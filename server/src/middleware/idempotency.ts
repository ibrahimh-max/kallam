/**
 * Idempotency for writes that cost money.
 *
 * `POST /v1/speaking/transcribe` spends provider credits, so a mobile retry on a
 * flaky connection must not charge the learner twice. The contract:
 *   - The client sends `Idempotency-Key: <uuid>`.
 *   - The first request stores a hash of the request body plus its response.
 *   - A replay with the same key and the same body returns the stored response.
 *   - A replay with the same key and a *different* body is a 409, because that is
 *     a client bug and silently re-billing is worse than an error.
 *
 * Scope is (user, endpoint, key), so one user's key can never collide with another's.
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, toErrorBody } from '../core/errors.ts';
import type { CtxRequest } from '../core/http.ts';
import type { Repository } from '../repositories/Repository.ts';

export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export function readIdempotencyKey(req: Request): string | null {
  const raw = req.header('idempotency-key');
  if (!raw) return null;
  const trimmed = raw.trim();
  // Constrain the shape: the key becomes part of a storage key.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(trimmed)) {
    throw new AppError('VALIDATION_FAILED', { messageEn: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-]', details: { field: 'Idempotency-Key' } });
  }
  return trimmed;
}

/**
 * Replay check. Runs after auth (needs a user) and before the handler.
 * A stored response is replayed verbatim, including its HTTP status.
 */
export function idempotencyGuard(repo: Repository, endpoint: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = (req as CtxRequest).ctx;
    let key: string | null;
    try {
      key = readIdempotencyKey(req);
    } catch (err) {
      const error = err instanceof AppError ? err : new AppError('VALIDATION_FAILED');
      res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
      return;
    }
    if (!key) return next();

    const userId = (req as CtxRequest).user?.id;
    if (!userId) return next();

    try {
      const existing = await repo.idempotency.get(key, userId, endpoint);
      if (!existing) return next();
      const incoming = requestHash(req.body);
      if (existing.requestHash !== incoming) {
        const error = new AppError('IDEMPOTENCY_CONFLICT');
        ctx?.logger.warn('idempotency conflict', { endpoint });
        res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
        return;
      }
      ctx?.logger.info('idempotent replay', { endpoint });
      res.status(200).type('application/json').send(existing.responseJson);
    } catch (err) {
      ctx?.logger.error('idempotency lookup failed', { detail: err instanceof Error ? err.message : 'unknown' });
      next(err);
    }
  };
}

/** Stores a successful response against the key so a retry can replay it. */
export async function rememberResponse(
  repo: Repository,
  endpoint: string,
  userId: string,
  key: string | null,
  body: unknown,
  responseJson: string,
): Promise<void> {
  if (!key) return;
  await repo.idempotency.put({
    key,
    userId,
    endpoint,
    requestHash: requestHash(body),
    responseJson,
    createdAt: new Date().toISOString(),
  });
}
