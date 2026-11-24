/**
 * Real HUMAIN adapter.
 *
 * Implements VoiceProvider against the documented transports:
 *   - voices        Socket.IO  tts_voice_list      -> tts_voice_list_result
 *   - transcribe    Socket.IO  audio_file          -> transcription_result
 *   - synthesize    Socket.IO  tts                 -> tts_audio frames
 *
 * Design choices that are deliberate, not accidental:
 *   - The key is read from the environment at construction and is never logged,
 *     never returned, and never placed in a URL. Provider requests put it in the
 *     `x-api-key` header only.
 *   - Errors keep the provider's machine-readable `code` so callers branch on
 *     code/retryable rather than on message text.
 *   - No retry is performed internally: there is no idempotency contract, so
 *     retrying is the caller's decision with a fresh request id.
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type {
  SpeechLanguage,
  SynthesizeInput,
  SynthesizeResult,
  TranscribeInput,
  TranscribeResult,
  Voice,
  VoiceProvider,
} from './VoiceProvider.ts';

export interface HumainConfig {
  apiUrl: string;
  apiKey: string;
  apiPath?: string;
  /** Per-request ceiling. Provider TTS synthesis itself dies at 25 s. */
  timeoutMs?: number;
}

/** Documented language byte for the realtime/fast frame headers. */
const LANGUAGE_BYTE: Record<SpeechLanguage, number> = { ar: 0, en: 1, codeswitch: 2, auto: 255 };

/** Voice-list payload shape from the docs. Treated as untrusted input. */
interface RawVoice {
  id?: unknown;
  label?: unknown;
  profile?: {
    speaker?: { gender?: unknown; dialect?: unknown };
    languages?: unknown;
  };
}

export class HumainVoiceProvider implements VoiceProvider {
  readonly name = 'humain';
  private readonly config: Required<HumainConfig>;

  constructor(config: HumainConfig) {
    if (!config.apiUrl) throw new Error('HUMAIN API URL is required');
    if (!config.apiKey) throw new Error('HUMAIN API key is required');
    this.config = {
      apiPath: '/socket.io',
      timeoutMs: 20_000,
      ...config,
    };
  }

