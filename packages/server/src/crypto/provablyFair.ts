/**
 * @file provablyFair.ts
 * @description Mathematically rigorous Provably Fair RNG engine for ZombieRun Crash.
 *
 * ALGORITHM OVERVIEW
 * ──────────────────
 * 1. Before betting opens, the server generates a serverSeed (32 bytes CSPRNG).
 *    It publishes SHA-256(serverSeed) — the "commitment hash" — so the outcome
 *    cannot be changed after bets are placed.
 *
 * 2. During the betting phase, each player's clientSeed is XOR-folded into a
 *    single aggregated clientSeed, ensuring at least one honest player can
 *    influence the result.
 *
 * 3. At round start, the crash multiplier is derived:
 *
 *      hmac = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`)
 *
 *    Extract the first 13 hex characters → 52-bit integer `e`.
 *
 *    Apply the Bustabit-style formula with 3% house edge:
 *
 *      HOUSE_EDGE  = 0.03              // 3%
 *      MAX_BITS    = 2^52              // 4503599627370496n (BigInt)
 *      EDGE_BITS   = floor(MAX_BITS * HOUSE_EDGE)
 *
 *      If e < EDGE_BITS:  crash at 1.00×  (house takes 3% of rounds)
 *      Else:
 *        rawM = (100 × MAX_BITS) / (MAX_BITS − e)
 *        M    = floor(rawM) / 100        // 2-decimal truncation (not rounding)
 *        M    = max(1.00, M)
 *
 * 4. After the round ends, the server reveals serverSeed + hmacHex.
 *    Any player can reproduce the HMAC, extract `e`, and verify M independently.
 *
 * WHY BIGINT?
 * ───────────
 * Number (IEEE-754 double) can represent integers exactly only up to 2^53 − 1.
 * 2^52 = 4503599627370496, which is within that range, but intermediate products
 * like (100n × MAX_BITS) reach ~4.5 × 10^17, still safe for Number but brittle.
 * We use BigInt throughout the multiplier calculation to be mathematically
 * unambiguous and immune to any future refactoring mistake.
 */

import crypto from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of entropy bits extracted from the HMAC digest */
const ENTROPY_BITS = 52n;

/** 2^52 as BigInt — the divisor/scaling factor in the crash formula */
const MAX_BITS = 2n ** ENTROPY_BITS; // 4503599627370496n

/**
 * House edge expressed as a fraction.
 * 3% → 3 / 100 → represented as (HOUSE_EDGE_NUM / HOUSE_EDGE_DEN) for BigInt math.
 */
const HOUSE_EDGE_NUM = 3n;
const HOUSE_EDGE_DEN = 100n;

/**
 * The threshold below which the result is an instant crash (house edge).
 * = floor(MAX_BITS × 0.03) = floor(4503599627370496 × 3 / 100) = 135107988821114
 */
const EDGE_THRESHOLD = (MAX_BITS * HOUSE_EDGE_NUM) / HOUSE_EDGE_DEN;

/** Minimum number of bytes for the server seed (256 bits of entropy) */
const SERVER_SEED_BYTES = 32;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SeedPair {
  /** Raw 64-char hex string — NEVER revealed before round ends */
  serverSeed: string;
  /** SHA-256 of serverSeed — published before bets open */
  serverSeedHash: string;
}

export interface CrashResult {
  /** The predetermined crash multiplier (floor-truncated to 2 decimal places) */
  crashMultiplier: number;
  /**
   * Full HMAC-SHA256 hex (64 chars).
   * Published post-round for player verification.
   */
  hmacHex: string;
  /**
   * The 52-bit integer extracted from the first 13 hex chars.
   * Exposed for transparency in the admin Provably Fair viewer.
   */
  extractedBits: string; // string representation of BigInt to avoid JSON precision loss
}

export interface VerificationInput {
  serverSeed:  string;
  clientSeed:  string;
  nonce:       number;
  expectedHmac: string;
  expectedMultiplier: number;
}

