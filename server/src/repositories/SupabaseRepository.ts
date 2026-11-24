/**
 * Supabase (Postgres + Auth) implementation of the data layer.
 *
 * Selected with REPOSITORY_DRIVER=supabase. It uses the **service role key**,
 * which is a backend-only secret and bypasses RLS. RLS is enabled and audited as
 * defense in depth, but user scoping must be enforced by this trusted API; the
 * mobile app accesses data only through the API.
 *
 * Identity model: `auth.users.id` is the anchor for every user-owned row, and all
 * of them cascade from it. That single fact is what makes the spec's "secure
 * account and data deletion" requirement enforceable in one call rather than a
 * scattered cleanup routine that will drift.
 *
 * Two guarantees are NOT implemented here on purpose — they live in SQL because
 * they are the operations that must be atomic:
 *   reserve_usage() / settle_usage()   (supabase/migrations/0003_*.sql)
 * Doing the quota check in TypeScript would be a read-then-write race in which two
 * overlapping speaking requests both pass, which is a cost leak, not a rounding
 * error.
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  SpeakingEvaluation,
  TtsCacheEntry,
  UsageEvent,
  UsageFeature,
  UsageStatus,
  VocabularyItem,
} from '../domain/models.ts';
import {
  RepositoryError,
  type AuthRepository,
  type ConsentRepository,
  type CreateProfileInput,
  type IdempotencyRepository,
  type LessonAttemptRepository,
  type LessonRepository,
  type ProfileRepository,
  type ProfileUpdate,
  type Repository,
  type ReserveUsageInput,
  type ReserveUsageResult,
  type SpeakingAttemptRepository,
  type TtsCacheRepository,
  type UsageRepository,
  type VocabularyRepository,
} from './Repository.ts';

export interface SupabaseRepositoryOptions {
  url: string;
  serviceRoleKey: string;
}

// -----------------------------------------------------------------------------
// Row shapes (snake_case, exactly as Postgres returns them)
// -----------------------------------------------------------------------------

interface ProfileRow {
  id: string;
  display_name: string | null;
  preferred_arabic_voice: string | null;
  preferred_english_voice: string | null;
  english_level: Profile['englishLevel'];
  learning_goal: Profile['learningGoal'];
  daily_goal_minutes: Profile['dailyGoalMinutes'];
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface LessonRow {
  id: string;
  slug: string;
  title: string;
  title_ar: string;
  description: string;
  level: Lesson['level'];
  topic: string;
  duration_minutes: number;
  evaluation_mode: Lesson['evaluationMode'];
  content_json: Lesson['content'];
  published: boolean;
  created_at: string;
}

interface LessonAttemptRow {
  id: string;
  user_id: string;
  lesson_id: string;
  started_at: string;
  completed_at: string | null;
  score: number | string | null;
  status: LessonAttempt['status'];
}

interface SpeakingRow {
  id: string;
  user_id: string;
  lesson_attempt_id: string | null;
  prompt_slug: string;
  transcript: string | null;
  evaluation_json: SpeakingEvaluation | null;
  language_mode: SpeakingAttempt['languageMode'];
  duration_seconds: number | string;
  audio_deleted_at: string | null;
  created_at: string;
}

interface VocabularyRow {
  id: string;
  user_id: string;
  english_term: string;
  arabic_meaning: string;
  example_sentence: string;
  review_state: ReviewState;
  next_review_at: string | null;
  created_at: string;
}

interface UsageRow {
  id: string;
  user_id: string | null;
  provider: string;
  feature: UsageFeature;
  model: string | null;
  usage_quantity: number | string;
  credits_estimated: number;
  cache_hit: boolean;
  request_id: string;
  status: UsageStatus;
  created_at: string;
}

interface ConsentRow {
  id: string;
  user_id: string;
  consent_type: ConsentType;
  policy_version: string;
  granted_at: string;
  withdrawn_at: string | null;
}

interface TtsCacheRow {
  cache_key: string;
  text: string;
  text_hash: string;
  voice_id: string;
  model: string;
  content_type: 'audio/wav';
  audio: unknown;
  duration_seconds: number | string;
  created_at: string;
  last_used_at: string;
  hits: number;
}

interface AuthCredentialRow {
  user_id: string;
  email: string;
  password_hash: string;
  email_verified_at: string | null;
  refresh_token_hash: string | null;
  created_at: string;
}

interface AuthActionTokenRow {
  user_id: string;
}

// -----------------------------------------------------------------------------
// Row -> domain mapping
// -----------------------------------------------------------------------------

/**
 * Postgres `numeric` arrives as a string to preserve precision. Crediting and
 * scoring must not silently become floating point, so every numeric column is
 * parsed explicitly here rather than being trusted to JS coercion.
 */
function toNumber(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    displayName: row.display_name,
    preferredArabicVoice: row.preferred_arabic_voice,
    preferredEnglishVoice: row.preferred_english_voice,
    englishLevel: row.english_level,
    learningGoal: row.learning_goal,
    dailyGoalMinutes: row.daily_goal_minutes,
    onboardingCompletedAt: row.onboarding_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    titleAr: row.title_ar,
    description: row.description,
    level: row.level,
    topic: row.topic,
    durationMinutes: row.duration_minutes,
    evaluationMode: row.evaluation_mode,
    content: row.content_json,
    published: row.published,
    createdAt: row.created_at,
  };
}

