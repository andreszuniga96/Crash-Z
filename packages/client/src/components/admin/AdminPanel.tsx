/**
 * @file components/admin/AdminPanel.tsx
 * @description Full admin dashboard panel.
 *
 * Tabs:
 *  1. Dashboard  — P&L summary cards + 7-day chart
 *  2. Jugadores  — Searchable user table with status/balance controls
 *  3. Rondas     — Round history with Provably Fair verification
 */

import { useEffect, useState, useCallback } from 'react';
import { useGameStore } from '../../store/gameStore';
import { toast, Modal, CrashBadge } from '../ui';
import { formatCOP, pesosToCents } from '../../lib/currency';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FinanceSummary {
  players:    { total: number; active: number; totalBalanceCents: number };
  financial: {
    totalRounds: number; totalWageredCents: number; totalPayoutCents: number;
    totalHouseEdgeCents: number; houseEdgeRatePercent: string;
    avgCrashMultiplier: string; avgPlayerCount: string;
  };
  dailyBreakdown: Array<{ _id: string; rounds: number; wageredCents: number; houseEdgeCents: number }>;
}

interface UserRow {
  _id: string; username: string; email: string;
  role: string; status: string; balanceCents: number;
  createdAt: string; lastLoginAt?: string;
}

interface RoundRow {
  _id: string; roundNumber: number; crashMultiplier: number;
  status: string; serverSeed?: string; serverSeedHash: string;
  playerCount: number; totalBetsCents: number; crashedAt?: string;
}

// ─── API helper ───────────────────────────────────────────────────────────────

async function adminFetch(path: string, token: string, options?: RequestInit) {
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Main AdminPanel ──────────────────────────────────────────────────────────

type TabId = 'dashboard' | 'players' | 'rounds';

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const token      = useGameStore((s) => s.accessToken);
  const [tab, setTab] = useState<TabId>('dashboard');

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 7000,
      background: 'rgba(0,2,8,0.96)', backdropFilter: 'blur(12px)',
      display: 'flex', flexDirection: 'column',
      animation: 'fadeIn 0.3s ease',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: '1.4rem', fontWeight: 900, color: '#ff3333' }}>☣</span>
          <span style={{ fontWeight: 800, fontSize: '1.1rem', color: '#e8ecf4' }}>ZombieRun Admin</span>
          <span style={{
            background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444', fontSize: '0.7rem', fontWeight: 700,
            padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase',
          }}>Admin</span>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            { id: 'dashboard', label: '📊 Dashboard' },
            { id: 'players',   label: '👥 Jugadores' },
            { id: 'rounds',    label: '🎲 Rondas' },
          ] as { id: TabId; label: string }[]).map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '7px 16px', borderRadius: 8, border: 'none',
              background: tab === t.id ? 'rgba(255,51,51,0.2)' : 'rgba(255,255,255,0.05)',
              color: tab === t.id ? '#ff6633' : '#6b7a99',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.85rem',
              cursor: 'pointer', transition: 'all 0.2s',
              borderBottom: tab === t.id ? '2px solid #ff3333' : '2px solid transparent',
            }}>
              {t.label}
            </button>
          ))}
        </div>

        <button onClick={onClose} style={{
          background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)',
          color: '#6b7a99', borderRadius: 10, padding: '7px 16px',
          cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
        }}>
          ✕ Cerrar
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {tab === 'dashboard' && <DashboardTab token={token} />}
        {tab === 'players'   && <PlayersTab   token={token} />}
        {tab === 'rounds'    && <RoundsTab    token={token} />}
      </div>
    </div>
  );
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

