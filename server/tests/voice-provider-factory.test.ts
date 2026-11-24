import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEnv } from '../src/config/env.ts';
import { createVoiceProvider } from '../src/services/voice/VoiceProviderFactory.ts';

test('voice provider factory uses the explicitly loaded environment', () => {
  const previous = process.env.VOICE_PROVIDER;
  process.env.VOICE_PROVIDER = 'humain';

  try {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOCAL_JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      VOICE_PROVIDER: 'mock',
    });

    assert.equal(createVoiceProvider(env).kind, 'mock');
  } finally {
    if (previous === undefined) delete process.env.VOICE_PROVIDER;
    else process.env.VOICE_PROVIDER = previous;
  }
});
