/**
 * Progress page (the P1.2 stats hub) — compare surface + trend chart +
 * per-skill trends carousel + mastery over a mocked `useEndpointOrMock`
 * (same harness style as Hanja/Diagnostic page tests).
 *
 * The hook is mocked with a per-key dispatch so each test controls the
 * `diagnostic.history` and `progress.series` reads directly; the page's
 * chart geometry is not asserted pixel-by-pixel — behaviour is asserted
 * through the accessible surfaces (chart aria-label, legend, readout,
 * comparison + attempts tables, carousel tabs/panels), which is also what
 * makes the charts usable without a pointer.
 *
 * P1.2 contract pinned here: Progress DOES render the moved F-017 "Progress
 * by skill" carousel and the SkillsCompare `full` headline compare (both
 * moved off Today), the retake-diagnostic button in the POPULATED state, and
 * the grammar-mastery placeholder beside Word mastery. The attempt-vs-attempt
 * delta table is folded into the single compare card, not a second card.
 *
 * Fixtures pass through `vi.hoisted` so the Vitest-hoisted `vi.mock` factory
 * can reference them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import { ApiError } from '../services/api';
import type {
  AllSkillSeries,
  DiagnosticDimension,
  DiagnosticHistoryResponse,
  DiagnosticHistorySnapshot,
  DiagnosticReference,
} from '../types/domain';

const { HISTORY_3 } = vi.hoisted(() => {
  // Type-only imports are erased at compile time, so annotating with the
  // domain types inside the hoisted factory is safe (nothing runs early).
  type DimKey = DiagnosticDimension['key'];
  const REFERENCES: DiagnosticReference[] = [
    { id: 'L3', label: 'TOPIK 3', kr: '3급', value: 40 },
    { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
    { id: 'native', label: 'Native', kr: '원어민', value: 100 },
  ];
  const LABELS: Partial<Record<DimKey, { label: string; kr: string }>> = {
    reading: { label: 'Reading', kr: '읽기' },
    listening: { label: 'Listening', kr: '듣기' },
    vocab: { label: 'Vocabulary', kr: '어휘' },
    grammar: { label: 'Grammar', kr: '문법' },
  };
  const mkSnap = (
    capturedAt: string,
    scores: Partial<Record<DimKey, number>>,
  ): DiagnosticHistorySnapshot => ({
    capturedAt,
    // Object.entries widens the key to string; the fixture only ever passes
    // DimKey keys, so the entry cast restores what the type system dropped.
    dimensions: (Object.entries(scores) as Array<[DimKey, number]>).map(
      ([key, score]) => ({
        key,
        label: LABELS[key]?.label ?? key,
        kr: LABELS[key]?.kr ?? key,
        score,
        // F-011: the trend chart only reads `score`; the degenerate band
        // satisfies the now-required dimension shape.
        scoreLow: score,
        scoreHigh: score,
        note: 'note',
      }),
    ),
    references: REFERENCES,
    defaultRef: 'L4',
    goals: [],
  });
  const history: DiagnosticHistoryResponse = {
    snapshots: [
        // Overall (mean): 42, 53, 67 — a visibly rising trend.
        mkSnap('2026-05-01T09:00:00.000Z', {
          reading: 40,
          listening: 44,
          vocab: 48,
          grammar: 36,
        }),
        mkSnap('2026-05-15T09:00:00.000Z', {
          reading: 55,
          listening: 48,
          vocab: 60,
          grammar: 49,
        }),
        mkSnap('2026-06-01T09:00:00.000Z', {
          reading: 70,
          listening: 62,
          vocab: 75,
          grammar: 61,
        }),
      ],
  };
  return { HISTORY_3: history };
});

// F-017 skill-series fixture (moved with the carousel from Today.test.tsx).
// Real wire shapes: TOPIK skills are accuracy/%, vocab counts REVIEWS,
// grammar is score/pts, writing is score/% (F-014 normalized grade score) —
// together they exercise all three wire metrics in render.
const { SKILL_SERIES } = vi.hoisted(() => {
  const series: AllSkillSeries = {
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
      unit: 'reviews',
      points: [
        { date: '2026-06-08', value: 12 },
        { date: '2026-06-29', value: 35 },
      ],
    },
    grammar: {
      metric: 'score',
      unit: 'pts',
      points: [
        { date: '2026-06-10', value: 39 },
        { date: '2026-06-30', value: 52 },
      ],
    },
    writing: {
      metric: 'score',
      unit: '%',
      points: [
        { date: '2026-06-16', value: 60 },
        { date: '2026-06-30', value: 72 },
      ],
    },
  };
  return { SKILL_SERIES: series };
});

const refetchSpy = vi.hoisted(() => vi.fn());
const seriesRefetchSpy = vi.hoisted(() => vi.fn());

// The Word Mastery section fetches directly (not via useEndpointOrMock).
const masterySvc = vi.hoisted(() => ({ fetchMastery: vi.fn() }));
const { MASTERY_DEFAULT } = vi.hoisted(() => ({
  MASTERY_DEFAULT: {
    summary: { new: 10, learning: 5, reviewing: 2, mastered: 3, total: 20 },
    words: [
      {
        id: 1,
        korean: '사랑',
        english: 'love',
        bucket: 'mastered',
        stability: 30,
        reps: 4,
        lapses: 0,
        dueAt: null,
      },
      {
        id: 2,
        korean: '먹다',
        english: 'to eat',
        bucket: 'learning',
        stability: 6,
        reps: 1,
        lapses: 0,
        dueAt: null,
      },
    ],
    total: 20,
  },
}));

// Per-test overrides, one per hook key — `{}` means "use the default".
type HookResult = UseEndpointOrMockResult<unknown>;
const hookOverride = vi.hoisted(() => ({ current: {} as Partial<HookResult> }));
const seriesOverride = vi.hoisted(() => ({ current: {} as Partial<HookResult> }));

function hookResult(): HookResult {
  const base: HookResult = {
    data: HISTORY_3,
    loading: false,
    error: null,
    isMock: false,
    refetch: refetchSpy,
  };
  return { ...base, ...hookOverride.current };
}

function seriesResult(): HookResult {
  const base: HookResult = {
    data: SKILL_SERIES,
    loading: false,
    error: null,
    isMock: false,
    refetch: seriesRefetchSpy,
  };
  return { ...base, ...seriesOverride.current };
}

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: vi.fn((key: string) =>
    key === 'progress.series' ? seriesResult() : hookResult(),
  ),
}));
vi.mock('../services/vocab', () => masterySvc);
// The page imports `fetchSkillSeries` for its realFn; with the hook mocked
// it is never invoked, but mock the module anyway so no test path can reach
// the real axios layer.
vi.mock('../services/stats', () => ({
  fetchSkillSeries: vi.fn(() => Promise.reject(new Error('not wired in tests'))),
}));

// Import after the mock so it is in place.
import Progress from './Progress';

function historyOf(count: number): DiagnosticHistoryResponse {
  return { snapshots: HISTORY_3.snapshots.slice(0, count) };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Progress />} />
        {/* Retake-diagnostic target (P1.2 populated-state CTA). */}
        <Route path="/diagnostic" element={<div>DIAGNOSTIC PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  refetchSpy.mockClear();
  seriesRefetchSpy.mockClear();
  hookOverride.current = {};
  seriesOverride.current = {};
  masterySvc.fetchMastery.mockReset();
  masterySvc.fetchMastery.mockResolvedValue(MASTERY_DEFAULT);
});

