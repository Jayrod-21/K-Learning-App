/**
 * ReviewLibrary — the /review Library landing (Overhaul P3B, F-042/F-043).
 *
 * Five sections in fixed order — Vocabulary → Grammar → TOPIK exams →
 * Uploads → Images — each navigating to its real route (TOPIK exams lands
 * on the dedicated past-exams surface, F-103; Mistakes is a link inside
 * THAT page now, not this shelf's direct target; Images is the F-102
 * `/images` re-entry row, restored after F-042 left the OCR page with no
 * in-app entry point). The P1.2 extras (quick-launch LEARN chips,
 * standalone Mistakes/Dictionary rows, the interim Scan-images row,
 * "coming soon" placeholders) are gone.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import ReviewLibrary from './ReviewLibrary';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function renderLibrary(): void {
  render(
    <MemoryRouter initialEntries={['/review']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <ReviewLibrary />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ReviewLibrary (P3B landing)', () => {
  it('F-043: titles the page "Library" via the nav manifest pair', () => {
    renderLibrary();
    expect(
      screen.getByRole('heading', { level: 1, name: '자료실 · Library' }),
    ).toBeInTheDocument();
    // The retired title must not linger anywhere on the page.
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
    expect(screen.queryByText('복습')).not.toBeInTheDocument();
  });

  it('renders the manifest eyebrow pair (contents summary, both scripts)', () => {
    renderLibrary();
    expect(
      screen.getByText('Vocabulary · grammar · exams · uploads'),
    ).toBeInTheDocument();
    expect(screen.getByText('단어 · 문법 · 기출 · 업로드')).toBeInTheDocument();
  });

  // S1 (`REVIEW_batch2-fidelity.md`) — this page's root was missing
  // `.km-rain-sheen` (device #8, Night ambient) while every sibling Library
  // page carries it. Fixed in the batch-2 fix-pass.
  it('carries the km-rain-sheen ambient overlay on the page root (S1)', () => {
    renderLibrary();
    expect(
      document.querySelector('.screen.km-library.km-rain-sheen'),
    ).toBeInTheDocument();
  });

  it('F-042 + F-102: exactly five sections, in order Vocabulary → Grammar → TOPIK exams → Uploads → Images', () => {
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    const rowText = within(list)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    expect(rowText).toHaveLength(5);
    expect(rowText[0]).toContain('Vocabulary');
    expect(rowText[1]).toContain('Grammar');
    expect(rowText[2]).toContain('TOPIK exams');
    expect(rowText[3]).toContain('Uploads');
    // F-102 — the /images re-entry row, LAST (grouped with Uploads at the
    // "your own material" end of the shelf).
    expect(rowText[4]).toContain('Images');
  });

  it.each([
    ['Vocabulary', '/review/vocab'],
    ['Grammar', '/review/grammar'],
    ['TOPIK exams', '/review/exams'],
    ['Uploads', '/uploads'],
    // F-102 — the OCR image-mining page's restored in-app entry point.
    ['Images', '/images'],
  ])('navigates the %s section to %s on tap', async (label, target) => {
    const user = userEvent.setup();
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    await user.click(
      within(list).getByRole('button', { name: new RegExp(label) }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent(target);
  });

  it('the TOPIK exams shelf lands on the dedicated past-exams surface (F-103)', async () => {
    // F-103 shipped: the shelf now targets the real past-exams page instead
    // of the Mistakes stub-wiring (F-042). Mistakes is reachable as a link
    // INSIDE that page now (see PastExams.tsx), not this shelf's own target.
    const user = userEvent.setup();
    renderLibrary();
    const row = screen.getByRole('button', { name: /TOPIK exams/ });
    expect(row).toHaveTextContent('기출 시험');
    await user.click(row);
    expect(screen.getByTestId('location')).toHaveTextContent('/review/exams');
  });

  it('F-128: reskins with the hub-header recipe — skyline + dancheong rail + a CityCard per row', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/review']}>
        <Routes>
          <Route path="*" element={<ReviewLibrary />} />
        </Routes>
      </MemoryRouter>,
    );
    // Device #4 — the Namsan skyline strip carries the real <h1> (same hub
    // recipe as Today/Progress).
    expect(container.querySelector('.km-skyline')).not.toBeNull();
    // Device #2 — the dancheong-rail divider under the skyline.
    expect(container.querySelector('.km-dancheong-rail')).not.toBeNull();
    // Device #1 — every section row is now a CityCard-backed signboard, one
    // per row, carrying the per-section tone (F-042's four sections + the
    // F-102 Images re-entry row).
    const cards = container.querySelectorAll('.km-library__row .km-citycard');
    expect(cards).toHaveLength(5);
    expect(container.querySelector('.km-tone--accent')).not.toBeNull();
    expect(container.querySelector('.km-tone--blue')).not.toBeNull();
    expect(container.querySelector('.km-tone--mint')).not.toBeNull();
    expect(container.querySelector('.km-tone--plain')).not.toBeNull();
  });

  it('renders each section bilingually with its contents description', () => {
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    // Titles carry both scripts (both-mode default renders "kr · en").
    expect(within(list).getByText('단어')).toBeInTheDocument();
    expect(within(list).getByText('Vocabulary')).toBeInTheDocument();
    // Description line: compact bilingual — Korean visible in ko-primary
    // both-mode, the English half preserved in the accessible reading.
    // (`getAllByText`: the compact variant renders the visible segment AND
    // an sr-only copy carrying the same Korean string.)
    expect(within(list).getAllByText('말뭉치 · 내 단어장')).not.toHaveLength(0);
    expect(within(list).getByText('Corpus · my lists')).toBeInTheDocument();
    // F-103: the exams shelf's description now sources from the dedicated
    // past-exams NavItem's own eyebrow pair, not a hardcoded Mistakes blurb.
    // Batch-2 fix-pass SHOULD-FIX 2: this eyebrow was reworded off of
    // `AttemptsReview`'s verbatim-identical text — see `nav.ts`'s
    // `review-exams` entry for the full rationale.
    expect(within(list).getAllByText('기출 자료실 · 재응시')).not.toHaveLength(0);
    expect(
      within(list).getByText('Exam library · re-enter & retake'),
    ).toBeInTheDocument();
  });

  it('F-042: the removed P1.2 surfaces are gone — chips, extra rows, placeholders', () => {
    renderLibrary();
    // Quick-launch hot-buttons into LEARN: removed (the hexagon owns LEARN).
    expect(
      screen.queryByRole('group', { name: 'Quick launch' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /flashcards/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /drill/i }),
    ).not.toBeInTheDocument();
    // Standalone Dictionary + interim Scan-images rows: removed (Dictionary
    // stays reachable via LibrarySubnav on the browse sub-pages).
    expect(screen.queryByText('Dictionary')).not.toBeInTheDocument();
    expect(screen.queryByText('Scan images')).not.toBeInTheDocument();
    // Inert "coming soon" placeholders: removed — every row navigates.
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    expect(screen.queryByText('준비 중')).not.toBeInTheDocument();
    // Nothing else is interactive: the five section rows (four F-042
    // shelves + the F-102 Images re-entry) are the ONLY buttons on the page.
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });
});
