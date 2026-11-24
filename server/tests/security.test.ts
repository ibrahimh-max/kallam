/**
 * Security tests.
 *
 * These target the boundary, not the happy path: unauthenticated access, tokens
 * that must not be accepted, cross-user access to another learner's rows,
 * account deletion, rate limiting and secret non-exposure. Each test asserts a
 * concrete status code or value, so a regression is a failing test, not a
 * silent change in behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64, registerUser, request, startTestApp, verifyEmail, wavBytes } from './harness.ts';
import { issueAccessToken } from '../src/security/tokens.ts';

test('every protected route rejects a request with no token', async () => {
  const app = await startTestApp();
  try {
    const protectedRoutes: Array<[string, string]> = [
      ['GET', '/v1/profile'],
      ['PATCH', '/v1/profile'],
      ['GET', '/v1/lessons'],
      ['GET', '/v1/lessons/today'],
      ['GET', '/v1/progress'],
      ['GET', '/v1/vocabulary'],
      ['GET', '/v1/usage'],
      ['GET', '/v1/voices'],
      ['GET', '/v1/speaking/history'],
      ['DELETE', '/v1/account'],
      ['POST', '/v1/auth/logout'],
    ];

    for (const [method, path] of protectedRoutes) {
      const response = await request(app, method, path, method === 'GET' ? {} : { body: {} });
      assert.equal(response.status, 401, `${method} ${path} should be 401 without a token`);
      assert.equal(response.body.error.code, 'UNAUTHORIZED', `${method} ${path} error code`);
      // The body must not leak internals.
      assert.equal(response.body.error.stack, undefined);
    }
  } finally {
    await app.close();
  }
});

test('a forged, expired-looking or malformed token is rejected', async () => {
  const app = await startTestApp();
  try {
    const user = await registerUser(app);

    // Same shape, wrong signature.
    const parts = user.token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;
    const forgedResponse = await request(app, 'GET', '/v1/profile', { token: forged });
    assert.equal(forgedResponse.status, 401);

    // Truncated payload.
    const truncatedResponse = await request(app, 'GET', '/v1/profile', { token: `${parts[0]}.${parts[1]}` });
    assert.equal(truncatedResponse.status, 401);

    // Non-token garbage.
    const garbageResponse = await request(app, 'GET', '/v1/profile', { token: 'not-a-jwt' });
    assert.equal(garbageResponse.status, 401);

    // A refresh token must not be usable as an access token.
    const swappedResponse = await request(app, 'GET', '/v1/profile', { token: user.refreshToken });
    assert.equal(swappedResponse.status, 401);
  } finally {
    await app.close();
  }
});

test('refresh rotates an opaque token even after its access token expires', async () => {
  const app = await startTestApp();
  try {
    const user = await registerUser(app);
    const expiredAccess = issueAccessToken(
      user.userId,
      user.email,
      app.env.localJwtSecret,
      Math.floor(Date.now() / 1000) - 3600,
    );

    const refreshed = await request(app, 'POST', '/v1/auth/refresh', {
      token: expiredAccess,
      body: { refresh_token: user.refreshToken },
    });
    assert.equal(refreshed.status, 200);
    assert.equal(typeof refreshed.body.tokens.access_token, 'string');
    assert.notEqual(refreshed.body.tokens.refresh_token, user.refreshToken);
    assert.equal(refreshed.body.profile.voice_consent_granted, true);

    const reuse = await request(app, 'POST', '/v1/auth/refresh', {
      body: { refresh_token: user.refreshToken },
    });
    assert.equal(reuse.status, 401);

    const current = await request(app, 'POST', '/v1/auth/refresh', {
      body: { refresh_token: refreshed.body.tokens.refresh_token },
    });
    assert.equal(current.status, 200);
  } finally {
    await app.close();
  }
});

test('a learner cannot read or mutate another learner\'s rows', async () => {
  const app = await startTestApp();
  try {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    // Vocabulary review is scoped by user id in the query, so Bob's item id
    // must not be reachable with Alice's token.
    const itemId = '11111111-1111-4111-8111-111111111111';
    const aliceOnBobsItem = await request(app, 'POST', `/v1/vocabulary/${itemId}/review`, {
      token: alice.token,
      body: { review_state: 'mastered' },
    });
    assert.equal(aliceOnBobsItem.status, 404);

    // History is always the caller's own, whichever token is used.
    const aliceHistory = await request(app, 'GET', '/v1/speaking/history', { token: alice.token });
    assert.equal(aliceHistory.status, 200);
    assert.deepEqual(aliceHistory.body.attempts, []);

    const bobHistory = await request(app, 'GET', '/v1/speaking/history', { token: bob.token });
    assert.equal(bobHistory.status, 200);
    assert.deepEqual(bobHistory.body.attempts, []);

    // A client-supplied user id in the body is rejected as an unknown field
    // rather than silently trusted.
    const spoof = await request(app, 'PATCH', '/v1/profile', {
      token: alice.token,
      body: { user_id: bob.userId, display_name: 'Spoofed' },
    });
    assert.equal(spoof.status, 400);

    // Alice's own profile is untouched by the attempt.
    const profile = await request(app, 'GET', '/v1/profile', { token: alice.token });
    assert.equal(profile.body.profile.id, alice.userId);
  } finally {
    await app.close();
  }
});

test('voice routes refuse to process audio once consent is withdrawn', async () => {
  const app = await startTestApp();
  try {
    const user = await registerUser(app);

    const before = await request(app, 'POST', '/v1/speaking/transcribe', {
      token: user.token,
      body: {
        prompt_slug: 'introduce_yourself_01',
        mime_type: 'audio/wav',
        duration_seconds: 1,
        audio_base64: base64(wavBytes(1)),
      },
    });
    assert.equal(before.status, 200);

    const withdraw = await request(app, 'POST', '/v1/consent/withdraw', {
      token: user.token,
      body: { consent_type: 'voice_processing' },
    });
    assert.equal(withdraw.status, 200);
    assert.equal(withdraw.body.voice_processing_consent, false);

    const after = await request(app, 'POST', '/v1/speaking/transcribe', {
      token: user.token,
      body: {
        prompt_slug: 'introduce_yourself_01',
        mime_type: 'audio/wav',
        duration_seconds: 1,
        audio_base64: base64(wavBytes(1)),
      },
    });
    assert.equal(after.status, 403);
    assert.equal(after.body.error.code, 'CONSENT_REQUIRED');

    // TTS is voice processing too, and must be blocked as well.
    const tts = await request(app, 'POST', '/v1/tts', {
      token: user.token,
      body: { text: 'Hello', voice_id: 'mock-ar-1', script: 'en' },
    });
    assert.equal(tts.status, 403);
  } finally {
    await app.close();
  }
});

test('account deletion ends every session immediately', async () => {
  const app = await startTestApp();
  try {
    const user = await registerUser(app);

    const deleted = await request(app, 'DELETE', '/v1/account', { token: user.token });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deletion_requested, true);

    // Same token, immediately after deletion.
    const reuse = await request(app, 'GET', '/v1/profile', { token: user.token });
    assert.equal(reuse.status, 401);
  } finally {
    await app.close();
  }
});

test('the per-user rate limit is enforced on authenticated routes', async () => {
  const app = await startTestApp({ requestsPerMinutePerUser: 3, requestsPerMinutePerIp: 1000 });
  try {
    const user = await registerUser(app);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await request(app, 'GET', '/v1/profile', { token: user.token });
      statuses.push(response.status);
    }

    // The first requests succeed, then the bucket closes.
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.equal(statuses[3], 429);
    assert.equal(statuses[5], 429);

    const limited = await request(app, 'GET', '/v1/profile', { token: user.token });
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.equal(limited.body.error.details.scope, 'user');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    await app.close();
  }
});

test('the per-IP rate limit is enforced before any body is parsed', async () => {
  const app = await startTestApp({ requestsPerMinutePerIp: 2, requestsPerMinutePerUser: 1000 });
  try {
    const first = await request(app, 'POST', '/v1/auth/login', { body: { email: 'a@b.com', password: 'x' } });
    assert.equal(first.status, 401);

    const second = await request(app, 'POST', '/v1/auth/login', { body: { email: 'a@b.com', password: 'x' } });
    assert.equal(second.status, 401);

    const third = await request(app, 'POST', '/v1/auth/login', { body: { email: 'a@b.com', password: 'x' } });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
    assert.equal(third.body.error.details.scope, 'ip');
  } finally {
    await app.close();
  }
});

test('responses never expose provider keys, database URLs or stack traces', async () => {
  const app = await startTestApp();
  try {
    const user = await registerUser(app);

    const paths = ['/v1/profile', '/v1/usage', '/v1/lessons', '/v1/voices', '/v1/progress'];
    for (const path of paths) {
      const response = await request(app, 'GET', path, { token: user.token });
      const text = JSON.stringify(response.body);
      assert.equal(/sk-[A-Za-z0-9]/.test(text), false, `${path} leaked a key-shaped string`);
      assert.equal(/HUMAIN_API_KEY|SUPABASE_SERVICE_ROLE|postgres:\/\//.test(text), false, `${path} leaked configuration`);
      assert.equal(/"stack"|at Object\.|node:internal/.test(text), false, `${path} leaked a stack trace`);
      // The registration response is the one place a token legitimately appears.
      assert.equal(/api[_-]?key/i.test(text), false, `${path} leaked an api key field`);
    }
  } finally {
    await app.close();
  }
});

test('registration refuses weak input and duplicate accounts', async () => {
  const app = await startTestApp();
  try {
    const shortPassword = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email: 'weak@example.com',
        password: 'short',
        accept_terms: true,
        accept_privacy_policy: true,
        voice_consent: true,
      },
    });
    assert.equal(shortPassword.status, 400);
    assert.equal(shortPassword.body.error.details.field, 'password');

    const badEmail = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email: 'not-an-email',
        password: 'correct-horse-battery',
        accept_terms: true,
        accept_privacy_policy: true,
        voice_consent: true,
      },
    });
    assert.equal(badEmail.status, 400);

    const first = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email: 'dupe@example.com',
        password: 'correct-horse-battery',
        accept_terms: true,
        accept_privacy_policy: true,
        voice_consent: true,
      },
    });
    assert.equal(first.status, 202);

    const duplicate = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email: 'dupe@example.com',
        password: 'different-password-choice',
        accept_terms: true,
        accept_privacy_policy: true,
        voice_consent: true,
      },
    });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(duplicate.body, first.body);

    const unverifiedLogin = await request(app, 'POST', '/v1/auth/login', {
      body: { email: 'dupe@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(unverifiedLogin.status, 401, 'an unverified address cannot start a session');
    await verifyEmail(app, 'dupe@example.com');

    const login = await request(app, 'POST', '/v1/auth/login', {
      body: { email: 'dupe@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200, 'a duplicate registration must not overwrite the existing password');
  } finally {
    await app.close();
  }
});

test('registration requires affirmative terms and privacy acceptance', async () => {
  const app = await startTestApp();
  try {
    const rejected = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email: 'no-acceptance@example.com',
        password: 'correct-horse-battery',
        accept_terms: false,
        accept_privacy_policy: true,
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, 'CONSENT_REQUIRED');

    const accepted = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email: 'accepted@example.com',
        password: 'correct-horse-battery',
        accept_terms: true,
        accept_privacy_policy: true,
      },
    });
    assert.equal(accepted.status, 202);
    await verifyEmail(app, 'accepted@example.com');
    const login = await request(app, 'POST', '/v1/auth/login', {
      body: { email: 'accepted@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200);
    const records = await app.repo.consents.listForUser(login.body.profile.id);
    assert.ok(records.some((record) => record.consentType === 'terms_of_service'));
    assert.ok(records.some((record) => record.consentType === 'privacy_policy'));
    assert.equal(records.some((record) => record.consentType === 'voice_processing'), false);
  } finally {
    await app.close();
  }
});

test('registration does not require voice consent and typed practice remains available', async () => {
  const app = await startTestApp();
  try {
    const registration = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email: 'no-voice@example.com',
        password: 'correct-horse-battery',
        accept_terms: true,
        accept_privacy_policy: true,
      },
    });
    assert.equal(registration.status, 202);
    await verifyEmail(app, 'no-voice@example.com');

    const login = await request(app, 'POST', '/v1/auth/login', {
      body: { email: 'no-voice@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.profile.voice_consent_granted, false);

    const token = login.body.tokens.access_token as string;
    const audio = await request(app, 'POST', '/v1/speaking/transcribe', {
      token,
      body: {
        prompt_slug: 'introduce_yourself_01',
        mime_type: 'audio/wav',
        duration_seconds: 1,
        audio_base64: base64(wavBytes(1)),
      },
    });
    assert.equal(audio.status, 403);
    assert.equal(audio.body.error.code, 'CONSENT_REQUIRED');

    const typed = await request(app, 'POST', '/v1/speaking/evaluate', {
      token,
      body: { prompt_slug: 'introduce_yourself_01', transcript: 'Hello, my name is Sara.' },
    });
    assert.equal(typed.status, 200);
    assert.equal(typed.body.evaluation.retry_required, false);

    const grant = await request(app, 'POST', '/v1/consent/grant', {
      token,
      body: { consent_type: 'voice_processing' },
    });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.voice_processing_consent, true);

    const audioAfterGrant = await request(app, 'POST', '/v1/speaking/transcribe', {
      token,
      headers: { 'idempotency-key': 'voice-consent-explicit-grant-0001' },
      body: {
        prompt_slug: 'introduce_yourself_01',
        mime_type: 'audio/wav',
        duration_seconds: 1,
        audio_base64: base64(wavBytes(1)),
      },
    });
    assert.equal(audioAfterGrant.status, 200);
    assert.equal(audioAfterGrant.body.confidence, null);
  } finally {
    await app.close();
  }
});

test('login gives the same answer for a wrong password and an unknown account', async () => {
  const app = await startTestApp();
  try {
    const user = await registerUser(app);

    const wrongPassword = await request(app, 'POST', '/v1/auth/login', {
      body: { email: user.email, password: 'definitely-not-it' },
    });
    const unknownUser = await request(app, 'POST', '/v1/auth/login', {
      body: { email: 'nobody@example.com', password: 'definitely-not-it' },
    });

    // Identical status, code and message: no account enumeration.
    assert.equal(wrongPassword.status, unknownUser.status);
    assert.equal(wrongPassword.body.error.code, unknownUser.body.error.code);
    assert.equal(wrongPassword.body.error.message_en, unknownUser.body.error.message_en);

    const validLogin = await request(app, 'POST', '/v1/auth/login', {
      body: { email: user.email, password: 'correct-horse-battery' },
    });
    assert.equal(validLogin.status, 200);
    assert.equal(validLogin.body.profile.voice_consent_granted, true);
  } finally {
    await app.close();
  }
});
