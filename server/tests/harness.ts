/**
 * Shared test harness.
 *
 * The tests drive the **real** Express app over **real HTTP** (a socket on an
 * ephemeral port) against the real services, with two controlled substitutions:
 *
 *   - the data layer is `MemoryRepository` (an in-process double for Postgres)
 *   - the voice provider is `MockVoiceProvider` (deterministic, no network, no credits)
 *
 * Everything else — validation, authorisation, quota accounting, TTS caching,
 * idempotency, retention — is the production code path. A test that called services
 * directly would not prove routing, middleware order, status codes or response
 * shapes, which is where most of the security-relevant behaviour lives.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.ts';
import { loadEnv, type ServerEnv } from '../src/config/env.ts';
import { NullLogger } from '../src/core/logger.ts';
import { MemoryRepository } from '../src/repositories/MemoryRepository.ts';
import type { Repository } from '../src/repositories/Repository.ts';
import { SEED_LESSONS } from '../src/content/lessons.ts';
import { MockVoiceProvider, type MockProviderOptions } from '../src/services/voice/MockVoiceProvider.ts';
import { MockEmailDelivery } from '../src/services/auth/EmailDelivery.ts';

/** A 32+ character secret, as `loadEnv` requires for custom API auth. */
export const TEST_JWT_SECRET = 'test-only-jwt-secret-value-not-used-in-production-32';

export interface TestEnvOptions {
  freeDailySpeakingAttempts?: number;
  freeDailyTtsRequests?: number;
  dailyCreditBudget?: number;
  maxTtsChars?: number;
  maxAudioBytes?: number;
  maxAudioDurationSeconds?: number;
  requestsPerMinutePerUser?: number;
  requestsPerMinutePerIp?: number;
  retention?: Partial<ServerEnv['retention']>;
  /** Public legal pages: an absent address must omit the email fallback cleanly. */
  supportEmail?: string;
  appName?: string;
}

/**
 * Builds env from a plain object, never from `process.env`.
 *
 * This is why `loadEnv` takes an explicit source: a test must not be able to pick
 * up a real HUMAIN key or DATABASE_URL from the shell, and must produce identical
 * configuration on every machine.
 */
export function testEnv(options: TestEnvOptions = {}): ServerEnv {
  return loadEnv({
    NODE_ENV: 'test',
    AUTH_DRIVER: 'custom',
    REPOSITORY_DRIVER: 'memory',
    EMAIL_PROVIDER: 'mock',
    LOCAL_JWT_SECRET: TEST_JWT_SECRET,
    ...(options.freeDailySpeakingAttempts !== undefined
      ? { FREE_DAILY_SPEAKING_ATTEMPTS: String(options.freeDailySpeakingAttempts) }
      : {}),
    ...(options.freeDailyTtsRequests !== undefined ? { FREE_DAILY_TTS_REQUESTS: String(options.freeDailyTtsRequests) } : {}),
    ...(options.dailyCreditBudget !== undefined ? { DAILY_CREDIT_BUDGET: String(options.dailyCreditBudget) } : {}),
    ...(options.maxTtsChars !== undefined ? { MAX_TTS_CHARS: String(options.maxTtsChars) } : {}),
    ...(options.maxAudioBytes !== undefined ? { MAX_AUDIO_BYTES: String(options.maxAudioBytes) } : {}),
    ...(options.maxAudioDurationSeconds !== undefined
      ? { MAX_AUDIO_DURATION_SECONDS: String(options.maxAudioDurationSeconds) }
      : {}),
    ...(options.requestsPerMinutePerUser !== undefined
      ? { RATE_LIMIT_PER_USER_PER_MINUTE: String(options.requestsPerMinutePerUser) }
      : {}),
    ...(options.requestsPerMinutePerIp !== undefined
      ? { RATE_LIMIT_PER_IP_PER_MINUTE: String(options.requestsPerMinutePerIp) }
      : {}),
    ...(options.retention?.transcriptDays !== undefined
      ? { RETENTION_TRANSCRIPT_DAYS: String(options.retention.transcriptDays) }
      : {}),
    ...(options.retention?.evaluationDays !== undefined
      ? { RETENTION_EVALUATION_DAYS: String(options.retention.evaluationDays) }
      : {}),
    ...(options.retention?.profileGraceDays !== undefined
      ? { RETENTION_PROFILE_GRACE_DAYS: String(options.retention.profileGraceDays) }
      : {}),
    ...(options.retention?.usageEventMonths !== undefined
      ? { RETENTION_USAGE_MONTHS: String(options.retention.usageEventMonths) }
      : {}),
    ...(options.retention?.consentMonthsAfterWithdrawal !== undefined
      ? { RETENTION_CONSENT_MONTHS_AFTER_WITHDRAWAL: String(options.retention.consentMonthsAfterWithdrawal) }
      : {}),
    ...(options.supportEmail !== undefined ? { SUPPORT_EMAIL: options.supportEmail } : {}),
    ...(options.appName !== undefined ? { APP_NAME: options.appName } : {}),
  } as NodeJS.ProcessEnv);
}

