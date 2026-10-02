/**
 * @file components/game/WinCelebration.tsx
 * @description Full-screen win celebration overlay with animated particles.
 *
 * Displays for WIN_DISPLAY_MS after the cashout is confirmed, then fades away
 * automatically. The player can also tap anywhere to dismiss it early.
 */

import { useEffect, useState, useRef } from 'react';
import { useGameStore } from '../../store/gameStore';
import { formatCOP }    from '../../lib/currency';

const WIN_DISPLAY_MS  = 3500;
const PARTICLE_COUNT  = 22;

interface Particle {
  id:    number;
  x:     number;
  delay: number;
  size:  number;
  color: string;
  dur:   number;
}

const COLORS = [
  '#fbbf24', '#22c55e', '#ff6a1f', '#38bdf8', '#f472b6', '#a78bfa',
];

function makeParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    id:    i,
    x:     10 + Math.random() * 80,
    delay: Math.random() * 600,
    size:  6 + Math.random() * 10,
    color: COLORS[i % COLORS.length],
    dur:   1200 + Math.random() * 800,
  }));
}

export function WinCelebration() {
  const lastWin    = useGameStore((s) => s.lastWin);
  const setLastWin = useGameStore((s) => s.setLastWin);

  const [particles]               = useState<Particle[]>(makeParticles);
  const [timerPct, setTimerPct]   = useState(100);
  const startRef = useRef<number>(0);
  const rafRef   = useRef<number>(0);

  useEffect(() => {
    if (!lastWin) return;

    setTimerPct(100);
    startRef.current = Date.now();

    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      const pct     = Math.max(0, 100 - (elapsed / WIN_DISPLAY_MS) * 100);
      setTimerPct(pct);
      if (elapsed < WIN_DISPLAY_MS) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setLastWin(null);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [lastWin?.at]);

  if (!lastWin) return null;

  const isHuge = lastWin.multiplier >= 5;
  const icon   = lastWin.multiplier >= 10 ? '??' : lastWin.multiplier >= 5 ? '??' : '??';

  return (
    <div
      onClick={() => setLastWin(null)}
      className="pointer-events-auto fixed inset-0 z-[7000] flex cursor-pointer flex-col items-center justify-center"
      style={{
        background: 'radial-gradient(ellipse at center, rgba(34,197,94,0.18) 0%, rgba(0,2,8,0.88) 60%)',
        animation:  'fadeIn 0.3s ease',
      }}
    >
      {particles.map((p) => (
        <span
          key={p.id}
          style={{
            position:   'absolute',
            left:       `${p.x}vw`,
            top:        '-12px',
            width:      p.size,
            height:     p.size,
            borderRadius: Math.random() > 0.5 ? '50%' : '2px',
            background: p.color,
            opacity:    0.85,
            animation:  `confettiFall ${p.dur}ms ${p.delay}ms ease-in forwards`,
          }}
        />
      ))}

      <div
        style={{
          background:   'rgba(6,10,20,0.96)',
          border:       '1px solid rgba(34,197,94,0.3)',
          borderRadius: 24,
          padding:      '40px 48px',
          textAlign:    'center',
          boxShadow:    '0 0 80px rgba(34,197,94,0.25), 0 32px 80px rgba(0,0,0,0.8)',
          animation:    'winCardPop 0.4s cubic-bezier(0.175,0.885,0.32,1.275)',
          maxWidth:     420,
          width:        'calc(100vw - 32px)',
        }}
      >
        <div style={{ fontSize: '3.5rem', lineHeight: 1, marginBottom: 8 }}>{icon}</div>

        <div style={{
          fontSize: '0.9rem', fontWeight: 700, letterSpacing: '0.22em',
          textTransform: 'uppercase', color: '#22c55e', marginBottom: 4,
        }}>
          �Retiraste a tiempo!
        </div>

        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize:   isHuge ? '3.8rem' : '3rem',
          fontWeight: 900, lineHeight: 1,
          color:      '#ff6a1f',
          textShadow: '0 0 30px rgba(255,106,31,0.7), 0 0 60px rgba(255,106,31,0.35)',
          marginBottom: 16,
        }}>
          {lastWin.multiplier.toFixed(2)}�
        </div>

        <div style={{
          fontFamily:   'JetBrains Mono, monospace',
          fontSize:     '2.2rem', fontWeight: 900,
          color:        '#22c55e',
          textShadow:   '0 0 24px rgba(34,197,94,0.5)',
          marginBottom: 6,
        }}>
          {formatCOP(lastWin.payoutCents)}
        </div>

        {lastWin.profitCents > 0 && (
          <div style={{
            fontFamily: 'Outfit, sans-serif', fontSize: '0.95rem',
            color: '#86efac', fontWeight: 600, marginBottom: 20,
          }}>
            + {formatCOP(lastWin.profitCents)} de ganancia neta
          </div>
        )}

        <div style={{
          height: 3, borderRadius: 99,
          background: 'rgba(255,255,255,0.08)',
          marginTop: lastWin.profitCents > 0 ? 0 : 20,
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${timerPct}%`,
            background: 'linear-gradient(90deg, #22c55e, #86efac)',
            borderRadius: 99, transition: 'none',
          }} />
        </div>

        <div style={{
          marginTop: 10, fontSize: '0.7rem',
          color: 'rgba(255,255,255,0.3)', fontFamily: 'Outfit, sans-serif',
        }}>
          Toca para cerrar
        </div>
      </div>
    </div>
  );
}

