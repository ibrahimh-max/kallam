/**
 * Authentication service.
 *
 * One rule shapes this file: identity is derived from a verified token, never from
 * a client-supplied user id (build (1).md §7 "Do not trust client-supplied user IDs").
 *
 * Flow:
 *   register  -> create auth row + profile + consents in one logical operation
 *   login     -> constant-ish work whether or not the email exists
 *   refresh   -> rotate the opaque refresh token (old one stops working)
 *   logout    -> clear the stored hash
 *
 * The service returns tokens and a public profile; it never returns the password
 * hash, the refresh hash, or anything derived from the HUMAIN key.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import { toPublicProfile, type ConsentType, type Profile, type PublicProfile } from '../../domain/models.ts';
import type { Repository } from '../../repositories/Repository.ts';
import { EmailDeliveryError, type EmailDelivery } from './EmailDelivery.ts';
import {
  assertEmailAcceptable,
  assertPasswordAcceptable,
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  verifyPassword,
} from '../../security/tokens.ts';

/** Bump when the consent text changes; stored with each grant for auditability. */
export const POLICY_VERSION = '2026-11-01';

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
}

export interface AuthResult {
  tokens: AuthTokens;
  profile: PublicProfile;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
  termsAccepted: boolean;
  privacyPolicyAccepted: boolean;
  /**
   * Explicit consent to third-party voice processing. It is optional at sign-up
   * and must be granted before microphone-backed features can run.
   */
  voiceConsent: boolean;
}

const ACCESS_TTL_SECONDS = 15 * 60;
const ABSENT_ACCOUNT_PASSWORD_HASH = hashPassword('absent-account-placeholder');

export class AuthService {
  private readonly repo: Repository;
  private readonly jwtSecret: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly emailDelivery: EmailDelivery;
  private readonly publicBaseUrl: string;

  constructor(
    repo: Repository,
    jwtSecret: string,
    logger: Logger,
    emailDelivery: EmailDelivery,
    publicBaseUrl: string,
    now: () => Date = () => new Date(),
  ) {
    this.repo = repo;
    this.jwtSecret = jwtSecret;
    this.logger = logger;
    this.emailDelivery = emailDelivery;
    this.publicBaseUrl = publicBaseUrl;
    this.now = now;
  }

  private tokensFor(userId: string, email: string): AuthTokens {
    return {
      access_token: issueAccessToken(userId, email, this.jwtSecret, Math.floor(this.now().getTime() / 1000)),
      refresh_token: createRefreshToken().token,
      expires_in: ACCESS_TTL_SECONDS,
      token_type: 'Bearer',
    };
  }

  /**
   * Register. Required policy acknowledgements and any explicit voice consent are
   * written before profile creation so the account's stored state matches the
   * learner's choice from the first response.
   */
  async register(input: RegisterInput): Promise<void> {
    assertEmailAcceptable(input.email);
    assertPasswordAcceptable(input.password);
    this.requireEmailDelivery();
    if (!input.termsAccepted || !input.privacyPolicyAccepted) {
      throw new AppError('CONSENT_REQUIRED', {
        messageAr: 'لازم توافق على شروط الاستخدام وسياسة الخصوصية لإنشاء الحساب.',
        messageEn: 'acceptance of the terms of service and privacy policy is required',
        details: { fields: ['accept_terms', 'accept_privacy_policy'] },
      });
    }
    const passwordHash = hashPassword(input.password);
    const existing = await this.repo.auth.findByEmail(input.email);
    if (existing) return;

    const user = await this.repo.auth.createUser(input.email, passwordHash);
    let verificationUrl: string;
    try {
      const at = this.now().toISOString();
      const consentTypes: ConsentType[] = ['terms_of_service', 'privacy_policy'];
      if (input.voiceConsent) consentTypes.unshift('voice_processing');
      for (const consentType of consentTypes) {
        await this.repo.consents.record(user.id, consentType, POLICY_VERSION, at);
      }

      await this.repo.profiles.create({
        id: user.id,
        displayName: input.displayName ?? null,
      });
      verificationUrl = await this.createActionUrl(user.id, 'verify_email', '/auth/verify-email', 24 * 60 * 60_000);
    } catch (error) {
      try {
        await this.repo.profiles.purge(user.id);
      } catch (cleanupError) {
        this.logger.error('auth.register_cleanup_failed', { userId: user.id });
        throw new AppError('INTERNAL', {
          messageEn: 'registration failed and partial account cleanup also failed',
          cause: new AggregateError([error, cleanupError]),
        });
      }
      throw error;
    }

    this.sendEmail(user.id, 'verify_email', () => this.emailDelivery.sendVerification(user.email, verificationUrl));
    this.logger.info('auth.register', { userId: user.id });
  }

