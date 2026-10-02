/**
 * @file database.ts
 * @description MongoDB connection management with reconnection logic and graceful shutdown.
 *
 * Features:
 * - Singleton connection (Mongoose handles connection pooling internally)
 * - Event-driven reconnection logging
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Validates MONGODB_URI at startup to fail fast
 */

import mongoose from 'mongoose';
import { logger } from './logger';

let isConnected = false;

// ─── Connection retry policy ──────────────────────────────────────────────────
//
// The API server is gated on the `mongo-init` container finishing, so by the
// time we get here the replica set is already healthy. These retries are the
// defensive layer for what that gate cannot cover: PRIMARY re-elections after
// a MongoDB restart, a slow first election on a cold host, or the container
// coming back on a different machine in a swarm.
//
// Delay is "full jitter": uniform_random(0, min(cap, base * 2^attempt)).
// Every instance therefore retries on an independently random schedule, so a
// fleet restarting together still spreads its connection attempts out instead
// of hammering mongod in lockstep.

const CONNECT_MAX_ATTEMPTS   = 10;
const CONNECT_BASE_DELAY_MS  = 500;
const CONNECT_MAX_DELAY_MS   = 8_000;

function fullJitterDelay(attempt: number): number {
  const ceiling = Math.min(CONNECT_MAX_DELAY_MS, CONNECT_BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Establishes a connection to MongoDB, retrying with exponential backoff +
 * full jitter. Safe to call multiple times — a no-op once connected.
 */
export async function connectDatabase(): Promise<void> {
  if (isConnected) {
    logger.debug('MongoDB already connected, skipping');
    return;
  }

  const uri = process.env['MONGODB_URI'];
  if (!uri) {
    throw new Error(
      'MONGODB_URI environment variable is not set. ' +
      'Example: mongodb://localhost:27017/zombierun',
    );
  }

  mongoose.set('strictQuery', true);

  const redactedUri = uri.replace(/:\/\/.*@/, '://***@');

  for (let attempt = 0; attempt < CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(uri, {
        // Connection pool: enough for concurrent game loop + API handlers
        maxPoolSize:         20,
        minPoolSize:         5,
        // Timeouts
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS:    10_000,
        socketTimeoutMS:     45_000,
        // Heartbeat: detect stale connections early
        heartbeatFrequencyMS: 10_000,
      });

      isConnected = true;
      logger.info('MongoDB connected', {
        uri: redactedUri,
        attempt: attempt + 1,
      });
      return;

    } catch (err) {
      const message = (err as Error).message;
      const isLast  = attempt === CONNECT_MAX_ATTEMPTS - 1;

      if (isLast) {
        logger.error('MongoDB connection failed — retries exhausted', {
          error: message,
          attempts: CONNECT_MAX_ATTEMPTS,
        });
        throw err;
      }

      const delayMs = fullJitterDelay(attempt);
      logger.warn('MongoDB connection failed — retrying with backoff', {
        error: message,
        attempt: attempt + 1,
        maxAttempts: CONNECT_MAX_ATTEMPTS,
        retryInMs: delayMs,
      });

      // Make sure a half-open socket from the failed attempt cannot linger
      // and confuse the next mongoose.connect() call.
      if (mongoose.connection.readyState !== 0) {
        try {
          await mongoose.disconnect();
        } catch {
          /* already torn down — nothing to do */
        }
      }

      await sleep(delayMs);
    }
  }
}

// ─── Connection Event Listeners ───────────────────────────────────────────────

mongoose.connection.on('disconnected', () => {
  isConnected = false;
  logger.warn('MongoDB disconnected — Mongoose will attempt to reconnect');
});

mongoose.connection.on('reconnected', () => {
  isConnected = true;
  logger.info('MongoDB reconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error('MongoDB connection error', { error: err.message });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}. Closing MongoDB connection...`);
  await mongoose.connection.close();
  logger.info('MongoDB connection closed. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
