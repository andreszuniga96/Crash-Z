/**
 * @file game/limits.ts
 * @description Betting limits, denominated in centavos of Colombian Peso (COP).
 *
 * The server is the authority on these values — the client mirrors them for
 * display and to disable buttons before a round-trip, but every PLACE_BET is
 * re-validated here.
 *
 * MUST be kept in sync with packages/client/src/lib/currency.ts.
 */

export const CURRENCY_CODE = 'COP';

/** 1 COP = 100 centavos. */
export const CENTAVOS_PER_PESO = 100;

/** $100 COP */
export const MIN_BET_CENTS = 10_000;

/** $10,000 COP */
export const MAX_BET_CENTS = 1_000_000;

// ─── Administrative balance movements ─────────────────────────────────────────
//
// These are DELIBERATELY separate from the table limits above. Reusing
// MAX_BET_CENTS as the deposit cap (which is what the old `10_000_00` did) ties
// a back-office bank deposit to the maximum single bet — so once the currency
// became COP, an admin could not credit a player with more than 10,000 COP
// (about $2.50) in one operation.

/** 10 COP — rejects dust/typo amounts. */
export const MIN_ADJUSTMENT_CENTS = 1_000;

/** 10,000,000 COP — generous ceiling for simulated bank deposits. */
export const MAX_ADJUSTMENT_CENTS = 1_000_000_000;

// ─── Daily player limits ───────────────────────────────────────────────────────
//
// These apply to PLAYER-initiated transactions (deposits and withdrawals).
// Admin adjustments are NOT subject to these limits.
//
// The low caps are intentional: the platform is designed for small bets
// accessible to anyone. Llave / Nequi / Daviplata are the accepted channels.

/** $10,000 COP — maximum a player may deposit per calendar day. */
export const MAX_DAILY_DEPOSIT_CENTS    = 1_000_000;   // $10,000 COP

/** $50,000 COP — maximum a player may withdraw per calendar day. */
export const MAX_DAILY_WITHDRAWAL_CENTS = 5_000_000;   // $50,000 COP

/**
 * Formats centavos as a readable COP string for error messages and logs.
 * Mirrors the client's `formatCOP`, but stays dependency-free.
 */
export function formatCOP(cents: number): string {
  const pesos = Math.round(cents) / CENTAVOS_PER_PESO;
  return `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(pesos)}`;
}
