/**
 * @file gameHandler.ts
 * @description Socket.IO event handler wiring.
 *
 * Responsibilities:
 *  - Authenticates each connecting socket via JWT
 *  - Joins the socket to a personal room (`user:{userId}`) for targeted delivery
 *  - Sends `reconnect:state` immediately after auth so clients can restore UI
 *  - Delegates game commands (bet:place, bet:cashout) to GameStateMachine
 *  - Manages a userId → Set<socketId> map for multi-tab / multi-device support
 *
 * NOTE: Socket.IO rooms named `user:{userId}` allow auto-cashout notifications
 * (emitted from the game loop) to reach the correct player even when the
 * original socketId is no longer available.
 */

import { Socket } from 'socket.io';
import {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  GamePhase,
  ReconnectStatePayload,
} from '../game/types';
import { GameStateMachine } from '../game/GameStateMachine';
import { verifyAccessToken } from '../auth/jwt';
import { elapsedMsToMultiplier } from '../crypto/provablyFair';
import { GameRoundModel, RoundStatus } from '../models/GameRound.model';
import { logger } from '../logger';

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

// Track active sockets per user for multi-tab awareness
const userSockets = new Map<string, Set<string>>();

/**
 * Registers all event listeners for a newly connected game socket.
 * Called once per connection from the Socket.IO server in socketio.ts.
 */
export function registerGameHandlers(
  socket:  GameSocket,
  machine: GameStateMachine,
): void {

  // ── Authentication ─────────────────────────────────────────────────────────
  // We authenticate in the handshake middleware (socketio.ts) before this runs.
  // By the time this function is called, socket.data is guaranteed to be set.
  const { userId, username, role } = socket.data;

  // Track this socket
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId)!.add(socket.id);

  // Join personal room for targeted emissions (auto-cashout, etc.)
  socket.join(`user:${userId}`);

  logger.info(`[Socket] Connected: user=${username} socket=${socket.id} role=${role}`);

  // ── Reconnect State ────────────────────────────────────────────────────────
  // Immediately send current game state so the client can restore its UI
  // without waiting for the next phase transition event.
  sendReconnectState(socket, machine).catch((err) =>
    logger.error('[Socket] Failed to send reconnect state', { error: err.message }),
  );

  // ── bet:place ──────────────────────────────────────────────────────────────
  socket.on('bet:place', (data, ack) => {
    if (typeof ack !== 'function') {
      logger.warn(`[Socket] bet:place received without ack callback from ${socket.id}`);
      return;
    }
    machine.handlePlaceBet(userId, username, data, ack, socket.id).catch((err) => {
      logger.error('[Socket] handlePlaceBet threw', { error: err.message });
      ack({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Server error.' } });
    });
  });

  // ── bet:cashout ────────────────────────────────────────────────────────────
  socket.on('bet:cashout', (data, ack) => {
    if (typeof ack !== 'function') {
      logger.warn(`[Socket] bet:cashout received without ack callback from ${socket.id}`);
      return;
    }
    machine.handleCashOut(userId, data, ack, socket.id).catch((err) => {
      logger.error('[Socket] handleCashOut threw', { error: err.message });
      ack({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Server error.' } });
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    logger.info(`[Socket] Disconnected: user=${username} socket=${socket.id} reason=${reason}`);
    const set = userSockets.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) userSockets.delete(userId);
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds and emits the `reconnect:state` payload for a newly connected socket.
 * This lets the client skip waiting for the next phase-transition event and
 * immediately render the correct UI (betting panel, running multiplier, etc.).
 */
async function sendReconnectState(
  socket:  GameSocket,
  machine: GameStateMachine,
): Promise<void> {
  const state         = machine.getState();
  const recentCrashes = await getRecentCrashes(20);

  const payload: ReconnectStatePayload = {
    phase:          state.phase,
    roundNumber:    state.roundNumber,
    serverSeedHash: state.serverSeedHash,
    recentCrashes,
  };

  if (state.phase === GamePhase.BETTING) {
    // How many ms are left in the betting window?
    // The machine doesn't expose bettingStartedAt directly, so we query the DB.
    const round = await GameRoundModel
      .findById(state.roundId)
      .select('bettingStartAt')
      .lean();

    if (round?.bettingStartAt) {
      const bettingDurationMs = parseInt(process.env['BETTING_PHASE_MS'] ?? '7000', 10);
      const elapsed           = Date.now() - round.bettingStartAt.getTime();
      payload.bettingEndsInMs = Math.max(0, bettingDurationMs - elapsed);
    }
  }

  if (state.phase === GamePhase.RUNNING) {
    payload.runningStartedAt   = state.runningStartedAt;
    payload.currentMultiplier  = elapsedMsToMultiplier(Date.now() - state.runningStartedAt);
  }

  socket.emit('reconnect:state', payload);
}

async function getRecentCrashes(limit: number): Promise<number[]> {
  const rounds = await GameRoundModel
    .find({ status: RoundStatus.CRASHED })
    .sort({ crashedAt: -1 })
    .limit(limit)
    .select('crashMultiplier')
    .lean();
  return rounds.map((r) => r.crashMultiplier);
}
