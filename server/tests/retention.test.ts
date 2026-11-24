/**
 * Retention, deletion and per-user data isolation.
 *
 * These tests exist because of a real bug found in review: `purgeExpiredAccounts`
 * called the *global* `speaking.clearTranscriptsBefore(now)` inside its per-user
 * loop, so purging one expired account silently wiped the transcripts of every
 * other learner. Nothing in the suite noticed, because nothing asserted that one
 * user's maintenance could affect another user's rows.
 *
 * The data layer is the in-memory driver, but the code under test (the retention
 * service and the account-deletion route) is the production path. The in-memory
 * driver reproduces the schema's `on delete cascade` by hand, so a purge here has
 * the same reach as a purge in Postgres.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, request, registerUser, wavBytes, base64, type TestApp, type TestUser } from './harness.ts';
import { RetentionService } from '../src/services/retention/RetentionService.ts';
import { NullLogger } from '../src/core/logger.ts';

/**
 * Retention is driven from an explicit clock, but the *app* keeps the real clock:
 * access tokens are signed with the injected clock and verified against the real
 * one, so pinning the app to a past date makes every freshly issued token look
 * expired. Anchoring the retention clock to real time keeps the windows
 * deterministic without touching token validity.
 */
const NOW = new Date();

/**
 * A transcript that actually matches the `coffee_order_01` prompt, so the stored
 * attempt carries a real transcript and evaluation to protect. An empty transcript
 * would make the "must not be cleared" assertions vacuous.
 */
const MATCHING_TRANSCRIPT = 'I would like a coffee please, thank you.';

function retentionFor(app: TestApp, now: Date = NOW): RetentionService {
  return new RetentionService(
    app.repo,
    {
      transcriptDays: 90,
      evaluationDays: 90,
      usageEventMonths: 24,
      consentMonthsAfterWithdrawal: 36,
      profileGraceDays: 30,
    },
    new NullLogger(),
    () => now,
  );
}

/** One speaking attempt through the real route, so a real row exists. */
async function speak(app: TestApp, user: TestUser, promptSlug: string, lessonAttemptId?: string): Promise<void> {
  const response = await request(app, 'POST', '/v1/speaking/transcribe', {
    token: user.token,
    headers: { 'idempotency-key': `speak-${user.userId}-${promptSlug}-${Math.random().toString(36).slice(2)}` },
    body: {
      prompt_slug: promptSlug,
      audio_base64: base64(wavBytes(1)),
      mime_type: 'audio/wav',
      duration_seconds: 1,
      ...(lessonAttemptId ? { lesson_attempt_id: lessonAttemptId } : {}),
    },
  });
  assert.equal(response.status, 200, `speaking route failed: ${JSON.stringify(response.body)}`);
}

