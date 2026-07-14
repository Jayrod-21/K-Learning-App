/**
 * Hanja page — real-wiring behaviour over a mocked `useEndpointOrMock` + a
 * fully-mocked `services/hanja` / `services/vocab` surface.
 *
 * `useEndpointOrMock` is mocked so we control the three read surfaces
 * (`hanja:list`, `hanja:progress`, `hanja:today`) per-test without spinning the
 * real hook; the service modules are mocked so every write (state, card seed,
 * FSRS review, list CRUD, membership) resolves/rejects on command and we can
 * assert the wire payloads the page actually sends.
 *
 * The page routes its nested views (study / lists / list detail / draw) on the
 * `view` search param, so every render is wrapped in a `MemoryRouter` whose
 * initial entry selects the surface under test.
 *
 * Fixtures pass through `vi.hoisted` so the Vitest-hoisted `vi.mock` factory can
 * reference them — referencing regular module-scope `const`s from a mock factory
 * throws a ReferenceError because `vi.mock` runs before `import`s execute.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/ToastProvider';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import { ApiError } from '../services/api';
// Alias the domain type so it doesn't clash with the default-exported `Hanja`
// page component imported below (both would otherwise be named `Hanja`).
import type { Hanja as HanjaChar, HanjaProgress, ServerVocabList } from '../types/domain';
import type {
  HanjaDueCard,
  HanjaListDetail,
  SeedHanjaCardResult,
} from '../services/hanja';

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
  fetchHanjaDueCards: vi.fn(),
  seedHanjaCard: vi.fn(),
  submitHanjaCardReview: vi.fn(),
  fetchHanjaLists: vi.fn(),
  fetchHanjaListDetail: vi.fn(),
  addHanjaToList: vi.fn(),
  removeHanjaFromList: vi.fn(),
}));

vi.mock('../services/vocab', () => ({
  createList: vi.fn(),
  deleteList: vi.fn(),
}));

// Import after the mocks so they are in place.
import Hanja from './Hanja';
import {
  addHanjaToList,
  fetchHanjaDueCards,
  fetchHanjaList,
  fetchHanjaListDetail,
  fetchHanjaLists,
  removeHanjaFromList,
  seedHanjaCard,
  setHanjaState,
  submitHanjaCardReview,
} from '../services/hanja';
import { createList, deleteList } from '../services/vocab';

const setHanjaStateMock = vi.mocked(setHanjaState);
const fetchHanjaDueCardsMock = vi.mocked(fetchHanjaDueCards);
const fetchHanjaListMock = vi.mocked(fetchHanjaList);
const seedHanjaCardMock = vi.mocked(seedHanjaCard);
const submitHanjaCardReviewMock = vi.mocked(submitHanjaCardReview);
const fetchHanjaListsMock = vi.mocked(fetchHanjaLists);
const fetchHanjaListDetailMock = vi.mocked(fetchHanjaListDetail);
const addHanjaToListMock = vi.mocked(addHanjaToList);
const removeHanjaFromListMock = vi.mocked(removeHanjaFromList);
const createListMock = vi.mocked(createList);
const deleteListMock = vi.mocked(deleteList);

// ── Non-hoisted fixtures (used only inside tests) ──────────────

function dueCard(over: Partial<HanjaDueCard>): HanjaDueCard {
  return {
    id: 11,
    face: 'recognition',
    due_at: '2026-07-09T00:00:00.000Z',
    fsrs_state: 'review',
    stability: '1.0',
    difficulty: '5.0',
    version: 3,
    hanja_character_id: 1,
    ch: '學',
    sound: '학',
    gloss: '배울',
    en: 'learn',
    level: 'L3',
    strokes: 16,
    ...over,
  };
}

const FIXTURE_DUE = [
  dueCard({}),
  dueCard({ id: 12, version: 1, hanja_character_id: 2, ch: '生', sound: '생', gloss: '날', en: 'birth', level: 'L2', strokes: 5 }),
];

function seedResult(over: Partial<SeedHanjaCardResult>): SeedHanjaCardResult {
  return {
    card_id: 101,
    character_id: 1,
    ch: '學',
    face: 'recognition',
    due_at: '2026-07-09T00:00:00.000Z',
    version: 1,
    created: true,
    ...over,
  };
}

const FIXTURE_LIST: ServerVocabList = {
  id: 5,
  name_kr: '중급 한자',
  name_en: null,
  kind: 'hanja',
  version: 1,
  entry_count: 2,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const FIXTURE_LIST_DETAIL: HanjaListDetail = {
  list: FIXTURE_LIST,
  entries: [
    {
      entry_id: 1,
      item_type: 'hanja',
      position: 0,
      added_at: '2026-07-01T00:00:00.000Z',
      hanja_char: '學',
      hanja_sound: '학',
      hanja_gloss_en: 'learn',
      hanja_level: 'L3',
    },
    {
      entry_id: 2,
      item_type: 'hanja',
      position: 1,
      added_at: '2026-07-01T00:00:00.000Z',
      hanja_char: '生',
      hanja_sound: '생',
      hanja_gloss_en: 'birth',
      hanja_level: 'L2',
    },
    {
      entry_id: 9,
      item_type: 'vocab',
      position: 2,
      added_at: '2026-07-01T00:00:00.000Z',
      hanja_char: null,
      hanja_sound: null,
      hanja_gloss_en: null,
      hanja_level: null,
    },
  ],
};

// F-168/F-166: Hanja.tsx now calls `useToast()` unconditionally (the
// index-tile quick-add popup and the bulk add-hanja picker are always
// mounted, just closed) — every render needs a `ToastProvider` ancestor or
// the hook throws its missing-provider guard.
function renderHanja(path = '/learn/hanja'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Hanja />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** A third pool character (practicing, not banked) for tests that need a
 *  real second draw-drill/picker candidate beyond the two-char fixture. */
