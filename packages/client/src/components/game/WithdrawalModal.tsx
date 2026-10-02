/**
 * @file components/game/WithdrawalModal.tsx
 * @description Player withdrawal request modal with daily limit tracking.
 */

import React, { useState, useEffect } from "react";
import { Modal, toast }      from "../ui";
import { formatCOP }         from "../../lib/currency";
import { useGameStore }      from "../../store/gameStore";

export const MAX_DAILY_WITHDRAWAL_CENTS = 5_000_000;

interface DailyLimits {
  deposited:  { usedCents: number; maxCents: number; remainingCents: number };
  withdrawn:  { usedCents: number; maxCents: number; remainingCents: number };
  balanceCents: number;
}

interface WithdrawalModalProps {
  onClose: () => void;
}

type Method = "nequi" | "daviplata" | "llave";

const METHODS: Record<Method, { label: string; emoji: string; color: string }> = {
  nequi:     { label: "Nequi",     emoji: "💜", color: "#6C0BA9" },
  daviplata: { label: "Daviplata", emoji: "🔴", color: "#E10600" },
  llave:     { label: "Llave",     emoji: "🟡", color: "#F6A800" },
};

export function WithdrawalModal({ onClose }: WithdrawalModalProps) {
  const accessToken   = useGameStore((s) => s.accessToken);
  const setBalance    = useGameStore((s) => s.setBalance);
  const balanceCents  = useGameStore((s) => s.balanceCents);

  const [limits, setLimits]         = useState<DailyLimits | null>(null);
  const [method, setMethod]         = useState<Method>("nequi");
  const [accountNumber, setAccount] = useState("");
  const [amountPesos, setAmount]    = useState("");
  const [loading, setLoading]       = useState(false);
  const [done, setDone]             = useState(false);

  useEffect(() => {
    fetch("/api/game/daily-limits", {
      headers: { Authorization: "Bearer " + accessToken },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d && setLimits(d))
      .catch(() => {});
  }, [accessToken]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = Math.round(parseFloat(amountPesos || "0") * 100);
    if (amountCents <= 0) { toast("Ingresa un monto válido", "warning"); return; }
    if (amountCents > balanceCents) { toast("Saldo insuficiente", "warning"); return; }
    if (accountNumber.replace(/\D/g,"").length < 7) { toast("Número de cuenta inválido", "warning"); return; }

    setLoading(true);
    try {
      const res = await fetch("/api/game/withdraw-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ amountCents, method, accountNumber }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error ?? "Error al solicitar retiro", "error"); return; }
      setBalance(data.newBalanceCents);
      setDone(true);
      toast("Retiro de " + formatCOP(amountCents) + " solicitado ✓", "success");
    } catch {
      toast("Error de conexión", "error");
    } finally {
      setLoading(false);
    }
  }

  const maxAllowed = limits
    ? Math.min(balanceCents, limits.withdrawn.remainingCents)
    : balanceCents;

  return (
    <Modal isOpen onClose={onClose} title="💸 Solicitar Retiro" width={480}>
      {done ? (
        <div style={{ textAlign: "center", padding: "24px 0" }}>
          <div style={{ fontSize: "3rem", marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>
            ¡Solicitud enviada!
          </div>
          <div style={{ color: "#6b7a99", fontSize: "0.85rem", marginBottom: 20 }}>
            Recibirás el dinero en tu {METHODS[method].label} en 15-30 minutos.
          </div>
          <button onClick={onClose} style={{ padding: "10px 28px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10, color: "#e8ecf4", fontFamily: "Outfit, sans-serif", fontWeight: 700, cursor: "pointer", fontSize: "0.9rem" }}>Cerrar</button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>

          {limits && (
            <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: "12px 16px", fontSize: "0.82rem", lineHeight: 1.8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: "#6b7a99" }}>Retirado hoy</span>
                <span style={{ color: "#e8ecf4", fontWeight: 700 }}>{formatCOP(limits.withdrawn.usedCents)} / {formatCOP(MAX_DAILY_WITHDRAWAL_CENTS)}</span>
              </div>
              <div style={{ height: 6, borderRadius: 99, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: Math.min(100, (limits.withdrawn.usedCents / MAX_DAILY_WITHDRAWAL_CENTS) * 100) + "%", background: "linear-gradient(90deg, #22c55e, #16a34a)", borderRadius: 99 }} />
              </div>
              <div style={{ color: "#6b7a99", marginTop: 6 }}>
                Disponible: <strong style={{ color: "#22c55e" }}>{formatCOP(limits.withdrawn.remainingCents)}</strong>
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7a99", marginBottom: 8 }}>
              Recibir en
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {(Object.entries(METHODS) as [Method, typeof METHODS[Method]][]).map(([key, val]) => (
                <button type="button" key={key} onClick={() => setMethod(key)} style={{ padding: "10px 0", borderRadius: 12, border: method === key ? "2px solid " + val.color : "2px solid rgba(255,255,255,0.1)", background: method === key ? val.color + "20" : "rgba(255,255,255,0.04)", color: method === key ? "#e8ecf4" : "#6b7a99", fontFamily: "Outfit, sans-serif", fontWeight: 700, fontSize: "0.88rem", cursor: "pointer", transition: "all 0.2s", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: "1.4rem" }}>{val.emoji}</span>
                  {val.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7a99" }}>
              Número de {METHODS[method].label}
            </label>
            <input type="tel" placeholder="Ej: 310 000 0000" value={accountNumber} onChange={(e) => setAccount(e.target.value)} style={{ padding: "0.7rem 1rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, color: "#e8ecf4", fontFamily: "Outfit, sans-serif", fontSize: "1rem", outline: "none", width: "100%", boxSizing: "border-box" }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7a99" }}>
              Monto a retirar (COP)
            </label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#6b7a99", fontSize: "1rem" }}>$</span>
              <input type="number" inputMode="numeric" placeholder={"Máx. " + formatCOP(maxAllowed)} value={amountPesos} onChange={(e) => setAmount(e.target.value)} min={100} max={maxAllowed / 100} style={{ width: "100%", padding: "0.7rem 3rem 0.7rem 1.8rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, color: "#e8ecf4", fontFamily: "JetBrains Mono, monospace", fontSize: "1rem", outline: "none", boxSizing: "border-box" }} />
              <button type="button" onClick={() => setAmount(String(maxAllowed / 100))} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", padding: "3px 8px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#6b7a99", fontFamily: "Outfit, sans-serif", fontWeight: 700, fontSize: "0.7rem", cursor: "pointer" }}>MÁX</button>
            </div>
          </div>

          <button type="submit" disabled={loading || maxAllowed <= 0} style={{ padding: "14px", background: maxAllowed <= 0 ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)", border: "none", borderRadius: 12, color: "#fff", fontFamily: "Outfit, sans-serif", fontWeight: 800, fontSize: "1rem", cursor: loading || maxAllowed <= 0 ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1, boxShadow: maxAllowed > 0 ? "0 0 24px rgba(34,197,94,0.3)" : "none", transition: "all 0.2s" }}>
            {loading ? "⏳ Procesando…" : maxAllowed <= 0 ? "🚫 Límite diario alcanzado" : "💸 Solicitar Retiro"}
          </button>

          <p style={{ fontSize: "0.72rem", color: "#6b7a99", textAlign: "center", lineHeight: 1.6 }}>
            Límite diario: <strong style={{ color: "#e8ecf4" }}>{formatCOP(MAX_DAILY_WITHDRAWAL_CENTS)}</strong> &middot; Tiempo estimado: 15-30 min
          </p>
        </form>
      )}
    </Modal>
  );
}
