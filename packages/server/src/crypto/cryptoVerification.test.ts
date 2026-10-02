/**
 * @file cryptoVerification.test.ts
 * @description Self-contained verification script for the Provably Fair engine.
 * Run with: npx ts-node src/crypto/cryptoVerification.test.ts
 *
 * Validates:
 *  1. SHA-256 hash commitment consistency
 *  2. HMAC-SHA256 determinism
 *  3. 52-bit extraction correctness
 *  4. House edge gate fires at the correct statistical rate
 *  5. BigInt precision — no floating point drift
 *  6. verifyRound() round-trip accuracy
 *  7. XOR seed aggregation
 */

import {
  generateSeedPair,
  computeCrashMultiplier,
  verifyRound,
  xorClientSeeds,
  multiplierToElapsedMs,
  elapsedMsToMultiplier,
} from './provablyFair';
import crypto from 'crypto';

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

// ─── Test 1: Seed Pair Generation ────────────────────────────────────────────

console.log('\n━━━ Test 1: Seed Pair Generation ━━━');
{
  const { serverSeed, serverSeedHash } = generateSeedPair();

  assert(serverSeed.length === 64,        'serverSeed is 64 hex chars (32 bytes)');
  assert(serverSeedHash.length === 64,    'serverSeedHash is 64 hex chars (SHA-256)');
  assert(/^[0-9a-f]+$/.test(serverSeed), 'serverSeed is valid hex');

  // Verify hash commitment
  const recomputedHash = crypto.createHash('sha256')
    .update(Buffer.from(serverSeed, 'hex'))
    .digest('hex');
  assert(recomputedHash === serverSeedHash, 'SHA-256 commitment is consistent');

  // Each call produces unique seeds (probability of collision ≈ 0)
  const { serverSeed: seed2 } = generateSeedPair();
  assert(serverSeed !== seed2, 'Each generateSeedPair() produces a unique seed');
}

// ─── Test 2: HMAC Determinism ─────────────────────────────────────────────────

console.log('\n━━━ Test 2: HMAC Determinism ━━━');
{
  const serverSeed = 'a'.repeat(64);  // Deterministic test seed
  const clientSeed = 'b'.repeat(16);
  const nonce      = 42;

  const r1 = computeCrashMultiplier(serverSeed, clientSeed, nonce);
  const r2 = computeCrashMultiplier(serverSeed, clientSeed, nonce);

  assert(r1.hmacHex === r2.hmacHex,
    'Same inputs produce identical HMAC hex');
  assert(r1.crashMultiplier === r2.crashMultiplier,
    'Same inputs produce identical crash multiplier');
  assert(r1.hmacHex.length === 64,
    'HMAC output is 64 hex chars (256 bits)');
  assert(r1.crashMultiplier >= 1.00,
    `Multiplier is ≥ 1.00 (got ${r1.crashMultiplier})`);
}

// ─── Test 3: Statistical House Edge ──────────────────────────────────────────

console.log('\n━━━ Test 3: Statistical House Edge (~3%) ━━━');
{
  const SAMPLES = 100_000;
  let instantCrashes = 0;
  const { serverSeed } = generateSeedPair();

  for (let nonce = 0; nonce < SAMPLES; nonce++) {
    const { crashMultiplier } = computeCrashMultiplier(
      serverSeed,
      `client_seed_${nonce % 1000}`,
      nonce,
    );
    if (crashMultiplier === 1.00) instantCrashes++;
  }

  const houseEdgeRate = instantCrashes / SAMPLES;
  // Allow ±0.5% statistical variance around 3%
  assert(
    houseEdgeRate >= 0.025 && houseEdgeRate <= 0.035,
    `House edge rate = ${(houseEdgeRate * 100).toFixed(3)}% (expected ~3.00%)`,
  );
}

// ─── Test 4: Precision & Truncation ──────────────────────────────────────────

