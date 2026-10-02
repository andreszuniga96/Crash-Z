/**
 * @file game.router.ts
 * @description Public and player-facing game API endpoints.
 *
 * GET  /api/game/history              — Recent crash history (public)
 * GET  /api/game/rounds/:roundId      — Single round details (public)
 * POST /api/game/verify               — Provably Fair self-verification (public)
 * GET  /api/game/my-bets              — Authenticated player's bet history
 * GET  /api/game/leaderboard          — Top winners (public)
 * POST /api/game/withdraw-request     — Player requests a withdrawal (daily limit enforced)
 * GET  /api/game/daily-limits         — Player's used limits for today
 */

import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';

import { GameRoundModel, RoundStatus }  from '../models/GameRound.model';
import { BetModel, BetStatus }          from '../models/Bet.model';
import { UserModel }                    from '../models/User.model';
import { authenticate }                 from '../auth/middleware';
import { verifyRound }                  from '../crypto/provablyFair';
import {
  MAX_DAILY_DEPOSIT_CENTS,
  MAX_DAILY_WITHDRAWAL_CENTS,
  formatCOP,
}                                       from '../game/limits';
import { logger }                       from '../logger';

export const gameRouter = Router();


// ─── GET /api/game/history ────────────────────────────────────────────────────

gameRouter.get('/history', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10), 200);
  const page  = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const skip  = (page - 1) * limit;

  const [rounds, total] = await Promise.all([
    GameRoundModel
      .find({ status: RoundStatus.CRASHED })
      .sort({ crashedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('roundNumber crashMultiplier serverSeedHash clientSeed nonce durationMs totalBetsCents totalPayoutCents playerCount crashedAt')
      .lean(),
    GameRoundModel.countDocuments({ status: RoundStatus.CRASHED }),
  ]);

  res.json({
    data:  rounds,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  });
});

// ─── GET /api/game/rounds/:roundId ────────────────────────────────────────────

gameRouter.get('/rounds/:roundId', async (req: Request, res: Response): Promise<void> => {
  const { roundId } = req.params;

  const round = await GameRoundModel
    .findById(roundId)
    // serverSeed is select:false — only include it for crashed rounds (already revealed)
    .select('+serverSeed +hmacHex')
    .lean();

  if (!round) {
    res.status(404).json({ error: 'Round not found' });
    return;
  }

  // Only expose the secret seed if the round has ended (Provably Fair reveal)
  const response = {
    ...round,
    serverSeed: round.status === RoundStatus.CRASHED ? round.serverSeed : '[hidden until round ends]',
    hmacHex:    round.status === RoundStatus.CRASHED ? round.hmacHex    : '[hidden until round ends]',
  };

  res.json(response);
});

// ─── POST /api/game/verify ────────────────────────────────────────────────────
// Provably Fair self-verification tool (usable by any player, no auth required)

gameRouter.post('/verify', async (req: Request, res: Response): Promise<void> => {
  const { serverSeed, clientSeed, nonce, expectedMultiplier } = req.body as {
    serverSeed?:        string;
    clientSeed?:        string;
    nonce?:             number;
    expectedMultiplier?: number;
  };

  if (
    typeof serverSeed        !== 'string' || serverSeed.length        !== 64 ||
    typeof clientSeed        !== 'string' || clientSeed.length         < 1  ||
    typeof nonce             !== 'number' ||
    typeof expectedMultiplier !== 'number'
  ) {
    res.status(400).json({
      error: 'Required: serverSeed (64 hex chars), clientSeed, nonce (number), expectedMultiplier (number)',
    });
    return;
  }

  // Verify SHA-256 format for server seed
  if (!/^[0-9a-f]{64}$/.test(serverSeed)) {
    res.status(400).json({ error: 'serverSeed must be 64 lowercase hex characters' });
    return;
  }

  // Recompute the HMAC from the round data
  // We need the hmacHex from the DB round to pass as expectedHmac
  const round = await GameRoundModel
    .findOne({ nonce, status: RoundStatus.CRASHED })
    .select('+hmacHex')
    .lean();

  const result = verifyRound({
    serverSeed,
    clientSeed,
    nonce,
    expectedHmac:       round?.hmacHex ?? '',
    expectedMultiplier,
  });

  res.json({
    valid:              result.valid,
    computedMultiplier: result.computedMultiplier,
    computedHmac:       result.computedHmac,
    extractedBits:      result.extractedBits,
    details:            result.details,
  });
});

