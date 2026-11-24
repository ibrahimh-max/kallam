/**
 * Loads `server/.env` into `process.env` at boot.
 *
 * Why this exists: `loadEnv()` reads the process environment, and without this
 * module the file is never read at all — so a correctly filled `.env` still
 * produced a boot failure, and the operator's HUMAIN credentials were invisible
 * to the server.
 *
 * Rules, deliberately matching the rest of `config/`:
 *  - No dependency. The parser is ~20 lines and the alternative is a package for
 *    a format that has no ambiguity we care about.
 *  - The real environment always wins. A value already present in `process.env`
 *    is never overwritten, so a container or CI variable cannot be silently
 *    replaced by a stale file on disk.
 *  - Values are never logged or returned in a printable form. `safeSummary()`
 *    remains the only thing that describes config, and it prints names and
 *    booleans only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/config -> server/ */
export const DEFAULT_ENV_PATH = resolve(HERE, '..', '..', '.env');

/**
 * Minimal `KEY=value` parser: `#` comments, blank lines, one layer of matching
 * quotes, and everything after the first `=` as the value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface LoadEnvFileResult {
  path: string;
  found: boolean;
  /** Names only — never values. */
  applied: string[];
  skippedExisting: string[];
}

/**
 * Apply a `.env` file to `process.env`. Returns names, never values, so the
 * result is safe to log.
 */
export function applyEnvFile(
  path: string = DEFAULT_ENV_PATH,
  target: NodeJS.ProcessEnv = process.env,
): LoadEnvFileResult {
  if (!existsSync(path)) return { path, found: false, applied: [], skippedExisting: [] };

  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  const applied: string[] = [];
  const skippedExisting: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    const current = target[key];
    if (typeof current === 'string' && current !== '') {
      skippedExisting.push(key);
      continue;
    }
    target[key] = value;
    applied.push(key);
  }

  return { path, found: true, applied, skippedExisting };
}