function mapLessonAttempt(row: LessonAttemptRow): LessonAttempt {
  return {
    id: row.id,
    userId: row.user_id,
    lessonId: row.lesson_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    score: row.score === null ? null : toNumber(row.score),
    status: row.status,
  };
}

function mapSpeaking(row: SpeakingRow): SpeakingAttempt {
  return {
    id: row.id,
    userId: row.user_id,
    lessonAttemptId: row.lesson_attempt_id,
    promptSlug: row.prompt_slug,
    transcript: row.transcript,
    evaluation: row.evaluation_json,
    languageMode: row.language_mode,
    durationSeconds: toNumber(row.duration_seconds),
    audioDeletedAt: row.audio_deleted_at,
    createdAt: row.created_at,
  };
}

function mapVocabulary(row: VocabularyRow): VocabularyItem {
  return {
    id: row.id,
    userId: row.user_id,
    englishTerm: row.english_term,
    arabicMeaning: row.arabic_meaning,
    exampleSentence: row.example_sentence,
    reviewState: row.review_state,
    nextReviewAt: row.next_review_at,
    createdAt: row.created_at,
  };
}

function mapUsage(row: UsageRow): UsageEvent {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    feature: row.feature,
    model: row.model,
    usageQuantity: toNumber(row.usage_quantity),
    creditsEstimated: row.credits_estimated,
    cacheHit: row.cache_hit,
    requestId: row.request_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapConsent(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    consentType: row.consent_type,
    policyVersion: row.policy_version,
    grantedAt: row.granted_at,
    withdrawnAt: row.withdrawn_at,
  };
}

/**
 * PostgREST serialises `bytea` as the hex text form `\x48656c6c6f`. Some client
 * versions hand back a base64 string or a raw buffer depending on the transport,
 * so all three are accepted rather than assuming one.
 */
function decodeBytea(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') {
    // PostgREST's canonical form is the `\\x`-prefixed hex text. Anything else is
    // base64. The previous "all-hex-looking and even length" guess was ambiguous
    // and silently corrupted the WAV: a base64 string such as "deadbeef" satisfied
    // it and was decoded as hex, so cached audio came back unplayable.
    if (value.startsWith('\\x')) return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
    return Uint8Array.from(Buffer.from(value, 'base64'));
  }
  throw new RepositoryError('tts_cache.audio was not a recognised bytea representation');
}

function encodeBytea(bytes: Uint8Array): string {
  return `\\x${Buffer.from(bytes).toString('hex')}`;
}

