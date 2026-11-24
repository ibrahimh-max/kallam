/**
 * Domain models.
 *
 * These are the shapes the learning logic is written against. They deliberately
 * mirror the schema in build (1).md §8, with one documented addition:
 * `UsageEvent.status`, which is required to implement the spec's own rule that a
 * provider failure must release reserved quota (§7.2). Without a status a
 * reservation and a settled charge are indistinguishable.
 *
 * Rules encoded here, not in prose elsewhere:
 *  - No model carries raw audio. Audio lives only inside a request.
 *  - Timestamps are UTC ISO-8601 strings.
 *  - Money/credits are integers (credits) or fractional credits rounded at the
 *    ledger, never floats in arithmetic that matters for billing.
 */

export type EnglishLevel = 'complete_beginner' | 'few_words' | 'simple_understanding' | 'basic_conversation';
export type LearningGoal = 'everyday' | 'work' | 'travel' | 'study' | 'general';
export type DailyGoalMinutes = 5 | 10 | 15;

export const ENGLISH_LEVELS: readonly EnglishLevel[] = ['complete_beginner', 'few_words', 'simple_understanding', 'basic_conversation'];
export const LEARNING_GOALS: readonly LearningGoal[] = ['everyday', 'work', 'travel', 'study', 'general'];
export const DAILY_GOALS: readonly DailyGoalMinutes[] = [5, 10, 15];

/** Short, plain Arabic labels used by the app's onboarding choices. */
export const LEARNING_GOAL_LABELS_AR: Record<LearningGoal, string> = {
  everyday: 'محادثات يومية',
  work: 'العمل والوظيفة',
  travel: 'السفر',
  study: 'الدراسة',
  general: 'إنجليزي عام',
};

export const ENGLISH_LEVEL_LABELS_AR: Record<EnglishLevel, string> = {
  complete_beginner: 'مبتدئ تماماً',
  few_words: 'أعرف كلمات بسيطة',
  simple_understanding: 'أفهم إنجليزي بسيط',
  basic_conversation: 'أقدر أسوي محادثة بسيطة',
};

export interface Profile {
  id: string;
  displayName: string | null;
  /** Voice UUID chosen by the learner; null means server default. */
  preferredArabicVoice: string | null;
  preferredEnglishVoice: string | null;
  englishLevel: EnglishLevel | null;
  learningGoal: LearningGoal | null;
  dailyGoalMinutes: DailyGoalMinutes | null;
  onboardingCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set when deletion was requested; the row is purged after the grace period. */
  deletedAt: string | null;
}

export interface PublicProfile {
  id: string;
  display_name: string | null;
  english_level: EnglishLevel | null;
  learning_goal: LearningGoal | null;
  daily_goal_minutes: DailyGoalMinutes | null;
  onboarding_completed: boolean;
  preferred_arabic_voice: string | null;
  preferred_english_voice: string | null;
  created_at: string;
  /**
   * Whether voice processing consent is active right now.
   *
   * It lives on the profile payload because the app must render the consent switch
   * from the server's truth: a locally remembered flag would let the UI show
   * "granted" for a learner whose consent was withdrawn on another device.
   */
  voice_consent_granted: boolean;
}

export function toPublicProfile(profile: Profile, voiceConsentGranted = false): PublicProfile {
  return {
    id: profile.id,
    display_name: profile.displayName,
    english_level: profile.englishLevel,
    learning_goal: profile.learningGoal,
    daily_goal_minutes: profile.dailyGoalMinutes,
    onboarding_completed: profile.onboardingCompletedAt !== null,
    preferred_arabic_voice: profile.preferredArabicVoice,
    preferred_english_voice: profile.preferredEnglishVoice,
    created_at: profile.createdAt,
    voice_consent_granted: voiceConsentGranted,
  };
}

export type ConsentType = 'voice_processing' | 'terms_of_service' | 'privacy_policy';

export interface ConsentRecord {
  id: string;
  userId: string;
  consentType: ConsentType;
  policyVersion: string;
  grantedAt: string;
  withdrawnAt: string | null;
}

// ---------------------------------------------------------------------------
// Lessons (content authored in the repo, seeded into the database)
// ---------------------------------------------------------------------------

export interface LessonStep {
  id: string;
  kind: LessonStepKind;
  /** Arabic tutor explanation shown first (Saudi Arabic). */
  explanationAr?: string;
  english?: string;
  arabicMeaning?: string;
  /** Audio cues resolved through the TTS cache. */
  audio?: { englishPhrase?: string; arabicExplanation?: string };
}

export type LessonStepKind = 'intro' | 'phrase' | 'listen' | 'understand' | 'practise' | 'review';

export interface ComprehensionQuestion {
  prompt: string;
  questionAr: string;
  options: string[];
  answerIndex: number;
}

export interface SpeakingPrompt {
  id: string;
  /** Stable prompt slug used by evaluation rules, e.g. `coffee_order_01`. */
  slug: string;
  taskAr: string;
  taskEn: string;
  modelAnswer: string;
  /** Accepted variants; comparison is normalised, never exact-match-only. */
  acceptedAnswers: string[];
  /** Keywords that must appear for the intent to count as recovered. */
  requiredKeywords: string[];
  /** Language mode for STT. English tasks use english_only. */
  languageMode: 'english_only' | 'arabic_only' | 'code_switch';
  /** Bounded correction hints keyed by a grammar rule. */
  correctionHints?: { match: string; suggested: string; explanationAr: string; type: CorrectionType }[];
}

