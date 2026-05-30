/**
 * Shell — the layout chrome shared by every authenticated screen.
 *
 * Structure (top to bottom):
 *   1. 54px status-bar spacer (respects iOS `safe-area-inset-top`).
 *   2. Scroll area where the routed screen body renders.
 *   3. Sticky 64px BottomNav + a portal-mounted MoreSheet when open.
 *
 * Owns the MoreSheet open state locally because it's UI-only — no other
 * screen needs to read or write it, so lifting it to App would only add a
 * prop hop. Theme comes from `useTheme`.
 *
 * Focus management: Shell owns the "restore focus to the More button after
 * the sheet closes" contract (WCAG 2.4.3). The ref is captured here,
 * passed into BottomNav, and called from `closeMore` via `queueMicrotask`
 * so React has finished unmounting the sheet before we move focus.
 */
import { useRef, useState, type JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { MoreSheet } from './MoreSheet';
import { useTheme } from '../hooks/useTheme';

export function Shell(): JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  // The More button lives inside BottomNav. We pass the ref *down* rather
  // than lifting the button up so BottomNav stays a self-contained nav unit.
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  // `useState`'s setter is referentially stable, so these don't need
  // `useCallback`. The sheet/nav consumers aren't memoized either, so the
  // wrapper would only add indirection.
  const openMore = (): void => {
    setMoreOpen(true);
  };
  const closeMore = (): void => {
    setMoreOpen(false);
    // Restore focus to the trigger after the sheet unmounts. `queueMicrotask`
    // lets React finish the reconciliation pass first; calling `.focus()`
    // synchronously would race the unmount and lose focus to `<body>`.
    queueMicrotask(() => {
      moreButtonRef.current?.focus();
    });
  };

  return (
    <div className="km-shell">
      <div className="km-shell__statusbar" aria-hidden="true" />
      <main className="km-shell__scroll">
        <Outlet />
      </main>
      <div className="km-shell__nav">
        <BottomNav
          moreOpen={moreOpen}
          onOpenMore={openMore}
          moreButtonRef={moreButtonRef}
        />
      </div>
      {moreOpen ? (
        <MoreSheet onClose={closeMore} onToggleTheme={toggleTheme} theme={theme} />
      ) : null}
    </div>
  );
}
