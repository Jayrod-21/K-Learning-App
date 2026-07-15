/**
 * Shell — the layout chrome shared by every authenticated screen.
 *
 * Structure (top to bottom):
 *   1. Status-bar spacer sized to ONLY `env(safe-area-inset-top)` — 0 on
 *      any device/browser with no notch (the header sits flush at the very
 *      top there), and exactly the real inset on notched devices (clears
 *      the notch without adding decorative blank space above it).
 *   2. Scroll area where the routed screen body renders.
 *   3. Sticky BottomNav (4 tabs + the center LEARN hexagon) with the
 *      upward-expanding LearnMenu overlaying it when open (P1.1).
 *   4. ChatFab — the floating chat dot on the right edge (hides itself on
 *      /chat, /settings, during a mock exam, and while the keyboard is up).
 *   5. FeedbackFab (F-127) — the floating "!" feedback button in the
 *      TOP-right corner (hides itself on /tickets — see FeedbackFab.tsx).
 *      Pinned to the opposite corner from ChatFab so the two never collide.
 *
 * `ExamActiveProvider` mounts here so BOTH the writer (MockMode, rendered
 * deep inside the `<Outlet/>`) and the reader (ChatFab, shell chrome) sit
 * under one provider without lifting the flag to App.
 *
 * DEVICE-ADAPTIVE CHROME (device-adaptive epic, Phase D0 — approved
 * Option A nav model): `useDeviceClass()` decides which primary-nav chrome
 * mounts.
 *   - mobile (<768px, unchanged): the sticky `BottomNav` + center LEARN
 *     hexagon, with `LearnMenu` overlaying it when open, exactly as before
 *     this phase.
 *   - tablet/desktop (≥768px): a persistent left `Sidebar` rail instead —
 *     LEARN's 7 sub-pages are flattened into a visible section there, so
 *     there is no launcher to open and `LearnMenu` is simply never
 *     rendered. The LearnMenu open/close phase machine below is left
 *     completely untouched: it costs nothing to keep running when nothing
 *     reads `learnPhase` (no hexagon exists to toggle it, so it just sits
 *     at 'closed' forever on desktop), and NOT touching it is what
 *     guarantees zero behavior change to the existing mobile state
 *     machine — only the render branch below is new.
 *   - A one-time root wrapper (`.km-appframe`) sits above the existing
 *     `.km-shell` column so the `Sidebar` can sit BESIDE it in a row at
 *     ≥768px; the wrapper is `display: contents` (i.e. invisible to layout)
 *     below that, so mobile's rendered box tree is unaffected.
 *
 * LEARN MENU LIFECYCLE — a three-state machine (honeycomb motion polish):
 *
 *     'closed' ──open──▶ 'open' ──close request──▶ 'closing' ──▶ 'closed'
 *                          ▲                          │
 *                          └───────re-open (toggle)───┘
 *
 *   - The menu is MOUNTED while phase !== 'closed'. A close request (Esc,
 *     scrim, tile activation, route change, hexagon re-tap) moves
 *     'open' → 'closing': the menu stays mounted and plays its reverse-
 *     staggered exit cascade while the hexagon un-spins 180° → 0°.
 *   - The REAL unmount happens when LearnMenu reports the last tile's
 *     exit animationend (`onLearnExited`), which is also when
 *     `useModalA11y` (inside LearnMenu) restores focus to the hexagon.
 *   - Safety net: a timeout of LEARN_MENU_EXIT_MS + margin force-closes
 *     if animationend never fires (interrupted animation, display:none
 *     ancestor, engine quirk) — the menu can never wedge mounted-closing.
 *   - prefers-reduced-motion BYPASSES 'closing' entirely (open → closed):
 *     the global CSS zeroes animation durations, and a 0-duration exit may
 *     fire animationend immediately or not at all depending on the engine
 *     — gating the unmount on it would race or hang, so we don't.
 *   - `aria-expanded` on the hexagon reads false from the moment the close
 *     is REQUESTED (phase 'closing') — AT hears the menu as closed while
 *     the purely-visual exit plays out.
 *
 * The menu also closes on ROUTE CHANGE (derive-state-during-render below):
 * tile taps navigate first and the exit cascade plays OVER the incoming
 * page (the menu is an overlay, so this reads as the launcher folding away
 * to reveal the destination); browser back/forward while open gets the
 * same animated close instead of being stranded.
 *
 * Focus restoration to the hexagon after close is owned by `useModalA11y`
 * inside LearnMenu (it captures `document.activeElement` — the hexagon —
 * on open and restores it on unmount), so Shell carries no focus plumbing
 * of its own. The close-request callbacks are memoized (useCallback) so
 * the phase transitions never churn useModalA11y's effects — a re-armed
 * effect would re-capture `activeElement` mid-close (a tile about to
 * disappear) and break the restore.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { ChatFab } from './ChatFab';
import { FeedbackFab } from './FeedbackFab';
import { LearnMenu, LEARN_MENU_EXIT_MS } from './LearnMenu';
import { Sidebar } from './Sidebar';
import { ExamActiveProvider } from '../hooks/ExamActiveProvider';
import { useDeviceClass } from '../hooks/useDeviceClass';

/** DOM id linking the hexagon's `aria-controls` to the LearnMenu panel. */
const LEARN_MENU_ID = 'km-learn-menu';

