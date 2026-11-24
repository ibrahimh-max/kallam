/**
 * Application assembly.
 *
 * One function builds the whole HTTP surface from injected dependencies, so tests
 * can construct the real app with a memory repository and a mock voice provider
 * without any network, and production assembles the same app with Supabase and
 * HUMAIN. Nothing below this line reads `process.env` except the two voice-id
 * overrides, which are passed through the catalog.
 *
 * Middleware order is a security decision, so it is fixed and commented:
 *   request context -> rate limit -> body parse -> route-level auth.
 * Rate limiting runs before body parsing so a flood cannot force us to buffer
 * bodies first.
 *
 * Learning/account routes require auth; registration, email actions, login and
 * health are intentionally public and individually rate-limited as needed.
 * No route accepts a user id from the client: identity comes from `requireAuth`.
 */
import express, { type Express, type Response, Router } from 'express';
import { randomBytes } from 'node:crypto';
import type { ServerEnv } from './config/env.ts';
import { AppError } from './core/errors.ts';
import {
  contextMiddleware,
  errorHandler,
  handler,
  notFoundHandler,
  requireParam,
  requireUser,
  sendOk,
  type CtxRequest,
} from './core/http.ts';
import { JsonLogger, type Logger } from './core/logger.ts';
import { decodeAudio, Validator } from './core/validation.ts';
import {
  allDocs,
  renderDocPage,
  renderLegalIndex,
  type LegalConfig,
} from './content/legal.ts';
import { renderAuthActionPage } from './content/authActionPage.ts';
import {
  DAILY_GOALS,
  ENGLISH_LEVELS,
  LEARNING_GOALS,
  type DailyGoalMinutes,
} from './domain/models.ts';
import { requireActiveAccount, requireAuth, requireVoiceConsent } from './middleware/auth.ts';
import { idempotencyGuard, readIdempotencyKey, rememberResponse } from './middleware/idempotency.ts';
import type { ProfileUpdate, Repository } from './repositories/Repository.ts';
import {
  authEmailRateLimitMiddleware,
  ipRateLimitMiddleware,
  MemoryRateLimitStore,
  userRateLimitMiddleware,
  type RateLimitStore,
} from './security/rateLimit.ts';
import { AuthService, POLICY_VERSION } from './services/auth/AuthService.ts';
import { createEmailDelivery, MockEmailDelivery, type EmailDelivery } from './services/auth/EmailDelivery.ts';
import { LessonService } from './services/lessons/LessonService.ts';
import { ProgressService } from './services/progress/ProgressService.ts';
import { RetentionService } from './services/retention/RetentionService.ts';
import { SpeakingService } from './services/speaking/SpeakingService.ts';
import { durationSecondsOf, estimateTtsCredits, TtsService } from './services/tts/TtsService.ts';
import { UsageService } from './services/usage/UsageService.ts';
import { VoiceCatalog } from './services/voice/VoiceCatalog.ts';
import type { VoiceProvider } from './services/voice/VoiceProvider.ts';

export interface AppDeps {
  env: ServerEnv;
  repo: Repository;
  provider: VoiceProvider;
  /** Injected so tests can capture logs instead of writing them to stdout. */
  logger?: Logger;
  /** Shared per-instance or Supabase-backed store for both limiter layers. */
  rateLimitStore?: RateLimitStore;
  emailDelivery?: EmailDelivery;
  now?: () => Date;
  /** Overrides for the voice catalog, normally read from the environment. */
  arabicVoiceIdOverride?: string;
  englishVoiceIdOverride?: string;
}

function sendAuthActionPage(
  res: Response,
  kind: 'verify-email' | 'reset-password',
): void {
  const nonce = randomBytes(18).toString('base64url');
  res
    .set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    .type('html')
    .send(renderAuthActionPage(kind, nonce));
}

