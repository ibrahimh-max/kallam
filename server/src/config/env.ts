/**
 * Server configuration, read once at startup.
 *
 * Rules this file enforces:
 *  - Secrets come from the environment only. Nothing is hardcoded, and no value
 *    from here is ever logged: `safeSummary()` returns names and booleans only.
 *  - Missing *required* config fails fast at boot rather than at the first user
 *    request. Missing *optional* config degrades to a documented local mode.
 *  - The HUMAIN key never leaves the backend. It is not serialised into any
 *    response, and `redact()` exists so logs can prove presence without content.
 */
import { createHash } from 'node:crypto';

export type RepositoryDriver = 'memory' | 'supabase';
export type AuthDriver = 'custom';
export type VoiceProviderMode = 'auto' | 'humain' | 'mock';

export interface ServerEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Public origin the web deletion page is served from (store requirement). */
  publicBaseUrl: string;

  repositoryDriver: RepositoryDriver;
  authDriver: AuthDriver;
  voiceProvider: VoiceProviderMode;
  corsAllowedOrigins: string[];

  humain: {
    apiUrl: string;
    apiKey: string;
    apiPath: string;
    timeoutMs: number;
  };

  supabase: {
    url: string;
    serviceRoleKey: string;
  };
  email: {
    provider: 'disabled' | 'mock' | 'resend';
    apiKey: string;
    from: string;
  };

  /** Signs backend-issued access tokens regardless of the selected data driver. */
  localJwtSecret: string;

  limits: {
    maxAudioBytes: number;
    maxAudioDurationSeconds: number;
    maxTtsChars: number;
    freeDailySpeakingAttempts: number;
    freeDailyTtsRequests: number;
    requestsPerMinutePerUser: number;
    requestsPerMinutePerIp: number;
  };

  /**
   * Number of proxy hops in front of the server that Express may believe.
   *
   * `0` (the default) means "trust nothing": `req.ip` is the socket peer, so a
   * client cannot choose its own rate-limit bucket with a forged
   * `x-forwarded-for` header. Raise it to the real hop count only when the
   * deployment actually sits behind a trusted load balancer.
   */
  trustProxyHops: number;

  usage: {
    /** Hard ceiling on estimated provider credits per UTC day. */
    dailyCreditBudget: number;
  };

  retention: {
    transcriptDays: number;
    evaluationDays: number;
    usageEventMonths: number;
    consentMonthsAfterWithdrawal: number;
    profileGraceDays: number;
  };

  /**
   * Public legal pages. Google Play requires a deletion path reachable from the
   * web by someone who already uninstalled the app, so the support address and
   * the published app name are configuration, not literals inside the template.
   */
  legal: {
    appName: string;
    supportEmail: string;
    effectiveDate: string;
  };
}

/**
 * Every reader takes the `source` explicitly.
 *
 * These previously read `process.env` directly, which meant `loadEnv(source)` honoured
 * the argument for some keys and the ambient environment for others — so a value set in
 * the shell could silently override the test's own config (or leak a real HUMAIN key
 * into a test run). One source, read once.
 */
function readString(source: NodeJS.ProcessEnv, name: string, fallback = ''): string {
  const raw = source[name];
  return typeof raw === 'string' ? raw.trim() : fallback;
}

function readInt(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = readString(source, name);
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return parsed;
}

function readUrl(source: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = readString(source, name, fallback);
  if (raw === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`${name} must use https in non-local environments`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function readCorsAllowedOrigins(source: NodeJS.ProcessEnv, nodeEnv: ServerEnv['nodeEnv']): string[] {
  const configured = readString(source, 'CORS_ALLOWED_ORIGINS');
  const values = configured === ''
    ? nodeEnv === 'production'
      ? []
      : ['http://localhost:5173', 'http://127.0.0.1:5173']
    : configured.split(',').map((origin) => origin.trim());
  const origins = new Set<string>();

  for (const value of values) {
    if (value === '') throw new Error('CORS_ALLOWED_ORIGINS contains an empty origin');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('CORS_ALLOWED_ORIGINS must contain absolute origins');
    }
    const isLocalHttp =
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.protocol !== 'https:' && !isLocalHttp) ||
      (nodeEnv === 'production' && url.protocol !== 'https:')
    ) {
      throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTPS origins (HTTP is allowed only for loopback development)');
    }
    origins.add(url.origin);
  }

  return [...origins];
}

