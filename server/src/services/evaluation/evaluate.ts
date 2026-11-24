/**
 * Deterministic lesson evaluation.
 *
 * Why deterministic: HUMAIN exposes no confidence score, so the spec's
 * "confidence < 0.5" rule cannot be implemented (Milestone 0 finding). The owner
 * approved R1 instead: a bounded deterministic turn. This file is that decision.
 *
 * The rule that governs everything here: **never invent a correction.** If we did
 * not hear something usable, the learner is asked to try again in Arabic. Only
 * corrections that come from an authored, published rule for that prompt are
 * emitted — no model, no guessing, no hallucinated grammar advice.
 *
 * Cost: 0 provider credits. That is not an accident: every correction is a lookup.
 */
import type {
  CorrectionType,
  LessonContent,
  SpeakingEvaluation,
  SpeakingPrompt,
} from '../../domain/models.ts';

/** Minimum usable transcript length, in words, before we attempt a comparison. */
export const MIN_TRANSCRIPT_WORDS = 1;

/** Below this many words we treat the clip as too short to judge at all. */
export const SHORT_TRANSCRIPT_WORDS = 2;

const RETRY_EMPTY_AR = 'ما سمعنا شيء واضح. جرّب تتكلم أقرب من المايك ومرة ثانية.';
const RETRY_SHORT_AR = 'اللي قلته قصير مرة. جرّب تقول جملة كاملة.';
const RETRY_UNMATCHED_AR = 'نحاول مرة ثانية. قول الجملة اللي فوق بصوت واضح.';

