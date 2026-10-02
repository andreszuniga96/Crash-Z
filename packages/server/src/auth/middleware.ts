/**
 * @file middleware.ts
 * @description Express middleware for JWT-based authentication and role-based authorization.
 *
 * Pattern: Middleware chains rather than single monolithic guards.
 *   - `authenticate` validates the JWT and attaches the user context to `req`
 *   - `authorize(...roles)` is a factory that creates role-check middleware
 *   - Used together: router.get('/admin', authenticate, authorize('admin'), handler)
 */

import { Request, Response, NextFunction } from 'express';
import { extractBearerToken, verifyAccessToken, VerifiedTokenPayload } from './jwt';
import { UserRole } from '../models/User.model';

// ─── Type Augmentation ────────────────────────────────────────────────────────

/**
 * Augment Express's Request type to include the authenticated user context.
 * This is the canonical pattern for typed middleware in Express + TypeScript.
 */
declare global {
  namespace Express {
    interface Request {
      user?: VerifiedTokenPayload;
    }
  }
}

// ─── Custom Error Classes ─────────────────────────────────────────────────────

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * `authenticate` — verifies the JWT access token in the Authorization header.
 *
 * On success: attaches `req.user` and calls `next()`.
 * On failure: responds with 401 and does NOT call `next()`.
 */
export function authenticate(
  req:  Request,
  res:  Response,
  next: NextFunction,
): void {
  try {
    const token = extractBearerToken(req.headers.authorization);

    if (!token) {
      res.status(401).json({
        error: 'Authentication required',
        code:  'MISSING_TOKEN',
      });
      return;
    }

    const payload = verifyAccessToken(token);
    req.user      = payload;
    next();

  } catch (err) {
    const isExpired  = err instanceof Error && err.name === 'TokenExpiredError';
    const isInvalid  = err instanceof Error && err.name === 'JsonWebTokenError';

    if (isExpired) {
      res.status(401).json({
        error: 'Token expired',
        code:  'TOKEN_EXPIRED',
      });
    } else if (isInvalid) {
      res.status(401).json({
        error: 'Invalid token',
        code:  'INVALID_TOKEN',
      });
    } else {
      // Unexpected error — log and return generic 500
      console.error('[authenticate] Unexpected error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

/**
 * `authorize` — factory function that creates a role-check middleware.
 * Must be used AFTER `authenticate` (which populates `req.user`).
 *
 * @param roles - One or more UserRole values that are permitted access
 *
 * @example
 * // Admin-only route
 * router.delete('/users/:id', authenticate, authorize(UserRole.ADMIN), deleteUser);
 *
 * // Multi-role route (admin or moderator)
 * router.get('/reports', authenticate, authorize(UserRole.ADMIN), getReports);
 */
export function authorize(...roles: UserRole[]) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      // Should not happen if `authenticate` is chained first, but defensive check
      res.status(401).json({
        error: 'Authentication required',
        code:  'MISSING_USER_CONTEXT',
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}`,
        code:  'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    next();
  };
}

/**
 * `optionalAuthenticate` — same as `authenticate` but doesn't block unauthenticated
 * requests. Used for public routes that behave differently when logged in
 * (e.g., the game feed showing personalized data).
 */
export function optionalAuthenticate(
  req:  Request,
  res:  Response,
  next: NextFunction,
): void {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (token) {
      req.user = verifyAccessToken(token);
    }
  } catch {
    // Silently ignore invalid/expired tokens for optional auth
  }
  next();
}
