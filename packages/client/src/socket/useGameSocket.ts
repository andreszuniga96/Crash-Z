/**
 * @file useGameSocket.ts
 * @description React hook that wires the SocketManager to the Zustand store.
 * Handles all socket → store state synchronisation and exposes bet/cashout actions.
 */

import { useEffect, useRef, useCallback } from 'react';
import { SocketManager, generateUUID } from '../socket/SocketManager';
import { useGameStore }                from '../store/gameStore';
import { GamePhase }                   from '../socket/types';
import type { ZombieRunEngine }        from '../game/ZombieRunEngine';

export function useGameSocket(engineRef: React.RefObject<ZombieRunEngine | null>) {
  const socketRef = useRef<SocketManager | null>(null);
  const store     = useGameStore();

  // ── Initialise socket when we have a token ────────────────────────────────
  useEffect(() => {
    if (!store.accessToken) return;

    const manager = new SocketManager({

      onStateChange: (state) => {
        store.setConnected(state.status === 'connected');
        if (state.status === 'reconnecting') {
          store.setReconnecting(true, state.reconnectAttempt);
        }
      },

      onBettingStarted: (data) => {
        store.setRoundData({
          phase:          GamePhase.BETTING,
          roundNumber:    data.roundNumber,
          serverSeedHash: data.serverSeedHash,
          bettingEndsAt:  Date.now() + data.bettingEndsInMs,
          bettingDurationMs: data.bettingEndsInMs,
          currentMultiplier: 1,
          lastCrash:      null,
        });
        store.setBetList([]);
        // Sync recent crashes if provided
        if (data.recentCrashes.length) {
          store.setRoundData({ recentCrashes: data.recentCrashes });
        }
        engineRef.current?.reset();
      },

      onRoundStarted: (data) => {
        store.setRoundData({
          phase:            GamePhase.RUNNING,
          roundNumber:      data.roundNumber,
          serverSeedHash:   data.serverSeedHash,
          runningStartedAt: data.runningStartedAt,
          currentMultiplier: 1,
        });
      },

      onMultiplierTick: (data) => {
        store.pushMultiplier(data.multiplier);
        engineRef.current?.setMultiplier(data.multiplier);
      },

      onRoundCrashed: (data) => {
        store.setRoundData({
          phase:             GamePhase.CRASHED,
          currentMultiplier: data.crashMultiplier,
          lastCrash:         data,
        });
        store.addCrash(data.crashMultiplier);
        store.setActiveBet(null);
        engineRef.current?.triggerCrash();
      },

      onBetAccepted: (data) => {
        store.setActiveBet({
          betId:          data.betId,
          amountCents:    data.amountCents,
          autoCashoutAt:  data.autoCashoutAt,
          idempotencyKey: data.idempotencyKey,
        });
        store.setBalance(data.newBalanceCents);
      },

      onCashoutConfirmed: (data) => {
        store.setActiveBet(null);
        store.setBalance(data.newBalanceCents);
        store.setLastWin({
          multiplier:  data.cashoutMultiplier,
          payoutCents: data.payoutCents,
          profitCents: data.profitCents,
          at:          Date.now(),
        });
      },

      onBetList: (data) => {
        store.setBetList(data.bets);
      },

      onReconnectState: (data) => {
        store.setRoundData({
          phase:            data.phase,
          roundNumber:      data.roundNumber,
          serverSeedHash:   data.serverSeedHash,
          recentCrashes:    data.recentCrashes,
          runningStartedAt: data.runningStartedAt ?? 0,
          currentMultiplier: data.currentMultiplier ?? 1,
          bettingEndsAt:    data.bettingEndsInMs
            ? Date.now() + data.bettingEndsInMs
            : 0,
          bettingDurationMs: data.bettingEndsInMs ?? 0,
        });
        if (data.currentMultiplier) {
          engineRef.current?.setMultiplier(data.currentMultiplier);
        }
      },

      onError: (err) => {
        console.error('[Socket error]', err.code, err.message);
      },
    });

    manager.connect(store.accessToken);
    socketRef.current = manager;

    return () => {
      manager.disconnect();
      socketRef.current = null;
    };
  }, [store.accessToken]); // reconnect when token refreshes

  // ── Actions ────────────────────────────────────────────────────────────────

  const placeBet = useCallback(async () => {
    const manager = socketRef.current;
    if (!manager) return { ok: false, error: { code: 'NO_SOCKET', message: 'Not connected.' } };

    // Generate and persist idempotency key BEFORE sending
    const key = generateUUID();
    store.setPendingBetKey(key);

    const result = await manager.placeBet({
      amountCents:    store.betAmount,
      autoCashoutAt:  store.autoCashout,
      idempotencyKey: key,
    });

    if (!result.ok) {
      // Keep the key — retry will reuse the same UUID
      console.error('[Bet error]', result.error);
    }
    return result;
  }, [store.betAmount, store.autoCashout]);

  const cashOut = useCallback(async () => {
    const manager   = socketRef.current;
    const activeBet = store.activeBet;
    if (!manager || !activeBet) return;

    const cashoutKey = generateUUID();

    const result = await manager.cashOut({
      betId:                 activeBet.betId,
      cashoutIdempotencyKey: cashoutKey,
    });

    if (!result.ok) {
      console.error('[Cashout error]', result.error);
    }
    return result;
  }, [store.activeBet]);

  return { placeBet, cashOut, socket: socketRef };
}
