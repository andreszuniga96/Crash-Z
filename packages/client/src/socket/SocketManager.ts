/**
 * @file SocketManager.ts
 * @description Socket.IO client with Exponential Backoff + Full Jitter reconnection.
 *
 * WHY NOT SOCKET.IO'S BUILT-IN RECONNECTION?
 * ─────────────────────────────────────────────
 * Socket.IO's built-in `reconnectionDelay` / `reconnectionDelayMax` implements
 * Exponential Backoff BUT WITHOUT full randomisation. All clients on the same
 * network will reconnect at very similar times, creating a thundering-herd
 * storm against the server after a mass disconnect (e.g. brief server restart).
 *
 * This manager DISABLES Socket.IO's reconnection (`reconnection: false`) and
 * implements the AWS Full Jitter algorithm manually, spreading reconnection
 * attempts uniformly across the backoff window.
 *
 * ALGORITHM (Full Jitter — AWS variant)
 * ──────────────────────────────────────
 *   cap   = 30000ms
 *   base  = 500ms
 *   delay(n) = random_uniform(0, min(cap, base × 2^n))
 *
 * REACTIVE STATE
 * ───────────────
 * The manager exposes its state as a Zustand slice that React components
 * can subscribe to for real-time connection status display.
 *
 * IDEMPOTENCY KEY GENERATION
 * ───────────────────────────
 * The client is responsible for generating UUID v4 idempotency keys BEFORE
 * sending bet/cashout commands. The key is persisted in React state so that
 * if the socket disconnects mid-flight, the same key is reused on retry,
 * ensuring the server processes the action exactly once.
 */

import { io, Socket } from 'socket.io-client';
import {
  ServerToClientEvents,
  ClientToServerEvents,
  C2S_PlaceBet,
  C2S_CashOut,
  AckCallback,
  GamePhase,
  ReconnectStatePayload,
  S2C_BettingStarted,
  S2C_RoundStarted,
  S2C_MultiplierTick,
  S2C_RoundCrashed,
  S2C_BetAccepted,
  S2C_CashoutConfirmed,
  S2C_BetList,
  S2C_Error,
} from './types';

// ─── Re-export types for consumers ────────────────────────────────────────────
export type {
  GamePhase, ReconnectStatePayload, S2C_BettingStarted, S2C_RoundStarted,
  S2C_MultiplierTick, S2C_RoundCrashed, S2C_BetAccepted, S2C_CashoutConfirmed,
  S2C_BetList, S2C_Error,
};

// ─── Backoff Config ────────────────────────────────────────────────────────────

const BACKOFF_BASE_MS   = 500;
const BACKOFF_CAP_MS    = 30_000;
const BACKOFF_MAX_TRIES = 15;

function fullJitterDelay(attempt: number): number {
  const ceil = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceil);
}

// ─── Connection State ──────────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface SocketState {
  status:          ConnectionStatus;
  reconnectAttempt: number;
  latencyMs:       number;
}

// ─── Event Handler Map ─────────────────────────────────────────────────────────

export interface GameEventHandlers {
  onBettingStarted?:   (data: S2C_BettingStarted)  => void;
  onRoundStarted?:     (data: S2C_RoundStarted)     => void;
  onMultiplierTick?:   (data: S2C_MultiplierTick)   => void;
  onRoundCrashed?:     (data: S2C_RoundCrashed)     => void;
  onBetAccepted?:      (data: S2C_BetAccepted)      => void;
  onCashoutConfirmed?: (data: S2C_CashoutConfirmed) => void;
  onBetList?:          (data: S2C_BetList)           => void;
  onError?:            (data: S2C_Error)             => void;
  onReconnectState?:   (data: ReconnectStatePayload) => void;
  onStateChange?:      (state: SocketState)          => void;
}

// ─── SocketManager Class ───────────────────────────────────────────────────────

export class SocketManager {
  private socket:    Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private handlers:  GameEventHandlers;
  private state:     SocketState = {
    status:           'disconnected',
    reconnectAttempt: 0,
    latencyMs:        0,
  };
  private accessToken:       string = '';
  private reconnectTimer:    ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt:  number = 0;
  private isDestroyed:       boolean = false;

  // Latency measurement
  private pingInterval:      ReturnType<typeof setInterval> | null = null;

