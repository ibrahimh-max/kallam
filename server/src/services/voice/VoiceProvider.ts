/**
 * The contract the learning application depends on.
 *
 * Nothing here mentions HUMAIN. Lesson logic, evaluation and caching are written
 * against this interface only, so the provider can be swapped (or a fake used in
 * tests) without touching the core application.
 *
 * Every method is server-side. The master key never leaves the backend.
 */

/** Languages the provider accepts. Mirrors the documented wire values. */
export type SpeechLanguage = 'ar' | 'en' | 'codeswitch' | 'auto';

/** A voice the account may actually synthesise with. */
export interface Voice {
  /** Profile UUID. This is the sendable value; `label` is display-only. */
  id: string;
  /** Human-readable name such as `mul_nourah`. Never match on this. */
  label: string;
  /** BCP-47 base dialect, e.g. `ars` for Saudi Arabic. */
  dialect: string;
  languages: string[];
  gender?: string;
}

export interface TranscribeInput {
  /** Raw audio bytes. The provider sniffs the container itself. */
  audio: Uint8Array;
  /** Hint only. The container is what actually decides. */
  container?: 'wav' | 'mp3' | 'flac' | 'aac' | 'mp4';
  language: SpeechLanguage;
  /** ASR model key, e.g. `bayan_ar`. Omitted means the language default. */
  model?: string;
}

export interface TranscribeResult {
  text: string;
  language: SpeechLanguage;
  /** Present when the provider supplies word timings. */
  words?: { word: string; startTime: number; endTime: number }[];
  /**
   * The provider exposes NO confidence score. Kept as an explicit `null` so no
   * caller can accidentally build a confidence threshold that can never fire.
   * Deciding "was that good enough?" is deterministic (R1 decision), not a score.
   */
  confidence: null;
  /** Echoed provider request id, for support and for the usage ledger. */
  requestId: string;
  latencyMs: number;
}

export interface SynthesizeInput {
  text: string;
  /**
   * The sendable voice UUID. Not a label. Arabic vs English is chosen by whether
   * the text contains Arabic script, so there is no `language` parameter here.
   */
  voiceId: string;
  /** Only documented TTS model today. */
  model?: 'nebula';
}

export interface SynthesizeResult {
  /** Raw PCM16 little-endian, mono, 24 kHz, without a WAV header. */
  pcm: Uint8Array;
  sampleRate: 24_000;
  requestId: string;
  latencyMs: number;
}

export interface VoiceProvider {
  /** Stable provider name, for the usage ledger and logs. */
  readonly name: string;

  /** Resolve the account's available voices. Never hard-code IDs. */
  listVoices(): Promise<Voice[]>;

  /**
   * Transcribe one short clip.
   *
   * Retry contract: there is NO idempotency or replay contract, so a blind
   * resubmit can duplicate usage. Callers must own their own attempt IDs and
   * only retry with a fresh request id.
   */
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;

  /**
   * Buffered synthesis. Returns the whole clip; the provider does not stream on
   * this route. Cache reusable lesson audio in the caller: cached audio costs 0.
   */
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
}
