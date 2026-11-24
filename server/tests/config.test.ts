import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEnv, safeSummary } from '../src/config/env.ts';

const SUPABASE_ENV = {
  NODE_ENV: 'development',
  AUTH_DRIVER: 'custom',
  REPOSITORY_DRIVER: 'supabase',
  SUPABASE_URL: 'https://tutor-test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
};

test('backend JWT signing secret is required even with Supabase-backed storage', () => {
  assert.throws(
    () => loadEnv(SUPABASE_ENV),
    /LOCAL_JWT_SECRET must be set/,
  );
});

test('safe configuration summary never exposes the backend JWT secret', () => {
  const secret = 'test-secret-with-more-than-thirty-two-characters';
  const resendKey = 'test-resend-api-key-that-must-not-leak';
  const env = loadEnv({
    ...SUPABASE_ENV,
    LOCAL_JWT_SECRET: secret,
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: resendKey,
    EMAIL_FROM: 'noreply@example.com',
  });
  const summary = JSON.stringify(safeSummary(env));

  assert.equal(env.authDriver, 'custom');
  assert.ok(!summary.includes(secret));
  assert.ok(!summary.includes(resendKey));
});

test('unsupported Supabase Auth selection fails instead of claiming an unimplemented integration', () => {
  assert.throws(
    () =>
      loadEnv({
        ...SUPABASE_ENV,
        AUTH_DRIVER: 'supabase',
        LOCAL_JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      }),
    /AUTH_DRIVER must be custom/,
  );
});

test('production mode refuses the ephemeral in-memory repository', () => {
  assert.throws(
    () =>
      loadEnv({
        NODE_ENV: 'production',
        REPOSITORY_DRIVER: 'memory',
        LOCAL_JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
        PUBLIC_BASE_URL: 'https://tutor.example',
        SUPPORT_EMAIL: 'support@example.com',
      }),
    /NODE_ENV=production requires REPOSITORY_DRIVER=supabase/,
  );
});

test('production mode requires HTTPS legal URLs, support contact, and a real voice key', () => {
  const productionEnv = {
    ...SUPABASE_ENV,
    NODE_ENV: 'production',
    LOCAL_JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
    PUBLIC_BASE_URL: 'https://tutor.example',
    SUPPORT_EMAIL: 'support@example.com',
    HUMAIN_API_KEY: 'test-provider-key',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 'test-resend-key',
    EMAIL_FROM: 'Saudi English Tutor <noreply@example.com>',
  };

  assert.equal(loadEnv(productionEnv).nodeEnv, 'production');
  assert.throws(
    () => loadEnv({ ...productionEnv, PUBLIC_BASE_URL: 'http://tutor.example' }),
    /PUBLIC_BASE_URL must use https/,
  );
  assert.throws(
    () => loadEnv({ ...productionEnv, HUMAIN_API_KEY: '' }),
    /requires HUMAIN_API_KEY/,
  );
  assert.throws(
    () => loadEnv({ ...productionEnv, RESEND_API_KEY: '', EMAIL_FROM: '' }),
    /EMAIL_PROVIDER=resend requires/,
  );
});

test('mock email delivery is restricted to test mode and the memory repository', () => {
  assert.throws(
    () => loadEnv({ NODE_ENV: 'development', EMAIL_PROVIDER: 'mock', LOCAL_JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters' }),
    /EMAIL_PROVIDER=mock is allowed only/,
  );
});

test('voice provider selection is validated and carried in the loaded config', () => {
  const secret = 'test-secret-with-more-than-thirty-two-characters';

  assert.equal(
    loadEnv({ NODE_ENV: 'test', LOCAL_JWT_SECRET: secret, VOICE_PROVIDER: 'mock' }).voiceProvider,
    'mock',
  );
  assert.equal(
    loadEnv({ NODE_ENV: 'test', LOCAL_JWT_SECRET: secret }).voiceProvider,
    'auto',
  );
  assert.throws(
    () => loadEnv({ NODE_ENV: 'test', LOCAL_JWT_SECRET: secret, VOICE_PROVIDER: 'unknown' }),
    /VOICE_PROVIDER must be auto, humain, or mock/,
  );
});