function mapTtsCache(row: TtsCacheRow): TtsCacheEntry {
  return {
    cacheKey: row.cache_key,
    text: row.text,
    textHash: row.text_hash,
    voiceId: row.voice_id,
    model: row.model,
    contentType: row.content_type,
    audio: decodeBytea(row.audio),
    durationSeconds: toNumber(row.duration_seconds),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    hits: row.hits,
  };
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * Every query goes through here so a failure becomes a typed RepositoryError with
 * the Postgres code attached. The message is for the server log; routes never
 * forward it to a client (see core/errors.ts).
 */
function unwrap<T>(result: { data: T | null; error: PostgrestErrorLike | null }, context: string): T {
  if (result.error) {
    throw new RepositoryError(`${context}: ${result.error.message}`, result.error);
  }
  if (result.data === null) {
    throw new RepositoryError(`${context}: no data returned`);
  }
  return result.data;
}

function unwrapMaybe<T>(result: { data: T | null; error: PostgrestErrorLike | null }, context: string): T | null {
  if (result.error) {
    throw new RepositoryError(`${context}: ${result.error.message}`, result.error);
  }
  return result.data;
}

function unwrapVoid(result: { error: PostgrestErrorLike | null }, context: string): void {
  if (result.error) {
    throw new RepositoryError(`${context}: ${result.error.message}`, result.error);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function subtractDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * DAY_MS).toISOString();
}

function subtractMonths(iso: string, months: number): string {
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

/** Upper bound on rows a single aggregate reads, so a heavy user cannot OOM the process. */
const CORRECTION_SCAN_LIMIT = 500;

// -----------------------------------------------------------------------------
// profiles
// -----------------------------------------------------------------------------

class SupabaseProfiles implements ProfileRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async create(input: CreateProfileInput): Promise<Profile> {
    const row = unwrap(
      await this.db
        .from('profiles')
        .insert({
          id: input.id,
          display_name: input.displayName ?? null,
          english_level: input.englishLevel ?? null,
          learning_goal: input.learningGoal ?? null,
          daily_goal_minutes: input.dailyGoalMinutes ?? null,
          preferred_arabic_voice: input.preferredArabicVoice ?? null,
          preferred_english_voice: input.preferredEnglishVoice ?? null,
        })
        .select()
        .single(),
      'profiles.create',
    ) as ProfileRow;
    return mapProfile(row);
  }

  async findById(id: string): Promise<Profile | null> {
    // A soft-deleted account must stop authenticating immediately, not at the end
    // of the purge grace period. The memory driver filters deleted_at too; without
    // this filter the two drivers disagree and a deleted learner keeps full access.
    const row = unwrapMaybe(
      await this.db.from('profiles').select().eq('id', id).is('deleted_at', null).maybeSingle(),
      'profiles.findById',
    ) as ProfileRow | null;
    return row ? mapProfile(row) : null;
  }

  async update(id: string, patch: ProfileUpdate): Promise<Profile | null> {
    const update: Record<string, unknown> = {};
    if (patch.displayName !== undefined) update.display_name = patch.displayName;
    if (patch.englishLevel !== undefined) update.english_level = patch.englishLevel;
    if (patch.learningGoal !== undefined) update.learning_goal = patch.learningGoal;
    if (patch.dailyGoalMinutes !== undefined) update.daily_goal_minutes = patch.dailyGoalMinutes;
    if (patch.preferredArabicVoice !== undefined) update.preferred_arabic_voice = patch.preferredArabicVoice;
    if (patch.preferredEnglishVoice !== undefined) update.preferred_english_voice = patch.preferredEnglishVoice;
    if (patch.onboardingCompletedAt !== undefined) update.onboarding_completed_at = patch.onboardingCompletedAt;

    // Nothing to change is not an error; the caller wants the current row back.
    if (Object.keys(update).length === 0) return this.findById(id);

    const row = unwrapMaybe(
      await this.db
        .from('profiles')
        .update(update)
        .eq('id', id)
        .is('deleted_at', null)
        .select()
        .maybeSingle(),
      'profiles.update',
    ) as ProfileRow | null;
    return row ? mapProfile(row) : null;
  }

  async markDeleted(id: string, at: string): Promise<boolean> {
    const rows = unwrap(
      await this.db.from('profiles').update({ deleted_at: at }).eq('id', id).is('deleted_at', null).select('id'),
      'profiles.markDeleted',
    ) as { id: string }[];
    return rows.length > 0;
  }

  /**
   * Full account removal. Deleting the auth user cascades to every owned row
   * through the foreign keys, which is why the schema was built that way.
   * `usage_events.user_id` is ON DELETE SET NULL, so the operator's spend history
   * survives without retaining personal data.
   */
  async purge(id: string): Promise<void> {
    const { error } = await this.db.auth.admin.deleteUser(id);
    if (error) throw new RepositoryError(`profiles.purge: ${error.message}`, error);
  }

  async listPendingPurge(now: string, graceDays: number): Promise<string[]> {
    const cutoff = subtractDays(now, graceDays);
    const rows = unwrap(
      await this.db.from('profiles').select('id').not('deleted_at', 'is', null).lt('deleted_at', cutoff),
      'profiles.listPendingPurge',
    ) as { id: string }[];
    return rows.map((row) => row.id);
  }
}

// -----------------------------------------------------------------------------
// auth
// -----------------------------------------------------------------------------

class SupabaseAuth implements AuthRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  /**
   * Creates the identity anchor in `auth.users` plus our own credential row.
   *
   * The password of the Supabase Auth user is a random, unrecorded value: this API
   * verifies passwords itself against the scrypt hash in `auth_credentials` and
   * issues its own access tokens. Supabase Auth is used here only for the identity
   * anchor and cascade deletion, not as the credential verifier or session issuer.
   * Supabase Auth sessions are not used; mailbox verification is managed by this
   * API through `auth_credentials.email_verified_at`.
   */
  async createUser(email: string, passwordHash: string): Promise<AuthUserRecord> {
    const normalized = email.trim().toLowerCase();
    const { data, error } = await this.db.auth.admin.createUser({
      email: normalized,
      password: randomBytes(32).toString('base64url'),
      email_confirm: false,
    });
    if (error || !data.user) {
      throw new RepositoryError(`auth.createUser: ${error?.message ?? 'no user returned'}`, error);
    }
    const userId = data.user.id;

    let credential: AuthCredentialRow;
    try {
      credential = unwrap(
        await this.db
          .from('auth_credentials')
          .insert({ user_id: userId, email: normalized, password_hash: passwordHash })
          .select()
          .single(),
        'auth.createUser.credentials',
      ) as AuthCredentialRow;
    } catch (insertError) {
      try {
        const { error: cleanupError } = await this.db.auth.admin.deleteUser(userId);
        if (cleanupError) throw cleanupError;
      } catch (cleanupError) {
        throw new RepositoryError(
          'auth.createUser: credential creation failed and the partial identity could not be removed',
          new AggregateError([insertError, cleanupError]),
        );
      }
      throw insertError;
    }

    return {
      id: credential.user_id,
      email: credential.email,
      passwordHash: credential.password_hash,
      emailVerifiedAt: credential.email_verified_at,
      refreshTokenHash: credential.refresh_token_hash,
      createdAt: credential.created_at,
    };
  }

  private mapCredential(row: AuthCredentialRow): AuthUserRecord {
    return {
      id: row.user_id,
      email: row.email,
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at,
      refreshTokenHash: row.refresh_token_hash,
      createdAt: row.created_at,
    };
  }

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const row = unwrapMaybe(
      await this.db.from('auth_credentials').select().eq('email', email.trim().toLowerCase()).maybeSingle(),
      'auth.findByEmail',
    ) as AuthCredentialRow | null;
    return row ? this.mapCredential(row) : null;
  }

  async findById(id: string): Promise<AuthUserRecord | null> {
    const row = unwrapMaybe(
      await this.db.from('auth_credentials').select().eq('user_id', id).maybeSingle(),
      'auth.findById',
    ) as AuthCredentialRow | null;
    return row ? this.mapCredential(row) : null;
  }

  async createActionToken(
    userId: string,
    purpose: AuthActionPurpose,
    tokenHash: string,
    expiresAt: string,
    createdAt: string,
  ): Promise<void> {
    unwrapVoid(
      await this.db.from('auth_action_tokens').delete().eq('user_id', userId).eq('purpose', purpose),
      'auth.deletePriorActionTokens',
    );
    unwrapVoid(
      await this.db.from('auth_action_tokens').insert({
        user_id: userId,
        purpose,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_at: createdAt,
      }),
      'auth.createActionToken',
    );
  }

  async consumeActionToken(tokenHash: string, purpose: AuthActionPurpose, now: string): Promise<string | null> {
    const row = unwrapMaybe(
      await this.db
        .from('auth_action_tokens')
        .delete()
        .eq('token_hash', tokenHash)
        .eq('purpose', purpose)
        .gt('expires_at', now)
        .select('user_id')
        .maybeSingle(),
      'auth.consumeActionToken',
    ) as AuthActionTokenRow | null;
    return row?.user_id ?? null;
  }

  async markEmailVerified(userId: string, at: string): Promise<void> {
    unwrapVoid(
      await this.db
        .from('auth_credentials')
        .update({ email_verified_at: at })
        .eq('user_id', userId)
        .is('email_verified_at', null),
      'auth.markEmailVerified',
    );
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    unwrapVoid(
      await this.db
        .from('auth_credentials')
        .update({ password_hash: passwordHash, refresh_token_hash: null })
        .eq('user_id', userId),
      'auth.updatePasswordHash',
    );
  }

  async deleteExpiredActionTokens(now: string): Promise<number> {
    const rows = unwrap(
      await this.db.from('auth_action_tokens').delete().lte('expires_at', now).select('token_hash'),
      'auth.deleteExpiredActionTokens',
    ) as { token_hash: string }[];
    return rows.length;
  }

  async setRefreshTokenHash(userId: string, hash: string | null): Promise<void> {
    unwrapVoid(
      await this.db.from('auth_credentials').update({ refresh_token_hash: hash }).eq('user_id', userId),
      'auth.setRefreshTokenHash',
    );
  }

  async rotateRefreshToken(currentHash: string, nextHash: string): Promise<AuthUserRecord | null> {
    const row = unwrapMaybe(
      await this.db
        .from('auth_credentials')
        .update({ refresh_token_hash: nextHash })
        .eq('refresh_token_hash', currentHash)
        .select()
        .maybeSingle(),
      'auth.rotateRefreshToken',
    ) as AuthCredentialRow | null;
    return row ? this.mapCredential(row) : null;
  }
}

