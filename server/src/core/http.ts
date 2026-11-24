/**
 * HTTP plumbing shared by every route.
 *
 * Kept deliberately small: a request id, a typed context, a wrapper that turns
 * thrown AppErrors into the documented error body, and a body-size guard. Route
 * handlers stay thin — they validate, call a service, and return.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, toErrorBody } from './errors.ts';
import type { Logger } from './logger.ts';

export interface AuthedUser {
  id: string;
  email: string | undefined;
}

export interface RequestContext {
  requestId: string;
  logger: Logger;
  /** Present only on authenticated routes (set by requireAuth). */
  user: AuthedUser | undefined;
  /** Set when the route requires consent and the check passed. */
  startedAt: number;
}

/** Express request augmented with our context. */
export interface CtxRequest extends Request {
  ctx: RequestContext;
  user?: AuthedUser;
}

export function createContext(logger: Logger, req: Request): RequestContext {
  const headerId = req.header('x-request-id');
  // Trust only a shape we generated; a client-supplied id must not be able to
  // forge log correlation with arbitrary text.
  const requestId = headerId && /^[A-Za-z0-9-]{6,64}$/.test(headerId) ? headerId : randomUUID();
  return { requestId, logger: logger.child({ requestId }), user: undefined, startedAt: Date.now() };
}

export type Handler = (req: CtxRequest, res: Response) => Promise<void> | void;

/** Wraps a handler so a rejected promise reaches the error middleware. */
export function handler(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as CtxRequest, res)).catch(next);
  };
}

/** Attaches a context to every request and echoes the request id back. */
export function contextMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = createContext(logger, req);
    (req as CtxRequest).ctx = ctx;
    res.setHeader('x-request-id', ctx.requestId);
    next();
  };
}

export function notFoundHandler() {
  return (req: Request, res: Response): void => {
    const ctx = (req as CtxRequest).ctx;
    const error = new AppError('NOT_FOUND', { details: { path: req.path } });
    res.status(error.status).json(toErrorBody(error, ctx?.requestId ?? 'unknown'));
  };
}

/**
 * Terminal error handler.
 *
 * Contract with the client: `error.code` decides behaviour, `message_ar` is what
 * the learner reads. Provider messages, stack traces and secrets never appear —
 * the full detail goes to the server log under the same request id.
 */
export function errorHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const ctx = (req as CtxRequest).ctx;
    const requestId = ctx?.requestId ?? 'unknown';

    if (err instanceof AppError) {
      if (err.status >= 500) {
        ctx?.logger.error('request failed', { code: err.code, status: err.status, detail: err.messageEn, details: err.details });
      } else {
        ctx?.logger.warn('request rejected', { code: err.code, status: err.status, details: err.details });
      }
      res.status(err.status).json(toErrorBody(err, requestId));
      return;
    }

    // Express body-parser signals oversize bodies with a typed error.
    const asRecord = err as { type?: string; status?: number } | null;
    if (asRecord && asRecord.type === 'entity.too.large') {
      const tooLarge = new AppError('AUDIO_TOO_LARGE');
      ctx?.logger.warn('payload too large', { status: 413 });
      res.status(tooLarge.status).json(toErrorBody(tooLarge, requestId));
      return;
    }
    if (asRecord && typeof asRecord.status === 'number' && asRecord.status === 400 && asRecord.type === 'entity.parse.failed') {
      const badJson = new AppError('VALIDATION_FAILED', { messageAr: 'صيغة الطلب غير صحيحة.' });
      res.status(badJson.status).json(toErrorBody(badJson, requestId));
      return;
    }

    // Any other body-parser / transport error that already carries a 4xx status is
    // the client's fault and must not be reported as 500. Concretely: a request sent
    // with `content-encoding: gzip` but a plain body makes body-parser throw
    // `{ type: 'encoding.unsupported', status: 415 }`, which previously fell through
    // to INTERNAL — a misleading 500 plus a spurious "unhandled error" log line.
    if (asRecord && typeof asRecord.status === 'number' && asRecord.status >= 400 && asRecord.status < 500) {
      const clientError = new AppError('VALIDATION_FAILED', {
        messageAr: 'تعذّر قراءة الطلب. تحقّق من صيغته وحاول مرة ثانية.',
        messageEn: `malformed request rejected at the HTTP layer (${asRecord.status})`,
      });
      ctx?.logger.warn('request rejected at http layer', { status: asRecord.status, type: asRecord.type });
      res.status(asRecord.status).json(toErrorBody(clientError, requestId));
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    ctx?.logger.error('unhandled error', { detail: message, stack: err instanceof Error ? err.stack?.split('\n').slice(0, 4).join(' | ') : undefined });
    const internal = new AppError('INTERNAL');
    res.status(internal.status).json(toErrorBody(internal, requestId));
  };
}

/**
 * `ok` wrapper keeps every success body shaped the same way.
 *
 * The body is `object`, not `Record<string, unknown>`: the API returns typed
 * payloads (`Progress`, `LessonWithProgress`, ...) and an interface has no implicit
 * index signature. Narrowing the parameter would force every route to cast its
 * response, which is exactly the kind of cast that hides a real shape error.
 */
export function sendOk(res: Response, body: object): void {
  res.status(200).json({ ok: true, ...body });
}

export function requireUser(req: CtxRequest): AuthedUser {
  if (!req.user) throw new AppError('UNAUTHORIZED');
  return req.user;
}

/**
 * Reads a required path parameter.
 *
 * Express types `req.params.x` as `string | string[]` (a repeated segment is
 * possible) and as possibly undefined for a malformed URL. The previous
 * `?? ''` pattern turned that into a lookup for a blank id, which reports
 * NOT_FOUND for what is really a bad request and hides the real cause. A missing
 * or repeated segment is a validation failure, and it says which segment.
 */
export function requireParam(req: CtxRequest, name: string): string {
  const raw: unknown = req.params[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('VALIDATION_FAILED', {
      messageAr: 'الرابط غير صحيح.',
      messageEn: `missing or malformed path parameter: ${name}`,
      details: { field: name },
    });
  }
  return raw;
}
