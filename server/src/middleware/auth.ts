/**
 * Authentication and consent middleware.
 *
 * `requireAuth` is the only place a request becomes "identified". It reads the
 * access token from the Authorization header (never a query parameter, so tokens
 * cannot leak into access logs or referrers) and attaches the verified user id.
 *
 * `requireVoiceConsent` is separate because consent can be withdrawn while a
 * session is still valid: the speaking routes check it per request rather than
 * once at login.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError, toErrorBody } from '../core/errors.ts';
import type { CtxRequest } from '../core/http.ts';
import type { Repository } from '../repositories/Repository.ts';
import { verifyAccessToken } from '../security/tokens.ts';

export function requireAuth(jwtSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = (req as CtxRequest).ctx;
    const header = req.header('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      const error = new AppError('UNAUTHORIZED');
      res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
      return;
    }
    const token = header.slice(7).trim();
    try {
      const claims = verifyAccessToken(token, jwtSecret);
      (req as CtxRequest).user = { id: claims.sub, email: claims.email };
      next();
    } catch (err) {
      const error = err instanceof AppError ? err : new AppError('UNAUTHORIZED');
      ctx?.logger.warn('auth.token_rejected', { code: error.code });
      res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
    }
  };
}

/**
 * Account-state gate.
 *
 * A valid signature is not sufficient: account deletion is two-phase, and the
 * access token stays cryptographically valid for its full 15-minute lifetime
 * afterwards. Without this check, "sessions are revoked immediately" would be a
 * comment rather than a fact — a deleted learner could keep reading and writing
 * until the token expired.
 *
 * Costs one primary-key lookup per authenticated request, which is the price of
 * revocation actually taking effect. Fails closed: if the lookup errors, the
 * request is rejected rather than allowed.
 */
export function requireActiveAccount(repo: Repository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = (req as CtxRequest).ctx;
    const userId = (req as CtxRequest).user?.id;
    if (!userId) {
      const error = new AppError('UNAUTHORIZED');
      res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
      return;
    }
    try {
      const profile = await repo.profiles.findById(userId);
      if (!profile) {
        ctx?.logger.warn('auth.account_inactive', { userId });
        const error = new AppError('UNAUTHORIZED', {
          messageAr: 'انتهت الجلسة. سجّل دخول من جديد.',
          messageEn: 'account is deleted or no longer active',
        });
        res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
        return;
      }
      next();
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.status).json(toErrorBody(err, ctx?.requestId ?? 'unknown'));
        return;
      }
      ctx?.logger.error('account state lookup failed', { detail: err instanceof Error ? err.message : 'unknown' });
      const error = new AppError('INTERNAL', { messageEn: 'could not verify account state' });
      res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
    }
  };
}

/**
 * Consent gate for voice-processing routes.
 *
 * Fails closed: if the consent lookup itself errors, the request is rejected
 * rather than allowed, because the alternative is processing a learner's voice
 * without a recorded permission.
 */
export function requireVoiceConsent(repo: Repository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = (req as CtxRequest).ctx;
    const userId = (req as CtxRequest).user?.id;
    if (!userId) {
      const error = new AppError('UNAUTHORIZED');
      res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
      return;
    }
    try {
      const granted = await repo.consents.hasActiveVoiceConsent(userId);
      if (!granted) {
        const error = new AppError('CONSENT_REQUIRED');
        res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
        return;
      }
      next();
    } catch (err) {
      ctx?.logger.error('consent lookup failed', { detail: err instanceof Error ? err.message : 'unknown' });
      const error = new AppError('INTERNAL', { messageEn: 'could not verify voice-processing consent' });
      res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
    }
  };
}
