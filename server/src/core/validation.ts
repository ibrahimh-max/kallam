/**
 * Boundary validation.
 *
 * Every route validates its input here before a service sees it, and every
 * failure names the offending field so the app can point at the right input.
 * Crucially this module also defines the *hard* audio limits: decoded size,
 * duration and MIME type. Those limits are the only thing standing between a
 * malicious client and our provider budget, so they are enforced server-side
 * and never trusted to the client.
 */
import { AppError } from './errors.ts';

export type FieldError = { field: string; rule: string };

export class Validator {
  private readonly errors: FieldError[] = [];
  private readonly value: Record<string, unknown>;

  constructor(body: unknown) {
    this.value = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (body !== null && typeof body === 'object' && Array.isArray(body)) {
      this.errors.push({ field: '$', rule: 'body must be a JSON object' });
    }
  }

  static from(body: unknown): Validator {
    return new Validator(body);
  }

  private fail(field: string, rule: string): void {
    this.errors.push({ field, rule });
  }

  /** Reject unknown keys so a typo cannot silently become a no-op. */
  rejectUnknown(allowed: string[]): Validator {
    for (const key of Object.keys(this.value)) {
      if (!allowed.includes(key)) this.fail(key, 'unknown field');
    }
    return this;
  }

  string(field: string, opts: { min?: number; max?: number; optional?: boolean; pattern?: RegExp } = {}): string | undefined {
    const raw = this.value[field];
    if (raw === undefined || raw === null || raw === '') {
      if (!opts.optional) this.fail(field, 'required');
      return undefined;
    }
    if (typeof raw !== 'string') {
      this.fail(field, 'must be a string');
      return undefined;
    }
    const trimmed = raw.trim();
    if (opts.min !== undefined && trimmed.length < opts.min) this.fail(field, `must be at least ${opts.min} characters`);
    if (opts.max !== undefined && trimmed.length > opts.max) this.fail(field, `must be at most ${opts.max} characters`);
    if (opts.pattern && !opts.pattern.test(trimmed)) this.fail(field, 'has an invalid format');
    return trimmed;
  }

  number(field: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number | undefined {
    const raw = this.value[field];
    if (raw === undefined || raw === null || raw === '') {
      if (!opts.optional) this.fail(field, 'required');
      return undefined;
    }
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(parsed)) {
      this.fail(field, 'must be a number');
      return undefined;
    }
    if (opts.min !== undefined && parsed < opts.min) this.fail(field, `must be at least ${opts.min}`);
    if (opts.max !== undefined && parsed > opts.max) this.fail(field, `must be at most ${opts.max}`);
    return parsed;
  }

  boolean(field: string, opts: { optional?: boolean } = {}): boolean | undefined {
    const raw = this.value[field];
    if (raw === undefined || raw === null) {
      if (!opts.optional) this.fail(field, 'required');
      return undefined;
    }
    if (typeof raw !== 'boolean') {
      this.fail(field, 'must be a boolean');
      return undefined;
    }
    return raw;
  }

  enum<T extends string>(field: string, allowed: readonly T[], opts: { optional?: boolean } = {}): T | undefined {
    const raw = this.value[field];
    if (raw === undefined || raw === null || raw === '') {
      if (!opts.optional) this.fail(field, 'required');
      return undefined;
    }
    if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
      this.fail(field, `must be one of: ${allowed.join(', ')}`);
      return undefined;
    }
    return raw as T;
  }

  /** UUID-shaped ids only: prompt ids and attempt ids are authored, not free text. */
  uuid(field: string, opts: { optional?: boolean } = {}): string | undefined {
    return this.string(field, { optional: opts.optional, pattern: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/ });
  }

  slug(field: string, opts: { optional?: boolean } = {}): string | undefined {
    return this.string(field, { optional: opts.optional, max: 80, pattern: /^[a-z0-9][a-z0-9_:-]*$/ });
  }

  /** Throws the first explanatory AppError when any field failed. */
  assertClean(): void {
    if (this.errors.length === 0) return;
    const first = this.errors[0]!;
    throw new AppError('VALIDATION_FAILED', {
      messageAr: `فيه خطأ في الحقل: ${first.field}`,
      messageEn: `invalid request field ${first.field}: ${first.rule}`,
      details: { field: first.field, reason: first.rule, fields: this.errors },
    });
  }

  done(): void {
    this.assertClean();
  }
}

export const AUDIO_MIME_ALLOWLIST = ['audio/m4a', 'audio/x-m4a', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/wave'] as const;

export interface DecodedAudio {
  bytes: Uint8Array;
  mimeType: string;
  durationSeconds: number;
}

/**
 * Decode and bound a base64 audio payload.
 *
 * Three independent ceilings, because each protects a different resource:
 *  - MAX_AUDIO_BYTES  : request memory in this process
 *  - maxDuration      : provider STT billing, which is per audio second
 *  - MIME allowlist   : only containers the provider is known to accept
 *
 * The base64 length is checked *before* decoding so an oversized payload cannot
 * force a large allocation first.
 */
export function decodeAudio(
  base64: string | undefined,
  mimeType: string | undefined,
  durationSeconds: number | undefined,
  limits: { maxBytes: number; maxDurationSeconds: number },
): DecodedAudio {
  if (!base64) {
    throw new AppError('VALIDATION_FAILED', { messageEn: 'field audio_base64: required', details: { field: 'audio_base64' } });
  }
  if (!mimeType || !AUDIO_MIME_ALLOWLIST.includes(mimeType as (typeof AUDIO_MIME_ALLOWLIST)[number])) {
    throw new AppError('INVALID_AUDIO', {
      messageEn: `field mime_type: unsupported value`,
      details: { field: 'mime_type', allowed: [...AUDIO_MIME_ALLOWLIST] },
    });
  }
  const normalizedBase64 = base64.replace(/\s+/g, '');
  // 4 base64 chars encode 3 bytes; reject before allocating.
  const estimatedBytes = Math.floor((normalizedBase64.length * 3) / 4);
  if (estimatedBytes > limits.maxBytes) {
    throw new AppError('AUDIO_TOO_LARGE', { details: { max_bytes: limits.maxBytes, received_bytes: estimatedBytes } });
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)) {
    throw new AppError('INVALID_AUDIO', { messageEn: 'audio_base64 is not valid base64', details: { field: 'audio_base64' } });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalizedBase64, 'base64');
  } catch {
    throw new AppError('INVALID_AUDIO', { details: { field: 'audio_base64' } });
  }
  if (bytes.byteLength === 0) {
    throw new AppError('INVALID_AUDIO', { messageEn: 'audio payload decoded to zero bytes', details: { field: 'audio_base64' } });
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new AppError('AUDIO_TOO_LARGE', { details: { max_bytes: limits.maxBytes, received_bytes: bytes.byteLength } });
  }
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError('VALIDATION_FAILED', { messageEn: 'field duration_seconds: required and must be positive', details: { field: 'duration_seconds' } });
  }
  if (durationSeconds > limits.maxDurationSeconds) {
    throw new AppError('AUDIO_TOO_LONG', { details: { max_seconds: limits.maxDurationSeconds, received_seconds: durationSeconds } });
  }
  return { bytes: new Uint8Array(bytes), mimeType, durationSeconds };
}
