import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, startTestApp } from './harness.ts';

function actionToken(actionUrl: string): string {
  const token = new URLSearchParams(new URL(actionUrl).hash.slice(1)).get('token');
  assert.ok(token);
  return token;
}

async function register(app: Awaited<ReturnType<typeof startTestApp>>, email: string): Promise<void> {
  const response = await request(app, 'POST', '/v1/auth/register', {
    body: {
      email,
      password: 'correct-horse-battery',
      accept_terms: true,
      accept_privacy_policy: true,
      voice_consent: false,
    },
  });
  assert.equal(response.status, 202);
}

test('email verification is required for login and its action token is single-use', async () => {
  const app = await startTestApp();
  const email = 'verify@example.com';
  try {
    await register(app, email);
    const user = await app.repo.auth.findByEmail(email);
    assert.ok(user);
    assert.equal(user.emailVerifiedAt, null);

    const beforeVerification = await request(app, 'POST', '/v1/auth/login', {
      body: { email, password: 'correct-horse-battery' },
    });
    assert.equal(beforeVerification.status, 401);

    const verificationEmail = app.emailDelivery.messages.find((message) => message.to === email);
    assert.ok(verificationEmail);
    assert.equal(new URL(verificationEmail.actionUrl).search, '');
    const resend = await request(app, 'POST', '/v1/auth/resend-verification', { body: { email } });
    const unknownResend = await request(app, 'POST', '/v1/auth/resend-verification', {
      body: { email: 'absent@example.com' },
    });
    assert.equal(resend.status, 202);
    assert.deepEqual(resend.body, unknownResend.body);

    const resentEmail = [...app.emailDelivery.messages].reverse().find((message) => message.to === email);
    assert.ok(resentEmail);
    const staleLink = await request(app, 'POST', '/v1/auth/verify-email', {
      body: { token: actionToken(verificationEmail.actionUrl) },
    });
    assert.equal(staleLink.status, 401);

    const token = actionToken(resentEmail.actionUrl);
    const verified = await request(app, 'POST', '/v1/auth/verify-email', { body: { token } });
    assert.equal(verified.status, 200);
    assert.ok((await app.repo.auth.findByEmail(email))?.emailVerifiedAt);

    const replay = await request(app, 'POST', '/v1/auth/verify-email', { body: { token } });
    assert.equal(replay.status, 401);
    const login = await request(app, 'POST', '/v1/auth/login', {
      body: { email, password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200);
  } finally {
    await app.close();
  }
});

test('password recovery is non-enumerating and revokes refresh sessions after reset', async () => {
  const app = await startTestApp();
  const email = 'recovery@example.com';
  try {
    await register(app, email);
    const verificationEmail = app.emailDelivery.messages.find((message) => message.to === email);
    assert.ok(verificationEmail);
    await request(app, 'POST', '/v1/auth/verify-email', {
      body: { token: actionToken(verificationEmail.actionUrl) },
    });

    const login = await request(app, 'POST', '/v1/auth/login', {
      body: { email, password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200);
    const oldRefreshToken = login.body.tokens.refresh_token as string;

    const known = await request(app, 'POST', '/v1/auth/forgot-password', { body: { email } });
    const unknown = await request(app, 'POST', '/v1/auth/forgot-password', { body: { email: 'absent@example.com' } });
    assert.equal(known.status, 202);
    assert.deepEqual(known.body, unknown.body);

    const recoveryEmail = [...app.emailDelivery.messages].reverse().find((message) => message.to === email);
    assert.ok(recoveryEmail);
    assert.equal(recoveryEmail.purpose, 'password_recovery');
    const reset = await request(app, 'POST', '/v1/auth/reset-password', {
      body: { token: actionToken(recoveryEmail.actionUrl), password: 'a-new-valid-password' },
    });
    assert.equal(reset.status, 200);

    const refresh = await request(app, 'POST', '/v1/auth/refresh', {
      body: { refresh_token: oldRefreshToken },
    });
    assert.equal(refresh.status, 401);
    const oldPassword = await request(app, 'POST', '/v1/auth/login', {
      body: { email, password: 'correct-horse-battery' },
    });
    assert.equal(oldPassword.status, 401);
    const newPassword = await request(app, 'POST', '/v1/auth/login', {
      body: { email, password: 'a-new-valid-password' },
    });
    assert.equal(newPassword.status, 200);
  } finally {
    await app.close();
  }
});

test('expired verification links cannot verify an account', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const app = await startTestApp({ now: () => now });
  const email = 'expired@example.com';
  try {
    await register(app, email);
    const message = app.emailDelivery.messages.find((item) => item.to === email);
    assert.ok(message);
    now = new Date('2026-01-02T00:00:01.000Z');

    const response = await request(app, 'POST', '/v1/auth/verify-email', {
      body: { token: actionToken(message.actionUrl) },
    });
    assert.equal(response.status, 401);
    assert.equal((await app.repo.auth.findByEmail(email))?.emailVerifiedAt, null);
  } finally {
    await app.close();
  }
});

test('email action pages are no-store, nonce-protected and do not load external assets', async () => {
  const app = await startTestApp();
  try {
    const response = await request(app, 'GET', '/auth/reset-password');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /script-src 'nonce-[A-Za-z0-9_-]+'/);
    const html = new TextDecoder().decode(response.bytes);
    assert.doesNotMatch(html, /<script[^>]+src=|https?:\/\//);
  } finally {
    await app.close();
  }
});
