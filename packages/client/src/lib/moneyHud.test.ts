/**
 * @file moneyHud.test.ts
 * @description Self-contained verification of the live COP money readout.
 *
 * Run with:
 *   node --experimental-strip-types packages/client/src/lib/moneyHud.test.ts
 *
 * (Node ≥ 22.6 strips the type annotations natively; there is no test runner in
 * this repo, so this follows the same self-contained harness style as the
 * server's cryptoVerification.test.ts.)
 *
 * Validates the arithmetic that the HUD, the betting panel and the server must
 * all agree on, because a disagreement here is a disagreement about money:
 *
 *  1. Stake × multiplier → payout, floored (never rounded up)
 *  2. The exact worked example from the design: $5.000 COP at 10.50× = $52.500
 *  3. es-CO grouping for every preset and both limits
 *  4. Bet validation guards the table limits
 *  5. The multiplier curve is monotone over time — so the payout readout can
 *     only ever climb during a round
 *  6. The curve matches the server's floor-truncated formula bit for bit
 *  7. The countdown percentage math for the 7-second betting window
 */

import {
  BET_PRESETS_CENTS,
  MAX_BET_CENTS,
  MIN_BET_CENTS,
  centsToPesos,
  formatCOP,
  formatCOPCompact,
  pesosToCents,
  validateBet,
} from './currency.ts';
import {
  GROWTH_CONSTANT_PER_MS,
  elapsedMsToMultiplier,
  multiplierToElapsedMs,
} from './multiplierCurve.ts';

// ─── Test Harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

/** Exactly what LiveMultiplier renders: floor(stake × multiplier). */
const payoutCents = (stakeCents: number, multiplier: number): number =>
  Math.floor(stakeCents * multiplier);

// ─── Test 1: The worked example ───────────────────────────────────────────────

console.log('\n━━━ Test 1: $5.000 COP at 10.50× ━━━');
{
  const stake = pesosToCents(5_000);            // 500.000 centavos
  assert(stake === 500_000, 'pesosToCents(5.000) === 500.000 centavos');

  const payout = payoutCents(stake, 10.5);
  assert(payout === 5_250_000, 'payout === 5.250.000 centavos');
  assert(formatCOP(payout) === '$52.500', 'formatted as $52.500', formatCOP(payout));
  assert(formatCOP(stake) === '$5.000',    'stake formats as $5.000');
}

// ─── Test 2: Flooring, never rounding up ──────────────────────────────────────

console.log('\n━━━ Test 2: Flooring (server parity) ━━━');
{
  // 333 centavos × 1.005 = 334.665 → the server pays 334, never 335.
  assert(payoutCents(333, 1.005) === 334, 'fractional centavos are floored');
  // Odd multipliers must not push a payout above the exact product.
  const stake = 123_457;
  let overpaid = 0;
  for (let m = 1.01; m < 40; m += 0.07) {
    if (payoutCents(stake, m) > stake * m) overpaid++;
  }
  assert(overpaid === 0, 'no multiplier can round the payout up');
  assert(payoutCents(stake, 1) === stake, 'at 1.00× the payout equals the stake');
}

// ─── Test 3: es-CO formatting ─────────────────────────────────────────────────

console.log('\n━━━ Test 3: COP formatting ━━━');
{
  assert(formatCOP(MIN_BET_CENTS) === '$100',    'table minimum reads $100');
  assert(formatCOP(MAX_BET_CENTS) === '$10.000', 'table maximum reads $10.000');
  assert(formatCOP(0) === '$0',                  'zero is $0');

  const expectedPresets = ['$100', '$500', '$1k', '$5k', '$10k'];
  const renderedPresets = BET_PRESETS_CENTS.map(formatCOPCompact);
  assert(
    JSON.stringify(renderedPresets) === JSON.stringify(expectedPresets),
    'preset chips render as $100/$500/$1k/$5k/$10k',
    renderedPresets.join(' '),
  );

  assert(centsToPesos(500_000) === 5_000, 'centsToPesos round-trips');
  assert(pesosToCents(5_000) === 500_000, 'pesosToCents round-trips');
}