// ─── GET /api/game/my-bets ────────────────────────────────────────────────────

gameRouter.get('/my-bets', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.sub;
  const limit  = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10), 100);
  const page   = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const skip   = (page - 1) * limit;

  const [bets, total] = await Promise.all([
    BetModel
      .find({ userId })
      .sort({ placedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('roundNumber amountCents autoCashoutAt status cashoutMultiplier payoutCents profitCents placedAt cashedOutAt')
      .lean(),
    BetModel.countDocuments({ userId }),
  ]);

  // Aggregate stats
  const stats = await BetModel.aggregate([
    { $match: { userId: new (require('mongoose').Types.ObjectId)(userId) } },
    {
      $group: {
        _id:              null,
        totalBetsCents:   { $sum: '$amountCents' },
        totalPayoutCents: { $sum: '$payoutCents' },
        totalBets:        { $sum: 1 },
        wins:             { $sum: { $cond: [{ $eq: ['$status', BetStatus.CASHED_OUT] }, 1, 0] } },
        biggestWinCents:  { $max: '$profitCents' },
        biggestMultiplier: { $max: '$cashoutMultiplier' },
      },
    },
  ]);

  res.json({
    data:  bets,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    stats: stats[0] ?? {
      totalBetsCents:   0,
      totalPayoutCents: 0,
      totalBets:        0,
      wins:             0,
      biggestWinCents:  0,
      biggestMultiplier: 0,
    },
  });
});

// ─── GET /api/game/leaderboard ────────────────────────────────────────────────

gameRouter.get('/leaderboard', async (req: Request, res: Response): Promise<void> => {
  const period = String(req.query['period'] ?? 'all'); // 'all' | 'week' | 'day'

  const matchStage: Record<string, unknown> = { status: BetStatus.CASHED_OUT };
  if (period === 'week') {
    matchStage['placedAt'] = { $gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) };
  } else if (period === 'day') {
    matchStage['placedAt'] = { $gte: new Date(Date.now() - 24 * 3600 * 1000) };
  }

  const top = await BetModel.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:              '$userId',
        totalProfitCents: { $sum: '$profitCents' },
        biggestMultiplier: { $max: '$cashoutMultiplier' },
        totalBets:         { $sum: 1 },
      },
    },
    { $sort: { totalProfitCents: -1 } },
    { $limit: 50 },
    {
      $lookup: {
        from:         'users',
        localField:   '_id',
        foreignField: '_id',
        as:           'user',
      },
    },
    { $unwind: '$user' },
    {
      $project: {
        username:         '$user.username',
        totalProfitCents: 1,
        biggestMultiplier: 1,
        totalBets:        1,
      },
    },
  ]);

  res.json({ period, data: top });
});

// ─── GET /api/game/daily-limits ───────────────────────────────────────────────
/**
 * Returns how much the authenticated player has deposited and withdrawn today,
 * so the client can display remaining headroom.
 */
gameRouter.get('/daily-limits', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId    = req.user!.sub;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const user = await UserModel
    .findById(userId)
    .select('transactions balanceCents')
    .lean();

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const todayTx = user.transactions.filter(
    (t) => new Date(t.createdAt) >= todayStart,
  );

  const depositedToday    = todayTx.filter((t) => t.type === 'deposit'    && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const withdrawnToday    = todayTx.filter((t) => t.type === 'withdrawal' && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);

  res.json({
    deposited:   { usedCents: depositedToday,    maxCents: MAX_DAILY_DEPOSIT_CENTS,    remainingCents: Math.max(0, MAX_DAILY_DEPOSIT_CENTS    - depositedToday) },
    withdrawn:   { usedCents: withdrawnToday,    maxCents: MAX_DAILY_WITHDRAWAL_CENTS, remainingCents: Math.max(0, MAX_DAILY_WITHDRAWAL_CENTS - withdrawnToday) },
    balanceCents: user.balanceCents,
  });
});