export interface VerificationResult {
  valid:              boolean;
  computedHmac:       string;
  computedMultiplier: number;
  extractedBits:      string;
  details:            string;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Generates a cryptographically secure server seed and its SHA-256 commitment hash.
 *
 * This pair is created BEFORE the betting phase opens.
 * The hash is broadcast to all players immediately.
 * The raw seed is stored in the DB with `select: false` and revealed post-crash.
 *
 * @returns SeedPair — { serverSeed (hex), serverSeedHash (hex) }
 */
export function generateSeedPair(): SeedPair {
  const serverSeedBytes = crypto.randomBytes(SERVER_SEED_BYTES);
  const serverSeed      = serverSeedBytes.toString('hex'); // 64 hex chars

  const serverSeedHash = crypto
    .createHash('sha256')
    .update(serverSeedBytes)
    .digest('hex');

  return { serverSeed, serverSeedHash };
}

/**
 * Computes the crash multiplier for a given set of round parameters.
 *
 * This function is deterministic: given the same inputs it always returns
 * the same output — enabling Provably Fair verification by any third party.
 *
 * @param serverSeed  - 64-char hex server seed (revealed post-round)
 * @param clientSeed  - Aggregated client seed string (XOR-folded from all players)
 * @param nonce       - Round-specific nonce (monotonically increasing)
 * @returns CrashResult with multiplier, hmac, and raw bits
 */
export function computeCrashMultiplier(
  serverSeed:  string,
  clientSeed:  string,
  nonce:       number,
): CrashResult {
  // ── Step 1: HMAC-SHA256 ──────────────────────────────────────────────────
  // Key  = serverSeed (raw bytes from hex)
  // Data = `${clientSeed}:${nonce}`
  const hmac = crypto.createHmac('sha256', Buffer.from(serverSeed, 'hex'));
  hmac.update(`${clientSeed}:${nonce}`);
  const hmacHex = hmac.digest('hex'); // 64 hex chars = 256 bits

  // ── Step 2: Extract 52-bit integer ──────────────────────────────────────
  // Specification mandates the first 13 hex characters (4 bits each = 52 bits)
  const first13Hex     = hmacHex.slice(0, 13);
  const extractedBigInt = BigInt('0x' + first13Hex);

  // ── Step 3: House edge gate ──────────────────────────────────────────────
  // The house "takes" rounds where extractedBigInt < EDGE_THRESHOLD.
  // Statistically this happens (EDGE_THRESHOLD / MAX_BITS) ≈ 3% of the time.
  if (extractedBigInt < EDGE_THRESHOLD) {
    return {
      crashMultiplier: 1.00,
      hmacHex,
      extractedBits: extractedBigInt.toString(),
    };
  }

  // ── Step 4: Crash multiplier calculation ─────────────────────────────────
  //
  //  rawMultiplier = (100 × MAX_BITS) / (MAX_BITS − extractedBigInt)
  //
  //  Both numerator and denominator are BigInts; BigInt division is integer
  //  (floor-truncates), which is exactly what we want.
  //
  //  The result is in "centi-multiplier" units (e.g. 125 → 1.25×).
  //  Convert by dividing by 100 with explicit 2-decimal precision.
  const numerator   = 100n * MAX_BITS;
  const denominator = MAX_BITS - extractedBigInt;

  // Guard: denominator should never be 0 given extractedBigInt < MAX_BITS,
  // but we add a defensive check for production safety.
  if (denominator <= 0n) {
    return {
      crashMultiplier: 1.00,
      hmacHex,
      extractedBits: extractedBigInt.toString(),
    };
  }

  const rawCentiMultiplier = numerator / denominator; // BigInt floor division

  // ── Step 5: 2-decimal truncation ────────────────────────────────────────
  // rawCentiMultiplier is already floor-divided (truncated), so converting
  // to Number and dividing by 100 gives us 2 decimal places without rounding.
  //
  // Safe: rawCentiMultiplier max = (100 × MAX_BITS) / 1 = ~4.5 × 10^17
  // which exceeds Number.MAX_SAFE_INTEGER. We must use Number carefully here.
  //
  // Solution: perform the /100 division in BigInt space first to get the
  // integer part, then extract the remainder for the fractional part.
  const integerPart    = rawCentiMultiplier / 100n;        // e.g. 125n → 1n
  const fractionalPart = rawCentiMultiplier % 100n;         // e.g. 125n → 25n

  // Both integerPart and fractionalPart are well within Number.MAX_SAFE_INTEGER
  // since integerPart ≤ MAX_BITS (2^52 < 2^53 - 1) and fractionalPart ≤ 99.
  const crashMultiplier = Number(integerPart) + Number(fractionalPart) / 100;

  // Enforce minimum of 1.00 (redundant after house edge gate but defensive)
  const finalMultiplier = Math.max(1.00, crashMultiplier);

  return {
    crashMultiplier: finalMultiplier,
    hmacHex,
    extractedBits: extractedBigInt.toString(),
  };
}

/**
 * XOR-folds two hex client seeds together.
 * Used to aggregate all player seeds during the betting phase.
 *
 * If one seed is empty, returns the other unchanged.
 * If lengths differ, the shorter seed is zero-padded.
 *
 * @param seedA - Hex string
 * @param seedB - Hex string
 * @returns XOR-combined hex string
 */
export function xorClientSeeds(seedA: string, seedB: string): string {
  if (!seedA) return seedB;
  if (!seedB) return seedA;

  // Normalise to equal length by zero-padding the shorter one on the left
  const maxLen = Math.max(seedA.length, seedB.length);
  const a = seedA.padStart(maxLen, '0');
  const b = seedB.padStart(maxLen, '0');

  let result = '';
  // Process in 8-char (4-byte) chunks for performance
  for (let i = 0; i < maxLen; i += 8) {
    const chunkA = a.slice(i, i + 8);
    const chunkB = b.slice(i, i + 8);
    const xored  = (parseInt(chunkA, 16) ^ parseInt(chunkB, 16))
      .toString(16)
      .padStart(chunkA.length, '0');
    result += xored;
  }
  return result;
}

/**
 * Verifies a completed round's Provably Fair outcome.
 * Called by the admin API and can be exposed to players for self-verification.
 *
 * @param input - All round parameters needed for verification
 * @returns VerificationResult with a boolean `valid` flag and computed values
 */
export function verifyRound(input: VerificationInput): VerificationResult {
  const { serverSeed, clientSeed, nonce, expectedHmac, expectedMultiplier } = input;

  // Recompute
  const result = computeCrashMultiplier(serverSeed, clientSeed, nonce);

  const hmacMatch        = result.hmacHex === expectedHmac;
  const multiplierMatch  = result.crashMultiplier === expectedMultiplier;
  const valid            = hmacMatch && multiplierMatch;

  // Verify the server seed hash commitment
  const recomputedHash = crypto
    .createHash('sha256')
    .update(Buffer.from(serverSeed, 'hex'))
    .digest('hex');

  const details = [
    `HMAC match: ${hmacMatch}`,
    `Multiplier match: ${multiplierMatch}`,
    `Computed multiplier: ${result.crashMultiplier}×`,
    `Expected multiplier: ${expectedMultiplier}×`,
    `Computed HMAC: ${result.hmacHex}`,
    `SHA-256(serverSeed): ${recomputedHash}`,
    `Extracted 52 bits: ${result.extractedBits}`,
    `EDGE_THRESHOLD: ${EDGE_THRESHOLD.toString()}`,
    `MAX_BITS: ${MAX_BITS.toString()}`,
  ].join('\n');

  return {
    valid,
    computedHmac:       result.hmacHex,
    computedMultiplier: result.crashMultiplier,
    extractedBits:      result.extractedBits,
    details,
  };
}

/**
 * Computes the elapsed time in milliseconds since a round started, given
 * a target multiplier. Used by the state machine to schedule crash events
 * and by the client to drive the animation curve.
 *
 * Formula (inverse of growth curve):
 *   multiplier(t) = e^(growth × t)
 *   t(multiplier) = ln(multiplier) / growth
 *
 * The growth constant is calibrated so that:
 *   - At t=0s → 1.00×
 *   - At t=10s → ~2.72× (e^1)
 *   - At t=30s → ~20× (approximation)
 *
 * growth = 0.00006 (per ms) → doubling every ~11.5s
 */
const GROWTH_CONSTANT_PER_MS = 0.00006;

export function multiplierToElapsedMs(targetMultiplier: number): number {
  if (targetMultiplier <= 1) return 0;
  return Math.log(targetMultiplier) / GROWTH_CONSTANT_PER_MS;
}

/**
 * Computes the multiplier value at a given elapsed time (ms).
 * This is the function the frontend animation loop uses.
 *
 * @param elapsedMs - Milliseconds since RUNNING_PHASE started
 * @returns Current multiplier value (2-decimal floor-truncated)
 */
export function elapsedMsToMultiplier(elapsedMs: number): number {
  const raw = Math.exp(GROWTH_CONSTANT_PER_MS * elapsedMs);
  return Math.floor(raw * 100) / 100; // 2-decimal floor truncation
}
