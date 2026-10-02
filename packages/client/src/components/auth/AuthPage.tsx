/**
 * @file components/auth/AuthPage.tsx
 * @description Login and Register pages with JWT flow.
 */

import React, { useState } from 'react';
import { useGameStore }    from '../../store/gameStore';
import { toast }           from '../ui';

type AuthMode = 'login' | 'register';

interface AuthPageProps {
  onAuthSuccess: () => void;
}

export function AuthPage({ onAuthSuccess }: AuthPageProps) {
  const [mode, setMode]         = useState<AuthMode>('login');
  const [email, setEmail]       = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [errors, setErrors]     = useState<Record<string, string>>({});

  const setAuth    = useGameStore((s) => s.setAuth);
  const setBalance = useGameStore((s) => s.setBalance);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setLoading(true);

    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body     = mode === 'login'
        ? { email, password }
        : { email, username, password };

      const res  = await fetch(endpoint, {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.fields) setErrors(data.fields);
        else toast(data.error ?? 'Error desconocido', 'error');
        return;
      }

      setAuth(data.accessToken, data.user.id, data.user.username);
      setBalance(data.user.balanceCents);
      toast(`¡Bienvenido, ${data.user.username}!`, 'success');
      onAuthSuccess();

    } catch {
      toast('Error de conexión. Intenta de nuevo.', 'error');
    } finally {
      setLoading(false);
    }
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '0.75rem 1rem',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12, color: '#e8ecf4',
    fontFamily: 'Outfit, sans-serif', fontSize: '0.95rem', outline: 'none',
    transition: 'border-color 0.2s',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 5000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at center, rgba(40,0,0,0.8) 0%, rgba(0,2,8,1) 70%)',
      animation: 'fadeIn 0.4s ease',
    }}>
      {/* Glowing orb background */}
      <div style={{
        position: 'absolute', width: 500, height: 500, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(255,51,51,0.06) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      <div style={{
        width: '100%', maxWidth: 420,
        background: 'rgba(6,10,20,0.95)',
        backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 24, padding: '36px 32px',
        boxShadow: '0 32px 80px rgba(0,0,0,0.8), 0 0 60px rgba(255,51,51,0.04)',
        animation: 'slideUp 0.4s ease',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            fontSize: '2.5rem', fontWeight: 900,
            background: 'linear-gradient(135deg, #ff3333 0%, #ff6600 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            letterSpacing: '0.05em', marginBottom: 4,
          }}>
            ☣ ZOMBIERUN
          </div>
          <div style={{ color: '#6b7a99', fontSize: '0.85rem' }}>
            {mode === 'login' ? 'Inicia sesión para sobrevivir' : 'Crea tu cuenta de superviviente'}
          </div>
        </div>

        {/* Mode toggle */}
        <div style={{
          display: 'flex', gap: 0, marginBottom: 24,
          background: 'rgba(255,255,255,0.04)',
          borderRadius: 12, padding: 4,
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          {(['login', 'register'] as AuthMode[]).map((m) => (
            <button key={m} onClick={() => { setMode(m); setErrors({}); }} style={{
              flex: 1, padding: '8px 0',
              background: mode === m ? 'rgba(255,255,255,0.1)' : 'transparent',
              border: 'none', borderRadius: 9, color: mode === m ? '#e8ecf4' : '#6b7a99',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.9rem',
              cursor: 'pointer', transition: 'all 0.2s',
            }}>
              {m === 'login' ? 'Iniciar Sesión' : 'Registrarse'}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {mode === 'register' && (
            <div>
              <input
                placeholder="Nombre de usuario"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                style={{ ...inputStyle, borderColor: errors['username'] ? '#ef4444' : 'rgba(255,255,255,0.12)' }}
              />
              {errors['username'] && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: 4 }}>{errors['username']}</div>}
            </div>
          )}

          <div>
            <input
              type="email"
              placeholder="Correo electrónico"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              style={{ ...inputStyle, borderColor: errors['email'] ? '#ef4444' : 'rgba(255,255,255,0.12)' }}
            />
            {errors['email'] && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: 4 }}>{errors['email']}</div>}
          </div>

          <div>
            <input
              type="password"
              placeholder="Contraseña"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              style={{ ...inputStyle, borderColor: errors['password'] ? '#ef4444' : 'rgba(255,255,255,0.12)' }}
            />
            {errors['password'] && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: 4 }}>{errors['password']}</div>}
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 4, padding: '14px',
              background: 'linear-gradient(135deg, #ff3333 0%, #ff6600 100%)',
              border: 'none', borderRadius: 12, color: '#fff',
              fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '1rem',
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.6 : 1,
              boxShadow: '0 0 24px rgba(255,51,51,0.4)',
              transition: 'all 0.2s', letterSpacing: '0.05em',
            }}
          >
            {loading ? '⏳ Procesando…' : mode === 'login' ? '🚀 Entrar al Juego' : '🎯 Crear Cuenta'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 20, color: '#6b7a99', fontSize: '0.75rem' }}>
          Juega de forma responsable. Mayores de 18 años.
        </div>
      </div>
    </div>
  );
}
