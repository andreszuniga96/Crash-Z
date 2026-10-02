/**
 * @file redis.ts
 * @description Redis client singleton using ioredis.
 * Used in Phase 2 for idempotency key storage and rate limiting.
 */

import Redis from 'ioredis';
import { logger } from './logger';

let redisClient: Redis | null = null;

/**
 * Returns the singleton Redis client, creating it on first call.
 * Subsequent calls return the same instance (connection is reused).
 */
export function getRedisClient(): Redis {
  if (redisClient) return redisClient;

  const url      = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const password = process.env['REDIS_PASSWORD'] ?? undefined;

  redisClient = new Redis(url, {
    password,
    maxRetriesPerRequest:    3,
    enableReadyCheck:        true,
    retryStrategy(times: number) {
      // Exponential backoff: 100ms → 200ms → 400ms → ... cap at 10s
      const delay = Math.min(100 * 2 ** times, 10_000);
      logger.warn(`Redis retry attempt ${times} in ${delay}ms`);
      return delay;
    },
    reconnectOnError(err: Error) {
      // Reconnect on READONLY errors (Redis Cluster failover)
      return err.message.includes('READONLY');
    },
  });

  redisClient.on('connect',    () => logger.info('Redis connected'));
  redisClient.on('ready',      () => logger.info('Redis ready'));
  redisClient.on('error',  (err) => logger.error('Redis error', { message: err.message }));
  redisClient.on('close',      () => logger.warn('Redis connection closed'));

  return redisClient;
}

/**
 * Checks and sets an idempotency key atomically using SET NX EX.
 *
 * Returns true if the key was SET (first time this action is being processed).
 * Returns false if the key already exists (duplicate/replay — reject the action).
 *
 * @param key     - Unique key for this action (e.g., `bet:${idempotencyKey}`)
 * @param ttlSecs - How long to keep the key (default: 3600 = 1 hour)
 */
export async function acquireIdempotencyKey(
  key:     string,
  ttlSecs: number = 3600,
): Promise<boolean> {
  const redis  = getRedisClient();
  // SET key "1" NX EX ttlSecs — atomic: only sets if not exists
  const result = await redis.set(key, '1', 'EX', ttlSecs, 'NX');
  return result === 'OK';
}

/**
 * Releases an idempotency key (e.g., on rollback after a DB error).
 * This allows safe retry after a server-side failure (not a client retry).
 */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(key);
}
