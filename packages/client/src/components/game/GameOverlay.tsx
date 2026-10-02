/**
 * @file components/game/GameOverlay.tsx
 * @description The main game HUD overlaid on the Three.js canvas.
 *
 * ── LAYOUT CONTRACT ──────────────────────────────────────────────────────────
 * The overlay is a single flex column that fills the viewport. Its whole job is
 * to leave the MIDDLE band of the screen clear so the 3D survivor is always
 * visible, no matter the viewport:
 *
 *   ┌──────────────────────────────┐
 *   │ header   status · user · hist│  auto height, wraps on narrow screens
 *   ├──────────────────────────────┤
 *   │ multiplier × live COP payout │  auto height, sits just under the header
 *   ├──────────────────────────────┤
 *   │                              │
 *   │   SPACER (flex-1)            │  ← 3D action lives here, never covered
 *   │                              │
 *   ├──────────────────────────────┤
 *   │ footer   bet list + panel    │  drawer on phones, split columns on lg+
 *   └──────────────────────────────┘
 *
 * ── MOBILE FIRST ─────────────────────────────────────────────────────────────
 * Base classes target the smallest viewport; `sm:` / `lg:` progressively add
 * the desktop arrangement. Concretely:
 *
 *  · PHONES — the betting panel is a DRAWER pinned to the bottom edge with a
 *    safe-area-aware inset. Collapsed it is a single row, so the canvas keeps
 *    the screen; it auto-opens when a betting window starts (nobody should miss
 *    a round because they were hunting for a hidden panel), and while a round
 *    is running the handle is replaced by the cash-out button so the money is
 *    one tap away without opening anything.
 *  · DESKTOP (lg+) — the drawer chrome disappears entirely: the panel becomes a
 *    fixed side column and the bet list a column on the left, leaving the
 *    middle of the canvas as the protagonist.
 *
 * ── THE PAYOUT READOUT ───────────────────────────────────────────────────────
 * The multiplier and the live COP amount live in <LiveMultiplier>, which owns
 * its own 60 fps frame loop. Keeping it isolated means the rest of the HUD only
 * re-renders at the socket's tick rate.
 *
 * The user bar (name / admin / logout) lives in THIS header rather than in
 * App.tsx. It used to be a second absolutely-positioned bar at the same corner,
 * which is exactly why the two rows of controls overlapped.
 */

import { useEffect, useState } from 'react';
import { useGameStore }     from '../../store/gameStore';
import { GamePhase }        from '../../socket/types';
import { toast }            from '../ui';
import { BettingPanel }     from './BettingPanel';
import { CrashHistory }     from './CrashHistory';
import { BetList }          from './BetList';
import { ConnectionBadge }  from './ConnectionBadge';
import { ProvenFairModal }  from './ProvenFairModal';
import { LiveMultiplier }   from './LiveMultiplier';
import { WithdrawalModal }  from './WithdrawalModal';
import { formatCOP }        from '../../lib/currency';

interface GameOverlayProps {
  onPlaceBet:   () => Promise<unknown>;
  onCashOut:    () => Promise<unknown>;
  username:     string;
  isAdmin:      boolean;
  onOpenAdmin:  () => void;
  onLogout:     () => void;
}

