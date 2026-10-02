/**
 * @file components/game/LiveMultiplier.tsx
 * @description The round's hero readout: multiplier × live COP potential payout.
 *
 * ── WHY IT IS ITS OWN COMPONENT ──────────────────────────────────────────────
 * The payout counter is the one element on screen that changes on every frame.
 * Keeping it (and the multiplier it belongs to) inside a self-contained
 * component means the 60 fps state update re-renders a few dozen DOM nodes,
 * not the betting panel, the bet list and the crash history along with them.
 * Everything else in the HUD keeps re-rendering at the socket's 10 Hz tick.
 *
 * ── MONEY ────────────────────────────────────────────────────────────────────
 * `activeBet.amountCents × multiplier`, floored, formatted as COP. With a
 * $5.000 COP stake at 10.50× the number reads `$52.500` — and it grows in step
 * with the multiplier because both are derived from the same live value.
 *
 * ── LIVE VALUE ───────────────────────────────────────────────────────────────
 * The multiplier is evaluated client-side from the round's start timestamp
 * (lib/multiplierCurve.ts) on every animation frame, so the money climbs
 * continuously instead of stepping at the server's 100 ms tick.
 *
 * The local value is CLAMPED to the last authoritative tick:
 *
 *     live = max(serverTick, min(localEstimate, serverTick × 1.05))
 *
 * so clock skew can make the display smooth, never optimistic — the HUD can
 * never show a multiplier, or an amount of money, the server has not reached.
 */

import { useEffect, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { GamePhase }   from '../../socket/types';
import { elapsedMsToMultiplier } from '../../lib/multiplierCurve';
import { formatCOP }   from '../../lib/currency';

/** How far ahead of the last server tick the client may interpolate. */
const MAX_LEAD = 1.05;

interface LiveMultiplierProps {
  /** Opens the provably-fair modal for the round that just crashed. */
  onVerifyRound: () => void;
}

export function LiveMultiplier({ onVerifyRound }: LiveMultiplierProps) {
  const phase            = useGameStore((s) => s.phase);
  const activeBet        = useGameStore((s) => s.activeBet);
  const tickMultiplier   = useGameStore((s) => s.currentMultiplier);
  const lastCrash        = useGameStore((s) => s.lastCrash);
  const bettingEndsAt    = useGameStore((s) => s.bettingEndsAt);
  const bettingDurationMs = useGameStore((s) => s.bettingDurationMs);
  const lastWin          = useGameStore((s) => s.lastWin);

  const [live, setLive] = useState(1);

  const isRunning = phase === GamePhase.RUNNING;
  const isBetting = phase === GamePhase.BETTING;
  const isCrashed = phase === GamePhase.CRASHED;

  // ── Frame loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;

    const tick = () => {
      const state = useGameStore.getState();

      if (state.phase === GamePhase.RUNNING && state.runningStartedAt > 0) {
        const estimate = elapsedMsToMultiplier(Date.now() - state.runningStartedAt);
        const lead     = state.currentMultiplier * MAX_LEAD;
        setLive(Math.max(state.currentMultiplier, Math.min(estimate, lead)));
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Displayed value ────────────────────────────────────────────────────────
  const displayMultiplier = isCrashed
    ? (lastCrash?.crashMultiplier ?? live)
    : isRunning
      ? live
      : tickMultiplier;

  // ── Live payout ────────────────────────────────────────────────────────────
  const hasStake   = activeBet !== null;
  const stakeCents = activeBet?.amountCents ?? 0;
  const payoutCents = hasStake ? Math.floor(stakeCents * displayMultiplier) : 0;

  const showMoney = hasStake && (isRunning || isBetting || isCrashed);

  // The glow grows with the multiplier — the number literally heats up.
  const glowRadius = 10 + Math.min(30, displayMultiplier * 2.6);
  const glowAlpha  = Math.min(0.75, 0.32 + Math.max(0, displayMultiplier - 1) * 0.045);

  return (
    <div className="mt-1 flex flex-col items-center px-2 text-center sm:mt-2">

      {/* Multiplier + money. Stacked on phones, side by side from sm up. */}
      <div className="flex flex-col items-center gap-x-5 gap-y-0.5 sm:flex-row sm:items-baseline">
        <div
          className={`multiplier-text text-[2.6rem] leading-none sm:text-6xl lg:text-7xl ${
            isCrashed ? 'multiplier-text--crashed animate-shake' : ''
          }`}
        >
          {displayMultiplier.toFixed(2)}×
        </div>

        {showMoney && (
          <div className="flex flex-col items-center sm:items-start">
            <span className="text-[0.55rem] font-bold uppercase tracking-[0.16em] text-emerald-500/70 sm:text-[0.65rem]">
              {isBetting ? 'En juego' : 'Ganancia potencial'}
            </span>
            <span
              className="payout-text font-mono text-2xl font-black leading-tight text-emerald-400 tabular-nums sm:text-4xl lg:text-5xl"
              style={{ textShadow: `0 0 ${glowRadius}px rgba(16,185,129,${glowAlpha})` }}
            >
              {formatCOP(payoutCents)}
            </span>
          </div>
        )}
      </div>

      {/* Phase label */}
      <div
        className={`mt-1 text-[0.7rem] font-bold uppercase tracking-[0.2em] sm:text-sm ${
          isCrashed ? 'text-red-500' : isBetting ? 'text-amber-500' : 'text-emerald-500'
        }`}
      >
        {isCrashed ? '💀 Colapso' : isBetting ? '⏳ Apostando' : isRunning ? '🏃 Corriendo' : '…'}
      </div>

      {isBetting && bettingEndsAt > 0 && (
        <BettingCountdown endsAt={bettingEndsAt} durationMs={bettingDurationMs} />
      )}

      {/* Show win result briefly after a successful cashout */}
      {lastWin && isCrashed && (
        <div className="pointer-events-auto mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-center">
          <span className="text-[0.72rem] text-emerald-400 font-bold">
            ✓ Retiraste a {lastWin.multiplier.toFixed(2)}× · {formatCOP(lastWin.payoutCents)}
          </span>
        </div>
      )}

      {isCrashed && lastCrash && (
        <button
          onClick={onVerifyRound}
          className="pointer-events-auto mt-2 rounded-lg border border-white/15 bg-white/10 px-3 py-1 text-[0.7rem] text-muted backdrop-blur transition-colors hover:text-ink sm:text-xs"
        >
          🔍 Verificar Ronda #{lastCrash.roundNumber}
        </button>
      )}
    </div>
  );
}


// ── Betting countdown timer ────────────────────────────────────────────────────

/**
 * Recomputes from the ABSOLUTE deadline rather than decrementing a counter, so
 * the display stays correct if the tab throttles timers in the background. The
 * bar's scale comes from the window length the server announced, so changing
 * BETTING_PHASE_MS server-side needs no client edit.
 */
function BettingCountdown({ endsAt, durationMs }: { endsAt: number; durationMs: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, endsAt - Date.now()));
  const windowMs = durationMs > 0 ? durationMs : 7000;

  useEffect(() => {
    const id = setInterval(() => setRemaining(Math.max(0, endsAt - Date.now())), 100);
    return () => clearInterval(id);
  }, [endsAt]);

  const pct = Math.max(0, Math.min(100, (remaining / windowMs) * 100));

  return (
    <div className="mt-2 flex flex-col items-center gap-1">
      <span className="font-mono text-base font-bold text-amber-500 sm:text-xl">
        {(remaining / 1000).toFixed(1)}s
      </span>
      <div className="h-1 w-32 overflow-hidden rounded-full bg-white/10 sm:w-44">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500 transition-[width] duration-100 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
