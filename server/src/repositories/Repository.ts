/**
 * The data layer contract.
 *
 * Everything above this line (routes, services, learning logic) is written
 * against these interfaces. Two implementations exist:
 *   - MemoryRepository  : zero-dependency, used by tests and by a local run
 *                         with no Supabase project (the owner's current state).
 *   - SupabaseRepository: the real Postgres/Auth backend.
 *
 * The swap is a config value, not a code change, which is what makes the deferred
 * Supabase decision (project_knowledge `supabase-deferred`) safe.
 *
 * Concurrency note: `reserveUsage` is the one operation that must be atomic,
 * because two overlapping speaking requests must not both pass the daily quota.
 * Both implementations provide that guarantee (single-threaded JS plus a compare
 * step in memory; a row-level transaction in Postgres).
 */
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

export interface CreateProfileInput {
  id: string;
  displayName?: string | null;
  englishLevel?: Profile['englishLevel'];
  learningGoal?: Profile['learningGoal'];
  dailyGoalMinutes?: Profile['dailyGoalMinutes'];
  preferredArabicVoice?: string | null;
  preferredEnglishVoice?: string | null;
}

export interface ProfileUpdate {
  displayName?: string | null;
  englishLevel?: Profile['englishLevel'];
  learningGoal?: Profile['learningGoal'];
  dailyGoalMinutes?: Profile['dailyGoalMinutes'];
  preferredArabicVoice?: string | null;
  preferredEnglishVoice?: string | null;
  onboardingCompletedAt?: string | null;
}

export interface ProfileRepository {
  create(input: CreateProfileInput): Promise<Profile>;
  findById(id: string): Promise<Profile | null>;
  update(id: string, patch: ProfileUpdate): Promise<Profile | null>;
  /** Soft delete: marks `deleted_at` so the grace period starts. Returns false if absent. */
  markDeleted(id: string, at: string): Promise<boolean>;
  /** Hard delete of the whole account. Used by the retention job after the grace period. */
  purge(id: string): Promise<void>;
  listPendingPurge(now: string, graceDays: number): Promise<string[]>;
}

export interface AuthRepository {
  createUser(email: string, passwordHash: string): Promise<AuthUserRecord>;
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findById(id: string): Promise<AuthUserRecord | null>;
  createActionToken(
    userId: string,
    purpose: AuthActionPurpose,
    tokenHash: string,
    expiresAt: string,
    createdAt: string,
  ): Promise<void>;
  /** Atomically consumes an unexpired, purpose-matched token. */
  consumeActionToken(tokenHash: string, purpose: AuthActionPurpose, now: string): Promise<string | null>;
  markEmailVerified(userId: string, at: string): Promise<void>;
  /** Changes the password and revokes the stored refresh session. */
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  deleteExpiredActionTokens(now: string): Promise<number>;
  setRefreshTokenHash(userId: string, hash: string | null): Promise<void>;
  /** Atomically consumes the current opaque token hash and replaces it. */
  rotateRefreshToken(currentHash: string, nextHash: string): Promise<AuthUserRecord | null>;
}

export interface ConsentRepository {
  record(userId: string, consentType: ConsentType, policyVersion: string, at: string): Promise<ConsentRecord>;
  withdraw(userId: string, consentType: ConsentType, at: string): Promise<void>;
  listForUser(userId: string): Promise<ConsentRecord[]>;
  /** True when an un-withdrawn voice-processing consent exists. */
  hasActiveVoiceConsent(userId: string): Promise<boolean>;
  listWithdrawnBefore(cutoff: string): Promise<ConsentRecord[]>;
  deleteById(id: string): Promise<void>;
}

export interface LessonRepository {
  upsertMany(lessons: Lesson[]): Promise<number>;
  findById(id: string): Promise<Lesson | null>;
  findBySlug(slug: string): Promise<Lesson | null>;
  listPublished(): Promise<Lesson[]>;
}

export interface LessonAttemptRepository {
  create(attempt: LessonAttempt): Promise<LessonAttempt>;
  findById(id: string): Promise<LessonAttempt | null>;
  findLatestForUser(userId: string): Promise<LessonAttempt | null>;
  /** The in-progress attempt for this lesson, if any, so resuming is idempotent. */
  findInProgress(userId: string, lessonId: string): Promise<LessonAttempt | null>;
  complete(id: string, at: string, score: number | null): Promise<LessonAttempt | null>;
  listForUser(userId: string): Promise<LessonAttempt[]>;
  countCompleted(userId: string): Promise<number>;
  countStarted(userId: string): Promise<number>;
}

