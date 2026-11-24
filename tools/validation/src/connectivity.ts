/**
 * Step 1 — connectivity.
 *
 * Uses the provider's own documented no-file probe. Sending no file creates no
 * job, so this step can never consume credits.
 *
 *   POST /v1/transcribe/codeswitch   with x-api-key and no file
 *     400 VALIDATION_INVALID_FORMAT -> the key works (the 400 is expected)
 *     401 AUTH_UNAUTHORIZED         -> key missing/invalid/wrong environment
 *     403 AUTH_FORBIDDEN            -> key lacks batch access
 */
import { loadEnv, redact, assertNoSecrets } from './env.ts';

export interface ProbeResult {
  label: string;
  url: string;
  status: number;
  code: string | null;
  retryable: boolean | null;
  verdict: 'ok' | 'unauthorized' | 'forbidden' | 'unexpected' | 'network-error';
  detail: string;
}

/** Read `code` and `retryable` out of an ErrorResponse without trusting the shape. */
export function readError(body: string): { code: string | null; retryable: boolean | null } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const code = typeof parsed.code === 'string' ? parsed.code : null;
    const retryable = typeof parsed.retryable === 'boolean' ? parsed.retryable : null;
    return { code, retryable };
  } catch {
    return { code: null, retryable: null };
  }
}

export async function probe(
  label: string,
  path: string,
  env: { apiKey: string; apiUrl: string },
  init: RequestInit = {},
  verdicts: Record<number, ProbeResult['verdict']> = {},
): Promise<ProbeResult> {
  const url = `${env.apiUrl}${path}`;
  const headers = new Headers(init.headers);
  headers.set('x-api-key', env.apiKey);

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return {
      label,
      url,
      status: 0,
      code: null,
      retryable: null,
      verdict: 'network-error',
      detail: error instanceof Error ? error.message : 'unknown network failure',
    };
  }

  const body = await response.text();
  const { code, retryable } = readError(body);
  const verdict =
    verdicts[response.status] ?? (response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'unexpected');

  return {
    label,
    url,
    status: response.status,
    code,
    retryable,
    verdict,
    detail: body.length > 300 ? `${body.slice(0, 300)}...` : body,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();

  const key = redact(env.apiKey);
  const url = redact(env.apiUrl);

  const lines = [
    'HUMAIN credential detection (values are never printed)',
    `  HUMAIN_API_KEY : present=${key.present} length=${key.length} sha256[0:12]=${key.fingerprint}`,
    `  HUMAIN_API_URL : present=${url.present} length=${url.length} sha256[0:12]=${url.fingerprint}`,
    `  origin         : ${new URL(env.apiUrl).protocol}//${new URL(env.apiUrl).host}   (scheme+host only)`,
    `  api_path       : ${env.apiPath}`,
    `  api_version    : ${env.apiVersion}`,
    '',
    'Step 1 — is the key accepted by this environment? (all probes are validation-layer, 0 credits)',
  ];

  // Probe A: the docs' own no-file check. A 400 VALIDATION_* means the key works.
  // The multipart content-type is required: without it the gateway answers a bare
  // 403 (documented as "check the URL, route and headers"), which reads as a
  // capability failure when it is really a malformed probe.
  const batch = await probe(
    'batch no-file probe',
    `/v1/transcribe/codeswitch`,
    env,
    { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=----humain-probe' }, body: '------humain-probe--' },
    {
      400: 'ok',
      401: 'unauthorized',
      403: 'forbidden',
    },
  );

  // Probe B: a REST route that is definitely not batch. Used to separate "bad key"
  // from "key is fine but batch is not permitted for this account".
  const tts = await probe(
    'buffered TTS validation probe',
    '/v1/audio/speech',
    env,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nebula', input: '', voice: 'unused' }) },
    { 400: 'ok', 401: 'unauthorized', 403: 'forbidden' },
  );

  lines.push(`  A) POST ${new URL(env.apiUrl).origin}/v1/transcribe/codeswitch   (no file)`);
  lines.push(`     status=${batch.status} code=${batch.code ?? '(none)'} verdict=${batch.verdict}`);
  lines.push(`     body=${batch.detail}`);
  lines.push(`  B) POST ${new URL(env.apiUrl).origin}/v1/audio/speech            (empty input)`);
  lines.push(`     status=${tts.status} code=${tts.code ?? '(none)'} verdict=${tts.verdict}`);
  lines.push(`     body=${tts.detail}`);
  lines.push('');

  const keyValid = batch.verdict === 'ok' || tts.verdict === 'ok';
  lines.push(`  KEY VERDICT: ${keyValid ? 'ACCEPTED (a REST route answered at the validation layer)' : 'NOT PROVEN'}`);

  if (batch.verdict === 'forbidden' && tts.verdict === 'ok') {
    lines.push('  NOTE: the key is valid, but the BATCH route returned 403 with no ErrorResponse body.');
    lines.push('  Per the docs that is a gateway rejection rather than a scope error. Batch is the');
    lines.push('  long-recording route; the short-clip route we actually need is probed in step 2.');
  }
  if (batch.verdict === 'unauthorized' || tts.verdict === 'unauthorized') {
    lines.push('  => 401: key missing, invalid, revoked, expired, or issued by a DIFFERENT environment.');
  }

  const output = lines.join('\n');
  assertNoSecrets(output, { apiKey: env.apiKey, apiUrl: env.apiUrl });
  console.log(output);

  if (!keyValid) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('connectivity.ts')) {
  main().catch((error: unknown) => {
    console.error('connectivity failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
