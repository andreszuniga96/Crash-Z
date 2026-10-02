/**
 * @file admin.router.ts
 * @description Admin-only REST API. All routes require authentication
 * AND the ADMIN role (enforced via the `authorize(UserRole.ADMIN)` middleware).
 *
 * ─── User Management ────────────────────────────────────────────────────────
 * GET    /api/admin/users                  — List all users (paginated + search)
 * GET    /api/admin/users/:userId          — Single user detail
 * PATCH  /api/admin/users/:userId/status   — Suspend / ban / reactivate
 * PATCH  /api/admin/users/:userId/balance  — Deposit or withdraw virtual funds
 * GET    /api/admin/users/:userId/bets     — Full bet history for a user
 *
 * ─── Financial ──────────────────────────────────────────────────────────────
 * GET    /api/admin/finance/summary        — Platform-wide P&L summary
 *
 * ─── Provably Fair Audit ─────────────────────────────────────────────────────
 * GET    /api/admin/rounds                 — All rounds (paginated, with seeds)
 * GET    /api/admin/rounds/:roundId        — Full round detail including serverSeed
 * POST   /api/admin/rounds/:roundId/verify — Re-verify round outcome
 */

import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';

import { UserModel, UserRole, AccountStatus, IBalanceTransaction } from '../models/User.model';
import { GameRoundModel, RoundStatus } from '../models/GameRound.model';
import { BetModel }                    from '../models/Bet.model';
import { authenticate }                from '../auth/middleware';
import { authorize }                   from '../auth/middleware';
import { validate, balanceAdjustSchema, updateUserStatusSchema } from './validation';
import { verifyRound }                 from '../crypto/provablyFair';
import { formatCOP }                   from '../game/limits';
import { logger }                      from '../logger';

export const adminRouter = Router();

// ── All admin routes require authentication AND admin role ────────────────────
adminRouter.use(authenticate);
adminRouter.use(authorize(UserRole.ADMIN));

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

adminRouter.get('/users', async (req: Request, res: Response): Promise<void> => {
  const limit  = Math.min(parseInt(String(req.query['limit'] ?? '20'),  10), 100);
  const page   = Math.max(1, parseInt(String(req.query['page']  ?? '1'),   10));
  const skip   = (page - 1) * limit;
  const search = String(req.query['search'] ?? '').trim();
  const status = String(req.query['status'] ?? '');
  const role   = String(req.query['role']   ?? '');

  const filter: Record<string, unknown> = {};
  if (search) {
    filter['$or'] = [
      { username: { $regex: search, $options: 'i' } },
      { email:    { $regex: search, $options: 'i' } },
    ];
  }
  if (status && Object.values(AccountStatus).includes(status as AccountStatus)) {
    filter['status'] = status;
  }
  if (role && Object.values(UserRole).includes(role as UserRole)) {
    filter['role'] = role;
  }

  const [users, total] = await Promise.all([
    UserModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('username email role status balanceCents createdAt lastLoginAt ipHistory nonce')
      .lean(),
    UserModel.countDocuments(filter),
  ]);

  res.json({
    data:  users,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  });
});

// ─── GET /api/admin/users/:userId ─────────────────────────────────────────────

adminRouter.get('/users/:userId', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;

  if (!mongoose.isValidObjectId(userId)) {
    res.status(400).json({ error: 'Invalid userId' });
    return;
  }

  const user = await UserModel
    .findById(userId)
    .select('username email role status balanceCents clientSeed nonce transactions createdAt lastLoginAt ipHistory')
    .lean();

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Get bet stats for this user
  const betStats = await BetModel.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id:              null,
        totalBets:        { $sum: 1 },
        totalWageredCents: { $sum: '$amountCents' },
        totalPayoutCents:  { $sum: '$payoutCents' },
        totalProfitCents:  { $sum: '$profitCents' },
        wins:             { $sum: { $cond: [{ $eq: ['$status', 'cashed_out'] }, 1, 0] } },
      },
    },
  ]);

  res.json({
    ...user,
    balanceCOP: (user.balanceCents / 100).toFixed(2),
    betStats:   betStats[0] ?? null,
  });
});

// ─── PATCH /api/admin/users/:userId/status ────────────────────────────────────

adminRouter.patch(
  '/users/:userId/status',
  validate(updateUserStatusSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params;
    const { status } = req.body as { status: AccountStatus };

    if (!mongoose.isValidObjectId(userId)) {
      res.status(400).json({ error: 'Invalid userId' });
      return;
    }

    // Prevent admin from suspending themselves
    if (userId === req.user!.sub) {
      res.status(403).json({ error: 'Admins cannot modify their own account status' });
      return;
    }

    const user = await UserModel.findByIdAndUpdate(
      userId,
      { status },
      { new: true, select: 'username email role status' },
    ).lean();

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    logger.info(`[Admin] Status update: user=${user.username} status=${status} by admin=${req.user!.username}`);
    res.json({ message: `User ${user.username} status updated to ${status}`, user });
  },
);

