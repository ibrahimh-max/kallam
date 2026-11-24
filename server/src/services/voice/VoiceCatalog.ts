/**
 * Voice IDs are per-environment profile UUIDs (Milestone 0 finding), so they are
 * resolved from the provider at runtime and cached, never hardcoded.
 *
 * Selection order, deliberately explicit:
 *   1. An environment override (`HUMAIN_ARABIC_VOICE_ID` / `HUMAIN_ENGLISH_VOICE_ID`)
 *      — so the owner can pin a voice after native-listener testing without code.
 *   2. A profile whose dialect matches Saudi Arabic (`ars`) for Arabic.
 *   3. Any profile that lists the language, in the provider's own order.
 *
 * If nothing matches, the catalog throws a typed error instead of guessing an id:
 * sending an unknown voice id would burn credits on a rejected request.
 */
import { AppError } from '../../core/errors.ts';
import type { Voice, VoiceProvider } from './VoiceProvider.ts';

export interface VoiceSelection {
  arabic: Voice;
  english: Voice;
  /** True when the Saudi-dialect preference was satisfied. */
  arabicIsSaudi: boolean;
}

export interface VoiceCatalogOptions {
  provider: VoiceProvider;
  arabicVoiceIdOverride?: string;
  englishVoiceIdOverride?: string;
  /** Cache lifetime. Voice profiles do not change often; 6 h avoids a call per request. */
  ttlMs?: number;
  now?: () => number;
}

export class VoiceCatalog {
  private cached: { voices: Voice[]; fetchedAt: number } | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private inflight: Promise<Voice[]> | null = null;

  private readonly options: VoiceCatalogOptions;

  constructor(options: VoiceCatalogOptions) {
    this.options = options;
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  async list(force = false): Promise<Voice[]> {
    const fresh = this.cached && this.now() - this.cached.fetchedAt < this.ttlMs;
    if (!force && fresh && this.cached) return this.cached.voices;
    // Single-flight: concurrent callers share one provider round trip.
    if (this.inflight) return this.inflight;
    this.inflight = this.options.provider
      .listVoices()
      .then((voices) => {
        this.cached = { voices, fetchedAt: this.now() };
        return voices;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async select(): Promise<VoiceSelection> {
    const voices = await this.list();
    if (voices.length === 0) {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        messageEn: 'the voice catalog returned no profiles for this account',
        retryable: true,
      });
    }

    const arabic =
      (this.options.arabicVoiceIdOverride ? voices.find((v) => v.id === this.options.arabicVoiceIdOverride) : undefined) ??
      voices.find((v) => v.dialect.toLowerCase() === 'ars') ??
      voices.find((v) => v.languages.includes('ar')) ??
      voices[0];

    const english =
      (this.options.englishVoiceIdOverride ? voices.find((v) => v.id === this.options.englishVoiceIdOverride) : undefined) ??
      voices.find((v) => v.languages.includes('en') && v.dialect !== 'ars') ??
      voices.find((v) => v.languages.includes('en')) ??
      arabic;

    if (!arabic || !english) {
      throw new AppError('PROVIDER_UNAVAILABLE', { messageEn: 'no usable voice profile for this account' });
    }

    return { arabic, english, arabicIsSaudi: arabic.dialect.toLowerCase() === 'ars' };
  }

  /** Resolve just the voice for one script, used by the lessons TTS path. */
  async selectFor(script: 'ar' | 'en'): Promise<Voice> {
    const selection = await this.select();
    return script === 'ar' ? selection.arabic : selection.english;
  }

  invalidate(): void {
    this.cached = null;
  }
}

/** True when a string contains Arabic script, which decides TTS voice selection. */
export function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}