describe('Progress page — trend', () => {
  it('renders the chart, legend, and the all-attempts table from history', () => {
    renderPage();

    expect(
      screen.getByRole('img', {
        name: /Line chart of diagnostic scores across 3 attempts/,
      }),
    ).toBeInTheDocument();

    // Legend names every series — identity never rides on color alone.
    // P3b: each entry is a <Bilingual/> pair (Korean-first in the default
    // both-mode), so assert on the composed text content.
    const legend = screen.getByRole('list', { name: 'Chart series' });
    for (const pair of [
      '읽기 · Reading',
      '듣기 · Listening',
      '어휘 · Vocabulary',
      '문법 · Grammar',
      '전체 · Overall',
    ]) {
      expect(legend).toHaveTextContent(pair);
    }

    // The table twin carries every plotted value, oldest first.
    const table = screen.getByRole('table', { name: /All diagnostic attempts/ });
    const rows = within(table).getAllByRole('row');
    // header + 3 attempts
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText('40')).toBeInTheDocument(); // attempt 1 reading
    expect(within(rows[3]!).getByText('70')).toBeInTheDocument(); // attempt 3 reading
    expect(within(rows[3]!).getByText('67')).toBeInTheDocument(); // attempt 3 overall (derived mean)
  });

  it('defaults the readout to the latest attempt and follows hover/focus', async () => {
    const user = userEvent.setup();
    renderPage();

    // Without any pointer, the latest attempt's values are already visible.
    // (Scoped to the TREND readout live region — the comparison pickers'
    // options render the same "Attempt N · date" text, and the carousel's
    // active LineChart carries its own role="status" readout.)
    const readout = screen
      .getAllByRole('status')
      .find((el) => /Attempt \d/.test(el.textContent ?? ''));
    expect(readout).toBeDefined();
    expect(within(readout!).getByText(/Attempt 3 · 6\/1/)).toBeInTheDocument();

    // Hovering an attempt's hit column moves the readout to that attempt.
    await user.hover(screen.getByRole('button', { name: /^Attempt 1, 5\/1/ }));
    expect(within(readout!).getByText(/Attempt 1 · 5\/1/)).toBeInTheDocument();

    // The hit column's accessible name carries the same values as the hover.
    expect(
      screen.getByRole('button', {
        name: 'Attempt 1, 5/1: Reading 40, Listening 44, Vocabulary 48, Grammar 36, Overall 42',
      }),
    ).toBeInTheDocument();
  });

  it('renders a dash for a dimension missing from one attempt (no crash)', () => {
    const partial = historyOf(2);
    // Attempt 2 loses grammar (an empty item pool can drop a dimension).
    const second = partial.snapshots[1] as DiagnosticHistorySnapshot;
    partial.snapshots[1] = {
      ...second,
      dimensions: second.dimensions.filter((d) => d.key !== 'grammar'),
    };
    hookOverride.current = { data: partial };
    renderPage();

    const table = screen.getByRole('table', { name: /All diagnostic attempts/ });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[2]!).getByText('—')).toBeInTheDocument();
  });
});

