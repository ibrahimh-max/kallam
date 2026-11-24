/**
 * In-memory implementation of `Repository`.
 *
 * Purpose: the owner has no Supabase project yet, and the tests must run with no
 * network and no external service. This adapter makes the whole backend runnable
 * and testable today, and it is the reference behaviour the Supabase adapter must
 * match — including the one place where correctness is subtle: `reserve()` does
 * its quota check and its insert with no `await` between them, so two concurrent
 * speaking requests cannot both pass the same daily limit.
 *
 * It is not durable by design. `health()` says so, and the server logs it at
 * startup so nobody mistakes a local run for a real deployment.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuthUserRecord,
  AuthActionPurpose,
  ConsentRecord,
  ConsentType,
  Lesson,
  LessonAttempt,
  Profile,
  ReviewState,
  SpeakingAttempt,
  TtsCacheEntry,
  UsageEvent,
  UsageFeature,
  UsageStatus,
  VocabularyItem,
} from '../domain/models.ts';
import type {
  AuthRepository,
  ConsentRepository,
  CreateProfileInput,
  IdempotencyRepository,
  LessonAttemptRepository,
  LessonRepository,
  ProfileRepository,
  ProfileUpdate,
  Repository,
  ReserveUsageInput,
  ReserveUsageResult,
  SpeakingAttemptRepository,
  TtsCacheRepository,
  UsageRepository,
  VocabularyRepository,
} from './Repository.ts';

const nowIso = (): string => new Date().toISOString();

/** Deep clone on read/write so a caller cannot mutate stored state by reference. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryProfiles implements ProfileRepository {
  private readonly rows: Map<string, Profile>;
  /**
   * Cascades one account's removal across every other store.
   *
   * Set by `MemoryRepository` after the stores exist. It exists because Postgres
   * removes owned rows through `on delete cascade`, and this driver has no foreign
   * keys — without it a purge would quietly leave orphan rows behind and the
   * retention tests would pass against behaviour production does not have.
   */
  onPurge: ((userId: string) => void) | null = null;

  constructor(rows: Map<string, Profile>) {
    this.rows = rows;
  }

  async create(input: CreateProfileInput): Promise<Profile> {
    const at = nowIso();
    const profile: Profile = {
      id: input.id,
      displayName: input.displayName ?? null,
      englishLevel: input.englishLevel ?? null,
      learningGoal: input.learningGoal ?? null,
      dailyGoalMinutes: input.dailyGoalMinutes ?? null,
      preferredArabicVoice: input.preferredArabicVoice ?? null,
      preferredEnglishVoice: input.preferredEnglishVoice ?? null,
      onboardingCompletedAt: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.rows.set(profile.id, profile);
    return clone(profile);
  }

  async findById(id: string): Promise<Profile | null> {
    const row = this.rows.get(id);
    if (!row || row.deletedAt !== null) return null;
    return clone(row);
  }

  async update(id: string, patch: ProfileUpdate): Promise<Profile | null> {
    const row = this.rows.get(id);
    if (!row || row.deletedAt !== null) return null;
    const next: Profile = { ...row, updatedAt: nowIso() };
    if ('displayName' in patch) next.displayName = patch.displayName ?? null;
    if ('englishLevel' in patch) next.englishLevel = patch.englishLevel ?? null;
    if ('learningGoal' in patch) next.learningGoal = patch.learningGoal ?? null;
    if ('dailyGoalMinutes' in patch) next.dailyGoalMinutes = patch.dailyGoalMinutes ?? null;
    if ('preferredArabicVoice' in patch) next.preferredArabicVoice = patch.preferredArabicVoice ?? null;
    if ('preferredEnglishVoice' in patch) next.preferredEnglishVoice = patch.preferredEnglishVoice ?? null;
    if ('onboardingCompletedAt' in patch) next.onboardingCompletedAt = patch.onboardingCompletedAt ?? null;
    this.rows.set(id, next);
    return clone(next);
  }

  async markDeleted(id: string, at: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    row.deletedAt = at;
    row.updatedAt = at;
    return true;
  }

  async purge(id: string): Promise<void> {
    this.rows.delete(id);
    this.onPurge?.(id);
  }

  async listPendingPurge(now: string, graceDays: number): Promise<string[]> {
    const cutoff = new Date(new Date(now).getTime() - graceDays * 86_400_000).toISOString();
    return [...this.rows.values()].filter((row) => row.deletedAt !== null && row.deletedAt <= cutoff).map((row) => row.id);
  }
}

