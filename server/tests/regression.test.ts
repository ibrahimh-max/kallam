/**
 * Regression tests for defects found during the post-implementation audit.
 *
 * Each test here failed against the code as it was before the corresponding fix,
 * and asserts the concrete behaviour the fix is supposed to guarantee â€” not merely
 * that the route answers. The comments name the defect so a future regression is
 * traceable to its cause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64, registerUser, request, startTestApp, wavBytes } from './harness.ts';

test('the unauthenticated /health route does not leak database internals', async () => {
  const app = await startTestApp();
  try {
    const response = await request(app, 'GET', '/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    // The boolean is the contract; the driver's diagnostic text is not. It used to
    // be returned as `repository_detail`, and for an unreachable database that
    // string contains the project host and can echo table/column names.
    assert.equal(response.body.repository_ok, true);
    assert.equal(response.body.repository_detail, undefined, 'health must not expose repository detail');

    // Nothing in the body may contain a connection string or a credential.
    const serialised = JSON.stringify(response.body);
    for (const forbidden of ['postgres://', 'postgresql://', 'supabase.co', 'sk-', 'password']) {
      assert.ok(!serialised.includes(forbidden), `health leaked ${forbidden}`);
    }
  } finally {
    await app.close();
  }
});

test('a forged x-forwarded-for header cannot mint a fresh rate-limit bucket', async () => {
  // Two requests per IP per minute. The old `clientIp()` returned the left-most
  // attacker-supplied x-forwarded-for value, so a caller could stay under the limit
  // forever by varying the header â€” removing the only brute-force defence from the
  // unauthenticated login route.
  const app = await startTestApp({ requestsPerMinutePerIp: 2, requestsPerMinutePerUser: 1000 });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await request(app, 'POST', '/v1/auth/login', {
        body: { email: 'attacker@example.com', password: 'guessing' },
        // A different claimed origin on every attempt.
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      statuses.push(response.status);
    }

    assert.deepEqual(statuses.slice(0, 2), [401, 401], 'the first two attempts get a real answer');
    assert.equal(statuses[2], 429, 'spoofing the header must not reset the bucket');
    assert.equal(statuses[3], 429, 'and the caller stays limited');
  } finally {
    await app.close();
  }
});

test('an unsupported content-encoding is a 4xx, not a 500', async () => {
  // body-parser throws { type: 'encoding.unsupported', status: 415 }. The error
  // handler only special-cased oversize bodies and malformed JSON, so this fell
  // through to INTERNAL: the client was told the server broke when in fact the
  // request was unacceptable, and every occurrence logged a false "unhandled error".
  const app = await startTestApp();
  try {
    const response = await request(app, 'POST', '/v1/auth/login', {
      body: { email: 'a@b.com', password: 'x' },
      headers: { 'content-encoding': 'gzip' },
    });

    // The contract asserted here is "client fault, not server fault": any 4xx is
    // acceptable, 5xx is the defect. The message must name the layer so a caller
    // knows the body was rejected before validation ran.
    assert.ok(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`);
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    assert.match(response.body.error.message_en, /HTTP layer/);
    assert.equal(response.body.error.stack, undefined, 'no stack trace in a client-facing error');
  } finally {
    await app.close();
  }
});

test('a learner cannot attach another learner\'s lesson attempt to a speaking request', async () => {
  // `lesson_attempt_id` is a plain foreign key and the service-role client bypasses
  // RLS, so this ownership check has to live in the route. Without it, learner A
  // could create a speaking attempt referencing learner B's row.
  const app = await startTestApp();
  try {
    const learnerA = await registerUser(app);
    const learnerB = await registerUser(app);

    const lessons = await request(app, 'GET', '/v1/lessons', { token: learnerB.token });
    const lessonId = lessons.body.lessons[0].id as string;

    const started = await request(app, 'POST', `/v1/lessons/${lessonId}/attempts`, {
      token: learnerB.token,
      body: {},
    });
    assert.equal(started.status, 201);
    const attemptOwnedByB = started.body.attempt.id as string;

    const response = await request(app, 'POST', '/v1/speaking/transcribe', {
      token: learnerA.token,
      headers: { 'idempotency-key': 'regression-ownership-check-0001' },
      body: {
        prompt_slug: 'introduce_yourself_01',
        mime_type: 'audio/wav',
        duration_seconds: 1,
        audio_base64: base64(wavBytes(1)),
        lesson_attempt_id: attemptOwnedByB,
      },
    });

    // 404 rather than 403: the response must not confirm that another account's
    // attempt id exists.
    assert.equal(response.status, 404, 'a foreign attempt id must be rejected');
    assert.equal(response.body.error.code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('a learner may still use their own lesson attempt', async () => {
  // The guard above must not break the legitimate path: the same flow with an
  // attempt the caller owns has to succeed.
  const app = await startTestApp();
  try {
    const learner = await registerUser(app);

    const lessons = await request(app, 'GET', '/v1/lessons', { token: learner.token });
    const lessonId = lessons.body.lessons[0].id as string;

    const started = await request(app, 'POST', `/v1/lessons/${lessonId}/attempts`, {
      token: learner.token,
      body: {},
    });
    assert.equal(started.status, 201);
    const ownAttempt = started.body.attempt.id as string;

    const response = await request(app, 'POST', '/v1/speaking/transcribe', {
      token: learner.token,
      headers: { 'idempotency-key': 'regression-ownership-check-0002' },
      body: {
        prompt_slug: 'introduce_yourself_01',
        mime_type: 'audio/wav',
        duration_seconds: 1,
        audio_base64: base64(wavBytes(1)),
        lesson_attempt_id: ownAttempt,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(typeof response.body.attempt_id, 'string');
    // Still no invented confidence value, whatever the transcript was.
    assert.equal(response.body.confidence, null);
  } finally {
    await app.close();
  }
});

test('an idempotency-store failure blocks a paid transcription request', async () => {
  const app = await startTestApp();
  try {
    const learner = await registerUser(app);
    app.repo.idempotency.get = async () => {
      throw new Error('simulated idempotency-store failure');
    };

    const response = await request(app, 'POST', '/v1/speaking/transcribe', {
      token: learner.token,
      headers: { 'idempotency-key': 'regression-idempotency-failure-0001' },
      body: {
        prompt_slug: 'introduce_yourself_01',
        mime_type: 'audio/wav',
        duration_seconds: 1,
        audio_base64: base64(wavBytes(1)),
      },
    });

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL');
    assert.equal(app.provider.calls.transcribe.length, 0);
    assert.equal(await app.repo.usage.creditsForDay(new Date().toISOString().slice(0, 10)), 0);
  } finally {
    await app.close();
  }
});