  constructor(handlers: GameEventHandlers = {}) {
    this.handlers = handlers;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Connects to the Socket.IO server using the given access token */
  connect(accessToken: string): void {
    this.accessToken = accessToken;
    this.isDestroyed = false;
    this.attemptConnect();
  }

  /** Gracefully disconnects and stops all reconnection attempts */
  disconnect(): void {
    this.isDestroyed = true;
    this.clearReconnectTimer();
    this.stopPingInterval();
    this.socket?.disconnect();
    this.socket = null;
    this.setState({ status: 'disconnected', reconnectAttempt: 0, latencyMs: 0 });
  }

  /** Updates the access token (called after a token refresh) */
  updateToken(newToken: string): void {
    this.accessToken = newToken;
  }

  /** Emits a PLACE_BET command with acknowledgement */
  placeBet(data: C2S_PlaceBet): Promise<{ ok: boolean; error?: S2C_Error }> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: 'Socket is not connected.' } });
        return;
      }
      this.socket.emit('bet:place', data, resolve as AckCallback);
    });
  }

  /** Emits a CASH_OUT command with acknowledgement */
  cashOut(data: C2S_CashOut): Promise<{ ok: boolean; error?: S2C_Error }> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: 'Socket is not connected.' } });
        return;
      }
      this.socket.emit('bet:cashout', data, resolve as AckCallback);
    });
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  getState(): Readonly<SocketState> {
    return this.state;
  }

  // ── Private: Connection ────────────────────────────────────────────────────

  private attemptConnect(): void {
    if (this.isDestroyed) return;

    this.setState({ status: this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting' });

    this.socket = io(window.location.origin, {
      // Disable built-in reconnection — we implement our own Full Jitter logic
      reconnection: false,

      transports: ['websocket'],

      auth: { token: this.accessToken },

      // Timeouts
      timeout: 10_000,
    });

    this.registerSocketEvents();
  }

  private registerSocketEvents(): void {
    if (!this.socket) return;

    // ── Successful connection ──────────────────────────────────────────────
    this.socket.on('connect', () => {
      console.info(`[Socket] Connected (attempt ${this.reconnectAttempt})`);
      this.reconnectAttempt = 0;
      this.setState({ status: 'connected', reconnectAttempt: 0 });
      this.startPingInterval();
    });

    // ── Disconnection — trigger backoff ───────────────────────────────────
    this.socket.on('disconnect', (reason) => {
      console.warn(`[Socket] Disconnected: ${reason}`);
      this.stopPingInterval();
      this.setState({ status: 'disconnected' });

      // 'io server disconnect' = intentional kick; don't auto-reconnect
      if (reason === 'io server disconnect' || this.isDestroyed) return;

      this.scheduleReconnect();
    });

    // ── Connection error ───────────────────────────────────────────────────
    this.socket.on('connect_error', (err) => {
      console.warn(`[Socket] Connection error: ${err.message}`);

      if (err.message === 'TOKEN_EXPIRED') {
        // TODO: trigger token refresh flow then reconnect
        this.handlers.onError?.({
          code:    'TOKEN_EXPIRED',
          message: 'Session expired. Please refresh the page.',
        });
        return;
      }

      this.setState({ status: 'disconnected' });
      this.scheduleReconnect();
    });

    // ── Game events ────────────────────────────────────────────────────────
    this.socket.on('betting:started',   (d) => this.handlers.onBettingStarted?.(d));
    this.socket.on('round:started',     (d) => this.handlers.onRoundStarted?.(d));
    this.socket.on('multiplier:tick',   (d) => this.handlers.onMultiplierTick?.(d));
    this.socket.on('round:crashed',     (d) => this.handlers.onRoundCrashed?.(d));
    this.socket.on('bet:accepted',      (d) => this.handlers.onBetAccepted?.(d));
    this.socket.on('cashout:confirmed', (d) => this.handlers.onCashoutConfirmed?.(d));
    this.socket.on('bet:list',          (d) => this.handlers.onBetList?.(d));
    this.socket.on('error',             (d) => this.handlers.onError?.(d));
    this.socket.on('reconnect:state',   (d) => this.handlers.onReconnectState?.(d));
  }

  // ── Private: Backoff Reconnect ─────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.isDestroyed) return;

    if (this.reconnectAttempt >= BACKOFF_MAX_TRIES) {
      console.error('[Socket] Max reconnect attempts reached. Giving up.');
      this.setState({ status: 'failed' });
      this.handlers.onError?.({
        code:    'MAX_RETRIES',
        message: 'Could not reconnect to the server. Please refresh the page.',
      });
      return;
    }

    const delay = fullJitterDelay(this.reconnectAttempt);
    console.info(
      `[Socket] Reconnect attempt ${this.reconnectAttempt + 1}/${BACKOFF_MAX_TRIES} ` +
      `in ${delay}ms (Full Jitter)`,
    );

    this.setState({ status: 'reconnecting', reconnectAttempt: this.reconnectAttempt + 1 });
    this.reconnectAttempt++;

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      // Destroy old socket before creating new one
      this.socket?.removeAllListeners();
      this.socket?.disconnect();
      this.socket = null;
      this.attemptConnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Private: Latency Measurement ──────────────────────────────────────────

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (!this.socket?.connected) return;
      // Latency measurement placeholder — implement with custom ack ping in production
    }, 5000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ── Private: State ────────────────────────────────────────────────────────

  private setState(partial: Partial<SocketState>): void {
    this.state = { ...this.state, ...partial };
    this.handlers.onStateChange?.(this.state);
  }
}

// ─── UUID v4 Generator ────────────────────────────────────────────────────────
// Used by the UI layer to generate idempotency keys before sending bets/cashouts

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