const EXTRA_CHAR: HanjaChar = {
  id: 'h3',
  ch: '水',
  sound: '수',
  gloss: '물',
  en: 'water',
  level: 'L1',
  strokes: 4,
  state: 'practicing',
  note: 'A flowing stream.',
  compounds: [],
};

beforeEach(() => {
  refetchSpies.list.mockClear();
  refetchSpies.progress.mockClear();
  refetchSpies.today.mockClear();
  setHanjaStateMock.mockReset();
  fetchHanjaDueCardsMock.mockReset();
  fetchHanjaListMock.mockReset();
  seedHanjaCardMock.mockReset();
  submitHanjaCardReviewMock.mockReset();
  fetchHanjaListsMock.mockReset();
  fetchHanjaListDetailMock.mockReset();
  addHanjaToListMock.mockReset();
  removeHanjaFromListMock.mockReset();
  createListMock.mockReset();
  deleteListMock.mockReset();
  // Benign defaults — individual tests override with rejections/fixtures.
  fetchHanjaListsMock.mockResolvedValue([]);
  fetchHanjaDueCardsMock.mockResolvedValue([]);
  fetchHanjaListMock.mockResolvedValue(FIXTURE_CHARS);
  seedHanjaCardMock.mockResolvedValue(seedResult({}));
  for (const key of Object.keys(hookOverrides)) {
    delete hookOverrides[key];
  }
});

