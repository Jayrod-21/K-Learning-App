/**
 * ReviewLibrary — the `/review` library index (Overhaul P1.1 placeholder).
 *
 * P1.1 stands up the TAB and its links only; the real library assembly
 * (dissolving Reference into first-class sub-pages, past-exams list, PDF
 * uploads) is P1.2+. Until then this page is a simple directory:
 *
 *   - Mistakes            → /review/mistakes (re-homed, pure move)
 *   - Vocabulary          → /reference?tab=vocab      (existing tab)
 *   - Grammar             → /reference?tab=grammar    (existing tab)
 *   - Dictionary          → /reference?tab=dictionary (existing tab)
 *   - Past TOPIK exams    → coming soon (no endpoint yet)
 *   - Uploads             → coming soon (P6 book scans / PDF uploads)
 *
 * NOTE: this page REPURPOSES the `/review` path — the FSRS vocab
 * flashcards that used to live here are now at `/learn/vocab` (LEARN menu
 * → "Vocab flashcards"). No redirect shim exists for the old meaning by
 * design; see `lib/redirects.tsx`.
 *
 * No I/O — pure navigation; no threat model beyond the router's own.
 */
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon';
import { Pill } from '../components/Pill';
import { Topbar } from '../components/Topbar';
import { navItem } from '../lib/nav';

interface LibraryRow {
  readonly key: string;
  readonly label: string;
  readonly kr: string;
  readonly icon: IconName;
  /** Destination — absent means the row is a "coming soon" stub. */
  readonly to?: string;
}

const ROWS: ReadonlyArray<LibraryRow> = [
  {
    key: 'mistakes',
    label: navItem('mistakes').label,
    kr: navItem('mistakes').kr,
    icon: navItem('mistakes').icon,
    to: navItem('mistakes').path,
  },
  // The three Reference tabs — linked in place for P1.1; they become
  // first-class library sub-pages when Reference dissolves in P1.2.
  { key: 'vocab', label: 'Vocabulary', kr: '단어', icon: 'cards', to: '/reference?tab=vocab' },
  { key: 'grammar', label: 'Grammar', kr: '문법', icon: 'grammar', to: '/reference?tab=grammar' },
  { key: 'dictionary', label: 'Dictionary', kr: '사전', icon: 'search', to: '/reference?tab=dictionary' },
  // Coming-soon stubs — routes and endpoints land in P1.2+.
  { key: 'exams', label: 'Past TOPIK exams', kr: '기출 시험' , icon: 'spark' },
  { key: 'uploads', label: 'Uploads', kr: '자료 업로드', icon: 'upload' },
];

function ReviewLibrary(): JSX.Element {
  const navigate = useNavigate();

  return (
    <section className="screen km-library" aria-labelledby="review-title">
      <Topbar
        krTitle={<span id="review-title">복습 · Review</span>}
        eyebrow="Library · 자료실"
      />

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
                    <span className="km-library__rowlabel">{row.label}</span>
                    <span className="kr km-library__rowkr">{row.kr}</span>
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              ) : (
                <div className="km-library__row km-library__row--soon">
                  <Icon name={row.icon} size={20} />
                  <span className="km-library__rowmeta">
                    <span className="km-library__rowlabel">{row.label}</span>
                    <span className="kr km-library__rowkr">{row.kr}</span>
                  </span>
                  <Pill>Coming soon</Pill>
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
