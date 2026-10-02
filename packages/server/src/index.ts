/**
 * @file index.ts
 * @description Server bootstrap — Phase 3 (final wiring).
 * Sequence: MongoDB → Redis → Express+API → Socket.IO → GameStateMachine
 */

import 'dotenv/config';
import http      from 'http';
import express   from 'express';
import cors      from 'cors';
import helmet    from 'helmet';
import rateLimit from 'express-rate-limit';

import { connectDatabase }      from './database';
import { getRedisClient }       from './redis';
import { createSocketIOServer } from './socket/socketio';
import { apiRouter }            from './api/index';
import { bootstrapAdmin }       from './scripts/seedAdmin';
import { logger }               from './logger';

// ─── Express App ──────────────────────────────────────────────────────────────

export const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      workerSrc:  ["'self'", 'blob:'],
    },
  },
}));

app.use(cors({
  origin:      (process.env['CORS_ORIGINS'] ?? 'http://localhost:5173').split(','),
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// ── Global rate limiter for /api ───────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs:        parseInt(process.env['RATE_LIMIT_WINDOW_MS']    ?? '60000', 10),
  max:             parseInt(process.env['RATE_LIMIT_MAX_REQUESTS'] ?? '100',   10),
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests', code: 'RATE_LIMITED' },
  skip: (req) => req.path === '/health',
});
app.use('/api', apiLimiter);

// ── Stricter limiter for auth endpoints (prevents brute-force) ────────────────
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,  // 15 minutes
  max:             20,               // 20 login attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many authentication attempts. Try again in 15 minutes.' },
});
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);

// ── Mount REST API ─────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '3.0.0' });
});

// ── 404 catch-all ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled Express error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── HTTP Server ──────────────────────────────────────────────────────────────

export const httpServer = http.createServer(app);

// ─── Startup ──────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  try {
    logger.info('════════════════════════════════════════');
    logger.info('  ZombieRun Crash — Server v3.0');
    logger.info('════════════════════════════════════════');

    // 1. Connect MongoDB
    await connectDatabase();
    logger.info('✓ MongoDB connected');

    // 2. Connect Redis (warm-up ping)
    const redis = getRedisClient();
    await redis.ping();
    logger.info('✓ Redis connected');

    // 3. Bootstrap admin user on first run
    await bootstrapAdmin();

    // 4. Initialise Socket.IO + Game State Machine
    createSocketIOServer(httpServer);
    logger.info('✓ Socket.IO + GameStateMachine started');

    // 5. Start HTTP server
    const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
    httpServer.listen(PORT, () => {
      logger.info(`✓ API server listening on http://localhost:${PORT}`);
      logger.info('✓ REST endpoints: /api/auth, /api/game, /api/admin');
      logger.info('✓ Game loop running');
    });

  } catch (err) {
    logger.error('Fatal startup error', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  }
}

bootstrap();
