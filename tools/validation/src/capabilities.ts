/**
 * Step 2 — capability matrix.
 *
 * The rule this file obeys: an active key does NOT imply every capability is
 * enabled, and no capability is assumed from the spec. Each probe is chosen so
 * that it fails at validation, BEFORE any billing step:
 *
 *   batch STT   no file          -> 400 VALIDATION_INVALID_FORMAT (documented no-credit check)
 *   HTTP TTS    empty text       -> 400 VALIDATION_REQUIRED_FIELD (TTS limits are checked before any charge)
 *   Socket.IO   handshake only   -> connect / connect_error; the handshake itself is free
 *
 * What this step deliberately does NOT claim: that a model key such as
 * `bayan_cs_ar_en` is provisioned for this account. Model availability is only
 * reported as ASR_MODEL_NOT_FOUND once a real (credit-consuming) request is sent,
 * so step 2 marks it "unverified" rather than guessing.
 */
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { loadEnv, assertNoSecrets } from './env.ts';
import { probe } from './connectivity.ts';

type Verdict = 'enabled' | 'forbidden' | 'not-authorized' | 'unknown' | 'unreachable';

interface Capability {
  name: string;
  transport: string;
  probe: string;
  verdict: Verdict;
  evidence: string;
}

/** Socket.IO handshake. Free: it opens a connection and sends no media. */
async function probeSocket(env: { apiUrl: string; apiKey: string; apiPath: string }): Promise<{
  verdict: Verdict;
  evidence: string;
}> {
  return new Promise((resolvePromise) => {
    const socket = io(env.apiUrl, {
      path: env.apiPath,
      transports: ['websocket'],
      extraHeaders: {
        'x-api-key': env.apiKey,
        // The docs require Origin on the Socket.IO handshake.
        Origin: new URL(env.apiUrl).origin,
      },
      reconnection: false,
      timeout: 15_000,
    });

    let settled = false;
    const finish = (verdict: Verdict, evidence: string): void => {
      if (settled) return;
      settled = true;
      socket.close();
      resolvePromise({ verdict, evidence });
    };

    socket.once('connect', () => finish('enabled', `handshake ok, id=${socket.id ?? '(none)'}`));

    socket.once('connect_error', (error: Error) => {
      const text = String(error.message ?? error);
      // An invalid key fails the connection rather than returning 401.
      const verdict: Verdict = /403|forbidden/i.test(text)
        ? 'forbidden'
        : /401|unauthor/i.test(text)
          ? 'not-authorized'
          : 'unreachable';
      finish(verdict, `connect_error: ${text.slice(0, 200)}`);
    });

    // socket.on('error') carries the provider's structured error event.
    socket.on('error', (err: unknown) => {
      const text = JSON.stringify(err).slice(0, 200);
      finish('unknown', `error event: ${text}`);
    });

    setTimeout(() => finish('unreachable', 'handshake timed out after 15s'), 15_000);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const capabilities: Capability[] = [];

  // --- batch STT: documented no-file probe, with the multipart content-type ----
  // Content-type matters: a bare 403 from this route is a GATEWAY rejection
  // ("check the URL, route and headers"), not a missing capability.
  const batch = await probe(
    'batch STT',
    '/v1/transcribe/codeswitch',
    env,
    { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=----humain-probe' }, body: '------humain-probe--' },
    { 400: 'ok', 401: 'unauthorized', 403: 'forbidden', 422: 'ok' },
  );
  capabilities.push({
    name: 'Batch STT (HTTP POST /v1/transcribe/{lang})',
    transport: 'multipart/form-data, one audio part',
    probe: 'declared multipart body, no file (0 credits)',
    verdict: batch.verdict === 'ok' ? 'enabled' : batch.verdict === 'forbidden' ? 'forbidden' : batch.verdict === 'unauthorized' ? 'not-authorized' : 'unknown',
    evidence: `status=${batch.status} code=${batch.code ?? '(none)'}${batch.code === 'VALIDATION_FILE_CORRUPT' ? ' (key accepted, file missing)' : ''}`,
  });

  // --- HTTP buffered TTS: empty text fails validation before any charge -------
  const tts = await probe(
    'HTTP TTS',
    '/v1/audio/speech',
    env,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nebula', input: '', voice: 'not-a-real-voice-id' }),
    },
    { 400: 'ok', 401: 'unauthorized', 403: 'forbidden', 404: 'unknown', 422: 'ok' },
  );
  capabilities.push({
    name: 'Buffered text-to-speech (HTTP)',
    transport: 'HTTP POST /v1/audio/speech',
    probe: 'empty input (limits are checked before any charge)',
    verdict:
      tts.verdict === 'ok' ? 'enabled' : tts.verdict === 'forbidden' ? 'forbidden' : tts.verdict === 'unauthorized' ? 'not-authorized' : 'unknown',
    evidence: `status=${tts.status} code=${tts.code ?? '(none)'}`,
  });

  // --- HTTP short-clip STT: no file -> validation error before any charge ------
  // Also needs the multipart content-type, for the same gateway reason. `id` is a
  // REQUIRED query parameter on this route (a fresh UUID per request), so the
  // probe sends one: without it the gateway answers a bare 403, which would read
  // as a missing capability when it is really an incomplete probe.
  const httpStt = await probe(
    'HTTP short-clip STT',
    `/v1/realtime/http/stt?id=${randomUUID()}`,
    env,
    { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=----humain-probe' }, body: '------humain-probe--' },
    {
      400: 'ok',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'unknown',
      422: 'ok',
    },
  );
  capabilities.push({
    name: 'Short-clip STT (HTTP, realtime/http/stt)',
    transport: 'HTTP POST /v1/realtime/http/stt',
    probe: 'no file sent (fails at validation, no job, no charge)',
    verdict:
      httpStt.verdict === 'ok' ? 'enabled' : httpStt.verdict === 'forbidden' ? 'forbidden' : httpStt.verdict === 'unauthorized' ? 'not-authorized' : 'unknown',
    evidence: `status=${httpStt.status} code=${httpStt.code ?? '(none)'}`,
  });

  // --- Socket.IO: handshake only, no media ------------------------------------
  const socket = await probeSocket(env);
  capabilities.push({
    name: 'Socket.IO transport (voice list, fast STT, streaming TTS)',
    transport: `WebSocket ${env.apiPath}`,
    probe: 'handshake only, no media sent',
    verdict: socket.verdict,
    evidence: socket.evidence,
  });

  // --- capabilities that cannot be proven without spending credits -----------
  capabilities.push({
    name: 'Fast speech-to-text (Socket.IO audio_file)',
    transport: 'Socket.IO audio_file',
    probe: 'NOT PROBED - any real upload is billed',
    verdict: 'unknown',
    evidence: 'requires a credit-consuming upload; awaiting owner approval',
  });
  capabilities.push({
    name: 'ASR model keys (bayan_cs_ar_en, bayan_ar, ...)',
    transport: 'batch/fast asr parameter',
    probe: 'NOT PROBED - unknown keys only report ASR_MODEL_NOT_FOUND on a real request',
    verdict: 'unknown',
    evidence: 'model provisioning per key cannot be read without a billed call',
  });
  capabilities.push({
    name: 'Voice Agent',
    transport: 'HTTP /agent/sessions',
    probe: 'NOT PROBED - needs the opt-in agent scope and is out of MVP scope',
    verdict: 'unknown',
    evidence: 'excluded from the MVP by build (1).md',
  });

  const pad = (s: string, n: number): string => s.padEnd(n);
  const lines = ['Step 2 — capability matrix (no paid calls)', ''];
  lines.push(`${pad('capability', 52)} ${pad('verdict', 14)} evidence`);
  lines.push(`${'-'.repeat(52)} ${'-'.repeat(14)} ${'-'.repeat(30)}`);
  for (const c of capabilities) {
    lines.push(`${pad(c.name, 52)} ${pad(c.verdict, 14)} ${c.evidence}`);
  }
  lines.push('');
  lines.push('Note: "enabled" means the route answered and the key was accepted by the');
  lines.push('validation layer. It does NOT prove a specific ASR model is provisioned.');

  const output = lines.join('\n');
  assertNoSecrets(output, { apiKey: env.apiKey, apiUrl: env.apiUrl });
  console.log(output);
}

main().catch((error: unknown) => {
  console.error('capabilities failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