/** Service container. Built once per app, never per request. */
export function buildServices(deps: AppDeps) {
  const logger = deps.logger ?? new JsonLogger({}, deps.env.nodeEnv === 'test' ? 'error' : 'info');
  const now = deps.now ?? (() => new Date());
  const emailDelivery = deps.emailDelivery ?? createEmailDelivery(deps.env.email);
  const usage = new UsageService(
    deps.repo,
    {
      freeDailySpeakingAttempts: deps.env.limits.freeDailySpeakingAttempts,
      freeDailyTtsRequests: deps.env.limits.freeDailyTtsRequests,
      dailyCreditBudget: deps.env.usage.dailyCreditBudget,
    },
    logger,
    now,
  );
  return {
    logger,
    now,
    usage,
    auth: new AuthService(deps.repo, deps.env.localJwtSecret, logger, emailDelivery, deps.env.publicBaseUrl, now),
    emailDelivery,
    lessons: new LessonService(deps.repo, logger, now),
    speaking: new SpeakingService(deps.repo, deps.provider, usage, logger, now),
    tts: new TtsService(deps.repo, deps.provider, logger, now),
    progress: new ProgressService(deps.repo, now),
    retention: new RetentionService(deps.repo, deps.env.retention, logger, now),
    voices: new VoiceCatalog({
      provider: deps.provider,
      ...(deps.arabicVoiceIdOverride !== undefined && deps.arabicVoiceIdOverride !== ''
        ? { arabicVoiceIdOverride: deps.arabicVoiceIdOverride }
        : {}),
      ...(deps.englishVoiceIdOverride !== undefined && deps.englishVoiceIdOverride !== ''
        ? { englishVoiceIdOverride: deps.englishVoiceIdOverride }
        : {}),
    }),
  };
}

export type Services = ReturnType<typeof buildServices>;