// ─── PATCH /api/admin/users/:userId/balance ───────────────────────────────────
/**
 * Deposit or withdraw virtual money from a player's account.
 * Simulates a bank transfer for the purposes of this platform.
 *
 * - Deposits: add amountCents to balanceCents, create a 'deposit' transaction
 * - Withdrawals: subtract amountCents (if sufficient), create a 'withdrawal' transaction
 * - All changes are recorded in the embedded transactions array
 *
 * Financial safety: uses a MongoDB transaction to ensure atomicity.
 */
adminRouter.patch(
  '/users/:userId/balance',
  validate(balanceAdjustSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { userId }     = req.params;
    const { amountCents, type, note } = req.body as {
      amountCents: number;
      type:        'deposit' | 'withdrawal';
      note?:       string;
    };

    if (!mongoose.isValidObjectId(userId)) {
      res.status(400).json({ error: 'Invalid userId' });
      return;
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const user = await UserModel.findById(userId).session(session);

      if (!user) {
        await session.abortTransaction();
        res.status(404).json({ error: 'User not found' });
        return;
      }

      if (type === 'withdrawal' && user.balanceCents < amountCents) {
        await session.abortTransaction();
        res.status(422).json({
          error: 'Insufficient balance',
          available: user.balanceCents,
          requested: amountCents,
        });
        return;
      }

      const delta = type === 'deposit' ? amountCents : -amountCents;
      const previousBalance = user.balanceCents;

      user.balanceCents += delta;
      user.transactions.push({
        _id:         new mongoose.Types.ObjectId(),
        amount:      delta,
        type:        type === 'deposit' ? 'deposit' : 'withdrawal',
        referenceId: `admin:${req.user!.sub}`,
        note:        note ?? `Admin ${type} by ${req.user!.username}`,
        createdAt:   new Date(),
      } as IBalanceTransaction);

      await user.save({ session });
      await session.commitTransaction();

      logger.info(
        `[Admin] Balance ${type}: user=${user.username} ` +
        `amount=${amountCents}¢ prev=${previousBalance}¢ new=${user.balanceCents}¢ ` +
        `by admin=${req.user!.username}`,
      );

      res.json({
        message:         `${type} of ${formatCOP(amountCents)} processed successfully`,
        previousBalance: previousBalance,
        newBalance:      user.balanceCents,
        newBalanceCOP:   formatCOP(user.balanceCents),
        transaction: {
          amount:    delta,
          type,
          note,
          createdAt: new Date(),
        },
      });

    } catch (err) {
      await session.abortTransaction();
      logger.error('[Admin] Balance adjustment failed', { error: (err as Error).message });
      res.status(500).json({ error: 'Balance adjustment failed. Please try again.' });
    } finally {
      await session.endSession();
    }
  },
);

// ─── GET /api/admin/users/:userId/bets ────────────────────────────────────────

adminRouter.get('/users/:userId/bets', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10), 100);
  const page  = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const skip  = (page - 1) * limit;

  if (!mongoose.isValidObjectId(userId)) {
    res.status(400).json({ error: 'Invalid userId' });
    return;
  }

  const [bets, total] = await Promise.all([
    BetModel
      .find({ userId })
      .sort({ placedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    BetModel.countDocuments({ userId }),
  ]);

  res.json({ data: bets, total, page, limit, pages: Math.ceil(total / limit) });
});

// ─── GET /api/admin/finance/summary ──────────────────────────────────────────

