import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp } from './harness.ts';

test('browser API preflight allows the web app origin and required request headers', async () => {
  const app = await startTestApp();
  try {
    const response = await fetch(`${app.baseUrl}/v1/auth/register`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Authorization/i);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  } finally {
    await app.close();
  }
});

test('browser CORS rejects unlisted origins and methods', async () => {
  const app = await startTestApp();
  try {
    const disallowedOrigin = await fetch(`${app.baseUrl}/v1/auth/register`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5174',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const disallowedMethod = await fetch(`${app.baseUrl}/v1/auth/register`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'TRACE',
      },
    });

    assert.equal(disallowedOrigin.status, 403);
    assert.equal(disallowedMethod.status, 403);
    assert.equal(disallowedOrigin.headers.get('access-control-allow-origin'), null);
  } finally {
    await app.close();
  }
});

test('browser responses expose only the TTS metadata needed by the app', async () => {
  const app = await startTestApp();
  try {
    const response = await fetch(`${app.baseUrl}/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(response.headers.get('access-control-expose-headers'), 'X-TTS-Cache, X-TTS-Credits');
  } finally {
    await app.close();
  }
});