console.log('\n━━━ Test 4: Decimal Precision (2-decimal truncation) ━━━');
{
  const { serverSeed } = generateSeedPair();
  const errors: string[] = [];

  for (let nonce = 0; nonce < 10_000; nonce++) {
    const { crashMultiplier } = computeCrashMultiplier(serverSeed, 'test', nonce);
    // Check that multiplier has at most 2 decimal places
    const str       = crashMultiplier.toString();
    const dotIndex  = str.indexOf('.');
    const decimals  = dotIndex >= 0 ? str.length - dotIndex - 1 : 0;
    if (decimals > 2) {
      errors.push(`nonce=${nonce}: multiplier=${crashMultiplier} has ${decimals} decimals`);
    }
  }

  assert(errors.length === 0,
    `All 10,000 multipliers have ≤ 2 decimal places`,
    errors.slice(0, 3).join('; '));
}

// ─── Test 5: verifyRound() Round-trip ────────────────────────────────────────

console.log('\n━━━ Test 5: verifyRound() Round-trip ━━━');
{
  const { serverSeed } = generateSeedPair();
  const clientSeed     = 'player_seed_abc';
  const nonce          = 7;

  const { crashMultiplier, hmacHex } = computeCrashMultiplier(serverSeed, clientSeed, nonce);

  const result = verifyRound({
    serverSeed,
    clientSeed,
    nonce,
    expectedHmac:        hmacHex,
    expectedMultiplier:  crashMultiplier,
  });

  assert(result.valid,          'verifyRound() returns valid=true for authentic data');
  assert(result.computedHmac === hmacHex, 'Computed HMAC matches expected');

  // Tamper test: change one bit of serverSeed
  const tamperedSeed = serverSeed.slice(0, -1) + (serverSeed.endsWith('0') ? '1' : '0');
  const tamperedResult = verifyRound({
    serverSeed:         tamperedSeed,
    clientSeed,
    nonce,
    expectedHmac:        hmacHex,
    expectedMultiplier:  crashMultiplier,
  });
  assert(!tamperedResult.valid, 'verifyRound() returns valid=false for tampered seed');
}

// ─── Test 6: XOR Client Seed Aggregation ──────────────────────────────────────

console.log('\n━━━ Test 6: XOR Client Seed Aggregation ━━━');
{
  const seedA = 'abcdef01';
  const seedB = '12345678';

  const combined = xorClientSeeds(seedA, seedB);
  assert(combined.length === 8,   'XOR output has same length as inputs');

  // XOR is its own inverse: A XOR B XOR B = A
  const restored = xorClientSeeds(combined, seedB);
  assert(restored === seedA,      'XOR is self-inverse (A XOR B XOR B = A)');

  // Edge cases
  assert(xorClientSeeds('', seedB) === seedB, 'Empty seedA returns seedB unchanged');
  assert(xorClientSeeds(seedA, '') === seedA, 'Empty seedB returns seedA unchanged');
}

// ─── Test 7: Time ↔ Multiplier Conversion ─────────────────────────────────────

console.log('\n━━━ Test 7: Time ↔ Multiplier Conversion ━━━');
{
  // At t=0, multiplier should be 1.00
  assert(elapsedMsToMultiplier(0) === 1.00, 'elapsedMsToMultiplier(0) = 1.00');

  // Round-trip: M → t → M should recover the multiplier (within truncation)
  const targetM = 2.50;
  const t       = multiplierToElapsedMs(targetM);
  const recovered = elapsedMsToMultiplier(t);
  // Truncation may reduce by up to 0.01
  assert(
    Math.abs(recovered - targetM) < 0.02,
    `Round-trip 2.50× → ${t.toFixed(0)}ms → ${recovered}× (within 0.02 tolerance)`,
  );

  // Larger multipliers take more time
  const t1 = multiplierToElapsedMs(2);
  const t5 = multiplierToElapsedMs(5);
  assert(t5 > t1, `Higher multipliers require more time (t(5×)=${t5.toFixed(0)}ms > t(2×)=${t1.toFixed(0)}ms)`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'━'.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n⚠️  ${failed} test(s) failed!`);
  process.exit(1);
} else {
  console.log('\n🎮 All Provably Fair tests passed!');
}
