/**
 * ReviewLibrary — the `/review` library index (Overhaul P1.2 assembly).
 *
 * A directory over the library's REAL sub-routes (the P1.1 `/reference?tab=`
 * placeholder links are gone — Reference dissolved into the routes below):
 *
 *   - Mistakes            → /review/mistakes
 *   - Vocabulary          → /review/vocab       (corpus browse + My Lists)
 *   - Dictionary          → /review/dictionary  (KRDICT, D2: separate page)
 *   - Grammar             → /review/grammar     (single browse, D3)
 *   - Scan images         → /images             (OCR mining; INTERIM home
 *                            until the P4 IA decision — see ROWS note)
 *   - Past TOPIK exams    → coming soon (designed placeholder; P4)
 *   - Uploads             → coming soon (designed placeholder; P4/P6)
 *
 * Above the directory sit two QUICK-LAUNCH hot-buttons into the LEARN flow
 * (`/learn/vocab` flashcards + `/learn/grammar` drill) — real targets,
 * deliberately simple chips; the fuller hot-button treatment is P4.
 *
 * NOTE: this page REPURPOSES the `/review` path — the FSRS vocab flashcards
 * that used to live here are now at `/learn/vocab` (LEARN menu → "Vocab
 * flashcards"). No redirect shim exists for the old meaning by design; see
 * `lib/redirects.tsx`.
 *
 * No I/O — pure navigation; no threat model beyond the router's own.
 */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Icon, type IconName } from '../components/Icon';
import { Pill } from '../components/Pill';
import { Topbar } from '../components/Topbar';
import { navItem, type NavItemId } from '../lib/nav';

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const LIBRARY_NAV = navItem('review');

interface LibraryRow {
  readonly key: string;
  readonly label: string;
  readonly kr: string;
  readonly icon: IconName;
  /** Destination — absent means the row is a "coming soon" placeholder. */
  readonly to?: string;
}

function rowFor(id: NavItemId): LibraryRow {
  const item = navItem(id);
  return {
    key: id,
    label: item.label,
    kr: item.kr,
    icon: item.icon,
    to: item.path,
  };
}

const ROWS: ReadonlyArray<LibraryRow> = [
  rowFor('mistakes'),
  // The dissolved Reference tabs — first-class library routes since P1.2.
  rowFor('review-vocab'),
  rowFor('review-dictionary'),
  rowFor('review-grammar'),
  // INTERIM home for `/images` (photo/OCR vocab mining) — the page lost its
  // entry point when the More sheet retired in P1.1. Sits with the
  // bring-your-own-material rows (Uploads); its FINAL home is a P4 decision
  // (fold into uploads vs. the chat image feature — OVERHAUL_DESIGN.md).
  { ...rowFor('images'), label: 'Scan images', kr: '이미지 스캔' },
  // Designed "coming soon" placeholders — routes + endpoints land in P4/P6.
  { key: 'exams', label: 'Past TOPIK exams', kr: '기출 시험', icon: 'spark' },
  { key: 'uploads', label: 'Uploads', kr: '자료 업로드', icon: 'upload' },
];

/** Quick-launch hot-buttons → the LEARN flow (real targets; simple for now —
 *  the fuller treatment is P4). */
const HOT_BUTTONS: ReadonlyArray<{
  readonly id: NavItemId;
  readonly label: string;
  readonly kr: string;
}> = [
  { id: 'flashcards', label: 'Vocab flashcards', kr: '단어 카드' },
  { id: 'grammar', label: 'Grammar drill', kr: '문법 연습' },
];

function ReviewLibrary(): JSX.Element {
  const navigate = useNavigate();

  return (
    <section className="screen km-library" aria-labelledby="review-title">
      <Topbar
        krTitle="복습"
        title="Review"
        titleId="review-title"
        eyebrow={
          <Bilingual en={LIBRARY_NAV.eyebrow} kr={LIBRARY_NAV.krEyebrow} />
        }
      />

      <div
        className="km-library__quick"
        role="group"
        aria-label="Quick launch"
      >
        {HOT_BUTTONS.map((hb) => {
          const item = navItem(hb.id);
          return (
            <button
              key={hb.id}
              type="button"
              className="km-library__chip focusring"
              onClick={() => {
                navigate(item.path);
              }}
            >
              <Icon name={item.icon} size={16} />
              <span>
                <Bilingual en={hb.label} kr={hb.kr} compact />
              </span>
            </button>
          );
        })}
      </div>

      <div className="km-library__list" role="list" aria-label="Review library">
        {ROWS.map((row) => {
          const { to } = row;
          return (
            <div key={row.key} role="listitem">
              {to !== undefined ? (
                <button
                  type="button"
                  className="km-library__row focusring"
                  onClick={() => {
                    navigate(to);
                  }}
                >
                  <Icon name={row.icon} size={20} />
                  <span className="km-library__rowmeta">
                    {/* P3b: the row's en/kr pair renders through the
                        bilingual primitive so the language-display setting
                        applies (was two hand-stacked single-language spans). */}
                    <span className="km-library__rowlabel">
                      <Bilingual en={row.label} kr={row.kr} />
                    </span>
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              ) : (
                <div className="km-library__row km-library__row--soon">
                  <Icon name={row.icon} size={20} />
                  <span className="km-library__rowmeta">
                    <span className="km-library__rowlabel">
                      <Bilingual en={row.label} kr={row.kr} />
                    </span>
                  </span>
                  <Pill>
                    <Bilingual en="Coming soon" kr="준비 중" compact />
                  </Pill>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default ReviewLibrary;