/**
 * Normalisation before comparison.
 *
 * Apostrophes and hyphens are removed rather than replaced with a space so
 * "I'd like" and "Id like" match; punctuation is dropped for the same reason.
 * Arabic diacritics are stripped because authored answers are unvocalised.
 * This is a *word* comparison for intent matching — explicitly not phonetic
 * assessment, and it is never reported as a pronunciation score.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '') // Arabic diacritics
    .replace(/['’`\-_]/g, '')
    .replace(/[.,!?;:"()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(text: string): string[] {
  const normalised = normalise(text);
  return normalised === '' ? [] : normalised.split(' ');
}

/** Token-level similarity; used to pick the closest authored variant. */
export function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Map<string, number>();
  for (const word of right) rightSet.set(word, (rightSet.get(word) ?? 0) + 1);
  let overlap = 0;
  for (const word of left) {
    const count = rightSet.get(word) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightSet.set(word, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

export interface EvaluationInput {
  prompt: SpeakingPrompt;
  transcript: string;
  /** Lesson content, so authored correction hints can be reached. */
  content?: LessonContent;
}

export interface EvaluationOutcome {
  evaluation: SpeakingEvaluation;
  /** True when a correction was emitted from an authored rule. */
  usedAuthoredRule: boolean;
}

/** Encouragement is chosen by outcome, not generated. */
function encouragementAr(understood: boolean, taskCompleted: boolean): string {
  if (understood && taskCompleted) return 'ممتاز! وصلت الفكرة.';
  if (understood) return 'زين، فهمنا قصدك. خلنا نضبطها شوي.';
  return 'حاول مرة ثانية، إحنا معك.';
}

export function evaluateSpeaking(input: EvaluationInput): EvaluationOutcome {
  const { prompt, transcript } = input;
  const transcriptWords = words(transcript);

  // --- Branch 1: nothing usable was heard. Ask again, invent nothing. --------
  if (transcriptWords.length === 0) {
    return {
      usedAuthoredRule: false,
      evaluation: {
        understood: false,
        task_completed: false,
        corrections: [],
        model_answer: prompt.modelAnswer,
        encouragement_ar: encouragementAr(false, false),
        retry_required: true,
        retry_reason_ar: RETRY_EMPTY_AR,
        match_method: 'none',
      },
    };
  }

  if (transcriptWords.length < SHORT_TRANSCRIPT_WORDS && words(prompt.modelAnswer).length >= SHORT_TRANSCRIPT_WORDS) {
    return {
      usedAuthoredRule: false,
      evaluation: {
        understood: false,
        task_completed: false,
        corrections: [],
        model_answer: prompt.modelAnswer,
        encouragement_ar: encouragementAr(false, false),
        retry_required: true,
        retry_reason_ar: RETRY_SHORT_AR,
        match_method: 'none',
      },
    };
  }

  // --- Branch 2: compare against authored answers only. ---------------------
  const candidates = [prompt.modelAnswer, ...prompt.acceptedAnswers];
  let best = { answer: prompt.modelAnswer, score: 0 };
  for (const candidate of candidates) {
    const score = similarity(transcript, candidate);
    if (score > best.score) best = { answer: candidate, score };
  }

  const normalisedTranscript = normalise(transcript);
  const exactMatch = candidates.some((candidate) => normalise(candidate) === normalisedTranscript);
  const keywordHits = prompt.requiredKeywords.filter((keyword) => normalisedTranscript.includes(normalise(keyword)));
  const keywordsSatisfied = prompt.requiredKeywords.length > 0 && keywordHits.length === prompt.requiredKeywords.length;

  // Thresholds are deliberately generous: a Saudi accent, a dropped article or a
  // filled pause must not turn a correct answer into a failure. Only a genuinely
  // different utterance falls through to the retry branch.
  const understood = exactMatch || best.score >= 0.6 || keywordsSatisfied;

  if (!understood) {
    return {
      usedAuthoredRule: false,
      evaluation: {
        understood: false,
        task_completed: false,
        corrections: [],
        model_answer: prompt.modelAnswer,
        encouragement_ar: encouragementAr(false, false),
        retry_required: true,
        retry_reason_ar: RETRY_UNMATCHED_AR,
        match_method: 'none',
      },
    };
  }

  const taskCompleted = exactMatch || best.score >= 0.8 || keywordsSatisfied;
  const matchMethod: SpeakingEvaluation['match_method'] = exactMatch ? 'exact' : best.score >= 0.6 ? 'normalised' : 'keywords';

  // --- Branch 3: corrections come only from authored rules. ----------------
  const corrections: SpeakingEvaluation['corrections'] = [];
  const hints = prompt.correctionHints ?? [];
  for (const hint of hints) {
    const needle = normalise(hint.match);
    if (needle === '') continue;
    // The learner said the problematic form and did not already say the good one.
    if (normalisedTranscript.includes(needle) && !normalisedTranscript.includes(normalise(hint.suggested))) {
      corrections.push({
        type: hint.type,
        original: extractOriginal(transcript, hint.match),
        suggested: hint.suggested,
        explanation_ar: hint.explanationAr,
      });
    }
    if (corrections.length >= 2) break; // "one or two important mistakes at a time"
  }

  return {
    usedAuthoredRule: corrections.length > 0,
    evaluation: {
      understood: true,
      task_completed: taskCompleted,
      corrections,
      model_answer: prompt.modelAnswer,
      encouragement_ar: encouragementAr(true, taskCompleted),
      retry_required: false,
      retry_reason_ar: null,
      match_method: matchMethod,
    },
  };
}

/**
 * Quote the learner's own words rather than echoing the rule's match string, so
 * the correction card shows what they actually said.
 */
function extractOriginal(transcript: string, match: string): string {
  const needle = normalise(match);
  const transcriptNormalised = normalise(transcript);
  const index = transcriptNormalised.indexOf(needle);
  if (index < 0) return transcript.trim();
  // Map back approximately: word counts line up because normalise only drops
  // characters, so split the raw transcript on the same word boundary.
  const wordIndex = transcriptNormalised.slice(0, index).split(' ').filter(Boolean).length;
  const matchWordCount = needle.split(' ').filter(Boolean).length;
  const rawWords = transcript.trim().split(/\s+/);
  return rawWords.slice(wordIndex, wordIndex + matchWordCount).join(' ') || match;
}

/** Correction labels for the progress view, in plain Arabic. */
export const CORRECTION_LABELS_AR: Record<CorrectionType, string> = {
  grammar: 'قواعد',
  word_choice: 'اختيار الكلمة',
  style: 'أسلوب الكلام',
  missing_word: 'كلمة ناقصة',
};