/** LearnMenu open/close lifecycle — see the state machine in the header. */
type LearnPhase = 'closed' | 'open' | 'closing';

/**
 * Extra headroom on the stuck-closing safety timeout beyond the nominal
 * exit length — wide enough to never pre-empt a healthy animationend
 * (which would double-drive the unmount path), short enough that a wedged
 * close-out is imperceptible.
 */
const EXIT_SAFETY_MARGIN_MS = 240;

/**
 * OS-level reduced-motion preference, read at close-request time (not
 * cached — the user can flip it mid-session). Guarded for environments
 * without matchMedia (older webviews, some test DOMs).
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The phase a close request lands in: animated exit, or straight to
 *  closed under reduced motion (never gate an instant close on an
 *  animationend that may not fire). */
function closeTarget(): LearnPhase {
  return prefersReducedMotion() ? 'closed' : 'closing';
}

export function Shell(): JSX.Element {
  const [learnPhase, setLearnPhase] = useState<LearnPhase>('closed');
  const location = useLocation();
  // Device-adaptive epic Phase D0: the only render branch this phase adds.
  // 'mobile' keeps today's bottom-bar + hexagon chrome; tablet/desktop swap
  // in the persistent Sidebar rail (Option A).
  const deviceClass = useDeviceClass();
  const sidebarLayout = deviceClass !== 'mobile';

  // Safety net: close the menu on any route change (browser back/forward,
  // programmatic navigation from a page, tile activation — tiles navigate
  // and request the close). Derive-state-during-render (not an effect) so
  // the closing phase starts on the SAME render that shows the new page —
  // the exit cascade plays over it without a stale-open frame.
  const [lastPathname, setLastPathname] = useState(location.pathname);
  if (lastPathname !== location.pathname) {
    setLastPathname(location.pathname);
    setLearnPhase((p) => (p === 'open' ? closeTarget() : p));
  }

  const toggleLearn = useCallback((): void => {
    setLearnPhase((p) => {
      if (p === 'open') return closeTarget();
      // 'closed' opens; a tap mid-'closing' re-opens (the tiles swap back
      // to the entrance animation and replay — feels like catching it).
      return 'open';
    });
  }, []);

  // Close REQUEST (Esc / scrim / tile activation, via LearnMenu's onClose).
  // Idempotent: repeat requests while already 'closing' are no-ops.
  const closeLearn = useCallback((): void => {
    setLearnPhase((p) => (p === 'open' ? closeTarget() : p));
  }, []);

  // Exit-cascade completion — LearnMenu saw the last tile's animationend.
  // Guarded on 'closing' so a stray/late animationend (e.g. after a
  // mid-close re-open) can't yank a freshly reopened menu down.
  const onLearnExited = useCallback((): void => {
    setLearnPhase((p) => (p === 'closing' ? 'closed' : p));
  }, []);

  // Stuck-closing safety timeout: if the sentinel animationend never fires
  // (interrupted animation, hidden ancestor, engine quirk), force the
  // unmount after the nominal exit length + margin. Cleared on any phase
  // change (including re-open), so it can never fire against a live menu.
  useEffect(() => {
    if (learnPhase !== 'closing') return;
    const timer = window.setTimeout(() => {
      setLearnPhase('closed');
    }, LEARN_MENU_EXIT_MS + EXIT_SAFETY_MARGIN_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [learnPhase]);

  return (
    <ExamActiveProvider>
      <div className="km-appframe">
        {sidebarLayout ? <Sidebar /> : null}
        <div className="km-shell">
          <div className="km-shell__statusbar" aria-hidden="true" />
          <main className="km-shell__scroll">
            <Outlet />
          </main>
          <ChatFab />
          <FeedbackFab />
          {sidebarLayout ? null : (
            <>
              <div className="km-shell__nav">
                <BottomNav
                  learnOpen={learnPhase === 'open'}
                  learnClosing={learnPhase === 'closing'}
                  onToggleLearn={toggleLearn}
                  learnMenuId={LEARN_MENU_ID}
                />
              </div>
              {learnPhase !== 'closed' ? (
                <LearnMenu
                  id={LEARN_MENU_ID}
                  onClose={closeLearn}
                  closing={learnPhase === 'closing'}
                  onExited={onLearnExited}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </ExamActiveProvider>
  );
}