class MemoryAuth implements AuthRepository {
  private readonly rows: Map<string, AuthUserRecord>;
  private readonly actionTokens: Map<string, { userId: string; purpose: AuthActionPurpose; expiresAt: string; createdAt: string }>;

  constructor(
    rows: Map<string, AuthUserRecord>,
    actionTokens: Map<string, { userId: string; purpose: AuthActionPurpose; expiresAt: string; createdAt: string }>,
  ) {
    this.rows = rows;
    this.actionTokens = actionTokens;
  }

  async createUser(email: string, passwordHash: string): Promise<AuthUserRecord> {
    const record: AuthUserRecord = {
      id: randomUUID(),
      email: email.toLowerCase(),
      passwordHash,
      emailVerifiedAt: null,
      refreshTokenHash: null,
      createdAt: nowIso(),
    };
    this.rows.set(record.id, record);
    return clone(record);
  }
  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const wanted = email.toLowerCase();
    for (const row of this.rows.values()) if (row.email === wanted) return clone(row);
    return null;
  }
  async findById(id: string): Promise<AuthUserRecord | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }
  async createActionToken(
    userId: string,
    purpose: AuthActionPurpose,
    tokenHash: string,
    expiresAt: string,
    createdAt: string,
  ): Promise<void> {
    for (const [hash, record] of this.actionTokens) {
      if (record.userId === userId && record.purpose === purpose) this.actionTokens.delete(hash);
    }
    this.actionTokens.set(tokenHash, { userId, purpose, expiresAt, createdAt });
  }
  async consumeActionToken(tokenHash: string, purpose: AuthActionPurpose, now: string): Promise<string | null> {
    const record = this.actionTokens.get(tokenHash);
    if (!record || record.purpose !== purpose) return null;
    this.actionTokens.delete(tokenHash);
    return record.expiresAt > now ? record.userId : null;
  }
  async markEmailVerified(userId: string, at: string): Promise<void> {
    const row = this.rows.get(userId);
    if (row && row.emailVerifiedAt === null) row.emailVerifiedAt = at;
  }
  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    const row = this.rows.get(userId);
    if (row) {
      row.passwordHash = passwordHash;
      row.refreshTokenHash = null;
    }
  }
  async deleteExpiredActionTokens(now: string): Promise<number> {
    let removed = 0;
    for (const [hash, record] of this.actionTokens) {
      if (record.expiresAt <= now) {
        this.actionTokens.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
  async setRefreshTokenHash(userId: string, hash: string | null): Promise<void> {
    const row = this.rows.get(userId);
    if (row) row.refreshTokenHash = hash;
  }
  async rotateRefreshToken(currentHash: string, nextHash: string): Promise<AuthUserRecord | null> {
    for (const row of this.rows.values()) {
      if (row.refreshTokenHash === currentHash) {
        row.refreshTokenHash = nextHash;
        return clone(row);
      }
    }
    return null;
  }

  /**
   * Cascade target: the auth user is the root of the cascade in Postgres, so
   * purging it is what removes everything else. The memory driver has no such
   * root, so the profile purge calls this explicitly.
   */
  removeForUser(userId: string): boolean {
    for (const [hash, token] of this.actionTokens) {
      if (token.userId === userId) this.actionTokens.delete(hash);
    }
    return this.rows.delete(userId);
  }
}

class MemoryConsents implements ConsentRepository {
  private readonly rows: ConsentRecord[];

  constructor(rows: ConsentRecord[]) {
    this.rows = rows;
  }

  async record(userId: string, consentType: ConsentType, policyVersion: string, at: string): Promise<ConsentRecord> {
    // Re-granting replaces the withdrawn record rather than appending duplicates.
    const existing = this.rows.find((r) => r.userId === userId && r.consentType === consentType && r.withdrawnAt === null);
    if (existing) return clone(existing);
    const record: ConsentRecord = { id: randomUUID(), userId, consentType, policyVersion, grantedAt: at, withdrawnAt: null };
    this.rows.push(record);
    return clone(record);
  }

  async withdraw(userId: string, consentType: ConsentType, at: string): Promise<void> {
    for (const row of this.rows) {
      if (row.userId === userId && row.consentType === consentType && row.withdrawnAt === null) row.withdrawnAt = at;
    }
  }

  async listForUser(userId: string): Promise<ConsentRecord[]> {
    return clone(this.rows.filter((r) => r.userId === userId));
  }

  async hasActiveVoiceConsent(userId: string): Promise<boolean> {
    return this.rows.some((r) => r.userId === userId && r.consentType === 'voice_processing' && r.withdrawnAt === null);
  }

  async listWithdrawnBefore(cutoff: string): Promise<ConsentRecord[]> {
    return clone(this.rows.filter((r) => r.withdrawnAt !== null && r.withdrawnAt <= cutoff));
  }

  async deleteById(id: string): Promise<void> {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }

  /** Cascade target: `consents.user_id` is `on delete cascade`. */
  removeForUser(userId: string): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]!.userId === userId) {
        this.rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

class MemoryLessons implements LessonRepository {
  private readonly rows: Map<string, Lesson>;

  constructor(rows: Map<string, Lesson>) {
    this.rows = rows;
  }

  async upsertMany(lessons: Lesson[]): Promise<number> {
    let written = 0;
    for (const lesson of lessons) {
      this.rows.set(lesson.slug, clone(lesson));
      written += 1;
    }
    return written;
  }
  async findById(id: string): Promise<Lesson | null> {
    for (const row of this.rows.values()) if (row.id === id) return clone(row);
    return null;
  }
  async findBySlug(slug: string): Promise<Lesson | null> {
    const row = this.rows.get(slug);
    return row ? clone(row) : null;
  }
  async listPublished(): Promise<Lesson[]> {
    return clone([...this.rows.values()].filter((l) => l.published));
  }
}

class MemoryLessonAttempts implements LessonAttemptRepository {
  private readonly rows: LessonAttempt[];

  constructor(rows: LessonAttempt[]) {
    this.rows = rows;
  }

  async create(attempt: LessonAttempt): Promise<LessonAttempt> {
    this.rows.push(clone(attempt));
    return clone(attempt);
  }
  async findById(id: string): Promise<LessonAttempt | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? clone(row) : null;
  }
  async findLatestForUser(userId: string): Promise<LessonAttempt | null> {
    const rows = this.rows.filter((r) => r.userId === userId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return rows[0] ? clone(rows[0]) : null;
  }
  async findInProgress(userId: string, lessonId: string): Promise<LessonAttempt | null> {
    const row = this.rows.find((r) => r.userId === userId && r.lessonId === lessonId && r.status === 'in_progress');
    return row ? clone(row) : null;
  }
  async complete(id: string, at: string, score: number | null): Promise<LessonAttempt | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.completedAt = at;
    row.status = 'completed';
    row.score = score;
    return clone(row);
  }
  async listForUser(userId: string): Promise<LessonAttempt[]> {
    return clone(this.rows.filter((r) => r.userId === userId));
  }
  async countCompleted(userId: string): Promise<number> {
    return this.rows.filter((r) => r.userId === userId && r.status === 'completed').length;
  }
  async countStarted(userId: string): Promise<number> {
    return this.rows.filter((r) => r.userId === userId).length;
  }

  /** Cascade target: `lesson_attempts.user_id` is `on delete cascade`. */
  removeForUser(userId: string): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]!.userId === userId) {
        this.rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

class MemorySpeaking implements SpeakingAttemptRepository {
  private readonly rows: SpeakingAttempt[];

  constructor(rows: SpeakingAttempt[]) {
    this.rows = rows;
  }

  async create(attempt: SpeakingAttempt): Promise<SpeakingAttempt> {
    this.rows.push(clone(attempt));
    return clone(attempt);
  }
  async findById(id: string): Promise<SpeakingAttempt | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? clone(row) : null;
  }
  async listForUser(userId: string, limit: number): Promise<SpeakingAttempt[]> {
    return clone(this.rows.filter((r) => r.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }
  async countForUser(userId: string): Promise<number> {
    return this.rows.filter((r) => r.userId === userId).length;
  }

  /**
   * The evaluation idempotency guard: one evaluation per lesson attempt.
   *
   * Matches the Supabase driver, which looks up `lesson_attempt_id`. The newest
   * row wins when a learner practised the same attempt twice.
   */
  async findByAttemptId(userId: string, attemptId: string): Promise<SpeakingAttempt | null> {
    const rows = this.rows
      .filter((r) => r.userId === userId && r.lessonAttemptId === attemptId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows[0] ? clone(rows[0]) : null;
  }

  /** Cascade target: `speaking_attempts.user_id` is `on delete cascade`. */
  removeForUser(userId: string): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]!.userId === userId) {
        this.rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  async clearTranscriptsBefore(cutoff: string): Promise<number> {
    let cleared = 0;
    for (const row of this.rows) {
      if (row.transcript !== null && row.createdAt <= cutoff) {
        row.transcript = null;
        cleared += 1;
      }
    }
    return cleared;
  }
  async clearEvaluationsBefore(cutoff: string): Promise<number> {
    let cleared = 0;
    for (const row of this.rows) {
      if (row.evaluation !== null && row.createdAt <= cutoff) {
        row.evaluation = null;
        cleared += 1;
      }
    }
    return cleared;
  }
  async correctionCounts(userId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.rows) {
      if (row.userId !== userId || !row.evaluation) continue;
      for (const correction of row.evaluation.corrections) {
        counts[correction.type] = (counts[correction.type] ?? 0) + 1;
      }
    }
    return counts;
  }
}

class MemoryVocabulary implements VocabularyRepository {
  private readonly rows: VocabularyItem[];

  constructor(rows: VocabularyItem[]) {
    this.rows = rows;
  }

  async upsert(item: Omit<VocabularyItem, 'id' | 'createdAt'> & { id?: string }): Promise<VocabularyItem> {
    const existing = this.rows.find((r) => r.userId === item.userId && r.englishTerm.toLowerCase() === item.englishTerm.toLowerCase());
    if (existing) {
      existing.arabicMeaning = item.arabicMeaning;
      existing.exampleSentence = item.exampleSentence;
      existing.reviewState = item.reviewState;
      existing.nextReviewAt = item.nextReviewAt;
      return clone(existing);
    }
    const record: VocabularyItem = { ...item, id: item.id ?? randomUUID(), createdAt: nowIso() };
    this.rows.push(record);
    return clone(record);
  }
  async listForUser(userId: string): Promise<VocabularyItem[]> {
    return clone(this.rows.filter((r) => r.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async countForUser(userId: string): Promise<number> {
    return this.rows.filter((r) => r.userId === userId).length;
  }
  async countDue(userId: string, now: string): Promise<number> {
    return this.rows.filter((r) => r.userId === userId && r.nextReviewAt !== null && r.nextReviewAt <= now).length;
  }
  async setReviewState(id: string, userId: string, state: ReviewState, nextReviewAt: string | null): Promise<VocabularyItem | null> {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row) return null;
    row.reviewState = state;
    row.nextReviewAt = nextReviewAt;
    return clone(row);
  }

  /** Cascade target: `vocabulary.user_id` is `on delete cascade`. */
  removeForUser(userId: string): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]!.userId === userId) {
        this.rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

class MemoryUsage implements UsageRepository {
  private readonly rows: UsageEvent[];

  constructor(rows: UsageEvent[]) {
    this.rows = rows;
  }

  /**
   * Quota check and reservation happen with no `await` between them, so Node's
   * single-threaded scheduler cannot interleave a second reservation into the
   * same window. This is the memory-driver equivalent of a Postgres transaction
   * with a row lock.
   */
  async reserve(input: ReserveUsageInput): Promise<ReserveUsageResult> {
    const event: UsageEvent = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      feature: input.feature,
      model: input.model,
      usageQuantity: input.quantity,
      creditsEstimated: input.creditsEstimated,
      cacheHit: false,
      requestId: input.requestId,
      status: 'reserved',
      createdAt: nowIso(),
    };

    // Only counting attempts that will actually be settled; a released
    // reservation (status failed) must not consume the learner's allowance.
    const todays = this.rows.filter((r) => r.userId === input.userId && r.createdAt.slice(0, 10) === input.day && r.status !== 'failed');
    const spentToday = this.rows
      .filter((r) => r.createdAt.slice(0, 10) === input.day && r.status !== 'failed')
      .reduce((sum, row) => sum + row.creditsEstimated, 0);

    if (input.creditsEstimated > 0 && spentToday + input.creditsEstimated > input.dailyCreditBudget) {
      return { event: { ...event, creditsEstimated: 0 }, allowed: false, reason: 'credit_budget' };
    }

    if (input.feature === 'stt') {
      const used = todays.filter((r) => r.feature === 'stt').length;
      if (used >= input.speakingDailyLimit) {
        return { event, allowed: false, reason: 'speaking_quota' };
      }
    }
    if (input.feature === 'tts') {
      const used = todays.filter((r) => r.feature === 'tts').length;
      if (used >= input.ttsDailyLimit) {
        return { event, allowed: false, reason: 'tts_quota' };
      }
    }

    this.rows.push(event);
    return { event, allowed: true, reason: 'ok' };
  }

  async settle(eventId: string, patch: { status: UsageStatus; cacheHit?: boolean; creditsEstimated?: number }): Promise<void> {
    const row = this.rows.find((r) => r.id === eventId);
    if (!row) return;
    row.status = patch.status;
    if (patch.cacheHit !== undefined) row.cacheHit = patch.cacheHit;
    if (patch.creditsEstimated !== undefined) row.creditsEstimated = patch.creditsEstimated;
    // A released reservation must not bill the learner or the budget.
    if (patch.status === 'failed') row.creditsEstimated = 0;
  }

  async findById(eventId: string): Promise<UsageEvent | null> {
    const row = this.rows.find((r) => r.id === eventId);
    return row ? clone(row) : null;
  }

  async summary(userId: string, day: string): Promise<{ speakingAttempts: number; ttsRequests: number; credits: number }> {
    const todays = this.rows.filter((r) => r.userId === userId && r.createdAt.slice(0, 10) === day && r.status !== 'failed');
    return {
      speakingAttempts: todays.filter((r) => r.feature === 'stt').length,
      ttsRequests: todays.filter((r) => r.feature === 'tts').length,
      credits: todays.reduce((sum, r) => sum + r.creditsEstimated, 0),
    };
  }

  async countCacheHits(userId: string, day: string, feature: UsageFeature): Promise<number> {
    return this.rows.filter((r) => r.userId === userId && r.feature === feature && r.cacheHit && r.createdAt.slice(0, 10) === day).length;
  }

  async countCacheMisses(userId: string, day: string, feature: UsageFeature): Promise<number> {
    return this.rows.filter((r) => r.userId === userId && r.feature === feature && !r.cacheHit && r.createdAt.slice(0, 10) === day).length;
  }

  async creditsForDay(day: string): Promise<number> {
    return this.rows.filter((r) => r.createdAt.slice(0, 10) === day && r.status !== 'failed').reduce((sum, r) => sum + r.creditsEstimated, 0);
  }

  async listForUser(userId: string, limit: number): Promise<UsageEvent[]> {
    return clone(this.rows.filter((r) => r.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }

  /**
   * Cascade target: `usage_events.user_id` is `on delete set null`, not cascade.
   *
   * The ledger is the operator's cost history and holds no personal data once the
   * id is cleared, so the row stays and only the linkage goes. Deleting it instead
   * would destroy spend records that no longer identify anyone.
   */
  anonymiseForUser(userId: string): number {
    let cleared = 0;
    for (const row of this.rows) {
      if (row.userId === userId) {
        row.userId = null;
        cleared += 1;
      }
    }
    return cleared;
  }

  async deleteBefore(cutoff: string): Promise<number> {
    const keep = this.rows.filter((r) => r.createdAt > cutoff);
    const removed = this.rows.length - keep.length;
    this.rows.length = 0;
    this.rows.push(...keep);
    return removed;
  }
}

class MemoryTtsCache implements TtsCacheRepository {
  private readonly rows: Map<string, TtsCacheEntry>;

  constructor(rows: Map<string, TtsCacheEntry>) {
    this.rows = rows;
  }

  async get(cacheKey: string): Promise<TtsCacheEntry | null> {
    const row = this.rows.get(cacheKey);
    return row ? clone(row) : null;
  }
  async put(entry: TtsCacheEntry): Promise<void> {
    this.rows.set(entry.cacheKey, clone(entry));
  }
  async touch(cacheKey: string, at: string): Promise<void> {
    const row = this.rows.get(cacheKey);
    if (row) {
      row.hits += 1;
      row.lastUsedAt = at;
    }
  }
  async deleteBefore(cutoff: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.lastUsedAt < cutoff) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

class MemoryIdempotency implements IdempotencyRepository {
  private readonly rows: Map<string, { requestHash: string; responseJson: string; createdAt: string }>;

  constructor(rows: Map<string, { requestHash: string; responseJson: string; createdAt: string }>) {
    this.rows = rows;
  }

  private static key(key: string, userId: string, endpoint: string): string {
    return `${userId}:${endpoint}:${key}`;
  }

  async get(key: string, userId: string, endpoint: string) {
    const row = this.rows.get(MemoryIdempotency.key(key, userId, endpoint));
    return row ? { requestHash: row.requestHash, responseJson: row.responseJson } : null;
  }

  async put(record: { key: string; userId: string; endpoint: string; requestHash: string; responseJson: string; createdAt: string }): Promise<void> {
    this.rows.set(MemoryIdempotency.key(record.key, record.userId, record.endpoint), {
      requestHash: record.requestHash,
      responseJson: record.responseJson,
      createdAt: record.createdAt,
    });
  }

  async deleteBefore(cutoff: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.createdAt < cutoff) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Cascade target: `idempotency_records.user_id` is `on delete cascade`. */
  removeForUser(userId: string): number {
    let removed = 0;
    for (const key of [...this.rows.keys()]) {
      if (key.startsWith(`${userId}:`)) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export class MemoryRepository implements Repository {
  readonly driver = 'memory' as const;
  readonly supportsTransactions = false;

  readonly profiles: ProfileRepository;
  readonly auth: AuthRepository;
  readonly consents: ConsentRepository;
  readonly lessons: LessonRepository;
  readonly lessonAttempts: LessonAttemptRepository;
  readonly speaking: SpeakingAttemptRepository;
  readonly vocabulary: VocabularyRepository;
  readonly usage: UsageRepository;
  readonly ttsCache: TtsCacheRepository;
  readonly idempotency: IdempotencyRepository;

  constructor() {
    // Locals, not just the readonly fields: the cascade below calls the concrete
    // classes, and those methods are deliberately absent from the interfaces
    // (they are a memory-driver detail that stands in for Postgres foreign keys).
    const profiles = new MemoryProfiles(new Map());
    const auth = new MemoryAuth(new Map(), new Map());
    const consents = new MemoryConsents([]);
    const lessonAttempts = new MemoryLessonAttempts([]);
    const speaking = new MemorySpeaking([]);
    const vocabulary = new MemoryVocabulary([]);
    const usage = new MemoryUsage([]);
    const idempotency = new MemoryIdempotency(new Map());

    this.profiles = profiles;
    this.auth = auth;
    this.consents = consents;
    this.lessons = new MemoryLessons(new Map());
    this.lessonAttempts = lessonAttempts;
    this.speaking = speaking;
    this.vocabulary = vocabulary;
    this.usage = usage;
    this.ttsCache = new MemoryTtsCache(new Map());
    this.idempotency = idempotency;

    // Postgres removes owned rows through foreign keys; this driver has none, so the
    // cascade is reproduced by hand. `tts_cache` is deliberately absent — it holds
    // shared, non-personal lesson audio and has no `user_id` to cascade on.
    // `usage_events` anonymises rather than deletes, matching ON DELETE SET NULL.
    profiles.onPurge = (userId: string): void => {
      auth.removeForUser(userId);
      consents.removeForUser(userId);
      lessonAttempts.removeForUser(userId);
      speaking.removeForUser(userId);
      vocabulary.removeForUser(userId);
      idempotency.removeForUser(userId);
      usage.anonymiseForUser(userId);
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: 'in-memory driver: functional but NOT durable — data is lost on restart. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use Postgres.',
    };
  }
}