function DashboardTab({ token }: { token: string }) {
  const [data, setData] = useState<FinanceSummary | null>(null);

  useEffect(() => {
    adminFetch('/finance/summary', token).then(setData).catch((e) => toast(e.message, 'error'));
  }, [token]);

  if (!data) return <Loading />;

  const cards = [
    { label: 'Jugadores Totales', value: data.players.total.toLocaleString(), icon: '👥', color: '#3b82f6' },
    { label: 'Jugadores Activos', value: data.players.active.toLocaleString(), icon: '🟢', color: '#22c55e' },
    { label: 'Total Wagered',     value: formatCOP(data.financial.totalWageredCents), icon: '🎯', color: '#f59e0b' },
    { label: 'Casa Edge',         value: `${data.financial.houseEdgeRatePercent}%`, icon: '🏦', color: '#ff3333' },
    { label: 'Avg Crash',         value: `${data.financial.avgCrashMultiplier}×`, icon: '💥', color: '#a855f7' },
    { label: 'Rondas Totales',    value: data.financial.totalRounds.toLocaleString(), icon: '🎲', color: '#06b6d4' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        {cards.map((c) => (
          <div key={c.label} style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16, padding: '20px 18px',
            borderLeft: `3px solid ${c.color}`,
            transition: 'transform 0.2s',
          }}>
            <div style={{ fontSize: '1.8rem', marginBottom: 8 }}>{c.icon}</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.5rem', fontWeight: 900, color: c.color }}>
              {c.value}
            </div>
            <div style={{ color: '#6b7a99', fontSize: '0.78rem', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {c.label}
            </div>
          </div>
        ))}
      </div>

      {/* 7-day breakdown */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 16, padding: '20px 24px',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 16, color: '#e8ecf4' }}>
          📅 Últimos 7 días
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.dailyBreakdown.map((d) => (
            <div key={d._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', color: '#6b7a99', fontSize: '0.85rem' }}>{d._id}</span>
              <span style={{ color: '#e8ecf4', fontSize: '0.85rem' }}>{d.rounds} rondas</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', color: '#22c55e' }}>{formatCOP(d.wageredCents)}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', color: '#f59e0b' }}>Edge: {formatCOP(d.houseEdgeCents)}</span>
            </div>
          ))}
          {data.dailyBreakdown.length === 0 && (
            <div style={{ color: '#6b7a99', textAlign: 'center', padding: '20px 0' }}>Sin datos</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Players Tab ──────────────────────────────────────────────────────────────

function PlayersTab({ token }: { token: string }) {
  const [users, setUsers]   = useState<UserRow[]>([]);
  const [total, setTotal]   = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage]     = useState(1);
  const [balanceModal, setBalanceModal] = useState<UserRow | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), limit: '20', search });
    adminFetch(`/users?${qs}`, token)
      .then((d) => { setUsers(d.data); setTotal(d.total); })
      .catch((e) => toast(e.message, 'error'));
  }, [token, page, search]);

  useEffect(() => { load(); }, [load]);

  async function changeStatus(userId: string, status: string) {
    try {
      await adminFetch(`/users/${userId}/status`, token, { method: 'PATCH', body: JSON.stringify({ status }) });
      toast(`Estado actualizado a "${status}"`, 'success');
      load();
    } catch (e: unknown) { toast((e as Error).message, 'error'); }
  }

  const statusColors: Record<string, string> = { active: '#22c55e', suspended: '#f59e0b', banned: '#ef4444' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Search bar */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <input
          placeholder="🔍 Buscar usuario o email…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{
            flex: 1, padding: '10px 14px',
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10, color: '#e8ecf4', fontFamily: 'Outfit, sans-serif', outline: 'none',
          }}
        />
        <span style={{ color: '#6b7a99', fontSize: '0.85rem' }}>{total} usuarios</span>
      </div>

      {/* Table */}
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              {['Usuario', 'Email', 'Rol', 'Estado', 'Saldo', 'Último Login', 'Acciones'].map((h) => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', color: '#6b7a99', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => (
              <tr key={u._id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 ? 'rgba(255,255,255,0.01)' : 'transparent', transition: 'background 0.15s' }}>
                <td style={{ padding: '10px 16px', color: '#e8ecf4', fontWeight: 600 }}>{u.username}</td>
                <td style={{ padding: '10px 16px', color: '#6b7a99', fontSize: '0.85rem' }}>{u.email}</td>
                <td style={{ padding: '10px 16px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 4, background: u.role === 'admin' ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)', color: u.role === 'admin' ? '#ef4444' : '#3b82f6', fontSize: '0.75rem', fontWeight: 700 }}>
                    {u.role}
                  </span>
                </td>
                <td style={{ padding: '10px 16px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 4, background: `${statusColors[u.status] ?? '#666'}20`, color: statusColors[u.status] ?? '#666', fontSize: '0.75rem', fontWeight: 700 }}>
                    {u.status}
                  </span>
                </td>
                <td style={{ padding: '10px 16px', fontFamily: 'JetBrains Mono, monospace', color: '#22c55e', fontSize: '0.9rem' }}>
                  {formatCOP(u.balanceCents)}
                </td>
                <td style={{ padding: '10px 16px', color: '#6b7a99', fontSize: '0.8rem' }}>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('es') : '—'}
                </td>
                <td style={{ padding: '10px 16px' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => setBalanceModal(u)} title="Ajustar saldo" style={btnSmall('#f59e0b')}>💰</button>
                    {u.status === 'active'
                      ? <button onClick={() => changeStatus(u._id, 'suspended')} title="Suspender" style={btnSmall('#f59e0b')}>⏸</button>
                      : <button onClick={() => changeStatus(u._id, 'active')} title="Activar" style={btnSmall('#22c55e')}>▶</button>
                    }
                    {u.status !== 'banned' && (
                      <button onClick={() => changeStatus(u._id, 'banned')} title="Banear" style={btnSmall('#ef4444')}>🚫</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        {page > 1 && <button onClick={() => setPage(page - 1)} style={btnSmall('#6b7a99')}>← Anterior</button>}
        <span style={{ color: '#6b7a99', fontSize: '0.85rem', padding: '6px 12px' }}>Página {page}</span>
        {users.length === 20 && <button onClick={() => setPage(page + 1)} style={btnSmall('#6b7a99')}>Siguiente →</button>}
      </div>

      {/* Balance modal */}
      {balanceModal && (
        <BalanceAdjustModal
          user={balanceModal}
          token={token}
          onClose={() => setBalanceModal(null)}
          onSuccess={load}
        />
      )}
    </div>
  );
}

function btnSmall(color: string): React.CSSProperties {
  return {
    background: `${color}18`, border: `1px solid ${color}40`, borderRadius: 6,
    color, padding: '4px 8px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700,
  };
}

// ─── Balance Modal ─────────────────────────────────────────────────────────────

function BalanceAdjustModal({ user, token, onClose, onSuccess }: {
  user: UserRow; token: string; onClose: () => void; onSuccess: () => void;
}) {
  const [type, setType]   = useState<'deposit' | 'withdrawal'>('deposit');
  const [amount, setAmount] = useState('');
  const [note, setNote]   = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    // The field is denominated in whole COP pesos; the API expects centavos.
    const amountCents = pesosToCents(parseFloat(amount));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return toast('Ingresa un monto válido', 'warning');
    }
    setLoading(true);
    try {
      await adminFetch(`/users/${user._id}/balance`, token, {
        method: 'PATCH', body: JSON.stringify({ amountCents, type, note }),
      });
      toast(`${type === 'deposit' ? 'Depósito' : 'Retiro'} de ${formatCOP(amountCents)} procesado`, 'success');
      onSuccess();
      onClose();
    } catch (e: unknown) {
      toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`💰 Ajuste de Saldo — ${user.username}`} width={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ color: '#6b7a99', fontSize: '0.9rem' }}>
          Saldo actual: <span style={{ color: '#22c55e', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>{formatCOP(user.balanceCents)}</span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {(['deposit', 'withdrawal'] as const).map((t) => (
            <button key={t} onClick={() => setType(t)} style={{
              flex: 1, padding: '8px', borderRadius: 8, border: 'none',
              background: type === t ? (t === 'deposit' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)') : 'rgba(255,255,255,0.04)',
              color: type === t ? (t === 'deposit' ? '#22c55e' : '#ef4444') : '#6b7a99',
              fontWeight: 700, cursor: 'pointer',
            }}>
              {t === 'deposit' ? '↑ Depósito' : '↓ Retiro'}
            </button>
          ))}
        </div>

        <input type="number" inputMode="numeric" placeholder="Monto en COP (ej: 50000)" value={amount} onChange={(e) => setAmount(e.target.value)} min="1" step="100"
          style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, color: '#e8ecf4', fontFamily: 'JetBrains Mono, monospace', outline: 'none' }}
        />

        <input placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)}
          style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, color: '#e8ecf4', fontFamily: 'Outfit, sans-serif', outline: 'none' }}
        />

        <button onClick={submit} disabled={loading} style={{
          padding: '12px', borderRadius: 10, border: 'none',
          background: type === 'deposit' ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'linear-gradient(135deg, #ef4444, #7f1d1d)',
          color: '#fff', fontWeight: 700, cursor: loading ? 'wait' : 'pointer', fontSize: '0.95rem',
          opacity: loading ? 0.7 : 1,
        }}>
          {loading
            ? '⏳ Procesando…'
            : `${type === 'deposit' ? 'Depositar' : 'Retirar'} ${formatCOP(pesosToCents(parseFloat(amount) || 0))}`}
        </button>
      </div>
    </Modal>
  );
}