export type CorrectionType = 'grammar' | 'word_choice' | 'style' | 'missing_word';

export interface LessonContent {
  steps: LessonStep[];
  comprehension?: ComprehensionQuestion[];
  speakingPrompts: SpeakingPrompt[];
  vocabulary: { englishTerm: string; arabicMeaning: string; exampleSentence: string }[];
}

export interface Lesson {
  id: string;
  slug: string;
  title: string;
  titleAr: string;
  description: string;
  level: EnglishLevel;
  topic: string;
  durationMinutes: number;
  /** Deterministic evaluation only in the MVP; `llm_assisted` is Phase 2. */
  evaluationMode: 'deterministic';
  content: LessonContent;
  published: boolean;
  createdAt: string;
}

export type LessonAttemptStatus = 'in_progress' | 'completed' | 'abandoned';

export interface LessonAttempt {
  id: string;
  userId: string;
  lessonId: string;
  startedAt: string;
  completedAt: string | null;
  score: number | null;
  status: LessonAttemptStatus;
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

export interface SpeakingEvaluation {
  understood: boolean;
  task_completed: boolean;
  corrections: {
    type: CorrectionType;
    original: string;
    suggested: string;
    explanation_ar: string;
  }[];
  model_answer: string;
  encouragement_ar: string;
  /** Deterministic retry signal replacing the unavailable confidence score (R1). */
  retry_required: boolean;
  retry_reason_ar: string | null;
  /** How the transcript was matched, for the beta log. Never a pronunciation score. */
  match_method: 'exact' | 'normalised' | 'keywords' | 'none';
}

export interface SpeakingAttempt {
  id: string;
  userId: string;
  lessonAttemptId: string | null;
  promptSlug: string;
  /** Null once the retention job has cleared it. */
  transcript: string | null;
  evaluation: SpeakingEvaluation | null;
  languageMode: 'english_only' | 'arabic_only' | 'code_switch';
  durationSeconds: number;
  audioDeletedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Vocabulary / progress
// ---------------------------------------------------------------------------

export type ReviewState = 'new' | 'learning' | 'review' | 'mastered';

export interface VocabularyItem {
  id: string;
  userId: string;
  englishTerm: string;
  arabicMeaning: string;
  exampleSentence: string;
  reviewState: ReviewState;
  nextReviewAt: string | null;
  createdAt: string;
}

export interface Progress {
  lessons_completed: number;
  lessons_started: number;
  speaking_attempts: number;
  vocabulary_learned: number;
  vocabulary_due_for_review: number;
  /** Minutes of completed lessons in the current ISO week. */
  weekly_minutes: number;
  current_streak_days: number;
  /** Most frequent correction rules, with a plain Arabic label. */
  common_mistakes: { type: CorrectionType; count: number; label_ar: string }[];
}

// ---------------------------------------------------------------------------
// Usage ledger
// ---------------------------------------------------------------------------

export type UsageFeature = 'stt' | 'tts' | 'evaluation';
export type UsageStatus = 'reserved' | 'succeeded' | 'failed';

export interface UsageEvent {
  id: string;
  userId: string | null;
  provider: string;
  feature: UsageFeature;
  model: string | null;
  usageQuantity: number;
  creditsEstimated: number;
  cacheHit: boolean;
  requestId: string;
  status: UsageStatus;
  createdAt: string;
}

export interface UsageSummary {
  /** UTC day the counters describe. */
  day: string;
  speaking_attempts_used: number;
  speaking_attempts_limit: number;
  tts_requests_used: number;
  tts_requests_limit: number;
  credits_used_today: number;
  credits_today_budget: number;
  tts_cache_hits_today: number;
  tts_cache_misses_today: number;
}

// ---------------------------------------------------------------------------
// TTS cache
// ---------------------------------------------------------------------------

/**
 * Cache identity. The spec requires text hash + voice + model + settings, and a
 * version bump when lesson text or voice settings change (§7.2).
 */
export interface TtsCacheEntry {
  cacheKey: string;
  text: string;
  textHash: string;
  voiceId: string;
  model: string;
  /** Container actually served to the client. */
  contentType: 'audio/wav';
  audio: Uint8Array;
  durationSeconds: number;
  createdAt: string;
  lastUsedAt: string;
  hits: number;
}

export interface IdempotencyRecord {
  key: string;
  userId: string;
  endpoint: string;
  requestHash: string;
  responseJson: string;
  createdAt: string;
}

export interface AuthUserRecord {
  id: string;
  email: string;
  /** scrypt hash; only ever produced by the auth service. */
  passwordHash: string;
  /** Null until the learner proves control of the mailbox. */
  emailVerifiedAt: string | null;
  /** Rotating refresh-token hash; null when signed out everywhere. */
  refreshTokenHash: string | null;
  createdAt: string;
}

export type AuthActionPurpose = 'verify_email' | 'password_recovery';

/** Credit estimates. Reconciled against the HUMAIN console (see docs). */
export const CREDIT_ESTIMATES = {
  /** STT is billed per audio second; the console figure is the source of truth. */
  sttCreditsPerSecond: 1,
  /** TTS per-character cost is NOT documented; this is a conservative placeholder. */
  ttsCreditsPer1000Chars: 1,
} as const;
