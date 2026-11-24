/**
 * Tokens and password hashing.
 *
 * Choices, with the reason each one is the safer default here:
 *  - Access token: short-lived (15 min) HS256 JWT, verified server-side. Kept
 *    short because a mobile app cannot be trusted to erase a leaked token.
 *  - Refresh token: opaque 32-byte random value, stored only as a SHA-256 hash.
 *    Opaque, not a JWT, so it can be revoked by overwriting one column.
 *  - Passwords: scrypt with a per-user salt. scrypt is memory-hard and in Node's
 *    standard library, so no extra native dependency is required.
 *  - Comparison is `timingSafeEqual` on equal-length buffers, so login does not
 *    leak information through response timing.
 *
 * The API issues and verifies these tokens in every repository mode. Supabase
 * Auth sessions are not currently used by the mobile app or backend.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { AppError } from '../core/errors.ts';

export interface AccessTokenClaims {
  sub: string;
  email?: string;
  iat: number;
  exp: number;
  iss: string;
  typ: 'access';
  /** Supabase-issued tokens carry a role; we keep it for parity. */
  role?: string;
}

const ISSUER = 'saudi-english-tutor';
const ACCESS_TTL_SECONDS = 15 * 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueAccessToken(userId: string, email: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: AccessTokenClaims = {
    sub: userId,
    ...(email ? { email } : {}),
    iat: nowSeconds,
    exp: nowSeconds + ACCESS_TTL_SECONDS,
    iss: ISSUER,
    typ: 'access',
  };
  const body = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

/**
 * Verify an access token.
 *
 * Order matters: signature first, then claims. Checking `exp` before the
 * signature would let an attacker probe token lifetimes with forged tokens.
 */
export function verifyAccessToken(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError('UNAUTHORIZED', { messageEn: 'malformed token' });
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`, secret);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new AppError('UNAUTHORIZED', { messageEn: 'bad token signature' });
  }

  let decodedHeader: { alg?: string; typ?: string };
  let claims: AccessTokenClaims;
  try {
    decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as typeof decodedHeader;
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessTokenClaims;
  } catch {
    throw new AppError('UNAUTHORIZED', { messageEn: 'token payload is not JSON' });
  }

  // Reject `alg: none` / algorithm confusion explicitly rather than trusting the header.
  if (decodedHeader.alg !== 'HS256') throw new AppError('UNAUTHORIZED', { messageEn: 'unsupported token algorithm' });
  if (claims.typ !== 'access') throw new AppError('UNAUTHORIZED', { messageEn: 'wrong token type' });
  if (claims.iss !== ISSUER) throw new AppError('UNAUTHORIZED', { messageEn: 'wrong token issuer' });
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new AppError('UNAUTHORIZED', { messageEn: 'token has no subject' });
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) throw new AppError('TOKEN_EXPIRED');
  return claims;
}

export interface PasswordHash {
  salt: string;
  hash: string;
}

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  const derived = scryptSync(password, salt, expected.length || SCRYPT_KEYLEN);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Opaque refresh token. Returned once; only its hash is stored. */
export function createRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Password policy: length over composition. Rejecting short passwords is useful;
 * demanding symbols pushes people to predictable substitutions.
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < 8) {
    throw new AppError('VALIDATION_FAILED', {
      messageAr: 'كلمة المرور لازم تكون 8 أحرف على الأقل.',
      messageEn: 'password must be at least 8 characters',
      details: { field: 'password' },
    });
  }
  if (password.length > 200) {
    throw new AppError('VALIDATION_FAILED', { messageEn: 'password must be at most 200 characters', details: { field: 'password' } });
  }
  if (password.trim().length === 0) {
    throw new AppError('VALIDATION_FAILED', { messageEn: 'password cannot be only whitespace', details: { field: 'password' } });
  }
}

export function assertEmailAcceptable(email: string): void {
  // Deliberately permissive: the authoritative check is a confirmation step.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new AppError('VALIDATION_FAILED', {
      messageAr: 'البريد الإلكتروني غير صحيح.',
      messageEn: 'email is not a valid address',
      details: { field: 'email' },
    });
  }
}
