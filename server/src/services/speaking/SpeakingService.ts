/**
 * The speaking pipeline: audio in, transcript + bounded Arabic feedback out.
 *
 * This is the heart of the product loop ("Speak in English → get corrected in
 * Saudi Arabic → practise again"), so the ordering and the failure behaviour are
 * both deliberate:
 *
 *   1. Resolve the prompt from authored content. An unknown prompt is rejected
 *      before any provider call, so a bad client cannot spend credits.
 *   2. Reserve the learner's daily speaking attempt *before* calling the provider,
 *      so a burst of parallel uploads cannot exceed the allowance.
 *   3. Transcribe with the language mode from the prompt (English task ->
 *      english_only; mixed speech -> code_switch).
 *   4. Release the reservation on provider failure — the learner is not charged
 *      for our outage.
 *   5. Evaluate deterministically (0 credits) and persist the attempt with NO
 *      audio. `audio_deleted_at` is set to the request time because in this design
 *      audio never reaches durable storage in the first place.
 *
 * Privacy shape of the persisted row: transcript + evaluation only, both cleared
 * later by the retention job.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { SpeakingAttempt, SpeakingEvaluation, SpeakingPrompt } from '../../domain/models.ts';
import type { Repository } from '../../repositories/Repository.ts';
import type { SpeechLanguage, VoiceProvider } from '../voice/VoiceProvider.ts';
import { evaluateSpeaking } from '../evaluation/evaluate.ts';
import { estimateSttCredits } from '../tts/TtsService.ts';
import type { UsageService } from '../usage/UsageService.ts';

/** Map the authored prompt mode to the provider's wire language value. */
export function languageForMode(mode: SpeakingPrompt['languageMode']): SpeechLanguage {
  switch (mode) {
    case 'english_only':
      return 'en';
    case 'arabic_only':
      return 'ar';
    case 'code_switch':
      return 'codeswitch';
  }
}

export interface TranscribeAndEvaluateInput {
  userId: string;
  lessonAttemptId: string | null;
  prompt: SpeakingPrompt;
  audio: Uint8Array;
  durationSeconds: number;
  requestId: string;
  /** From the Idempotency-Key header, if the client sent one. */
  idempotencyKey: string | null;
}

export interface SpeakingOutcome {
  attempt_id: string;
  transcript: string;
  language_detected: SpeechLanguage;
  /** Always null: the provider exposes no confidence value, and we do not invent one. */
  confidence: null;
  evaluation: SpeakingEvaluation;
  credits_consumed: number;
  cache_hit: false;
  stt_latency_ms: number;
  /** True when audio was not retained (always true in this design). */
  audio_discarded: true;
}

export class SpeakingService {
  private readonly repo: Repository;
  private readonly provider: VoiceProvider;
  private readonly usage: UsageService;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(repo: Repository, provider: VoiceProvider, usage: UsageService, logger: Logger, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.provider = provider;
    this.usage = usage;
    this.logger = logger;
    this.now = now;
  }

  async transcribeAndEvaluate(input: TranscribeAndEvaluateInput): Promise<SpeakingOutcome> {
    const language = languageForMode(input.prompt.languageMode);
    const creditsEstimated = estimateSttCredits(input.durationSeconds);

    // --- 2. Reserve before spending. ---------------------------------------
    const reservation = await this.usage.reserve({
      userId: input.userId,
      feature: 'stt',
      quantity: input.durationSeconds,
      creditsEstimated,
      provider: this.provider.name,
      model: null,
      requestId: input.requestId,
    });
    const event = this.usage.assertAllowed(reservation);

    // --- 3. Transcribe. ----------------------------------------------------
    let transcript = '';
    let providerLatencyMs = 0;
    try {
      const result = await this.provider.transcribe({
        audio: input.audio,
        language,
      });
      transcript = result.text ?? '';
      providerLatencyMs = result.latencyMs;
    } catch (error) {
      // --- 4. Our failure is not the learner's cost. ----------------------
      await this.usage.settleFailure(event.id);
      const code = (error as { code?: string }).code;
      this.logger.error('speaking.stt_failed', {
        userId: input.userId,
        promptSlug: input.prompt.slug,
        providerCode: code,
        detail: error instanceof Error ? error.message : 'unknown',
      });
      throw new AppError('PROVIDER_UNAVAILABLE', {
        messageAr: 'خدمة الصوت ما قدرت تسمع التسجيل. جرّب مرة ثانية.',
        messageEn: 'speech-to-text provider call failed; quota released',
      });
    }

    // The call succeeded, so the learner's allowance is genuinely used.
    await this.usage.settleSuccess(event.id, { creditsEstimated });

    // --- 5. Deterministic evaluation. Costs nothing, invents nothing. ------
    const { evaluation, usedAuthoredRule } = evaluateSpeaking({
      prompt: input.prompt,
      transcript,
    });

    const at = this.now().toISOString();
    const attempt: SpeakingAttempt = {
      id: randomUUID(),
      userId: input.userId,
      lessonAttemptId: input.lessonAttemptId,
      promptSlug: input.prompt.slug,
      transcript: transcript === '' ? null : transcript,
      evaluation,
      languageMode: input.prompt.languageMode,
      durationSeconds: input.durationSeconds,
      // Audio is discarded at the end of the request; the timestamp records that.
      audioDeletedAt: at,
      createdAt: at,
    };
    await this.repo.speaking.create(attempt);

    this.logger.info('speaking.evaluated', {
      userId: input.userId,
      promptSlug: input.prompt.slug,
      words: transcript === '' ? 0 : transcript.trim().split(/\s+/).length,
      understood: evaluation.understood,
      taskCompleted: evaluation.task_completed,
      retry: evaluation.retry_required,
      corrections: evaluation.corrections.length,
      usedAuthoredRule,
      matchMethod: evaluation.match_method,
      durationSeconds: input.durationSeconds,
      credits: creditsEstimated,
    });

    return {
      attempt_id: attempt.id,
      transcript,
      language_detected: language,
      confidence: null,
      evaluation,
      credits_consumed: creditsEstimated,
      cache_hit: false,
      stt_latency_ms: providerLatencyMs,
      audio_discarded: true,
    };
  }

  /** Text-only evaluation, for typed practice and for re-running a saved transcript. */
  async evaluateTranscript(input: { userId: string; prompt: SpeakingPrompt; transcript: string }): Promise<SpeakingEvaluation> {
    const trimmed = input.transcript.trim();
    if (trimmed === '') throw new AppError('EMPTY_TRANSCRIPT');
    const { evaluation } = evaluateSpeaking({ prompt: input.prompt, transcript: trimmed });
    return evaluation;
  }

  async listRecent(userId: string, limit = 20): Promise<SpeakingAttempt[]> {
    return this.repo.speaking.listForUser(userId, Math.min(Math.max(limit, 1), 100));
  }
}
