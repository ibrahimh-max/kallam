/**
 * Step 4 — credit-consuming measurements. GATED.
 *
 * This file DOES spend credits. It refuses to run without BOTH:
 *   --approve            explicit owner approval in this invocation, and
 *   --confirm-credits=N  the owner's stated ceiling for this run
 *
 * Guardrails enforced before the first request:
 *   - estimated worst-case cost must be <= VALIDATION_MAX_CREDITS
 *   - the owner's stated ceiling must be <= VALIDATION_MAX_CREDITS
 *   - refuses entirely when VALIDATION_MIN_CREDITS_REMAINING exceeds the free tier
 *
 * Cost note: HUMAIN does not document per-character TTS pricing and the response
 * carries no `credits_consumed` field, so consumption is ESTIMATED here and must
 * be reconciled against the console Usage page afterwards.
 */
import { loadEnv, assertNoSecrets } from './env.ts';
import { HumainVoiceProvider } from '../../../server/src/services/voice/HumainVoiceProvider.ts';

interface Plan {
  label: string;
  kind: 'tts' | 'stt';
  sampleRateHz: number;
  bitsPerSample: number;
  channels: number;
  estimatedCredits: number;
}

/**
 * A synthesised 440 Hz tone, PCM16 mono. Used because the provider has no
 * "silence" fast path: a valid, short clip is the smallest honest STT probe.
 */
export function tone(seconds: number, sampleRateHz: number): Uint8Array {
  const samples = Math.floor(seconds * sampleRateHz);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRateHz) * 8000);
    buffer.writeInt16LE(value, i * 2);
  }
  return new Uint8Array(buffer);
}

/** Wrap raw PCM16 mono in a minimal WAV container so the provider can decode it. */
export function wav(pcm: Uint8Array, sampleRateHz: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRateHz * channels * bitsPerSample) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

/**
 * The proposed run. Chosen to be the smallest set that answers the open
 * questions, NOT a batch: 2 TTS clips and 1 short STT clip.
 */
export const PROPOSED_PLAN: Plan[] = [
  { label: 'TTS: short Saudi Arabic greeting (~40 chars)', kind: 'tts', sampleRateHz: 24_000, bitsPerSample: 16, channels: 1, estimatedCredits: 1 },
  { label: 'TTS: one English lesson sentence (~60 chars)', kind: 'tts', sampleRateHz: 24_000, bitsPerSample: 16, channels: 1, estimatedCredits: 1 },
  { label: 'STT: 2 s synthesised tone (capability + latency only, not quality)', kind: 'stt', sampleRateHz: 16_000, bitsPerSample: 16, channels: 1, estimatedCredits: 2 },
];

export function estimateCredits(plan: Plan[]): number {
  return plan.reduce((total, p) => total + p.estimatedCredits, 0);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const argv = process.argv.slice(2);
  const approved = argv.includes('--approve');
  const ceilingArg = argv.find((a) => a.startsWith('--confirm-credits='));
  const ceiling = ceilingArg ? Number.parseInt(ceilingArg.split('=')[1] ?? '', 10) : Number.NaN;
  const estimate = estimateCredits(PROPOSED_PLAN);

  const header = [
    'Step 4 — measurement plan (SPENDS CREDITS)',
    '',
  ];
  const pad = (s: string, n: number): string => s.padEnd(n);
  header.push(`${pad('measurement', 58)} kind  est. credits`);
  header.push(`${'-'.repeat(58)} ${'-'.repeat(4)}  ${'-'.repeat(12)}`);
  for (const p of PROPOSED_PLAN) header.push(`${pad(p.label, 58)} ${pad(p.kind, 4)}  ${p.estimatedCredits}`);
  header.push('');
  header.push(`  estimated total      : ${estimate} credits`);
  header.push(`  VALIDATION_MAX_CREDITS: ${env.maxCredits}`);
  header.push(`  your stated ceiling  : ${Number.isFinite(ceiling) ? `${ceiling} credits` : '(not given)'}`);
  header.push('');
  header.push('  Cost basis: HUMAIN does not document per-character TTS pricing and returns no');
  header.push('  credits_consumed field, so these are ESTIMATES to be reconciled against the');
  header.push('  console Usage page afterwards. STT is billed per audio second.');
  header.push('');
  console.log(header.join('\n'));

  // ---- guardrails -----------------------------------------------------------
  if (!approved || !Number.isFinite(ceiling)) {
    console.log('REFUSING TO RUN: this step spends credits and needs explicit approval.');
    console.log('  Re-run with:  node tools/validation/src/measure.ts --approve --confirm-credits=<N>');
    console.log('  Nothing was sent. No credits were consumed.');
    return;
  }
  if (ceiling > env.maxCredits) {
    console.log(`REFUSING TO RUN: ceiling ${ceiling} exceeds VALIDATION_MAX_CREDITS ${env.maxCredits}.`);
    return;
  }
  if (estimate > ceiling) {
    console.log(`REFUSING TO RUN: estimated ${estimate} credits exceeds your ceiling of ${ceiling}.`);
    return;
  }

  // ---- run ------------------------------------------------------------------
  const provider = new HumainVoiceProvider({
    apiUrl: env.apiUrl,
    apiKey: env.apiKey,
    apiPath: env.apiPath,
  });

  const voices = await provider.listVoices();
  const saudi = voices.find((v) => v.dialect === 'ars');
  if (!saudi) {
    console.log('REFUSING TO RUN: no Saudi Arabic (ars) voice available to synthesise with.');
    return;
  }

  const results: string[] = [`Running with voice ${saudi.label} (${saudi.id}).`, ''];
  let spent = 0;

  for (const step of PROPOSED_PLAN) {
    try {
      if (step.kind === 'tts') {
        const text = step.label.includes('Arabic') ? 'مرحبا، كيف حالك اليوم؟' : 'Hello, how are you today?';
        const out = await provider.synthesize({ text, voiceId: saudi.id });
        spent += step.estimatedCredits;
        results.push(`  TTS ok  ${out.pcm.byteLength} bytes PCM, ${out.latencyMs} ms, id=${out.requestId}`);
      } else {
        const audio = wav(tone(2, step.sampleRateHz), step.sampleRateHz);
        const out = await provider.transcribe({ audio, language: 'codeswitch', container: 'wav' });
        spent += step.estimatedCredits;
        results.push(`  STT ok  ${out.latencyMs} ms, text=${JSON.stringify(out.text)}, id=${out.requestId}`);
      }
    } catch (error) {
      const e = error as Error & { code?: string };
      results.push(`  FAILED  ${step.label}: code=${e.code ?? '(none)'} message=${e.message}`);
    }
    results.push(`  running estimated spend: ${spent} credits`);
  }

  results.push('');
  results.push(`  ESTIMATED credits consumed: ${spent} (of 5000 free). Reconcile on the console Usage page.`);
  const output = results.join('\n');
  assertNoSecrets(output, { apiKey: env.apiKey, apiUrl: env.apiUrl });
  console.log(output);
}

// Only auto-run when invoked directly; importing this file must not spend credits.
if (process.argv[1]?.endsWith('measure.ts')) {
  main().catch((error: unknown) => {
    console.error('measure failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
