/**
 * Retention and deletion.
 *
 * Implements build (1).md §10.1: every stored category has a duration, and the
 * job that enforces them runs at server startup and every 24 hours while the
 * server process is alive.
 *
 * Deletion is two-phase and that is the important part:
 *   request  -> sessions revoked, profile hidden, consents withdrawn (immediate)
 *   grace    -> RETENTION_PROFILE_GRACE_DAYS (default 30), so an accidental
 *               deletion during beta is recoverable
 *   purge    -> every row for that user is removed, including the auth row
 *
 * Every step logs counts, never content. A purge that fails halfway must be
 * visible, so the job collects errors per user and reports them rather than
 * aborting silently.
 */
import type { Logger } from '../../core/logger.ts';
import type { Repository } from '../../repositories/Repository.ts';

export interface RetentionPolicy {
  transcriptDays: number;
  evaluationDays: number;
  usageEventMonths: number;
  consentMonthsAfterWithdrawal: number;
  profileGraceDays: number;
}

export interface RetentionReport {
  ran_at: string;
  transcripts_cleared: number;
  evaluations_cleared: number;
  usage_events_deleted: number;
  consents_deleted: number;
  tts_cache_entries_deleted: number;
  idempotency_records_deleted: number;
  auth_action_tokens_deleted: number;
  accounts_purged: number;
  errors: string[];
}

export function cutoffIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function monthsAgoIso(months: number, now: Date): string {
  const then = new Date(now.getTime());
  then.setUTCMonth(then.getUTCMonth() - months);
  return then.toISOString();
}

export class RetentionService {
  private readonly repo: Repository;
  private readonly policy: RetentionPolicy;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(repo: Repository, policy: RetentionPolicy, logger: Logger, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.policy = policy;
    this.logger = logger;
    this.now = now;
  }

  /**
   * Runs every retention rule once.
   *
   * Ordering is deliberate: transcript and evaluation clearing happens *before*
   * account purge, so a long purge cannot leave transcripts past their window.
   */
  async run(): Promise<RetentionReport> {
    const at = this.now();
    const report: RetentionReport = {
      ran_at: at.toISOString(),
      transcripts_cleared: 0,
      evaluations_cleared: 0,
      usage_events_deleted: 0,
      consents_deleted: 0,
      tts_cache_entries_deleted: 0,
      idempotency_records_deleted: 0,
      auth_action_tokens_deleted: 0,
      accounts_purged: 0,
      errors: [],
    };

    const steps: { name: string; run: () => Promise<number>; assign: (count: number) => void }[] = [
      {
        name: 'speaking transcripts',
        run: () => this.repo.speaking.clearTranscriptsBefore(cutoffIso(this.policy.transcriptDays, at)),
        assign: (n) => {
          report.transcripts_cleared = n;
        },
      },
      {
        name: 'speaking evaluations',
        run: () => this.repo.speaking.clearEvaluationsBefore(cutoffIso(this.policy.evaluationDays, at)),
        assign: (n) => {
          report.evaluations_cleared = n;
        },
      },
      {
        name: 'usage events',
        run: () => this.repo.usage.deleteBefore(monthsAgoIso(this.policy.usageEventMonths, at)),
        assign: (n) => {
          report.usage_events_deleted = n;
        },
      },
      {
        name: 'withdrawn consents',
        run: () => this.deleteWithdrawnConsents(cutoffIso(this.policy.consentMonthsAfterWithdrawal * 30, at)),
        assign: (n) => {
          report.consents_deleted = n;
        },
      },
      {
        name: 'tts cache',
        run: () => this.repo.ttsCache.deleteBefore(cutoffIso(180, at)),
        assign: (n) => {
          report.tts_cache_entries_deleted = n;
        },
      },
      {
        name: 'idempotency records',
        run: () => this.repo.idempotency.deleteBefore(cutoffIso(7, at)),
        assign: (n) => {
          report.idempotency_records_deleted = n;
        },
      },
      {
        name: 'expired auth action tokens',
        run: () => this.repo.auth.deleteExpiredActionTokens(at.toISOString()),
        assign: (n) => {
          report.auth_action_tokens_deleted = n;
        },
      },
      {
        name: 'account purge',
        run: () => this.purgeExpiredAccounts(at, report.errors),
        assign: (n) => {
          report.accounts_purged = n;
        },
      },
    ];

    for (const step of steps) {
      try {
        step.assign(await step.run());
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        report.errors.push(`${step.name}: ${detail}`);
        this.logger.error('retention.step_failed', { step: step.name, detail });
      }
    }

    this.logger.info('retention.completed', { ...report, errors: report.errors.length });
    return report;
  }

  private async deleteWithdrawnConsents(cutoff: string): Promise<number> {
    const records = await this.repo.consents.listWithdrawnBefore(cutoff);
    for (const record of records) await this.repo.consents.deleteById(record.id);
    return records.length;
  }

  /**
   * Purge accounts whose grace period has expired.
   *
   * One call does the whole job: `profiles.purge` deletes the auth user and every
   * user-owned table removes its rows through `on delete cascade`. Deliberately not
   * a hand-rolled sequence of per-table deletes — an earlier version of this method
   * called the *global* `speaking.clearTranscriptsBefore(now)` inside the per-user
   * loop, which wiped every other learner's transcripts each time a single account
   * was purged. The cascade is per-user by construction, so it cannot do that.
   *
   * A failure is recorded per user and the loop continues, so one bad account
   * cannot strand the rest of the queue.
   */
  private async purgeExpiredAccounts(at: Date, errors: string[]): Promise<number> {
    const userIds = await this.repo.profiles.listPendingPurge(at.toISOString(), this.policy.profileGraceDays);
    let purged = 0;
    for (const userId of userIds) {
      try {
        await this.repo.profiles.purge(userId);
        purged += 1;
        this.logger.info('retention.account_purged', { userId });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        this.logger.error('retention.purge_failed', { userId, detail });
        errors.push(`account purge failed: ${detail}`);
      }
    }
    return purged;
  }
}
