/**
 * Lesson delivery.
 *
 * `todayLesson` implements the starter path rule: the next unpublished-by-this-user
 * lesson in curriculum order, so a new learner always has something to do and a
 * returning learner does not repeat finished work. It is deliberately *not* an
 * adaptive recommender — that is Phase 3, and pretending otherwise would be
 * fabricated personalisation (build (1).md §5).
 */
import { AppError } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { Lesson, LessonAttempt, LearningGoal } from '../../domain/models.ts';
import type { Repository } from '../../repositories/Repository.ts';

export interface LessonWithProgress {
  lesson: Lesson;
  /** The learner's attempt for this lesson, if one exists. */
  attempt: LessonAttempt | null;
  completed: boolean;
}

export class LessonService {
  private readonly repo: Repository;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(repo: Repository, logger: Logger, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.logger = logger;
    this.now = now;
  }

  async listPublished(): Promise<Lesson[]> {
    return this.repo.lessons.listPublished();
  }

  async getById(id: string): Promise<Lesson> {
    const lesson = await this.repo.lessons.findById(id);
    if (!lesson || !lesson.published) throw new AppError('UNKNOWN_LESSON');
    return lesson;
  }

  /**
   * Today's lesson: first published lesson the learner has not completed, with a
   * mild preference for their chosen goal. If everything is complete, return the
   * most recent one so the learner can revise rather than see an empty screen.
   */
  async todayLesson(userId: string, goal: LearningGoal | null): Promise<LessonWithProgress> {
    const [lessons, attempts] = await Promise.all([this.repo.lessons.listPublished(), this.repo.lessonAttempts.listForUser(userId)]);

    if (lessons.length === 0) {
      throw new AppError('UNKNOWN_LESSON', { messageAr: 'ما فيه دروس متوفرة حالياً.', messageEn: 'no published lessons available' });
    }

    const completedIds = new Set(attempts.filter((a) => a.status === 'completed').map((a) => a.lessonId));
    const inProgressByLesson = new Map(attempts.filter((a) => a.status === 'in_progress').map((a) => [a.lessonId, a]));

    // Goal-matching lessons first, then the rest; order within each group is the
    // authored curriculum order, which is the intended difficulty progression.
    const ordered = goal
      ? [...lessons.filter((l) => l.topic === goal), ...lessons.filter((l) => l.topic !== goal)]
      : lessons;

    const next = ordered.find((lesson) => !completedIds.has(lesson.id)) ?? ordered[ordered.length - 1]!;
    return {
      lesson: next,
      attempt: inProgressByLesson.get(next.id) ?? null,
      completed: completedIds.has(next.id),
    };
  }

  /**
   * Start (or resume) an attempt.
   *
   * Idempotent on purpose: tapping "start" twice, or retrying after a dropped
   * connection, must not create two attempts and inflate the learner's progress.
   */
  async startAttempt(userId: string, lessonId: string): Promise<LessonAttempt> {
    const lesson = await this.getById(lessonId);
    const existing = await this.repo.lessonAttempts.findInProgress(userId, lesson.id);
    if (existing) {
      this.logger.info('lesson.attempt_resumed', { userId, lessonSlug: lesson.slug });
      return existing;
    }
    const attempt: LessonAttempt = {
      id: crypto.randomUUID(),
      userId,
      lessonId: lesson.id,
      startedAt: this.now().toISOString(),
      completedAt: null,
      score: null,
      status: 'in_progress',
    };
    const created = await this.repo.lessonAttempts.create(attempt);
    this.logger.info('lesson.attempt_started', { userId, lessonSlug: lesson.slug });
    return created;
  }