describe('Hanja page', () => {
  it('renders the encountered band and the server-featured character by default', () => {
    renderHanja();
    expect(screen.getByRole('heading', { name: /한자/ })).toBeInTheDocument();
    expect(screen.getByText(/Just getting started/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Today's hanja 學/ }),
    ).toBeInTheDocument();
  });

  it('does not show the dev mock badge when every source is real', () => {
    renderHanja();
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
    renderHanja();

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
    renderHanja();

    expect(
      screen.queryByRole('progressbar', {
        name: 'Hanja encountered out of L4 target',
      }),
    ).not.toBeInTheDocument();
  });

  it('P3b: adopts the terse nav eyebrow pair (the flowery line is gone)', () => {
    renderHanja();
    expect(screen.getByText('Word roots')).toBeInTheDocument();
    expect(screen.getByText('한자 어원')).toBeInTheDocument();
    expect(
      screen.queryByText(/bones inside the words/i),
    ).not.toBeInTheDocument();
  });

  it('toggles to the Index view and shows the filter chips (aria-pressed) + grid', async () => {
    const user = userEvent.setup();
    renderHanja();

    await user.click(screen.getByRole('tab', { name: /Index/ }));

    // Filter chips are toggle buttons → aria-pressed is the correct ARIA.
    expect(
      screen.getByRole('button', { name: '전체 · All', pressed: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '담김 · Banked', pressed: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^學 학/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^生 생/ }),
    ).toBeInTheDocument();
  });

  it('filters the grid locally to the Banked chip', async () => {
    const user = userEvent.setup();
    renderHanja();

    await user.click(screen.getByRole('tab', { name: /Index/ }));
    await user.click(screen.getByRole('button', { name: '담김 · Banked' }));

    // 生 is banked → stays; 學 is practicing → filtered out.
    expect(
      screen.getByRole('button', { name: /^生 생/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^學 학/ }),
    ).not.toBeInTheDocument();
  });

  it('applies the new state optimistically without a data-resetting refetch', async () => {
    const user = userEvent.setup();
    setHanjaStateMock.mockResolvedValueOnce({ char: '生', state: 'practicing' });
    renderHanja();

    await user.click(screen.getByRole('tab', { name: /Index/ }));
    await user.click(screen.getByRole('button', { name: /^生 생/ }));

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
    renderHanja();

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
    renderHanja();

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
    renderHanja();

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
    renderHanja();
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
    renderHanja();

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
    renderHanja();
    expect(screen.getByRole('alert')).toHaveTextContent(/Hanja unavailable/);
  });

  it('shows the loading skeleton while any source is loading', () => {
    hookOverrides['hanja:progress'] = { loading: true, data: null };
    renderHanja();
    expect(screen.getByText(/Loading hanja/)).toBeInTheDocument();
  });

  // ── Quick-nav + nested-view chrome (F-024) ─────────────────

  it('quick-nav routes from the root into the study view', async () => {
    const user = userEvent.setup();
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Flashcards/ }));

    expect(
      await screen.findByText(/No hanja cards due/),
    ).toBeInTheDocument();
    expect(fetchHanjaDueCardsMock).toHaveBeenCalled();
  });

  it('nested views carry a BackButton that returns to the Hanja root', async () => {
    const user = userEvent.setup();
    renderHanja('/learn/hanja?view=study');

    await screen.findByText(/No hanja cards due/);
    await user.click(screen.getByRole('button', { name: 'Back to Hanja' }));

    // Back on the root — the featured card is on screen again.
    expect(
      await screen.findByRole('button', { name: /Today's hanja 學/ }),
    ).toBeInTheDocument();
  });

  // ── Study view (F-075 / B-028) ─────────────────────────────

  it('drills a due card end-to-end: reveal → rate → advance to the next card', async () => {
    const user = userEvent.setup();
    fetchHanjaDueCardsMock.mockResolvedValue(FIXTURE_DUE);
    submitHanjaCardReviewMock.mockResolvedValue({
      version: 4,
      due_at: '2026-07-10T00:00:00.000Z',
      scheduled_days: 1,
    });
    renderHanja('/learn/hanja?view=study');

    // Card 1 of 2 — front shows the glyph, no answer yet.
    expect(await screen.findByText('1 / 2')).toBeInTheDocument();
    expect(screen.queryByText('배울')).not.toBeInTheDocument();

    // Reveal, then self-rate Good.
    await user.click(screen.getByRole('button', { name: 'Hanja flashcard' }));
    expect(screen.getByText('배울')).toBeInTheDocument();
    await user.click(
      screen.getByRole('group', { name: 'Rate your recall' }),
    );
    await user.click(screen.getByRole('button', { name: /Good/ }));

    await waitFor(() => {
      expect(submitHanjaCardReviewMock).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          rating: 'good',
          expected_version: 3,
          duration_ms: expect.any(Number) as number,
        }),
      );
    });
    // The deck advanced to card 2 (生), flipped back to the front.
    expect(await screen.findByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('生')).toBeInTheDocument();
    expect(screen.queryByText('날')).not.toBeInTheDocument();
  });

  it('Space on a focused rating button rates — it must not flip the card and drop the rating (shared keyboard fix)', async () => {
    const user = userEvent.setup();
    fetchHanjaDueCardsMock.mockResolvedValue([FIXTURE_DUE[0]!]);
    submitHanjaCardReviewMock.mockResolvedValue({
      version: 4,
      due_at: '2026-07-10T00:00:00.000Z',
      scheduled_days: 1,
    });
    renderHanja('/learn/hanja?view=study');

    await user.click(await screen.findByRole('button', { name: 'Hanja flashcard' }));
    const good = screen.getByRole('button', { name: /Good/ });
    good.focus();

    // The window space-to-reveal handler must NOT preventDefault (cancelling
    // the button's native Space activation) nor flip the ratings away.
    const notPrevented = fireEvent.keyDown(good, { key: ' ' });
    expect(notPrevented).toBe(true);
    expect(
      screen.getByRole('group', { name: 'Rate your recall' }),
    ).toBeInTheDocument();

    // The browser delivers the button's click on keyup — the rating lands.
    fireEvent.click(good);
    await waitFor(() => {
      expect(submitHanjaCardReviewMock).toHaveBeenCalledWith(
        11,
        expect.objectContaining({ rating: 'good', expected_version: 3 }),
      );
    });
  });

  it('pins the rating interval subs to the shared FSRS engine, mirroring the vocab session (B-021 parity)', async () => {
    const user = userEvent.setup();
    fetchHanjaDueCardsMock.mockResolvedValue([FIXTURE_DUE[0]!]);
    renderHanja('/learn/hanja?view=study');

    await user.click(await screen.findByRole('button', { name: 'Hanja flashcard' }));

    // Hanja reviews run the SAME retuned engine as vocab
    // (server/src/services/fsrs.ts): RELEARN_DELAY_MS = 50s → '<1m',
    // HARD_STEP_DELAY_MS = 6min → '6m', good = 1 day, easy = 4 days.
    // A drifted label = a lying UI (identical pin to Review.test.tsx B-021).
    const expected: ReadonlyArray<[RegExp, string]> = [
      [/Again/, '<1m'],
      [/Hard/, '6m'],
      [/Good/, '1d'],
      [/Easy/, '4d'],
    ];
    for (const [name, sub] of expected) {
      const btn = screen.getByRole('button', { name });
      expect(within(btn).getByText(sub)).toBeInTheDocument();
    }
  });

  it('completes the session after the last card and offers a re-check', async () => {
    const user = userEvent.setup();
    fetchHanjaDueCardsMock.mockResolvedValue([FIXTURE_DUE[0]!]);
    submitHanjaCardReviewMock.mockResolvedValue({
      version: 4,
      due_at: '2026-07-10T00:00:00.000Z',
      scheduled_days: 1,
    });
    renderHanja('/learn/hanja?view=study');

    await user.click(await screen.findByRole('button', { name: 'Hanja flashcard' }));
    await user.click(screen.getByRole('button', { name: /Easy/ }));

    expect(await screen.findByText(/Deck clear/)).toBeInTheDocument();
    // "Check for more" refetches the queue.
    await user.click(screen.getByRole('button', { name: /Check for more/ }));
    await waitFor(() => {
      expect(fetchHanjaDueCardsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps the card and surfaces an alert when the rating write fails', async () => {
    const user = userEvent.setup();
    fetchHanjaDueCardsMock.mockResolvedValue([FIXTURE_DUE[0]!]);
    submitHanjaCardReviewMock.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    renderHanja('/learn/hanja?view=study');

    await user.click(await screen.findByRole('button', { name: 'Hanja flashcard' }));
    await user.click(screen.getByRole('button', { name: /Again/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn.t save that rating/,
    );
    // No advance — still 1 / 1 with the answer face up and ratings live.
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(screen.getByText('배울')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Again/ })).toBeEnabled();
  });

  it('offers a deck refresh on a 409 (stale expected_version)', async () => {
    const user = userEvent.setup();
    fetchHanjaDueCardsMock
      .mockResolvedValueOnce([FIXTURE_DUE[0]!])
      .mockResolvedValueOnce([]);
    submitHanjaCardReviewMock.mockRejectedValueOnce(
      new ApiError('version conflict', { status: 409, code: 'conflict' }),
    );
    renderHanja('/learn/hanja?view=study');

    await user.click(await screen.findByRole('button', { name: 'Hanja flashcard' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /rescheduled elsewhere/,
    );
    await user.click(screen.getByRole('button', { name: /Refresh deck/ }));

    // The refreshed (now-empty) queue renders the empty state.
    expect(await screen.findByText(/No hanja cards due/)).toBeInTheDocument();
    expect(fetchHanjaDueCardsMock).toHaveBeenCalledTimes(2);
  });

  it('shows a real error card with retry when the due-cards fetch fails', async () => {
    const user = userEvent.setup();
    fetchHanjaDueCardsMock
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce([]);
    renderHanja('/learn/hanja?view=study');

    expect(
      await screen.findByText(/Your hanja deck couldn't be loaded/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/No hanja cards due/)).toBeInTheDocument();
    expect(fetchHanjaDueCardsMock).toHaveBeenCalledTimes(2);
  });

  // ── Detail-sheet drill CTA (B-028) ─────────────────────────

  it('Drill seeds the recognition card, then enters the study view', async () => {
    const user = userEvent.setup();
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Drill · recall/ }));

    await waitFor(() => {
      expect(seedHanjaCardMock).toHaveBeenCalledWith('學');
    });
    // Navigated into the study view (empty deck fixture → empty state).
    expect(await screen.findByText(/No hanja cards due/)).toBeInTheDocument();
  });

  it('keeps the sheet open and shows an alert when the drill seed fails', async () => {
    const user = userEvent.setup();
    seedHanjaCardMock.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Drill · recall/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn.t start the drill/,
    );
    // Still on the sheet — the bank control never left the screen.
    expect(
      screen.getByRole('button', { name: /Bank this hanja/ }),
    ).toBeInTheDocument();
  });

  it('the Drawing drill CTA opens the draw view for the open character', async () => {
    const user = userEvent.setup();
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Drawing drill/ }));

    expect(await screen.findByText(/Draw the character from memory/)).toBeInTheDocument();
  });

  // ── Detail-sheet add-to-list (F-075) ───────────────────────

  it('adds the open character to a chosen list (seed → typed membership)', async () => {
    const user = userEvent.setup();
    fetchHanjaListsMock.mockResolvedValue([FIXTURE_LIST]);
    addHanjaToListMock.mockResolvedValue(undefined);
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    // Expand the disclosure tile, pick the list, add.
    await user.click(screen.getByRole('button', { name: /Add to a list/ }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'List' }),
      '5',
    );
    await user.click(screen.getByRole('button', { name: '추가 · Add' }));

    await waitFor(() => {
      // The pool DTO has no numeric character id — the idempotent card seed
      // supplies it, and the membership write uses the 049 typed shape.
      expect(seedHanjaCardMock).toHaveBeenCalledWith('學');
      expect(addHanjaToListMock).toHaveBeenCalledWith(5, [1]);
    });
    expect(await screen.findByText(/Added 學/)).toBeInTheDocument();
  });

  it('reads a duplicate membership (409) as information, not failure', async () => {
    const user = userEvent.setup();
    fetchHanjaListsMock.mockResolvedValue([FIXTURE_LIST]);
    addHanjaToListMock.mockRejectedValueOnce(
      new ApiError('items already in list', { status: 409, code: 'conflict' }),
    );
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Add to a list/ }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'List' }),
      '5',
    );
    await user.click(screen.getByRole('button', { name: '추가 · Add' }));

    expect(await screen.findByText(/already in/)).toBeInTheDocument();
    // Informational status, not an alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('creates a hanja-kind list from the sheet, then adds the character', async () => {
    const user = userEvent.setup();
    createListMock.mockResolvedValue({
      list: { ...FIXTURE_LIST, id: 7, name_kr: '새 목록', entry_count: 0 },
      appended: 0,
    });
    addHanjaToListMock.mockResolvedValue(undefined);
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Add to a list/ }));
    await user.type(
      await screen.findByLabelText(/New list name/),
      '새 목록',
    );
    await user.click(screen.getByRole('button', { name: /Create & add/ }));

    await waitFor(() => {
      expect(createListMock).toHaveBeenCalledWith({
        name_kr: '새 목록',
        kind: 'hanja',
      });
      expect(addHanjaToListMock).toHaveBeenCalledWith(7, [1]);
    });
    expect(await screen.findByText(/Created “새 목록”/)).toBeInTheDocument();
  });

  it("names the real failure when the list is created but the add fails — never a false 'couldn't create' (SF-2)", async () => {
    const user = userEvent.setup();
    fetchHanjaListsMock.mockResolvedValue([]);
    createListMock.mockResolvedValue({
      list: { ...FIXTURE_LIST, id: 7, name_kr: '새 목록', entry_count: 0 },
      appended: 0,
    });
    seedHanjaCardMock.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    renderHanja();

    await user.click(screen.getByRole('button', { name: /Today's hanja 學/ }));
    await user.click(screen.getByRole('button', { name: /Add to a list/ }));
    await user.type(await screen.findByLabelText(/New list name/), '새 목록');
    await user.click(screen.getByRole('button', { name: /Create & add/ }));

    // The list EXISTS — the copy must say so and point at the safe retry
    // (plain Add on the now-pre-selected list), not invite a duplicate
    // create.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Created “새 목록”, but 學 couldn't be added/);
    expect(alert).not.toHaveTextContent(/Couldn't create that list/);
    // The fresh list is in the picker and pre-selected for that retry.
    expect(
      await screen.findByRole('combobox', { name: 'List' }),
    ).toHaveValue('7');
  });

  // ── Lists view (F-075) ─────────────────────────────────────

  it('lists view renders hanja lists and opens a detail view', async () => {
    const user = userEvent.setup();
    fetchHanjaListsMock.mockResolvedValue([FIXTURE_LIST]);
    fetchHanjaListDetailMock.mockResolvedValue(FIXTURE_LIST_DETAIL);
    renderHanja('/learn/hanja?view=lists');

    // `^` anchors past the row's own delete button ("Delete list 중급 한자").
    await user.click(await screen.findByRole('button', { name: /^중급 한자/ }));

    await waitFor(() => {
      expect(fetchHanjaListDetailMock).toHaveBeenCalledWith(
        5,
        expect.any(AbortSignal),
      );
    });
    // Detail rows render the hanja columns; non-hanja rows are noted, not shown.
    expect(await screen.findByText('學')).toBeInTheDocument();
    expect(screen.getByText('生')).toBeInTheDocument();
    expect(screen.getByText(/non-hanja item/)).toBeInTheDocument();
  });

  it('F-166: creates a new hanja-kind list via the create-list popup', async () => {
    const user = userEvent.setup();
    createListMock.mockResolvedValue({
      list: { ...FIXTURE_LIST, id: 8, name_kr: '급수 한자', entry_count: 0 },
      appended: 0,
    });
    renderHanja('/learn/hanja?view=lists');

    await screen.findByText(/No hanja lists yet/);
    // The create form is now a Sheet popup behind a trigger — not an
    // always-visible inline card.
    expect(screen.queryByLabelText(/List name/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New list/ }));
    await user.type(screen.getByLabelText(/List name/), '급수 한자');
    await user.click(screen.getByRole('button', { name: '만들기 · Create' }));

    await waitFor(() => {
      expect(createListMock).toHaveBeenCalledWith({
        name_kr: '급수 한자',
        kind: 'hanja',
      });
    });
    expect(await screen.findByText('급수 한자')).toBeInTheDocument();
  });

  it('surfaces a create failure as an alert', async () => {
    const user = userEvent.setup();
    createListMock.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    renderHanja('/learn/hanja?view=lists');

    await screen.findByText(/No hanja lists yet/);
    await user.click(screen.getByRole('button', { name: /New list/ }));
    await user.type(screen.getByLabelText(/List name/), '실패 목록');
    await user.click(screen.getByRole('button', { name: '만들기 · Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn.t create that list/,
    );
  });

  it('deletes a list behind a two-step inline confirm', async () => {
    const user = userEvent.setup();
    fetchHanjaListsMock.mockResolvedValue([FIXTURE_LIST]);
    deleteListMock.mockResolvedValue(undefined);
    renderHanja('/learn/hanja?view=lists');

    await user.click(
      await screen.findByRole('button', { name: 'Delete list 중급 한자' }),
    );
    // First tap only arms the confirm — nothing deleted yet.
    expect(deleteListMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '삭제 · Delete' }));

    await waitFor(() => {
      expect(deleteListMock).toHaveBeenCalledWith(5);
    });
    expect(screen.queryByText('중급 한자')).not.toBeInTheDocument();
  });

  // ── List detail view (F-075) ───────────────────────────────

  it('removes a character from a list via the typed membership delete', async () => {
    const user = userEvent.setup();
    fetchHanjaListDetailMock.mockResolvedValue(FIXTURE_LIST_DETAIL);
    removeHanjaFromListMock.mockResolvedValue(undefined);
    renderHanja('/learn/hanja?view=list&id=5');

    await user.click(
      await screen.findByRole('button', { name: 'Remove 學 from list' }),
    );
    await user.click(screen.getByRole('button', { name: '빼기 · Remove' }));

    await waitFor(() => {
      expect(removeHanjaFromListMock).toHaveBeenCalledWith(5, 1);
    });
    expect(screen.queryByText('學')).not.toBeInTheDocument();
    // 生 survives.
    expect(screen.getByText('生')).toBeInTheDocument();
  });

  it('"Add all to deck" seeds one idempotent card per character', async () => {
    const user = userEvent.setup();
    fetchHanjaListDetailMock.mockResolvedValue(FIXTURE_LIST_DETAIL);
    seedHanjaCardMock
      .mockResolvedValueOnce(seedResult({ ch: '學', character_id: 1 }))
      .mockResolvedValueOnce(
        seedResult({ ch: '生', character_id: 2, created: false }),
      );
    renderHanja('/learn/hanja?view=list&id=5');

    await user.click(
      await screen.findByRole('button', { name: /Add all to deck/ }),
    );

    await waitFor(() => {
      expect(seedHanjaCardMock).toHaveBeenCalledWith('學');
      expect(seedHanjaCardMock).toHaveBeenCalledWith('生');
    });
    // Honest tally: 1 fresh card, 1 already in the deck.
    expect(
      await screen.findByText(/Added 1 new card.*1 already there/),
    ).toBeInTheDocument();
  });

  it('shows "List not found" for a garbage id (no fetch fired)', () => {
    renderHanja('/learn/hanja?view=list&id=nope');
    expect(screen.getByText(/List not found/)).toBeInTheDocument();
    expect(fetchHanjaListDetailMock).not.toHaveBeenCalled();
  });

  // ── Drawing drill (F-076) ──────────────────────────────────

  it('draw view renders the recall prompt without leaking the character', () => {
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('學')}`);

    expect(screen.getByText('배울')).toBeInTheDocument();
    expect(screen.getByText(/Draw the character from memory/)).toBeInTheDocument();
    // The answer glyph stays hidden until revealed.
    expect(screen.queryByText('學')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /글자 보기 · Show character/ }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('reveals and hides the ghost character for comparison', async () => {
    const user = userEvent.setup();
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('學')}`);

    await user.click(
      screen.getByRole('button', { name: /글자 보기 · Show character/ }),
    );
    expect(screen.getByText('學')).toBeInTheDocument();
    const hideBtn = screen.getByRole('button', {
      name: /글자 숨기기 · Hide character/,
    });
    expect(hideBtn).toHaveAttribute('aria-pressed', 'true');

    await user.click(hideBtn);
    expect(screen.queryByText('學')).not.toBeInTheDocument();
  });

  it('tracks strokes for undo/clear even without a 2d context (model-first)', () => {
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('學')}`);

    const undoBtn = screen.getByRole('button', { name: /Undo/ });
    const clearBtn = screen.getByRole('button', { name: /Clear/ });
    expect(undoBtn).toBeDisabled();
    expect(clearBtn).toBeDisabled();

    // One pointer stroke on the pad (happy-dom has no canvas 2d context —
    // the stroke MODEL must still update so the controls stay honest).
    const pad = screen.getByRole('img', { name: /Drawing pad/ });
    fireEvent.pointerDown(pad, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(pad, { clientX: 40, clientY: 40 });
    fireEvent.pointerUp(pad);

    expect(undoBtn).toBeEnabled();
    expect(clearBtn).toBeEnabled();

    fireEvent.click(undoBtn);
    expect(undoBtn).toBeDisabled();
    expect(clearBtn).toBeDisabled();
  });

  it('names the keyboard/AT alternative inside the About disclosure', async () => {
    const user = userEvent.setup();
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('學')}`);

    const aboutToggle = screen.getByRole('button', { name: /About this drill/ });
    expect(aboutToggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(aboutToggle);
    expect(aboutToggle).toHaveAttribute('aria-expanded', 'true');

    // Honest notes: not graded, no stroke-order data, pointer-only + the
    // flashcard drill as the accessible alternative.
    expect(screen.getByText(/nothing is graded or saved/i)).toBeInTheDocument();
    expect(screen.getByText(/stroke-order/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Flashcard drill/ }));
    expect(await screen.findByText(/No hanja cards due/)).toBeInTheDocument();
  });

  it('draw view reports an unknown character honestly', () => {
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('無')}`);
    expect(screen.getByText(/Character not found/)).toBeInTheDocument();
  });

  // ── F-165: draw-drill Anki right/wrong loop → mastery pool ─

  it('F-165: a right answer promotes the real mastery state and completes a single-character session', async () => {
    const user = userEvent.setup();
    // 學 is the only practicing/new character reachable from itself (生 is
    // banked, so the queue never chains to it) — a single right answer
    // empties the queue.
    setHanjaStateMock.mockResolvedValueOnce({ char: '學', state: 'banked' });
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('學')}`);

    await user.click(screen.getByRole('button', { name: /Right/ }));

    await waitFor(() => {
      expect(setHanjaStateMock).toHaveBeenCalledWith('學', 'banked');
    });
    expect(await screen.findByText(/Drill complete/)).toBeInTheDocument();
  });

  it('F-165: a wrong answer re-queues the character WITHOUT writing state', async () => {
    const user = userEvent.setup();
    hookOverrides['hanja:list'] = { data: [...FIXTURE_CHARS, EXTRA_CHAR] };
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('學')}`);

    // Queue seeds [學, 水] — 生 (banked) never enters it.
    expect(screen.getByText('배울')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Wrong/ }));

    // 學 requeued to the back — 水 is current now.
    expect(await screen.findByText('물')).toBeInTheDocument();
    expect(setHanjaStateMock).not.toHaveBeenCalled();
  });

  it('F-170: the draw-drill progress bar reflects live mastered count as the session advances', async () => {
    const user = userEvent.setup();
    setHanjaStateMock.mockResolvedValueOnce({ char: '學', state: 'banked' });
    hookOverrides['hanja:list'] = { data: [...FIXTURE_CHARS, EXTRA_CHAR] };
    renderHanja(`/learn/hanja?view=draw&char=${encodeURIComponent('學')}`);

    const bar = screen.getByRole('progressbar', { name: 'Draw drill progress' });
    expect(bar).toHaveAttribute('aria-valuemax', '2');
    expect(bar).toHaveAttribute('aria-valuenow', '1');

    await user.click(screen.getByRole('button', { name: /Right/ }));

    await waitFor(() => {
      expect(setHanjaStateMock).toHaveBeenCalledWith('學', 'banked');
    });
    expect(
      screen.getByRole('progressbar', { name: 'Draw drill progress' }),
    ).toHaveAttribute('aria-valuenow', '2');
  });

  // ── F-167/F-169: index mastery color + hangul-reading label ─

  it('F-167: index tiles carry the real per-state class the mastery-color override keys off', async () => {
    const user = userEvent.setup();
    renderHanja();
    await user.click(screen.getByRole('tab', { name: /Index/ }));

    expect(screen.getByRole('button', { name: /^學 학/ }).className).toContain(
      'km-hanjacell--practicing',
    );
    expect(screen.getByRole('button', { name: /^生 생/ }).className).toContain(
      'km-hanjacell--banked',
    );
  });

  it('F-169: index tiles show only the hangul reading, never the gloss word', async () => {
    const user = userEvent.setup();
    renderHanja();
    await user.click(screen.getByRole('tab', { name: /Index/ }));

    // 배울/날 are the Korean GLOSS words — must be absent from the index
    // grid (they still appear plenty elsewhere, e.g. Today's feature card
    // and the detail sheet, so this asserts scoped to the grid container).
    const grid = screen.getByRole('button', { name: /^學 학/ }).closest('.km-hanja__grid');
    expect(grid).not.toBeNull();
    expect(within(grid as HTMLElement).queryByText('배울')).not.toBeInTheDocument();
    expect(within(grid as HTMLElement).queryByText('날')).not.toBeInTheDocument();
    expect(within(grid as HTMLElement).getByText('학')).toBeInTheDocument();
    expect(within(grid as HTMLElement).getByText('생')).toBeInTheDocument();
  });

  // ── F-168: index "+"-to-list popup + "added to list" toast ─

  it('F-168: adds a character to a list from the index "+" popup and shows a confirmation toast', async () => {
    const user = userEvent.setup();
    fetchHanjaListsMock.mockResolvedValue([FIXTURE_LIST]);
    seedHanjaCardMock.mockResolvedValueOnce(seedResult({ ch: '學', character_id: 1 }));
    renderHanja();
    await user.click(screen.getByRole('tab', { name: /Index/ }));

    await user.click(screen.getByRole('button', { name: 'Add 學 to a list' }));
    await user.click(await screen.findByRole('button', { name: /중급 한자/ }));

    await waitFor(() => {
      expect(seedHanjaCardMock).toHaveBeenCalledWith('學');
      expect(addHanjaToListMock).toHaveBeenCalledWith(5, [1]);
    });
    expect(await screen.findByText(/Added 學 to/)).toBeInTheDocument();
  });

  it('F-168: reads a duplicate membership from the quick-add popup as information, closing the sheet', async () => {
    const user = userEvent.setup();
    fetchHanjaListsMock.mockResolvedValue([FIXTURE_LIST]);
    seedHanjaCardMock.mockResolvedValueOnce(seedResult({ ch: '學', character_id: 1 }));
    addHanjaToListMock.mockRejectedValueOnce(
      new ApiError('dup', { status: 409, code: 'conflict' }),
    );
    renderHanja();
    await user.click(screen.getByRole('tab', { name: /Index/ }));

    await user.click(screen.getByRole('button', { name: 'Add 學 to a list' }));
    await user.click(await screen.findByRole('button', { name: /중급 한자/ }));

    expect(await screen.findByText(/already in/)).toBeInTheDocument();
    // The sheet closes on the "already in" read, same as a real add.
    expect(
      screen.queryByRole('dialog', { name: 'Add to a list' }),
    ).not.toBeInTheDocument();
  });

  // ── F-166: bulk add-hanja picker ────────────────────────────

  it('F-166: bulk-adds selected hanja to a list via the Add-hanja picker', async () => {
    const user = userEvent.setup();
    fetchHanjaListDetailMock.mockResolvedValue(FIXTURE_LIST_DETAIL);
    fetchHanjaListMock.mockResolvedValue([...FIXTURE_CHARS, EXTRA_CHAR]);
    seedHanjaCardMock.mockResolvedValueOnce(seedResult({ ch: '水', character_id: 3 }));
    renderHanja('/learn/hanja?view=list&id=5');

    await user.click(await screen.findByRole('button', { name: /Add hanja/ }));
    // 學/生 are already members — only 水 should be offered.
    expect(screen.queryByRole('button', { name: /^學 학/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /^水 수/ }));
    await user.click(screen.getByRole('button', { name: /Add 1 selected/ }));

    await waitFor(() => {
      expect(seedHanjaCardMock).toHaveBeenCalledWith('水');
      expect(addHanjaToListMock).toHaveBeenCalledWith(5, [3]);
    });
  });
});
