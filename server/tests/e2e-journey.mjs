/**
 * Live end-to-end check of the MVP learner journey against a RUNNING server.
 *
 * This is not a unit test: it drives the real HTTP surface in the order a learner
 * uses it, and asserts the outcome a person would see. Run it with the server up:
 *
 *   cd server && npm start                # VOICE_PROVIDER=mock to spend nothing
 *   node tests/e2e-journey.mjs            # from server/
 *
 * It spends zero credits: every voice call is served by the mock provider.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, actual, expected });
    console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

function checkTruthy(name, actual) {
  const ok = Boolean(actual);
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, actual, expected: 'a truthy value' });
    console.log(`  FAIL  ${name} -> ${JSON.stringify(actual)}`);
  }
}

async function call(method, path, { token, body, idempotencyKey } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function verifyTestEmail(email) {
  const inbox = await call('GET', `/__test/emails?to=${encodeURIComponent(email)}`);
  const message = inbox.body?.emails?.filter((item) => item.purpose === 'verify_email').at(-1);
  if (!message) throw new Error(`no test verification email for ${email}`);
  const actionToken = new URL(message.actionUrl).hash.slice(1);
  const token = new URLSearchParams(actionToken).get('token');
  return call('POST', '/v1/auth/verify-email', { body: { token } });
}

/** A silent mono WAV, the same container the app uploads. */
function wavBytes(seconds = 1, sampleRate = 16000) {
  const samples = Math.round(seconds * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  }
  return buffer;
}