export function GameOverlay({
  onPlaceBet,
  onCashOut,
  username,
  isAdmin,
  onOpenAdmin,
  onLogout,
}: GameOverlayProps) {
  const phase          = useGameStore((s) => s.phase);
  const lastCrash      = useGameStore((s) => s.lastCrash);
  const fps            = useGameStore((s) => s.fps);
  const pixelRatio     = useGameStore((s) => s.pixelRatio);
  const serverSeedHash = useGameStore((s) => s.serverSeedHash);
  const activeBet      = useGameStore((s) => s.activeBet);
  const betAmount      = useGameStore((s) => s.betAmount);
  const multiplier     = useGameStore((s) => s.currentMultiplier);
  const betCount       = useGameStore((s) => s.betList.length);

  const [showPF, setShowPF]               = useState(false);
  const [showBets, setShowBets]           = useState(false);
  const [drawerOpen, setDrawerOpen]       = useState(false);
  const [showWithdraw, setShowWithdraw]   = useState(false);

  const isCrashed = phase === GamePhase.CRASHED;
  const isRunning = phase === GamePhase.RUNNING;
  const isBetting = phase === GamePhase.BETTING;
  const hasBet    = activeBet !== null;

  // ── Drawer choreography ────────────────────────────────────────────────────
  // Open it when a window starts without a bet (so a phone player can act
  // immediately), and hand the screen back to the canvas once the round runs.
  useEffect(() => {
    if (isBetting && !hasBet) setDrawerOpen(true);
    if (isRunning || isCrashed) setDrawerOpen(false);
  }, [isBetting, isRunning, isCrashed, hasBet]);

  /** Cash-out from the drawer handle, with the same feedback as the panel. */
  async function handleCashOutNow() {
    const res = await onCashOut() as { ok: boolean; error?: { message: string } };
    if (!res?.ok) toast(res?.error?.message ?? 'Error al retirar', 'error');
    else toast(`¡Retirado a ${multiplier.toFixed(2)}×!`, 'success');
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col">

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <header className="pointer-events-auto flex items-start justify-between gap-2 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-3 sm:pt-3">

        {/* Left: connection + provably-fair hash */}
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <ConnectionBadge />

          {serverSeedHash && (
            <button
              onClick={() => setShowPF(true)}
              title="Verificar la transparencia de la ronda"
              className="max-w-[6.5rem] truncate rounded-md border border-white/10 bg-black/50 px-2 py-0.5 font-mono text-[0.65rem] text-muted transition-colors hover:text-ink sm:max-w-none"
            >
              🔒 {serverSeedHash.slice(0, 12)}…
            </button>
          )}
        </div>

        {/* Right: user controls, crash history, perf readout */}
        <div className="flex min-w-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="hidden max-w-[9rem] truncate text-xs text-muted sm:inline">
              👤 {username}
            </span>

            {isAdmin && (
              <button
                onClick={onOpenAdmin}
                className="rounded-md border border-red-500/30 bg-red-500/15 px-2 py-0.5 text-[0.7rem] font-bold text-red-400 transition-colors hover:bg-red-500/25"
              >
                ⚙ <span className="hidden sm:inline">Admin</span>
              </button>
            )}

            <button
              onClick={() => setShowWithdraw(true)}
              className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[0.7rem] font-bold text-emerald-400 transition-colors hover:bg-emerald-500/20"
            >
              💸 <span className="hidden sm:inline">Retirar</span>
            </button>

            <button
              onClick={onLogout}
              className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[0.7rem] text-muted transition-colors hover:bg-white/10 hover:text-ink"
            >
              Salir
            </button>
          </div>

          <div className="max-w-[54vw] sm:max-w-none">
            <CrashHistory />
          </div>

          {/* Perf readout — desktop only, it is a developer aid */}
          <div
            className={`hidden rounded-md border border-white/5 bg-black/45 px-2 py-0.5 font-mono text-[0.65rem] sm:block ${
              fps < 45 ? 'text-amber-500' : 'text-emerald-600'
            }`}
          >
            {fps}fps · {pixelRatio.toFixed(1)}×dpr
          </div>
        </div>
      </header>

      {/* ══ MULTIPLIER × LIVE PAYOUT ════════════════════════════════════════ */}
      {/* Sits directly under the header so it never covers the 3D action. */}
      <LiveMultiplier onVerifyRound={() => setShowPF(true)} />

      {/* ══ SPACER ══════════════════════════════════════════════════════════ */}
      {/* flex-1 absorbs all remaining height, which is what keeps the survivor
          visible between the readout and the bottom drawer. */}
      <div className="min-h-0 flex-1" />

      {/* ══ FOOTER ══════════════════════════════════════════════════════════ */}
      <footer className="pointer-events-none relative z-20 flex flex-col gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-3 lg:flex-row lg:items-end lg:gap-4 lg:px-4 lg:pb-4">

        {/* Bet list — a toggle chip on mobile, a left column on lg+ */}
        <div className="pointer-events-auto order-2 lg:order-1 lg:mr-auto lg:w-[min(320px,34vw)] lg:shrink-0">
          <button
            onClick={() => setShowBets((v) => !v)}
            className="mb-1 w-full rounded-lg border border-white/10 bg-black/50 px-3 py-1.5 text-left text-[0.72rem] text-muted backdrop-blur transition-colors hover:text-ink lg:hidden"
            aria-expanded={showBets}
          >
            {showBets ? '▾' : '▸'} Apuestas activas ({betCount})
          </button>

          <div className={showBets ? 'block' : 'hidden lg:block'}>
            <BetList />
          </div>
        </div>

        {/* ── Betting panel: bottom drawer on mobile, right column on lg+ ─── */}
        <div className="pointer-events-auto order-1 w-full lg:order-2 lg:w-[340px] lg:shrink-0">

          {/* Drawer handle / one-tap cash-out — mobile and tablet only */}
          <div className="lg:hidden">
            {isRunning && hasBet ? (
              <button
                onClick={handleCashOutNow}
                className="btn btn-success w-full animate-breathe py-3.5 text-base tracking-wide"
              >
                💰 RETIRAR {multiplier.toFixed(2)}× · {formatCOP(activeBet.amountCents * multiplier)}
              </button>
            ) : (
              <button
                onClick={() => setDrawerOpen((v) => !v)}
                aria-expanded={drawerOpen}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-white/12 bg-black/65 px-3 py-2.5 text-left backdrop-blur transition-colors hover:bg-black/80"
              >
                <span className="flex min-w-0 items-center gap-2 text-[0.78rem] font-bold text-ink">
                  <span className="text-muted">{drawerOpen ? '▾' : '▴'}</span>
                  <span className="truncate">
                    {hasBet ? `Apuesta ${formatCOP(activeBet.amountCents)}` : `Apostar ${formatCOP(betAmount)}`}
                  </span>
                </span>
                <span className="shrink-0 text-[0.68rem] uppercase tracking-[0.12em] text-muted">
                  {isBetting ? 'Abierta' : isCrashed ? 'Resultado' : 'Esperando'}
                </span>
              </button>
            )}
          </div>

          {/* Drawer body (mobile) / always-visible column (lg+) */}
          <div className={`${drawerOpen ? 'mt-2 animate-slide-up' : 'hidden'} lg:mt-0 lg:block`}>
            <div className="max-h-[46vh] overflow-y-auto overscroll-contain rounded-2xl lg:max-h-none lg:overflow-visible">
              <BettingPanel onPlaceBet={onPlaceBet} onCashOut={onCashOut} />
            </div>
          </div>
        </div>
      </footer>

      {showPF && (
        <ProvenFairModal
          onClose={() => setShowPF(false)}
          round={lastCrash}
          serverSeedHash={serverSeedHash}
        />
      )}

      {showWithdraw && <WithdrawalModal onClose={() => setShowWithdraw(false)} />}
    </div>
  );
}

