/**
 * Runner smoke test.
 *
 * Exists so a broken test script fails loudly instead of silently reporting
 * "0 tests, 0 failures". Kept intentionally trivial: it proves the runner
 * discovers TypeScript test files and can drive the real app over HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, startTestApp } from './harness.ts';

test('the test runner discovers TypeScript tests and the app answers HTTP', async () => {
  const app = await startTestApp();
  try {
    const response = await request(app, 'GET', '/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
  } finally {
    await app.close();
  }
});