// -----------------------------------------------------------------------------
// consents
// -----------------------------------------------------------------------------

class SupabaseConsents implements ConsentRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async record(userId: string, consentType: ConsentType, policyVersion: string, at: string): Promise<ConsentRecord> {
    const row = unwrap(
      await this.db
        .from('consents')
        .insert({ user_id: userId, consent_type: consentType, policy_version: policyVersion, granted_at: at })
        .select()
        .single(),
      'consents.record',
    ) as ConsentRow;
    return mapConsent(row);
  }

  /**
   * Withdrawal records the time on the most recent active grant rather than
   * deleting the row: the audit trail has to show that consent existed and was
   * later withdrawn.
   */
  async withdraw(userId: string, consentType: ConsentType, at: string): Promise<void> {
    const rows = unwrap(
      await this.db
        .from('consents')
        .update({ withdrawn_at: at })
        .eq('user_id', userId)
        .eq('consent_type', consentType)
        .is('withdrawn_at', null)
        .select('id'),
      'consents.withdraw',
    ) as { id: string }[];
    if (rows.length === 0) {
      throw new RepositoryError(`consents.withdraw: no active ${consentType} consent for user`);
    }
  }

  async listForUser(userId: string): Promise<ConsentRecord[]> {
    const rows = unwrap(
      await this.db.from('consents').select().eq('user_id', userId).order('granted_at', { ascending: false }),
      'consents.listForUser',
    ) as ConsentRow[];
    return rows.map(mapConsent);
  }

  async hasActiveVoiceConsent(userId: string): Promise<boolean> {
    const rows = unwrap(
      await this.db
        .from('consents')
        .select('id')
        .eq('user_id', userId)
        .eq('consent_type', 'voice_processing')
        .is('withdrawn_at', null)
        .limit(1),
      'consents.hasActiveVoiceConsent',
    ) as { id: string }[];
    return rows.length > 0;
  }

  async listWithdrawnBefore(cutoff: string): Promise<ConsentRecord[]> {
    const rows = unwrap(
      await this.db.from('consents').select().not('withdrawn_at', 'is', null).lt('withdrawn_at', cutoff),
      'consents.listWithdrawnBefore',
    ) as ConsentRow[];
    return rows.map(mapConsent);
  }

  async deleteById(id: string): Promise<void> {
    unwrapVoid(await this.db.from('consents').delete().eq('id', id), 'consents.deleteById');
  }
}

// -----------------------------------------------------------------------------
// lessons
// -----------------------------------------------------------------------------

