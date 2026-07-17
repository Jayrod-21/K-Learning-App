/**
 * TourProvider — trigger + persistence logic for the guided tours.
 *
 * The driver.js overlay is NOT under test: `lib/tourDriver` is mocked to a
 * spy that records which tour was asked to run and hands back the
 * `onFinished` callback, so these tests exercise exactly the contract the
 * feature spec cares about:
 *   - first-run fires when `toursSeen` is empty; not when its id is present,
 *   - a surface mini-tour fires on the first visit, not the second,
 *   - finishing/skipping persists the id (localStorage + a field-scoped
 *     `PATCH /settings/prefs/tours-seen` — never a full-blob PUT, so the
 *     sync structurally cannot clobber palette/textSize),
 *   - replay re-runs an already-seen tour,
 *   - "skip all" marks everything seen and suppresses auto-fire,
 *   - an 'unavailable' tour (no target resolved) is NOT marked seen,
 *   - auto-fire is suppressed while a mock exam is active,
 *   - server-seen ids are adopted on boot (cross-device suppression).
 *
 * Style mirrors TextSizeProvider.test.tsx / AuthProvider.test.tsx: explicit
 * localStorage state per test, fake timers advanced through the provider's
 * paint-settle delay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { JSX, ReactNode } from 'react';
import { TourProvider } from './TourProvider';
import { useTour } from './useTour';
import { ExamActiveContext } from './exam-active-context';
import { TOURS_SEEN_STORAGE_KEY } from './tour-context';
import { TOUR_IDS, type TourDefinition } from '../lib/tours';
import type { TourContextValue } from './tour-context';
import type { Prefs } from '../services/settings';

// ─── Mocks ───────────────────────────────────────────────────

const driverMocks = vi.hoisted(() => ({
  startTour: vi.fn(),
}));
vi.mock('../lib/tourDriver', () => ({
  startTour: driverMocks.startTour,
}));

const serviceMocks = vi.hoisted(() => ({
  fetchPrefs: vi.fn(),
  putPrefs: vi.fn(),
  patchToursSeen: vi.fn(),
}));
vi.mock('../services/settings', () => ({
  fetchPrefs: serviceMocks.fetchPrefs,
  putPrefs: serviceMocks.putPrefs,
  patchToursSeen: serviceMocks.patchToursSeen,
}));

const BASE_PREFS: Prefs = {
  notif: {
    channel: { email: true, sms: false },
    reviewsDue: true,
    daily: false,
    weekly: true,
  },
  palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
  languageDisplay: { mode: 'both', primary: 'ko', subScale: 0.7 },
  textSize: 'md',
  toursSeen: [],
};

/** Last onFinished handed to the (mocked) runner — lets a test "finish" or
 *  "skip" the tour, both of which funnel through this single callback. */
let lastOnFinished: (() => void) | null = null;

function mockStarted(): void {
  driverMocks.startTour.mockImplementation(
    (_tour: TourDefinition, opts: { onFinished: () => void }) => {
      lastOnFinished = opts.onFinished;
      return { status: 'started', handle: { destroy: vi.fn() } };
    },
  );
}

// ─── Harness ─────────────────────────────────────────────────

/** Render the provider at a route and expose the live context via
 *  renderHook's `result.current` (no module-level render side effects —
 *  react-hooks/globals). */
function renderAt(
  path: string,
  opts?: { examActive?: boolean },
): { current: TourContextValue } {
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <MemoryRouter initialEntries={[path]}>
      <ExamActiveContext.Provider
        value={{ examActive: opts?.examActive ?? false, setExamActive: () => {} }}
      >
        <TourProvider>{children}</TourProvider>
      </ExamActiveContext.Provider>
    </MemoryRouter>
  );
  const { result } = renderHook(() => useTour(), { wrapper });
  return result;
}

