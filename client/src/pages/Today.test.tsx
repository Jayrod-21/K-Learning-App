/**
 * Today — loading + rendered + interaction.
 *
 * We mock `useEndpointOrMock` to control the data the screen reads. All
 * three fetches (today plan + diagnostic snapshot + F-017 skill series)
 * share the same hook, so we dispatch on the `key` arg. All are
 * realFn-backed (`/plan/today`, `/diagnostic/latest`, the `/…/series`
 * fan-out); the hook mock here stands in for any source, so the screen
 * assertions hold regardless of which resolved. `services/stats` is also
 * mocked so the realFn closure can never touch the network.
 *
 * Interaction: clicking the Review queue card navigates to /review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  AllSkillSeries,
  TodayPlan,
  DiagnosticSnapshot,
} from '../types/domain';

// Hook mock — control loading + data per key. `vi.hoisted` is necessary
// because `vi.mock` is hoisted above imports; sharing mutable state requires
// the holder to be hoisted too, otherwise the factory hits TDZ.
const hoisted = vi.hoisted(() => {
  type HookState =
    | { kind: 'loading' }
    | { kind: 'data'; data: unknown };
  return {
    today: { state: { kind: 'loading' } as HookState },
    diag: { state: { kind: 'loading' } as HookState },
    series: { state: { kind: 'loading' } as HookState },
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    const s =
      key === 'today'
        ? hoisted.today.state
        : key === 'today.snapshot'
          ? hoisted.diag.state
          : hoisted.series.state;
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

// The screen imports `fetchSkillSeries` for its realFn; with the hook mocked
// it is never invoked, but mock the module anyway so no test path can reach
// the real axios layer.
vi.mock('../services/stats', () => ({
  fetchSkillSeries: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
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

const SERIES: AllSkillSeries = {
  reading: {
    metric: 'accuracy',
    unit: '%',
    points: [
      { date: '2026-06-08', value: 58 },
      { date: '2026-06-15', value: 66 },
      { date: '2026-06-30', value: 74 },
    ],
  },
  listening: {
    metric: 'accuracy',
    unit: '%',
    points: [
      { date: '2026-06-09', value: 42 },
      { date: '2026-06-30', value: 58 },
    ],
  },
  vocab: {
    metric: 'count',
    unit: 'cards',
    points: [
      { date: '2026-06-08', value: 12 },
      { date: '2026-06-29', value: 35 },
    ],
  },
  grammar: {
    metric: 'accuracy',
    unit: '%',
    points: [
      { date: '2026-06-10', value: 39 },
      { date: '2026-06-30', value: 52 },
    ],
  },
  writing: { metric: 'none', unit: '', points: [] },
};

const SNAP: DiagnosticSnapshot = {
  dimensions: [
    { key: 'reading', label: 'Reading', kr: '읽기', score: 62, note: 'n' },
    // Pass 5 adds grammar to the dimension union; the snapshot card renders it
    // generically (SkillsCompare keys on the string `key`), so it must survive.
    { key: 'grammar', label: 'Grammar', kr: '문법', score: 48, note: 'g' },
  ],
  references: [
    { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
  ],
  defaultRef: 'L4',
  goals: [],
};

function renderTodayAt(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/review" element={<div>REVIEW PAGE</div>} />
        <Route path="/writing" element={<div>WRITING PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Today', () => {
  beforeEach(() => {
    // Every fetch starts pending; each test opts specific keys into data.
    hoisted.today.state = { kind: 'loading' };
    hoisted.diag.state = { kind: 'loading' };
    hoisted.series.state = { kind: 'loading' };
  });

  it('renders loading skeletons while both fetches are pending', () => {
    hoisted.today.state = { kind: 'loading' };
    hoisted.diag.state = { kind: 'loading' };

    renderTodayAt();
    // Skeleton cards announce aria-busy="true".
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the Korean title, review queue, and three task cards when loaded', () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    renderTodayAt();

    expect(screen.getByText('오늘 · Today')).toBeInTheDocument();
    expect(screen.getByText('24 cards due')).toBeInTheDocument();
    expect(screen.getByText('도시화와 환경')).toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
    // Largest gap pill on Listening tile.
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    // Register drill pill on Writing tile.
    expect(screen.getByText('Register drill')).toBeInTheDocument();
  });

  it('singularises the due count at 1 ("1 card due", not "cards")', () => {
    hoisted.today.state = { kind: 'data', data: { ...PLAN, reviewCount: 1 } };
    hoisted.diag.state = { kind: 'data', data: SNAP };
    renderTodayAt();
    expect(screen.getByText('1 card due')).toBeInTheDocument();
    expect(screen.queryByText('1 cards due')).not.toBeInTheDocument();
  });

  it('navigates to /review when the review queue card is clicked', async () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    const user = userEvent.setup();
    renderTodayAt();

    const cta = screen.getByRole('button', {
      name: /Open review — 24 cards due/,
    });
    await user.click(cta);

    expect(screen.getByText('REVIEW PAGE')).toBeInTheDocument();
  });

  it('navigates to /writing when the Writing task tile is clicked (F-001)', async () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    const user = userEvent.setup();
    renderTodayAt();

    // The tile is one big <button>; its accessible name includes the task
    // title. Previously this tile pointed at /grammar (no Writing screen
    // existed) — it must now land on the real /writing grader.
    const tile = screen.getByRole('button', { name: /Paragraph in/ });
    await user.click(tile);

    expect(screen.getByText('WRITING PAGE')).toBeInTheDocument();
  });

  it('moves the "Largest gap" pill onto the modality named by largestGap', () => {
    // Writing is the weakest skill today → its tile wears "Largest gap" and the
    // "Register drill" copy is suppressed (gap precedence over the default).
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, largestGap: 'Writing' },
    };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    renderTodayAt();

    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.queryByText('Register drill')).not.toBeInTheDocument();
  });

  it('omits a task tile whose server task is null (empty corpus)', () => {
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, reading: null },
    };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    renderTodayAt();

    // Reading tile gone; listening + writing still render.
    expect(screen.queryByText('도시화와 환경')).not.toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
  });

  // ── Progress-by-skill carousel (F-017) ─────────────────────

  it('renders the Progress by skill carousel card with the series data', () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };
    hoisted.series.state = { kind: 'data', data: SERIES };

    renderTodayAt();

    // Bilingual card heading, consistent with the page's other sections.
    expect(
      screen.getByText('실력 추이 · Progress by skill'),
    ).toBeInTheDocument();

    // The carousel region is present with one dot per skill (5 pages).
    const region = screen.getByRole('region', { name: 'Progress by skill' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(screen.getAllByRole('tab')).toHaveLength(5);

    // First panel (Reading) is the active page and shows its latest value.
    const firstPanel = screen.getAllByRole('tabpanel', { hidden: true })[0];
    expect(firstPanel).toHaveAttribute('aria-hidden', 'false');
    expect(firstPanel).toHaveTextContent('Reading');
    expect(firstPanel).toHaveTextContent('74%');
    expect(
      screen.getByRole('img', { name: 'Reading trend over the last 30 days' }),
    ).toBeInTheDocument();
  });

  it('renders the Writing page as a placeholder (no series route yet)', () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };
    hoisted.series.state = { kind: 'data', data: SERIES };

    renderTodayAt();

    expect(
      screen.getByText('Start writing to see your progress here.'),
    ).toBeInTheDocument();
  });

  it('navigates carousel pages via the dots (Vocab shows its count)', async () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };
    hoisted.series.state = { kind: 'data', data: SERIES };

    const user = userEvent.setup();
    renderTodayAt();

    // Page order is Reading, Listening, Vocab, Grammar, Writing → Vocab = 3.
    await user.click(screen.getByRole('tab', { name: 'Page 3 of 5' }));

    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(panels[2]).toHaveAttribute('aria-hidden', 'false');
    expect(panels[2]).toHaveTextContent('Vocab');
    expect(panels[2]).toHaveTextContent('35 cards');
  });

  it('keeps the SkillsCompare snapshot card alongside the carousel', () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };
    hoisted.series.state = { kind: 'data', data: SERIES };

    renderTodayAt();

    // The snapshot card (complementary, not replaced) still renders its
    // dimensions while the carousel card renders below it.
    expect(
      screen.getByRole('progressbar', { name: 'Grammar skill' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('실력 추이 · Progress by skill'),
    ).toBeInTheDocument();
  });
});