export function buildApp(deps: AppDeps): Express {
  const services = buildServices(deps);
  const { logger } = services;
  const rateLimitStore = deps.rateLimitStore ?? new MemoryRateLimitStore();
  const app = express();

  // Do not advertise the framework.
  app.disable('x-powered-by');
  // `req.ip` drives the per-IP rate limit, so this must not over-trust headers.
  // Express's numeric trust setting uses a fixed hop count when `x-forwarded-for`
  // is absent (so a directly-connected client is still identified by its socket),
  // but it reads that header when present. With hops=0 we express the honest
  // default: believe no proxy. A deployment behind a real load balancer raises
  // TRUST_PROXY_HOPS to its actual hop count.
  app.set('trust proxy', deps.env.trustProxyHops);

  const allowedOrigins = new Set(deps.env.corsAllowedOrigins);
  const allowedRequestHeaders = new Set(['authorization', 'content-type', 'idempotency-key']);
  const allowedMethods = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (req.method === 'OPTIONS') {
      if (!origin || !allowedOrigins.has(origin)) return res.sendStatus(403);

      const requestedMethod = req.get('Access-Control-Request-Method')?.toUpperCase();
      const requestedHeaders = (req.get('Access-Control-Request-Headers') ?? '')
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .filter((header) => header !== '');
      if (
        (requestedMethod !== undefined && !allowedMethods.has(requestedMethod)) ||
        requestedHeaders.some((header) => !allowedRequestHeaders.has(header))
      ) {
        return res.sendStatus(403);
      }

      res.vary('Origin');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', [...allowedMethods].join(', '));
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }

    if (origin) {
      if (!allowedOrigins.has(origin)) return res.sendStatus(403);
      res.vary('Origin');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'X-TTS-Cache, X-TTS-Credits');
    }
    next();
  });

  app.use(contextMiddleware(logger));
  app.use(
    ipRateLimitMiddleware({
      windowMs: 60_000,
      perIpLimit: deps.env.limits.requestsPerMinutePerIp,
      store: rateLimitStore,
    }),
  );

  // JSON only. Audio arrives base64-encoded inside JSON so there is exactly one
  // body format and one size limit to reason about. The limit is derived from the
  // audio ceiling (base64 inflates by ~4/3) plus room for the other fields.
  const jsonLimit = Math.ceil((deps.env.limits.maxAudioBytes * 4) / 3) + 64 * 1024;
  app.use(express.json({ limit: jsonLimit }));

  app.get(
    '/health',
    handler(async (_req, res) => {
      const health = await deps.repo.health();
      const spend = await services.usage.globalSpendToday();
      // Unauthenticated route: expose a boolean, never the driver's diagnostic
      // text. A connection failure message names the database host and can echo
      // table/column names from the PostgREST error.
      if (!health.ok && health.detail) {
        logger.warn('health.repository_unreachable', { detail: health.detail });
      }
      sendOk(res, {
        service: 'saudi-english-tutor-server',
        repository: deps.repo.driver,
        repository_ok: health.ok,
        voice_provider: deps.provider.name,
        today: spend,
      });
    }),
  );

  app.use('/v1', v1Routes(deps, services, rateLimitStore));

  // ---------------------------------------------------------------------------
  // Public legal pages (unauthenticated by design)
  // ---------------------------------------------------------------------------
  // Google Play requires an app offering account creation to provide a public
  // web path to delete the account and its data. Someone who uninstalled the app
  // and cannot sign in must still be able to read this, so the pages carry no
  // auth, no script and no external asset. They sit outside `/v1` because they
  // are documents, not API responses.
  const legalConfig = legalConfigFrom(deps.env);
  app.get(
    '/legal',
    handler(async (_req, res) => {
      res.type('html').status(200).send(renderLegalIndex(legalConfig));
    }),
  );
  app.get(
    '/legal/:slug',
    handler(async (req, res) => {
      const slug = req.params.slug;
      const doc = allDocs(legalConfig).find((d) => d.slug === slug);
      if (!doc) throw new AppError('NOT_FOUND', { details: { path: req.path } });
      res.type('html').status(200).send(renderDocPage(legalConfig, doc));
    }),
  );
  app.get('/auth/verify-email', (_req, res) => sendAuthActionPage(res, 'verify-email'));
  app.get('/auth/reset-password', (_req, res) => sendAuthActionPage(res, 'reset-password'));
  const testEmailDelivery = services.emailDelivery;
  if (
    deps.env.nodeEnv === 'test' &&
    deps.env.email.provider === 'mock' &&
    deps.repo.driver === 'memory' &&
    testEmailDelivery instanceof MockEmailDelivery
  ) {
    app.get(
      '/__test/emails',
      handler(async (req, res) => {
        const to = typeof req.query.to === 'string' ? req.query.to.toLowerCase() : '';
        res.json({ emails: testEmailDelivery.messages.filter((message) => message.to === to) });
      }),
    );
  }
  // A store reviewer may fetch `/` directly; send them to the index.
  app.get(
    '/',
    handler(async (_req, res) => {
      res.redirect(302, '/legal');
    }),
  );

  app.use(notFoundHandler());
  app.use(errorHandler());
  return app;
}

/**
 * Builds the legal configuration from the same env the retention job uses, so a
 * published retention period cannot drift away from the enforced one.
 */
export function legalConfigFrom(env: ServerEnv): LegalConfig {
  return {
    appName: env.legal.appName,
    supportEmail: env.legal.supportEmail,
    effectiveDate: env.legal.effectiveDate,
    retention: env.retention,
  };
}

