/**
 * @file components/game/BettingPanel.tsx
 * @description The interactive betting panel — mobile-first.
 *
 * States:
 *  BETTING  → amount input + auto-cashout + "APOSTAR"
 *  RUNNING  → "RETIRAR" button (live multiplier)
 *  CRASHED  → round result summary
 *  IDLE     → waiting
 *
 * ── MONEY ────────────────────────────────────────────────────────────────────
 * All amounts in the store and over the wire are INTEGER centavos of COP.
 * The visible input is denominated in whole pesos, so every conversion goes
 * through lib/currency.ts rather than ad-hoc `/ 100` arithmetic.
 *
 * ── LAYOUT ───────────────────────────────────────────────────────────────────
 * The panel is the bottom sheet on mobile and a fixed 320px column on lg+.
 * It uses compact vertical rhythm on small screens (the 3D action needs the
 * height more than the panel does) and relaxes on sm+.
 */

import { useState } from 'react';
import { useGameStore }     from '../../store/gameStore';
import { GamePhase }        from '../../socket/types';
import { toast }            from '../ui';
import { DepositModal }     from './DepositModal';
import {
  BET_PRESETS_CENTS,
  MAX_BET_CENTS,
  MIN_BET_CENTS,
  centsToPesos,
  formatCOP,
  formatCOPCompact,
  pesosToCents,
  validateBet,
} from '../../lib/currency';

interface BettingPanelProps {
  onPlaceBet: () => Promise<unknown>;
  onCashOut:  () => Promise<unknown>;
}

