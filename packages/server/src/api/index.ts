/**
 * @file index.ts
 * @description API router barrel — mounts all sub-routers onto their prefix paths.
 * Import this single router into index.ts.
 */

import { Router } from 'express';
import cookieParser from 'cookie-parser';

import { authRouter  } from './auth.router';
import { gameRouter  } from './game.router';
import { adminRouter } from './admin.router';

export const apiRouter = Router();

// Cookie parser needed for the httpOnly refresh token cookie
apiRouter.use(cookieParser());

// ── Mount sub-routers ──────────────────────────────────────────────────────────
apiRouter.use('/auth',  authRouter);
apiRouter.use('/game',  gameRouter);
apiRouter.use('/admin', adminRouter);

// ── Catch-all 404 for /api/* ───────────────────────────────────────────────────
apiRouter.use((_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});