// ─── POST /api/game/withdraw-request ─────────────────────────────────────────
/**
 * Player requests a withdrawal of their winnings.
 *
 * Rules:
 *  · Max $50,000 COP per calendar day across all withdrawals
 *  · Cannot withdraw more than current balance
 *  · Payment method must be one of: nequi | daviplata | llave
 *
 * The actual payout is manual (admin confirms on their side), so this endpoint
 * deducts the amount from the balance immediately and records a pending
 * withdrawal transaction.
 */
gameRouter.post('/withdraw-request', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.sub;
  const { amountCents, method, accountNumber } = req.body as {
    amountCents?:   number;
    method?:        string;
    accountNumber?: string;
  };

  // ── Basic validation ───────────────────────────────────────────────────────
  if (!Number.isInteger(amountCents) || amountCents! <= 0) {
    res.status(400).json({ error: 'amountCents debe ser un entero positivo' });
    return;
  }
  const VALID_METHODS = ['nequi', 'daviplata', 'llave'];
  if (!method || !VALID_METHODS.includes(method)) {
    res.status(400).json({ error: `Método inválido. Opciones: ${VALID_METHODS.join(', ')}` });
    return;
  }
  if (!accountNumber || typeof accountNumber !== 'string' || accountNumber.length < 7) {
    res.status(400).json({ error: 'Número de cuenta inválido' });
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await UserModel.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    // ── Insufficient balance ───────────────────────────────────────────────
    if (user.balanceCents < amountCents!) {
      await session.abortTransaction();
      res.status(422).json({ error: 'Saldo insuficiente', available: user.balanceCents });
      return;
    }

    // ── Daily limit check ──────────────────────────────────────────────────
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const withdrawnToday = user.transactions
      .filter((t) => t.type === 'withdrawal' && new Date(t.createdAt) >= todayStart)
      .reduce((s, t) => s + Math.abs(t.amount), 0);

    if (withdrawnToday + amountCents! > MAX_DAILY_WITHDRAWAL_CENTS) {
      await session.abortTransaction();
      const remaining = Math.max(0, MAX_DAILY_WITHDRAWAL_CENTS - withdrawnToday);
      res.status(422).json({
        error:   `Límite diario de retiro alcanzado. Disponible hoy: ${formatCOP(remaining)}`,
        maxDailyCents:   MAX_DAILY_WITHDRAWAL_CENTS,
        usedTodayCents:  withdrawnToday,
        remainingCents:  remaining,
      });
      return;
    }

    // ── Debit balance ──────────────────────────────────────────────────────
    const previousBalance = user.balanceCents;
    user.balanceCents -= amountCents!;
    user.transactions.push({
      _id:         new mongoose.Types.ObjectId(),
      amount:      -amountCents!,
      type:        'withdrawal',
      note:        `Retiro ${method} → ${accountNumber} (pendiente pago)`,
      createdAt:   new Date(),
    } as typeof user.transactions[0]);

    await user.save({ session });
    await session.commitTransaction();

    logger.info(
      `[Withdrawal] user=${user.username} amount=${amountCents}¢ method=${method} ` +
      `prev=${previousBalance}¢ new=${user.balanceCents}¢`,
    );

    res.json({
      message:         `Solicitud de retiro de ${formatCOP(amountCents!)} recibida`,
      newBalanceCents: user.balanceCents,
      method,
      accountNumber,
      estimatedTime:   '15–30 minutos',
    });

  } catch (err) {
    await session.abortTransaction();
    logger.error('[Withdrawal] Failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Error al procesar el retiro. Intenta de nuevo.' });
  } finally {
    await session.endSession();
  }
});