  async login(email: string, password: string): Promise<AuthResult> {
    assertEmailAcceptable(email);
    const user = await this.repo.auth.findByEmail(email);

    // Run a hash comparison even when the user is absent so the response time does
    // not distinguish "no such account" from "wrong password".
    const storedHash = user?.passwordHash ?? ABSENT_ACCOUNT_PASSWORD_HASH;
    const passwordOk = verifyPassword(password, storedHash);

    if (!user || !passwordOk || user.emailVerifiedAt === null) {
      this.logger.warn('auth.login_failed', { emailPresent: email.length > 0 });
      throw new AppError('UNAUTHORIZED', {
        messageAr: 'البريد أو كلمة المرور غير صحيحة.',
        messageEn: 'invalid credentials',
      });
    }

    const profile = await this.repo.profiles.findById(user.id);
    if (!profile || profile.deletedAt !== null) {
      throw new AppError('UNAUTHORIZED', { messageEn: 'account has been deleted or deactivated' });
    }

    const { token, hash } = createRefreshToken();
    await this.repo.auth.setRefreshTokenHash(user.id, hash);
    this.logger.info('auth.login', { userId: user.id });
    const voiceConsentGranted = await this.repo.consents.hasActiveVoiceConsent(user.id);
    return {
      tokens: { ...this.tokensFor(user.id, user.email), refresh_token: token },
      profile: toPublicProfile(profile, voiceConsentGranted),
    };
  }

  async resendVerification(email: string): Promise<void> {
    assertEmailAcceptable(email);
    this.requireEmailDelivery();
    const user = await this.repo.auth.findByEmail(email);
    if (!user || user.emailVerifiedAt !== null) return;
    const actionUrl = await this.createActionUrl(user.id, 'verify_email', '/auth/verify-email', 24 * 60 * 60_000);
    this.sendEmail(user.id, 'verify_email', () => this.emailDelivery.sendVerification(user.email, actionUrl));
  }

  async requestPasswordRecovery(email: string): Promise<void> {
    assertEmailAcceptable(email);
    this.requireEmailDelivery();
    const user = await this.repo.auth.findByEmail(email);
    if (!user || user.emailVerifiedAt === null) return;
    const actionUrl = await this.createActionUrl(user.id, 'password_recovery', '/auth/reset-password', 60 * 60_000);
    this.sendEmail(user.id, 'password_recovery', () => this.emailDelivery.sendPasswordRecovery(user.email, actionUrl));
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.repo.auth.consumeActionToken(
      this.hashActionToken(token),
      'verify_email',
      this.now().toISOString(),
    );
    if (!userId) throw this.invalidActionToken();
    await this.repo.auth.markEmailVerified(userId, this.now().toISOString());
    this.logger.info('auth.email_verified', { userId });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    assertPasswordAcceptable(password);
    const userId = await this.repo.auth.consumeActionToken(
      this.hashActionToken(token),
      'password_recovery',
      this.now().toISOString(),
    );
    if (!userId) throw this.invalidActionToken();
    await this.repo.auth.updatePasswordHash(userId, hashPassword(password));
    this.logger.info('auth.password_reset', { userId });
  }

