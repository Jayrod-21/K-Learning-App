/**
 * ReviewLibrary — the /review Library landing (Overhaul P3B, F-042/F-043).
 *
 * Four sections in fixed order — Vocabulary → Grammar → TOPIK exams →
 * Uploads — each navigating to its real route (TOPIK exams lands on the
 * dedicated past-exams surface, F-103; Mistakes is a link inside THAT page
 * now, not this shelf's direct target). The P1.2 extras (quick-launch LEARN
 * chips, standalone Mistakes/Dictionary rows, the interim Scan-images row,
 * "coming soon" placeholders) are gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
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

  it('F-042: exactly four sections, in order Vocabulary → Grammar → TOPIK exams → Uploads', () => {
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    const rowText = within(list)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    expect(rowText).toHaveLength(4);
    expect(rowText[0]).toContain('Vocabulary');
    expect(rowText[1]).toContain('Grammar');
    expect(rowText[2]).toContain('TOPIK exams');
    expect(rowText[3]).toContain('Uploads');
  });

  it.each([
    ['Vocabulary', '/review/vocab'],
    ['Grammar', '/review/grammar'],
    ['TOPIK exams', '/review/exams'],
    ['Uploads', '/uploads'],
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
    // per row, carrying the per-section tone (F-042's four sections).
    const cards = container.querySelectorAll('.km-library__row .km-citycard');
    expect(cards).toHaveLength(4);
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
    // Nothing else is interactive: the four section rows are the ONLY
    // buttons on the page.
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });
});

/**
 * Device-adaptive epic, Phase D2 — the Library shelves as a two-column grid
 * at tablet/desktop.
 *
 * `useDeviceClass` reads `window.matchMedia`; `src/test/setup.ts` installs a
 * `matches: false` default before every test (mobile-first baseline), so
 * every test ABOVE this block already exercises the mobile branch without
 * explicit stubbing. This block stubs `matchMedia` to report tablet/desktop
 * widths (the same `mockViewportWidth` idiom as Today.test.tsx's D1 block /
 * `useDeviceClass.test.tsx`) to pin the grid modifier, and re-confirms the
 * mobile class string is byte-identical at an explicit narrow width too.
 *
 * jsdom does no layout, so the grid GEOMETRY (fixed 2 columns, the orphan
 * guard) is pinned at the CSS source level — same technique as Today's D1
 * fix-pass tests — with correctness established by construction in
 * ReviewLibrary.css's width-arithmetic comment.
 */
describe('ReviewLibrary — device-adaptive grid layout (Phase D2)', () => {
  function mockViewportWidth(width: number): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => {
        const m = /min-width:\s*(\d+)px/.exec(query);
        const threshold = m ? Number(m[1]) : 0;
        return {
          matches: width >= threshold,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        } as unknown as MediaQueryList;
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mobile (default test matchMedia): the list class string is byte-identical to pre-D2 — no grid modifier', () => {
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    // Exact class attribute, not a substring check — the D2 contract is that
    // the mobile DOM does not change AT ALL, modifier included.
    expect(list.getAttribute('class')).toBe('km-library__list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  });

  it('mobile at an explicit narrow viewport (375px): still no grid modifier', () => {
    mockViewportWidth(375);
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    expect(list.getAttribute('class')).toBe('km-library__list');
  });

  it('tablet (768px): the list carries the --grid modifier with all four shelves still present, in order', () => {
    mockViewportWidth(768);
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    expect(list.getAttribute('class')).toBe(
      'km-library__list km-library__list--grid',
    );
    const rowText = within(list)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    expect(rowText).toHaveLength(4);
    expect(rowText[0]).toContain('Vocabulary');
    expect(rowText[1]).toContain('Grammar');
    expect(rowText[2]).toContain('TOPIK exams');
    expect(rowText[3]).toContain('Uploads');
  });

  it('desktop (1280px): same --grid modifier (tablet and desktop share the one 2-column layout)', () => {
    mockViewportWidth(1280);
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    expect(list.getAttribute('class')).toBe(
      'km-library__list km-library__list--grid',
    );
  });

  it('a shelf in the grid branch keeps its exact navigation — layout never drops onClick behavior', async () => {
    mockViewportWidth(1024);
    const user = userEvent.setup();
    renderLibrary();
    const list = screen.getByRole('list', { name: 'Library sections' });
    await user.click(within(list).getByRole('button', { name: /Vocabulary/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/review/vocab');
  });

  it('CSS: the --grid modifier is a FIXED 2-column grid gated behind ≥768px — the geometry the no-orphan arithmetic depends on', () => {
    // 4 shelves ÷ 2 columns = a clean 2×2 at every ≥768px width. Pin the
    // exact `grid-template-columns` so a future edit to auto-fit (which
    // computes 3 columns from ~976px viewport and would strand the fourth
    // shelf alone in row 2 — see the arithmetic in ReviewLibrary.css) can't
    // slip through as an innocuous-looking tweak.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'ReviewLibrary.css'),
      'utf8',
    );
    const mediaBlock =
      /@media \(min-width: 768px\) \{\s*\.km-library__list--grid \{[\s\S]*?\n\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(mediaBlock).not.toBe('');
    expect(mediaBlock).toContain('display: grid;');
    expect(mediaBlock).toContain(
      'grid-template-columns: repeat(2, minmax(0, 1fr));',
    );
  });

  it('CSS: the orphan guard spans a trailing odd shelf full-width (inert at the current even count, mirrors the D1 fix-pass rule)', () => {
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'ReviewLibrary.css'),
      'utf8',
    );
    expect(stylesheet).toContain(
      ":last-child:nth-child(odd)",
    );
    const guardBlock =
      /\.km-library__list--grid > \[role='listitem'\]:last-child:nth-child\(odd\) \{[\s\S]*?\}/.exec(
        stylesheet,
      )?.[0] ?? '';
    expect(guardBlock).toContain('grid-column: 1 / -1;');
  });
});
