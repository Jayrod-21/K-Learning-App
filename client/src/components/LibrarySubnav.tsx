/**
 * LibrarySubnav — the section switcher shared by the Review-library browse
 * pages (`/review/vocab` · `/review/dictionary` · `/review/grammar`).
 *
 * When the Reference page dissolved into sibling routes (Overhaul P1.2,
 * decisions D2/D3) its tab row became this navigation strip: same visual
 * shape (`km-review__tabs`), but the "tabs" are ROUTES — each tap navigates,
 * so every section stays deep-linkable and the browser back button works.
 * Semantically it is a `<nav>` of links-as-buttons with `aria-current="page"`
 * on the active section (not `role="tablist"`, which would promise in-page
 * panel switching).
 *
 * P3b: each section renders its nav-manifest en/kr pair through
 * `<Bilingual compact/>` — the strip is tight three-across chrome, so
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
  'review-grammar',
];

export function LibrarySubnav(): JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <nav className="km-review__tabs" aria-label="Review library section">
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
