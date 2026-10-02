/**
 * @file lib/currency.ts
 * @description Colombian Peso (COP) money handling for the whole client.
 *
 * ── INTERNAL UNIT ────────────────────────────────────────────────────────────
 * Every amount in the system — balances, bets, payouts — is an INTEGER number
 * of centavos (1 COP = 100 centavos). Integers avoid floating-point drift in
 * balance arithmetic, which matters because a rounding error here is real
 * money. The existing field names (`amountCents`, `balanceCents`) are kept as
 * the generic "minor currency unit" convention rather than renamed.
 *
 * ── SINGLE SOURCE OF TRUTH ───────────────────────────────────────────────────
 * MUST be kept in sync with packages/server/src/game/limits.ts.
 * If these two ever disagree the UI will offer a bet the server rejects.
 */

// ─── Currency identity ────────────────────────────────────────────────────────

export const CURRENCY_CODE   = 'COP';
export const CURRENCY_SYMBOL = '$';
export const LOCALE          = 'es-CO';

/** COP is subdivided into 100 centavos. */
export const CENTAVOS_PER_PESO = 100;

// ─── Betting limits (centavos) ────────────────────────────────────────────────

/** $100 COP */
export const MIN_BET_CENTS = 10_000;

/** $10,000 COP */
export const MAX_BET_CENTS = 1_000_000;

/**
 * Quick-pick amounts, as whole pesos.
 * Spread deliberately so the low end stays reachable and the high end matches
 * the table maximum.
 */
export const BET_PRESETS_PESOS = [100, 500, 1_000, 5_000, 10_000] as const;

/** Same presets expressed in centavos, for direct use as bet values. */
export const BET_PRESETS_CENTS = BET_PRESETS_PESOS.map(
  (pesos) => pesos * CENTAVOS_PER_PESO,
);

/** Default bet when the panel first mounts — the table minimum. */
export const DEFAULT_BET_CENTS = MIN_BET_CENTS;

// ─── Conversions ──────────────────────────────────────────────────────────────

export function centsToPesos(cents: number): number {
  return Math.round(cents) / CENTAVOS_PER_PESO;
}

export function pesosToCents(pesos: number): number {
  return Math.round(pesos * CENTAVOS_PER_PESO);
}

// ─── Formatting ───────────────────────────────────────────────────────────────
//
// The number is formatted with es-CO grouping (dot as the thousands separator)
// and the `$` is prepended manually.
//
// Intl's `style: 'currency'` is deliberately NOT used: for COP it emits
// "$ 1.500" with a non-breaking space, which reads oddly inside a compact
// button and makes the string awkward to compare or test.

const numberFormatter = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** `$1.500` — full amount, no decimals. */
export function formatCOP(cents: number): string {
  return `${CURRENCY_SYMBOL}${numberFormatter.format(centsToPesos(cents))}`;
}

/**
 * `1.5k` / `1.2M` for tight spaces (crash-history rows, bet tables).
 * Uses decimal thousands/millions, which is how COP amounts are read aloud.
 */
export function formatCOPCompact(cents: number): string {
  const pesos = centsToPesos(cents);

  if (Math.abs(pesos) >= 1_000_000) {
    return `${CURRENCY_SYMBOL}${(pesos / 1_000_000).toFixed(pesos % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (Math.abs(pesos) >= 1_000) {
    return `${CURRENCY_SYMBOL}${(pesos / 1_000).toFixed(pesos % 1_000 === 0 ? 0 : 1)}k`;
  }
  return `${CURRENCY_SYMBOL}${numberFormatter.format(pesos)}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface BetValidation {
  ok:    boolean;
  error: string | null;
}

/**
 * Validates a bet against the table limits and the player's balance.
 * Returns a user-facing message so callers never have to build one.
 */
export function validateBet(amountCents: number, balanceCents: number): BetValidation {
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'Ingresa un monto válido' };
  }
  if (amountCents < MIN_BET_CENTS) {
    return { ok: false, error: `La apuesta mínima es ${formatCOP(MIN_BET_CENTS)}` };
  }
  if (amountCents > MAX_BET_CENTS) {
    return { ok: false, error: `La apuesta máxima es ${formatCOP(MAX_BET_CENTS)}` };
  }
  if (amountCents > balanceCents) {
    return { ok: false, error: 'Saldo insuficiente' };
  }
  return { ok: true, error: null };
}

/** Clamps an arbitrary amount into the legal betting range. */
export function clampBet(amountCents: number, balanceCents: number): number {
  const ceiling = Math.min(MAX_BET_CENTS, Math.max(0, balanceCents));
  return Math.min(ceiling, Math.max(MIN_BET_CENTS, Math.round(amountCents)));
}