class SupabaseLessons implements LessonRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async upsertMany(lessons: Lesson[]): Promise<number> {
    if (lessons.length === 0) return 0;
    const rows = lessons.map((lesson) => ({
      slug: lesson.slug,
      title: lesson.title,
      title_ar: lesson.titleAr,
      description: lesson.description,
      level: lesson.level,
      topic: lesson.topic,
      duration_minutes: lesson.durationMinutes,
      evaluation_mode: lesson.evaluationMode,
      content_json: lesson.content,
      published: lesson.published,
    }));
    const written = unwrap(
      await this.db.from('lessons').upsert(rows, { onConflict: 'slug' }).select('id'),
      'lessons.upsertMany',
    ) as { id: string }[];
    return written.length;
  }

  async findById(id: string): Promise<Lesson | null> {
    const row = unwrapMaybe(await this.db.from('lessons').select().eq('id', id).maybeSingle(), 'lessons.findById') as LessonRow | null;
    return row ? mapLesson(row) : null;
  }

  async findBySlug(slug: string): Promise<Lesson | null> {
    const row = unwrapMaybe(
      await this.db.from('lessons').select().eq('slug', slug).maybeSingle(),
      'lessons.findBySlug',
    ) as LessonRow | null;
    return row ? mapLesson(row) : null;
  }

  async listPublished(): Promise<Lesson[]> {
    const rows = unwrap(
      await this.db.from('lessons').select().eq('published', true).order('created_at', { ascending: true }),
      'lessons.listPublished',
    ) as LessonRow[];
    return rows.map(mapLesson);
  }
}

// -----------------------------------------------------------------------------
// lesson attempts
// -----------------------------------------------------------------------------

class SupabaseLessonAttempts implements LessonAttemptRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async create(attempt: LessonAttempt): Promise<LessonAttempt> {
    const row = unwrap(
      await this.db
        .from('lesson_attempts')
        .insert({
          user_id: attempt.userId,
          lesson_id: attempt.lessonId,
          started_at: attempt.startedAt,
          status: attempt.status,
        })
        .select()
        .single(),
      'lessonAttempts.create',
    ) as LessonAttemptRow;
    return mapLessonAttempt(row);
  }

  async findById(id: string): Promise<LessonAttempt | null> {
    const row = unwrapMaybe(
      await this.db.from('lesson_attempts').select().eq('id', id).maybeSingle(),
      'lessonAttempts.findById',
    ) as LessonAttemptRow | null;
    return row ? mapLessonAttempt(row) : null;
  }

  async findLatestForUser(userId: string): Promise<LessonAttempt | null> {
    const rows = unwrapMaybe(
      await this.db
        .from('lesson_attempts')
        .select()
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .limit(1),
      'lessonAttempts.findLatestForUser',
    ) as LessonAttemptRow[] | null;
    const row = rows?.[0];
    return row ? mapLessonAttempt(row) : null;
  }

  async findInProgress(userId: string, lessonId: string): Promise<LessonAttempt | null> {
    const rows = unwrapMaybe(
      await this.db
        .from('lesson_attempts')
        .select()
        .eq('user_id', userId)
        .eq('lesson_id', lessonId)
        .eq('status', 'in_progress')
        .limit(1),
      'lessonAttempts.findInProgress',
    ) as LessonAttemptRow[] | null;
    const row = rows?.[0];
    return row ? mapLessonAttempt(row) : null;
  }

  /** Only an in-progress attempt can be completed, so a double-tap cannot re-score. */
  async complete(id: string, at: string, score: number | null): Promise<LessonAttempt | null> {
    const row = unwrapMaybe(
      await this.db
        .from('lesson_attempts')
        .update({ status: 'completed', completed_at: at, score })
        .eq('id', id)
        .eq('status', 'in_progress')
        .select()
        .maybeSingle(),
      'lessonAttempts.complete',
    ) as LessonAttemptRow | null;
    return row ? mapLessonAttempt(row) : null;
  }

  async listForUser(userId: string): Promise<LessonAttempt[]> {
    const rows = unwrap(
      await this.db.from('lesson_attempts').select().eq('user_id', userId).order('started_at', { ascending: false }),
      'lessonAttempts.listForUser',
    ) as LessonAttemptRow[];
    return rows.map(mapLessonAttempt);
  }

  async countCompleted(userId: string): Promise<number> {
    const { count, error } = await this.db
      .from('lesson_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'completed');
    if (error) throw new RepositoryError(`lessonAttempts.countCompleted: ${error.message}`, error);
    return count ?? 0;
  }

  async countStarted(userId: string): Promise<number> {
    const { count, error } = await this.db
      .from('lesson_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw new RepositoryError(`lessonAttempts.countStarted: ${error.message}`, error);
    return count ?? 0;
  }
}

// -----------------------------------------------------------------------------
// speaking attempts
// -----------------------------------------------------------------------------

class SupabaseSpeaking implements SpeakingAttemptRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async create(attempt: SpeakingAttempt): Promise<SpeakingAttempt> {
    const row = unwrap(
      await this.db
        .from('speaking_attempts')
        .insert({
          user_id: attempt.userId,
          lesson_attempt_id: attempt.lessonAttemptId,
          prompt_slug: attempt.promptSlug,
          transcript: attempt.transcript,
          evaluation_json: attempt.evaluation,
          language_mode: attempt.languageMode,
          duration_seconds: attempt.durationSeconds,
          audio_deleted_at: attempt.audioDeletedAt,
          created_at: attempt.createdAt,
        })
        .select()
        .single(),
      'speaking.create',
    ) as SpeakingRow;
    return mapSpeaking(row);
  }

  async findById(id: string): Promise<SpeakingAttempt | null> {
    const row = unwrapMaybe(await this.db.from('speaking_attempts').select().eq('id', id).maybeSingle(), 'speaking.findById') as SpeakingRow | null;
    return row ? mapSpeaking(row) : null;
  }

  async listForUser(userId: string, limit: number): Promise<SpeakingAttempt[]> {
    const rows = unwrap(
      await this.db
        .from('speaking_attempts')
        .select()
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit),
      'speaking.listForUser',
    ) as SpeakingRow[];
    return rows.map(mapSpeaking);
  }

  async countForUser(userId: string): Promise<number> {
    const { count, error } = await this.db
      .from('speaking_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw new RepositoryError(`speaking.countForUser: ${error.message}`, error);
    return count ?? 0;
  }

  async findByAttemptId(userId: string, attemptId: string): Promise<SpeakingAttempt | null> {
    const rows = unwrapMaybe(
      await this.db
        .from('speaking_attempts')
        .select()
        .eq('user_id', userId)
        .eq('lesson_attempt_id', attemptId)
        .limit(1),
      'speaking.findByAttemptId',
    ) as SpeakingRow[] | null;
    const row = rows?.[0];
    return row ? mapSpeaking(row) : null;
  }

  async clearTranscriptsBefore(cutoff: string): Promise<number> {
    const rows = unwrap(
      await this.db
        .from('speaking_attempts')
        .update({ transcript: null })
        .lt('created_at', cutoff)
        .not('transcript', 'is', null)
        .select('id'),
      'speaking.clearTranscriptsBefore',
    ) as { id: string }[];
    return rows.length;
  }

  async clearEvaluationsBefore(cutoff: string): Promise<number> {
    const rows = unwrap(
      await this.db
        .from('speaking_attempts')
        .update({ evaluation_json: null })
        .lt('created_at', cutoff)
        .not('evaluation_json', 'is', null)
        .select('id'),
      'speaking.clearEvaluationsBefore',
    ) as { id: string }[];
    return rows.length;
  }

  /**
   * Aggregates in TypeScript from a single bounded query rather than one query per
   * attempt (which would be an N+1). Only the JSON column is fetched, and the scan
   * is capped, so a learner with a long history cannot turn the progress screen
   * into an unbounded read.
   */
  async correctionCounts(userId: string): Promise<Record<string, number>> {
    const rows = unwrap(
      await this.db
        .from('speaking_attempts')
        .select('evaluation_json')
        .eq('user_id', userId)
        .not('evaluation_json', 'is', null)
        .order('created_at', { ascending: false })
        .limit(CORRECTION_SCAN_LIMIT),
      'speaking.correctionCounts',
    ) as { evaluation_json: SpeakingEvaluation | null }[];

    const counts: Record<string, number> = {};
    for (const row of rows) {
      for (const correction of row.evaluation_json?.corrections ?? []) {
        counts[correction.type] = (counts[correction.type] ?? 0) + 1;
      }
    }
    return counts;
  }
}

