/**
 * @file GameRound.model.ts
 * @description Mongoose model for a single crash game round.
 *
 * Stores the full Provably Fair audit trail so any user can verify
 * the outcome was predetermined and not manipulated after bets were placed.
 *
 * Lifecycle:
 *   PENDING → BETTING → RUNNING → CRASHED
 */

import { Schema, model, Document, Types } from 'mongoose';

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum RoundStatus {
  PENDING  = 'pending',   // being prepared (seeds generated, hash published)
  BETTING  = 'betting',   // accepting bets (7s window)
  RUNNING  = 'running',   // multiplier climbing
  CRASHED  = 'crashed',   // round ended
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface IGameRound extends Document {
  _id:         Types.ObjectId;
  roundNumber: number;   // monotonically increasing global counter

  // ── Provably Fair Fields ────────────────────────────────────────────────────
  /**
   * The secret 32-byte seed known only to the server.
   * Published AFTER the round crashes so players can verify.
   */
  serverSeed:     string;
  /**
   * SHA-256 of serverSeed. Published BEFORE bets open
   * so players can confirm the seed was not changed.
   */
  serverSeedHash: string;
  /**
   * Aggregate client seed: XOR of all participating players' client seeds,
   * collected during the betting phase.
   */
  clientSeed:     string;
  /** Round-specific nonce for HMAC derivation */
  nonce:          number;
  /** Hex HMAC-SHA256 digest: hmac(serverSeed, `${clientSeed}:${nonce}`) */
  hmacHex:        string;

  // ── Outcome ─────────────────────────────────────────────────────────────────
  /** Predetermined crash point, calculated from hmacHex. 2-decimal places. */
  crashMultiplier: number;
  /** Elapsed ms from RUNNING start to crash */
  durationMs:      number;

  // ── Timing ──────────────────────────────────────────────────────────────────
  bettingStartAt?: Date;
  runningStartAt?: Date;
  crashedAt?:      Date;

  // ── Status ──────────────────────────────────────────────────────────────────
  status: RoundStatus;

  // ── Aggregates (denormalized for dashboard queries) ──────────────────────────
  totalBetsCents:  number;
  totalPayoutCents: number;
  houseEdgeCents:  number;
  playerCount:     number;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const GameRoundSchema = new Schema<IGameRound>(
  {
    roundNumber: {
      type:     Number,
      required: true,
      unique:   true,
      index:    true,
    },

    // Provably Fair
    serverSeed:     { type: String, required: true, select: false }, // hidden until round ends
    serverSeedHash: { type: String, required: true },
    clientSeed:     { type: String, default: '' },
    nonce:          { type: Number, required: true },
    hmacHex:        { type: String, default: '', select: false },    // hidden until round ends

    // Outcome — stored once calculated; 0 while PENDING/BETTING
    crashMultiplier: { type: Number, default: 0 },
    durationMs:      { type: Number, default: 0 },

    // Timing
    bettingStartAt: { type: Date },
    runningStartAt: { type: Date },
    crashedAt:      { type: Date },

    // Status
    status: {
      type:    String,
      enum:    Object.values(RoundStatus),
      default: RoundStatus.PENDING,
      index:   true,
    },

    // Aggregates
    totalBetsCents:   { type: Number, default: 0 },
    totalPayoutCents: { type: Number, default: 0 },
    houseEdgeCents:   { type: Number, default: 0 },
    playerCount:      { type: Number, default: 0 },
  },
  {
    timestamps: true,
    versionKey: '__v',
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

GameRoundSchema.index({ status: 1, createdAt: -1 });
GameRoundSchema.index({ crashedAt: -1 });        // For provably fair history feed
GameRoundSchema.index({ crashMultiplier: 1 });   // For analytics / high-roller queries

// ─── Export ───────────────────────────────────────────────────────────────────

export const GameRoundModel = model<IGameRound>('GameRound', GameRoundSchema);
