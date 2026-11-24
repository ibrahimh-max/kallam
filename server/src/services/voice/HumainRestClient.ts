/**
 * Transport-free HTTP client for the HUMAIN Voice REST surface.
 *
 * Why this exists next to `HumainVoiceProvider`: the Socket.IO adapter owns the
 * learning flows (fast STT + buffered TTS), while these HTTP routes are what the
 * Milestone 0 harness probed and what batch STT uses. Both live server-side and
 * share one config object so there is a single place where the key is read.
 *
 * Safety properties, all deliberate:
 *  - The key travels in the `x-api-key` header only. It is never put in a query
 *    string, because query strings end up in provider logs and in our own logs.
 *  - Responses are size-capped and time-boxed; a hung provider must not pin a
 *    learner request open.
 *  - Errors are translated to a typed result, never surfaced raw, because a raw
 *    provider body can contain account identifiers.
 */
import { AppError } from '../../core/errors.ts';

export interface HumainRestConfig {
  apiUrl: string;
  apiKey: string;
  apiVersion?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type BatchTranscribeResult =
  | { ok: true; text: string; language: string; latencyMs: number }
  | { ok: false; code: string; status: number | null; latencyMs: number };

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class HumainRestClient {
  private readonly base: string;
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private readonly config: HumainRestConfig;

  constructor(config: HumainRestConfig) {
    if (!config.apiUrl) throw new AppError('PROVIDER_UNAVAILABLE', { messageEn: 'HUMAIN_API_URL is not configured' });
    if (!config.apiKey) throw new AppError('PROVIDER_UNAVAILABLE', { messageEn: 'HUMAIN_API_KEY is not configured' });
    this.config = config;
    this.base = config.apiUrl.replace(/\/$/, '');
    this.version = config.apiVersion ?? 'v1';
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Never returns the key. Safe to log or embed in a report. */
  describe(): { apiUrlOrigin: string; apiVersion: string; timeoutMs: number; apiKeyPresent: boolean } {
    return {
      apiUrlOrigin: new URL(this.base).origin,
      apiVersion: this.version,
      timeoutMs: this.timeoutMs,
      apiKeyPresent: this.config.apiKey.length > 0,
    };
  }

  private async request(path: string, init: RequestInit, query?: Record<string, string>): Promise<globalThis.Response> {
    const url = new URL(`${this.base}/v${this.version.replace(/^v/, '')}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url.toString(), {
        ...init,
        signal: controller.signal,
        headers: {
          // The API key is a header, never a query parameter.
          'x-api-key': this.config.apiKey,
          Origin: new URL(this.base).origin,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError';
      throw new AppError(aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', {
        messageEn: aborted ? 'HUMAIN request timed out' : 'HUMAIN request failed at the transport layer',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bounded read: a runaway body cannot exhaust memory. */
  private async readText(response: globalThis.Response): Promise<string> {
    const body = await response.text();
    return body.length > MAX_RESPONSE_BYTES ? body.slice(0, MAX_RESPONSE_BYTES) : body;
  }

  /**
   * Batch STT via `POST /v1/transcribe/{lang}`, multipart with a `file` part.
   * Returns a typed result rather than throwing for a *provider* rejection, so
   * the caller can distinguish "the provider said no" from "we are misconfigured".
   */
  async batchTranscribe(
    audio: Uint8Array,
    lang: 'ar' | 'en',
    fileName = 'clip.wav',
    mimeType = 'audio/wav',
  ): Promise<BatchTranscribeResult> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), fileName);

    let response: globalThis.Response;
    try {
      response = await this.request(`/transcribe/${lang}`, { method: 'POST', body: form });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'PROVIDER_UNAVAILABLE';
      return { ok: false, code, status: null, latencyMs: Date.now() - started };
    }

    const latencyMs = Date.now() - started;
    const body = await this.readText(response);
    if (!response.ok) {
      return { ok: false, code: extractCode(body) ?? `HTTP_${response.status}`, status: response.status, latencyMs };
    }
    let parsed: { transcription?: unknown; text?: unknown; language?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return { ok: false, code: 'MALFORMED_RESPONSE', status: response.status, latencyMs };
    }
    const text = typeof parsed.transcription === 'string' ? parsed.transcription : typeof parsed.text === 'string' ? parsed.text : '';
    return { ok: true, text, language: typeof parsed.language === 'string' ? parsed.language : lang, latencyMs };
  }

  /**
   * Buffered TTS via `POST /v1/audio/speech`. Sibling of the Socket.IO route; the
   * learning flow uses the Socket.IO one because it returns raw PCM, but this is
   * the route that answers a plain HTTP probe (used by the Milestone 0 harness).
   */
  async speech(text: string, voiceId: string, model = 'nebula'): Promise<{ ok: true; audio: Uint8Array; contentType: string; latencyMs: number } | { ok: false; code: string; status: number | null; latencyMs: number }> {
    const started = Date.now();
    let response: globalThis.Response;
    try {
      response = await this.request('/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: text, text, voice_id: voiceId, model }),
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'PROVIDER_UNAVAILABLE';
      return { ok: false, code, status: null, latencyMs: Date.now() - started };
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const body = await this.readText(response);
      return { ok: false, code: extractCode(body) ?? `HTTP_${response.status}`, status: response.status, latencyMs };
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      return { ok: false, code: 'RESPONSE_TOO_LARGE', status: response.status, latencyMs };
    }
    return { ok: true, audio: buffer, contentType: response.headers.get('content-type') ?? 'application/octet-stream', latencyMs };
  }
}

/** Provider error bodies carry a machine code; keep it, drop the rest. */
function extractCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: { code?: unknown } };
    const code = typeof parsed.code === 'string' ? parsed.code : typeof parsed.error?.code === 'string' ? parsed.error.code : null;
    return code && /^[A-Z0-9_]{3,48}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
