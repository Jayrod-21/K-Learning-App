/**
 * Today — the action hub (Overhaul P1.2, Slice A): loading + rendered +
 * interaction.
 *
 * We mock `useEndpointOrMock` to control the data the screen reads. Both
 * fetches (today plan + the F-007 open-exam lookup) share the same hook, so
 * we dispatch on the `key` arg. Both are realFn-backed (`/plan/today`,
 * `/topik/attempt`); the hook mock here stands in for any source, so the
 * screen assertions hold regardless of which resolved. `services/topik` is
 * also mocked so the realFn closure can never touch the network.
 *
 * P1.2 contract pinned here: Today NO LONGER renders the F-017 stats
 * carousel or the compact SkillsCompare TOPIK-level snapshot (both moved to
 * Progress — see Progress.test.tsx); it DOES render the R/L/W task carousel,
 * the grammar-practice + TOPIK-recommendation placeholders, the open-exam
 * panel, and the review-mistakes shortcut.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TodayPlan } from '../types/domain';
import type { AttemptState } from '../services/topik';

// Hook mock — control loading + data per key. `vi.hoisted` is necessary
// because `vi.mock` is hoisted above imports; sharing mutable state requires
// the holder to be hoisted too, otherwise the factory hits TDZ.
const hoisted = vi.hoisted(() => {
  type HookState =
    | { kind: 'loading' }
    | { kind: 'data'; data: unknown };
  return {
    today: { state: { kind: 'loading' } as HookState },
    attempt: { state: { kind: 'loading' } as HookState },
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    const s = key === 'today' ? hoisted.today.state : hoisted.attempt.state;
    if (s.kind === 'loading') {
      return {
        data: null,
        loading: true,
        error: null,
        isMock: false,
        refetch: () => undefined,
      };
    }
    return {
      data: s.data,
      loading: false,
      error: null,
      isMock: true,
      refetch: () => undefined,
    };
  },
}));

// The screen imports `fetchAttempt` for its realFn; with the hook mocked it
// is never invoked, but mock the module anyway so no test path can reach the
// real axios layer.
vi.mock('../services/topik', () => ({
  fetchAttempt: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));

// Pull the page AFTER the hook mock is set up so the screen wires to it.
import { Today } from './Today';

const PLAN: TodayPlan = {
  reviewCount: 24,
  reading: { title: '도시화와 환경', mins: 3, level: 'L4', tag: 'Reading' },
  listening: {
    title: 'KBS — 재택근무 확산',
    mins: 4,
    level: 'L3→L4',
    tag: 'Listening',
  },
  writing: {
    title: 'Paragraph in 합쇼체',
    mins: 8,
    level: 'L4',
    tag: 'Writing',
  },
  largestGap: 'Listening',
};

/** A saved F-007 mock attempt, as GET /topik/attempt returns it. */
const ATTEMPT: AttemptState = {
  section: 'listening',
  sourceTest: 60,
  currentIdx: 12,
  picks: { '101': 'a', '102': 'c' },
  remainingMs: 1_260_000,
  answered: 12,
  updatedAt: '2026-07-01T09:00:00.000Z',
};