  /** One connection per workflow call keeps the adapter easy to reason about. */
  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(this.config.apiUrl, {
        path: this.config.apiPath,
        transports: ['websocket'],
        reconnection: false,
        timeout: this.config.timeoutMs,
        extraHeaders: {
          // Both headers are required on the Socket.IO handshake.
          'x-api-key': this.config.apiKey,
          Origin: new URL(this.config.apiUrl).origin,
        },
      });
      const settle = (fn: () => void): void => {
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
        fn();
      };
      const onConnect = (): void => settle(() => resolve(socket));
      const onError = (error: Error): void => settle(() => reject(new Error(`provider connect_error: ${error.message}`)));
      socket.once('connect', onConnect);
      socket.once('connect_error', onError);
    });
  }

  async listVoices(): Promise<Voice[]> {
    const socket = await this.connect();
    try {
      const raw = await new Promise<RawVoice[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tts_voice_list_result timed out')), this.config.timeoutMs);
        socket.once('tts_voice_list_result', (voices: RawVoice[]) => {
          clearTimeout(timer);
          resolve(Array.isArray(voices) ? voices : []);
        });
        socket.once('error', (err: unknown) => {
          clearTimeout(timer);
          reject(new Error(`provider error: ${JSON.stringify(err).slice(0, 200)}`));
        });
        socket.emit('tts_voice_list', {});
      });

      // An empty list is valid. Never substitute a guessed ID.
      return raw
        .filter((v): v is RawVoice & { id: string } => typeof v.id === 'string' && v.id.length > 0)
        .map((v) => ({
          id: v.id,
          label: typeof v.label === 'string' ? v.label : '',
          dialect: typeof v.profile?.speaker?.dialect === 'string' ? v.profile.speaker.dialect : '',
          languages: Array.isArray(v.profile?.languages) ? v.profile.languages.filter((l): l is string => typeof l === 'string') : [],
          gender: typeof v.profile?.speaker?.gender === 'string' ? v.profile.speaker.gender : undefined,
        }));
    } finally {
      socket.close();
    }
  }

  /**
   * Build the documented fast-transcription packet:
   *   [0..16) uuid | [16] language | [17..19) asr key length | key | 6 reserved bytes | audio
   */
  static buildAudioFilePacket(requestId: string, language: SpeechLanguage, model: string, audio: Uint8Array): Buffer {
    const uuid = Buffer.from(requestId.replaceAll('-', ''), 'hex');
    if (uuid.length !== 16) throw new Error('requestId must be a UUID');

    const key = Buffer.from(model ?? '', 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16LE(key.length, 0);
    const reserved = Buffer.alloc(6); // diarization, ITN, redaction lengths: all zero

    return Buffer.concat([uuid, Buffer.of(LANGUAGE_BYTE[language]), length, key, reserved, Buffer.from(audio)]);
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (input.audio.byteLength === 0) throw new Error('audio is empty; the provider rejects empty payloads');
    const requestId = randomUUID();
    const model = input.model ?? '';
    const started = Date.now();

    const socket = await this.connect();
    try {
      const result = await new Promise<{ transcription: string; words: TranscribeResult['words']; isFinal: boolean }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('transcription_result timed out')), this.config.timeoutMs);
          socket.on('transcription_result', (r: { id?: string; transcription?: string; is_final?: boolean; words?: unknown }) => {
            if (r.id !== requestId) return; // responses echo the id; route by it
            if (r.is_final !== true) return; // wait for the final record
            clearTimeout(timer);
            resolve({
              transcription: typeof r.transcription === 'string' ? r.transcription : '',
              isFinal: true,
              words: Array.isArray(r.words) ? (r.words as TranscribeResult['words']) : undefined,
            });
          });
          socket.once('error', (err: unknown) => {
            clearTimeout(timer);
            const e = err as { code?: string; retryable?: boolean };
            const error = new Error(`provider error: ${e?.code ?? JSON.stringify(err).slice(0, 120)}`);
            // Preserve the machine-readable code for callers.
            (error as Error & { code?: string; retryable?: boolean }).code = e?.code;
            (error as Error & { retryable?: boolean }).retryable = e?.retryable;
            reject(error);
          });
          socket.emit('audio_file', HumainVoiceProvider.buildAudioFilePacket(requestId, input.language, model, input.audio));
        },
      );

      return {
        text: result.transcription,
        language: input.language,
        words: result.words,
        // The provider exposes no confidence value, and we will not invent one.
        confidence: null,
        requestId,
        latencyMs: Date.now() - started,
      };
    } finally {
      socket.close();
    }
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    const text = input.text.trim();
    if (text === '') throw new Error('text is empty; the provider requires at least one letter or number');
    // Code points, matching the provider's own limit unit.
    const codePoints = [...text].length;
    if (codePoints > 1500) throw new Error(`text is ${codePoints} code points; the provider limit is 1500`);

    const requestId = randomUUID();
    const started = Date.now();

    const socket = await this.connect();
    try {
      const pcm = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => reject(new Error('tts_audio timed out')), this.config.timeoutMs);
        socket.on('tts_audio', (data: ArrayBuffer) => {
          const frame = Buffer.from(data);
          if (frame.length < 17) return;
          if (!frame.subarray(0, 16).equals(Buffer.from(requestId.replaceAll('-', ''), 'hex'))) return;
          chunks.push(frame.subarray(17)); // bytes 17+ are PCM
          if (frame[16]! & 1) {
            // bit 0 marks the last frame; include its PCM (done above)
            clearTimeout(timer);
            resolve(Buffer.concat(chunks));
          }
        });
        socket.once('error', (err: unknown) => {
          clearTimeout(timer);
          const e = err as { code?: string; retryable?: boolean };
          const error = new Error(`provider error: ${e?.code ?? JSON.stringify(err).slice(0, 120)}`);
          (error as Error & { code?: string }).code = e?.code;
          reject(error);
        });
        // No `language` field exists: Arabic is selected by the text's script.
        socket.emit('tts', { id: requestId, text, model: input.model ?? 'nebula', voice_id: input.voiceId });
      });

      return {
        pcm: new Uint8Array(pcm),
        sampleRate: 24_000,
        requestId,
        latencyMs: Date.now() - started,
      };
    } finally {
      socket.close();
    }
  }
}
