/**
 * @file jwt.ts
 * @description JWT utilities for ZombieRun Crash authentication.
 *
 * Design decisions:
 * - Access tokens: short-lived (15 min) — minimises exposure window
 * - Refresh tokens: long-lived (7 days) — stored in httpOnly cookie on the client
 * - Both tokens carry only the minimum necessary claims (principle of least privilege)
 * - The token payload is typed with TypeScript for compile-time safety
 * - Asymmetric signing (RS256) is ideal for microservices, but this monolith uses
 *   HS256 with a strong secret for simplicity. Secret must be ≥ 256 bits.
 */

import jwt, { SignOptions, VerifyOptions } from 'jsonwebtoken';
import { Types } from 'mongoose';
import { UserRole } from '../models/User.model';

// ─── Token Payload Types ──────────────────────────────────────────────────────

/** Claims embedded in both access and refresh tokens */
export interface TokenPayload {
  sub:      string;      // MongoDB User._id (hex string)
  username: string;
  role:     UserRole;
  type:     'access' | 'refresh';
  iat?:     number;
  exp?:     number;
}

/** Parsed and verified token with standard JWT fields guaranteed */
export interface VerifiedTokenPayload extends TokenPayload {
  iat: number;
  exp: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

function getSecret(): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET must be set and at least 32 characters long. ' +
      'Generate with: node -e "require(\'crypto\').randomBytes(64).toString(\'hex\')"',
    );
  }
  return secret;
}

const ACCESS_TOKEN_TTL  = '15m';   // 15 minutes
const REFRESH_TOKEN_TTL = '7d';    // 7 days

// ─── Token Generation ─────────────────────────────────────────────────────────

/**
 * Signs a new access token for the given user.
 * Access tokens are included in the Authorization header of every API request.
 */
export function signAccessToken(params: {
  userId:   Types.ObjectId | string;
  username: string;
  role:     UserRole;
}): string {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
    sub:      params.userId.toString(),
    username: params.username,
    role:     params.role,
    type:     'access',
  };

  const options: SignOptions = {
    expiresIn:  ACCESS_TOKEN_TTL,
    algorithm:  'HS256',
    issuer:     'zombierun-crash',
    audience:   'zombierun-crash-client',
  };

  return jwt.sign(payload, getSecret(), options);
}

/**
 * Signs a new refresh token.
 * Refresh tokens should be stored in an httpOnly, Secure, SameSite=Strict cookie.
 * They are used ONLY to obtain new access tokens; they carry no other privileges.
 */
export function signRefreshToken(params: {
  userId:   Types.ObjectId | string;
  username: string;
  role:     UserRole;
}): string {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
    sub:      params.userId.toString(),
    username: params.username,
    role:     params.role,
    type:     'refresh',
  };

  const options: SignOptions = {
    expiresIn:  REFRESH_TOKEN_TTL,
    algorithm:  'HS256',
    issuer:     'zombierun-crash',
    audience:   'zombierun-crash-client',
  };

  return jwt.sign(payload, getSecret(), options);
}

/**
 * Verifies and decodes an access token.
 *
 * @throws JsonWebTokenError    if the signature is invalid
 * @throws TokenExpiredError    if the token has expired
 * @throws NotBeforeError       if the token is not yet valid
 */
export function verifyAccessToken(token: string): VerifiedTokenPayload {
  const options: VerifyOptions = {
    algorithms: ['HS256'],
    issuer:     'zombierun-crash',
    audience:   'zombierun-crash-client',
  };

  const decoded = jwt.verify(token, getSecret(), options) as VerifiedTokenPayload;

  if (decoded.type !== 'access') {
    throw new jwt.JsonWebTokenError('Token type mismatch: expected access token');
  }

  return decoded;
}

/**
 * Verifies and decodes a refresh token.
 *
 * @throws JsonWebTokenError   if the signature is invalid
 * @throws TokenExpiredError   if the token has expired
 */
export function verifyRefreshToken(token: string): VerifiedTokenPayload {
  const options: VerifyOptions = {
    algorithms: ['HS256'],
    issuer:     'zombierun-crash',
    audience:   'zombierun-crash-client',
  };

  const decoded = jwt.verify(token, getSecret(), options) as VerifiedTokenPayload;

  if (decoded.type !== 'refresh') {
    throw new jwt.JsonWebTokenError('Token type mismatch: expected refresh token');
  }

  return decoded;
}

/**
 * Decodes a token WITHOUT verifying its signature.
 * Use ONLY for logging or debugging — never for authorization decisions.
 */
export function decodeTokenUnsafe(token: string): TokenPayload | null {
  return jwt.decode(token) as TokenPayload | null;
}

/**
 * Extracts the bearer token from an HTTP Authorization header.
 * Returns null if the header is missing or malformed.
 *
 * @param authHeader - Value of the 'Authorization' request header
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;
  return parts[1] ?? null;
}
