/**
 * @file components/ui/index.tsx
 * @description Shared primitive UI components used across the application.
 */

import React, { useEffect, useState } from 'react';

// ─── Toast Notification ───────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id:      string;
  type:    ToastType;
  message: string;
}

let addToastFn: ((t: Omit<Toast, 'id'>) => void) | null = null;

export function toast(message: string, type: ToastType = 'info') {
  addToastFn?.({ message, type });
}

const toastColors: Record<ToastType, string> = {
  success: '#22c55e',
  error:   '#ef4444',
  warning: '#f59e0b',
  info:    '#3b82f6',
};

const toastIcons: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  warning: '⚠',
  info:    'ℹ',
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    addToastFn = (t) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { ...t, id }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
      }, 3500);
    };
    return () => { addToastFn = null; };
  }, []);

  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 9000,
      display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'none',
    }}>
      {toasts.map((t) => (
        <div key={t.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(8,12,24,0.96)',
          border: `1px solid ${toastColors[t.type]}40`,
          borderLeft: `3px solid ${toastColors[t.type]}`,
          borderRadius: 10,
          padding: '10px 16px',
          color: '#e8ecf4',
          fontSize: '0.875rem',
          fontFamily: 'Outfit, sans-serif',
          fontWeight: 500,
          boxShadow: `0 8px 24px rgba(0,0,0,0.6), 0 0 12px ${toastColors[t.type]}20`,
          animation: 'slideUp 0.3s ease forwards',
          minWidth: 240, maxWidth: 360,
          pointerEvents: 'none',
        }}>
          <span style={{ color: toastColors[t.type], fontSize: '1rem', fontWeight: 700 }}>
            {toastIcons[t.type]}
          </span>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

interface ModalProps {
  isOpen:   boolean;
  onClose:  () => void;
  title:    string;
  children: React.ReactNode;
  width?:   number | string;
}

export function Modal({ isOpen, onClose, title, children, width = 520 }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 8000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(4px)',
      animation: 'fadeIn 0.2s ease',
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'rgba(8,12,24,0.98)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 20,
        padding: '28px 32px',
        width, maxWidth: 'calc(100vw - 32px)',
        maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
        animation: 'slideUp 0.3s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e8ecf4' }}>{title}</h2>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.08)', border: 'none', color: '#999',
            width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
            fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.2s',
          }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

export function Spinner({ size = 24, color = '#ff3333' }: { size?: number; color?: string }) {
  return (
    <div style={{
      width: size, height: size,
      border: `2px solid rgba(255,255,255,0.1)`,
      borderTop: `2px solid ${color}`,
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
    }} />
  );
}

// ─── Input Field ──────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?:  string;
  error?:  string;
  suffix?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, suffix, style, ...props }, ref) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label && (
        <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#6b7a99', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {label}
        </label>
      )}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          ref={ref}
          style={{
            width: '100%',
            padding: suffix ? '0.65rem 2.8rem 0.65rem 0.875rem' : '0.65rem 0.875rem',
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${error ? '#ef4444' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 10,
            color: '#e8ecf4',
            fontFamily: 'Outfit, sans-serif',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color 0.2s',
            ...style,
          }}
          onFocus={(e) => { e.target.style.borderColor = 'rgba(255,51,51,0.5)'; }}
          onBlur={(e) => { e.target.style.borderColor = error ? '#ef4444' : 'rgba(255,255,255,0.1)'; }}
          {...props}
        />
        {suffix && (
          <span style={{ position: 'absolute', right: 12, color: '#6b7a99', fontSize: '0.85rem', pointerEvents: 'none' }}>
            {suffix}
          </span>
        )}
      </div>
      {error && <span style={{ fontSize: '0.78rem', color: '#ef4444' }}>{error}</span>}
    </div>
  )
);
Input.displayName = 'Input';

// ─── Badge ────────────────────────────────────────────────────────────────────

export function CrashBadge({ value }: { value: number }) {
  const tier = value >= 10 ? 'moon' : value >= 3 ? 'high' : value >= 2 ? 'mid' : 'low';
  const colors = {
    low:  { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
    mid:  { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' },
    high: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
    moon: { bg: 'rgba(251,191,36,0.2)',  text: '#fbbf24' },
  };
  const c = colors[tier];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 4,
      background: c.bg, color: c.text,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '0.78rem', fontWeight: 700,
      boxShadow: tier === 'moon' ? `0 0 8px ${c.text}40` : 'none',
    }}>
      {value.toFixed(2)}×
    </span>
  );
}