// -----------------------------------------------------------------------------
// vocabulary
// -----------------------------------------------------------------------------

class SupabaseVocabulary implements VocabularyRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  /** `onConflict` on (user_id, english_term) means saving the same term twice updates it. */
  async upsert(item: Omit<VocabularyItem, 'id' | 'createdAt'> & { id?: string }): Promise<VocabularyItem> {
    const row = unwrap(
      await this.db
        .from('vocabulary')
        .upsert(
          {
            user_id: item.userId,
            english_term: item.englishTerm,
            arabic_meaning: item.arabicMeaning,
            example_sentence: item.exampleSentence,
            review_state: item.reviewState,
            next_review_at: item.nextReviewAt,
          },
          { onConflict: 'user_id,english_term' },
        )
        .select()
        .single(),
      'vocabulary.upsert',
    ) as VocabularyRow;
    return mapVocabulary(row);
  }

  async listForUser(userId: string): Promise<VocabularyItem[]> {
    const rows = unwrap(
      await this.db.from('vocabulary').select().eq('user_id', userId).order('created_at', { ascending: false }),
      'vocabulary.listForUser',
    ) as VocabularyRow[];
    return rows.map(mapVocabulary);
  }

  async countForUser(userId: string): Promise<number> {
    const { count, error } = await this.db
      .from('vocabulary')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw new RepositoryError(`vocabulary.countForUser: ${error.message}`, error);
    return count ?? 0;
  }

  async countDue(userId: string, now: string): Promise<number> {
    const { count, error } = await this.db
      .from('vocabulary')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .lte('next_review_at', now);
    if (error) throw new RepositoryError(`vocabulary.countDue: ${error.message}`, error);
    return count ?? 0;
  }

  async setReviewState(
    id: string,
    userId: string,
    state: ReviewState,
    nextReviewAt: string | null,
  ): Promise<VocabularyItem | null> {
    const row = unwrapMaybe(
      await this.db
        .from('vocabulary')
        .update({ review_state: state, next_review_at: nextReviewAt })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .maybeSingle(),
      'vocabulary.setReviewState',
    ) as VocabularyRow | null;
    return row ? mapVocabulary(row) : null;
  }
}

// -----------------------------------------------------------------------------
// usage ledger
// -----------------------------------------------------------------------------