/** Flush the boot fetch (microtasks) + the paint-settle auto-fire delay.
 *  Two act passes: the first lets the fetch resolve and the hydration
 *  state/effect commit (which is when the auto-fire timer is SCHEDULED);
 *  the second advances past the delay so the scheduled timer actually
 *  fires. A single combined advance would race the effect commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

function seenInStorage(): string[] {
  const raw = window.localStorage.getItem(TOURS_SEEN_STORAGE_KEY);
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

function startedTourIds(): string[] {
  return driverMocks.startTour.mock.calls.map(
    (c) => (c[0] as TourDefinition).id,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  lastOnFinished = null;
  driverMocks.startTour.mockReset();
  serviceMocks.fetchPrefs.mockReset();
  serviceMocks.putPrefs.mockReset();
  serviceMocks.patchToursSeen.mockReset();
  serviceMocks.fetchPrefs.mockResolvedValue({ ...BASE_PREFS });
  serviceMocks.putPrefs.mockImplementation((p: Prefs) => Promise.resolve(p));
  // The server unions the sent ids into its stored list and echoes the full
  // prefs view; default: nothing stored server-side beyond what we sent.
  serviceMocks.patchToursSeen.mockImplementation((ids: string[]) =>
    Promise.resolve({ ...BASE_PREFS, toursSeen: [...ids].sort() }),
  );
  mockStarted();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────

describe('TourProvider — first-run trigger', () => {
  it('fires the first-run tour when toursSeen is empty', async () => {
    renderAt('/');
    await settle();
    expect(startedTourIds()).toEqual(['first-run']);
  });

  it('does NOT fire when the first-run id is already seen (server-side)', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run'],
    });
    renderAt('/');
    await settle();
    expect(driverMocks.startTour).not.toHaveBeenCalled();
  });

  it('does NOT fire when the first-run id is already seen (local cache)', async () => {
    window.localStorage.setItem(
      TOURS_SEEN_STORAGE_KEY,
      JSON.stringify(['first-run']),
    );
    renderAt('/');
    await settle();
    expect(driverMocks.startTour).not.toHaveBeenCalled();
  });

  it('waits for the boot fetch to settle before firing (no pre-hydration flash)', async () => {
    // A slow server holding a seen mark from another device: the tour must
    // never fire in the window before the response lands.
    let release: (p: Prefs) => void = () => {};
    serviceMocks.fetchPrefs.mockReturnValue(
      new Promise<Prefs>((resolve) => {
        release = resolve;
      }),
    );
    renderAt('/');
    await settle(); // well past the paint-settle delay — still un-hydrated
    expect(driverMocks.startTour).not.toHaveBeenCalled();
    await act(async () => {
      release({ ...BASE_PREFS, toursSeen: ['first-run'] });
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(driverMocks.startTour).not.toHaveBeenCalled();
  });

  it('falls back to the local set when the boot fetch fails', async () => {
    serviceMocks.fetchPrefs.mockRejectedValue(new Error('offline'));
    renderAt('/');
    await settle();
    expect(startedTourIds()).toEqual(['first-run']);
  });

  it('is suppressed while a mock exam is active', async () => {
    renderAt('/', { examActive: true });
    await settle();
    expect(driverMocks.startTour).not.toHaveBeenCalled();
  });
});

describe('TourProvider — surface mini-tour trigger', () => {
  it('fires the surface tour on the first visit (first-run already seen)', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run'],
    });
    renderAt('/learn/hanja');
    await settle();
    expect(startedTourIds()).toEqual(['hanja']);
  });

  it('does NOT fire on a later visit once persisted', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run', 'hanja'],
    });
    renderAt('/learn/hanja');
    await settle();
    expect(driverMocks.startTour).not.toHaveBeenCalled();
  });

  it('prefers the first-run tour when both are unseen', async () => {
    renderAt('/learn/hanja');
    await settle();
    expect(startedTourIds()[0]).toBe('first-run');
  });
});

describe('TourProvider — persistence on finish/skip', () => {
  it('marks the tour seen locally and PATCHes ONLY the toursSeen field (never a full-blob PUT)', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run'],
    });
    renderAt('/learn/hanja');
    await settle();
    expect(startedTourIds()).toEqual(['hanja']);

    await act(async () => {
      lastOnFinished?.();
      await vi.advanceTimersByTimeAsync(10);
    });

    // Local fast path: the id is in localStorage immediately.
    expect(seenInStorage()).toContain('hanja');
    // Server sync: field-scoped PATCH with the sorted local set. The server
    // union-merges and jsonb_set's only that key, so no palette/textSize/
    // languageDisplay value is ever carried by (or clobbered by) this sync —
    // proven structurally here: the provider issues NO full-blob PUT at all.
    expect(serviceMocks.patchToursSeen).toHaveBeenCalledTimes(1);
    expect(serviceMocks.patchToursSeen).toHaveBeenCalledWith([
      'first-run',
      'hanja',
    ]);
    expect(serviceMocks.putPrefs).not.toHaveBeenCalled();
  });

  it('adopts ids the PATCH echo carries that were only known server-side (mid-session convergence)', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run'],
    });
    // Another device marked 'library' between our boot and this mark: the
    // server's union echo carries it back.
    serviceMocks.patchToursSeen.mockImplementation((ids: string[]) =>
      Promise.resolve({
        ...BASE_PREFS,
        toursSeen: [...new Set([...ids, 'library'])].sort(),
      }),
    );
    const result = renderAt('/learn/hanja');
    await settle();
    await act(async () => {
      lastOnFinished?.();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.seen.has('library')).toBe(true);
    expect(seenInStorage()).toContain('library');
  });

  it('a failed sync still keeps the local mark (no re-fire, no crash)', async () => {
    serviceMocks.fetchPrefs.mockResolvedValueOnce({
      ...BASE_PREFS,
      toursSeen: ['first-run'],
    });
    const result = renderAt('/learn/hanja');
    await settle();
    // The mark-time PATCH fails outright.
    serviceMocks.patchToursSeen.mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => {
      lastOnFinished?.();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(seenInStorage()).toContain('hanja');
    expect(serviceMocks.putPrefs).not.toHaveBeenCalled();
    expect(result.current.seen.has('hanja')).toBe(true);
    warn.mockRestore();
  });

  it('adopts server-side ids on boot without firing them', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run', 'library', 'topik'],
    });
    renderAt('/learn/topik');
    await settle();
    expect(driverMocks.startTour).not.toHaveBeenCalled();
    // …and the union landed in the local cache for the next cold start.
    expect(seenInStorage()).toEqual(
      expect.arrayContaining(['first-run', 'library', 'topik']),
    );
  });
});

describe('TourProvider — replay + skip-all', () => {
  it('replay re-runs an already-seen tour', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: [...TOUR_IDS],
    });
    const result = renderAt('/');
    await settle();
    expect(driverMocks.startTour).not.toHaveBeenCalled();

    await act(async () => {
      result.current.replay('first-run');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(startedTourIds()).toEqual(['first-run']);
  });

  it('replay of a surface tour navigates to its surface, then runs it', async () => {
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: [...TOUR_IDS],
    });
    const result = renderAt('/settings');
    await settle();
    await act(async () => {
      result.current.replay('hanja');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(startedTourIds()).toEqual(['hanja']);
  });

  it('markAllSeen ("skip all tours") persists every id and suppresses auto-fire', async () => {
    const result = renderAt('/');
    // Skip all IMMEDIATELY — before the auto-fire delay elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1); // let the boot fetch resolve
    });
    await act(async () => {
      result.current.markAllSeen();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(driverMocks.startTour).not.toHaveBeenCalled();
    expect(seenInStorage()).toEqual([...TOUR_IDS].sort());
    expect(serviceMocks.patchToursSeen).toHaveBeenCalledTimes(1);
    expect(serviceMocks.patchToursSeen).toHaveBeenCalledWith(
      [...TOUR_IDS].sort(),
    );
    expect(serviceMocks.putPrefs).not.toHaveBeenCalled();
  });
});

describe('TourProvider — missing targets', () => {
  it("an 'unavailable' tour (no anchored step resolved) is not marked seen and does not crash", async () => {
    driverMocks.startTour.mockReturnValue({ status: 'unavailable' });
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run'],
    });
    const result = renderAt('/learn/hanja');
    await settle();
    expect(startedTourIds()).toEqual(['hanja']); // it TRIED…
    expect(seenInStorage()).not.toContain('hanja'); // …but did not burn the mark
    expect(serviceMocks.patchToursSeen).not.toHaveBeenCalled();
    expect(result.current.activeTourId).toBeNull();
  });

  it('an unavailable tour retries on a later visit, runs once its anchors resolve, and only THEN burns the mark (S1 contract, provider half)', async () => {
    // Visit 1: half-loaded page — the runner reports 'unavailable'.
    driverMocks.startTour.mockReturnValue({ status: 'unavailable' });
    serviceMocks.fetchPrefs.mockResolvedValue({
      ...BASE_PREFS,
      toursSeen: ['first-run'],
    });
    const first = renderAt('/learn/hanja');
    await settle();
    expect(startedTourIds()).toEqual(['hanja']);
    expect(first.current.seen.has('hanja')).toBe(false);
    cleanup();

    // Visit 2 (fresh mount, same device): the anchors now resolve. The tour
    // fires again — the one-shot was NOT burned — and finishing it persists.
    driverMocks.startTour.mockReset();
    mockStarted();
    renderAt('/learn/hanja');
    await settle();
    expect(startedTourIds()).toEqual(['hanja']);
    await act(async () => {
      lastOnFinished?.();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(seenInStorage()).toContain('hanja');
    expect(serviceMocks.patchToursSeen).toHaveBeenCalledTimes(1);
  });
});

describe('TourProvider — context state', () => {
  it('exposes hydrated + activeTourId through useTour', async () => {
    const result = renderAt('/');
    expect(result.current.hydrated).toBe(false);
    await settle();
    expect(result.current.hydrated).toBe(true);
    expect(result.current.activeTourId).toBe('first-run');
    await act(async () => {
      lastOnFinished?.();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.activeTourId).toBeNull();
    expect(result.current.seen.has('first-run')).toBe(true);
  });
});
