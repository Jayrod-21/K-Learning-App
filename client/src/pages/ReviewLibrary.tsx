/**
 * ReviewLibrary — the `/review` LIBRARY landing (Overhaul P3B, F-042/F-043).
 *
 * A four-section directory over the library's real routes, in fixed order:
 *
 *   - Vocabulary   → /review/vocab     (corpus browse + My Lists)
 *   - Grammar      → /review/grammar   (single KGIU browse, D3)
 *   - TOPIK exams  → /review/mistakes  (the exams shelf: Mistakes today;
 *                     a dedicated past-exams surface takes over this row
 *                     when it lands — see the P3B ticket in the report)
 *   - Uploads      → /uploads          (book PDFs, U1b)
 *
 * F-043 renamed the page (and the bottom-nav tab, via lib/nav.ts) from
 * "Review" to "Library"; the `review` NavItemId and the `/review` path are
 * hard route contracts and stay as-is. F-042 removed the P1.2-era extras:
 * the quick-launch LEARN chips (flashcards/grammar drill — the hexagon
 * LEARN launcher owns that flow), the standalone Mistakes/Dictionary rows
 * (Dictionary stays reachable via LibrarySubnav on the browse pages), the
 * interim "Scan images" row, and the inert "coming soon" placeholders.
 *
 * Each row's title AND its one-line contents description come from the nav
 * manifest's en/kr pairs and render through `<Bilingual/>`, so the
 * language-display setting applies everywhere.
 *
 * No BackButton: `/review` is a primary bottom-nav tab (same as
 * Today/Progress), not a sub-page.
 *
 * No I/O — pure navigation; no threat model beyond the router's own.
 */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Icon, type IconName } from '../components/Icon';
import { Topbar } from '../components/Topbar';
import { navItem, type NavItemId } from '../lib/nav';
import './ReviewLibrary.css';

/** Page title + eyebrow source — nav.ts owns the en/kr pairs (F-043). */
const LIBRARY_NAV = navItem('review');

interface LibrarySection {
  readonly key: string;
  readonly label: string;
  readonly kr: string;
  /** One-line contents description (chrome register, en/kr pair). */
  readonly desc: string;
  readonly krDesc: string;
  readonly icon: IconName;
  readonly to: string;
}

function sectionFor(id: NavItemId): LibrarySection {
  const item = navItem(id);
  return {
    key: id,
    label: item.label,
    kr: item.kr,
    desc: item.eyebrow,
    krDesc: item.krEyebrow,
    icon: item.icon,
    to: item.path,
  };
}

/** The four library sections, in the F-042 order. */
const SECTIONS: ReadonlyArray<LibrarySection> = [
  sectionFor('review-vocab'),
  sectionFor('review-grammar'),
  {
    // The exams shelf (F-042): Mistakes and past TOPIK exams share this
    // section. No dedicated past-exams surface is wired yet, so the row
    // lands on Mistakes — the one exams surface that exists today. When
    // the past-exams page ships it takes over `to` (and Mistakes becomes
    // a link inside it).
    key: 'exams',
    label: 'TOPIK exams',
    kr: '기출 시험',
    desc: 'Mistakes · past exams',
    krDesc: '틀린 문제 · 기출',
    icon: 'spark',
    to: navItem('mistakes').path,
  },
  sectionFor('uploads'),
];

function ReviewLibrary(): JSX.Element {
  const navigate = useNavigate();

  return (
    <section className="screen km-library" aria-labelledby="library-title">
      <Topbar
        krTitle={LIBRARY_NAV.kr}
        title={LIBRARY_NAV.label}
        titleId="library-title"
        eyebrow={
          <Bilingual en={LIBRARY_NAV.eyebrow} kr={LIBRARY_NAV.krEyebrow} />
        }
      />

      {/* role="list" on the div (not a <ul>) matches the app-wide pattern —
          the global CSS reset strips list semantics, so the role restores
          them explicitly for AT. */}
      <div
        className="km-library__list"
        role="list"
        aria-label="Library sections"
      >
        {SECTIONS.map((s) => (
          <div key={s.key} role="listitem">
            <button
              type="button"
              className="km-library__row focusring"
              onClick={() => {
                navigate(s.to);
              }}
            >
              <Icon name={s.icon} size={20} />
              <span className="km-library__rowmeta">
                <span className="km-library__rowlabel">
                  <Bilingual en={s.label} kr={s.kr} />
                </span>
                {/* `compact`: the description is tight secondary chrome —
                    in 'both' mode only the primary language shows while
                    the accessible name keeps both (same call as
                    LibrarySubnav). */}
                <span className="km-library__rowdesc">
                  <Bilingual en={s.desc} kr={s.krDesc} compact />
                </span>
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export default ReviewLibrary;
