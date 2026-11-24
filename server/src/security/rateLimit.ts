/**
 * Rate limiting.
 *
 * Two independent buckets, because they block different attacks:
 *   - per user  : one account hammering the provider or the quota
 *   - per IP    : one machine creating many accounts or probing auth
 *
 * Memory mode uses a process-local store for development and tests. Supabase mode
 * uses an atomic Postgres RPC so replicas share counters. Store failures are
 * propagated to the API error handler rather than silently failing open.
 */
import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ServerEnv } from '../config/env.ts';
import { AppError } from '../core/errors.ts';
import type { CtxRequest } from '../core/http.ts';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  hit(bucket: string, windowMs: number, limit: number, now: number): RateLimitDecision | Promise<RateLimitDecision>;
}

/** Fixed-window counter for local development and isolated tests. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  hit(bucket: string, windowMs: number, limit: number, now: number): RateLimitDecision {
    this.sweep(now);
    const existing = this.windows.get(bucket);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(bucket, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    if (existing.count > limit) return { allowed: false, remaining: 0, retryAfterSeconds };
    return { allowed: true, remaining: Math.max(0, limit - existing.count), retryAfterSeconds: 0 };
  }

  /** Prevents unbounded growth from one-off IPs. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, value] of this.windows) if (value.resetAt <= now) this.windows.delete(key);
  }

  size(): number {
    return this.windows.size;
  }
}

interface SharedRateLimitArgs {
  p_bucket_hash: string;
  p_window_ms: number;
  p_limit: number;
  p_now_ms: number;
}

type SharedRateLimitRpc = (
  args: SharedRateLimitArgs,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/** Fixed-window counter shared by Supabase-backed API instances. */
export class SupabaseRateLimitStore implements RateLimitStore {
  private readonly callRpc: SharedRateLimitRpc;
  private readonly bucketKey: Buffer;

  constructor(callRpc: SharedRateLimitRpc, hashSecret: string) {
    if (hashSecret.length < 32) throw new Error('shared rate-limit hash secret must be at least 32 characters');
    this.callRpc = callRpc;
    this.bucketKey = createHmac('sha256', hashSecret).update('saudi-english-tutor:rate-limit:v1').digest();
  }

  async hit(bucket: string, windowMs: number, limit: number, now: number): Promise<RateLimitDecision> {
    const bucketHash = createHmac('sha256', this.bucketKey).update(bucket).digest('hex');
    const result = await this.callRpc({
      p_bucket_hash: bucketHash,
      p_window_ms: windowMs,
      p_limit: limit,
      p_now_ms: now,
    });
    if (result.error) throw new Error(`shared rate-limit store failed: ${result.error.message}`);
    if (!Array.isArray(result.data) || result.data.length !== 1) {
      throw new Error('shared rate-limit store returned an invalid result');
    }

    const row: unknown = result.data[0];
    if (!isRecord(row)) {
      throw new Error('shared rate-limit store returned an invalid row');
    }
    if (
      typeof row.allowed !== 'boolean' ||
      typeof row.remaining !== 'number' ||
      !Number.isInteger(row.remaining) ||
      row.remaining < 0 ||
      typeof row.retry_after_seconds !== 'number' ||
      !Number.isInteger(row.retry_after_seconds) ||
      row.retry_after_seconds < 0
    ) {
      throw new Error('shared rate-limit store returned invalid decision fields');
    }
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      retryAfterSeconds: row.retry_after_seconds,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRateLimitStore(env: ServerEnv): RateLimitStore {
  if (env.repositoryDriver === 'memory') return new MemoryRateLimitStore();

  const client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseRateLimitStore(
    async (args) => {
      const { data, error } = await client.rpc('hit_rate_limit', args);
      return { data, error: error ? { message: error.message } : null };
    },
    env.localJwtSecret,
  );
}

export interface RateLimitOptions {
  windowMs?: number;
  perUserLimit?: number;
  perIpLimit?: number;
  store?: RateLimitStore;
  now?: () => number;
}

function clientIp(req: Request): string {
  // Use the framework's own resolution. `app.set('trust proxy', 1)` makes Express
  // trust exactly one hop, so `req.ip` is the real client behind that proxy.
  //
  // This deliberately does NOT read `x-forwarded-for` itself: a client-supplied
  // header is attacker-controlled, and honouring it here let one caller mint a
  // fresh bucket per request (`X-Forwarded-For: 10.0.0.<i>`), which disabled the
  // only brute-force defence on the unauthenticated login/register routes.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function reject(res: Response, req: Request, scope: 'ip' | 'user' | 'email', retryAfterSeconds: number): void {
  const error = new AppError('RATE_LIMITED', { details: { scope, retry_after_seconds: retryAfterSeconds } });
  res.setHeader('retry-after', String(retryAfterSeconds));
  res.status(error.status).json({
    error: {
      code: error.code,
      message_ar: error.messageAr,
      message_en: error.messageEn,
      retryable: true,
      request_id: (req as CtxRequest).ctx?.requestId ?? 'unknown',
      details: error.details,
    },
  });
}

/** Shared email bucket for signup, resend, and recovery requests. */
export function authEmailRateLimitMiddleware(store: RateLimitStore, limit = 3) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as { email?: unknown } | null;
    if (!body || typeof body.email !== 'string' || body.email.trim() === '') {
      next();
      return;
    }
    const email = body.email.trim().toLowerCase();
    void Promise.resolve()
      .then(() => store.hit(`auth-email:${email}`, 60 * 60_000, limit, Date.now()))
      .then((decision) => {
        if (!decision.allowed) {
          reject(res, req, 'email', decision.retryAfterSeconds);
          return;
        }
        next();
      })
      .catch(next);
  };
}

/**
 * Per-IP bucket. Mounted globally, before body parsing, so a flood is shed before
 * any body is buffered.
 */
export function ipRateLimitMiddleware(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const perIpLimit = options.perIpLimit ?? 120;
  const store = options.store ?? new MemoryRateLimitStore();
  const now = options.now ?? (() => Date.now());

  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve()
      .then(() => store.hit(`ip:${clientIp(req)}`, windowMs, perIpLimit, now()))
      .then((decision) => {
        if (!decision.allowed) {
          reject(res, req, 'ip', decision.retryAfterSeconds);
          return;
        }
        next();
      })
      .catch(next);
  };
}

/**
 * Per-user bucket.
 *
 * Mounted after `requireAuth`, because the bucket key is the *verified* user id.
 * Running it earlier would key every authenticated request on the IP instead, which
 * both locks out unrelated learners sharing a NAT and fails to bound a single
 * account. Annotation order here is the whole point of the split, so it is asserted
 * by a test.
 */
export function userRateLimitMiddleware(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const perUserLimit = options.perUserLimit ?? 60;
  const store = options.store ?? new MemoryRateLimitStore();
  const now = options.now ?? (() => Date.now());

  return (req: Request, res: Response, next: NextFunction): void => {
    const userId = (req as CtxRequest).user?.id;
    if (!userId) {
      // No identity to bucket on: authentication itself will reject the request.
      next();
      return;
    }
    void Promise.resolve()
      .then(() => store.hit(`user:${userId}`, windowMs, perUserLimit, now()))
      .then((decision) => {
        res.setHeader('x-ratelimit-remaining', String(decision.remaining));
        if (!decision.allowed) {
          reject(res, req, 'user', decision.retryAfterSeconds);
          return;
        }
        next();
      })
      .catch(next);
  };
}
