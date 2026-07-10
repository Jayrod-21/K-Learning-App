/**
 * Hanja page — real-wiring behaviour over a mocked `useEndpointOrMock` + a
 * mocked `services/hanja` write.
 *
 * `useEndpointOrMock` is mocked so we control the three read surfaces
 * (`hanja:list`, `hanja:progress`, `hanja:today`) per-test without spinning the
 * real hook; the `services/hanja` module is mocked so the bank/practice action
 * resolves/rejects on command and we can assert the optimistic local update
 * (no data-resetting refetch fires — the refetch spies stay untouched).
 *
 * Fixtures pass through `vi.hoisted` so the Vitest-hoisted `vi.mock` factory can
 * reference them — referencing regular module-scope `const`s from a mock factory
 * throws a ReferenceError because `vi.mock` runs before `import`s execute.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import { ApiError } from '../services/api';
// Alias the domain type so it doesn't clash with the default-exported `Hanja`
// page component imported below (both would otherwise be named `Hanja`).
import type { Hanja as HanjaChar, HanjaProgress } from '../types/domain';

const { FIXTURE_CHARS, FIXTURE_PROGRESS } = vi.hoisted(() => {
  return {
    FIXTURE_CHARS: [
      {
        id: 'h1',
        ch: '學',
        sound: '학',
        gloss: '배울',
        en: 'learn',
        level: 'L3',
        strokes: 16,
        state: 'practicing',
        note: 'Etymology of learning.',
        compounds: [{ kr: '學生', han: '學生', en: 'student', with: '生' }],
      },
      {
        id: 'h2',
        ch: '生',
        sound: '생',
        gloss: '날',
        en: 'birth',
        level: 'L2',
        strokes: 5,
        state: 'banked',
        note: 'Sprout from earth.',
        compounds: [{ kr: '學生', han: '學生', en: 'student', with: '學' }],
      },
    ] as HanjaChar[],
    FIXTURE_PROGRESS: {
      banked: 4,
      practicing: 2,
      new: 1,
      targetL4: 800,
      encountered: 7,
      note: 'Just getting started.',
    } as HanjaProgress,
  };
});

// The refetch spies are shared so each test can assert the fan-out.
const refetchSpies = vi.hoisted(() => ({
  list: vi.fn(),
  progress: vi.fn(),
  today: vi.fn(),
}));

// Per-test overrides for each hook key — `undefined` means "use the default".
type HookResult = UseEndpointOrMockResult<unknown>;
const hookOverrides = vi.hoisted(
  () => ({}) as Record<string, Partial<HookResult> | undefined>,
);

function resultFor(key: string): HookResult {
  const base: Record<string, HookResult> = {
    'hanja:list': {
      data: FIXTURE_CHARS,
      loading: false,
      error: null,
      isMock: false,
      refetch: refetchSpies.list,
    },
    'hanja:progress': {
      data: FIXTURE_PROGRESS,
      loading: false,
      error: null,
      isMock: false,
      refetch: refetchSpies.progress,
    },
    'hanja:today': {
      data: FIXTURE_CHARS[0],
      loading: false,
      error: null,
      isMock: false,
      refetch: refetchSpies.today,
    },
  };
  const def = base[key] ?? base['hanja:list'];
  return { ...def, ...hookOverrides[key] };
}

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: vi.fn((key: string) => resultFor(key)),
}));

vi.mock('../services/hanja', () => ({
  fetchHanjaList: vi.fn(),
  fetchHanjaProgress: vi.fn(),
  fetchHanjaToday: vi.fn(),
  setHanjaState: vi.fn(),
}));

// Import after the mocks so they are in place.
import Hanja from './Hanja';
import { setHanjaState } from '../services/hanja';

const setHanjaStateMock = vi.mocked(setHanjaState);

beforeEach(() => {
  refetchSpies.list.mockClear();
  refetchSpies.progress.mockClear();
  refetchSpies.today.mockClear();
  setHanjaStateMock.mockReset();
  for (const key of Object.keys(hookOverrides)) {
    delete hookOverrides[key];
  }
});

describe('Hanja page', () => {
  it('renders the encountered band and the server-featured character by default', () => {
    render(<Hanja />);
    expect(screen.getByRole('heading', { name: /한자/ })).toBeInTheDocument();
    expect(screen.getByText(/Just getting started/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Today's hanja 學/ }),
    ).toBeInTheDocument();
  });

  it('does not show the dev mock badge when every source is real', () => {
    render(<Hanja />);
    expect(screen.queryByTestId('mock-badge')).not.toBeInTheDocument();
  });

  it('clamps the encountered bar aria-valuenow to the L4 target (ARIA 1.2)', () => {
    // encountered spans ALL levels; targetL4 counts only L4 characters — a
    // long-run user legitimately exceeds the target. The visual fill already
    // clamps; the exposed ARIA value must too (valuenow ≤ valuemax). Kept in
    // lockstep with the Progress page's Hanja tab via lib/encounteredBar.
    hookOverrides['hanja:progress'] = {
      data: { ...FIXTURE_PROGRESS, encountered: 900 },
    };
    render(<Hanja />);

    const bar = screen.getByRole('progressbar', {
      name: 'Hanja encountered out of L4 target',
    });
    expect(bar).toHaveAttribute('aria-valuemax', '800');
    expect(bar).toHaveAttribute('aria-valuenow', '800');
  });

  it('drops progressbar semantics when the L4 target is zero (no aria-valuemax=0)', () => {
    // aria-valuemax={0} would violate ARIA's valuemax > valuemin rule; with
    // no fraction to report the bar hides from AT (the eyebrow line still
    // states the raw counts as text).
    hookOverrides['hanja:progress'] = {
      data: { ...FIXTURE_PROGRESS, targetL4: 0 },
    };
    render(<Hanja />);

    expect(
      screen.queryByRole('progressbar', {
        name: 'Hanja encountered out of L4 target',
      }),
    ).not.toBeInTheDocument();
  });

  it('P3b: adopts the terse nav eyebrow pair (the flowery line is gone)', () => {
    render(<Hanja />);
    expect(screen.getByText('Word roots')).toBeInTheDocument();
    expect(screen.getByText('한자 어원')).toBeInTheDocument();
    expect(
      screen.queryByText(/bones inside the words/i),
    ).not.toBeInTheDocument();
  });

  it('toggles to the Index view and shows the filter chips (aria-pressed) + grid', async () => {
    const user = userEvent.setup();
    render(<Hanja />);

    await user.click(screen.getByRole('tab', { name: /Index/ }));

    // Filter chips are toggle buttons → aria-pressed is the correct ARIA.
    expect(
      screen.getByRole('button', { name: '전체 · All', pressed: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '담김 · Banked', pressed: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /學 배울 학/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /生 날 생/ }),
    ).toBeInTheDocument();
  });

  it('filters the grid locally to the Banked chip', async () => {
    const user = userEvent.setup();
    render(<Hanja />);

    await user.click(screen.getByRole('tab', { name: /Index/ }));
    await user.click(screen.getByRole('button', { name: '담김 · Banked' }));

    // 生 is banked → stays; 學 is practicing → filtered out.
    expect(
      screen.getByRole('button', { name: /生 날 생/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /學 배울 학/ }),
    ).not.toBeInTheDocument();
  });

  it('applies the new state optimistically without a data-resetting refetch', async () => {
    const user = userEvent.setup();
    setHanjaStateMock.mockResolvedValueOnce({ char: '生', state: 'practicing' });
    render(<Hanja />);

    await user.click(screen.getByRole('tab', { name: /Index/ }));
    await user.click(screen.getByRole('button', { name: /生 날 생/ }));

    // 生 is banked → the control offers "Practice again" (→ practicing).
    await user.click(screen.getByRole('button', { name: /Practice again/ }));

    await waitFor(() => {
      expect(setHanjaStateMock).toHaveBeenCalledWith('生', 'practicing');
    });
    // The overlay is local — no refetch fires (a refetch would reset the list
    // to null, unmount the open sheet, and flash the skeleton; SF-2).
    expect(refetchSpies.list).not.toHaveBeenCalled();
    expect(refetchSpies.progress).not.toHaveBeenCalled();
    expect(refetchSpies.today).not.toHaveBeenCalled();

    // 生 is now practicing → its control flips to "Bank this hanja", proving
    // the optimistic state reached the still-open detail sheet.
    expect(
      await screen.findByRole('button', { name: /Bank this hanja/ }),
    ).toBeInTheDocument();
  });

  it('does NOT blank the screen (no skeleton, sheet stays open) on a successful set-state', async () => {
    const user = userEvent.setup();
    setHanjaStateMock.mockResolvedValueOnce({ char: '學', state: 'banked' });
    render(<Hanja />);

    // Open the featured 學 sheet, then bank it.
    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Bank this hanja/ }));

    await waitFor(() => {
      expect(setHanjaStateMock).toHaveBeenCalledWith('學', 'banked');
    });
    // The loading skeleton must never appear (no refetch → no loading reset).
    expect(screen.queryByText(/Loading hanja/)).not.toBeInTheDocument();
    // The detail sheet stays mounted — its compound list is still on screen.
    expect(
      await screen.findByRole('button', { name: /Practice again/ }),
    ).toBeInTheDocument();
  });

  it('banks a new/practicing character via "Bank this hanja"', async () => {
    const user = userEvent.setup();
    setHanjaStateMock.mockResolvedValueOnce({ char: '學', state: 'banked' });
    render(<Hanja />);

    // 學 (practicing) is the featured Today card — open it directly.
    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Bank this hanja/ }));

    await waitFor(() => {
      expect(setHanjaStateMock).toHaveBeenCalledWith('學', 'banked');
    });
  });

  it('surfaces an error and applies no optimistic change when the state write fails', async () => {
    const user = userEvent.setup();
    setHanjaStateMock.mockRejectedValueOnce(new Error('boom'));
    render(<Hanja />);

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Bank this hanja/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn.t update that hanja/i,
    );
    // No overlay entry is written on failure, so the control stays on its
    // pre-write label (學 is still practicing → still offers "Bank this hanja")
    // and no refetch fires either.
    expect(
      screen.getByRole('button', { name: /Bank this hanja/ }),
    ).toBeInTheDocument();
    expect(refetchSpies.list).not.toHaveBeenCalled();
    expect(refetchSpies.progress).not.toHaveBeenCalled();
    expect(refetchSpies.today).not.toHaveBeenCalled();
  });

  it('shows the Today empty state when the server returns no featured character', () => {
    hookOverrides['hanja:today'] = { data: null };
    render(<Hanja />);
    expect(screen.getByText(/No featured 한자 yet/)).toBeInTheDocument();
  });

  it('renders an error card (not the empty state) when the featured fetch fails (F-UP-018)', async () => {
    // Pre-fix a failed hanja:today fetch fell through to "No featured 한자
    // yet" — a data statement indistinguishable from an empty corpus. A
    // failure must read as a failure, with a retry scoped to that source.
    hookOverrides['hanja:today'] = {
      data: null,
      error: new ApiError('relation "hanja_daily" does not exist', {
        status: 500,
        code: 'server_error',
      }),
    };
    const user = userEvent.setup();
    render(<Hanja />);

    expect(
      screen.getByText(/Couldn’t load today’s featured 한자/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No featured 한자 yet/)).not.toBeInTheDocument();
    // Fixed copy — the server prose never renders.
    expect(screen.queryByText(/hanja_daily/)).not.toBeInTheDocument();

    // Retry re-runs ONLY the featured source.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchSpies.today).toHaveBeenCalledTimes(1);
    expect(refetchSpies.list).not.toHaveBeenCalled();
    expect(refetchSpies.progress).not.toHaveBeenCalled();
  });

  it('shows the fatal error card when the list fails to load', () => {
    hookOverrides['hanja:list'] = {
      data: null,
      error: new ApiError('boom', { status: 500, code: 'server_error' }),
    };
    render(<Hanja />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Hanja unavailable/);
  });

  it('shows the loading skeleton while any source is loading', () => {
    hookOverrides['hanja:progress'] = { loading: true, data: null };
    render(<Hanja />);
    expect(screen.getByText(/Loading hanja/)).toBeInTheDocument();
  });
});
