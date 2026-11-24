/**
 * Chooses the voice implementation once, at startup.
 *
 * Decision rule (documented because it is a security-relevant default):
 *   - VOICE_PROVIDER=mock           -> MockVoiceProvider outside production.
 *   - VOICE_PROVIDER=humain         -> HumainVoiceProvider with a real key.
 *   - VOICE_PROVIDER=auto (default) -> HumainVoiceProvider when configured.
 *
 * The last case matters: silently falling back to a mock in production would make
 * the app *look* like it transcribes speech while returning empty transcripts.
 * Failing loudly at boot is the safe behaviour.
 */
import { AppError } from '../../core/errors.ts';
import type { ServerEnv } from '../../config/env.ts';
import { HumainVoiceProvider } from './HumainVoiceProvider.ts';
import { MockVoiceProvider } from './MockVoiceProvider.ts';
import type { VoiceProvider } from './VoiceProvider.ts';

export interface VoiceProviderChoice {
  provider: VoiceProvider;
  kind: 'humain' | 'mock';
  reason: string;
}

export function createVoiceProvider(env: ServerEnv, override?: VoiceProvider): VoiceProviderChoice {
  if (override) return { provider: override, kind: 'mock', reason: 'provider injected by the caller (tests)' };

  if (env.voiceProvider === 'mock') {
    if (env.nodeEnv === 'production') {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        messageEn: 'VOICE_PROVIDER=mock is not allowed when NODE_ENV=production',
      });
    }
    return { provider: new MockVoiceProvider(), kind: 'mock', reason: 'VOICE_PROVIDER=mock was explicitly set' };
  }

  if (env.humain.apiKey === '') {
    throw new AppError('PROVIDER_UNAVAILABLE', {
      messageEn: env.voiceProvider === 'humain'
        ? 'VOICE_PROVIDER=humain requires HUMAIN_API_KEY'
        : 'HUMAIN_API_KEY is not set. Set it in server/.env for the real provider, or select VOICE_PROVIDER=mock for local tests.',
    });
  }

  return {
    provider: new HumainVoiceProvider({
      apiUrl: env.humain.apiUrl,
      apiKey: env.humain.apiKey,
      apiPath: env.humain.apiPath,
      timeoutMs: env.humain.timeoutMs,
    }),
    kind: 'humain',
    reason: 'HUMAIN_API_KEY is configured',
  };
}