adminRouter.get('/finance/summary', async (_req: Request, res: Response): Promise<void> => {
  const [playerStats, roundStats, recentActivity] = await Promise.all([
    // Platform-wide player metrics
    UserModel.aggregate([
      {
        $group: {
          _id:               null,
          totalPlayers:      { $sum: 1 },
          activePlayers:     { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          totalBalanceCents: { $sum: '$balanceCents' },
        },
      },
    ]),

    // Round financial metrics
    GameRoundModel.aggregate([
      { $match: { status: RoundStatus.CRASHED } },
      {
        $group: {
          _id:                  null,
          totalRounds:          { $sum: 1 },
          totalWageredCents:    { $sum: '$totalBetsCents' },
          totalPayoutCents:     { $sum: '$totalPayoutCents' },
          totalHouseEdgeCents:  { $sum: '$houseEdgeCents' },
          avgCrashMultiplier:   { $avg: '$crashMultiplier' },
          avgPlayerCount:       { $avg: '$playerCount' },
        },
      },
    ]),

    // Last 7 days daily breakdown
    GameRoundModel.aggregate([
      {
        $match: {
          status:    RoundStatus.CRASHED,
          crashedAt: { $gte: new Date(Date.now() - 7 * 24 * 3600_000) },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$crashedAt' },
          },
          rounds:           { $sum: 1 },
          wageredCents:     { $sum: '$totalBetsCents' },
          payoutCents:      { $sum: '$totalPayoutCents' },
          houseEdgeCents:   { $sum: '$houseEdgeCents' },
        },
      },
      { $sort: { _id: -1 } },
    ]),
  ]);

  const ps = playerStats[0]  ?? {};
  const rs = roundStats[0]   ?? {};

  res.json({
    players: {
      total:            ps.totalPlayers      ?? 0,
      active:           ps.activePlayers     ?? 0,
      totalBalanceCents: ps.totalBalanceCents ?? 0,
    },
    financial: {
      totalRounds:         rs.totalRounds         ?? 0,
      totalWageredCents:   rs.totalWageredCents    ?? 0,
      totalPayoutCents:    rs.totalPayoutCents      ?? 0,
      totalHouseEdgeCents: rs.totalHouseEdgeCents   ?? 0,
      houseEdgeRatePercent: rs.totalWageredCents
        ? ((rs.totalHouseEdgeCents / rs.totalWageredCents) * 100).toFixed(2)
        : '0.00',
      avgCrashMultiplier: (rs.avgCrashMultiplier ?? 0).toFixed(2),
      avgPlayerCount:     (rs.avgPlayerCount     ?? 0).toFixed(1),
    },
    dailyBreakdown: recentActivity,
  });
});

// ─── GET /api/admin/rounds ────────────────────────────────────────────────────

adminRouter.get('/rounds', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10), 100);
  const page  = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const skip  = (page - 1) * limit;

  const [rounds, total] = await Promise.all([
    GameRoundModel
      .find({})
      // Include secret fields for admin view
      .select('+serverSeed +hmacHex')
      .sort({ roundNumber: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    GameRoundModel.countDocuments({}),
  ]);

  // Mask serverSeed for non-crashed rounds (still in progress)
  const sanitised = rounds.map((r) => ({
    ...r,
    serverSeed: r.status === RoundStatus.CRASHED ? r.serverSeed : '[pending reveal]',
    hmacHex:    r.status === RoundStatus.CRASHED ? r.hmacHex    : '[pending reveal]',
  }));

  res.json({ data: sanitised, total, page, limit, pages: Math.ceil(total / limit) });
});

// ─── GET /api/admin/rounds/:roundId ──────────────────────────────────────────

adminRouter.get('/rounds/:roundId', async (req: Request, res: Response): Promise<void> => {
  const { roundId } = req.params;

  if (!mongoose.isValidObjectId(roundId)) {
    res.status(400).json({ error: 'Invalid roundId' });
    return;
  }

  const [round, bets] = await Promise.all([
    GameRoundModel
      .findById(roundId)
      .select('+serverSeed +hmacHex')
      .lean(),
    BetModel
      .find({ roundId })
      .populate('userId', 'username')
      .sort({ amountCents: -1 })
      .lean(),
  ]);

  if (!round) {
    res.status(404).json({ error: 'Round not found' });
    return;
  }

  res.json({ round, bets });
});

// ─── POST /api/admin/rounds/:roundId/verify ───────────────────────────────────
/**
 * Admin-initiated Provably Fair verification.
 * Re-derives the crash multiplier from the stored seeds and compares
 * it against what was recorded in the DB.
 */
adminRouter.post('/rounds/:roundId/verify', async (req: Request, res: Response): Promise<void> => {
  const { roundId } = req.params;

  if (!mongoose.isValidObjectId(roundId)) {
    res.status(400).json({ error: 'Invalid roundId' });
    return;
  }

  const round = await GameRoundModel
    .findById(roundId)
    .select('+serverSeed +hmacHex')
    .lean();

  if (!round) {
    res.status(404).json({ error: 'Round not found' });
    return;
  }

  if (round.status !== RoundStatus.CRASHED) {
    res.status(422).json({ error: 'Round has not ended yet — seeds are still hidden' });
    return;
  }

  const result = verifyRound({
    serverSeed:         round.serverSeed!,
    clientSeed:         round.clientSeed,
    nonce:              round.nonce,
    expectedHmac:       round.hmacHex!,
    expectedMultiplier: round.crashMultiplier,
  });

  logger.info(
    `[Admin] PF verify: round=#${round.roundNumber} valid=${result.valid} ` +
    `by admin=${req.user!.username}`,
  );

  res.json({
    roundNumber:        round.roundNumber,
    valid:              result.valid,
    storedMultiplier:   round.crashMultiplier,
    computedMultiplier: result.computedMultiplier,
    computedHmac:       result.computedHmac,
    extractedBits:      result.extractedBits,
    details:            result.details,
    seeds: {
      serverSeed:     round.serverSeed,
      serverSeedHash: round.serverSeedHash,
      clientSeed:     round.clientSeed,
      nonce:          round.nonce,
    },
  });
});
