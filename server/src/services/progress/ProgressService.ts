/**
 * Progress aggregation.
 *
 * Two rules from the spec are enforced here rather than left to the UI:
 *  - `common_mistakes` counts only *authored* correction types, so nothing is
 *    inferred from unclear speech.
 *  - There is no pronunciation score anywhere. Only counts and rates that the
 *    data actually supports are returned (build (1).md §4.6, §15.3).
 *
 * Streak is computed from completed attempt dates in UTC. It is informational and
 * never used to shame the learner, so a broken streak simply reports 0.
 */
import type { Progress, CorrectionType } from '../../domain/models.ts';
import type { Repository } from '../../repositories/Repository.ts';
import { CORRECTION_LABELS_AR } from '../evaluation/evaluate.ts';

export function isoWeekStart(at: Date): Date {
  const day = at.getUTCDay(); // 0 = Sunday
  const diffToMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - diffToMonday);
  return start;
}

/** Consecutive days ending today (or yesterday) with at least one completed lesson. */
export function computeStreak(completedDatesIso: string[], now: Date): number {
  const days = new Set(completedDatesIso.map((iso) => iso.slice(0, 10)));
  if (days.size === 0) return 0;

  let streak = 0;
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // A learner who has not practised *yet today* keeps yesterday's streak.
  if (!days.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export class ProgressService {
  private readonly repo: Repository;
  private readonly now: () => Date;

  constructor(repo: Repository, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.now = now;
  }

  async forUser(userId: string): Promise<Progress> {
    const at = this.now();
    const nowIso = at.toISOString();
    const [attempts, speakingCount, vocabCount, dueCount, correctionCounts, lessons] = await Promise.all([
      this.repo.lessonAttempts.listForUser(userId),
      this.repo.speaking.countForUser(userId),
      this.repo.vocabulary.countForUser(userId),
      this.repo.vocabulary.countDue(userId, nowIso),
      this.repo.speaking.correctionCounts(userId),
      this.repo.lessons.listPublished(),
    ]);

    const durationByLessonId = new Map(lessons.map((lesson) => [lesson.id, lesson.durationMinutes]));
    const completed = attempts.filter((a) => a.status === 'completed');
    const weekStart = isoWeekStart(at).getTime();
    const weeklyMinutes = completed
      .filter((a) => a.completedAt !== null && new Date(a.completedAt).getTime() >= weekStart)
      .reduce((sum, a) => sum + (durationByLessonId.get(a.lessonId) ?? 0), 0);

    const commonMistakes = (Object.entries(correctionCounts) as [CorrectionType, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, count]) => ({ type, count, label_ar: CORRECTION_LABELS_AR[type] ?? type }));

    return {
      lessons_completed: completed.length,
      lessons_started: attempts.length,
      speaking_attempts: speakingCount,
      vocabulary_learned: vocabCount,
      vocabulary_due_for_review: dueCount,
      weekly_minutes: weeklyMinutes,
      current_streak_days: computeStreak(
        completed.filter((a) => a.completedAt !== null).map((a) => a.completedAt as string),
        at,
      ),
      common_mistakes: commonMistakes,
    };
  }
}