const run = async () => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'correct-horse-battery-staple';

  console.log('\n1. Anonymous access is refused');
  const anon = await call('GET', '/v1/profile');
  check('GET /v1/profile without a token', anon.status, 401);

  console.log('\n2. Register with explicit legal acceptance; voice consent remains optional');
  const reg = await call('POST', '/v1/auth/register', {
    body: {
      email,
      password,
      display_name: 'نورة',
      accept_terms: true,
      accept_privacy_policy: true,
      voice_consent: false,
    },
  });
  check('registration status is non-enumerating', reg.status, 202);
  check('registration response contains no session', reg.body?.tokens, undefined);
  check('registration response contains no profile', reg.body?.profile, undefined);
  const beforeVerification = await call('POST', '/v1/auth/login', { body: { email, password } });
  check('unverified learner cannot sign in', beforeVerification.status, 401);
  const verified = await verifyTestEmail(email);
  check('email verification succeeds', verified.status, 200);

  // No key may leak into any response body.
  const serialised = JSON.stringify(reg.body);
  check('no key-shaped string in register response', /sk-[A-Za-z0-9]/.test(serialised), false);

  const signedIn = await call('POST', '/v1/auth/login', { body: { email, password } });
  check('new learner can sign in after registration', signedIn.status, 200);
  checkTruthy('access token issued at login', signedIn.body?.tokens?.access_token);
  checkTruthy('refresh token issued at login', signedIn.body?.tokens?.refresh_token);
  check('onboarding not yet complete', signedIn.body?.profile?.onboarding_completed, false);
  check('voice consent is not assumed at registration', signedIn.body?.profile?.voice_consent_granted, false);
  let token = signedIn.body.tokens.access_token;
  const refreshToken = signedIn.body.tokens.refresh_token;

  console.log('\n3. Onboarding -> profile patch stamps completion server-side');
  const onb = await call('PATCH', '/v1/profile', {
    token,
    body: {
      english_level: 'complete_beginner',
      learning_goal: 'everyday',
      daily_goal_minutes: 10,
      complete_onboarding: true,
    },
  });
  check('profile patch status', onb.status, 200);
  check('onboarding_completed now true', onb.body?.profile?.onboarding_completed, true);
  check('level persisted', onb.body?.profile?.english_level, 'complete_beginner');

  console.log('\n4. Voice processing requires a deliberate opt-in');
  const grantConsent = await call('POST', '/v1/consent/grant', {
    token,
    body: { consent_type: 'voice_processing' },
  });
  check('voice consent grant status', grantConsent.status, 200);
  check('voice consent is now active', grantConsent.body?.voice_processing_consent, true);

  console.log('\n5. Invalid input is rejected with the field named');
  const badGoal = await call('PATCH', '/v1/profile', { token, body: { daily_goal_minutes: 7 } });
  check('bad daily goal status', badGoal.status, 400);
  check('bad daily goal names the field', badGoal.body?.error?.details?.field, 'daily_goal_minutes');

  console.log('\n6. Lessons');
  const lessons = await call('GET', '/v1/lessons', { token });
  check('lessons status', lessons.status, 200);
  checkTruthy('seed lessons present', Array.isArray(lessons.body?.lessons) && lessons.body.lessons.length >= 5);

  const today = await call('GET', '/v1/lessons/today', { token });
  check('today lesson status', today.status, 200);
  checkTruthy('today returns a lesson', today.body?.lesson?.slug);

  const lessonId = lessons.body.lessons[0].id;
  const detail = await call('GET', `/v1/lessons/${lessonId}`, { token });
  check('lesson detail status', detail.status, 200);
  checkTruthy('lesson has Arabic title', detail.body?.lesson?.titleAr);
  checkTruthy('lesson has speaking prompts', detail.body?.lesson?.content?.speakingPrompts?.length > 0);

  console.log('\n7. Lesson attempt -> complete -> vocabulary saved');
  const attempt = await call('POST', `/v1/lessons/${lessonId}/attempts`, { token });
  check('attempt start status', attempt.status, 201);
  const attemptId = attempt.body.attempt.id;

  const done = await call('POST', `/v1/attempts/${attemptId}/complete`, {
    token,
    body: { comprehension_score: 1, save_vocabulary: true },
  });
  check('attempt complete status', done.status, 200);
  checkTruthy('vocabulary saved from lesson', done.body?.vocabulary_saved >= 1);

  const vocab = await call('GET', '/v1/vocabulary', { token });
  checkTruthy('vocabulary list populated', vocab.body?.items?.length >= 1);
  const itemId = vocab.body.items[0].id;
  const review = await call('POST', `/v1/vocabulary/${itemId}/review`, {
    token,
    body: { review_state: 'mastered' },
  });
  check('vocabulary review status', review.status, 200);
  // The wire contract: request/control fields are snake_case, but a returned
  // domain entity keeps the shape declared in server/src/domain/models.ts
  // (`VocabularyItem.reviewState`). Assert the real key, and report the keys we
  // actually received if it ever changes.
  const reviewItemKeys = Object.keys(review.body?.item ?? {});
  check('review state persisted', review.body?.item?.reviewState, 'mastered');
  if (review.body?.item?.reviewState !== 'mastered') console.log(`        observed item keys: ${JSON.stringify(reviewItemKeys)}`);
  const reread = await call('GET', '/v1/vocabulary', { token });
  check(
    'the review state survives a re-read',
    reread.body.items.find((i) => i.id === itemId)?.reviewState,
    'mastered',
  );

  console.log('\n8. Voices (real catalogue, no provider spend)');
  const voices = await call('GET', '/v1/voices', { token });
  check('voices status', voices.status, 200);
  checkTruthy('a default Arabic voice is chosen', voices.body?.default_arabic_voice_id);

  console.log('\n9. Speaking: audio -> transcript -> bounded Arabic feedback');
  const promptSlug = detail.body.lesson.content.speakingPrompts[0].slug;
  const transcribe = await call('POST', '/v1/speaking/transcribe', {
    token,
    idempotencyKey: `e2e-${attemptId}`,
    body: {
      prompt_slug: promptSlug,
      mime_type: 'audio/wav',
      duration_seconds: 1,
      audio_base64: wavBytes(1).toString('base64'),
      lesson_attempt_id: attemptId,
    },
  });
  check('transcribe status', transcribe.status, 200);
  checkTruthy('a transcript came back', typeof transcribe.body?.transcript === 'string');
  checkTruthy('an evaluation came back', transcribe.body?.evaluation);
  check('evaluation has Arabic encouragement', typeof transcribe.body.evaluation.encouragement_ar, 'string');
  check(
    'match method is one of the documented values',
    ['exact', 'normalised', 'keywords', 'none'].includes(transcribe.body.evaluation.match_method),
    true,
  );

  console.log('\n10. Idempotency: the same key does not bill twice');
  const replay = await call('POST', '/v1/speaking/transcribe', {
    token,
    idempotencyKey: `e2e-${attemptId}`,
    body: {
      prompt_slug: promptSlug,
      mime_type: 'audio/wav',
      duration_seconds: 1,
      audio_base64: wavBytes(1).toString('base64'),
      lesson_attempt_id: attemptId,
    },
  });
  check('replay returns the stored response', replay.status, 200);
  check('replay is the identical attempt', replay.body?.attempt?.id ?? replay.body?.attempt_id, transcribe.body.attempt?.id ?? transcribe.body.attempt_id);

  const conflict = await call('POST', '/v1/speaking/transcribe', {
    token,
    idempotencyKey: `e2e-${attemptId}`,
    body: {
      prompt_slug: promptSlug,
      mime_type: 'audio/wav',
      duration_seconds: 2,
      audio_base64: wavBytes(2).toString('base64'),
      lesson_attempt_id: attemptId,
    },
  });
  check('same key with a different payload is a conflict', conflict.status, 409);

  console.log('\n11. Typed practice costs nothing and uses the same rules');
  const typed = await call('POST', '/v1/speaking/evaluate', {
    token,
    body: { prompt_slug: promptSlug, transcript: 'hello' },
  });
  check('typed evaluate status', typed.status, 200);
  checkTruthy('typed evaluate returns an evaluation', typed.body?.evaluation);
  check('empty/short transcript asks to retry', typed.body.evaluation.retry_required, true);

  console.log('\n12. TTS cache: first call synthesises, second is a cache hit');
  const tts1 = await fetch(`${BASE}/v1/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: "I'd like a coffee, please.", script: 'en', namespace: 'e2e' }),
  });
  const audio1 = Buffer.from(await tts1.arrayBuffer());
  check('tts status', tts1.status, 200);
  // The cache is deliberately durable and shared across learners, so a repeat run
  // may already find this text cached. Assert the property that must hold either
  // way: the state is one of the two documented values, and a miss is charged
  // while a hit is not.
  const firstCacheState = tts1.headers.get('x-tts-cache');
  checkTruthy('first call reports a cache state', ['hit', 'miss'].includes(firstCacheState));
  checkTruthy('audio bytes returned', audio1.length > 44);
  if (firstCacheState === 'miss') {
    checkTruthy('a cache miss is charged', Number(tts1.headers.get('x-tts-credits')) > 0);
  }

  const tts2 = await fetch(`${BASE}/v1/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: "I'd like a coffee, please.", script: 'en', namespace: 'e2e' }),
  });
  await tts2.arrayBuffer();
  check('the second identical request is a cache hit', tts2.headers.get('x-tts-cache'), 'hit');
  check('a cache hit costs 0 credits', tts2.headers.get('x-tts-credits'), '0');

  console.log('\n13. Progress reflects what actually happened');
  const progress = await call('GET', '/v1/progress', { token });
  check('progress status', progress.status, 200);
  check('one lesson completed', progress.body.progress.lessons_completed, 1);
  checkTruthy('speaking attempts counted', progress.body.progress.speaking_attempts >= 1);
  checkTruthy('vocabulary counted', progress.body.progress.vocabulary_learned >= 1);

  console.log('\n14. Usage ledger is attributed and inside budget');
  const usage = await call('GET', '/v1/usage', { token });
  check('usage status', usage.status, 200);
  checkTruthy('speaking attempts recorded', usage.body.usage.speaking_attempts_used >= 1);
  checkTruthy('tts requests recorded', usage.body.usage.tts_requests_used >= 1);
  checkTruthy('tts cache hits counted', usage.body.usage.tts_cache_hits_today >= 1);
  checkTruthy('credits stayed inside the daily budget', usage.body.usage.credits_used_today <= usage.body.usage.credits_today_budget);

  console.log('\n15. Cross-user access is refused');
  const otherEmail = `e2e-b-${Date.now()}@example.com`;
  const other = await call('POST', '/v1/auth/register', {
    body: {
      email: otherEmail,
      password,
      accept_terms: true,
      accept_privacy_policy: true,
      voice_consent: false,
    },
  });
  check('second registration is non-enumerating', other.status, 202);
  const otherVerified = await verifyTestEmail(otherEmail);
  check('second email verification succeeds', otherVerified.status, 200);
  const otherSession = await call('POST', '/v1/auth/login', {
    body: { email: otherEmail, password },
  });
  const intruder = await call('POST', `/v1/vocabulary/${itemId}/review`, {
    token: otherSession.body.tokens.access_token,
    body: { review_state: 'new' },
  });
  check("another learner cannot touch this learner's vocabulary", intruder.status, 404);

  console.log('\n16. Refresh rotates the token');
  const refreshed = await call('POST', '/v1/auth/refresh', { token, body: { refresh_token: refreshToken } });
  check('refresh status', refreshed.status, 200);
  checkTruthy('a new access token was issued', refreshed.body?.tokens?.access_token);
  check('the refresh token was rotated', refreshed.body.tokens.refresh_token !== refreshToken, true);

  const reuseOld = await call('POST', '/v1/auth/refresh', { token, body: { refresh_token: refreshToken } });
  check('the rotated-out refresh token no longer works', reuseOld.status, 401);

  console.log('\n17. Consent withdrawal blocks voice processing immediately');
  const withdraw = await call('POST', '/v1/consent/withdraw', { token, body: { consent_type: 'voice_processing' } });
  check('withdraw status', withdraw.status, 200);
  const blocked = await call('POST', '/v1/speaking/transcribe', {
    token,
    body: { prompt_slug: promptSlug, mime_type: 'audio/wav', duration_seconds: 1, audio_base64: wavBytes(1).toString('base64') },
  });
  check('speaking is blocked with 403', blocked.status, 403);
  check('blocked with CONSENT_REQUIRED', blocked.body?.error?.code, 'CONSENT_REQUIRED');

  console.log('\n18. Logout ends the session for refresh, deletion ends it for access');
  const logout = await call('POST', '/v1/auth/logout', { token });
  check('logout status', logout.status, 200);
  const afterLogout = await call('POST', '/v1/auth/refresh', { token, body: { refresh_token: refreshed.body.tokens.refresh_token } });
  check('refresh after logout is refused', afterLogout.status, 401);

  const fresh = await call('POST', '/v1/auth/login', { body: { email, password } });
  check('login status', fresh.status, 200);
  const deleteRes = await call('DELETE', '/v1/account', { token: fresh.body.tokens.access_token });
  check('delete status', deleteRes.status, 200);
  check('deletion is acknowledged', deleteRes.body?.deletion_requested, true);
  const afterDelete = await call('GET', '/v1/profile', { token: fresh.body.tokens.access_token });
  check('the deleted account cannot use its token', afterDelete.status, 401);

  console.log('\n19. Wrong credentials give a non-enumerating answer');
  const wrongPw = await call('POST', '/v1/auth/login', { body: { email, password: 'not-the-password' } });
  const unknown = await call('POST', '/v1/auth/login', { body: { email: `nobody-${Date.now()}@example.com`, password: 'not-the-password' } });
  check('same status for wrong password and unknown account', wrongPw.status, unknown.status);
  check('same code for wrong password and unknown account', wrongPw.body.error.code, unknown.body.error.code);

  console.log('\n20. Unknown route is a clean 404, not a crash');
  const notFound = await call('GET', '/v1/does-not-exist', { token });
  check('unknown route status', notFound.status, 404);

  console.log(`\n=== ${passed} checks passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`FAILED: ${f.name}`);
    console.log(JSON.stringify({ harnessVerification: { version: 1, checks: failures.map((f) => ({ name: f.name, actual: f.actual, expected: f.expected })) } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ harnessVerification: { version: 1, checks: [{ name: 'live MVP journey checks passed', actual: passed, expected: passed }] } }));
};

run().catch((error) => {
  console.error('e2e journey crashed:', error);
  process.exit(1);
});
