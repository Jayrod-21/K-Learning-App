/**
 * ReviewLibrary — the `/review` LIBRARY landing (Overhaul P3B, F-042/F-043).
 *
 * A four-section directory over the library's real routes, in fixed order:
 *
 *   - Vocabulary   → /review/vocab     (corpus browse + My Lists)
 *   - Grammar      → /review/grammar   (single KGIU browse, D3)
 *   - TOPIK exams  → /review/mistakes  (the exams shelf: Mistakes today;
 *                     the dedicated past-exams surface — ticket F-103 —
 *                     takes over this row when it lands)
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
 * F-128 reskin — "Seoul Day & Night": the page opens with a `SkylineHeader`
 * (device #4) carrying the real `<h1>` in its `title` slot + a
 * `DancheongRail` accent underneath (device #2), the SAME hub-header recipe
 * Today/Progress use (see those pages' F-128 doc comments) — this is the
 * library's own hub landing, not a nested sub-page, so it gets the same
 * treatment. Each section row is now a `CityCard` (device #1: Night neon
 * signboard / Day hanji paper) with its leading-edge `rail`, replacing the
 * pre-redesign flat `.km-library__row` look — the real `<button>` still owns
 * 100% of the interaction/a11y, CityCard is nested purely as the visual
 * surface (same split ActivityTile uses on Today, `pages/Today.tsx`).
 *
 * No I/O — pure navigation; no threat model beyond the router's own.
 */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import type { CityCardTone } from '../components/CityCard';
import { CityCard } from '../components/CityCard';
import { DancheongRail } from '../components/DancheongRail';
import { Eyebrow } from '../components/Eyebrow';
import { Icon, type IconName } from '../components/Icon';
import { SkylineHeader } from '../components/SkylineHeader';
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
    // The exams shelf (F-042): Mistakes and past TOPIK exams share this
    // section. No dedicated past-exams surface is wired yet, so the row
    // lands on Mistakes — the one exams surface that exists today. When
    // the past-exams page ships (ticket F-103) it takes over `to` (and
    // Mistakes becomes a link inside it).
    key: 'exams',
    label: 'TOPIK exams',
    kr: '기출 시험',
    desc: 'Mistakes · past exams',
    krDesc: '틀린 문제 · 기출',
    icon: 'spark',
    to: navItem('mistakes').path,
    tone: 'mint',
  },
  sectionFor('uploads', 'plain'),
];

function ReviewLibrary(): JSX.Element {
  const navigate = useNavigate();

  return (
    <section className="screen km-library" aria-labelledby="library-title">
      {/* F-128 device #4 — the hub-header recipe shared with Today/Progress:
          the real <h1> rides in SkylineHeader's own `title` slot. */}
      <SkylineHeader
        className="km-library__skyline"
        title={
          <>
            <Eyebrow>
              <Bilingual en={LIBRARY_NAV.eyebrow} kr={LIBRARY_NAV.krEyebrow} />
            </Eyebrow>
            <h1 id="library-title" className="kr-display km-library__title">
              <Bilingual kr={LIBRARY_NAV.kr} en={LIBRARY_NAV.label} />
            </h1>
          </>
        }
      />

      {/* F-128 device #2 — the same dancheong-rail divider under the
          skyline that Today/Progress render (purely decorative — the rail
          is aria-hidden itself). */}
      <div className="km-library__rail-divider">
        <DancheongRail tone="accent" />
      </div>

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
