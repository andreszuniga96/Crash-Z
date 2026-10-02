/**
 * @file store/gameStore.ts
 * @description Zustand store — single source of truth for the client game state.
 * The socket manager writes here; React components read from here.
 */

import { create } from 'zustand';
import { GamePhase, PublicBetEntry, S2C_RoundCrashed } from '../socket/types';
import { DEFAULT_BET_CENTS } from '../lib/currency';

export interface ActiveBet {
  betId:          string;
  amountCents:    number;
  autoCashoutAt:  number;
  idempotencyKey: string;
}

export interface LastWin {
  multiplier:  number;
  payoutCents: number;
  profitCents: number;
  at:          number; // timestamp ms
}

export interface GameStore {
  // ── Connection ─────────────────────────────────────────────────────────────
  isConnected:      boolean;
  isReconnecting:   boolean;
  reconnectAttempt: number;
  setConnected:     (v: boolean) => void;
  setReconnecting:  (v: boolean, attempt?: number) => void;

  // ── Auth ───────────────────────────────────────────────────────────────────
  accessToken:      string;
  userId:           string;
  username:         string;
  balanceCents:     number;
  setAuth:          (token: string, userId: string, username: string) => void;
  setBalance:       (cents: number) => void;

  // ── Game Phase ─────────────────────────────────────────────────────────────
  phase:            GamePhase;
  roundNumber:      number;
  serverSeedHash:   string;
  bettingEndsAt:    number;   // Unix ms
  /**
   * Length of the current betting window in ms, as announced by the server.
   * The HUD derives its progress ring/bar from this instead of a hard-coded
   * constant, so changing BETTING_PHASE_MS on the server needs no client edit.
   */
  bettingDurationMs: number;
  runningStartedAt: number;   // Unix ms
  currentMultiplier: number;
  recentCrashes:    number[];
  lastCrash:        S2C_RoundCrashed | null;
  setPhase:         (p: GamePhase) => void;
  setRoundData:     (data: Partial<GameStore>) => void;
  pushMultiplier:   (m: number) => void;
  addCrash:         (multiplier: number) => void;

  // ── Betting ────────────────────────────────────────────────────────────────
  activeBet:        ActiveBet | null;
  betList:          PublicBetEntry[];
  pendingBetKey:    string;   // UUID kept in store for retry
  setActiveBet:     (bet: ActiveBet | null) => void;
  setBetList:       (bets: PublicBetEntry[]) => void;
  setPendingBetKey: (key: string) => void;

  // ── UI ─────────────────────────────────────────────────────────────────────
  betAmount:        number;
  autoCashout:      number;
  setBetAmount:     (v: number) => void;
  setAutoCashout:   (v: number) => void;

  // ── Win Celebration ────────────────────────────────────────────────────────
  lastWin:          LastWin | null;
  setLastWin:       (win: LastWin | null) => void;

  // ── Performance ────────────────────────────────────────────────────────────
  fps:              number;
  pixelRatio:       number;
  setPerf:          (fps: number, pixelRatio: number) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  // Connection
  isConnected:      false,
  isReconnecting:   false,
  reconnectAttempt: 0,
  setConnected:     (v) => set({ isConnected: v, isReconnecting: false }),
  setReconnecting:  (v, attempt = 0) => set({ isReconnecting: v, reconnectAttempt: attempt }),

  // Auth
  accessToken:  '',
  userId:       '',
  username:     '',
  balanceCents: 0,
  setAuth:      (token, userId, username) => set({ accessToken: token, userId, username }),
  setBalance:   (cents) => set({ balanceCents: cents }),

  // Game Phase
  phase:            GamePhase.IDLE,
  roundNumber:      0,
  serverSeedHash:   '',
  bettingEndsAt:    0,
  // Mirrors the server default; overwritten by the real value on every
  // betting:started / reconnect:state payload.
  bettingDurationMs: 7000,
  runningStartedAt: 0,
  currentMultiplier: 1,
  recentCrashes:    [],
  lastCrash:        null,
  setPhase:         (p) => set({ phase: p }),
  setRoundData:     (data) => set(data as Partial<GameStore>),
  pushMultiplier:   (m) => set({ currentMultiplier: m }),
  addCrash:         (m) => set((s) => ({
    recentCrashes: [m, ...s.recentCrashes].slice(0, 20),
  })),

  // Betting
  activeBet:        null,
  betList:          [],
  pendingBetKey:    '',
  setActiveBet:     (bet) => set({ activeBet: bet }),
  setBetList:       (bets) => set({ betList: bets }),
  setPendingBetKey: (key) => set({ pendingBetKey: key }),

  // UI
  // Defaults to the table minimum, never an arbitrary amount that the server
  // might reject (it used to be 500 centavos, i.e. below the COP minimum).
  betAmount:    DEFAULT_BET_CENTS,
  autoCashout:  0,
  setBetAmount: (v) => set({ betAmount: v }),
  setAutoCashout: (v) => set({ autoCashout: v }),

  // Win Celebration
  lastWin:    null,
  setLastWin: (win) => set({ lastWin: win }),

  // Performance
  fps:          60,
  pixelRatio:   1,
  setPerf:      (fps, pixelRatio) => set({ fps, pixelRatio }),
}));
