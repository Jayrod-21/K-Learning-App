/**
 * Shell — the layout chrome shared by every authenticated screen.
 *
 * Structure (top to bottom):
 *   1. 54px status-bar spacer (respects iOS `safe-area-inset-top`).
 *   2. Scroll area where the routed screen body renders.
 *   3. Sticky BottomNav (4 tabs + the center LEARN hexagon) with the
 *      upward-expanding LearnMenu overlaying it when open (P1.1).
 *   4. ChatFab — the floating chat dot on the right edge (hides itself on
 *      /chat, /settings, during a mock exam, and while the keyboard is up).
 *
 * `ExamActiveProvider` mounts here so BOTH the writer (MockMode, rendered
 * deep inside the `<Outlet/>`) and the reader (ChatFab, shell chrome) sit
 * under one provider without lifting the flag to App.
 *
 * Owns the LearnMenu open state locally because it's UI-only — no other
 * screen needs to read or write it. The menu also closes on ROUTE CHANGE
 * (effect below): rows close themselves after navigating, but browser
 * back/forward while the menu is open would otherwise leave it stranded
 * over the new page.
 *
 * Focus restoration to the hexagon after close is owned by `useModalA11y`
 * inside LearnMenu (it captures `document.activeElement` — the hexagon —
 * on open and restores it on unmount), so Shell carries no focus plumbing
 * of its own (unlike the retired MoreSheet wiring).
 */
import { useState, type JSX } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { ChatFab } from './ChatFab';
import { LearnMenu } from './LearnMenu';
import { ExamActiveProvider } from '../hooks/ExamActiveProvider';

/** DOM id linking the hexagon's `aria-controls` to the LearnMenu panel. */
const LEARN_MENU_ID = 'km-learn-menu';

export function Shell(): JSX.Element {
  const [learnOpen, setLearnOpen] = useState(false);
  const location = useLocation();

  // Safety net: close the menu on any route change (browser back/forward,
  // programmatic navigation from a page). Row taps already close it. Uses
  // the derive-state-during-render pattern (not an effect) so the menu
  // never paints one frame over the new page before closing.
  const [lastPathname, setLastPathname] = useState(location.pathname);
  if (lastPathname !== location.pathname) {
    setLastPathname(location.pathname);
    setLearnOpen(false);
  }

  const toggleLearn = (): void => {
    setLearnOpen((open) => !open);
  };
  const closeLearn = (): void => {
    setLearnOpen(false);
  };

  return (
    <ExamActiveProvider>
      <div className="km-shell">
        <div className="km-shell__statusbar" aria-hidden="true" />
        <main className="km-shell__scroll">
          <Outlet />
        </main>
        <ChatFab />
        <div className="km-shell__nav">
          <BottomNav
            learnOpen={learnOpen}
            onToggleLearn={toggleLearn}
            learnMenuId={LEARN_MENU_ID}
          />
        </div>
        {learnOpen ? (
          <LearnMenu id={LEARN_MENU_ID} onClose={closeLearn} />
        ) : null}
      </div>
    </ExamActiveProvider>
  );
}