describe('Progress page — compare surface (P1.2 reconciliation)', () => {
  it('renders ONE compare card: SkillsCompare full headline over the latest attempt', () => {
    renderPage();

    expect(screen.getByText('Where you stand')).toBeInTheDocument();

    // The moved TOPIK-level display: full-variant SkillsCompare with the
    // reference picker (TOPIK levels through the Native ceiling)…
    const picker = screen.getByRole('radiogroup', { name: 'Reference level' });
    expect(within(picker).getByRole('radio', { name: 'TOPIK 3' })).toBeInTheDocument();
    expect(within(picker).getByRole('radio', { name: 'TOPIK 4' })).toBeInTheDocument();
    expect(within(picker).getByRole('radio', { name: 'Native' })).toBeInTheDocument();
    // …and exactly ONE such picker — one compare surface, not two widgets.
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);

    // The bars carry the LATEST attempt's scores (70/62/75/61).
    const reading = screen.getByRole('progressbar', { name: 'Reading skill' });
    expect(reading).toHaveAttribute('aria-valuenow', '70');
    expect(
      screen.getByRole('progressbar', { name: 'Grammar skill' }),
    ).toHaveAttribute('aria-valuenow', '61');

    // Full mode (not the old Today compact): the legend explains the marks.
    expect(screen.getByText('At / above')).toBeInTheDocument();
  });

  it('folds attempt-vs-attempt into the compare card with signed per-dimension deltas', () => {
    renderPage();

    // The sub-block lives under the headline compare, defaulting to
    // previous vs latest.
    expect(screen.getByText('Attempt vs attempt')).toBeInTheDocument();
    const table = screen.getByRole('table', {
      name: /Score change from attempt 2 to attempt 3/,
    });
    // Reading 55 → 70 and Vocabulary 60 → 75 both rise by 15.
    expect(within(table).getAllByText('▲ +15')).toHaveLength(2);
    // Listening 48 → 62 and Overall 53 → 67 both rise by 14.
    expect(within(table).getAllByText('▲ +14')).toHaveLength(2);
    // Grammar 49 → 61.
    expect(within(table).getByText('▲ +12')).toBeInTheDocument();
  });

  it('recomputes the deltas when the From attempt changes', async () => {
    const user = userEvent.setup();
    renderPage();

    // P3b: the label is bilingual — the accessible name carries both halves.
    await user.selectOptions(screen.getByRole('combobox', { name: /From/ }), '0');

    const table = screen.getByRole('table', {
      name: /Score change from attempt 1 to attempt 3/,
    });
    // Reading 40 → 70.
    expect(within(table).getByText('▲ +30')).toBeInTheDocument();
  });

  it('shows the retake-diagnostic button in the POPULATED state and navigates', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole('button', { name: /Retake diagnostic/ }),
    );
    expect(screen.getByText('DIAGNOSTIC PAGE')).toBeInTheDocument();
  });
});