export interface SpeakingAttemptRepository {
  create(attempt: SpeakingAttempt): Promise<SpeakingAttempt>;
  findById(id: string): Promise<SpeakingAttempt | null>;
  listForUser(userId: string, limit: number): Promise<SpeakingAttempt[]>;
  countForUser(userId: string): Promise<number>;
  /** Idempotency guard for evaluation: one evaluation per attempt id. */
  findByAttemptId(userId: string, attemptId: string): Promise<SpeakingAttempt | null>;
  clearTranscriptsBefore(cutoff: string): Promise<number>;
  /** Clears the evaluation payload but keeps counts, after the longer retention window. */
  clearEvaluationsBefore(cutoff: string): Promise<number>;
  /** Correction type frequency, for the "common mistakes" progress view. */
  correctionCounts(userId: string): Promise<Record<string, number>>;
}

export interface VocabularyRepository {
  upsert(item: Omit<VocabularyItem, 'id' | 'createdAt'> & { id?: string }): Promise<VocabularyItem>;
  listForUser(userId: string): Promise<VocabularyItem[]>;
  countForUser(userId: string): Promise<number>;
  countDue(userId: string, now: string): Promise<number>;
  setReviewState(id: string, userId: string, state: ReviewState, nextReviewAt: string | null): Promise<VocabularyItem | null>;
}

export interface ReserveUsageInput {
  userId: string;
  feature: UsageFeature;
  /** e.g. audio seconds for stt, characters for tts. */
  quantity: number;
  creditsEstimated: number;
  provider: string;
  model: string | null;
  requestId: string;
  /** UTC day being charged, `YYYY-MM-DD`. */
  day: string;
  speakingDailyLimit: number;
  ttsDailyLimit: number;
  dailyCreditBudget: number;
}

export interface ReserveUsageResult {
  event: UsageEvent;
  allowed: boolean;
  reason: 'ok' | 'speaking_quota' | 'tts_quota' | 'credit_budget';
}

export interface UsageRepository {
  reserve(input: ReserveUsageInput): Promise<ReserveUsageResult>;
  settle(eventId: string, patch: { status: UsageStatus; cacheHit?: boolean; creditsEstimated?: number }): Promise<void>;
  findById(eventId: string): Promise<UsageEvent | null>;
  /** Counters for `GET /v1/usage`. Cached by the params, not the DB. */
  summary(userId: string, day: string): Promise<{ speakingAttempts: number; ttsRequests: number; credits: number }>;
  countCacheHits(userId: string, day: string, feature: UsageFeature): Promise<number>;
  countCacheMisses(userId: string, day: string, feature: UsageFeature): Promise<number>;
  /** Global spend for the day, used as the last-resort budget guard. */
  creditsForDay(day: string): Promise<number>;
  listForUser(userId: string, limit: number): Promise<UsageEvent[]>;
  deleteBefore(cutoff: string): Promise<number>;
}

export interface TtsCacheRepository {
  get(cacheKey: string): Promise<TtsCacheEntry | null>;
  put(entry: TtsCacheEntry): Promise<void>;
  /** Marks a hit for cost attribution. */
  touch(cacheKey: string, at: string): Promise<void>;
  deleteBefore(cutoff: string): Promise<number>;
}

export interface IdempotencyRepository {
  get(key: string, userId: string, endpoint: string): Promise<{ requestHash: string; responseJson: string } | null>;
  put(record: {
    key: string;
    userId: string;
    endpoint: string;
    requestHash: string;
    responseJson: string;
    createdAt: string;
  }): Promise<void>;
  deleteBefore(cutoff: string): Promise<number>;
}

export interface Repository {
  readonly driver: 'memory' | 'supabase';
  profiles: ProfileRepository;
  auth: AuthRepository;
  consents: ConsentRepository;
  lessons: LessonRepository;
  lessonAttempts: LessonAttemptRepository;
  speaking: SpeakingAttemptRepository;
  vocabulary: VocabularyRepository;
  usage: UsageRepository;
  ttsCache: TtsCacheRepository;
  idempotency: IdempotencyRepository;
  /** Isolation level available for multi-write operations. */
  readonly supportsTransactions: boolean;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class RepositoryError extends Error {
  /** Declared explicitly rather than as a parameter property: `erasableSyntaxOnly`. */
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RepositoryError';
    this.cause = cause;
  }
}