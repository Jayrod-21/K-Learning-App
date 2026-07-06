/**
 * Progress page — trend chart + comparison behaviour over a mocked
 * `useEndpointOrMock` (same harness style as Hanja/Diagnostic page tests).
 *
 * The hook is mocked so each test controls the `diagnostic.history` read
 * directly; the page's chart geometry is not asserted pixel-by-pixel —
 * behaviour is asserted through the accessible surfaces (chart aria-label,
 * legend, readout, comparison + attempts tables), which is also what makes
 * the chart usable without a pointer.
 *
 * Fixtures pass through `vi.hoisted` so the Vitest-hoisted `vi.mock` factory
 * can reference them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import { ApiError } from '../services/api';
import type {
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

const refetchSpy = vi.hoisted(() => vi.fn());

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

// Per-test override for the single hook key — `{}` means "use the default".
type HookResult = UseEndpointOrMockResult<unknown>;
const hookOverride = vi.hoisted(() => ({ current: {} as Partial<HookResult> }));

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

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: vi.fn(() => hookResult()),
}));
vi.mock('../services/vocab', () => masterySvc);

// Import after the mock so it is in place.
import Progress from './Progress';

function historyOf(count: number): DiagnosticHistoryResponse {
  return { snapshots: HISTORY_3.snapshots.slice(0, count) };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <Progress />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  refetchSpy.mockClear();
  hookOverride.current = {};
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
    const legend = screen.getByRole('list', { name: 'Chart series' });
    for (const label of [
      /Reading · 읽기/,
      /Listening · 듣기/,
      /Vocabulary · 어휘/,
      /Grammar · 문법/,
      /Overall · 전체/,
    ]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
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
    // (Scoped to the readout live region — the comparison pickers' options
    // render the same "Attempt N · date" text.)
    const readout = screen.getByRole('status');
    expect(within(readout).getByText(/Attempt 3 · 6\/1/)).toBeInTheDocument();

    // Hovering an attempt's hit column moves the readout to that attempt.
    await user.hover(screen.getByRole('button', { name: /^Attempt 1, 5\/1/ }));
    expect(within(readout).getByText(/Attempt 1 · 5\/1/)).toBeInTheDocument();

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

describe('Progress page — comparison', () => {
  it('defaults to previous vs latest and shows signed per-dimension deltas', () => {
    renderPage();

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

    await user.selectOptions(screen.getByRole('combobox', { name: 'From' }), '0');

    const table = screen.getByRole('table', {
      name: /Score change from attempt 1 to attempt 3/,
    });
    // Reading 40 → 70.
    expect(within(table).getByText('▲ +30')).toBeInTheDocument();
  });
});

describe('Progress page — empty / sparse / loading / error states', () => {
  it('invites the user to take the diagnostic when there is no history', () => {
    hookOverride.current = { data: { snapshots: [] } };
    renderPage();

    expect(
      screen.getByRole('button', { name: /Take the diagnostic/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a single attempt (markers only) with a retake note', () => {
    hookOverride.current = { data: historyOf(1) };
    renderPage();

    expect(
      screen.getByRole('img', {
        name: /Line chart of diagnostic scores across 1 attempt\./,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/One attempt so far/)).toBeInTheDocument();
    // No comparison card with a single attempt.
    expect(screen.queryByText('Comparison')).not.toBeInTheDocument();
    // The attempts table still lists the one attempt.
    const table = screen.getByRole('table', { name: /All diagnostic attempts/ });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('shows the loading state while the history is in flight', () => {
    hookOverride.current = { data: null, loading: true };
    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent(/Loading progress/);
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

    // The empty mock fallback must NOT masquerade as "no history yet".
    expect(screen.getByRole('alert')).toHaveTextContent(/history unavailable/);
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

    await user.click(screen.getByRole('button', { name: 'Next' }));
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
