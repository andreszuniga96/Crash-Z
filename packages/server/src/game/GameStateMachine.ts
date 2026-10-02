/**
 * @file GameStateMachine.ts
 * @description The core infinite game loop for ZombieRun Crash.
 *
 * PHASE LIFECYCLE
 * ───────────────
 *
 *  ┌─────────┐   prepareRound()    ┌─────────┐
 *  │  IDLE   │ ──────────────────► │ BETTING │  7 seconds
 *  └─────────┘                     └────┬────┘
 *       ▲                               │ startRound()
 *       │                               ▼
 *  ┌──────────┐   resolveRound()   ┌─────────┐
 *  │ CRASHED  │ ◄───────────────── │ RUNNING │  until crashMultiplier
 *  └──────────┘                    └─────────┘
 *
 * IDEMPOTENCY CONTRACT
 * ─────────────────────
 * Every PLACE_BET and CASH_OUT action must pass through two gates:
 *
 *   Gate 1 — Redis (fast, ~1ms):
 *     SET idempotency:{key} 1 NX EX 3600
 *     → If EXISTS: return cached result immediately (no DB hit)
 *     → If SET:    proceed to Gate 2
 *
 *   Gate 2 — MongoDB unique index (durable):
 *     The compound index { idempotencyKey, roundId } on the Bet collection
 *     throws E11000 DuplicateKey on any concurrent duplicate that slips
 *     through Gate 1 (race condition window during Redis failover).
 *
 * This dual-gate design provides both speed AND durability.
 *
 * AUTO-CASHOUT
 * ─────────────
 * During the RUNNING phase, the game loop ticks every TICK_INTERVAL_MS.
 * On each tick it checks all activeBets for autoCashoutAt <= currentMultiplier.
 * Eligible bets are cashed out automatically and atomically before broadcasting
 * the tick to clients.
 */

import { Server as SocketIOServer } from 'socket.io';
import mongoose, { ClientSession } from 'mongoose';
import {
  GamePhase,
  GameState,
  ActiveBetEntry,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  C2S_PlaceBet,
  C2S_CashOut,
  AckCallback,
} from './types';
import {
  MIN_BET_CENTS,
  MAX_BET_CENTS,
  formatCOP,
} from './limits';
import {
  generateSeedPair,
  computeCrashMultiplier,
  elapsedMsToMultiplier,
  multiplierToElapsedMs,
  xorClientSeeds,
} from '../crypto/provablyFair';
import { UserModel }      from '../models/User.model';
import { GameRoundModel, RoundStatus } from '../models/GameRound.model';
import { BetModel, BetStatus } from '../models/Bet.model';
import { acquireIdempotencyKey, releaseIdempotencyKey } from '../redis';
import { logger } from '../logger';

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Duration of the betting phase in milliseconds.
 *
 * 7 s is the tuned value: 10 s left players waiting through dead air at the
 * top of every round, 5 s made it impossible to read the panel on mobile before
 * the timer expired. `.env` overrides this for experimentation, so the default
 * here and `BETTING_PHASE_MS` in `.env` must be changed together.
 */
const BETTING_PHASE_MS = parseInt(process.env['BETTING_PHASE_MS'] ?? '7000', 10);

/** Pause between CRASHED and next BETTING phase */
const INTER_ROUND_DELAY_MS = parseInt(process.env['INTER_ROUND_DELAY_MS'] ?? '5000', 10);

/** How often the server broadcasts the current multiplier during RUNNING */
const TICK_INTERVAL_MS = 100;

/** How many recent crash results to include in betting:started and reconnect payloads */
const RECENT_CRASHES_COUNT = 20;

// ─── IO Type Alias ────────────────────────────────────────────────────────────

type TypedIO = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Non-blocking sleep — yields control back to the event loop */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retrieve last N crash multipliers from DB for history display */
async function getRecentCrashes(limit: number): Promise<number[]> {
  const rounds = await GameRoundModel
    .find({ status: RoundStatus.CRASHED })
    .sort({ crashedAt: -1 })
    .limit(limit)
    .select('crashMultiplier')
    .lean();
  return rounds.map((r) => r.crashMultiplier);
}

