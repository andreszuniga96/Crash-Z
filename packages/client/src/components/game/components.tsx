/**
 * @file components/game/components.tsx
 * @description Secondary HUD pieces rendered inside GameOverlay:
 *              CrashHistory, BetList, ConnectionBadge, ProvenFairModal.
 *
 * The sibling files (CrashHistory.tsx, BetList.tsx, ...) are thin re-export
 * shims pointing here. All four components are mobile-first: they stay compact
 * and horizontally scrollable instead of overflowing the viewport.
 */

import React from 'react';
import { useGameStore } from '../../store/gameStore';
import { CrashBadge, Modal } from '../ui';
import { formatCOPCompact } from '../../lib/currency';
import type { S2C_RoundCrashed } from '../../socket/types';

// ── CrashHistory ──────────────────────────────────────────────────────────────

/**
 * Horizontal ticker of recent crash multipliers.
 * Detects hot streaks (3+ crashes >= 2×) and shows a motivating banner.
 */
export function CrashHistory() {
  const crashes = useGameStore((s) => s.recentCrashes);
  if (crashes.length === 0) return null;

  // Hot streak: last 3 rounds all >= 2.0×
  const last3      = crashes.slice(0, 3);
  const isHotStreak = last3.length === 3 && last3.every((c) => c >= 2.0);
  const biggestRecent = Math.max(...crashes.slice(0, 5));

  return (
    <div className="flex flex-col gap-1">
      {isHotStreak && (
        <div className="animate-breathe rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-center text-[0.62rem] font-bold text-amber-400">
          🔥 ¡Racha caliente! Últimas 3 rondas +2×
        </div>
      )}
      {biggestRecent >= 10 && !isHotStreak && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-center text-[0.62rem] font-bold text-yellow-400">
          🚀 ¡{biggestRecent.toFixed(2)}× reciente!
        </div>
      )}
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-white/[0.07] bg-black/50 px-2 py-1 scrollbar-none">
        <span className="mr-1 shrink-0 text-[0.65rem] whitespace-nowrap text-muted">
          Historial:
        </span>
        {crashes.slice(0, 10).map((c, i) => (
          <CrashBadge key={i} value={c} />
        ))}
      </div>
    </div>
  );
}

// ── BetList ───────────────────────────────────────────────────────────────────

