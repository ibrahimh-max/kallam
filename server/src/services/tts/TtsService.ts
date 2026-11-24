/**
 * TTS with cache-first lookup.
 *
 * This is the single largest cost lever in the product (build (1).md §7.2, §11):
 * cached synthesis costs 0 credits, uncached synthesis costs credits. So the rule
 * is: **never call the provider for text we have already synthesised.**
 *
 * Cache identity = text hash + voice id + model + version. The version segment is
 * bumped whenever lesson text or voice settings change, which is what stops a
 * stale clip from being served after a content edit.
 *
 * Output format: the provider returns raw PCM16 mono @ 24 kHz, which no mobile
 * player can play directly. We prepend a WAV header and serve `audio/wav`, so the
 * app streams it without a decoder dependency. Caching the WAV (not the PCM) also
 * means cache hits skip re-wrapping.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { TtsCacheEntry, UsageFeature } from '../../domain/models.ts';
import type { Repository } from '../../repositories/Repository.ts';
import type { VoiceProvider } from '../voice/VoiceProvider.ts';

/** Bump when a change makes previously generated audio wrong to serve. */
export const TTS_CACHE_VERSION = 'v1';
export const TTS_MODEL = 'nebula';
export const SAMPLE_RATE = 24_000;

export interface TtsRequest {
  text: string;
  voiceId: string;
  /** Groups related phrases, e.g. `lesson_coffee_en`. Part of the key. */
  namespace: string;
  userId: string;
  requestId: string;
  /** Feature label for the usage ledger: lessons vs speaking feedback. */
  feature: UsageFeature;
  /** Hard character ceiling for one synthesis call. */
  maxChars: number;
}

export interface TtsResult {
  audio: Uint8Array;
  contentType: 'audio/wav';
  cacheHit: boolean;
  cacheKey: string;
  creditsEstimated: number;
  latencyMs: number;
}

/** Wrap PCM16 LE mono into a playable WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

export function durationSecondsOf(wav: Uint8Array): number {
  const dataBytes = Math.max(0, wav.byteLength - 44);
  return Number((dataBytes / (SAMPLE_RATE * 2)).toFixed(3));
}

/**
 * Cache key. Includes a hash of the *normalised* text so a whitespace-only edit
 * does not invalidate a clip, plus voice, model and version.
 */
export function ttsCacheKey(namespace: string, text: string, voiceId: string, model = TTS_MODEL): string {
  const textHash = createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
  return `${namespace}_${textHash}_${voiceId}_${model}_${TTS_CACHE_VERSION}`;
}

export function textHashOf(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

export class TtsService {
  private readonly repo: Repository;
  private readonly provider: VoiceProvider;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(repo: Repository, provider: VoiceProvider, logger: Logger, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.provider = provider;
    this.logger = logger;
    this.now = now;
  }

  /**
   * Cache-first synthesis.
   *
   * `creditsEstimated` on a hit is exactly 0 and is reported as such, because the
   * ledger's cache_hit column is the only way the unit economics can be trusted.
   */
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const text = request.text.replace(/\s+/g, ' ').trim();
    if (text === '') {
      throw new AppError('VALIDATION_FAILED', { messageAr: 'النص المطلوب فاضي.', messageEn: 'text is empty', details: { field: 'text' } });
    }
    if ([...text].length > request.maxChars) {
      throw new AppError('VALIDATION_FAILED', {
        messageAr: 'النص طويل على القراءة الصوتية.',
        messageEn: `text exceeds the ${request.maxChars} code point limit`,
        details: { field: 'text', max: request.maxChars },
      });
    }

    const cacheKey = ttsCacheKey(request.namespace, text, request.voiceId);

    // --- Cache path: no provider call, no credits. --------------------------
    const cached = await this.repo.ttsCache.get(cacheKey);
    if (cached) {
      const at = this.now().toISOString();
      await this.repo.ttsCache.touch(cacheKey, at);
      this.logger.info('tts.cache_hit', { cacheKey, chars: text.length });
      return {
        audio: cached.audio,
        contentType: 'audio/wav',
        cacheHit: true,
        cacheKey,
        creditsEstimated: 0,
        latencyMs: 0,
      };
    }

    // --- Miss path: spend once, then cache. --------------------------------
    let pcm: Uint8Array;
    let latencyMs: number;
    try {
      const result = await this.provider.synthesize({ text, voiceId: request.voiceId, model: TTS_MODEL });
      pcm = result.pcm;
      latencyMs = result.latencyMs;
    } catch (error) {
      // Provider failures become a typed, retryable error. The raw message is
      // logged server-side only.
      this.logger.error('tts.provider_failed', { detail: error instanceof Error ? error.message : 'unknown' });
      throw new AppError('PROVIDER_UNAVAILABLE', { messageEn: 'TTS provider call failed' });
    }

    const wav = pcmToWav(pcm);
    const entry: TtsCacheEntry = {
      cacheKey,
      text,
      textHash: textHashOf(text),
      voiceId: request.voiceId,
      model: TTS_MODEL,
      contentType: 'audio/wav',
      audio: wav,
      durationSeconds: durationSecondsOf(wav),
      createdAt: this.now().toISOString(),
      lastUsedAt: this.now().toISOString(),
      hits: 0,
    };
    await this.repo.ttsCache.put(entry);
    this.logger.info('tts.cache_miss', { cacheKey, chars: text.length, latencyMs });

    return {
      audio: wav,
      contentType: 'audio/wav',
      cacheHit: false,
      cacheKey,
      creditsEstimated: estimateTtsCredits(text.length),
      latencyMs,
    };
  }
}

/**
 * TTS credit estimate.
 *
 * The provider documents no per-character price and returns no
 * `credits_consumed` field (measured in Milestone 0). Rather than invent a
 * precise-looking number, this is an explicitly conservative placeholder that the
 * console Usage page reconciles. It is used for internal budgets and the
 * cache-hit-vs-miss attribution, never shown to the learner as a fact.
 */
export function estimateTtsCredits(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 1000));
}

/** STT is billed per audio second, so the estimate is direct. */
export function estimateSttCredits(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds));
}