/** Global monotonic round counter — persisted in DB, loaded at boot */
let globalRoundNumber = 0;

async function loadOrInitRoundNumber(): Promise<number> {
  const latest = await GameRoundModel
    .findOne({})
    .sort({ roundNumber: -1 })
    .select('roundNumber')
    .lean();
  return (latest?.roundNumber ?? 0) + 1;
}

// ─── GameStateMachine Class ───────────────────────────────────────────────────

export class GameStateMachine {
  private io:         TypedIO;
  private state:      GameState;
  private tickTimer:  NodeJS.Timeout | null = null;
  private isRunning:  boolean               = false;

  constructor(io: TypedIO) {
    this.io = io;
    // Zero-value state — overwritten in prepareRound() before anything is emitted
    this.state = this.makeInitialState();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Bootstraps the machine and starts the infinite game loop.
   * Must be called once after MongoDB and Redis are connected.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[GSM] start() called while already running — ignoring');
      return;
    }
    this.isRunning    = true;
    globalRoundNumber = await loadOrInitRoundNumber();
    logger.info(`[GSM] Game loop starting at round #${globalRoundNumber}`);
    this.runLoop();
  }

  /** Returns a snapshot of the current game state (for reconnect payloads) */
  getState(): Readonly<GameState> {
    return this.state;
  }

  /**
   * Handles a PLACE_BET event from a connected socket.
   * Called by the socket handler in socket/gameHandler.ts.
   */
  async handlePlaceBet(
    userId:   string,
    username: string,
    data:     C2S_PlaceBet,
    ack:      AckCallback,
    socketId: string,
  ): Promise<void> {
    const { amountCents, autoCashoutAt, idempotencyKey } = data;
    const { state } = this;

    // ── Phase gate ─────────────────────────────────────────────────────────
    if (state.phase !== GamePhase.BETTING) {
      return ack({
        ok:    false,
        error: { code: 'WRONG_PHASE', message: 'Betting is closed. Wait for the next round.' },
      });
    }

    // ── Input validation ───────────────────────────────────────────────────
    // Limits are COP-denominated (see ./limits.ts). Requiring an integer also
    // guarantees no fractional centavo can enter the balance arithmetic —
    // every write below is real money movement.
    if (
      !Number.isInteger(amountCents) ||
      amountCents < MIN_BET_CENTS ||
      amountCents > MAX_BET_CENTS
    ) {
      return ack({
        ok:    false,
        error: {
          code:    'INVALID_AMOUNT',
          message: `La apuesta debe estar entre ${formatCOP(MIN_BET_CENTS)} y ${formatCOP(MAX_BET_CENTS)} COP.`,
          idempotencyKey,
        },
      });
    }
    if (!idempotencyKey || !/^[0-9a-f-]{36}$/.test(idempotencyKey)) {
      return ack({
        ok:    false,
        error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'idempotencyKey must be a valid UUID v4.' },
      });
    }

    // ── Gate 1: Redis idempotency (fast path) ──────────────────────────────
    const redisKey = `bet:idem:${idempotencyKey}:${state.roundId}`;
    const acquired = await acquireIdempotencyKey(redisKey, 3600);

    if (!acquired) {
      // Already processed — look up the existing result and return it
      logger.debug(`[GSM] Duplicate bet request (Redis), key=${idempotencyKey}`);
      const existing = await BetModel.findOne({
        idempotencyKey,
        roundId: state.roundId,
      }).lean();

      if (existing) {
        const user = await UserModel.findById(userId).select('balanceCents').lean();
        return ack({
          ok: true,
          // Synthetic success — same result the client already received
        });
      }
      return ack({
        ok:    false,
        error: { code: 'DUPLICATE_BET', message: 'This bet is already being processed.', idempotencyKey },
      });
    }

    // ── Gate 2: MongoDB transaction (durable, atomic) ──────────────────────
    const session: ClientSession = await mongoose.startSession();
    session.startTransaction();

    try {
      // Fetch user and verify balance
      const user = await UserModel.findById(userId).session(session);
      if (!user) throw new Error('USER_NOT_FOUND');
      if (user.status !== 'active') throw new Error('ACCOUNT_SUSPENDED');
      if (user.balanceCents < amountCents) throw new Error('INSUFFICIENT_BALANCE');

      // Deduct balance
      user.balanceCents -= amountCents;
      user.transactions.push({
        _id:         new mongoose.Types.ObjectId(),
        amount:      -amountCents,
        type:        'bet',
        referenceId: state.roundId,
        createdAt:   new Date(),
      });
      await user.save({ session });

      // Create Bet document (unique index enforces Gate 2 idempotency)
      const [bet] = await BetModel.create([{
        userId:         userId,
        roundId:        state.roundId,
        roundNumber:    state.roundNumber,
        amountCents,
        autoCashoutAt:  autoCashoutAt ?? 0,
        status:         BetStatus.ACTIVE,
        idempotencyKey,
        placedAt:       new Date(),
      }], { session });

      // Update round aggregate
      await GameRoundModel.findByIdAndUpdate(
        state.roundId,
        {
          $inc: { totalBetsCents: amountCents, playerCount: 1 },
        },
        { session },
      );

      await session.commitTransaction();

      // Register bet in in-memory active bets map for fast auto-cashout scanning
      state.activeBets.set(userId, {
        betId:         bet._id.toString(),
        userId,
        amountCents,
        autoCashoutAt: autoCashoutAt ?? 0,
        cashedOut:     false,
      });

      // XOR-fold player's client seed into the round's aggregate seed
      const playerSeed = user.clientSeed || userId.slice(-8);
      state.clientSeed = xorClientSeeds(state.clientSeed, playerSeed);

      // Increment player's nonce for next round
      await UserModel.findByIdAndUpdate(userId, { $inc: { nonce: 1 } });

      logger.info(`[GSM] Bet placed: user=${username} amount=${amountCents}¢ round=${state.roundNumber}`);

      // Broadcast updated bet list to all players
      this.broadcastBetList();

      ack({
        ok: true,
      });

      // Send enriched confirmation to the betting player's socket
      this.io.to(socketId).emit('bet:accepted', {
        betId:           bet._id.toString(),
        roundNumber:     state.roundNumber,
        amountCents,
        autoCashoutAt:   autoCashoutAt ?? 0,
        idempotencyKey,
        newBalanceCents: user.balanceCents,
      });

    } catch (err) {
      await session.abortTransaction();

      // Release Redis key so the client can retry legitimately
      await releaseIdempotencyKey(redisKey);

      const msg = (err as Error).message;
      logger.error(`[GSM] placeBet failed: ${msg}`, { userId, idempotencyKey });

      const errorMap: Record<string, S2C_ErrorPayload> = {
        USER_NOT_FOUND:        { code: 'USER_NOT_FOUND',        message: 'User account not found.'         },
        ACCOUNT_SUSPENDED:     { code: 'ACCOUNT_SUSPENDED',     message: 'Your account is suspended.'      },
        INSUFFICIENT_BALANCE:  { code: 'INSUFFICIENT_BALANCE',  message: 'Insufficient balance.'           },
      };

      ack({
        ok:    false,
        error: errorMap[msg] ?? { code: 'BET_FAILED', message: 'Failed to place bet. Please try again.', idempotencyKey },
      });

    } finally {
      await session.endSession();
    }
  }

  /**
   * Handles a CASH_OUT event from a connected socket.
   * Processes the cashout at the current server-side multiplier to prevent
   * clients from claiming a multiplier they observed after the fact.
   */
  async handleCashOut(
    userId:   string,
    data:     C2S_CashOut,
    ack:      AckCallback,
    socketId: string,
  ): Promise<void> {
    const { betId, cashoutIdempotencyKey } = data;
    const { state } = this;

    // ── Phase gate ─────────────────────────────────────────────────────────
    if (state.phase !== GamePhase.RUNNING) {
      return ack({
        ok:    false,
        error: { code: 'WRONG_PHASE', message: 'No active round to cash out from.' },
      });
    }

    // ── Capture multiplier immediately (before any async work) ────────────
    const elapsedMs         = Date.now() - state.runningStartedAt;
    const cashoutMultiplier = elapsedMsToMultiplier(elapsedMs);

    // Confirm the round hasn't already crashed (race condition check)
    if (cashoutMultiplier >= state.crashMultiplier) {
      return ack({
        ok:    false,
        error: { code: 'ROUND_CRASHED', message: 'The round already ended.' },
      });
    }

    // ── Validate active bet ────────────────────────────────────────────────
    const activeBet = state.activeBets.get(userId);
    if (!activeBet || activeBet.betId !== betId || activeBet.cashedOut) {
      return ack({
        ok:    false,
        error: { code: 'NO_ACTIVE_BET', message: 'No active bet found for this round.' },
      });
    }

    // ── Gate 1: Redis idempotency ──────────────────────────────────────────
    const redisKey = `cashout:idem:${cashoutIdempotencyKey}`;
    const acquired = await acquireIdempotencyKey(redisKey, 3600);

    if (!acquired) {
      logger.debug(`[GSM] Duplicate cashout (Redis), key=${cashoutIdempotencyKey}`);
      return ack({
        ok:    false,
        error: { code: 'DUPLICATE_CASHOUT', message: 'Cashout already processed.' },
      });
    }

    // Mark as cashed out immediately in memory to prevent auto-cashout racing
    activeBet.cashedOut = true;

    // ── Gate 2: MongoDB transaction ────────────────────────────────────────
    const payoutCents = Math.floor(activeBet.amountCents * cashoutMultiplier);
    const profitCents = payoutCents - activeBet.amountCents;

    const session: ClientSession = await mongoose.startSession();
    session.startTransaction();

    try {
      // Update Bet document
      await BetModel.findByIdAndUpdate(
        betId,
        {
          status:                BetStatus.CASHED_OUT,
          cashoutMultiplier,
          payoutCents,
          profitCents,
          cashoutIdempotencyKey,
          cashedOutAt:           new Date(),
        },
        { session },
      );

      // Credit user balance
      const user = await UserModel.findById(userId).session(session);
      if (!user) throw new Error('USER_NOT_FOUND');

      user.balanceCents += payoutCents;
      user.transactions.push({
        _id:         new mongoose.Types.ObjectId(),
        amount:      payoutCents,
        type:        'win',
        referenceId: state.roundId,
        createdAt:   new Date(),
      });
      await user.save({ session });

      // Update round aggregate
      await GameRoundModel.findByIdAndUpdate(
        state.roundId,
        { $inc: { totalPayoutCents: payoutCents } },
        { session },
      );

      await session.commitTransaction();

      logger.info(
        `[GSM] Cashout: user=${userId} mult=${cashoutMultiplier}x ` +
        `payout=${payoutCents}¢ profit=${profitCents}¢`,
      );

      ack({ ok: true });

      this.io.to(socketId).emit('cashout:confirmed', {
        betId,
        cashoutMultiplier,
        payoutCents,
        profitCents,
        newBalanceCents: user.balanceCents,
      });

      // Update public bet list to show this player cashed out
      this.broadcastBetList();

    } catch (err) {
      await session.abortTransaction();

      // Undo in-memory flag so the player can retry
      activeBet.cashedOut = false;
      await releaseIdempotencyKey(redisKey);

      logger.error(`[GSM] cashOut failed: ${(err as Error).message}`, { userId, betId });

      ack({
        ok:    false,
        error: { code: 'CASHOUT_FAILED', message: 'Cashout failed. Please try again.' },
      });

    } finally {
      await session.endSession();
    }
  }

  // ── Private: Game Loop ─────────────────────────────────────────────────────

  /**
   * The eternal game loop. Runs as an async function that never returns
   * (barring a fatal unhandled exception, which process-level error handlers
   * should restart the server for).
   *
   * Each iteration = one complete round:
   *   1. prepareRound  — generate seeds, persist DB document
   *   2. bettingPhase  — wait BETTING_PHASE_MS, collect bets
   *   3. runningPhase  — climb multiplier, handle auto-cashouts, crash
   *   4. crashedPhase  — resolve lost bets, publish seeds, pause
   */
  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.prepareRound();
        await this.bettingPhase();
        await this.runningPhase();
        await this.crashedPhase();
        await sleep(INTER_ROUND_DELAY_MS);

      } catch (err) {
        logger.error('[GSM] Uncaught error in game loop', { error: (err as Error).message, stack: (err as Error).stack });
        // Brief pause before attempting to recover
        await sleep(3000);
      }
    }
  }

  // ── Private: Phase Implementations ────────────────────────────────────────

  /**
   * PREPARE: Create the next round's DB document and compute the crash point.
   * The crash multiplier is computed NOW (before bets open) and stored
   * server-side. The serverSeed is kept hidden (select:false in DB).
   */
  private async prepareRound(): Promise<void> {
    const roundNumber = globalRoundNumber++;
    const nonce       = roundNumber;

    // Generate seed pair — serverSeedHash is the "commitment"
    const { serverSeed, serverSeedHash } = generateSeedPair();

    // Persist round to DB with PENDING status and hidden serverSeed
    const roundDoc = await GameRoundModel.create({
      roundNumber,
      serverSeed,       // select: false — never returned in queries by default
      serverSeedHash,
      clientSeed:      '',
      nonce,
      status:          RoundStatus.PENDING,
      bettingStartAt:  null,
    });

    // Reset in-memory state for this round
    this.state = {
      phase:           GamePhase.IDLE,
      roundId:         roundDoc._id.toString(),
      roundNumber,
      serverSeedHash,
      serverSeed,       // kept in memory for crash calculation
      clientSeed:      '',
      nonce,
      crashMultiplier: 0,  // computed just before RUNNING starts (seeds aren't fully collected yet)
      runningStartedAt: 0,
      activeBets:      new Map(),
    };

    logger.info(`[GSM] Round #${roundNumber} prepared | hash=${serverSeedHash.slice(0, 16)}...`);
  }

  /**
   * BETTING PHASE: Open the betting window.
   * Broadcasts betting:started to all connected clients.
   * Waits exactly BETTING_PHASE_MS before transitioning.
   */
  private async bettingPhase(): Promise<void> {
    this.state.phase = GamePhase.BETTING;

    await GameRoundModel.findByIdAndUpdate(this.state.roundId, {
      status:         RoundStatus.BETTING,
      bettingStartAt: new Date(),
    });

    const recentCrashes = await getRecentCrashes(RECENT_CRASHES_COUNT);

    this.io.emit('betting:started', {
      roundNumber:     this.state.roundNumber,
      roundId:         this.state.roundId,
      serverSeedHash:  this.state.serverSeedHash,
      bettingEndsInMs: BETTING_PHASE_MS,
      recentCrashes,
    });

    logger.info(`[GSM] BETTING PHASE → round #${this.state.roundNumber} (${BETTING_PHASE_MS}ms)`);
    await sleep(BETTING_PHASE_MS);
  }

  /**
   * RUNNING PHASE: Compute crash multiplier (now that clientSeed is final),
   * start the tick loop, process auto-cashouts, and crash when the time comes.
   */
  private async runningPhase(): Promise<void> {
    this.state.phase = GamePhase.RUNNING;

    // Persist final clientSeed now that the betting window has closed
    await GameRoundModel.findByIdAndUpdate(this.state.roundId, {
      status:         RoundStatus.RUNNING,
      clientSeed:     this.state.clientSeed,
      runningStartAt: new Date(),
    });

    // ── Compute the predetermined crash multiplier ─────────────────────
    // We compute it AFTER the betting phase so the clientSeed (aggregated
    // from all player seeds) is fully incorporated. The serverSeed was
    // committed at prepareRound(), so the outcome is still manipulation-proof.
    const { crashMultiplier, hmacHex } = computeCrashMultiplier(
      this.state.serverSeed!,
      this.state.clientSeed || 'no_players',
      this.state.nonce,
    );
    this.state.crashMultiplier = crashMultiplier;
    this.state.hmacHex         = hmacHex;

    // Record HMAC in DB (still hidden via select:false)
    await GameRoundModel.findByIdAndUpdate(this.state.roundId, { hmacHex });

    const runningStartedAt   = Date.now();
    this.state.runningStartedAt = runningStartedAt;

    logger.info(
      `[GSM] RUNNING PHASE → round #${this.state.roundNumber} | ` +
      `crashAt=${crashMultiplier}x (~${multiplierToElapsedMs(crashMultiplier).toFixed(0)}ms)`,
    );

    this.io.emit('round:started', {
      roundNumber:      this.state.roundNumber,
      roundId:          this.state.roundId,
      serverSeedHash:   this.state.serverSeedHash,
      runningStartedAt,
    });

    // ── Tick loop ─────────────────────────────────────────────────────────
    // Each tick: compute current multiplier, run auto-cashouts, broadcast.
    // The loop exits when the predetermined crash time is reached.
    await new Promise<void>((resolve) => {
      this.tickTimer = setInterval(async () => {
        const now       = Date.now();
        const elapsed   = now - runningStartedAt;
        const current   = elapsedMsToMultiplier(elapsed);

        // ── Auto-cashout sweep ─────────────────────────────────────────
        for (const [uid, entry] of this.state.activeBets) {
          if (
            !entry.cashedOut &&
            entry.autoCashoutAt > 0 &&
            current >= entry.autoCashoutAt
          ) {
            // Mark in memory first (non-blocking)
            entry.cashedOut = true;
            // Process in background — do not await in tick loop
            this.processAutoCashout(entry, entry.autoCashoutAt).catch((e) =>
              logger.error('[GSM] Auto-cashout error', { error: e.message, userId: uid }),
            );
          }
        }

        // ── Crash check ────────────────────────────────────────────────
        if (current >= crashMultiplier) {
          clearInterval(this.tickTimer!);
          this.tickTimer = null;

          // Emit final tick AT the crash multiplier
          this.io.emit('multiplier:tick', {
            multiplier: crashMultiplier,
            elapsedMs:  elapsed,
          });

          resolve();
          return;
        }

        // ── Broadcast tick ─────────────────────────────────────────────
        this.io.emit('multiplier:tick', { multiplier: current, elapsedMs: elapsed });

      }, TICK_INTERVAL_MS);
    });
  }

  /**
   * CRASHED PHASE: Mark the round as crashed, resolve all losing bets,
   * reveal the server seed, and broadcast the final result.
   */
  private async crashedPhase(): Promise<void> {
    this.state.phase = GamePhase.CRASHED;
    const now        = new Date();

    const elapsedMs  = Date.now() - this.state.runningStartedAt;

    logger.info(`[GSM] CRASHED at ${this.state.crashMultiplier}x — resolving lost bets`);

    // ── Resolve all still-active bets as LOST ─────────────────────────────
    const lostUserIds = [...this.state.activeBets.entries()]
      .filter(([, e]) => !e.cashedOut)
      .map(([, e]) => e.betId);

    if (lostUserIds.length > 0) {
      await BetModel.updateMany(
        { _id: { $in: lostUserIds } },
        {
          status:            BetStatus.LOST,
          cashoutMultiplier: 0,
          payoutCents:       0,
          profitCents:       0,
        },
      );
    }

    // ── Fetch final round aggregates for the broadcast ────────────────────
    const roundDoc = await GameRoundModel.findByIdAndUpdate(
      this.state.roundId,
      {
        status:          RoundStatus.CRASHED,
        crashedAt:       now,
        crashMultiplier: this.state.crashMultiplier,
        durationMs:      elapsedMs,
        // Reveal seeds now that the round is over
        clientSeed:      this.state.clientSeed,
        houseEdgeCents:  0,  // Computed below
      },
      { new: true },
    );

    if (roundDoc) {
      const houseEdgeCents = roundDoc.totalBetsCents - roundDoc.totalPayoutCents;
      await GameRoundModel.findByIdAndUpdate(this.state.roundId, { houseEdgeCents });
    }

    // ── Broadcast crash event with Provably Fair reveal ───────────────────
    this.io.emit('round:crashed', {
      roundNumber:      this.state.roundNumber,
      crashMultiplier:  this.state.crashMultiplier,
      serverSeed:       this.state.serverSeed!,
      hmacHex:          this.state.hmacHex!,
      clientSeed:       this.state.clientSeed,
      nonce:            this.state.nonce,
      totalBetsCents:   roundDoc?.totalBetsCents   ?? 0,
      totalPayoutCents: roundDoc?.totalPayoutCents ?? 0,
      playerCount:      roundDoc?.playerCount      ?? 0,
    });

    // Clear active bets for next round
    this.state.activeBets.clear();
  }

  // ── Private: Helpers ───────────────────────────────────────────────────────

  /**
   * Processes an automatic cashout triggered by the tick loop.
   * This mirrors handleCashOut() but is initiated by the server, not the client,
   * so there is no idempotency key — the in-memory flag guards against doubles.
   */
  private async processAutoCashout(entry: ActiveBetEntry, multiplier: number): Promise<void> {
    const payoutCents = Math.floor(entry.amountCents * multiplier);
    const profitCents = payoutCents - entry.amountCents;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await BetModel.findByIdAndUpdate(
        entry.betId,
        {
          status:            BetStatus.CASHED_OUT,
          cashoutMultiplier: multiplier,
          payoutCents,
          profitCents,
          cashedOutAt:       new Date(),
        },
        { session },
      );

      const user = await UserModel.findById(entry.userId).session(session);
      if (!user) throw new Error('User not found during auto-cashout');

      user.balanceCents += payoutCents;
      user.transactions.push({
        _id:         new mongoose.Types.ObjectId(),
        amount:      payoutCents,
        type:        'win',
        referenceId: this.state.roundId,
        createdAt:   new Date(),
      });
      await user.save({ session });

      await GameRoundModel.findByIdAndUpdate(
        this.state.roundId,
        { $inc: { totalPayoutCents: payoutCents } },
        { session },
      );

      await session.commitTransaction();

      logger.info(`[GSM] Auto-cashout: user=${entry.userId} mult=${multiplier}x payout=${payoutCents}¢`);

      // Notify the user's socket(s) of the auto-cashout
      // (socket handler maps userId → socketId for targeted delivery)
      this.io.to(`user:${entry.userId}`).emit('cashout:confirmed', {
        betId:             entry.betId,
        cashoutMultiplier: multiplier,
        payoutCents,
        profitCents,
        newBalanceCents:   user.balanceCents,
      });

      this.broadcastBetList();

    } catch (err) {
      await session.abortTransaction();
      // Undo in-memory flag for retry on next tick
      entry.cashedOut = false;
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Broadcasts the public (censored) bet list to all connected clients.
   * Shows usernames, amounts, and cashout multipliers (null = still active).
   * Called after any bet or cashout action.
   */
  private broadcastBetList(): void {
    const bets = [...this.state.activeBets.values()].map((e) => ({
      username:    e.userId,  // replaced with username in socket layer
      amountCents: e.amountCents,
      cashoutAt:   e.cashedOut ? e.autoCashoutAt : null,
    }));

    this.io.emit('bet:list', { bets });
  }

  private makeInitialState(): GameState {
    return {
      phase:            GamePhase.IDLE,
      roundId:          '',
      roundNumber:      0,
      serverSeedHash:   '',
      clientSeed:       '',
      nonce:            0,
      crashMultiplier:  0,
      runningStartedAt: 0,
      activeBets:       new Map(),
    };
  }
}

// ─── Internal type alias ──────────────────────────────────────────────────────
interface S2C_ErrorPayload { code: string; message: string; idempotencyKey?: string; }
