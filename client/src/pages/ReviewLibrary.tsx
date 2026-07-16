/**
 * ReviewLibrary — the `/review` LIBRARY landing (Overhaul P3B, F-042/F-043).
 *
 * A four-section directory over the library's real routes, in fixed order:
 *
 *   - Vocabulary   → /review/vocab     (corpus browse + My Lists)
 *   - Grammar      → /review/grammar   (single KGIU browse, D3)
 *   - TOPIK exams  → /review/exams     (F-103: dedicated past-exams surface —
 *                     completed sittings + scores + re-enter; Mistakes is a
 *                     link inside it, not the shelf's direct target anymore)
 *   - Uploads      → /uploads          (book PDFs, U1b)
 *
 * F-043 renamed the page (and the bottom-nav tab, via lib/nav.ts) from
 * "Review" to "Library"; the `review` NavItemId and the `/review` path are
 * hard route contracts and stay as-is. F-042 removed the P1.2-era extras:
 * the quick-launch LEARN chips (flashcards/grammar drill — the hexagon
 * LEARN launcher owns that flow), the standalone Mistakes/Dictionary rows
 * (Dictionary stays reachable via LibrarySubnav on the browse pages), the
 * interim "Scan images" row (leaving `/images` with no in-app entry point —
 * its re-entry home is ticket F-102), and the inert "coming soon"
 * placeholders.
 *
 * Each row's title AND its one-line contents description come from the nav
 * manifest's en/kr pairs and render through `<Bilingual/>`, so the
 * language-display setting applies everywhere.
 *
 * No BackButton: `/review` is a primary bottom-nav tab (same as
 * Today/Progress), not a sub-page.
 *
 * F-128 reskin — "Seoul Day & Night": the page opens with the shared
 * `PageHubHeader` (devices #4/#2 — `SkylineHeader` carrying the real `<h1>`
 * + a `DancheongRail` accent underneath), the SAME hub-header recipe
 * Today/Progress use (see those pages' F-128 doc comments) — this is the
 * library's own hub landing, not a nested sub-page, so it gets the same
 * treatment. Batch-2 fix-pass (BLOCKER-2): this page's own copy of the
 * recipe was extracted into `PageHubHeader` (`components/PageHubHeader.tsx`)
 * so every Library page shares one implementation, and the root now also
 * carries `.km-rain-sheen` (device #8, Night ambient) to match every
 * sibling Library page — the one thing this page was missing
 * (`REVIEW_batch2-fidelity.md` S1). Each section row is now a `CityCard` (device #1: Night neon
 * signboard / Day hanji paper) with its leading-edge `rail`, replacing the
 * pre-redesign flat `.km-library__row` look — the real `<button>` still owns
 * 100% of the interaction/a11y, CityCard is nested purely as the visual
 * surface (same split ActivityTile uses on Today, `pages/Today.tsx`).
 *
 * Device-adaptive epic, Phase D2: at tablet/desktop (`useDeviceClass() !==
 * 'mobile'`, the same one-render-branch pattern D1 gave Today/Progress), the
 * four shelves lay out as a two-column card GRID using the width instead of
 * a single narrow stack — the `--grid` modifier below is the ONLY thing the
 * branch adds, so the mobile markup (and its class string) stays
 * byte-identical. The grid geometry/width arithmetic lives with the CSS in
 * ReviewLibrary.css.
 *
 * No I/O — pure navigation; no threat model beyond the router's own.
 */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import type { CityCardTone } from '../components/CityCard';
import { CityCard } from '../components/CityCard';
import { Icon, type IconName } from '../components/Icon';
import { PageHubHeader } from '../components/PageHubHeader';
import { useDeviceClass } from '../hooks/useDeviceClass';
import { cn } from '../lib/cn';
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
  /** F-128 — CityCard tone, mirroring the prototype's per-row signboard
   *  color (`km-prototype.html`'s `/library` screen: vocab plain/accent,
   *  grammar blue, exams mint, uploads plain). */
  readonly tone: CityCardTone;
}

function sectionFor(id: NavItemId, tone: CityCardTone): LibrarySection {
  const item = navItem(id);
  return {
    key: id,
    label: item.label,
    kr: item.kr,
    desc: item.eyebrow,
    krDesc: item.krEyebrow,
    icon: item.icon,
    to: item.path,
    tone,
  };
}

/** The four library sections, in the F-042 order. */
const SECTIONS: ReadonlyArray<LibrarySection> = [
  sectionFor('review-vocab', 'accent'),
  sectionFor('review-grammar', 'blue'),
  {
    // The exams shelf (F-042) now lands on the dedicated past-exams surface
    // (F-103) — completed sittings + scores, re-enter/retake action.
    // Mistakes (per-item wrong-answer review) is a link INSIDE that page,
    // not this shelf's direct target anymore.
    key: 'exams',
    label: 'TOPIK exams',
    kr: '기출 시험',
    desc: navItem('review-exams').eyebrow,
    krDesc: navItem('review-exams').krEyebrow,
    icon: 'spark',
    to: navItem('review-exams').path,
    tone: 'mint',
  },
  sectionFor('uploads', 'plain'),
];

function ReviewLibrary(): JSX.Element {
  const navigate = useNavigate();
  // D2 (device-adaptive epic) — the ONE render branch this phase adds to the
  // Library landing: tablet/desktop tag the section list with a `--grid`
  // modifier so ReviewLibrary.css can lay the shelves out two-up using the
  // width. Mobile (`'mobile'`) renders byte-identical to before — `cn`
  // drops the falsy modifier, so the class string is exactly
  // 'km-library__list', same as pre-D2.
  const isGridLayout = useDeviceClass() !== 'mobile';

  return (
    <section
      className="screen km-library km-rain-sheen"
      aria-labelledby="library-title"
    >
      {/* F-128 devices #4/#2 — the shared hub-header recipe (batch-2
          fix-pass BLOCKER-2, components/PageHubHeader.tsx). */}
      <PageHubHeader
        titleId="library-title"
        eyebrow={<Bilingual en={LIBRARY_NAV.eyebrow} kr={LIBRARY_NAV.krEyebrow} />}
        heading={<Bilingual kr={LIBRARY_NAV.kr} en={LIBRARY_NAV.label} />}
      />

      {/* role="list" on the div (not a <ul>) matches the app-wide pattern —
          the global CSS reset strips list semantics, so the role restores
          them explicitly for AT. */}
      <div
        className={cn(
          'km-library__list',
          isGridLayout && 'km-library__list--grid',
        )}
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
              <CityCard
                tone={s.tone}
                rail
                className="km-library__rowCard"
              >
                <span className="km-library__rowTop">
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
                </span>
              </CityCard>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export default ReviewLibrary;