class SupabaseUsage implements UsageRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  /**
   * Delegates to the SQL function that atomically enforces both per-user quotas
   * and the shared daily credit budget before inserting a reservation.
   */
  async reserve(input: ReserveUsageInput): Promise<ReserveUsageResult> {
    const data = unwrap(
      await this.db.rpc('reserve_usage_with_budget', {
        p_user_id: input.userId,
        p_feature: input.feature,
        p_quantity: input.quantity,
        p_credits: input.creditsEstimated,
        p_provider: input.provider,
        p_model: input.model,
        p_request_id: input.requestId,
        p_day: input.day,
        p_speaking_limit: input.speakingDailyLimit,
        p_tts_limit: input.ttsDailyLimit,
        p_daily_credit_budget: input.dailyCreditBudget,
      }),
      'usage.reserve',
    ) as { id: string; allowed: boolean; reason: string; status: string; credits: number }[];

    const row = data[0];
    if (!row) throw new RepositoryError('usage.reserve: function returned no row');

    // The reservation row is echoed back so the caller can settle it. On a quota
    // rejection nothing was inserted, so the returned id is a fresh throwaway.
    const event: UsageEvent = {
      id: row.id,
      userId: input.userId,
      provider: input.provider,
      feature: input.feature,
      model: input.model,
      usageQuantity: input.quantity,
      creditsEstimated: row.credits,
      cacheHit: false,
      requestId: input.requestId,
      status: row.status as UsageStatus,
      createdAt: new Date().toISOString(),
    };

    if (row.allowed) return { event, allowed: true, reason: 'ok' };
    if (
      row.reason === 'speaking_quota' ||
      row.reason === 'tts_quota' ||
      row.reason === 'credit_budget'
    ) {
      return { event, allowed: false, reason: row.reason };
    }
    throw new RepositoryError(`usage.reserve: unexpected refusal reason ${row.reason}`);
  }

  async settle(
    eventId: string,
    patch: { status: UsageStatus; cacheHit?: boolean; creditsEstimated?: number },
  ): Promise<void> {
    unwrapVoid(
      await this.db.rpc('settle_usage', {
        p_event_id: eventId,
        p_status: patch.status,
        p_cache_hit: patch.cacheHit ?? null,
        p_credits: patch.creditsEstimated ?? null,
      }),
      'usage.settle',
    );
  }

  async findById(eventId: string): Promise<UsageEvent | null> {
    const row = unwrapMaybe(await this.db.from('usage_events').select().eq('id', eventId).maybeSingle(), 'usage.findById') as UsageRow | null;
    return row ? mapUsage(row) : null;
  }

  async summary(userId: string, day: string): Promise<{ speakingAttempts: number; ttsRequests: number; credits: number }> {
    // One query, aggregated in TypeScript. The per-user-per-day row count is
    // bounded by the free-allowance limits, so this stays small.
    const rows = unwrap(
      await this.db.from('usage_events').select('feature, credits_estimated').eq('user_id', userId).eq('day', day).neq('status', 'failed'),
      'usage.summary',
    ) as { feature: UsageFeature; credits_estimated: number }[];

    return {
      speakingAttempts: rows.filter((row) => row.feature === 'stt').length,
      ttsRequests: rows.filter((row) => row.feature === 'tts').length,
      credits: rows.reduce((sum, row) => sum + row.credits_estimated, 0),
    };
  }

  private async countCache(userId: string, day: string, feature: UsageFeature, hit: boolean): Promise<number> {
    const { count, error } = await this.db
      .from('usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('day', day)
      .eq('feature', feature)
      .eq('cache_hit', hit)
      .neq('status', 'failed');
    if (error) throw new RepositoryError(`usage.countCache: ${error.message}`, error);
    return count ?? 0;
  }

  async countCacheHits(userId: string, day: string, feature: UsageFeature): Promise<number> {
    return this.countCache(userId, day, feature, true);
  }

  async countCacheMisses(userId: string, day: string, feature: UsageFeature): Promise<number> {
    return this.countCache(userId, day, feature, false);
  }

  async creditsForDay(day: string): Promise<number> {
    const rows = unwrap(
      await this.db.from('usage_events').select('credits_estimated').eq('day', day).neq('status', 'failed'),
      'usage.creditsForDay',
    ) as { credits_estimated: number }[];
    return rows.reduce((sum, row) => sum + row.credits_estimated, 0);
  }

  async listForUser(userId: string, limit: number): Promise<UsageEvent[]> {
    const rows = unwrap(
      await this.db
        .from('usage_events')
        .select()
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit),
      'usage.listForUser',
    ) as UsageRow[];
    return rows.map(mapUsage);
  }

  async deleteBefore(cutoff: string): Promise<number> {
    const rows = unwrap(
      await this.db.from('usage_events').delete().lt('created_at', cutoff).select('id'),
      'usage.deleteBefore',
    ) as { id: string }[];
    return rows.length;
  }
}

// -----------------------------------------------------------------------------
// TTS cache
// -----------------------------------------------------------------------------

