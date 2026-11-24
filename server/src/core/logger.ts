/**
 * Structured JSON logging with a hard redaction rule.
 *
 * A log line is the easiest place to leak a secret by accident, so every line
 * passes through `scrub()` which:
 *   - drops keys named like credentials (api_key, authorization, token, ...)
 *   - collapses any string that looks like a bearer/API key or download URL
 *   - keeps transcripts out of logs entirely (they are learner speech)
 *
 * `requestId` is carried on every entry so one learner action can be followed
 * across services without ever recording the learner's content.
 */

const SECRET_KEY = /(api[_-]?key|authorization|auth|bearer|secret|password|token|service[_-]?role|jwt)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_\-]{12,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}|Bearer\s+[A-Za-z0-9._\-]{12,})/g;
const URL_WITH_CREDENTIAL = /https?:\/\/[^\s"']*[?&][^\s"']*/g;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

/** Terminal fields whose values must never reach a log sink. */
const NEVER_LOG = new Set(['transcript', 'audio', 'audio_base64', 'pcm', 'text_raw']);

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE, '[redacted]').replace(URL_WITH_CREDENTIAL, '[redacted-url]');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: scrub(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => scrub(entry, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (NEVER_LOG.has(key.toLowerCase())) {
        out[key] = '[omitted]';
      } else if (SECRET_KEY.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = scrub(entry, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bound: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class JsonLogger implements Logger {
  private readonly minLevel: number;
  private readonly bound: LogFields;
  private readonly sink: (line: string) => void;

  constructor(
    bound: LogFields = {},
    level: LogLevel = 'info',
    sink: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  ) {
    this.bound = bound;
    this.minLevel = LEVEL_ORDER[level];
    this.sink = sink;
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(scrub({ ...this.bound, ...fields }) as Record<string, unknown>),
    };
    this.sink(JSON.stringify(entry));
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }
  child(bound: LogFields): Logger {
    return new JsonLogger({ ...this.bound, ...bound }, 'debug', this.sink);
  }
}

/** Silent logger for tests: assertions should not depend on log side effects. */
export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}
