/**
 * @file auth.router.ts
 * @description Authentication endpoints: register, login, refresh, logout, me.
 *
 * POST /api/auth/register  — Create a new player account
 * POST /api/auth/login     — Authenticate and receive tokens
 * POST /api/auth/refresh   — Exchange refresh token for new access token
 * POST /api/auth/logout    — Invalidate refresh token (client clears cookie)
 * GET  /api/auth/me        — Get current user profile (requires access token)
 */

import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';

import { UserModel, UserRole, AccountStatus } from '../models/User.model';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../auth/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../auth/jwt';
import { authenticate } from '../auth/middleware';
import { validate, registerSchema, loginSchema } from './validation';
import { logger } from '../logger';

export const authRouter = Router();

// ─── POST /api/auth/register ──────────────────────────────────────────────────

authRouter.post(
  '/register',
  validate(registerSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { username, email, password } = req.body as {
      username: string; email: string; password: string;
    };

    // ── Password strength check ────────────────────────────────────────────
    const strengthErrors = validatePasswordStrength(password);
    if (strengthErrors.length > 0) {
      res.status(400).json({ error: 'Password too weak', details: strengthErrors });
      return;
    }

    // ── Duplicate check (email + username) ────────────────────────────────
    const existing = await UserModel.findOne({
      $or: [{ email: email.toLowerCase() }, { username }],
    }).lean();

    if (existing) {
      const field = existing.email === email.toLowerCase() ? 'email' : 'username';
      res.status(409).json({ error: `${field} is already taken` });
      return;
    }

    // ── Hash password and create user ─────────────────────────────────────
    const passwordHash = await hashPassword(password);
    const clientIp     = req.ip ?? 'unknown';

    const user = await UserModel.create({
      username,
      email:        email.toLowerCase(),
      passwordHash,
      role:         UserRole.PLAYER,
      status:       AccountStatus.ACTIVE,
      balanceCents: 0,
      ipHistory:    [clientIp],
    });

    logger.info(`[Auth] New player registered: ${username} (${email})`);

    // ── Issue tokens ───────────────────────────────────────────────────────
    const accessToken  = signAccessToken({ userId: user._id, username, role: user.role });
    const refreshToken = signRefreshToken({ userId: user._id, username, role: user.role });

    // Refresh token in httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure:   process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days in ms
    });

    res.status(201).json({
      accessToken,
      user: {
        id:           user._id,
        username:     user.username,
        email:        user.email,
        role:         user.role,
        balanceCents: user.balanceCents,
      },
    });
  },
);

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

authRouter.post(
  '/login',
  validate(loginSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body as { email: string; password: string };

    // Fetch user with passwordHash (normally excluded by `select: false`)
    const user = await UserModel.findActiveByEmail(email);

    if (!user) {
      // Constant-time response to prevent user enumeration
      await hashPassword('dummy_password_to_prevent_timing_attack');
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // ── Update login metadata ──────────────────────────────────────────────
    const clientIp = req.ip ?? 'unknown';
    user.lastLoginAt = new Date();
    user.ipHistory.push(clientIp);
    await user.save();

    logger.info(`[Auth] Login: ${user.username} from ${clientIp}`);

    // ── Issue tokens ───────────────────────────────────────────────────────
    const accessToken  = signAccessToken({ userId: user._id, username: user.username, role: user.role });
    const refreshToken = signRefreshToken({ userId: user._id, username: user.username, role: user.role });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure:   process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      maxAge:   7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      accessToken,
      user: {
        id:           user._id,
        username:     user.username,
        email:        user.email,
        role:         user.role,
        balanceCents: user.balanceCents,
        balanceCOP:   user.balanceCOP,
      },
    });
  },
);

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────

authRouter.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies?.['refreshToken'] as string | undefined;

  if (!token) {
    res.status(401).json({ error: 'Refresh token missing', code: 'MISSING_REFRESH_TOKEN' });
    return;
  }

  try {
    const payload = verifyRefreshToken(token);

    // Verify user still exists and is active
    const user = await UserModel.findById(payload.sub)
      .select('username role status balanceCents')
      .lean();

    if (!user || user.status !== AccountStatus.ACTIVE) {
      res.status(401).json({ error: 'Account not found or suspended' });
      return;
    }

    const accessToken = signAccessToken({
      userId:   user._id,
      username: user.username,
      role:     user.role,
    });

    res.json({ accessToken });

  } catch (err) {
    const code = (err as Error).name === 'TokenExpiredError' ? 'REFRESH_EXPIRED' : 'INVALID_REFRESH';
    res.status(401).json({ error: 'Invalid or expired refresh token', code });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

authRouter.post('/logout', (_req: Request, res: Response): void => {
  // Clear the httpOnly cookie on the client
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure:   process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
  });
  res.json({ message: 'Logged out successfully' });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

authRouter.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = await UserModel.findById(req.user!.sub)
    .select('username email role status balanceCents clientSeed nonce createdAt lastLoginAt')
    .lean();

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({
    id:           user._id,
    username:     user.username,
    email:        user.email,
    role:         user.role,
    status:       user.status,
    balanceCents: user.balanceCents,
    balanceCOP:   user.balanceCents / 100,
    clientSeed:   user.clientSeed,
    nonce:        user.nonce,
    createdAt:    user.createdAt,
    lastLoginAt:  user.lastLoginAt,
  });
});

// ─── PUT /api/auth/client-seed ────────────────────────────────────────────────
// Allows a player to change their Provably Fair client seed between rounds

authRouter.put('/client-seed', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { clientSeed } = req.body as { clientSeed?: string };

  if (!clientSeed || typeof clientSeed !== 'string' || clientSeed.length < 8 || clientSeed.length > 64) {
    res.status(400).json({ error: 'clientSeed must be a string between 8 and 64 characters' });
    return;
  }

  const user = await UserModel.findByIdAndUpdate(
    req.user!.sub,
    { clientSeed },
    { new: true, select: 'clientSeed nonce' },
  ).lean();

  res.json({ clientSeed: user?.clientSeed, nonce: user?.nonce });
});
