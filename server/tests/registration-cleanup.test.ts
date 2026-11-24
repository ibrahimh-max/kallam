import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, startTestApp } from './harness.ts';

test('registration removes the partial account when profile setup fails', async () => {
  const app = await startTestApp();
  const email = 'partial-registration@example.com';
  const originalCreate = app.repo.profiles.create.bind(app.repo.profiles);
  app.repo.profiles.create = async () => {
    throw new Error('synthetic profile failure');
  };

  try {
    const response = await request(app, 'POST', '/v1/auth/register', {
      body: {
        email,
        password: 'correct-horse-battery',
        display_name: 'Test Learner',
        accept_terms: true,
        accept_privacy_policy: true,
        voice_consent: false,
      },
    });

    assert.equal(response.status, 500);
    assert.equal(await app.repo.auth.findByEmail(email), null);
  } finally {
    app.repo.profiles.create = originalCreate;
    await app.close();
  }
});