/** Presence without content — safe to log. */
export function redact(value: string): { present: boolean; length: number; fingerprint: string } {
  return {
    present: value.length > 0,
    length: value.length,
    fingerprint: value.length === 0 ? '' : createHash('sha256').update(value).digest('hex').slice(0, 12),
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const nodeEnvRaw = (source.NODE_ENV ?? 'development').trim();
  const nodeEnv: ServerEnv['nodeEnv'] =
    nodeEnvRaw === 'production' ? 'production' : nodeEnvRaw === 'test' ? 'test' : 'development';

  const humainApiKey = (source.HUMAIN_API_KEY ?? '').trim();

  // Repository selection defaults to the driver that can actually run. An
  // explicitly requested Supabase repository without credentials is a
  // misconfiguration, not a silent downgrade.
  const requestedRepo = (source.REPOSITORY_DRIVER ?? '').trim();
  const requestedAuth = (source.AUTH_DRIVER ?? '').trim();
  const requestedVoiceProvider = readString(source, 'VOICE_PROVIDER').toLowerCase();

  const supabaseUrl = readUrl(source, 'SUPABASE_URL', '');
  const supabaseServiceRoleKey = (source.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  const resendApiKey = (source.RESEND_API_KEY ?? '').trim();
  const emailFrom = readString(source, 'EMAIL_FROM');
  const requestedEmailProvider = readString(source, 'EMAIL_PROVIDER');

  const supabaseReady = supabaseUrl !== '' && supabaseServiceRoleKey !== '';
  const repositoryDriver: RepositoryDriver =
    requestedRepo === 'supabase' ? 'supabase' : requestedRepo === 'memory' ? 'memory' : supabaseReady ? 'supabase' : 'memory';
  const authDriver: AuthDriver = 'custom';
  const corsAllowedOrigins = readCorsAllowedOrigins(source, nodeEnv);
  const emailProvider =
    requestedEmailProvider === 'mock'
      ? 'mock'
      : requestedEmailProvider === 'disabled'
        ? 'disabled'
        : requestedEmailProvider === 'resend' || (resendApiKey !== '' && emailFrom !== '')
          ? 'resend'
          : 'disabled';

  if (!['', 'mock', 'disabled', 'resend'].includes(requestedEmailProvider)) {
    throw new Error('EMAIL_PROVIDER must be resend, disabled, or mock');
  }
  if (!['', 'auto', 'humain', 'mock'].includes(requestedVoiceProvider)) {
    throw new Error('VOICE_PROVIDER must be auto, humain, or mock');
  }
  const voiceProvider: VoiceProviderMode =
    requestedVoiceProvider === 'mock' ? 'mock' : requestedVoiceProvider === 'humain' ? 'humain' : 'auto';
  if (repositoryDriver === 'supabase' && !supabaseReady) {
    throw new Error('REPOSITORY_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  if (requestedAuth !== '' && requestedAuth !== 'custom' && requestedAuth !== 'local') {
    throw new Error(
      'AUTH_DRIVER must be custom: this API verifies passwords and issues its own tokens; Supabase Auth sessions are not implemented',
    );
  }
  if ((resendApiKey === '') !== (emailFrom === '')) {
    throw new Error('RESEND_API_KEY and EMAIL_FROM must be configured together');
  }
  if (emailProvider === 'resend' && (resendApiKey === '' || emailFrom === '')) {
    throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');
  }
  if (emailProvider === 'mock' && (nodeEnv !== 'test' || repositoryDriver !== 'memory')) {
    throw new Error('EMAIL_PROVIDER=mock is allowed only with NODE_ENV=test and REPOSITORY_DRIVER=memory');
  }

  const localJwtSecret = (source.LOCAL_JWT_SECRET ?? '').trim();
  if (localJwtSecret.length < 32) {
    throw new Error(
      'LOCAL_JWT_SECRET must be set to at least 32 characters because the API signs its own access tokens. Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }

  const publicBaseUrl = readUrl(source, 'PUBLIC_BASE_URL', 'http://localhost:8080');
  const supportEmail = readString(source, 'SUPPORT_EMAIL', '');

  if (nodeEnv === 'production' && repositoryDriver !== 'supabase') {
    throw new Error('NODE_ENV=production requires REPOSITORY_DRIVER=supabase');
  }
  const publicOrigin = publicBaseUrl === '' ? null : new URL(publicBaseUrl);
  if (
    nodeEnv === 'production' &&
    (publicOrigin === null ||
      publicOrigin.protocol !== 'https:' ||
      publicOrigin.hostname === 'localhost' ||
      publicOrigin.hostname === '127.0.0.1' ||
      publicOrigin.hostname === '[::1]')
  ) {
    throw new Error('NODE_ENV=production requires a public HTTPS PUBLIC_BASE_URL');
  }
  if (nodeEnv === 'production' && supportEmail === '') {
    throw new Error('NODE_ENV=production requires SUPPORT_EMAIL for public privacy and account-deletion requests');
  }
  if (nodeEnv === 'production' && humainApiKey === '') {
    throw new Error('NODE_ENV=production requires HUMAIN_API_KEY for real voice processing');
  }
  if (nodeEnv === 'production' && emailProvider !== 'resend') {
    throw new Error('NODE_ENV=production requires EMAIL_PROVIDER=resend for verified-email registration and recovery');
  }

  return {
    nodeEnv,
    port: readInt(source, 'PORT', 8080),
    publicBaseUrl,
    repositoryDriver,
    authDriver,
    voiceProvider,
    corsAllowedOrigins,
    humain: {
      // The origin is required for every provider call; absent config is a boot
      // failure only when a real provider call is attempted (see voice factory).
      apiUrl: readUrl(source, 'HUMAIN_API_URL', 'https://api.voice.humain.com'),
      apiKey: humainApiKey,
      apiPath: readString(source, 'HUMAIN_API_PATH', '/socket.io') || '/socket.io',
      timeoutMs: readInt(source, 'HUMAIN_TIMEOUT_MS', 20_000),
    },
    supabase: {
      url: supabaseUrl,
      serviceRoleKey: supabaseServiceRoleKey,
    },
    email: {
      provider: emailProvider,
      apiKey: resendApiKey,
      from: emailFrom,
    },
    localJwtSecret,
    limits: {
      maxAudioBytes: readInt(source, 'MAX_AUDIO_BYTES', 2 * 1024 * 1024),
      maxAudioDurationSeconds: readInt(source, 'MAX_AUDIO_DURATION_SECONDS', 15),
      maxTtsChars: readInt(source, 'MAX_TTS_CHARS', 300),
      freeDailySpeakingAttempts: readInt(source, 'FREE_DAILY_SPEAKING_ATTEMPTS', 10),
      freeDailyTtsRequests: readInt(source, 'FREE_DAILY_TTS_REQUESTS', 60),
      requestsPerMinutePerUser: readInt(source, 'RATE_LIMIT_PER_USER_PER_MINUTE', 60),
      requestsPerMinutePerIp: readInt(source, 'RATE_LIMIT_PER_IP_PER_MINUTE', 120),
    },
    trustProxyHops: readInt(source, 'TRUST_PROXY_HOPS', 0),
    usage: {
      dailyCreditBudget: readInt(source, 'DAILY_CREDIT_BUDGET', 2_000),
    },
    retention: {
      transcriptDays: readInt(source, 'RETENTION_TRANSCRIPT_DAYS', 90),
      evaluationDays: readInt(source, 'RETENTION_EVALUATION_DAYS', 90),
      usageEventMonths: readInt(source, 'RETENTION_USAGE_MONTHS', 24),
      consentMonthsAfterWithdrawal: readInt(source, 'RETENTION_CONSENT_MONTHS_AFTER_WITHDRAWAL', 36),
      profileGraceDays: readInt(source, 'RETENTION_PROFILE_GRACE_DAYS', 30),
    },
    legal: {
      appName: readString(source, 'APP_NAME', 'Saudi English Tutor'),
      // Optional on purpose: with no address the pages still render the in-app
      // path and simply omit the email fallback, rather than publishing an
      // invented or unmonitored mailbox.
      supportEmail,
      effectiveDate: readString(source, 'LEGAL_EFFECTIVE_DATE', '2026-11-23'),
    },
  };
}

/** Names and booleans only. Never values. */
export function safeSummary(env: ServerEnv): Record<string, unknown> {
  return {
    nodeEnv: env.nodeEnv,
    port: env.port,
    repositoryDriver: env.repositoryDriver,
    authDriver: env.authDriver,
    voiceProvider: env.voiceProvider,
    humain: {
      apiUrlPresent: env.humain.apiUrl !== '',
      apiKey: redact(env.humain.apiKey),
      apiPath: env.humain.apiPath,
    },
    supabase: { configured: env.supabase.url !== '' && env.supabase.serviceRoleKey !== '' },
    email: { provider: env.email.provider, apiKey: redact(env.email.apiKey), fromPresent: env.email.from !== '' },
    limits: env.limits,
    usage: env.usage,
  };
}

export function isVoiceConfigured(env: ServerEnv): boolean {
  return env.humain.apiKey !== '' && env.humain.apiUrl !== '';
}