function v1Routes(deps: AppDeps, services: Services, rateLimitStore: RateLimitStore): Router {
  const router = Router();
  const auth = requireAuth(deps.env.localJwtSecret);
  const accountState = requireActiveAccount(deps.repo);
  const userLimit = userRateLimitMiddleware({
    windowMs: 60_000,
    perUserLimit: deps.env.limits.requestsPerMinutePerUser,
    store: rateLimitStore,
  });
  const consent = requireVoiceConsent(deps.repo);
  const emailLimit = authEmailRateLimitMiddleware(rateLimitStore);

  /**
   * The middleware stack every authenticated route shares, in order:
   *
   *   1. requireAuth          — verify the token signature, attach the user id
   *   2. requireActiveAccount — a signature is not enough; deletion must take effect
   *                             immediately, not when the token happens to expire
   *   3. userLimit            — bucket on the *verified* user id, so one account
   *                             cannot outrun its limit and a shared NAT cannot
   *                             lock out unrelated learners
   *
   * Kept as one spread list so a new route cannot accidentally be added with a
   * weaker stack than its neighbours. Logout uses `auth` alone so a learner whose
   * profile is mid-deletion can still end the session. Refresh is rate-limited by
   * the global IP middleware and authenticates with its opaque token, not an expired
   * access token.
   */
  const authed = [auth, accountState, userLimit] as const;

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  router.post(
    '/auth/register',
    emailLimit,
    handler(async (req, res) => {
      const validator = Validator.from(req.body).rejectUnknown([
        'email',
        'password',
        'display_name',
        'accept_terms',
        'accept_privacy_policy',
        'voice_consent',
      ]);
      const email = validator.string('email', { min: 3, max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ });
      const password = validator.string('password', { min: 8, max: 200 });
      const displayName = validator.string('display_name', { max: 60, optional: true });
      const termsAccepted = validator.boolean('accept_terms');
      const privacyPolicyAccepted = validator.boolean('accept_privacy_policy');
      const voiceConsent = validator.boolean('voice_consent', { optional: true });
      validator.done();

      await services.auth.register({
        email: email ?? '',
        password: password ?? '',
        ...(displayName !== undefined ? { displayName } : {}),
        termsAccepted: termsAccepted === true,
        privacyPolicyAccepted: privacyPolicyAccepted === true,
        voiceConsent: voiceConsent ?? false,
      });
      res.status(202).json({
        ok: true,
        message_ar: 'إذا كان البريد يحتاج تحقق، راجع الوارد. للحساب الموجود سجّل الدخول أو اطلب استعادة كلمة المرور.',
        message_en: 'If this address needs verification, check your inbox. For an existing account, sign in or request a password reset.',
      });
    }),
  );

  router.post(
    '/auth/resend-verification',
    emailLimit,
    handler(async (req, res) => {
      const validator = Validator.from(req.body).rejectUnknown(['email']);
      const email = validator.string('email', { min: 3, max: 254 });
      validator.done();
      await services.auth.resendVerification(email ?? '');
      res.status(202).json({
        ok: true,
        message_ar: 'إذا كان البريد يحتاج تحقق، بنرسل رسالة جديدة.',
        message_en: 'If this address needs verification, a new message will be sent.',
      });
    }),
  );

  router.post(
    '/auth/forgot-password',
    emailLimit,
    handler(async (req, res) => {
      const validator = Validator.from(req.body).rejectUnknown(['email']);
      const email = validator.string('email', { min: 3, max: 254 });
      validator.done();
      await services.auth.requestPasswordRecovery(email ?? '');
      res.status(202).json({
        ok: true,
        message_ar: 'إذا كان للحساب بريد مؤكد، بنرسل رابط استعادة.',
        message_en: 'If a verified account exists for this address, a recovery link will be sent.',
      });
    }),
  );

  router.post(
    '/auth/verify-email',
    handler(async (req, res) => {
      const validator = Validator.from(req.body).rejectUnknown(['token']);
      const token = validator.string('token', { min: 32, max: 200 });
      validator.done();
      await services.auth.verifyEmail(token ?? '');
      sendOk(res, { email_verified: true });
    }),
  );

  router.post(
    '/auth/reset-password',
    handler(async (req, res) => {
      const validator = Validator.from(req.body).rejectUnknown(['token', 'password']);
      const token = validator.string('token', { min: 32, max: 200 });
      const password = validator.string('password', { min: 8, max: 200 });
      validator.done();
      await services.auth.resetPassword(token ?? '', password ?? '');
      sendOk(res, { password_reset: true });
    }),
  );

  router.post(
    '/auth/login',
    handler(async (req, res) => {
      const validator = Validator.from(req.body).rejectUnknown(['email', 'password']);
      const email = validator.string('email', { min: 3, max: 254 });
      const password = validator.string('password', { min: 1, max: 200 });
      validator.done();

      const result = await services.auth.login(email ?? '', password ?? '');
      res.status(200).json({ ok: true, ...result });
    }),
  );

  /** The opaque refresh token is the credential; the access token may be expired. */
  router.post(
    '/auth/refresh',
    handler(async (req, res) => {
      const validator = Validator.from(req.body).rejectUnknown(['refresh_token']);
      const refreshToken = validator.string('refresh_token', { min: 16, max: 200 });
      validator.done();
      const result = await services.auth.refresh(refreshToken ?? '');
      res.status(200).json({ ok: true, ...result });
    }),
  );

  router.post(
    '/auth/logout',
    ...authed,
    handler(async (req, res) => {
      await services.auth.logout(requireUser(req).id);
      sendOk(res, { logged_out: true });
    }),
  );

  router.get(
    '/auth/session',
    ...authed,
    handler(async (req, res) => {
      sendOk(res, { profile: await services.auth.publicProfileFor(requireUser(req).id) });
    }),
  );

  // -------------------------------------------------------------------------
  // Profile / onboarding
  // -------------------------------------------------------------------------
  router.get(
    '/profile',
    ...authed,
    handler(async (req, res) => {
      sendOk(res, { profile: await services.auth.publicProfileFor(requireUser(req).id) });
    }),
  );

  /**
   * Profile update, and the onboarding completion endpoint.
   *
   * When the onboarding fields arrive together for the first time,
   * `onboarding_completed_at` is stamped, which is what moves the app from the
   * onboarding flow to the home screen. Stamping it server-side means a reinstall
   * cannot skip onboarding by replaying a client flag.
   */
  router.patch(
    '/profile',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown([
        'display_name',
        'english_level',
        'learning_goal',
        'daily_goal_minutes',
        'preferred_arabic_voice',
        'preferred_english_voice',
        'complete_onboarding',
      ]);
      const displayName = validator.string('display_name', { max: 60, optional: true });
      const englishLevel = validator.enum('english_level', ENGLISH_LEVELS, { optional: true });
      const learningGoal = validator.enum('learning_goal', LEARNING_GOALS, { optional: true });
      const dailyGoal = validator.number('daily_goal_minutes', { optional: true });
      const arabicVoice = validator.string('preferred_arabic_voice', { max: 64, optional: true });
      const englishVoice = validator.string('preferred_english_voice', { max: 64, optional: true });
      const completeOnboarding = validator.boolean('complete_onboarding', { optional: true });
      validator.done();

      if (dailyGoal !== undefined && !DAILY_GOALS.includes(dailyGoal as DailyGoalMinutes)) {
        throw new AppError('VALIDATION_FAILED', {
          messageAr: 'الهدف اليومي لازم يكون 5 أو 10 أو 15 دقيقة.',
          messageEn: 'daily_goal_minutes must be one of 5, 10, 15',
          details: { field: 'daily_goal_minutes', allowed: [...DAILY_GOALS] },
        });
      }

      const patch: ProfileUpdate = {};
      if (displayName !== undefined) patch.displayName = displayName;
      if (englishLevel !== undefined) patch.englishLevel = englishLevel;
      if (learningGoal !== undefined) patch.learningGoal = learningGoal;
      if (dailyGoal !== undefined) patch.dailyGoalMinutes = dailyGoal as DailyGoalMinutes;
      if (arabicVoice !== undefined) patch.preferredArabicVoice = arabicVoice;
      if (englishVoice !== undefined) patch.preferredEnglishVoice = englishVoice;

      if (completeOnboarding === true) {
        const current = await services.auth.profileFor(user.id);
        // Only stamp once: the completion time is a fact about the learner's first
        // onboarding, not about the last profile edit.
        if (current.onboardingCompletedAt === null) patch.onboardingCompletedAt = services.now().toISOString();
      }

      const updated = await deps.repo.profiles.update(user.id, patch);
      if (!updated) throw new AppError('NOT_FOUND', { messageAr: 'ما لقينا الملف الشخصي.', messageEn: 'profile not found' });
      // Re-read through the service so the consent flag reflects the live record
      // rather than a stale value captured before the update.
      sendOk(res, { profile: await services.auth.publicProfileFor(user.id) });
    }),
  );

  // -------------------------------------------------------------------------
  // Lessons
  // -------------------------------------------------------------------------
  router.get(
    '/lessons',
    ...authed,
    handler(async (_req, res) => {
      // Content is sent whole: a lesson is a few kilobytes and the app must work
      // offline once opened, so there is no second round trip per step.
      sendOk(res, { lessons: await services.lessons.listPublished() });
    }),
  );

  router.get(
    '/lessons/today',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const profile = await services.auth.profileFor(user.id);
      sendOk(res, await services.lessons.todayLesson(user.id, profile.learningGoal));
    }),
  );

  router.get(
    '/lessons/:lessonId',
    ...authed,
    handler(async (req, res) => {
      sendOk(res, { lesson: await services.lessons.getById(requireParam(req, 'lessonId')) });
    }),
  );

  router.post(
    '/lessons/:lessonId/attempts',
    ...authed,
    handler(async (req, res) => {
      const attempt = await services.lessons.startAttempt(requireUser(req).id, requireParam(req, 'lessonId'));
      res.status(201).json({ ok: true, attempt });
    }),
  );

  router.post(
    '/attempts/:attemptId/complete',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown(['comprehension_score', 'save_vocabulary']);
      const score = validator.number('comprehension_score', { min: 0, max: 1, optional: true });
      const saveVocabulary = validator.boolean('save_vocabulary', { optional: true });
      validator.done();

      const result = await services.lessons.completeAttempt({
        userId: user.id,
        attemptId: requireParam(req, 'attemptId'),
        ...(score !== undefined ? { comprehensionScore: score } : {}),
        saveVocabulary: saveVocabulary ?? true,
      });
      sendOk(res, { ...result });
    }),
  );

  // -------------------------------------------------------------------------
  // Voices (settings screen)
  // -------------------------------------------------------------------------
  router.get(
    '/voices',
    auth,
    accountState,
    userLimit,
    consent,
    handler(async (_req, res) => {
      // Only sendable fields: the provider returns more, and the client has no use
      // for account internals.
      const [selection, all] = await Promise.all([services.voices.select(), services.voices.list()]);
      sendOk(res, {
        voices: all.map((voice) => ({
          id: voice.id,
          label: voice.label,
          dialect: voice.dialect,
          languages: voice.languages,
          gender: voice.gender ?? null,
        })),
        default_arabic_voice_id: selection.arabic.id,
        default_english_voice_id: selection.english.id,
        arabic_is_saudi: selection.arabicIsSaudi,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Text-to-speech (cache-first)
  // -------------------------------------------------------------------------
  /**
   * No `Idempotency-Key` here on purpose: TTS is keyed by its own content hash, so
   * a retry of the same text hits the cache and costs 0 credits. That is a stronger
   * guarantee than a keyed replay, and it also serves a *different* learner for free.
   *
   * The quota is reserved *before* synthesis, so a learner who is out of allowance
   * never causes a provider call at all.
   */
  router.post(
    '/tts',
    auth,
    accountState,
    userLimit,
    consent,
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown(['text', 'voice_id', 'script', 'namespace']);
      const text = validator.string('text', { min: 1, max: deps.env.limits.maxTtsChars });
      const voiceId = validator.string('voice_id', { max: 64, optional: true });
      const script = validator.enum('script', ['ar', 'en'] as const, { optional: true }) ?? 'en';
      const namespace = validator.slug('namespace', { optional: true }) ?? 'adhoc';
      validator.done();

      const trimmed = (text ?? '').trim();
      const resolvedVoiceId = voiceId ?? (await services.voices.selectFor(script)).id;
      const creditsEstimated = estimateTtsCredits([...trimmed].length);

      const reservation = await services.usage.reserve({
        userId: user.id,
        feature: 'tts',
        quantity: [...trimmed].length,
        creditsEstimated,
        provider: deps.provider.name,
        model: 'nebula',
        requestId: req.ctx.requestId,
      });
      // Throws QUOTA_EXHAUSTED / PROVIDER_UNAVAILABLE. No provider call has been
      // made at this point, so a refused request costs nothing.
      const event = services.usage.assertAllowed(reservation);

      let result;
      try {
        result = await services.tts.synthesize({
          text: trimmed,
          voiceId: resolvedVoiceId,
          namespace,
          userId: user.id,
          requestId: req.ctx.requestId,
          feature: 'tts',
          maxChars: deps.env.limits.maxTtsChars,
        });
      } catch (error) {
        // A failed synthesis releases the allowance; the learner is not charged
        // for our outage.
        await services.usage.settleFailure(event.id);
        throw error;
      }

      await services.usage.settleSuccess(event.id, {
        cacheHit: result.cacheHit,
        creditsEstimated: result.cacheHit ? 0 : result.creditsEstimated,
      });

      res.setHeader('content-type', result.contentType);
      res.setHeader('x-tts-cache', result.cacheHit ? 'hit' : 'miss');
      res.setHeader('x-tts-credits', String(result.cacheHit ? 0 : result.creditsEstimated));
      res.setHeader('x-tts-duration', String(durationSecondsOf(result.audio)));
      res.status(200).send(Buffer.from(result.audio));
    }),
  );

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------
  /**
   * Transcription plus bounded evaluation. This is the one route that spends real
   * credits on uncacheable input, so it carries the idempotency guard: a mobile
   * retry on a flaky connection must not bill twice.
   */
  router.post(
    '/speaking/transcribe',
    auth,
    accountState,
    userLimit,
    consent,
    idempotencyGuard(deps.repo, 'POST /v1/speaking/transcribe'),
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown([
        'prompt_slug',
        'audio_base64',
        'mime_type',
        'duration_seconds',
        'lesson_attempt_id',
      ]);
      const promptSlug = validator.slug('prompt_slug');
      const audioBase64 = validator.string('audio_base64', { optional: true });
      const mimeType = validator.string('mime_type', { max: 64, optional: true });
      const durationSeconds = validator.number('duration_seconds', { min: 0.1, max: 600, optional: true });
      const lessonAttemptId = validator.uuid('lesson_attempt_id', { optional: true });
      validator.done();

      const { prompt } = await services.lessons.findPromptBySlug(promptSlug ?? '');

      // A client may only attach an attempt that belongs to it. The id is a plain
      // foreign key, so without this check learner A could reference learner B's
      // attempt (the service-role client bypasses RLS). 404, not 403, so the
      // response does not confirm that someone else's attempt id exists.
      if (lessonAttemptId) {
        const owned = await deps.repo.lessonAttempts.findById(lessonAttemptId);
        if (!owned || owned.userId !== user.id) {
          throw new AppError('NOT_FOUND', {
            messageAr: 'ما لقينا هذا الدرس.',
            messageEn: 'lesson attempt not found for this account',
          });
        }
      }

      // Bounds (size, duration, container) are enforced here, before any provider
      // call, so a malformed upload cannot spend credits.
      const decoded = decodeAudio(audioBase64, mimeType, durationSeconds, {
        maxBytes: deps.env.limits.maxAudioBytes,
        maxDurationSeconds: deps.env.limits.maxAudioDurationSeconds,
      });

      const outcome = await services.speaking.transcribeAndEvaluate({
        userId: user.id,
        lessonAttemptId: lessonAttemptId ?? null,
        prompt,
        audio: decoded.bytes,
        durationSeconds: decoded.durationSeconds,
        requestId: req.ctx.requestId,
        idempotencyKey: readIdempotencyKey(req),
      });

      const body = JSON.stringify({ ok: true, ...outcome });
      await rememberResponse(deps.repo, 'POST /v1/speaking/transcribe', user.id, readIdempotencyKey(req), req.body, body);
      res.status(200).type('application/json').send(body);
    }),
  );

  /** Typed practice: same evaluation rules, no provider call, no credits. */
  router.post(
    '/speaking/evaluate',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown(['prompt_slug', 'transcript']);
      const promptSlug = validator.slug('prompt_slug');
      const transcript = validator.string('transcript', { min: 1, max: 1000 });
      validator.done();

      const { prompt } = await services.lessons.findPromptBySlug(promptSlug ?? '');
      const evaluation = await services.speaking.evaluateTranscript({
        userId: user.id,
        prompt,
        transcript: transcript ?? '',
      });
      sendOk(res, { evaluation });
    }),
  );

  router.get(
    '/speaking/history',
    ...authed,
    handler(async (req, res) => {
      const validator = Validator.from(req.query).rejectUnknown(['limit']);
      const limit = validator.number('limit', { min: 1, max: 100, optional: true }) ?? 20;
      validator.done();
      sendOk(res, { attempts: await services.speaking.listRecent(requireUser(req).id, limit) });
    }),
  );

  // -------------------------------------------------------------------------
  // Progress, vocabulary, usage
  // -------------------------------------------------------------------------
  router.get(
    '/progress',
    ...authed,
    handler(async (req, res) => {
      sendOk(res, { progress: await services.progress.forUser(requireUser(req).id) });
    }),
  );

  router.get(
    '/vocabulary',
    ...authed,
    handler(async (req, res) => {
      sendOk(res, { items: await deps.repo.vocabulary.listForUser(requireUser(req).id) });
    }),
  );

  router.post(
    '/vocabulary/:itemId/review',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown(['review_state', 'next_review_at']);
      const reviewState = validator.enum('review_state', ['new', 'learning', 'review', 'mastered'] as const) ?? 'learning';
      const nextReviewAt = validator.string('next_review_at', { max: 40, optional: true });
      validator.done();

      // Scoped by user id: a guessed item id must not let one learner touch
      // another learner's vocabulary.
      const updated = await deps.repo.vocabulary.setReviewState(
        requireParam(req, 'itemId'),
        user.id,
        reviewState,
        nextReviewAt ?? null,
      );
      if (!updated) throw new AppError('NOT_FOUND', { messageAr: 'ما لقينا هذه الكلمة.', messageEn: 'vocabulary item not found for this user' });
      sendOk(res, { item: updated });
    }),
  );

  router.get(
    '/usage',
    ...authed,
    handler(async (req, res) => {
      sendOk(res, { usage: await services.usage.summary(requireUser(req).id) });
    }),
  );

  // -------------------------------------------------------------------------
  // Account deletion
  // -------------------------------------------------------------------------
  /**
   * Deletion request. Two-phase: sessions are revoked and the profile is hidden
   * immediately, then the retention job purges the rows after the grace period.
   */
  router.delete(
    '/account',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const result = await services.auth.requestDeletion(user.id);
      req.ctx.logger.info('route.account.deletion_requested', { userId: user.id });
      sendOk(res, {
        deletion_requested: true,
        ...result,
        note_ar: 'حُذفت جلستك. راح نمسح بياناتك نهائياً بعد انتهاء المدة.',
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Consent withdrawal (privacy requirement: withdrawable at any time)
  // -------------------------------------------------------------------------
  router.post(
    '/consent/withdraw',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown(['consent_type']);
      const consentType = validator.enum('consent_type', ['voice_processing'] as const);
      validator.done();

      // Only voice processing is withdrawable in-app today; terms and privacy are
      // accepted implicitly by continuing to use the account, and deleting the
      // account is how they end.
      await deps.repo.consents.withdraw(user.id, consentType ?? 'voice_processing', services.now().toISOString());
      req.ctx.logger.info('route.consent.withdrawn', { userId: user.id, consentType });
      sendOk(res, { withdrawn: true, voice_processing_consent: false });
    }),
  );

  // Re-granting is the counterpart of withdrawal. Without it, a learner who
  // withdraws voice consent once is permanently locked out of the core exercise,
  // which is a worse outcome than an explicit opt-in.
  router.post(
    '/consent/grant',
    ...authed,
    handler(async (req, res) => {
      const user = requireUser(req);
      const validator = Validator.from(req.body).rejectUnknown(['consent_type']);
      const consentType = validator.enum('consent_type', ['voice_processing'] as const);
      validator.done();

      // `record` replaces a withdrawn row of the same type instead of appending a
      // duplicate, so at most one active voice consent exists per user.
      await deps.repo.consents.record(
        user.id,
        consentType ?? 'voice_processing',
        POLICY_VERSION,
        services.now().toISOString(),
      );
      req.ctx.logger.info('route.consent.granted', { userId: user.id, consentType });
      sendOk(res, { granted: true, voice_processing_consent: true });
    }),
  );

  return router;
}

export type { CtxRequest };