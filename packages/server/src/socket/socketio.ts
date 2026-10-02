/**
 * @file socketio.ts
 * @description Socket.IO server initialisation with:
 *   - JWT authentication middleware (handshake-level, before any event fires)
 *   - CORS configuration
 *   - Rate limiting on connection attempts
 *   - Exponential Backoff + Full Jitter reconnection configuration
 *     (sent to clients via the handshake response)
 *   - Game handler registration per connected socket
 *
 * EXPONENTIAL BACKOFF WITH FULL JITTER
 * ──────────────────────────────────────
 * Socket.IO clients are configured with the following reconnection strategy.
 * The server does NOT directly control client retry logic — it configures it
 * through the io() constructor options on the CLIENT side (Phase 4).
 * However, this file documents the algorithm and provides the constants
 * exported for the client to import.
 *
 * Algorithm (AWS "Full Jitter" variant):
 *
 *   cap   = MAX_BACKOFF_MS                    // e.g. 30000ms
 *   base  = INITIAL_BACKOFF_MS                // e.g. 500ms
 *   sleep = random_between(0, min(cap, base × 2^attempt))
 *
 * Properties:
 *   - Attempt 0: random in [0, 500ms]
 *   - Attempt 1: random in [0, 1000ms]
 *   - Attempt 2: random in [0, 2000ms]
 *   - ...
 *   - Attempt ≥6: random in [0, 30000ms]  (capped)
 *
 * The "Full Jitter" variant is preferred over "Equal Jitter" because it
 * completely randomises the delay, giving the best thundering-herd prevention
 * when many clients disconnect simultaneously (e.g. server restart).
 *
 * Reference: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */

import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer }     from 'http';
import {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
} from '../game/types';
import { GameStateMachine } from '../game/GameStateMachine';
import { registerGameHandlers } from './gameHandler';
import { verifyAccessToken }    from '../auth/jwt';
import { logger }               from '../logger';

// ─── Backoff Constants (exported for use in Phase 4 client config) ────────────

export const BACKOFF_INITIAL_MS  = 500;
export const BACKOFF_MAX_MS      = 30_000;
export const BACKOFF_MULTIPLIER  = 2;
export const BACKOFF_MAX_RETRIES = 15;

/**
 * Computes the delay for reconnection attempt `n` using Full Jitter.
 * Exported so the client can use an identical implementation.
 *
 * @param attempt - Zero-indexed attempt number
 */
export function computeBackoffDelay(attempt: number): number {
  const cap  = BACKOFF_MAX_MS;
  const base = BACKOFF_INITIAL_MS;
  const ceil = Math.min(cap, base * Math.pow(BACKOFF_MULTIPLIER, attempt));
  // Full Jitter: uniform random in [0, ceil)
  return Math.floor(Math.random() * ceil);
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/** Maximum new connections per IP within the window */
const MAX_CONNECTIONS_PER_IP   = 10;
const CONNECTION_WINDOW_MS     = 60_000;

const connectionAttempts = new Map<string, { count: number; windowStart: number }>();

function isConnectionRateLimited(ip: string): boolean {
  const now  = Date.now();
  const entry = connectionAttempts.get(ip);

  if (!entry || (now - entry.windowStart) > CONNECTION_WINDOW_MS) {
    connectionAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > MAX_CONNECTIONS_PER_IP) {
    logger.warn(`[Socket] Rate limited: ${ip} (${entry.count} connections in ${CONNECTION_WINDOW_MS}ms)`);
    return true;
  }
  return false;
}

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of connectionAttempts) {
    if (now - entry.windowStart > CONNECTION_WINDOW_MS * 2) {
      connectionAttempts.delete(ip);
    }
  }
}, 5 * 60_000);

// ─── Socket.IO Server Factory ─────────────────────────────────────────────────

/**
 * Creates and attaches a Socket.IO server to the given HTTP server.
 * Also instantiates and starts the GameStateMachine.
 *
 * @param httpServer - The Express HTTP server instance
 * @returns The configured Socket.IO server (for use in tests or admin tools)
 */
export function createSocketIOServer(
  httpServer: HttpServer,
): SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> {

  const corsOrigins = (process.env['CORS_ORIGINS'] ?? 'http://localhost:5173').split(',');

  const io = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    // ── Transport & Upgrade ────────────────────────────────────────────────
    transports:      ['websocket', 'polling'],
    upgradeTimeout:  10_000,

    // ── CORS ──────────────────────────────────────────────────────────────
    cors: {
      origin:      corsOrigins,
      methods:     ['GET', 'POST'],
      credentials: true,
    },

    // ── Ping / Heartbeat ───────────────────────────────────────────────────
    // Server pings clients every 25s; clients must respond within 20s.
    // If missed: server considers the client disconnected and fires 'disconnect'.
    pingInterval: 25_000,
    pingTimeout:  20_000,

    // ── Payload limits ─────────────────────────────────────────────────────
    maxHttpBufferSize: 1e5,  // 100 KB — more than enough for game events

    // ── Connection State Recovery ──────────────────────────────────────────
    // Buffers events for briefly-disconnected clients (mobile network handoff).
    // Avoids the need for manual reconnect:state fetch in most short-disconnect cases.
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,  // 2 minutes
      skipMiddlewares:          false,     // Re-run auth middleware on recovery
    },
  });

  // ── Authentication Middleware ──────────────────────────────────────────────
  // Runs BEFORE the 'connection' event fires, in the handshake phase.
  // If authentication fails, the connection is rejected before any memory
  // is allocated for the socket — preventing unauthenticated socket objects.
  io.use((socket, next) => {
    const ip = socket.handshake.address;

    // Rate limit before auth (prevents auth-flood attacks)
    if (isConnectionRateLimited(ip)) {
      return next(new Error('TOO_MANY_CONNECTIONS'));
    }

    // Extract JWT from handshake auth object
    // Client sends: io({ auth: { token: accessToken } })
    const token = socket.handshake.auth?.['token'] as string | undefined;

    if (!token) {
      return next(new Error('MISSING_TOKEN'));
    }

    try {
      const payload = verifyAccessToken(token);
      // Populate socket.data — available to all event handlers
      socket.data = {
        userId:   payload.sub,
        username: payload.username,
        role:     payload.role,
      };
      next();

    } catch (err) {
      const msg = (err as Error).name === 'TokenExpiredError'
        ? 'TOKEN_EXPIRED'
        : 'INVALID_TOKEN';
      logger.debug(`[Socket] Auth rejected: ${msg} ip=${ip}`);
      next(new Error(msg));
    }
  });

  // ── Game State Machine ─────────────────────────────────────────────────────
  const machine = new GameStateMachine(io);
  machine.start().catch((err) => {
    logger.error('[Socket] GameStateMachine failed to start', { error: err.message });
    process.exit(1);
  });

  // ── Connection Handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    // Register all game-specific event handlers
    registerGameHandlers(socket, machine);
  });

  logger.info('[Socket] Socket.IO server initialised');
  return io;
}
