/**
 * FeedbackFab (F-127) — the global "!" feedback button, pinned to the
 * shell's TOP-RIGHT corner on every page. Mirrors `ChatFab`'s conventions
 * (`focusring`, keyboard-operable real `<button>`, reduced-motion aware,
 * segment-boundary path hiding) but sits at the OPPOSITE corner from
 * ChatFab's ~1/5-down right-edge dot so the two never collide.
 *
 * Tapping it navigates to `/tickets` carrying router state:
 *   `{ compose: true, sourcePage: { path, name } }`
 * — `path` is the raw `location.pathname` (the thing actually persisted as
 * `tickets.source_page`, migration 058); `name` is a friendly label
 * (`pageNameForPath`, lib/nav.ts) for immediate display while composing.
 * `Tickets.tsx` reads `state.compose` to open the file-a-ticket form (F-128:
 * it now lives in a `Sheet`, opened on arrival rather than always rendered
 * inline) and autofocus its Title field, and `state.sourcePage.path` to
 * stamp the ticket it creates. The Settings "Beta feedback" tile (F-023's original, still
 * canonical, entry point) stays untouched — this is a second, more
 * discoverable entry, per F-127.
 *
 * Visibility — HIDDEN (renders null) on `/tickets` itself (and any
 * sub-path): reporting feedback FROM the feedback page is noise, and it
 * would otherwise sit directly over that page's own Topbar controls.
 *
 * No I/O of its own — it only navigates with router state (no fetch, no
 * user input rendered back), so there is no separate threat model beyond
 * "the path/name it forwards are the CALLER's own current route", which
 * carries no more information than the URL bar already does.
 */
import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { pageNameForPath } from '../lib/nav';
import { Icon } from './Icon';
import './FeedbackFab.css';

/** Route prefix where the FAB stays hidden — see module header. */
const HIDDEN_PATH_PREFIXES = ['/tickets'] as const;

function isHiddenPath(pathname: string): boolean {
  // Lowercase before comparing, same as ChatFab's `isHiddenPath` — React
  // Router matches routes case-insensitively, so a hand-typed `/Tickets`
  // still renders the tickets screen.
  const path = pathname.toLowerCase();
  return HIDDEN_PATH_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

export function FeedbackFab(): JSX.Element | null {
  const location = useLocation();
  const navigate = useNavigate();

  if (isHiddenPath(location.pathname)) {
    return null;
  }

  return (
    <button
      type="button"
      className="km-feedbackfab focusring"
      aria-label="Report feedback · 피드백 보내기"
      onClick={() => {
        navigate('/tickets', {
          state: {
            compose: true,
            sourcePage: {
              path: location.pathname,
              name: pageNameForPath(location.pathname),
            },
          },
        });
      }}
    >
      <Icon name="alert" size={18} />
    </button>
  );
}
