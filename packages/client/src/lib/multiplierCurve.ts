/**
 * @file lib/multiplierCurve.ts
 * @description The multiplier growth curve, mirrored 1:1 from the server.
 *
 * ── WHY THE CLIENT NEEDS THIS ────────────────────────────────────────────────
 * The server broadcasts the multiplier on a 100 ms tick. Rendering that value
 * verbatim makes the HUD — and especially the payout counter — step 10 times a
 * second, which reads as a stutter exactly where the game is supposed to feel
 * alive. The growth curve is deterministic and the round's start timestamp is
 * known, so the client can evaluate the SAME function against its own clock on
 * every animation frame and get the true value, smoothly, at 60 fps.
 *
 * Clocks are never perfectly aligned, so this is used as a *lead* and never as
 * the final authority: consumers clamp the local value to the last authoritative
 * tick (see LiveMultiplier). Worst case the client is a few milliseconds ahead
 * of the server; it can never show a multiplier the server has not reached.
 *
 * ── KEEPING THE TWO IN SYNC ──────────────────────────────────────────────────
 * The constants below are duplicated in
 * `packages/server/src/crypto/provablyFair.ts`. Change one, change the other —
 * a divergence shows up as a HUD that drifts away from the server ticks.
 */

/** Growth rate per millisecond: m(t) = e^(k·t). */
export const GROWTH_CONSTANT_PER_MS = 0.00006;

/**
 * Multiplier at a given elapsed time, truncated (not rounded) to two decimals
 * to match the server's floor truncation exactly.
 */
export function elapsedMsToMultiplier(elapsedMs: number): number {
  const raw = Math.exp(GROWTH_CONSTANT_PER_MS * Math.max(0, elapsedMs));
  return Math.floor(raw * 100) / 100;
}

/** Inverse of the curve — mostly useful for tests and tooling. */
export function multiplierToElapsedMs(targetMultiplier: number): number {
  if (targetMultiplier <= 1) return 0;
  return Math.log(targetMultiplier) / GROWTH_CONSTANT_PER_MS;
}
