/**
 * Zero-credit acceptance check for Milestone 0 steps 1-3.
 *
 * Runs the three validation steps as child processes and asserts the verdicts
 * that matter. It consumes no credits: every probe is rejected at the provider's
 * validation layer before any billed work starts.
 *
 * Emits one harnessVerification JSON line so the result is machine-checkable.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The nine deliverables named in the Milestone 0 acceptance criteria. Asserted here
 * rather than trusted, so a file that gets moved or renamed fails the check instead
 * of quietly disappearing from the milestone.
 */
const MILESTONE_0_FILES = [
  'tools/validation/README.md',
  'tools/validation/src/env.ts',
  'tools/validation/src/connectivity.ts',
  'tools/validation/src/capabilities.ts',
  'tools/validation/src/voices.ts',
  'tools/validation/src/measure.ts',
  'tools/validation/src/report.ts',
  'server/src/services/voice/VoiceProvider.ts',
  'server/src/services/voice/HumainVoiceProvider.ts',
];

function run(script) {
  const result = spawnSync(process.execPath, [resolve(ROOT, script)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const step1 = run('tools/validation/src/connectivity.ts');
const step2 = run('tools/validation/src/capabilities.ts');
const step3 = run('tools/validation/src/voices.ts');

const missingFiles = MILESTONE_0_FILES.filter((relative) => !existsSync(resolve(ROOT, relative)));

const checks = [
  {
    name: 'all nine Milestone 0 deliverables exist',
    actual: missingFiles.length,
    expected: 0,
  },
  {
    name: 'step1 exits 0 (key accepted by the environment)',
    actual: step1.code,
    expected: 0,
  },
  {
    name: 'step1 batch probe reaches the validation layer (VALIDATION_FILE_CORRUPT, not 403)',
    actual: /VALIDATION_FILE_CORRUPT/.test(step1.out) ? 1 : 0,
    expected: 1,
  },
  {
    name: 'step1 never prints the API key value',
    actual: /HUMAIN_API_KEY : present=true/.test(step1.out) && /sk-voice/.test(step1.out) ? 1 : 0,
    expected: 0,
  },
  {
    name: 'step1 never prints a raw https URL containing a credential',
    actual: /@/.test(step1.out) ? 1 : 0,
    expected: 0,
  },
  {
    name: 'step2 batch STT verdict is enabled',
    actual: /Batch STT .*enabled/.test(step2.out) ? 1 : 0,
    expected: 1,
  },
  {
    name: 'step2 buffered TTS verdict is enabled',
    actual: /Buffered text-to-speech \(HTTP\)\s+enabled/.test(step2.out) ? 1 : 0,
    expected: 1,
  },
  {
    name: 'step2 Socket.IO transport verdict is enabled',
    actual: /Socket.IO transport .*enabled/.test(step2.out) ? 1 : 0,
    expected: 1,
  },
  {
    name: 'step2 fast STT is reported unknown, not assumed enabled',
    actual: /Fast speech-to-text \(Socket.IO audio_file\)\s+unknown/.test(step2.out) ? 1 : 0,
    expected: 1,
  },
  {
    name: 'step3 exits 0 (voice list readable without credentials being printed)',
    actual: step3.code,
    expected: 0,
  },
  {
    name: 'step3 returns at least 2 Saudi Arabic (ars) voices',
    actual: Number((step3.out.match(/(\d+) with Saudi Arabic dialect/) ?? [])[1] ?? 0) >= 2 ? 1 : 0,
    expected: 1,
  },
  {
    name: 'step3 resolves a real UUID for mul_nourah (not the friendly label)',
    actual: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s+mul_nourah/.test(step3.out) ? 1 : 0,
    expected: 1,
  },
];

console.log(JSON.stringify({ harnessVerification: { version: 1, checks } }));

for (const c of checks) {
  if (c.actual !== c.expected) {
    console.error(`FAIL ${c.name}: actual=${c.actual} expected=${c.expected}`);
    process.exitCode = 1;
  }
}
