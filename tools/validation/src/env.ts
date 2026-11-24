/**
 * Loads and validates the HUMAIN credentials from `server/.env`.
 *
 * Two hard rules this module exists to enforce:
 *   1. A secret value is never returned in a printable form. Any value that
 *      leaves this module carries only a length and a short hash, which proves
 *      "we read it" without disclosing it.
 *   2. Nothing here reaches the Flutter app. This runs on the operator's machine
 *      and, later, on the backend server only.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** tools/validation/src -> repo root */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const ENV_PATH = resolve(REPO_ROOT, 'server', '.env');

export interface ValidationEnv {
  apiKey: string;
  apiUrl: string;
  apiPath: string;
  apiVersion: string;
  maxCredits: number;
  minCreditsRemaining: number;
}

/** Minimal KEY=value parser. Deliberately not a dependency. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, as dotenv does.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') out[key] = value;
  }
  return out;
}

/** A value we are allowed to show: proves presence, discloses nothing. */
export interface Redacted {
  present: boolean;
  length: number;
  fingerprint: string;
}

export function redact(value: string): Redacted {
  return {
    present: value.length > 0,
    length: value.length,
    fingerprint: value.length === 0 ? '' : createHash('sha256').update(value).digest('hex').slice(0, 12),
  };
}

/**
 * Guard against accidental disclosure. Call before printing anything that was
 * built from environment values. Throws rather than logging a secret.
 *
 * The key is always a secret. The API origin is only treated as sensitive when
 * it carries something beyond the bare origin (credentials, a path, a query) —
 * a documented public origin such as https://api.voice.humain.com is not a
 * secret, and printing it is essential for diagnosing routing errors.
 */
export function assertNoSecrets(text: string, env: { apiKey: string; apiUrl: string }): void {
  if (env.apiKey.length >= 8 && text.includes(env.apiKey)) {
    throw new Error('refusing to print: output would disclose apiKey');
  }

  let urlIsSensitive = false;
  try {
    const parsed = new URL(env.apiUrl);
    urlIsSensitive = parsed.username !== '' || parsed.password !== '' || (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '';
  } catch {
    urlIsSensitive = env.apiUrl.length > 0;
  }

  if (urlIsSensitive && env.apiUrl.length >= 8 && text.includes(env.apiUrl)) {
    throw new Error('refusing to print: output would disclose a non-public apiUrl');
  }
}

export function loadEnv(): ValidationEnv {
  if (!existsSync(ENV_PATH)) {
    throw new Error(
      `missing ${ENV_PATH}. Copy server/.env.example to server/.env and fill in HUMAIN_API_KEY.`,
    );
  }
  const file = parseEnvFile(readFileSync(ENV_PATH, 'utf8'));

  const apiKey = file.HUMAIN_API_KEY ?? '';
  const apiUrl = file.HUMAIN_API_URL ?? '';
  if (apiKey.trim() === '') throw new Error('HUMAIN_API_KEY is empty in server/.env');
  if (apiUrl.trim() === '') throw new Error('HUMAIN_API_URL is empty in server/.env');

  // A key only works against the environment that issued it, so the origin must
  // be a bare scheme+host. A path here silently breaks every Socket.IO call.
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error('HUMAIN_API_URL is not a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`HUMAIN_API_URL must use https (got ${parsed.protocol})`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('HUMAIN_API_URL must be a bare origin, without a path');
  }

  const intOr = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    apiKey,
    apiUrl: parsed.origin,
    apiPath: file.HUMAIN_API_PATH || '/socket.io',
    apiVersion: file.HUMAIN_API_VERSION || 'v1',
    maxCredits: intOr(file.VALIDATION_MAX_CREDITS, 500),
    minCreditsRemaining: intOr(file.VALIDATION_MIN_CREDITS_REMAINING, 3000),
  };
}