describe('retention and account deletion', () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp({ mockProvider: { transcripts: Array<string>(20).fill(MATCHING_TRANSCRIPT) } });
  });

  after(async () => {
    await app.close();
  });

  it('purging one expired account leaves every other learner untouched', async () => {
    const leaving = await registerUser(app);
    const staying = await registerUser(app);

    // The staying learner records a speaking attempt that must survive.
    await speak(app, staying, 'coffee_order_01');
    const before = await app.repo.speaking.listForUser(staying.userId, 10);
    assert.equal(before.length, 1);
    assert.equal(before[0]!.transcript !== null, true, 'the seeded attempt should have a transcript to protect');

    // The leaving learner requests deletion, and the grace period then expires.
    const deletion = await request(app, 'DELETE', '/v1/account', { token: leaving.token });
    assert.equal(deletion.status, 200);

    const report = await retentionFor(
      app,
      new Date(NOW.getTime() + 31 * 86_400_000),
    ).run();

    assert.equal(report.accounts_purged, 1, `expected exactly one purge, got ${JSON.stringify(report)}`);

    // The bug: the surviving learner's transcript was cleared by the purge.
    const after = await app.repo.speaking.listForUser(staying.userId, 10);
    assert.equal(after.length, 1, "another learner's attempt row must not be removed");
    assert.notEqual(after[0]!.transcript, null, "another learner's transcript must not be cleared");

    // And the purged learner's rows are genuinely gone.
    const purged = await app.repo.speaking.listForUser(leaving.userId, 10);
    assert.equal(purged.length, 0, 'the purged account must not keep speaking rows');
    assert.equal(await app.repo.profiles.findById(leaving.userId), null);
  });

  it('a purge removes every owned row but keeps the anonymised usage ledger', async () => {
    const user = await registerUser(app);
    await speak(app, user, 'coffee_order_01');

    const day = NOW.toISOString().slice(0, 10);
    const usageBefore = await app.repo.usage.listForUser(user.userId, 50);
    assert.equal(usageBefore.length > 0, true, 'the speaking route should have written a usage event');
    const creditsBefore = await app.repo.usage.creditsForDay(day);
    assert.equal(creditsBefore > 0, true, 'the speaking route should have booked a cost against the ledger');

    await request(app, 'DELETE', '/v1/account', { token: user.token });
    await retentionFor(app, new Date(NOW.getTime() + 31 * 86_400_000)).run();

    // Cascade targets: gone.
    assert.equal(await app.repo.profiles.findById(user.userId), null, 'profile');
    assert.equal((await app.repo.speaking.listForUser(user.userId, 50)).length, 0, 'speaking attempts');
    assert.equal((await app.repo.vocabulary.listForUser(user.userId)).length, 0, 'vocabulary');
    assert.equal((await app.repo.lessonAttempts.listForUser(user.userId)).length, 0, 'lesson attempts');
    assert.equal((await app.repo.consents.listForUser(user.userId)).length, 0, 'consents');
    assert.equal(await app.repo.auth.findById(user.userId), null, 'auth credential');

    // ON DELETE SET NULL: the spend record survives, detached from the person.
    const usageAfter = await app.repo.usage.listForUser(user.userId, 50);
    assert.equal(usageAfter.length, 0, 'no usage row should still point at the deleted user');
    assert.equal(
      await app.repo.usage.creditsForDay(day),
      creditsBefore,
      'the operator cost history must survive the purge, just detached from the user',
    );
  });

  it('the transcript window does clear old transcripts, and only old ones', async () => {
    const user = await registerUser(app);
    await speak(app, user, 'coffee_order_01');

    const fresh = await retentionFor(app).run();
    const keptRows = await app.repo.speaking.listForUser(user.userId, 10);
    assert.equal(keptRows[0]!.transcript !== null, true, 'a transcript inside the window must be kept');

    // Well past the 90-day window.
    const late = await retentionFor(app, new Date(NOW.getTime() + 200 * 86_400_000)).run();
    const clearedRows = await app.repo.speaking.listForUser(user.userId, 10);
    assert.equal(clearedRows.length, 1, 'the attempt row itself is retained, only the transcript goes');
    assert.equal(clearedRows[0]!.transcript, null, 'a transcript past 90 days must be cleared');
    assert.equal(clearedRows[0]!.evaluation, null, 'the evaluation is cleared on the same schedule');
    assert.equal(fresh.transcripts_cleared + late.transcripts_cleared >= 1, true);
  });

  it('a deleted account can no longer authenticate, before any purge runs', async () => {
    const user = await registerUser(app);
    const deletion = await request(app, 'DELETE', '/v1/account', { token: user.token });
    assert.equal(deletion.status, 200);
    assert.equal(deletion.body.profile_purged, false, 'the request phase must not hard-delete');

    const afterDeletion = await request(app, 'GET', '/v1/profile', { token: user.token });
    assert.equal(afterDeletion.status, 401, `expected the session to be dead, got ${afterDeletion.status}`);

    // The refresh token must be revoked too, not just the access token.
    const refreshed = await request(app, 'POST', '/v1/auth/refresh', { body: { refresh_token: user.refreshToken } });
    assert.equal(refreshed.status, 401, `expected refresh to fail, got ${refreshed.status}`);
  });

  it('retention reports a failed step instead of hiding it', async () => {
    // A repository whose tts cache sweep always fails: the report must surface it
    // and the other steps must still run.
    const failing = {
      ...app.repo,
      ttsCache: {
        ...app.repo.ttsCache,
        deleteBefore: async (): Promise<number> => {
          throw new Error('synthetic tts failure');
        },
      },
    } as typeof app.repo;

    const service = new RetentionService(
      failing,
      { transcriptDays: 90, evaluationDays: 90, usageEventMonths: 24, consentMonthsAfterWithdrawal: 36, profileGraceDays: 30 },
      new NullLogger(),
      () => NOW,
    );

    const report = await service.run();
    assert.equal(report.errors.length, 1, `expected one recorded error, got ${JSON.stringify(report.errors)}`);
    assert.match(report.errors[0]!, /tts cache: synthetic tts failure/);
    // The failure did not abort the run.
    assert.equal(typeof report.accounts_purged, 'number');
  });

  it('retention reports individual account-purge failures', async () => {
    const user = await registerUser(app);
    await request(app, 'DELETE', '/v1/account', { token: user.token });

    const profiles = app.repo.profiles;
    const originalPurge = profiles.purge.bind(profiles);
    profiles.purge = async (userId) => {
      if (userId === user.userId) {
        throw new Error('synthetic account purge failure');
      }
      await originalPurge(userId);
    };
    try {
      const afterGracePeriod = new Date(NOW.getTime() + 31 * 86_400_000);
      const report = await retentionFor(app, afterGracePeriod).run();
      assert.equal(report.errors.length, 1);
      assert.match(report.errors[0]!, /account purge failed: synthetic account purge failure/);
      const pending = await app.repo.profiles.listPendingPurge(afterGracePeriod.toISOString(), 30);
      assert.ok(pending.includes(user.userId), 'failed account remains queued for a later retry');
    } finally {
      profiles.purge = originalPurge;
    }
  });
});
