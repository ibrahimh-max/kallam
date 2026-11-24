/**
 * Regression tests for the public legal surface (Milestone 5, build (1).md §10.1
 * and §14).
 *
 * These are not "the page returns 200" tests. Each one asserts a property that
 * would be a real defect if it regressed:
 *
 *   - the deletion path must be reachable WITHOUT authentication, because Google
 *     Play requires a web route for someone who uninstalled the app and can no
 *     longer sign in;
 *   - the published retention numbers must come from the same policy the
 *     retention job enforces, because a policy that promises 90 days while the
 *     job clears at 30 is a false statement to users;
 *   - the pages must carry no script and no third-party asset, so the privacy
 *     page cannot itself become an undeclared tracker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, startTestApp } from './harness.ts';

function decodeHtml(result: { bytes: Uint8Array }): string {
  return new TextDecoder().decode(result.bytes);
}

test('the account-deletion page is reachable with no token at all', async () => {
  const app = await startTestApp();
  try {
    // No `token` is passed: this is exactly the request an uninstalled user makes.
    const response = await request(app, 'GET', '/legal/delete-account');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);

    const html = decodeHtml(response);
    // The in-app path must be described, and the irreversible timing stated.
    assert.ok(html.includes('Delete your account and data'), 'page must have an English title');
    assert.ok(html.includes('Delete account'), 'page must name the in-app control');
  } finally {
    await app.close();
  }
});

test('the published retention durations are the ones the retention job enforces', async () => {
  // Deliberately NOT the defaults: if the pages hardcoded 90/24/36/30 they would
  // still pass against this app, which is the drift the test exists to catch.
  const app = await startTestApp({
    retention: {
      transcriptDays: 45,
      evaluationDays: 45,
      usageEventMonths: 12,
      consentMonthsAfterWithdrawal: 18,
      profileGraceDays: 7,
    },
  });
  try {
    const privacy = decodeHtml(await request(app, 'GET', '/legal/privacy'));
    assert.ok(privacy.includes('45 days'), 'transcript/evaluation window must be read from policy');
    assert.ok(privacy.includes('12 months'), 'usage-event window must be read from policy');
    assert.ok(privacy.includes('18 months'), 'consent window must be read from policy');
    assert.ok(privacy.includes('7 days'), 'profile grace period must be read from policy');

    // And the values the code does NOT compute must not appear as if they did.
    assert.ok(!privacy.includes('90 days'), 'must not advertise the default when config differs');

    const deletion = decodeHtml(await request(app, 'GET', '/legal/delete-account'));
    assert.ok(deletion.includes('7 days'), 'deletion page must state the configured grace period');
  } finally {
    await app.close();
  }
});

test('the legal pages ship no script and no external asset', async () => {
  const app = await startTestApp();
  try {
    for (const path of ['/legal/privacy', '/legal/terms', '/legal/delete-account', '/legal']) {
      const html = decodeHtml(await request(app, 'GET', path));
      assert.ok(!html.includes('<script'), `${path} must not ship script`);
      assert.ok(!/src=["']https?:/i.test(html), `${path} must not load a remote asset`);
      assert.ok(!/<link[^>]+href=["']https?:/i.test(html), `${path} must not load a remote stylesheet`);
      // Arabic is a first-class citizen here, not an afterthought: RTL must be marked.
      assert.ok(html.includes('dir="rtl"'), `${path} must mark Arabic as RTL`);
    }
  } finally {
    await app.close();
  }
});

test('an unknown legal slug is a clean 404, not a crash or an index fallback', async () => {
  const app = await startTestApp();
  try {
    const response = await request(app, 'GET', '/legal/does-not-exist');
    assert.equal(response.status, 404);
    assert.equal(response.body.ok, undefined, 'a 404 must not carry the ok wrapper');
    assert.equal(response.body.error.code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('an optional support address changes what the deletion page instructs', async () => {
  // With no SUPPORT_EMAIL the pages must still work and must NOT print an empty
  // "email us at" sentence — the fallback text is the point.
  const without = await startTestApp({ supportEmail: '' });
  try {
    const html = decodeHtml(await request(without, 'GET', '/legal/delete-account'));
    assert.ok(html.includes('Email us from the address you registered with'));
    assert.ok(!html.includes('email us from the address you registered with at '), 'no empty address');
  } finally {
    await without.close();
  }

  const withAddress = await startTestApp({ supportEmail: 'privacy@example.com' });
  try {
    const html = decodeHtml(await request(withAddress, 'GET', '/legal/delete-account'));
    assert.ok(html.includes('privacy@example.com'), 'a configured address must be published');
  } finally {
    await withAddress.close();
  }
});
