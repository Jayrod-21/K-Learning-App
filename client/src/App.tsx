/**
 * App root.
 *
 * Composition:
 *   <ErrorBoundary>
 *     <ThemeProvider>
 *       <AuthProvider>
 *         <BrowserRouter>
 *           <Routes>...
 *
 * Routing model:
 *   - `/login` is the only public route. `<RequireAuth/>` gates everything
 *     else and pushes guests to `/login`.
 *   - The 11 in-app screens render as `<ScreenStub/>` placeholders during
 *     Pass 1; the next pass replaces each with the real body.
 *   - Unknown paths redirect to `/`. We could 404 instead, but a soft
 *     redirect is friendlier for a single-user app where typos are typos.
 */
import { useEffect, type JSX, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { AuthProvider } from './hooks/AuthProvider';
import { useAuth } from './hooks/useAuth';
import { ThemeProvider } from './hooks/ThemeProvider';
import { SettingsProvider } from './hooks/SettingsProvider';
import { ToastProvider } from './components/ToastProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { InstallPrompt } from './components/InstallPrompt';
import { Shell } from './components/Shell';
import Login from './pages/Login';
import Today from './pages/Today';
import Topik from './pages/Topik';
import Reading from './pages/Reading';
import Review from './pages/Review';
import Diagnostic from './pages/Diagnostic';
import Grammar from './pages/Grammar';
import Writing from './pages/Writing';
import Hanja from './pages/Hanja';
import Images from './pages/Images';
import Chat from './pages/Chat';
import Reference from './pages/Reference';
import Settings from './pages/Settings';

export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <SettingsProvider>
          {/* PF-A: ToastProvider wraps the app so every screen can surface a
              transient hanji toast. Placed inside SettingsProvider (so toasts
              inherit the palette tokens) and outside the router (so a toast
              survives navigation). PF-B parent: reconcile this with the
              InstallPrompt mount — both live at App root; nesting order here
              is intentional (Toast available to InstallPrompt if it opts in). */}
          <ToastProvider>
            <BrowserRouter>
              <AuthProvider>
                <Routes>
                  <Route
                    path="/login"
                    element={
                      <PublicOnly>
                        <Login />
                      </PublicOnly>
                    }
                  />
                  <Route
                    element={
                      <RequireAuth>
                        <Shell />
                      </RequireAuth>
                    }
                  >
                    <Route index element={<Today />} />
                    <Route path="topik" element={<Topik />} />
                    <Route path="reading" element={<Reading />} />
                    <Route path="review" element={<Review />} />
                    <Route path="diagnostic" element={<Diagnostic />} />
                    <Route path="grammar" element={<Grammar />} />
                    <Route path="writing" element={<Writing />} />
                    <Route path="hanja" element={<Hanja />} />
                    <Route path="images" element={<Images />} />
                    <Route path="chat" element={<Chat />} />
                    <Route path="reference" element={<Reference />} />
                    <Route path="settings" element={<Settings />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </AuthProvider>
            </BrowserRouter>
            {/* PF-B: PWA install banner. Mounted at App root as a sibling of the
                router (it needs no routing context) and INSIDE ToastProvider so
                it inherits the palette tokens and could surface a toast later.
                Renders null unless the browser offers an install opportunity,
                so the mount is effectively free. */}
            <InstallPrompt />
          </ToastProvider>
        </SettingsProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

/**
 * Block access until auth has resolved. While loading, render the same
 * statusbar-only skeleton the Shell shows so the page doesn't flash blank.
 */
function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <BootSkeleton />;
  if (status === 'guest') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/**
 * Redirect already-authenticated users away from the public auth page.
 * Honours a `from` value left behind by `RequireAuth` so a deep link
 * survives the round trip through /login.
 */
function PublicOnly({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (status !== 'authenticated') return;
    const state = location.state as { from?: string } | null;
    const target = typeof state?.from === 'string' ? state.from : '/';
    navigate(target, { replace: true });
  }, [status, navigate, location.state]);

  if (status === 'loading') return <BootSkeleton />;
  // Already-authenticated users get the skeleton instead of the login form
  // while the redirect effect above schedules `navigate(target)`. Without
  // this, there would be a one-frame flash of the Login screen before the
  // navigation lands. Looks like a bug, is actually the fix.
  if (status === 'authenticated') return <BootSkeleton />;
  return <>{children}</>;
}

function BootSkeleton(): JSX.Element {
  return (
    <div className="km-shell" aria-busy="true" aria-live="polite">
      <div className="km-shell__statusbar" aria-hidden="true" />
      <div className="km-shell__scroll km-stub">
        <div className="km-eyebrow">한국어 마스터</div>
        <h1 className="kr-display km-stub__title">로딩 중…</h1>
      </div>
    </div>
  );
}