class SupabaseTtsCache implements TtsCacheRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async get(cacheKey: string): Promise<TtsCacheEntry | null> {
    const row = unwrapMaybe(
      await this.db.from('tts_cache').select().eq('cache_key', cacheKey).maybeSingle(),
      'ttsCache.get',
    ) as TtsCacheRow | null;
    return row ? mapTtsCache(row) : null;
  }

  async put(entry: TtsCacheEntry): Promise<void> {
    unwrapVoid(
      await this.db.from('tts_cache').upsert(
        {
          cache_key: entry.cacheKey,
          text: entry.text,
          text_hash: entry.textHash,
          voice_id: entry.voiceId,
          model: entry.model,
          content_type: entry.contentType,
          audio: encodeBytea(entry.audio),
          duration_seconds: entry.durationSeconds,
          created_at: entry.createdAt,
          last_used_at: entry.lastUsedAt,
          hits: entry.hits,
        },
        { onConflict: 'cache_key' },
      ),
      'ttsCache.put',
    );
  }

  /**
   * Increments `hits` via SQL so concurrent cache hits cannot lose an increment to
   * a read-modify-write in application code. The hit count is cost-attribution
   * data: "how many credits did caching save?" must be answerable.
   */
  async touch(cacheKey: string, at: string): Promise<void> {
    unwrapVoid(
      await this.db.rpc('touch_tts_cache', { p_cache_key: cacheKey, p_at: at }),
      'ttsCache.touch',
    );
  }

  async deleteBefore(cutoff: string): Promise<number> {
    const rows = unwrap(
      await this.db.from('tts_cache').delete().lt('last_used_at', cutoff).select('cache_key'),
      'ttsCache.deleteBefore',
    ) as { cache_key: string }[];
    return rows.length;
  }
}

// -----------------------------------------------------------------------------
// idempotency
// -----------------------------------------------------------------------------

class SupabaseIdempotency implements IdempotencyRepository {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async get(
    key: string,
    userId: string,
    endpoint: string,
  ): Promise<{ requestHash: string; responseJson: string } | null> {
    const row = unwrapMaybe(
      await this.db
        .from('idempotency_records')
        .select('request_hash, response_json')
        .eq('key', key)
        .eq('user_id', userId)
        .eq('endpoint', endpoint)
        .maybeSingle(),
      'idempotency.get',
    ) as { request_hash: string; response_json: string } | null;
    return row ? { requestHash: row.request_hash, responseJson: row.response_json } : null;
  }

  /**
   * `ignoreDuplicates` makes the insert a no-op when the key already exists, so a
   * concurrent retry cannot fail with a primary-key violation — the first writer
   * wins and the loser simply re-reads.
   */
  async put(record: {
    key: string;
    userId: string;
    endpoint: string;
    requestHash: string;
    responseJson: string;
    createdAt: string;
  }): Promise<void> {
    unwrapVoid(
      await this.db.from('idempotency_records').upsert(
        {
          key: record.key,
          user_id: record.userId,
          endpoint: record.endpoint,
          request_hash: record.requestHash,
          response_json: record.responseJson,
          created_at: record.createdAt,
        },
        { onConflict: 'user_id,endpoint,key', ignoreDuplicates: true },
      ),
      'idempotency.put',
    );
  }

  async deleteBefore(cutoff: string): Promise<number> {
    const rows = unwrap(
      await this.db.from('idempotency_records').delete().lt('created_at', cutoff).select('key'),
      'idempotency.deleteBefore',
    ) as { key: string }[];
    return rows.length;
  }
}

// -----------------------------------------------------------------------------
// Repository
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assessRlsAudit(data: unknown): { ok: boolean; detail: string } {
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, detail: 'RLS audit returned no public tables' };
  }

  const unprotected: string[] = [];
  for (const rawRow of data) {
    if (!isRecord(rawRow) || typeof rawRow.table_name !== 'string' || typeof rawRow.rls_enabled !== 'boolean') {
      return { ok: false, detail: 'RLS audit returned an invalid row' };
    }
    if (!rawRow.rls_enabled) unprotected.push(rawRow.table_name);
  }

  if (unprotected.length > 0) {
    return { ok: false, detail: `RLS disabled on public tables: ${unprotected.join(', ')}` };
  }
  return { ok: true, detail: `RLS enabled on ${data.length} public tables` };
}

export class SupabaseRepository implements Repository {
  readonly driver = 'supabase' as const;
  /** Multi-write operations can rely on real transactions in Postgres. */
  readonly supportsTransactions = true;

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

  private readonly db: SupabaseClient;

  constructor(options: SupabaseRepositoryOptions) {
    this.db = createClient(options.url, options.serviceRoleKey, {
      // A server process must not keep a user session or refresh tokens.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    this.profiles = new SupabaseProfiles(this.db);
    this.auth = new SupabaseAuth(this.db);
    this.consents = new SupabaseConsents(this.db);
    this.lessons = new SupabaseLessons(this.db);
    this.lessonAttempts = new SupabaseLessonAttempts(this.db);
    this.speaking = new SupabaseSpeaking(this.db);
    this.vocabulary = new SupabaseVocabulary(this.db);
    this.usage = new SupabaseUsage(this.db);
    this.ttsCache = new SupabaseTtsCache(this.db);
    this.idempotency = new SupabaseIdempotency(this.db);
  }

  /**
   * Connectivity and RLS probe used by /health. A reachable table alone does not
   * prove the migrations installed the row-level security posture.
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { error } = await this.db.from('lessons').select('id', { count: 'exact', head: true }).limit(1);
      if (error) return { ok: false, detail: `supabase unreachable: ${error.message}` };
      const { data, error: auditError } = await this.db.rpc('rls_audit');
      if (auditError) return { ok: false, detail: `RLS audit failed: ${auditError.message}` };
      const audit = assessRlsAudit(data);
      if (!audit.ok) return audit;
      return { ok: true, detail: `supabase (postgres) reachable; ${audit.detail}` };
    } catch (error) {
      return { ok: false, detail: `supabase unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export { subtractDays, subtractMonths };