export interface TestAppOptions extends TestEnvOptions {
  mockProvider?: MockProviderOptions;
  now?: () => Date;
}

export interface TestApp {
  baseUrl: string;
  repo: Repository;
  provider: MockVoiceProvider;
  emailDelivery: MockEmailDelivery;
  env: ServerEnv;
  close(): Promise<void>;
}

/** Starts the app on an ephemeral port and returns a client bound to it. */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const env = testEnv(options);
  const repo = new MemoryRepository();
  const provider = new MockVoiceProvider(options.mockProvider);
  const emailDelivery = new MockEmailDelivery();

  const app = buildApp({
    env,
    repo,
    provider,
    emailDelivery,
    logger: new NullLogger(),
    ...(options.now ? { now: options.now } : {}),
  });

  // Seed the authored lesson content, exactly as the server does at boot.
  await repo.lessons.upsertMany(SEED_LESSONS);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    repo,
    provider,
    emailDelivery,
    env,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface HttpResult<T = any> {
  status: number;
  headers: Headers;
  body: T;
  /** Raw bytes, needed for the TTS route which returns audio rather than JSON. */
  bytes: Uint8Array;
}

/**
 * One HTTP call. Returns the parsed body for JSON responses and the raw bytes for
 * everything else, so an audio response can be asserted on too.
 */
export async function request<T = any>(
  app: TestApp,
  method: string,
  path: string,
  options: { token?: string | undefined; body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  let payload: string | undefined;
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });

  const buffer = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? (JSON.parse(new TextDecoder().decode(buffer)) as T)
    : (undefined as unknown as T);

  return { status: response.status, headers: response.headers, body, bytes: buffer };
}

export interface TestUser {
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}

let emailCounter = 0;

/** Registers a fresh learner and returns working credentials. */
export async function registerUser(app: TestApp, overrides: { email?: string; password?: string } = {}): Promise<TestUser> {
  emailCounter += 1;
  const email = overrides.email ?? `learner${emailCounter}.${process.pid}@example.com`;
  const password = overrides.password ?? 'correct-horse-battery';

  const response = await request(app, 'POST', '/v1/auth/register', {
    body: {
      email,
      password,
      display_name: 'Test Learner',
      accept_terms: true,
      accept_privacy_policy: true,
      voice_consent: true,
    },
  });

  if (response.status !== 202) {
    throw new Error(`registerUser failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  await verifyEmail(app, email);
  const session = await request(app, 'POST', '/v1/auth/login', {
    body: { email, password },
  });
  if (session.status !== 200) {
    throw new Error(`registerUser login failed: ${session.status} ${JSON.stringify(session.body)}`);
  }

  return {
    token: session.body.tokens.access_token as string,
    refreshToken: session.body.tokens.refresh_token as string,
    userId: session.body.profile.id as string,
    email,
  };
}

export async function verifyEmail(app: TestApp, email: string): Promise<void> {
  const message = [...app.emailDelivery.messages]
    .reverse()
    .find((item) => item.to === email && item.purpose === 'verify_email');
  if (!message) throw new Error(`no test verification email was captured for ${email}`);
  const token = new URLSearchParams(new URL(message.actionUrl).hash.slice(1)).get('token');
  const verification = await request(app, 'POST', '/v1/auth/verify-email', { body: { token } });
  if (verification.status !== 200) {
    throw new Error(`email verification failed: ${verification.status} ${JSON.stringify(verification.body)}`);
  }
}

/** A small, valid WAV container, used where the route validates the audio header. */
export function wavBytes(durationSeconds = 1): Uint8Array {
  const sampleRate = 16_000;
  const samples = Math.round(sampleRate * durationSeconds);
  const dataBytes = samples * 2;
  const buffer = new Uint8Array(44 + dataBytes);
  const view = new DataView(buffer.buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples; i += 1) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 200) * 6000), true);
  }
  return buffer;
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