// ─── Rounds Tab ────────────────────────────────────────────────────────────────

function RoundsTab({ token }: { token: string }) {
  const [rounds, setRounds]   = useState<RoundRow[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<null | { valid: boolean; computedMultiplier: number }>(null);

  useEffect(() => {
    adminFetch(`/rounds?page=${page}&limit=20`, token)
      .then((d) => { setRounds(d.data); setTotal(d.total); })
      .catch((e) => toast(e.message, 'error'));
  }, [token, page]);

  async function verifyRound(roundId: string) {
    setVerifyId(roundId); setVerifyResult(null);
    try {
      const res = await adminFetch(`/rounds/${roundId}/verify`, token, { method: 'POST' });
      setVerifyResult(res);
    } catch (e: unknown) { toast((e as Error).message, 'error'); setVerifyId(null); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ color: '#6b7a99', fontSize: '0.85rem' }}>{total} rondas totales</div>
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              {['#', 'Crash', 'Jugadores', 'Apostado', 'Estado', 'Seed Hash', 'Verificar'].map((h) => (
                <th key={h} style={{ padding: '12px 14px', textAlign: 'left', color: '#6b7a99', fontSize: '0.73rem', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rounds.map((r, i) => (
              <tr key={r._id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                <td style={{ padding: '9px 14px', color: '#6b7a99', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem' }}>#{r.roundNumber}</td>
                <td style={{ padding: '9px 14px' }}><CrashBadge value={r.crashMultiplier} /></td>
                <td style={{ padding: '9px 14px', color: '#e8ecf4', fontSize: '0.85rem' }}>{r.playerCount}</td>
                <td style={{ padding: '9px 14px', fontFamily: 'JetBrains Mono, monospace', color: '#22c55e', fontSize: '0.85rem' }}>{formatCOP(r.totalBetsCents)}</td>
                <td style={{ padding: '9px 14px' }}>
                  <span style={{ fontSize: '0.75rem', color: r.status === 'crashed' ? '#ef4444' : '#f59e0b', fontWeight: 700 }}>{r.status}</span>
                </td>
                <td style={{ padding: '9px 14px' }}>
                  <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: '#6b7a99' }}>
                    {r.serverSeedHash?.slice(0, 14)}…
                  </code>
                </td>
                <td style={{ padding: '9px 14px' }}>
                  {r.status === 'crashed' ? (
                    <button onClick={() => verifyRound(r._id)} style={btnSmall(verifyId === r._id && verifyResult?.valid ? '#22c55e' : '#3b82f6')}>
                      {verifyId === r._id && verifyResult ? (verifyResult.valid ? '✓ OK' : '✕ FAIL') : '🔐 Verificar'}
                    </button>
                  ) : <span style={{ color: '#3b3b3b', fontSize: '0.75rem' }}>—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        {page > 1 && <button onClick={() => setPage(page - 1)} style={btnSmall('#6b7a99')}>← Anterior</button>}
        <span style={{ color: '#6b7a99', fontSize: '0.85rem', padding: '6px 12px' }}>Página {page}</span>
        {rounds.length === 20 && <button onClick={() => setPage(page + 1)} style={btnSmall('#6b7a99')}>Siguiente →</button>}
      </div>
    </div>
  );
}

// ─── Loading ──────────────────────────────────────────────────────────────────

function Loading() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
      <div style={{ color: '#6b7a99', fontSize: '0.9rem', animation: 'pulse 1.5s infinite' }}>
        Cargando datos…
      </div>
    </div>
  );
}
