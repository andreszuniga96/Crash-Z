/**
 * @file App.tsx
 * @description Root application.
 *
 * State machine:
 *   'auth'  → AuthPage (no session)
 *   'game'  → Three.js canvas + GameOverlay + optional AdminPanel
 *
 * NOTE ON THE TOP BAR
 * ───────────────────
 * The user controls (name / admin / logout) used to live here as a second
 * absolutely-positioned bar pinned to the same corner as GameOverlay's own top
 * bar — which is why the two rows of controls rendered on top of each other.
 * They now live in GameOverlay's single header, and this component only owns
 * the canvas, the view switch, and the admin panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ZombieRunEngine }  from './game/ZombieRunEngine';
import { useGameStore }     from './store/gameStore';
import { useGameSocket }    from './socket/useGameSocket';
import { AuthPage }         from './components/auth/AuthPage';
import { GameOverlay }      from './components/game/GameOverlay';
import { AdminPanel }       from './components/admin/AdminPanel';
import { WinCelebration }   from './components/game/WinCelebration';
import { ToastContainer }   from './components/ui';

type AppView = 'auth' | 'game';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ZombieRunEngine | null>(null);

  const [view, setView]               = useState<AppView>('auth');
  const [engineReady, setEngineReady] = useState(false);
  const [showAdmin, setShowAdmin]     = useState(false);
  const [isAdmin, setIsAdmin]         = useState(false);

  const setPerf     = useGameStore((s) => s.setPerf);
  const username    = useGameStore((s) => s.username);

  // Wire socket to store and engine (only active when authenticated)
  const { placeBet, cashOut } = useGameSocket(engineRef);

  /**
   * Loads the profile behind a token. The role is only exposed by /api/auth/me
   * (the login response is not trusted for authorisation), so this is the one
   * place that decides whether the admin button appears.
   */
  const loadProfile = useCallback(async (token: string) => {
    if (!token) return;
    try {
      const res = await fetch('/api/auth/me', {
        headers:     { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) return;

      const me = await res.json();
      useGameStore.getState().setBalance(me.balanceCents);
      setIsAdmin(me.role === 'admin');
    } catch {
      /* profile is non-critical — leave the UI in its signed-in default */
    }
  }, []);

  // ── Three.js engine lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new ZombieRunEngine(canvas, {
      onReady:     () => setEngineReady(true),
      onError:     (err) => console.error('[Engine]', err),
      onFpsUpdate: (fps, pr) => setPerf(fps, pr),
    });

    // Re-sync once the renderer exists: the ResizeObserver fires before the
    // async init resolves and is therefore ignored by the ready-guard.
    engine.init().then(() => engine.syncSize()).catch(console.error);
    engineRef.current = engine;

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      engine.handleResize(rect.width, rect.height);
    });
    ro.observe(canvas);

    // Belt-and-braces: some mobile browsers fire orientationchange without a
    // corresponding ResizeObserver entry, and the visual viewport can change
    // height when the URL bar collapses. Re-syncing from the element's own
    // measured size is idempotent, so calling it twice costs nothing.
    const onWindowResize = () => engine.syncSize();
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('orientationchange', onWindowResize);

    return () => {
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('orientationchange', onWindowResize);
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
  }, [setPerf]);

  // ── Restore session on mount (refresh cookie may still be valid) ───────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method:      'POST',
          credentials: 'include',
        });
        if (!res.ok || cancelled) return;

        const data = await res.json();
        const me   = await fetch('/api/auth/me', {
          headers:     { Authorization: `Bearer ${data.accessToken}` },
          credentials: 'include',
        }).then((r) => (r.ok ? r.json() : null));

        if (!me || cancelled) return;

        useGameStore.getState().setAuth(data.accessToken, me.id, me.username);
        useGameStore.getState().setBalance(me.balanceCents);
        setIsAdmin(me.role === 'admin');
        setView('game');
      } catch {
        /* no existing session — stay on auth */
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const handleAuthSuccess = useCallback(() => {
    setView('game');
    void loadProfile(useGameStore.getState().accessToken);
  }, [loadProfile]);

  const handleLogout = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    useGameStore.getState().setAuth('', '', '');
    useGameStore.getState().setBalance(0);
    useGameStore.getState().setActiveBet(null);
    setIsAdmin(false);
    setShowAdmin(false);
    setView('auth');
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Three.js canvas — always mounted so the renderer survives auth changes */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
      />

      {view === 'auth' && <AuthPage onAuthSuccess={handleAuthSuccess} />}

      {view === 'game' && engineReady && (
        <GameOverlay
          onPlaceBet={placeBet}
          onCashOut={cashOut}
          username={username}
          isAdmin={isAdmin}
          onOpenAdmin={() => setShowAdmin(true)}
          onLogout={handleLogout}
        />
      )}

      {view === 'game' && !engineReady && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="animate-breathe font-mono text-sm text-muted">
            Iniciando motor 3D…
          </div>
        </div>
      )}

      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}

      <WinCelebration />
      <ToastContainer />
    </div>
  );
}