  private requireEmailDelivery(): void {
    if (!this.emailDelivery.configured) {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        messageAr: 'خدمة البريد غير مهيأة حالياً. حاول لاحقاً.',
        messageEn: 'email delivery is not configured',
      });
    }
  }

  private async createActionUrl(
    userId: string,
    purpose: 'verify_email' | 'password_recovery',
    path: string,
    lifetimeMs: number,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.repo.auth.createActionToken(
      userId,
      purpose,
      this.hashActionToken(token),
      new Date(now.getTime() + lifetimeMs).toISOString(),
      now.toISOString(),
    );
    const url = new URL(path, this.publicBaseUrl);
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  }

  private hashActionToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private invalidActionToken(): AppError {
    return new AppError('UNAUTHORIZED', {
      messageAr: 'الرابط غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً.',
      messageEn: 'invalid or expired action token',
    });
  }

  private sendEmail(userId: string, purpose: 'verify_email' | 'password_recovery', send: () => Promise<void>): void {
    void send().catch((error: unknown) => {
      this.logger.error('auth.email_delivery_failed', {
        userId,
        purpose,
        status: error instanceof EmailDeliveryError ? error.status : null,
      });
    });
  }

  /** Rotating refresh: a valid opaque token is sufficient after access-token expiry. */
  async refresh(refreshToken: string): Promise<AuthResult> {
    if (!refreshToken) throw new AppError('UNAUTHORIZED', { messageEn: 'refresh token required' });
    const { token, hash } = createRefreshToken();
    const user = await this.repo.auth.rotateRefreshToken(hashRefreshToken(refreshToken), hash);
    if (!user) {
      this.logger.warn('auth.refresh_rejected', { reason: 'token_mismatch' });
      throw new AppError('UNAUTHORIZED', { messageAr: 'انتهت الجلسة. سجّل دخول من جديد.', messageEn: 'refresh token is not the current one' });
    }
    const profile = await this.repo.profiles.findById(user.id);
    if (!profile || profile.deletedAt !== null) {
      await this.repo.auth.setRefreshTokenHash(user.id, null);
      throw new AppError('UNAUTHORIZED', { messageEn: 'account has been deleted' });
    }
    const voiceConsentGranted = await this.repo.consents.hasActiveVoiceConsent(user.id);
    return {
      tokens: { ...this.tokensFor(user.id, user.email), refresh_token: token },
      profile: toPublicProfile(profile, voiceConsentGranted),
    };
  }

  async logout(userId: string): Promise<void> {
    await this.repo.auth.setRefreshTokenHash(userId, null);
    this.logger.info('auth.logout', { userId });
  }

  /**
   * Account deletion request. Two-phase on purpose:
   *   - now: profile marked deleted, sessions revoked, consents withdrawn. The app
   *     can no longer authenticate as this user.
   *   - after the grace period: the retention job purges the rows.
   * A grace period is what makes an accidental deletion recoverable during beta.
   */
  async requestDeletion(userId: string): Promise<{ purge_after_days: number; profile_purged: boolean }> {
    const at = this.now().toISOString();
    await this.repo.profiles.markDeleted(userId, at);
    await this.repo.auth.setRefreshTokenHash(userId, null);
    for (const consentType of ['voice_processing', 'terms_of_service', 'privacy_policy'] as ConsentType[]) {
      await this.repo.consents.withdraw(userId, consentType, at);
    }
    this.logger.info('auth.deletion_requested', { userId });
    return { purge_after_days: 30, profile_purged: false };
  }

  async profileFor(userId: string): Promise<Profile> {
    const profile = await this.repo.profiles.findById(userId);
    if (!profile) throw new AppError('NOT_FOUND', { messageEn: 'profile not found' });
    return profile;
  }

  /**
   * The profile as the app should see it, including whether voice consent is
   * active *right now*. Both are read here so the two can never be served from
   * different moments, which would let the settings screen show a consent switch
   * that disagrees with the server that enforces it.
   */
  async publicProfileFor(userId: string): Promise<PublicProfile> {
    const profile = await this.profileFor(userId);
    const voiceConsentGranted = await this.repo.consents.hasActiveVoiceConsent(userId);
    return toPublicProfile(profile, voiceConsentGranted);
  }
}