describe('Progress page — per-skill trends carousel (F-017, moved from Today)', () => {
  it('renders the Progress by skill carousel card with the series data', () => {
    renderPage();

    expect(screen.getByText('Progress by skill')).toBeInTheDocument();

    // The carousel region is present with one dot per skill (5 pages).
    const region = screen.getByRole('region', { name: 'Progress by skill' });
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(within(region).getAllByRole('tab')).toHaveLength(5);

    // First panel (Reading) is the active page and shows its latest value.
    const firstPanel = within(region).getAllByRole('tabpanel', {
      hidden: true,
    })[0];
    expect(firstPanel).toHaveAttribute('aria-hidden', 'false');
    expect(firstPanel).toHaveTextContent('Reading');
    expect(firstPanel).toHaveTextContent('74%');
    expect(
      screen.getByRole('img', { name: 'Reading trend over the last 30 days' }),
    ).toBeInTheDocument();
  });

  it('navigates carousel pages via the dots (Vocab shows its count)', async () => {
    const user = userEvent.setup();
    renderPage();

    const region = screen.getByRole('region', { name: 'Progress by skill' });
    // Page order is Reading, Listening, Vocab, Grammar, Writing → Vocab = 3.
    await user.click(
      within(region).getByRole('tab', { name: 'Page 3 of 5' }),
    );

    const panels = within(region).getAllByRole('tabpanel', { hidden: true });
    expect(panels[2]).toHaveAttribute('aria-hidden', 'false');
    expect(panels[2]).toHaveTextContent('Vocab');
    expect(panels[2]).toHaveTextContent('35 reviews');
  });

  it('renders the Grammar page with the score metric (score/pts wire shape)', async () => {
    const user = userEvent.setup();
    renderPage();

    const region = screen.getByRole('region', { name: 'Progress by skill' });
    // Grammar is page 4. Its series is `metric: 'score'` + `unit: 'pts'` on
    // the real wire — this pins the score render path (headline "N pts" +
    // a real chart), which the count metric (Vocab) does not exercise.
    await user.click(within(region).getByRole('tab', { name: 'Page 4 of 5' }));

    const panels = within(region).getAllByRole('tabpanel', { hidden: true });
    expect(panels[3]).toHaveAttribute('aria-hidden', 'false');
    expect(panels[3]).toHaveTextContent('Grammar');
    expect(panels[3]).toHaveTextContent('52 pts');
    expect(
      screen.getByRole('img', { name: 'Grammar trend over the last 30 days' }),
    ).toBeInTheDocument();
  });

  it('renders the Writing page as a real chart when it has points (F-014)', async () => {
    const user = userEvent.setup();
    renderPage();

    const region = screen.getByRole('region', { name: 'Progress by skill' });
    // Writing is page 5. Its series is `metric: 'score'` + `unit: '%'` on
    // the real wire — the headline formats as a percent and a REAL chart
    // renders: no invitation, no placeholder. This is the POSITIVE F-014
    // path; the empty/failed negatives below don't cover it.
    await user.click(within(region).getByRole('tab', { name: 'Page 5 of 5' }));

    const panels = within(region).getAllByRole('tabpanel', { hidden: true });
    expect(panels[4]).toHaveAttribute('aria-hidden', 'false');
    expect(panels[4]).toHaveTextContent('Writing');
    expect(panels[4]).toHaveTextContent('72%');
    expect(
      screen.getByRole('img', { name: 'Writing trend over the last 30 days' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Start writing to see your progress here.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the invitation only when the writing series is EMPTY', () => {
    seriesOverride.current = {
      data: {
        ...SKILL_SERIES,
        writing: { metric: 'score', unit: '%', points: [] },
      },
    };
    renderPage();

    expect(
      screen.getByText('Start writing to see your progress here.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: 'Writing trend over the last 30 days' }),
    ).not.toBeInTheDocument();
  });

  it('marks the Writing panel "Couldn’t load this trend." when its route failed', () => {
    // fetchSkillSeries degrades a failed /writing/series to the metric:'none'
    // placeholder — the panel must read as a FAILED FETCH (F-UP-016a), never
    // as the fresh-account "No data yet" empty state, never an invitation as
    // if the user had never written, and never fabricated points.
    seriesOverride.current = {
      data: {
        ...SKILL_SERIES,
        writing: { metric: 'none', unit: '', points: [] },
      },
    };
    renderPage();

    expect(screen.getByText('Couldn’t load this trend.')).toBeInTheDocument();
    // A failed panel must NOT masquerade as a genuinely-empty series.
    expect(screen.queryByText('No data yet')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Start writing to see your progress here.'),
    ).not.toBeInTheDocument();
  });

  it('collapses the carousel to an ErrorCard with a live retry on a total outage', async () => {
    // F-UP-016a — ALL series routes failing must read as one honest
    // ErrorCard wired to the series refetch, not five "No data yet" panels.
    const down = { metric: 'none', unit: '', points: [] } as const;
    seriesOverride.current = {
      data: {
        reading: down,
        listening: down,
        vocab: down,
        grammar: down,
        writing: down,
      },
    };
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByText('Progress trends couldn’t be loaded.'),
    ).toBeInTheDocument();
    // No empty-state copy, no per-panel failure copy, no carousel — a total
    // outage is one error, not a fresh account or five broken panels.
    expect(screen.queryByText('No data yet')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Couldn’t load this trend.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tablist', { name: 'Progress by skill pages' }),
    ).not.toBeInTheDocument();

    // Retry is real: it fires the series source's refetch — not the
    // history's (which rendered fine, so this is the only Retry on screen).
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(seriesRefetchSpy).toHaveBeenCalledTimes(1);
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it('renders every panel honestly for a fresh user (all series empty)', () => {
    // The COMMON real state for this app's audience: every series route
    // responds fine with zero activity. Every headline is an em dash; the
    // four charted skills say "No data yet"; writing keeps its invitation.
    // All-empty must NEVER read as the total-outage ErrorCard (that state
    // is `metric: 'none'`) — genuinely empty and failed are different.
    seriesOverride.current = {
      data: {
        reading: { metric: 'accuracy', unit: '%', points: [] },
        listening: { metric: 'accuracy', unit: '%', points: [] },
        vocab: { metric: 'count', unit: 'reviews', points: [] },
        grammar: { metric: 'score', unit: 'pts', points: [] },
        writing: { metric: 'score', unit: '%', points: [] },
      } satisfies AllSkillSeries,
    };
    renderPage();

    // (Scoped to the carousel region — the rest of the Progress page has
    // its own em dashes and copy.)
    const region = screen.getByRole('region', { name: 'Progress by skill' });
    expect(within(region).getAllByText('—')).toHaveLength(5);
    expect(within(region).getAllByText('No data yet')).toHaveLength(4);
    expect(
      within(region).getByText('Start writing to see your progress here.'),
    ).toBeInTheDocument();
    // Not the outage path, no chart images, no NaN/undefined leakage.
    expect(
      screen.queryByText('Progress trends couldn’t be loaded.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: /trend over/ }),
    ).not.toBeInTheDocument();
    expect(region.textContent).not.toMatch(/NaN|undefined/);
  });

  it('renders the trends carousel even with an empty diagnostic history', () => {
    // The carousel is fed by its own fetch — a user with practice activity
    // but zero diagnostic runs still sees their trends (zero regression vs
    // the carousel's old home on Today, which had no history dependency).
    hookOverride.current = { data: { snapshots: [] } };
    renderPage();

    expect(
      screen.getByRole('button', { name: /Take the diagnostic/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Progress by skill' }),
    ).toBeInTheDocument();
  });
});

describe('Progress page — empty / sparse / loading / error states', () => {
  it('invites the user to take the diagnostic when there is no history', () => {
    hookOverride.current = { data: { snapshots: [] } };
    renderPage();

    expect(
      screen.getByRole('button', { name: /Take the diagnostic/ }),
    ).toBeInTheDocument();
    // No history-fed surfaces: neither the attempts/delta tables nor the
    // compare card render without an attempt.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Where you stand')).not.toBeInTheDocument();
  });

  it('renders a single attempt (markers only) with a retake note and no attempt-vs-attempt', () => {
    hookOverride.current = { data: historyOf(1) };
    renderPage();

    expect(
      screen.getByRole('img', {
        name: /Line chart of diagnostic scores across 1 attempt\./,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/One attempt so far/)).toBeInTheDocument();
    // The compare card still renders (headline + retake CTA)…
    expect(screen.getByText('Where you stand')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Retake diagnostic/ }),
    ).toBeInTheDocument();
    // …but the attempt-vs-attempt sub-block needs two attempts.
    expect(screen.queryByText('Attempt vs attempt')).not.toBeInTheDocument();
    // The attempts table still lists the one attempt.
    const table = screen.getByRole('table', { name: /All diagnostic attempts/ });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('shows the loading state while the history is in flight', () => {
    hookOverride.current = { data: null, loading: true };
    renderPage();

    // Several polite live regions exist on the page (the carousel's active
    // LineChart readout is one); the history loading state must be among them.
    const statuses = screen.getAllByRole('status');
    expect(
      statuses.some((el) => /Loading progress/.test(el.textContent ?? '')),
    ).toBe(true);
  });

  it('surfaces a fetch failure as an error card with a working retry', async () => {
    const user = userEvent.setup();
    hookOverride.current = {
      data: { snapshots: [] },
      error: new ApiError('history unavailable', {
        status: 500,
        code: 'server_error',
      }),
    };
    renderPage();

    // The empty mock fallback must NOT masquerade as "no history yet", and
    // the card shows FIXED copy (F-UP-018) — never the server prose on
    // ApiError.message.
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Could not load your progress history\./,
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      /history unavailable/,
    );
    expect(
      screen.queryByRole('button', { name: /Take the diagnostic/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Progress page — word mastery (F-013)', () => {
  it('renders the bucket summary + word list and filters on a chip tap', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Word mastery')).toBeInTheDocument();
    expect(await screen.findByText('사랑')).toBeInTheDocument();
    expect(screen.getByText('먹다')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Mastered/ }));
    await waitFor(() => {
      expect(masterySvc.fetchMastery).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: 'mastered' }),
        expect.anything(),
      );
    });
  });

  it('invites the user to add cards when there are none', async () => {
    masterySvc.fetchMastery.mockResolvedValue({
      summary: { new: 0, learning: 0, reviewing: 0, mastered: 0, total: 0 },
      words: [],
      total: 0,
    });
    renderPage();
    expect(
      await screen.findByText(/No vocab cards yet/),
    ).toBeInTheDocument();
  });

  it('shows an error card on failure and recovers on retry', async () => {
    const user = userEvent.setup();
    masterySvc.fetchMastery.mockReset();
    masterySvc.fetchMastery
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(MASTERY_DEFAULT);
    renderPage();

    expect(
      await screen.findByText('Could not load word mastery.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('사랑')).toBeInTheDocument();
  });

  it('toggles a bucket filter off on a second tap (back to all)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('사랑');

    await user.click(screen.getByRole('button', { name: /Mastered/ }));
    await waitFor(() => {
      expect(masterySvc.fetchMastery).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: 'mastered' }),
        expect.anything(),
      );
    });

    masterySvc.fetchMastery.mockClear();
    await user.click(screen.getByRole('button', { name: /Mastered/ }));
    await waitFor(() => {
      expect(masterySvc.fetchMastery).toHaveBeenCalledWith(
        expect.not.objectContaining({ bucket: expect.anything() }),
        expect.anything(),
      );
    });
  });

  it('pages forward when there are more words than one page', async () => {
    const user = userEvent.setup();
    masterySvc.fetchMastery.mockReset();
    masterySvc.fetchMastery.mockResolvedValue({
      summary: { new: 40, learning: 5, reviewing: 3, mastered: 2, total: 50 },
      words: [
        {
          id: 1,
          korean: '가',
          english: 'a',
          bucket: 'new',
          stability: 0,
          reps: 0,
          lapses: 0,
          dueAt: null,
        },
      ],
      total: 50,
    });
    renderPage();
    await screen.findByText('가');

    // P3b: the pager buttons are bilingual — match the English half.
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => {
      expect(masterySvc.fetchMastery).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 30 }),
        expect.anything(),
      );
    });
  });

  it('keeps the loaded list when a REFETCH fails (graceful degrade)', async () => {
    const user = userEvent.setup();
    // First load succeeds; the bucket-filter refetch then fails.
    masterySvc.fetchMastery.mockReset();
    masterySvc.fetchMastery
      .mockResolvedValueOnce(MASTERY_DEFAULT)
      .mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('사랑')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Mastered/ }));
    // Refetch failed → the prior words stay + a subtle inline retry appears
    // (NOT the full ErrorCard, and the list is NOT wiped).
    expect(
      await screen.findByText(/showing the last loaded mastery/),
    ).toBeInTheDocument();
    expect(screen.getByText('사랑')).toBeInTheDocument();
  });
});

