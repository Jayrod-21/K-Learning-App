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
import { matchActiveNavId, navItem, PRIMARY_TAB_IDS } from '../lib/nav';
import { Bilingual } from './Bilingual';
import { Icon } from './Icon';

export interface BottomNavProps {
  /** True when the LearnMenu is open — drives `aria-expanded` + styling. */
  learnOpen: boolean;
  /**
   * True while the LearnMenu plays its exit cascade (Shell's 'closing'
   * phase). `aria-expanded` already reads false — the close was requested
   * — but the hexagon needs to know so its idle float stays paused while
   * the 180°→0° un-spin transition runs (the float animation restarting
   * mid-spin would bob the hexagon while it rotates).
   */
  learnClosing: boolean;
  /** Called when the user taps the LEARN hexagon (toggle). */
  onToggleLearn: () => void;
  /**
   * DOM id of the LearnMenu panel, for `aria-controls`. Only wired while
   * the panel is mounted — open OR playing its close-out (an
   * `aria-controls` pointing at a non-existent id is an a11y defect).
   */
  learnMenuId: string;
}

export function BottomNav({
  learnOpen,
  learnClosing,
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
        // Guided-tour anchor (lib/tours.ts) — the Sidebar's links carry the
        // SAME keys, so whichever chrome is mounted resolves the step.
        data-tour={`tab-${id}`}
        onClick={() => {
          if (location.pathname !== it.path) {
            navigate(it.path);
          }
        }}
      >
        <Icon name={it.icon} size={22} />
        {/* P3a: the visible label follows the language-display setting.
            `compact` — a 10px tab cell can't legibly fit two scripts (the
            sub would render at ~7px and the longest pair risks ellipsis on
            360px viewports), so in 'both' mode only the primary language
            shows, like the hexagon. The button's aria-label above keeps
            BOTH languages in every mode. */}
        <span className="km-bottomnav__label">
          <Bilingual en={it.label} kr={it.kr} compact />
        </span>
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
          // --open drives the 180° spin (transitioned, so dropping it on
          // close plays the un-spin); --closing only holds the idle float
          // off while that un-spin runs.
          learnOpen && 'km-bottomnav__hex--open',
          learnClosing && 'km-bottomnav__hex--closing',
          (learnOpen || onLearnSubpage) && 'km-bottomnav__hex--current',
        )}
        aria-haspopup="dialog"
        aria-expanded={learnOpen}
        aria-controls={learnOpen || learnClosing ? learnMenuId : undefined}
        aria-label="Learn · 배움"
        data-tour="learn-launcher"
        onClick={onToggleLearn}
      >
        <Icon name="learn" size={28} />
        {/* `compact`: the clipped hexagon can't fit two scripts — in 'both'
            mode only the primary language shows; aria-label keeps both. */}
        <span className="km-bottomnav__hexlabel">
          <Bilingual en="LEARN" kr="배움" compact />
        </span>
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
 * "Review" (the library owns its sub-pages). Thin wrapper over the shared
 * `matchActiveNavId` (lib/nav.ts) — `Sidebar` reuses the same matcher over
 * its wider flattened id set so both surfaces agree on one "you are here"
 * rule.
 */
function matchActiveId(pathname: string): (typeof PRIMARY_TAB_IDS)[number] | null {
  return matchActiveNavId(pathname, PRIMARY_TAB_IDS);
}