export function BettingPanel({ onPlaceBet, onCashOut }: BettingPanelProps) {
  const phase          = useGameStore((s) => s.phase);
  const balanceCents   = useGameStore((s) => s.balanceCents);
  const betAmount      = useGameStore((s) => s.betAmount);
  const autoCashout    = useGameStore((s) => s.autoCashout);
  const activeBet      = useGameStore((s) => s.activeBet);
  const multiplier     = useGameStore((s) => s.currentMultiplier);
  const lastCrash      = useGameStore((s) => s.lastCrash);
  const setBetAmount   = useGameStore((s) => s.setBetAmount);
  const setAutoCashout = useGameStore((s) => s.setAutoCashout);

  const [loading, setLoading] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);

  const username  = useGameStore((s) => s.username);
  const recentCrashes = useGameStore((s) => s.recentCrashes);

  const isBetting = phase === GamePhase.BETTING;
  const isRunning = phase === GamePhase.RUNNING;
  const isCrashed = phase === GamePhase.CRASHED;

  const hasBet = activeBet !== null;

  // The money model in one place: the player is owed stake × multiplier, of
  // which the profit is everything above the stake. Both are floored, exactly
  // like the server's settlement, so the number shown is never rounded up.
  const payoutCents = hasBet ? Math.floor(activeBet!.amountCents * multiplier) : 0;
  const profitCents = hasBet ? payoutCents - activeBet!.amountCents : 0;

  // Validate continuously so the button state and the hint always agree with
  // exactly the same rule the server will apply.
  const validation = validateBet(betAmount, balanceCents);
  const canBet     = validation.ok && !loading;

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handlePlaceBet() {
    if (!validation.ok) return toast(validation.error ?? 'Apuesta inválida', 'warning');
    setLoading(true);
    try {
      const res = await onPlaceBet() as { ok: boolean; error?: { message: string } };
      if (!res?.ok) toast(res?.error?.message ?? 'Error al apostar', 'error');
      else toast('¡Apuesta realizada!', 'success');
    } finally {
      setLoading(false);
    }
  }

  async function handleCashOut() {
    setLoading(true);
    try {
      const res = await onCashOut() as { ok: boolean; error?: { message: string } };
      if (!res?.ok) toast(res?.error?.message ?? 'Error al retirar', 'error');
      else toast(`¡Retirado a ${multiplier.toFixed(2)}×!`, 'success');
    } finally {
      setLoading(false);
    }
  }

  function nudge(factor: number) {
    const ceiling = Math.min(MAX_BET_CENTS, balanceCents);
    const next    = Math.round(betAmount * factor);
    setBetAmount(Math.max(MIN_BET_CENTS, Math.min(ceiling, next)));
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="panel flex flex-col gap-2.5 p-3 sm:gap-3 sm:p-4 lg:gap-3.5">

      {/* ── Balance + Deposit ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
          Saldo
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-base font-bold text-emerald-500 sm:text-lg">
            {formatCOP(balanceCents)}
          </span>
          <button
            onClick={() => setShowDeposit(true)}
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[0.65rem] font-bold text-amber-400 transition-colors hover:bg-amber-500/20"
            title="Recargar saldo"
          >
            + Recargar
          </button>
        </div>
      </div>

      {/* ── BETTING FORM ──────────────────────────────────────────────────── */}
      {isBetting && !hasBet && (
        <>
          {/* Presets — 5 columns fits down to a 320px viewport */}
          <div className="grid grid-cols-5 gap-1">
            {BET_PRESETS_CENTS.map((cents) => {
              const selected = betAmount === cents;
              return (
                <button
                  key={cents}
                  onClick={() => setBetAmount(cents)}
                  className={`rounded-lg border py-1.5 font-mono text-[0.65rem] font-bold transition-colors sm:text-xs ${
                    selected
                      ? 'border-red-500/50 bg-red-500/20 text-orange-400'
                      : 'border-white/10 bg-white/5 text-muted hover:bg-white/10 hover:text-ink'
                  }`}
                >
                  {formatCOPCompact(cents)}
                </button>
              );
            })}
          </div>

          {/* Amount */}
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
              Monto
            </span>
            <div className="relative flex items-center">
              <span className="pointer-events-none absolute left-3 text-sm text-muted">$</span>
              <input
                type="number"
                inputMode="numeric"
                // The field is denominated in PESOS; the store holds centavos.
                value={centsToPesos(betAmount)}
                onChange={(e) => setBetAmount(pesosToCents(parseFloat(e.target.value || '0')))}
                min={centsToPesos(MIN_BET_CENTS)}
                max={centsToPesos(MAX_BET_CENTS)}
                step={100}
                className="input pl-7 pr-3"
              />
            </div>
          </label>

          {/* Quick adjustments */}
          <div className="grid grid-cols-3 gap-1">
            {([
              ['½',  () => nudge(0.5)],
              ['×2', () => nudge(2)],
              ['MÁX', () => setBetAmount(Math.min(MAX_BET_CENTS, balanceCents))],
            ] as const).map(([label, fn]) => (
              <button
                key={label}
                onClick={fn}
                className="rounded-lg border border-white/10 bg-white/5 py-1 font-mono text-[0.7rem] text-muted transition-colors hover:bg-white/10 hover:text-ink"
              >
                {label}
              </button>
            ))}
          </div>

          {/* Auto cashout */}
          <label className="flex flex-col gap-1">
            <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
              Auto retirar (0 = manual)
            </span>
            <div className="relative flex items-center">
              <input
                type="number"
                inputMode="decimal"
                value={autoCashout === 0 ? '' : autoCashout.toFixed(2)}
                onChange={(e) => setAutoCashout(parseFloat(e.target.value || '0'))}
                placeholder="Ej: 2.00"
                min="1.01"
                step="0.25"
                className="input pr-8"
              />
              <span className="pointer-events-none absolute right-3 text-sm text-muted">×</span>
            </div>
          </label>

          {/* Limits hint + inline validation */}
          <p className={`text-[0.68rem] ${validation.ok ? 'text-muted' : 'text-amber-500'}`}>
            {validation.ok
              ? `Mín ${formatCOP(MIN_BET_CENTS)} · Máx ${formatCOP(MAX_BET_CENTS)}`
              : validation.error}
          </p>

          {/* The CTA sticks to the bottom edge of the mobile drawer so it stays
              reachable even when the drawer body scrolls. */}
          <div className="sticky bottom-0 -mx-3 mt-1 bg-gradient-to-t from-[rgba(6,10,20,0.96)] via-[rgba(6,10,20,0.78)] to-transparent px-3 pb-0.5 pt-2 sm:-mx-4 sm:px-4 lg:static lg:mx-0 lg:bg-none lg:px-0 lg:pt-0">
            <button
              onClick={handlePlaceBet}
              disabled={!canBet}
              className="btn btn-primary w-full py-3 text-sm tracking-[0.08em] sm:py-3.5 sm:text-base"
            >
              {loading ? '⏳ Procesando…' : `🎯 Apostar ${formatCOP(betAmount)}`}
            </button>
          </div>
        </>
      )}

      {/* ── BETTING, BET ALREADY PLACED ───────────────────────────────────── */}
      {isBetting && hasBet && (
        <div className="py-2 text-center">
          <div className="mb-1 text-sm font-bold text-emerald-500 sm:text-base">
            ✓ Apuesta confirmada
          </div>
          <div className="text-xs text-muted sm:text-sm">
            {formatCOP(activeBet!.amountCents)}
            {activeBet!.autoCashoutAt > 0 && ` · Auto: ${activeBet!.autoCashoutAt.toFixed(2)}×`}
          </div>
          <div className="mt-2 animate-breathe text-[0.72rem] text-amber-500 sm:text-xs">
            Esperando inicio de ronda…
          </div>
        </div>
      )}

      {/* ── RUNNING ───────────────────────────────────────────────────────── */}
      {isRunning && hasBet && (
        <>
          {/* Makes the money model explicit: stake × multiplier = payout. */}
          <div
            className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${
              profitCents > 0
                ? 'border-emerald-500/25 bg-emerald-500/10'
                : 'border-red-500/25 bg-red-500/10'
            }`}
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-[0.72rem] font-semibold text-muted sm:text-xs">Retiro ahora</span>
              <span className="truncate font-mono text-[0.62rem] text-muted/70 sm:text-[0.68rem]">
                {formatCOPCompact(activeBet!.amountCents)} × {multiplier.toFixed(2)}×
                {profitCents > 0 && ` · +${formatCOPCompact(profitCents)}`}
              </span>
            </span>
            <span
              className={`payout-text shrink-0 font-mono text-base font-bold sm:text-lg ${
                profitCents > 0 ? 'text-emerald-500' : 'text-red-500'
              }`}
            >
              {formatCOP(payoutCents)}
            </span>
          </div>

          {activeBet!.autoCashoutAt > 0 && (
            <div className="text-center text-[0.72rem] text-muted sm:text-xs">
              Auto-retiro en{' '}
              <span className="font-bold text-amber-500">
                {activeBet!.autoCashoutAt.toFixed(2)}×
              </span>
            </div>
          )}

          <button
            onClick={handleCashOut}
            disabled={loading}
            className="btn btn-success w-full animate-breathe py-3.5 text-sm tracking-wide sm:py-4 sm:text-base"
          >
            {loading
              ? '⏳…'
              : `💰 RETIRAR ${multiplier.toFixed(2)}× · ${formatCOP(payoutCents)}`}
          </button>
        </>
      )}

      {/* ── RUNNING, NO BET ───────────────────────────────────────────────── */}
      {isRunning && !hasBet && (
        <div className="py-2 text-center">
          <div className="text-sm font-bold text-amber-400 animate-breathe">
            ¡No te pierdas la siguiente!
          </div>
          <div className="mt-1 text-[0.7rem] text-muted">
            Próxima ronda en instantes — prepara tu apuesta
          </div>
          {recentCrashes.length > 0 && (
            <div className="mt-2 text-[0.68rem] text-muted">
              Últimos:{' '}
              {recentCrashes.slice(0,4).map((c, i) => (
                <span key={i} className={`mr-1 font-mono font-bold ${
                  c >= 3 ? 'text-emerald-400' : c >= 2 ? 'text-amber-400' : 'text-red-400'
                }`}>
                  {c.toFixed(2)}×
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CRASHED ───────────────────────────────────────────────────────── */}
      {isCrashed && (
        <div className="py-1 text-center">
          {lastCrash && (
            <>
              <div className="mb-1 text-[0.72rem] text-muted sm:text-xs">
                Ronda #{lastCrash.roundNumber} — Colapso
              </div>
              <div className="multiplier-text multiplier-text--crashed text-3xl sm:text-4xl">
                {lastCrash.crashMultiplier.toFixed(2)}×
              </div>
              <div className="mt-1 text-[0.72rem] text-muted sm:text-xs">
                {lastCrash.playerCount} jugadores · {formatCOPCompact(lastCrash.totalBetsCents)} apostados
              </div>
            </>
          )}
          <div className="mt-2 animate-breathe text-[0.72rem] font-semibold text-amber-400 sm:text-xs">
            🎯 ¡Nueva oportunidad llegando!
          </div>
        </div>
      )}

      {showDeposit && (
        <DepositModal username={username} onClose={() => setShowDeposit(false)} />
      )}
    </div>
  );
}

