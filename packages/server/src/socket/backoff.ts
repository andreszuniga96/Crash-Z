/**
 * @file backoff.ts
 * @description Exponential Backoff with Full Jitter — shared utility.
 *
 * Used by:
 *   - Phase 4 client: manually manages Socket.IO reconnection attempts
 *     to implement the AWS Full Jitter algorithm (Socket.IO's built-in
 *     reconnectionDelay uses Exponential Backoff WITHOUT jitter by default,
 *     which is insufficient for thundering-herd prevention).
 *
 * Algorithm: AWS "Full Jitter"
 * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 *
 *   delay(attempt) = random_uniform(0, min(CAP, BASE × 2^attempt))
 *
 * ┌─────────┬──────────────────────────────────────────┐
 * │ Attempt │ Max possible delay (before jitter)        │
 * ├─────────┼──────────────────────────────────────────┤
 * │    0    │   500 ms                                  │
 * │    1    │  1000 ms                                  │
 * │    2    │  2000 ms                                  │
 * │    3    │  4000 ms                                  │
 * │    4    │  8000 ms                                  │
 * │    5    │ 16000 ms                                  │
 * │   ≥6    │ 30000 ms  (capped)                        │
 * └─────────┴──────────────────────────────────────────┘
 */

export const BACKOFF_CONFIG = {
  /** Initial window ceiling (ms) */
  BASE_MS:      500,
  /** Maximum window ceiling (ms) — prevents unbounded waits */
  CAP_MS:       30_000,
  /** Exponential growth factor */
  MULTIPLIER:   2,
  /** Maximum number of reconnection attempts before giving up */
  MAX_ATTEMPTS: 15,
} as const;

/**
 * Computes the Full Jitter delay for reconnection attempt `n`.
 *
 * @param attempt - Zero-indexed attempt counter (reset to 0 on successful connect)
 * @returns Delay in milliseconds
 */
export function computeFullJitterDelay(attempt: number): number {
  const { BASE_MS, CAP_MS, MULTIPLIER } = BACKOFF_CONFIG;
  const ceiling = Math.min(CAP_MS, BASE_MS * Math.pow(MULTIPLIER, attempt));
  // Uniform random in [0, ceiling)
  return Math.floor(Math.random() * ceiling);
}

/**
 * Returns a Promise that resolves after the Full Jitter delay for attempt `n`.
 * Use in a reconnection loop:
 *
 * @example
 * let attempt = 0;
 * while (!connected && attempt < BACKOFF_CONFIG.MAX_ATTEMPTS) {
 *   await backoffWait(attempt++);
 *   tryReconnect();
 * }
 */
export function backoffWait(attempt: number): Promise<void> {
  const delay = computeFullJitterDelay(attempt);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
