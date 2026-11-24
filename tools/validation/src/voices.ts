/**
 * Step 3 — resolve the account's real voice IDs.
 *
 * build (1).md lists `mul_nourah`, `mul_abdullah`, `mul_sara`, `mul_abdulaziz`.
 * Those are LABELS, not sendable IDs: the wire value is a profile UUID that
 * differs per environment, and there is no HTTP voice-list route, so the list is
 * only reachable over Socket.IO (`tts_voice_list` -> `tts_voice_list_result`).
 *
 * Free: listing voices costs nothing and neither does the handshake.
 */
import { io } from 'socket.io-client';
import { loadEnv, assertNoSecrets } from './env.ts';

interface VoiceProfile {
  id: string;
  label: string;
  profile?: {
    speaker?: { gender?: string; dialect?: string };
    languages?: string[];
    emotions?: string[];
    styles?: string[];
  };
}

/** The Saudi Arabic dialect tag from the docs. */
const SAUDI = 'ars';

export async function listVoices(env: {
  apiUrl: string;
  apiKey: string;
  apiPath: string;
}): Promise<VoiceProfile[]> {
  return new Promise((resolvePromise, reject) => {
    const socket = io(env.apiUrl, {
      path: env.apiPath,
      transports: ['websocket'],
      extraHeaders: { 'x-api-key': env.apiKey, Origin: new URL(env.apiUrl).origin },
      reconnection: false,
      timeout: 15_000,
    });

    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.close();
      fn();
    };

    socket.once('connect_error', (error: Error) =>
      done(() => reject(new Error(`Socket.IO connect_error: ${error.message}`))),
    );

    // A failed lookup emits TTS_VOICE_LIST_FAILED with no id, so bound the wait.
    socket.once('error', (err: unknown) => done(() => reject(new Error(`error event: ${JSON.stringify(err).slice(0, 200)}`))));

    socket.once('tts_voice_list_result', (voices: VoiceProfile[]) =>
      done(() => resolvePromise(Array.isArray(voices) ? voices : [])),
    );

    socket.once('connect', () => socket.emit('tts_voice_list', {}));

    setTimeout(() => done(() => reject(new Error('tts_voice_list_result timed out after 15s'))), 15_000);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const voices = await listVoices(env);

  const lines = ['Step 3 — voice list (Socket.IO tts_voice_list; 0 credits)', ''];

  if (voices.length === 0) {
    // The docs are explicit: an empty list is a valid answer. Never guess an ID.
    lines.push('  The provider returned an EMPTY list. That is a valid result.');
    lines.push('  Do NOT fall back to a label or a hard-coded UUID.');
    console.log(lines.join('\n'));
    return;
  }

  const saudi = voices.filter((v) => (v.profile?.speaker?.dialect ?? '') === SAUDI);
  const bilingual = voices.filter((v) => (v.profile?.languages ?? []).includes('ar') && (v.profile?.languages ?? []).includes('en'));

  lines.push(`  ${voices.length} voice profile(s) returned.`);
  lines.push(`  ${saudi.length} with Saudi Arabic dialect (${SAUDI}).`);
  lines.push(`  ${bilingual.length} that speak both ar and en.`);
  lines.push('');
  lines.push(`  ${'id'.padEnd(38)} ${'label'.padEnd(16)} ${'dialect'.padEnd(8)} languages`);
  lines.push(`  ${'-'.repeat(38)} ${'-'.repeat(16)} ${'-'.repeat(8)} ${'-'.repeat(20)}`);

  for (const v of voices) {
    const dialect = v.profile?.speaker?.dialect ?? '';
    const languages = (v.profile?.languages ?? []).join(',');
    const marker = dialect === SAUDI ? ' *SAUDI*' : '';
    lines.push(`  ${v.id.padEnd(38)} ${v.label.padEnd(16)} ${dialect.padEnd(8)} ${languages}${marker}`);
  }

  lines.push('');
  if (saudi.length >= 2) {
    lines.push(`  Exit criterion ">= 2 Saudi Arabic voices confirmed available" is met on paper:`);
    lines.push(`  ${saudi.map((v) => v.label).join(', ')}`);
  } else if (saudi.length === 1) {
    lines.push('  Only ONE Saudi Arabic voice is available to this account.');
  } else {
    lines.push('  WARNING: no Saudi Arabic (ars) voice found. build (1).md requires Saudi voices.');
  }
  lines.push('  Voices still need native Saudi listeners and commercial-use confirmation.');

  const output = lines.join('\n');
  assertNoSecrets(output, { apiKey: env.apiKey, apiUrl: env.apiUrl });
  console.log(output);
}

main().catch((error: unknown) => {
  console.error('voices failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
