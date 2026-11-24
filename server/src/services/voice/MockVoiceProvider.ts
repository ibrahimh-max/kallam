/**
 * Deterministic fake provider for tests and offline development.
 *
 * Why a real implementation and not a stub that throws: the automated test suite
 * must prove the *whole* speaking flow (upload → transcribe → evaluate → TTS)
 * without spending credits or depending on the network. This provider therefore
 * returns real PCM bytes and real transcripts from a scripted table, and it
 * records what it was asked so tests can assert on calls and cache behaviour.
 *
 * It is never selected when a real key is configured unless explicitly forced.
 */
import { randomUUID } from 'node:crypto';
import type {
  SpeechLanguage,
  SynthesizeInput,
  SynthesizeResult,
  TranscribeInput,
  TranscribeResult,
  Voice,
  VoiceProvider,
} from './VoiceProvider.ts';

/** Voices mirror the shape the real provider returns, with Saudi Arabic present. */
export const MOCK_VOICES: Voice[] = [
  { id: '00000000-0000-4000-8000-000000000001', label: 'mock_nourah', dialect: 'ars', languages: ['ar', 'en'], gender: 'female' },
  { id: '00000000-0000-4000-8000-000000000002', label: 'mock_abdullah', dialect: 'ars', languages: ['ar', 'en'], gender: 'male' },
  { id: '00000000-0000-4000-8000-000000000003', label: 'mock_english', dialect: 'en-US', languages: ['en'], gender: 'female' },
];

export interface MockProviderOptions {
  /** Transcript returned for the next transcribe call, in order. */
  transcripts?: string[];
  /** Simulated latency, in ms, added to the wall-clock latency field. */
  latencyMs?: number;
  /** When set, transcribe rejects with this code instead of returning. */
  failWith?: { method: 'transcribe' | 'synthesize' | 'listVoices'; code: string };
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = 'mock';
  readonly calls: { transcribe: TranscribeInput[]; synthesize: SynthesizeInput[]; listVoices: number } = {
    transcribe: [],
    synthesize: [],
    listVoices: 0,
  };

  private readonly transcripts: string[];
  private readonly latencyMs: number;
  private readonly failWith: MockProviderOptions['failWith'];

  constructor(options: MockProviderOptions = {}) {
    this.transcripts = [...(options.transcripts ?? [])];
    this.latencyMs = options.latencyMs ?? 5;
    this.failWith = options.failWith;
  }

  async listVoices(): Promise<Voice[]> {
    this.calls.listVoices += 1;
    if (this.failWith?.method === 'listVoices') throw new Error(`mock provider error: ${this.failWith.code}`);
    return MOCK_VOICES.map((v) => ({ ...v, languages: [...v.languages] }));
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    this.calls.transcribe.push(input);
    if (this.failWith?.method === 'transcribe') throw new Error(`mock provider error: ${this.failWith.code}`);
    const text = this.transcripts.shift() ?? '';
    return {
      text,
      language: input.language,
      words: text === '' ? undefined : text.split(/\s+/).map((word, index) => ({ word, startTime: index * 0.4, endTime: index * 0.4 + 0.35 })),
      confidence: null,
      requestId: randomUUID(),
      latencyMs: this.latencyMs,
    };
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    this.calls.synthesize.push(input);
    if (this.failWith?.method === 'synthesize') throw new Error(`mock provider error: ${this.failWith.code}`);
    // A real, non-silent PCM16 waveform: 24 kHz mono, ~60 ms per character.
    const sampleRate = 24_000 as const;
    const samples = Math.max(2400, Math.min(input.text.length * 1440, sampleRate * 5));
    const pcm = new Uint8Array(samples * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < samples; i += 1) {
      const value = Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 8000);
      view.setInt16(i * 2, value, true);
    }
    return { pcm, sampleRate, requestId: randomUUID(), latencyMs: this.latencyMs };
  }
}

/** Language helper used by tests to assert the STT mode mapping. */
export function mockLanguageByte(language: SpeechLanguage): number {
  return { ar: 0, en: 1, codeswitch: 2, auto: 255 }[language];
}
