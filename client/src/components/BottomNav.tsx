/**
 * BottomNav — fixed row with 4 primary tabs around a center LEARN hexagon
 * (Overhaul P1.1): today · progress · [LEARN] · review · settings.
 *
 * The hexagon is a LAUNCHER, not a nav link — it toggles the upward
 * `LearnMenu` (owned by Shell) and carries `aria-expanded` +
 * `aria-controls` instead of `aria-current`. The 4 tabs navigate.
 *
 * Active state:
 *   - A primary tab lights on longest-prefix match of the new paths, so
 *     `/review/mistakes` still lights "Review" (the library owns it).
 *   - On a `/learn/*` sub-page no primary tab matches; the HEXAGON lights
 *     instead (`--current`) so the bar always shows where you are.
 *   - While the LearnMenu is open, only the hexagon reads active
 *     (mirrors the old More-sheet behaviour).
 *
 * A11y:
 *   - `<nav>` with an `aria-label`.
 *   - Tabs render as `<button>` with `aria-current="page"` on match so screen
 *     readers announce the active section without us shipping ARIA tablist
 *     semantics (the tabs change the URL, they don't switch a panel).
 *   - 44×44px touch targets on all five cells (iOS HIG minimum).
 *   - `focusring` for keyboard outline (the hexagon uses a drop-shadow ring
 *     instead — a rectangular outline on a clipped shape reads broken).
 */
import { useLocation, useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { cn } from '../lib/cn';
import { navItem, PRIMARY_TAB_IDS, type NavItemId } from '../lib/nav';
import { Icon } from './Icon';

export interface BottomNavProps {
  /** True when the LearnMenu is open — drives `aria-expanded` + styling. */
  learnOpen: boolean;
  /** Called when the user taps the LEARN hexagon (toggle). */
  onToggleLearn: () => void;
  /**
   * DOM id of the LearnMenu panel, for `aria-controls`. Only wired while
   * the menu is open (an `aria-controls` pointing at a non-existent id is
   * an a11y defect).
   */
  learnMenuId: string;
}

export function BottomNav({
  learnOpen,
  onToggleLearn,
  learnMenuId,
}: BottomNavProps): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const activeId = matchActiveId(location.pathname);
  const onLearnSubpage = isLearnPath(location.pathname);

  const cells: JSX.Element[] = PRIMARY_TAB_IDS.map((id) => {
    const it = navItem(id);
    const active = !learnOpen && activeId === id;
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
  });

  // Hexagon sits center — between progress (index 1) and review (index 2).
  cells.splice(
    2,
    0,
    <div key="learn" className="km-bottomnav__hexslot">
      <button
        type="button"
        className={cn(
          'km-bottomnav__hex',
          learnOpen && 'km-bottomnav__hex--open',
          (learnOpen || onLearnSubpage) && 'km-bottomnav__hex--current',
        )}
        aria-haspopup="dialog"
        aria-expanded={learnOpen}
        aria-controls={learnOpen ? learnMenuId : undefined}
        aria-label="Learn · 배움"
        onClick={onToggleLearn}
      >
        <Icon name="learn" size={28} />
        <span className="km-bottomnav__hexlabel">LEARN</span>
      </button>
    </div>,
  );

  return (
    <nav className="km-bottomnav" aria-label="Primary navigation">
      {cells}
    </nav>
  );
}

/** True when the current URL is a LEARN sub-page (`/learn/...`). */
function isLearnPath(pathname: string): boolean {
  return pathname === '/learn' || pathname.startsWith('/learn/');
}

/**
 * Map the current URL to a primary tab id, or null if we're on a
 * non-primary route. Longest-prefix wins so `/review/mistakes` lights
 * "Review" (the library owns its sub-pages).
 */
function matchActiveId(pathname: string): NavItemId | null {
  let best: { id: NavItemId; len: number } | null = null;
  for (const id of PRIMARY_TAB_IDS) {
    const it = navItem(id);
    // Path-boundary check: a bare `startsWith('/review')` would also light
    // Review for `/review-history` (a plausible future sibling route). Match
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
