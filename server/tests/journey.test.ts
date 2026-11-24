/**
 * Durable regression gate for the full learner journey.
 *
 * `tests/e2e-journey.mjs` asserts the 70 outcomes a learner actually sees, but it
 * needs a server someone started by hand. A check nobody runs on every commit is a
 * check that rots, so this test boots the real server binary as a child process and
 * drives the same journey against it.
 *
 * Two deliberate choices:
 *   - `VOICE_PROVIDER=mock` is forced, so this test can never spend provider credits
 *     even though a real HUMAIN key sits in `server/.env`. Without this the factory
 *     would pick the real provider and the test would bill the owner.
 *   - the port is allocated by the OS before the child starts, so the test cannot
 *     collide with a developer's own running server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Ask the OS for a free port, then release it so the child can bind it. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl: string, deadlineMs = 20_000): Promise<void> {
  const started = Date.now();
  let lastError = 'no attempt made';
  while (Date.now() - started < deadlineMs) {
    try {
      // Any HTTP answer proves the listener is up; the exact status is irrelevant.
      await fetch(`${baseUrl}/v1/lessons`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`server did not become reachable in ${deadlineMs} ms: ${lastError}`);
}

function runJourney(baseUrl: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['tests/e2e-journey.mjs'], {
      cwd: serverDir,
      env: { ...process.env, E2E_BASE_URL: baseUrl, VOICE_PROVIDER: 'mock' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('the whole learner journey works end to end against a real server process', async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['src/server.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      VOICE_PROVIDER: 'mock',
      EMAIL_PROVIDER: 'mock',
      REPOSITORY_DRIVER: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
  server.stderr.on('data', (chunk) => { serverLog += String(chunk); });

  // Always tear the child down, even when an assertion below throws: a leaked server
  // would hold the port and make the next run fail for an unrelated reason.
  t.after(() => { server.kill(); });

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    server.kill();
    assert.fail(`server never started.\nlog:\n${serverLog}\n\n${(error as Error).message}`);
  }

  const result = await runJourney(baseUrl);
  server.kill();

  assert.equal(
    result.code,
    0,
    `journey failed (exit ${result.code})\n--- server ---\n${serverLog}\n--- journey ---\n${result.stdout}\n${result.stderr}`,
  );

  const summary = /=== (\d+) checks passed, (\d+) failed ===/.exec(result.stdout);
  assert.ok(summary, `journey printed no summary line:\n${result.stdout}`);
  const [, passed, failed] = summary as unknown as [string, string, string];
  assert.equal(failed, '0', `journey reported failures:\n${result.stdout}`);
  assert.ok(Number(passed) >= 70, `expected at least 70 journey checks, saw ${passed}`);
});