describe('Progress page — grammar mastery placeholder (P1.2, filled in P4)', () => {
  it('renders a designed coming-soon card beside Word mastery', async () => {
    renderPage();

    // Both mastery sections co-exist: the real vocab one…
    expect(await screen.findByText('Word mastery')).toBeInTheDocument();
    // …and the intentional grammar placeholder (title + pill + real copy,
    // never a blank panel).
    expect(screen.getByText('Grammar mastery')).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    // P3b verbage trim — the three-clause sentence became one terse
    // bilingual line.
    expect(
      screen.getByText('Per-pattern grammar mastery will chart here.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('문형별 숙달도가 여기에 표시될 거예요.'),
    ).toBeInTheDocument();
  });
});

describe('Progress page — P3b bilingual chrome + verbage trims', () => {
  it('renders the page eyebrow and compare-card chrome bilingually (both-mode)', () => {
    renderPage();

    // Page eyebrow comes from nav.ts's en/kr pair.
    expect(screen.getByText('Diagnostic history')).toBeInTheDocument();
    expect(screen.getByText('진단 기록')).toBeInTheDocument();
    // Compare-card chrome: each label is a TRUE en/kr pair now (the old
    // eyebrow glued two unrelated halves together).
    expect(screen.getByText('Where you stand')).toBeInTheDocument();
    expect(screen.getByText('현재 실력')).toBeInTheDocument();
    expect(screen.getByText('Attempt vs attempt')).toBeInTheDocument();
    expect(screen.getByText('회차 비교')).toBeInTheDocument();
  });

  it('trims the eyebrow/title redundancy: one bilingual label per card', () => {
    renderPage();

    // Word mastery — the "Vocabulary · 단어 숙달" eyebrow is gone; the
    // Korean lives ONCE, on the title itself.
    expect(screen.getAllByText('단어 숙달')).toHaveLength(1);
    expect(
      screen.getByText('단어 숙달').closest('.km-progress__card-title'),
    ).not.toBeNull();

    // Grammar mastery — same trim.
    expect(screen.getAllByText('문법 숙달')).toHaveLength(1);
    expect(
      screen.getByText('문법 숙달').closest('.km-progress__card-title'),
    ).not.toBeNull();

    // Progress by skill — the eyebrow keeps only the window meta; "실력
    // 추이" is the title's Korean, once.
    expect(screen.getAllByText('실력 추이')).toHaveLength(1);
    expect(
      screen.getByText('실력 추이').closest('.km-progress__card-title'),
    ).not.toBeNull();
    expect(screen.getByText('Last 30 days')).toBeInTheDocument();
    expect(screen.getByText('최근 30일')).toBeInTheDocument();

    // All attempts — "Every attempt" no longer duplicates the title.
    expect(screen.queryByText(/Every attempt/)).not.toBeInTheDocument();
    expect(screen.getByText('All attempts')).toBeInTheDocument();
    expect(screen.getByText('전체 회차')).toBeInTheDocument();
    expect(screen.getByText('Oldest first')).toBeInTheDocument();
  });
});
