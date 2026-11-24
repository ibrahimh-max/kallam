/**
 * Usage and quota accounting.
 *
 * The rule from build (1).md §7.2 that shapes this file: **a provider failure must
 * release the reserved quota.** So every paid operation is two-phase:
 *
 *   1. reserve()  — checks the per-user daily limits and the global daily credit
 *                   budget, then writes a `reserved` ledger row. Atomic in the
 *                   repository, so two concurrent attempts cannot both pass.
 *   2. settle()   — marks the row `succeeded` (with the real credit estimate and
 *                   cache_hit) or `failed`, which zeroes the credits and returns
 *                   the learner's allowance.
 *
 * What is deliberately *not* charged:
 *   - a TTS cache hit (0 credits, recorded as cache_hit = true)
 *   - deterministic evaluation (0 credits, no provider involved)
 *   - a failed provider call
 */
import { AppError } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { UsageEvent, UsageFeature, UsageSummary } from '../../domain/models.ts';
import type { Repository } from '../../repositories/Repository.ts';

export interface UsageLimits {
  freeDailySpeakingAttempts: number;
  freeDailyTtsRequests: number;
  dailyCreditBudget: number;
}

export interface Reservation {
  event: UsageEvent | null;
  /** False when the call must not proceed. */
  allowed: boolean;
  reason: 'ok' | 'speaking_quota' | 'tts_quota' | 'credit_budget';
}

export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export class UsageService {
  private readonly repo: Repository;
  private readonly limits: UsageLimits;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(repo: Repository, limits: UsageLimits, logger: Logger, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.limits = limits;
    this.logger = logger;
    this.now = now;
  }

  async reserve(input: {
    userId: string;
    feature: UsageFeature;
    quantity: number;
    creditsEstimated: number;
    provider: string;
    model: string | null;
    requestId: string;
  }): Promise<Reservation> {
    const day = utcDay(this.now());

    const result = await this.repo.usage.reserve({
      ...input,
      day,
      speakingDailyLimit: this.limits.freeDailySpeakingAttempts,
      ttsDailyLimit: this.limits.freeDailyTtsRequests,
      dailyCreditBudget: this.limits.dailyCreditBudget,
    });

    if (!result.allowed) {
      if (result.reason === 'credit_budget') {
        this.logger.warn('usage.credit_budget_exhausted', {
          day,
          requested: input.creditsEstimated,
          budget: this.limits.dailyCreditBudget,
        });
      }
      this.logger.info('usage.quota_exhausted', { feature: input.feature, reason: result.reason, day });
      return { event: null, allowed: false, reason: result.reason };
    }

    return { event: result.event, allowed: true, reason: 'ok' };
  }

  /** Throws the learner-facing error for a refused reservation. */
  assertAllowed(reservation: Reservation): UsageEvent {
    if (reservation.allowed && reservation.event) return reservation.event;
    if (reservation.reason === 'credit_budget') {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        messageAr: 'خدمة الصوت عندها صيانة. جرّب بعد شوي.',
        messageEn: 'daily provider credit budget exhausted',
        retryable: true,
      });
    }
    throw new AppError('QUOTA_EXHAUSTED', { details: { reason: reservation.reason } });
  }

  async settleSuccess(eventId: string, patch: { cacheHit?: boolean; creditsEstimated?: number } = {}): Promise<void> {
    await this.repo.usage.settle(eventId, { status: 'succeeded', ...patch });
  }

  async settleFailure(eventId: string): Promise<void> {
    await this.repo.usage.settle(eventId, { status: 'failed', creditsEstimated: 0 });
  }

  /** Everything `GET /v1/usage` needs, in one call. */
  async summary(userId: string): Promise<UsageSummary> {
    const day = utcDay(this.now());
    const counters = await this.repo.usage.summary(userId, day);
    const [cacheHits, cacheMisses] = await Promise.all([
      this.repo.usage.countCacheHits(userId, day, 'tts'),
      this.repo.usage.countCacheMisses(userId, day, 'tts'),
    ]);
    return {
      day,
      speaking_attempts_used: counters.speakingAttempts,
      speaking_attempts_limit: this.limits.freeDailySpeakingAttempts,
      tts_requests_used: counters.ttsRequests,
      tts_requests_limit: this.limits.freeDailyTtsRequests,
      credits_used_today: counters.credits,
      credits_today_budget: this.limits.dailyCreditBudget,
      tts_cache_hits_today: cacheHits,
      tts_cache_misses_today: cacheMisses,
    };
  }

  /** For the operator-facing health/diagnostics endpoint. Not learner-scoped. */
  async globalSpendToday(): Promise<{ day: string; credits: number; budget: number }> {
    const day = utcDay(this.now());
    return { day, credits: await this.repo.usage.creditsForDay(day), budget: this.limits.dailyCreditBudget };
  }
}
