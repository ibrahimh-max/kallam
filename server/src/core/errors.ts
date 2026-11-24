/**
 * Stable error codes and the one error type the HTTP layer understands.
 *
 * Design rule: a client branches on `code`, never on message text. Every code
 * here maps to exactly one HTTP status, so a caller can retry safely based on
 * `code` alone. Human-facing text is Arabic-first because the learner is Arabic
 * speaking, with an English fallback for the operator/log.
 *
 * Nothing in this file may carry a provider message, a stack trace, or a secret.
 */

export type ErrorCode =
  // auth / authorisation
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOKEN_EXPIRED'
  // input validation
  | 'VALIDATION_FAILED'
  | 'INVALID_AUDIO'
  | 'AUDIO_TOO_LONG'
  | 'AUDIO_TOO_LARGE'
  | 'EMPTY_TRANSCRIPT'
  | 'UNKNOWN_PROMPT'
  | 'UNKNOWN_LESSON'
  // conflict / idempotency
  | 'ALREADY_EVALUATED'
  | 'IDEMPOTENCY_CONFLICT'
  // quota / rate
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  // provider
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT'
  // account lifecycle
  | 'NOT_FOUND'
  | 'CONSENT_REQUIRED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  TOKEN_EXPIRED: 401,
  VALIDATION_FAILED: 400,
  INVALID_AUDIO: 400,
  AUDIO_TOO_LONG: 400,
  AUDIO_TOO_LARGE: 413,
  EMPTY_TRANSCRIPT: 400,
  UNKNOWN_PROMPT: 400,
  UNKNOWN_LESSON: 404,
  ALREADY_EVALUATED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXHAUSTED: 429,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_REJECTED: 502,
  PROVIDER_TIMEOUT: 504,
  NOT_FOUND: 404,
  CONSENT_REQUIRED: 403,
  INTERNAL: 500,
};

/**
 * Default learner-facing text, Arabic-first. `ar` is what the app shows;
 * `en` is for logs and operators. Callers may override with a more specific
 * message, but never with provider text.
 */
const MESSAGES: Record<ErrorCode, { ar: string; en: string }> = {
  UNAUTHORIZED: { ar: 'لازم تسجّل دخول أول.', en: 'Sign in first.' },
  FORBIDDEN: { ar: 'ما عندك صلاحية لهذا الإجراء.', en: 'Not permitted.' },
  TOKEN_EXPIRED: { ar: 'انتهت الجلسة. سجّل دخول من جديد.', en: 'Session expired.' },
  VALIDATION_FAILED: { ar: 'فيه بيانات ناقصة أو غير صحيحة.', en: 'Invalid request.' },
  INVALID_AUDIO: { ar: 'التسجيل ما كان واضح. جرّب مرة ثانية.', en: 'Audio could not be decoded.' },
  AUDIO_TOO_LONG: { ar: 'التسجيل طويل. تكلم جملة قصيرة.', en: 'Recording exceeds the duration limit.' },
  AUDIO_TOO_LARGE: { ar: 'حجم التسجيل كبير. جرّب تسجيل أقصر.', en: 'Audio exceeds the size limit.' },
  EMPTY_TRANSCRIPT: { ar: 'ما سمعنا شيء. جرّب تتكلم أعلى شوي.', en: 'Empty transcript.' },
  UNKNOWN_PROMPT: { ar: 'هذا التدريب غير متوفر حالياً.', en: 'Unknown prompt.' },
  UNKNOWN_LESSON: { ar: 'ما لقينا هذا الدرس.', en: 'Unknown lesson.' },
  ALREADY_EVALUATED: { ar: 'هذه المحاولة تم تقييمها.', en: 'Attempt already evaluated.' },
  IDEMPOTENCY_CONFLICT: { ar: 'نفس الطلب أُرسل مرتين ببيانات مختلفة.', en: 'Idempotency key reused with a different payload.' },
  RATE_LIMITED: { ar: 'وصلت للحد الحالي. جرّب بعد شوي.', en: 'Rate limit reached.' },
  QUOTA_EXHAUSTED: { ar: 'خلصت محاولات الكلام لليوم. نرجع بكرة.', en: 'Daily speaking allowance used up.' },
  PROVIDER_UNAVAILABLE: { ar: 'خدمة الصوت مشغولة الآن. جرّب مرة ثانية.', en: 'Voice provider unavailable.' },
  PROVIDER_REJECTED: { ar: 'خدمة الصوت ما قبلت الطلب. جرّب مرة ثانية.', en: 'Voice provider rejected the request.' },
  PROVIDER_TIMEOUT: { ar: 'خدمة الصوت تأخرت. جرّب مرة ثانية.', en: 'Voice provider timed out.' },
  NOT_FOUND: { ar: 'ما لقينا هذا العنصر.', en: 'Not found.' },
  CONSENT_REQUIRED: { ar: 'لازم توافق على استخدام المايك أول.', en: 'Voice processing consent required.' },
  INTERNAL: { ar: 'صار خطأ غير متوقع. جرّب مرة ثانية.', en: 'Unexpected server error.' },
};

export interface AppErrorOptions {
  /** Safe, specific learner-facing Arabic. Falls back to the code's default. */
  messageAr?: string;
  messageEn?: string;
  /** Extra machine-readable context. Must not contain audio, transcripts or secrets. */
  details?: Record<string, unknown>;
  /** Set when the same request could succeed later unchanged. */
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly messageAr: string;
  readonly messageEn: string;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const defaults = MESSAGES[code];
    super(options.messageEn ?? defaults.en);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.messageAr = options.messageAr ?? defaults.ar;
    this.messageEn = options.messageEn ?? defaults.en;
    this.details = options.details;
    // Parenthesised on purpose: `??` must not bind against the `||` chain.
    this.retryable = options.retryable ?? (code === 'PROVIDER_UNAVAILABLE' || code === 'PROVIDER_TIMEOUT' || code === 'RATE_LIMITED');
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function statusFor(code: ErrorCode): number {
  return STATUS[code];
}

/** Shape sent to the client. Never includes provider text or a stack trace. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message_ar: string;
    message_en: string;
    retryable: boolean;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

export function toErrorBody(error: AppError, requestId: string): ErrorBody {
  const body: ErrorBody = {
    error: {
      code: error.code,
      message_ar: error.messageAr,
      message_en: error.messageEn,
      retryable: error.retryable,
      request_id: requestId,
    },
  };
  if (error.details !== undefined) body.error.details = error.details;
  return body;
}