function renderTodayAt(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Today />} />
        {/* Overhaul targets: the review-queue CTA lands on the re-homed
            flashcards page; task tiles land on /learn/*; the exam panel on
            /learn/topik; the shortcut row on /review/mistakes. */}
        <Route path="/learn/vocab" element={<div>FLASHCARDS PAGE</div>} />
        <Route path="/learn/writing" element={<div>WRITING PAGE</div>} />
        <Route path="/learn/topik" element={<div>TOPIK PAGE</div>} />
        <Route path="/review/mistakes" element={<div>MISTAKES PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Load both sources with the happy-path fixtures (no saved attempt). */
function loadDefaults(): void {
  hoisted.today.state = { kind: 'data', data: PLAN };
  hoisted.attempt.state = { kind: 'data', data: null };
}

describe('Today', () => {
  beforeEach(() => {
    // Every fetch starts pending; each test opts specific keys into data.
    hoisted.today.state = { kind: 'loading' };
    hoisted.attempt.state = { kind: 'loading' };
  });

  it('renders loading skeletons while the fetches are pending', () => {
    renderTodayAt();
    // Skeleton cards + the exam panel's pending state announce aria-busy.
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the title, review queue lead, and the R/L/W task carousel when loaded', () => {
    loadDefaults();
    renderTodayAt();

    expect(
      screen.getByRole('heading', { level: 1, name: '오늘 · Today' }),
    ).toBeInTheDocument();
    expect(screen.getByText('24 cards due')).toBeInTheDocument();

    // The three tasks are now carousel pages (reshaped from the old grid).
    const region = screen.getByRole('region', { name: "Today's tasks" });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(
      within(region).getAllByRole('tab'),
    ).toHaveLength(3);

    // All three task titles exist in the DOM (off-screen pages included).
    expect(screen.getByText('도시화와 환경')).toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
    // Largest gap pill on Listening tile.
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    // Register drill pill on Writing tile.
    expect(screen.getByText('Register drill')).toBeInTheDocument();
  });

  it('no longer renders the stats carousel or the TOPIK-level snapshot (moved to Progress)', () => {
    loadDefaults();
    renderTodayAt();

    // F-017 "Progress by skill" carousel — moved to the Progress page.
    expect(
      screen.queryByRole('region', { name: 'Progress by skill' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Progress by skill/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: /trend over the last/ }),
    ).not.toBeInTheDocument();

    // Compact SkillsCompare snapshot — its reference radiogroup and skill
    // progressbars must be gone from Today.
    expect(
      screen.queryByRole('radiogroup', { name: 'Reference level' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('singularises the due count at 1 ("1 card due", not "cards")', () => {
    loadDefaults();
    hoisted.today.state = { kind: 'data', data: { ...PLAN, reviewCount: 1 } };
    renderTodayAt();
    expect(screen.getByText('1 card due')).toBeInTheDocument();
    expect(screen.queryByText('1 cards due')).not.toBeInTheDocument();
  });

  it('navigates to /learn/vocab (flashcards) when the review queue card is clicked', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    const cta = screen.getByRole('button', {
      name: /Open review — 24 cards due/,
    });
    await user.click(cta);

    expect(screen.getByText('FLASHCARDS PAGE')).toBeInTheDocument();
  });

  it('navigates to /learn/writing when the Writing task page is clicked (F-001)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    // Writing is carousel page 3 — bring it on-screen via its dot first
    // (off-screen pages are aria-hidden + inert), then tap the tile.
    const region = screen.getByRole('region', { name: "Today's tasks" });
    await user.click(
      within(region).getByRole('tab', { name: 'Page 3 of 3' }),
    );
    const tile = screen.getByRole('button', { name: /Paragraph in/ });
    await user.click(tile);

    expect(screen.getByText('WRITING PAGE')).toBeInTheDocument();
  });

  it('moves the "Largest gap" pill onto the modality named by largestGap', () => {
    // Writing is the weakest skill today → its tile wears "Largest gap" and the
    // "Register drill" copy is suppressed (gap precedence over the default).
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, largestGap: 'Writing' },
    };
    renderTodayAt();

    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.queryByText('Register drill')).not.toBeInTheDocument();
  });

  it('omits a task page whose server task is null (empty corpus)', () => {
    loadDefaults();
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, reading: null },
    };
    renderTodayAt();

    // Reading page gone (2 dots, not 3); listening + writing still render.
    expect(screen.queryByText('도시화와 환경')).not.toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: "Today's tasks" });
    expect(within(region).getAllByRole('tab')).toHaveLength(2);
  });

  // ── Placeholders (P1.2 — real backing lands in P4) ─────────

  it('renders the grammar-practice placeholder as a designed coming-soon panel', () => {
    loadDefaults();
    renderTodayAt();

    expect(screen.getByText('문법 연습 · Grammar practice')).toBeInTheDocument();
    expect(screen.getByText('Daily grammar drills')).toBeInTheDocument();
    // Real copy, not a blank panel.
    expect(
      screen.getByText(/Due grammar patterns queue here/),
    ).toBeInTheDocument();
    // P3b: the trimmed copy is bilingual (kr via <Bilingual/>).
    expect(
      screen.getByText('복습 예정 문형이 여기에 모여요.'),
    ).toBeInTheDocument();
    // Both placeholder slots (grammar + TOPIK recommendation) carry the pill,
    // bilingually (Coming soon · 준비 중).
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    expect(screen.getAllByText('준비 중')).toHaveLength(2);
  });

  it('renders the TOPIK-recommendation placeholder inside the exam carousel', () => {
    loadDefaults();
    renderTodayAt();

    const region = screen.getByRole('region', { name: 'TOPIK exams' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(within(region).getAllByRole('tab')).toHaveLength(2);
    expect(
      within(region).getByText('Recommended for you'),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(/Mock-exam picks based on your practice/),
    ).toBeInTheDocument();
    expect(
      within(region).getByText('맞춤 모의시험 추천이 여기에 나와요.'),
    ).toBeInTheDocument();
  });

  // ── Open exam (F-007 attempt surfaced) ─────────────────────

  it('surfaces a saved mock attempt as a Resume exam CTA that opens /learn/topik', async () => {
    loadDefaults();
    hoisted.attempt.state = { kind: 'data', data: ATTEMPT };
    const user = userEvent.setup();
    renderTodayAt();

    expect(screen.getByText('Exam in progress')).toBeInTheDocument();
    expect(screen.getByText(/Listening mock/)).toBeInTheDocument();
    expect(screen.getByText(/12 answered/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Resume exam/ }));
    expect(screen.getByText('TOPIK PAGE')).toBeInTheDocument();
  });

  it('offers the TOPIK page directly when no attempt is saved (honest empty state)', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    // No fabricated resume: the null attempt reads as "no exam in progress".
    expect(screen.getByText(/No exam in progress/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Resume exam/ }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /Open TOPIK practice/ }),
    );
    expect(screen.getByText('TOPIK PAGE')).toBeInTheDocument();
  });

  // ── Review shortcut ────────────────────────────────────────

  it('navigates to /review/mistakes from the review shortcut row', async () => {
    loadDefaults();
    const user = userEvent.setup();
    renderTodayAt();

    await user.click(
      screen.getByRole('button', { name: /Review mistakes/ }),
    );
    expect(screen.getByText('MISTAKES PAGE')).toBeInTheDocument();
  });
});
