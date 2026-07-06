/**
 * BottomNav — fixed 64px row with 4 primary tabs and a More opener.
 *
 * Active tab is computed from the current router location, not from props,
 * so a deep link or browser back/forward keeps the lit tab consistent. The
 * More opener owns its own active state derived from the parent's
 * `moreOpen` flag (so the More button stays lit while the sheet is open).
 *
 * A11y:
 *   - `<nav>` with an `aria-label`.
 *   - Tabs render as `<button>` with `aria-current="page"` on match so screen
 *     readers announce the active section without us shipping ARIA tablist
 *     semantics (the tabs change the URL, they don't switch a panel).
 *   - 44×44px touch targets on all five cells (iOS HIG minimum).
 *   - `focusring` for keyboard outline.
 */
import { useLocation, useNavigate } from 'react-router-dom';
import type { JSX, RefObject } from 'react';
import { cn } from '../lib/cn';
import { navItem, PRIMARY_TAB_IDS, type NavItemId } from '../lib/nav';
import { Icon } from './Icon';

export interface BottomNavProps {
  /** True when the More sheet is open — keeps the More button lit. */
  moreOpen: boolean;
  /** Called when the user taps the More cell. */
  onOpenMore: () => void;
  /**
   * Ref the parent (Shell) supplies so it can restore focus to the More
   * button after the sheet closes (WCAG 2.4.3 Focus Order — focus must
   * return to the trigger when a dialog closes). Plumbed as a callback-free
   * RefObject so we don't take ownership.
   */
  moreButtonRef?: RefObject<HTMLButtonElement | null>;
}

export function BottomNav({
  moreOpen,
  onOpenMore,
  moreButtonRef,
}: BottomNavProps): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const activeId = matchActiveId(location.pathname);

  return (
    <nav className="km-bottomnav" aria-label="Primary navigation">
      {PRIMARY_TAB_IDS.map((id) => {
        const it = navItem(id);
        const active = !moreOpen && activeId === id;
        return (
          <button
            key={id}
            type="button"
            className={cn(
              'km-bottomnav__cell focusring',
              active && 'km-bottomnav__cell--active',
            )}
            aria-current={active ? 'page' : undefined}
            aria-label={`${it.label} · ${it.kr}`}
            onClick={() => {
              if (location.pathname !== it.path) {
                navigate(it.path);
              }
            }}
          >
            <Icon name={it.icon} size={22} />
            <span className="km-bottomnav__label">{it.label}</span>
          </button>
        );
      })}
      <button
        ref={moreButtonRef}
        type="button"
        className={cn(
          'km-bottomnav__cell focusring',
          moreOpen && 'km-bottomnav__cell--active',
        )}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        aria-label="More"
        onClick={onOpenMore}
      >
        <Icon name="more" size={22} />
        <span className="km-bottomnav__label">More</span>
      </button>
    </nav>
  );
}

/**
 * Map the current URL to a primary tab id, or null if we're on a More-tab
 * route. Longest-prefix wins so `/ttmik/lessons/1/1` still lights "Listen".
 */
function matchActiveId(pathname: string): NavItemId | null {
  let best: { id: NavItemId; len: number } | null = null;
  for (const id of PRIMARY_TAB_IDS) {
    const it = navItem(id);
    // Path-boundary check: a bare `startsWith('/topik')` would also light
    // TOPIK for `/topik-history` (a plausible future sibling route). Match
    // only on exact equality or on a real `/` segment boundary.
    const matches =
      it.path === '/'
        ? pathname === '/'
        : pathname === it.path || pathname.startsWith(`${it.path}/`);
    if (matches) {
      const len = it.path.length;
      if (!best || len > best.len) {
        best = { id, len };
      }
    }
  }
  return best?.id ?? null;
}
