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
 * Routing model (Overhaul P1.1/P1.2 — namespaced paths):
 *   - `/login` is the only public route. `<RequireAuth/>` gates everything
 *     else and pushes guests to `/login`.
 *   - Primary tabs: `/` (Today), `/progress`, `/review` (library index),
 *     `/settings`. LEARN sub-pages live under `/learn/*`; the library's
 *     sub-pages live under `/review/*` (mistakes, vocab, dictionary,
 *     grammar — P1.2 dissolved the old Reference page into the latter
 *     three; decisions D2/D3).
 *   - `/chat` NEVER moves — hard contract (AskAboutThisButton.CHAT_PATH).
 *   - Legacy paths (`/topik`, `/ttmik`, `/grammar`, `/reference?tab=`, …)
 *     render redirect shims from `lib/redirects.tsx` so old links keep
 *     landing.
 *   - Each in-app screen renders its real body; routes are registered here
 *     and the nav model lives in `lib/nav.ts` (kept in sync with these paths).
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
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt';
import { Shell } from './components/Shell';
import { legacyRedirectRoutes } from './lib/redirects';
import Login from './pages/Login';
import Today from './pages/Today';
import Topik from './pages/Topik';
import Review from './pages/Review';
import ReviewLibrary from './pages/ReviewLibrary';
import ReviewVocab from './pages/review/ReviewVocab';
import ReviewDictionary from './pages/review/ReviewDictionary';
import ReviewGrammar from './pages/review/ReviewGrammar';
import Reading from './pages/Reading';
import Diagnostic from './pages/Diagnostic';
import Grammar from './pages/Grammar';
import Writing from './pages/Writing';
import Hanja from './pages/Hanja';
import Mistakes from './pages/Mistakes';
import Images from './pages/Images';
import Chat from './pages/Chat';
import Settings from './pages/Settings';
import Progress from './pages/Progress';
import Ttmik from './pages/Ttmik';
import Uploads from './pages/Uploads';
import UploadViewer from './pages/UploadViewer';

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
                    {/* Primary tabs. */}
                    <Route index element={<Today />} />
                    <Route path="progress" element={<Progress />} />
                    {/* `/review` is the LIBRARY index — the FSRS flashcards
                        that used to live here are now `/learn/vocab`. The
                        library sub-pages below re-home the dissolved
                        Reference tabs (P1.2, D2/D3). */}
                    <Route path="review" element={<ReviewLibrary />} />
                    <Route path="review/mistakes" element={<Mistakes />} />
                    <Route path="review/vocab" element={<ReviewVocab />} />
                    <Route
                      path="review/dictionary"
                      element={<ReviewDictionary />}
                    />
                    <Route
                      path="review/grammar"
                      element={<ReviewGrammar />}
                    />
                    <Route path="settings" element={<Settings />} />
                    {/* LEARN sub-pages (hexagon launcher). Pure re-homes,
                        except Reading — a new placeholder until P6. */}
                    <Route path="learn/topik" element={<Topik />} />
                    <Route path="learn/listen" element={<Ttmik />} />
                    <Route path="learn/vocab" element={<Review />} />
                    <Route path="learn/grammar" element={<Grammar />} />
                    <Route path="learn/writing" element={<Writing />} />
                    <Route path="learn/hanja" element={<Hanja />} />
                    <Route path="learn/reading" element={<Reading />} />
                    {/* Secondary routed screens. `/chat` never moves. */}
                    <Route path="diagnostic" element={<Diagnostic />} />
                    <Route path="images" element={<Images />} />
                    <Route path="chat" element={<Chat />} />
                    {/* U1b — PDF book-upload feature. `/uploads` is BOTH a
                        client route (this list) AND an API prefix
                        (`GET /uploads`, `POST /uploads`, …); the nginx
                        Accept-header split routes browser navigation here to
                        the SPA while the page's own XHR/fetch calls hit the
                        server — no redirect needed (see
                        [[km-nginx-api-route-allowlist]]). `/uploads/:id` is
                        the view-only PDF viewer; it isn't its own NavItem
                        (dynamic detail view, same convention as Images'
                        capture view). */}
                    <Route path="uploads" element={<Uploads />} />
                    <Route path="uploads/:id" element={<UploadViewer />} />
                    {/* Legacy paths → new namespaced homes (includes the
                        tab-aware /reference shim — the page is retired). */}
                    {legacyRedirectRoutes()}
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
            {/* Surfaces a "new version — reload" banner when a freshly-deployed
                service worker is waiting (registerType: 'prompt'). Renders null
                until then, so the mount is free. */}
            <PwaUpdatePrompt />
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
