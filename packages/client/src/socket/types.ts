/**
 * @file types.ts
 * @description Shared game types re-exported for the client.
 *
 * We duplicate the type definitions here instead of importing from the server
 * package to avoid a circular monorepo dependency and keep the client
 * bundle free of server-only code.
 *
 * These types MUST be kept in sync with:
 *   packages/server/src/game/types.ts
 */

// ─── Game Phase Enum ──────────────────────────────────────────────────────────

export enum GamePhase {
  IDLE    = 'IDLE',
  BETTING = 'BETTING',
  RUNNING = 'RUNNING',
  CRASHED = 'CRASHED',
}

// ─── Server → Client Payloads ─────────────────────────────────────────────────

export interface S2C_BettingStarted {
  roundNumber:    number;
  roundId:        string;
  serverSeedHash: string;
  bettingEndsInMs: number;
  recentCrashes:  number[];
}

export interface S2C_RoundStarted {
  roundNumber:     number;
  roundId:         string;
  serverSeedHash:  string;
  runningStartedAt: number;
}

export interface S2C_MultiplierTick {
  multiplier:  number;
  elapsedMs:   number;
}

export interface S2C_RoundCrashed {
  roundNumber:     number;
  crashMultiplier: number;
  serverSeed:      string;
  hmacHex:         string;
  clientSeed:      string;
  nonce:           number;
  totalBetsCents:  number;
  totalPayoutCents: number;
  playerCount:     number;
}

export interface S2C_BetAccepted {
  betId:           string;
  roundNumber:     number;
  amountCents:     number;
  autoCashoutAt:   number;
  idempotencyKey:  string;
  newBalanceCents: number;
}

export interface S2C_CashoutConfirmed {
  betId:              string;
  cashoutMultiplier:  number;
  payoutCents:        number;
  profitCents:        number;
  newBalanceCents:    number;
}

export interface S2C_Error {
  code:    string;
  message: string;
  idempotencyKey?: string;
}

export interface S2C_BetList {
  bets: PublicBetEntry[];
}

export interface PublicBetEntry {
  username:    string;
  amountCents: number;
  cashoutAt:   number | null;
}

export interface ReconnectStatePayload {
  phase:           GamePhase;
  roundNumber:     number;
  serverSeedHash:  string;
  runningStartedAt?: number;
  currentMultiplier?: number;
  bettingEndsInMs?:   number;
  recentCrashes:   number[];
}

// ─── Client → Server Payloads ─────────────────────────────────────────────────

export interface C2S_PlaceBet {
  amountCents:    number;
  autoCashoutAt:  number;
  idempotencyKey: string;
}

export interface C2S_CashOut {
  betId:                 string;
  cashoutIdempotencyKey: string;
}

// ─── Socket.IO Event Maps ─────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'betting:started':   (data: S2C_BettingStarted)   => void;
  'round:started':     (data: S2C_RoundStarted)      => void;
  'multiplier:tick':   (data: S2C_MultiplierTick)    => void;
  'round:crashed':     (data: S2C_RoundCrashed)      => void;
  'bet:accepted':      (data: S2C_BetAccepted)       => void;
  'cashout:confirmed': (data: S2C_CashoutConfirmed)  => void;
  'bet:list':          (data: S2C_BetList)            => void;
  'error':             (data: S2C_Error)              => void;
  'reconnect:state':   (data: ReconnectStatePayload) => void;
}

export interface ClientToServerEvents {
  'bet:place':   (data: C2S_PlaceBet, ack: AckCallback) => void;
  'bet:cashout': (data: C2S_CashOut,  ack: AckCallback) => void;
}

export type AckCallback = (response: { ok: boolean; error?: S2C_Error }) => void;