/** Live table of bets placed in the current round. */
export function BetList() {
  const bets = useGameStore((s) => s.betList);
  if (bets.length === 0) return null;

  const cashedOut = bets.filter((b) => b.cashoutAt !== null).length;

  return (
    <div className="max-h-32 overflow-y-auto rounded-xl border border-white/[0.07] bg-[rgba(6,10,20,0.88)] px-3 py-2 backdrop-blur-xl scrollbar-thin sm:max-h-44">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-muted">
          Apuestas activas ({bets.length})
        </span>
        {cashedOut > 0 && (
          <span className="text-[0.65rem] font-bold text-emerald-400">
            {cashedOut} retirados ✓
          </span>
        )}
      </div>

      <div className="flex flex-col">
        {bets.slice(0, 12).map((bet, i) => (
          <div
            key={i}
            className={`flex items-center justify-between gap-2 py-1 text-[0.75rem] sm:text-xs ${
              i < bets.length - 1 ? 'border-b border-white/[0.04]' : ''
            } ${bet.cashoutAt ? 'opacity-75' : ''}`}
          >
            <span className="min-w-0 flex-1 truncate text-slate-300">{bet.username}</span>

            <span className="shrink-0 font-mono font-bold text-emerald-500">
              {formatCOPCompact(bet.amountCents)}
            </span>

            {bet.cashoutAt ? (
              <span className="shrink-0 font-mono text-[0.7rem] font-bold text-emerald-400">
                ✓ {bet.cashoutAt.toFixed(2)}× · {formatCOPCompact(Math.floor(bet.amountCents * bet.cashoutAt))}
              </span>
            ) : (
              <span className="shrink-0 text-[0.7rem] text-muted">activo</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


// ── ConnectionBadge ───────────────────────────────────────────────────────────

/** Socket.IO connection status indicator. */
export function ConnectionBadge() {
  const isConnected    = useGameStore((s) => s.isConnected);
  const isReconnecting = useGameStore((s) => s.isReconnecting);
  const attempt        = useGameStore((s) => s.reconnectAttempt);

  const dotClass = isConnected
    ? 'connected'
    : isReconnecting
      ? 'connecting'
      : 'disconnected';

  // Keep the label short on mobile; the full string only fits on sm+.
  const label = isConnected
    ? 'Conectado'
    : isReconnecting
      ? `Reconectando (${attempt})…`
      : 'Desconectado';

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-black/50 px-2 py-1">
      <span className={`status-dot ${dotClass}`} />
      <span className="text-[0.68rem] font-medium text-muted sm:text-[0.72rem]">
        {label}
      </span>
    </div>
  );
}

// ── ProvenFairModal ───────────────────────────────────────────────────────────

interface ProvenFairModalProps {
  onClose:        () => void;
  round:          S2C_RoundCrashed | null;
  serverSeedHash: string;
}

/**
 * Provably-fair verification dialog.
 * The heavy hashing happens server-side; this only displays the trail and the
 * server's independent recomputation.
 */
export function ProvenFairModal({ onClose, round, serverSeedHash }: ProvenFairModalProps) {
  const [result, setResult]   = React.useState<{ valid: boolean; computedMultiplier: number } | null>(null);
  const [loading, setLoading] = React.useState(false);

  const canVerify = Boolean(round?.serverSeed);

  async function verify() {
    if (!round) return;
    setLoading(true);
    try {
      const res = await fetch('/api/game/verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverSeed:         round.serverSeed,
          clientSeed:         round.clientSeed,
          nonce:              round.nonce,
          expectedMultiplier: round.crashMultiplier,
        }),
      });
      setResult(await res.json());
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const seedCode = 'block rounded-lg bg-white/[0.04] px-3 py-2 font-mono text-[0.68rem] break-all';

  return (
    <Modal isOpen onClose={onClose} title="🔍 Verificación Provably Fair" width={560}>
      <div className="flex flex-col gap-4">

        <div>
          <div className="mb-1 text-[0.75rem] font-semibold uppercase text-muted">
            Hash del Seed del Servidor (pre-ronda)
          </div>
          <code className={`${seedCode} text-emerald-500`}>{serverSeedHash || '—'}</code>
        </div>

        {round && (
          <>
            <div>
              <div className="mb-1 text-[0.75rem] font-semibold uppercase text-muted">
                Seed Revelado (post-ronda)
              </div>
              <code className={`${seedCode} text-ink`}>
                {round.serverSeed || '[No revelado aún]'}
              </code>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="mb-1 text-[0.7rem] uppercase text-muted">Nonce</div>
                <code className="font-mono text-amber-500">{round.nonce}</code>
              </div>
              <div className="min-w-0">
                <div className="mb-1 text-[0.7rem] uppercase text-muted">Client Seed</div>
                <code className="block truncate font-mono text-[0.8rem] text-amber-500">
                  {round.clientSeed.slice(0, 16)}…
                </code>
              </div>
              <div>
                <div className="mb-1 text-[0.7rem] uppercase text-muted">Crash</div>
                <code className="font-mono font-bold text-red-500">
                  {round.crashMultiplier.toFixed(2)}×
                </code>
              </div>
            </div>
          </>
        )}

        {canVerify && !result && (
          <button
            onClick={verify}
            disabled={loading}
            className="btn w-full bg-gradient-to-br from-blue-500 to-blue-700 py-3 text-white"
          >
            {loading ? '⏳ Verificando…' : '🔐 Verificar con el Servidor'}
          </button>
        )}

        {result && (
          <div
            className={`rounded-xl border px-4 py-3 ${
              result.valid
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-red-500/30 bg-red-500/10'
            }`}
          >
            <div
              className={`mb-2 text-base font-bold ${
                result.valid ? 'text-emerald-500' : 'text-red-500'
              }`}
            >
              {result.valid ? '✓ Ronda VERIFICADA — Justa' : '✕ Verificación FALLIDA'}
            </div>
            <div className="text-[0.78rem] text-muted">
              Multiplicador calculado:{' '}
              <span className="font-mono text-ink">{result.computedMultiplier?.toFixed(2)}×</span>
            </div>
          </div>
        )}

        <p className="text-[0.75rem] leading-relaxed text-muted">
          El multiplicador de crash se genera con{' '}
          <strong className="text-ink">HMAC-SHA256</strong> a partir del seed del
          servidor (desconocido hasta el colapso) + seed del cliente + nonce.
          Puedes verificar matemáticamente que el resultado no fue manipulado.
        </p>
      </div>
    </Modal>
  );
}
