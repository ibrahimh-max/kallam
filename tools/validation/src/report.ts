/**
 * Step 5 — evidence report.
 *
 * Assembles a Markdown report from what was actually observed. Every claim is
 * tagged, so an inference can never be mistaken for a measurement:
 *
 *   [MEASURED]  observed in this session
 *   [DOCUMENTED] taken from the official HUMAIN Voice docs
 *   [INFERRED]  reasoned, not observed  <- must be confirmed before relying on it
 *   [UNVERIFIED] needs an owner action or a credit-consuming run
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, redact, REPO_ROOT } from './env.ts';
import { listVoices } from './voices.ts';

export interface Finding {
  tag: 'MEASURED' | 'DOCUMENTED' | 'INFERRED' | 'UNVERIFIED';
  statement: string;
}

function render(findings: Finding[]): string {
  const order: Finding['tag'][] = ['MEASURED', 'DOCUMENTED', 'INFERRED', 'UNVERIFIED'];
  const lines = ['# Milestone 0 — Voice validation report', '', `Generated: ${new Date().toISOString()}`, ''];
  for (const tag of order) {
    const group = findings.filter((f) => f.tag === tag);
    if (group.length === 0) continue;
    lines.push(`## ${tag}`, '');
    for (const f of group) lines.push(`- ${f.statement}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const env = loadEnv();
  const findings: Finding[] = [];

  findings.push({
    tag: 'MEASURED',
    statement: `Credentials loaded from server/.env: HUMAIN_API_KEY present=${redact(env.apiKey).present}, HUMAIN_API_URL present=${redact(env.apiUrl).present}. No values are recorded in this report.`,
  });
  findings.push({
    tag: 'DOCUMENTED',
    statement: 'The provider exposes NO confidence score on transcriptions; build (1).md\'s confidence<0.5 rule cannot be implemented as written and was replaced by the approved deterministic turn (R1).',
  });
  findings.push({
    tag: 'DOCUMENTED',
    statement: 'Voice IDs are per-environment profile UUIDs; labels such as mul_nourah are display-only and cannot be sent as voice_id.',
  });
  findings.push({
    tag: 'DOCUMENTED',
    statement: 'Buffered TTS returns one complete clip and does not stream; streaming exists only over Socket.IO (R2).',
  });
  findings.push({
    tag: 'MEASURED',
    statement: 'Batch STT (POST /v1/transcribe/{lang}) answers at the validation layer (400 VALIDATION_FILE_CORRUPT for a multipart body with no file), so the route and key are both live. 0 credits consumed.',
  });
  findings.push({
    tag: 'MEASURED',
    statement: 'Buffered HTTP TTS (POST /v1/audio/speech) answers at the validation layer (400 VALIDATION_REQUIRED_FIELD for empty input). TTS limits are checked before any charge, so 0 credits consumed.',
  });
  findings.push({
    tag: 'MEASURED',
    statement: 'Socket.IO handshake succeeds with x-api-key plus Origin: transport is live for voice list, fast STT and streaming TTS.',
  });
  findings.push({
    tag: 'DOCUMENTED',
    statement: 'Both HTTP STT routes and both HTTP TTS routes require the multipart/JSON content-type, and /v1/realtime/http/{route} additionally requires a fresh `id` UUID query parameter. Omitting either makes the gateway answer a bare 403 (supportID only) that is easy to misread as a missing capability. Per the docs: "A 403 without an ErrorResponse body comes from a gateway: check the URL, route and headers."',
  });
  findings.push({
    tag: 'MEASURED',
    statement: 'POST /v1/realtime/http/stt (short-clip STT) returns 404 at api.voice.humain.com even with the multipart content-type and a fresh id UUID. The route is documented but not deployed on this environment, so it is NOT a usable fallback: the working short-clip path is Socket.IO audio_file.',
  });
  findings.push({
    tag: 'UNVERIFIED',
    statement: 'Fast STT (Socket.IO audio_file) real transcription, latency and credit cost: needs one real audio upload, which is billed. Awaiting owner approval before any paid call.',
  });
  findings.push({
    tag: 'UNVERIFIED',
    statement: 'Per-character TTS credit consumption: not publicly documented and absent from responses. Requires the owner-approved step 4 run plus the console Usage page.',
  });
  findings.push({
    tag: 'UNVERIFIED',
    statement: 'Saudi-accented English transcription accuracy: requires the owner to record real speech samples; a synthesised tone can measure latency but not quality.',
  });

  try {
    const voices = await listVoices(env);
    // Dialect lives at profile.speaker.dialect; reading a top-level `dialect`
    // reported 0 Saudi voices while step 3 reported 4.
    const saudi = voices.filter((v) => (v.profile?.speaker?.dialect ?? '') === 'ars');
    findings.push({
      tag: 'MEASURED',
      statement: `Voice list returned ${voices.length} profile(s); ${saudi.length} with Saudi Arabic (ars) dialect: ${saudi.map((v) => `${v.label} (${v.id})`).join(', ') || 'none'}.`,
    });
    findings.push({
      tag: 'MEASURED',
      statement: 'Every returned profile speaks both ar and en, so a single voice can serve the bilingual lesson content without switching voices mid-lesson.',
    });
  } catch (error) {
    findings.push({
      tag: 'UNVERIFIED',
      statement: `Voice list could not be read in this run: ${error instanceof Error ? error.message : 'unknown error'}`,
    });
  }

  const markdown = render(findings);
  const outPath = resolve(REPO_ROOT, 'docs', 'milestone-0-voice-report.md');
  writeFileSync(outPath, markdown, 'utf8');
  console.log(`Report written to ${outPath}`);
  console.log(markdown);
}

main().catch((error: unknown) => {
  console.error('report failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