  /**
   * Complete an attempt and save its vocabulary in one operation.
   *
   * Score is only written when the caller can justify it: the MVP has no validated
   * scoring rubric and no pronunciation assessment, so `score` stays null unless the
   * lesson explicitly supplies a comprehension-based score (correct answers / total).
   */
  async completeAttempt(input: {
    userId: string;
    attemptId: string;
    /** Optional comprehension score: 0..1, derived from authored answer keys only. */
    comprehensionScore?: number;
    saveVocabulary: boolean;
  }): Promise<{ attempt: LessonAttempt; vocabulary_saved: number }> {
    const attempt = await this.repo.lessonAttempts.findById(input.attemptId);
    if (!attempt || attempt.userId !== input.userId) {
      throw new AppError('NOT_FOUND', { messageAr: 'ما لقينا هذه المحاولة.', messageEn: 'attempt not found for this user' });
    }
    const lesson = await this.getById(attempt.lessonId);

    // Completing twice is not an error; the second call returns the stored result.
    if (attempt.status === 'completed') {
      return { attempt, vocabulary_saved: 0 };
    }

    let score: number | null = null;
    if (input.comprehensionScore !== undefined) {
      if (!Number.isFinite(input.comprehensionScore) || input.comprehensionScore < 0 || input.comprehensionScore > 1) {
        throw new AppError('VALIDATION_FAILED', {
          messageEn: 'comprehension_score must be between 0 and 1',
          details: { field: 'comprehension_score' },
        });
      }
      score = input.comprehensionScore;
    }

    const completed = await this.repo.lessonAttempts.complete(attempt.id, this.now().toISOString(), score);
    if (!completed) throw new AppError('INTERNAL', { messageEn: 'attempt disappeared during completion' });

    let saved = 0;
    if (input.saveVocabulary) {
      // Vocabulary lives in authored content; `vocabularyFor` is the single reader.
      for (const item of vocabularyFor(lesson)) {
        await this.repo.vocabulary.upsert({
          userId: input.userId,
          englishTerm: item.englishTerm,
          arabicMeaning: item.arabicMeaning,
          exampleSentence: item.exampleSentence,
          reviewState: 'new',
          // First review is scheduled one day out; the SRS job owns later steps.
          nextReviewAt: new Date(this.now().getTime() + 86_400_000).toISOString(),
        });
        saved += 1;
      }
    }

    this.logger.info('lesson.attempt_completed', {
      userId: input.userId,
      lessonSlug: lesson.slug,
      score,
      vocabularySaved: saved,
    });
    return { attempt: completed, vocabulary_saved: saved };
  }

  /** Resolve an authored speaking prompt by lesson slug + prompt slug. */
  async findPrompt(lessonSlug: string, promptSlug: string): Promise<{ lesson: Lesson; prompt: Lesson['content']['speakingPrompts'][number] }> {
    const lesson = await this.repo.lessons.findBySlug(lessonSlug);
    if (!lesson || !lesson.published) throw new AppError('UNKNOWN_LESSON');
    const prompt = lesson.content.speakingPrompts.find((p) => p.slug === promptSlug);
    if (!prompt) throw new AppError('UNKNOWN_PROMPT');
    return { lesson, prompt };
  }

  /** Resolve a prompt by slug alone, for the direct speaking endpoints. */
  async findPromptBySlug(promptSlug: string): Promise<{ lesson: Lesson; prompt: Lesson['content']['speakingPrompts'][number] }> {
    const lessons = await this.repo.lessons.listPublished();
    for (const lesson of lessons) {
      const prompt = lesson.content.speakingPrompts.find((p) => p.slug === promptSlug);
      if (prompt) return { lesson, prompt };
    }
    throw new AppError('UNKNOWN_PROMPT');
  }
}

/**
 * Vocabulary accessor.
 *
 * A plain function rather than a method on `Lesson`: content is data that arrives
 * from the database as JSON, so it must not depend on prototypes surviving
 * serialisation. This is the single reader used by lesson completion.
 */
export function vocabularyFor(lesson: Lesson): Lesson['content']['vocabulary'] {
  return lesson.content?.vocabulary ?? [];
}