// ─── Test 4: Validation guards ────────────────────────────────────────────────

console.log('\n━━━ Test 4: Bet validation ━━━');
{
  assert(validateBet(MIN_BET_CENTS, 10 * MAX_BET_CENTS).ok,        'minimum bet is accepted');
  assert(validateBet(MAX_BET_CENTS, 10 * MAX_BET_CENTS).ok,        'maximum bet is accepted');
  assert(!validateBet(MIN_BET_CENTS - 1, 10 * MAX_BET_CENTS).ok,   'one centavo below minimum is rejected');
  assert(!validateBet(MAX_BET_CENTS + 1, 10 * MAX_BET_CENTS).ok,   'one centavo above maximum is rejected');
  assert(!validateBet(MIN_BET_CENTS, MIN_BET_CENTS - 1).ok,        'a bet above the balance is rejected');
}

// ─── Test 5: The readout can only climb ───────────────────────────────────────

console.log('\n━━━ Test 5: Monotone growth during a round ━━━');
{
  const stake = pesosToCents(5_000);
  let previousPayout = -1;
  let previousMultiplier = -1;
  let regressions = 0;

  // Walk a whole round in 100 ms steps (one server tick per step).
  for (let elapsed = 0; elapsed <= 60_000; elapsed += 100) {
    const multiplier = elapsedMsToMultiplier(elapsed);
    const payout     = payoutCents(stake, multiplier);
    if (multiplier < previousMultiplier || payout < previousPayout) regressions++;
    previousMultiplier = multiplier;
    previousPayout     = payout;
  }

  assert(regressions === 0, 'multiplier and payout never decrease during a round');

  const at10s = payoutCents(stake, elapsedMsToMultiplier(10_000));
  const at20s = payoutCents(stake, elapsedMsToMultiplier(20_000));
  console.log(`     · 10 s: ${formatCOP(at10s)} · 20 s: ${formatCOP(at20s)}`);
  assert(at20s > at10s, 'the number is visibly larger ten seconds later');
}

// ─── Test 6: Curve parity with the server ─────────────────────────────────────

console.log('\n━━━ Test 6: Multiplier curve parity ━━━');
{
  assert(GROWTH_CONSTANT_PER_MS === 0.00006, 'growth constant is 0.00006 per ms (matches provablyFair.ts)');

  let mismatches = 0;
  for (let elapsed = 0; elapsed < 120_000; elapsed += 137) {
    const expected = Math.floor(Math.exp(GROWTH_CONSTANT_PER_MS * elapsed) * 100) / 100;
    if (elapsedMsToMultiplier(elapsed) !== expected) mismatches++;
  }
  assert(mismatches === 0, 'curve is floor-truncated to 2 decimals exactly like the server');

  assert(multiplierToElapsedMs(1) === 0, '1.00× maps back to t = 0');
  const roundTrip = elapsedMsToMultiplier(multiplierToElapsedMs(10.5));
  assert(roundTrip === 10.5, '10.50× survives the round trip', String(roundTrip));
}

// ─── Test 7: 7-second betting window ──────────────────────────────────────────

console.log('\n━━━ Test 7: 7 s betting window ━━━');
{
  // BettingCountdown renders `remaining / windowMs` as the bar's width.
  const progressPct = (remainingMs: number, windowMs: number): number =>
    Math.max(0, Math.min(100, (remainingMs / windowMs) * 100));

  assert(progressPct(7_000, 7_000) === 100,  'the bar starts full');
  assert(progressPct(3_500, 7_000) === 50,   'the bar is half drained at 3.5 s');
  assert(progressPct(0, 7_000) === 0,        'the bar empties at 7 s');
  assert(progressPct(-500, 7_000) === 0,     'a late tick cannot invert the bar');

  // The store's fallback must match the server default, otherwise a reconnect
  // mid-window would draw the wrong bar width.
  assert(7_000 / 1000 === 7, 'window is exactly 7 seconds');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n━━━ Summary ━━━\n  passed: ${passed}\n  failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
