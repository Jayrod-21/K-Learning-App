/**
 * LibrarySubnav — the vocabulary-family section switcher shared by the two
 * Review-library browse pages (`/review/vocab` · `/review/dictionary`).
 *
 * When the Reference page dissolved into sibling routes (Overhaul P1.2,
 * decisions D2/D3) its tab row became this navigation strip: same visual
 * shape (`km-review__tabs`), but the "tabs" are ROUTES — each tap navigates,
 * so every section stays deep-linkable and the browser back button works.
 * Semantically it is a `<nav>` of links-as-buttons with `aria-current="page"`
 * on the active section (not `role="tablist"`, which would promise in-page
 * panel switching).
 *
 * Grammar is deliberately NOT one of these tabs (the actual bug this ticket
 * fixes): the vocabulary and dictionary pages are a vocab-only lens (see
 * their own F-144/F-150 doc comments — "grammar keeps showing on the Vocab
 * page" was a recurring live bug), so a Grammar tab here made it a one-tap
 * detour off that lens. `/review/grammar` (`ReviewGrammar.tsx`) never
 * rendered this component — it already carries its own `BackButton` to
 * `/review` — so removing the tab orphans nothing; Grammar remains reachable
 * exactly one way: the Library index (`ReviewLibrary`) → Grammar row.
 *
 * P3b: each section renders its nav-manifest en/kr pair through
 * `<Bilingual compact/>` — the strip is tight two-across chrome, so
 * 'both' mode shows the primary language only while the accessible name
 * keeps both (the primitive's sr-only reading).
 *
 * Pure navigation — no I/O, no threat surface beyond the router's own.
 */
import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bilingual } from './Bilingual';
import { navItem, type NavItemId } from '../lib/nav';

const SECTION_IDS: ReadonlyArray<NavItemId> = [
  'review-vocab',
  'review-dictionary',
];

export function LibrarySubnav(): JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <nav className="km-review__tabs" aria-label="Library sections">
      {SECTION_IDS.map((id) => {
        const item = navItem(id);
        const selected = pathname === item.path;
        return (
          <button
            key={id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
            onClick={() => {
              if (!selected) navigate(item.path);
            }}
          >
            <Bilingual en={item.label} kr={item.kr} compact />
          </button>
        );
      })}
    </nav>
  );
}
