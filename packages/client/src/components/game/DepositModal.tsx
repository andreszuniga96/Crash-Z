/**
 * @file components/game/DepositModal.tsx
 */

import { useState } from "react";
import { Modal }          from "../ui";
import { formatCOP }      from "../../lib/currency";

export const MAX_DAILY_DEPOSIT_CENTS    = 1_000_000;
export const MAX_DAILY_WITHDRAWAL_CENTS = 5_000_000;

interface DepositModalProps {
  onClose:  () => void;
  username: string;
}

type Method = "nequi" | "daviplata" | "llave";

const METHODS: Record<Method, { label: string; number: string; emoji: string; color: string }> = {
  nequi:     { label: "Nequi",     number: "310 000 0000", emoji: "💜", color: "#6C0BA9" },
  daviplata: { label: "Daviplata", number: "320 000 0000", emoji: "🔴", color: "#E10600" },
  llave:     { label: "Llave",     number: "300 000 0000", emoji: "🟡", color: "#F6A800" },
};

export function DepositModal({ onClose, username }: DepositModalProps) {
  const [method, setMethod] = useState<Method>("nequi");
  const [copied, setCopied] = useState(false);
  const prefix = username.toUpperCase().slice(0, 4);
  const suffix = Date.now().toString(36).slice(-5).toUpperCase();
  const ref = prefix + "-" + suffix;

  function copyRef() {
    navigator.clipboard?.writeText(ref).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const m = METHODS[method];

  return (
    <Modal isOpen onClose={onClose} title="💳 Recargar Saldo" width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

        <div style={{
          background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.25)",
          borderRadius: 12, padding: "12px 16px",
          fontSize: "0.82rem", color: "#fde68a", lineHeight: 1.6,
        }}>
          <strong>📋 Límites diarios</strong><br />
          &middot; Recarga máxima: <strong>{formatCOP(MAX_DAILY_DEPOSIT_CENTS)}/día</strong><br />
          &middot; Retiro máximo: <strong>{formatCOP(MAX_DAILY_WITHDRAWAL_CENTS)}/día</strong><br />
          Montos pensados para que el juego sea accesible para todos.
        </div>

        <div>
          <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7a99", marginBottom: 10 }}>
            Método de pago
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {(Object.entries(METHODS) as [Method, typeof METHODS[Method]][]).map(([key, val]) => (
              <button
                key={key}
                onClick={() => setMethod(key)}
                style={{
                  padding: "10px 0", borderRadius: 12,
                  border: method === key ? "2px solid " + val.color : "2px solid rgba(255,255,255,0.1)",
                  background: method === key ? val.color + "20" : "rgba(255,255,255,0.04)",
                  color: method === key ? "#e8ecf4" : "#6b7a99",
                  fontFamily: "Outfit, sans-serif", fontWeight: 700, fontSize: "0.88rem",
                  cursor: "pointer", transition: "all 0.2s",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                }}
              >
                <span style={{ fontSize: "1.4rem" }}>{val.emoji}</span>
                {val.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{
          background: "rgba(255,255,255,0.04)", borderRadius: 14, padding: "16px 18px",
          display: "flex", flexDirection: "column", gap: 12,
        }}>
          <div style={{ fontSize: "0.82rem", color: "#6b7a99", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Paso a paso
          </div>
          <DepositSteps method={m} />
        </div>

        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "0.72rem", color: "#6b7a99", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Número {m.label}
          </div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "1.5rem", fontWeight: 900, color: "#e8ecf4", letterSpacing: "0.06em" }}>
            {m.number}
          </div>
        </div>

        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "0.72rem", color: "#6b7a99", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Tu referencia (obligatoria)
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
            <code style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "1.1rem", fontWeight: 700, background: "rgba(255,255,255,0.07)", padding: "8px 16px", borderRadius: 10, color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)", letterSpacing: "0.06em" }}>
              {ref}
            </code>
            <button onClick={copyRef} style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)", background: copied ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.07)", color: copied ? "#22c55e" : "#e8ecf4", fontFamily: "Outfit, sans-serif", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer", transition: "all 0.2s" }}>
              {copied ? "✓ Copiado" : "Copiar"}
            </button>
          </div>
        </div>

        <p style={{ fontSize: "0.72rem", color: "#6b7a99", textAlign: "center", lineHeight: 1.6 }}>
          Si no incluyes la referencia, tu recarga puede demorar más tiempo.<br />
          Soporte: soporte@zombierun.co
        </p>
      </div>
    </Modal>
  );
}

function DepositSteps({ method }: { method: { label: string; number: string; color: string } }) {
  const steps = [
    "Abre tu app de " + method.label,
    "Envía el monto deseado (máx. " + formatCOP(MAX_DAILY_DEPOSIT_CENTS) + "/día) al número: " + method.number,
    "Incluye tu referencia en el mensaje/descripción",
    "Espera máx. 15 min. Tu saldo se actualizará automáticamente",
  ];
  return (
    <>
      {steps.map((step, i) => (
        <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0, background: method.color, color: "#fff", fontWeight: 800, fontSize: "0.75rem", display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
          <span style={{ fontSize: "0.85rem", color: "#c4cce4", lineHeight: 1.5 }}>{step}</span>
        </div>
      ))}
    </>
  );
}

