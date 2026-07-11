/**
 * Review — Phase 3C-1 lists-first flashcards page.
 *
 * The page pipes two useEndpointOrMock feeds through the vocab service:
 *   - 'review:due'   → vocab.getDueCards  (StudyCard[] adapter + grammar split)
 *   - 'review:lists' → vocab.listLists    (ServerVocabList[])
 * plus direct abortable fetches for list detail (getListDetail) and the
 * study-session persistence pair (bankEntry → submitReview).
 *
 * Coverage map:
 *   F-060 — lists-first landing (no tabs), create-a-list, open-list detail
 *           with Study at the top.
 *   F-061 — edit mode: rename, remove word (optimistic + rollback), add
 *           words hand-off to /review/vocab with the list in router state.
 *   F-062 — completion page: reviewed count, rating breakdown, next-due
 *           summary from the server's scheduled_days, unsaved tally.
 *   B-021 — the displayed rating intervals are pinned to the server FSRS
 *           tuning (<1m / 6m / 1d / 4d).
 *   B-022 — the examples tile closes via its button, on page tap, and on
 *           card flip.
 *   B-013 — corpus seeding (collapsed tile on the landing).
 *   FU-NF-42 — grammar production cards render + deep-link into the drill.
 *   Keyboard (fix-pass BLOCKER-1/2) — Space/Enter on the rating buttons and
 *           the drawer toggle/close ACTIVATE those controls; neither the
 *           window space-handler nor the Flashcard flip handler may hijack
 *           them (which flipped the card and silently dropped the action).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type {
  DueCard,
  ServerVocabList,
  VocabListDetailResponse,
} from '../types/domain';
import { ApiError } from '../services/api';

// ── Hoisted hook mock state ───────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  type HookState =
    | { kind: 'loading' }
    | { kind: 'data'; data: unknown; isMock: boolean }
    | { kind: 'error'; error: unknown };
  return {
    due: { state: { kind: 'loading' } as HookState },
    lists: { state: { kind: 'loading' } as HookState },
    refetchCalls: { due: 0, lists: 0 },
    capturedRealFns: {
      due: null as null | (() => Promise<unknown>),
      lists: null as null | (() => Promise<unknown>),
    },
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: <T,>(
    key: string,
    _mockFn: () => Promise<T>,
    opts?: { realFn?: () => Promise<T> },
  ) => {
    const slot =
      key === 'review:due' ? hoisted.due
      : key === 'review:lists' ? hoisted.lists
      : null;
    if (slot !== null && opts?.realFn) {
      if (key === 'review:due') hoisted.capturedRealFns.due = opts.realFn;
      else hoisted.capturedRealFns.lists = opts.realFn;
    }
    const refetch = (): void => {
      if (key === 'review:due') hoisted.refetchCalls.due++;
      else if (key === 'review:lists') hoisted.refetchCalls.lists++;
    };
    const s = slot?.state ?? { kind: 'loading' as const };
    if (s.kind === 'loading') {
      return { data: null, loading: true, error: null, isMock: false, refetch };
    }
    if (s.kind === 'error') {
      return {
        data: null,
        loading: false,
        error: s.error,
        isMock: false,
        refetch,
      };
    }
    return {
      data: s.data,
      loading: false,
      error: null,
      isMock: s.isMock,
      refetch,
    };
  },
}));

// ── Service mocks ────────────────────────────────────────────────────
vi.mock('../services/vocab', () => ({
  getDueCards: vi.fn(),
  submitReview: vi.fn(),
  bankEntry: vi.fn(),
  listLists: vi.fn(),
  getListDetail: vi.fn(),
  createList: vi.fn(),
  patchList: vi.fn(),
  deleteList: vi.fn(),
  searchEntries: vi.fn(),
  addListEntries: vi.fn(),
  removeListEntry: vi.fn(),
  initCards: vi.fn(),
  getEntry: vi.fn(),
}));

vi.mock('../services/progress', () => ({
  logStudy: vi.fn().mockResolvedValue({ id: 1, minutes_studied: '0' }),
  fetchProgress: vi.fn(),
  updateMetric: vi.fn(),
}));

vi.mock('../services/define', () => ({ defineEntry: vi.fn() }));

import { Review, type StudyCard } from './Review';
import * as vocabService from '../services/vocab';
import * as progressService from '../services/progress';
import { defineEntry } from '../services/define';

// ── Router probes ────────────────────────────────────────────────────

/** Captures the grammar-drill deep-link's router state (FU-NF-42). */
function GrammarStub(): JSX.Element {
  const loc = useLocation();
  return (
    <div data-testid="grammar-stub">
      GRAMMAR PAGE
      <span data-testid="grammar-state">{JSON.stringify(loc.state)}</span>
    </div>
  );
}

/** Captures the F-061 add-words hand-off's router state. */
function LibraryVocabStub(): JSX.Element {
  const loc = useLocation();
  return (
    <div data-testid="library-vocab-stub">
      LIBRARY VOCAB
      <span data-testid="library-vocab-state">{JSON.stringify(loc.state)}</span>
    </div>
  );
}

function renderReview(initialEntry = '/learn/vocab'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/learn/vocab" element={<Review />} />
        <Route path="/learn/grammar" element={<GrammarStub />} />
        <Route path="/review/vocab" element={<LibraryVocabStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────

const LISTS: ServerVocabList[] = [
  {
    id: 7,
    name_kr: '병원 어휘',
    name_en: 'Hospital words',
    kind: 'vocab',
    version: 1,
    entry_count: 2,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  },
  {
    id: 8,
    name_kr: '뉴스 어휘',
    name_en: null,
    kind: 'vocab',
    version: 1,
    entry_count: 0,
    created_at: '2026-07-02T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
  },
];

const LIST_DETAIL: VocabListDetailResponse = {
  list: LISTS[0]!,
  entries: [
    {
      entry_id: 42,
      position: 1,
      added_at: '2026-07-01T00:00:00Z',
      korean: '학교',
      english: 'school',
      proficiency: 'L1',
    },
    {
      entry_id: 43,
      position: 2,
      added_at: '2026-07-01T00:00:00Z',
      korean: '영향',
      english: 'influence',
      proficiency: 'L3',
    },
  ],
  entry_limit: 100,
  entry_offset: 0,
};

const DUE_RAW: DueCard = {
  id: 101,
  face: 'recognition',
  due_at: new Date().toISOString(),
  stability: '0',
  difficulty: '0',
  fsrs_state: 'new',
  vocab_entry_id: 1,
  grammar_entry_id: null,
  source_sentence_id: null,
  topik_item_id: null,
  version: 1,
  vocabKorean: '영향',
  vocabEnglish: 'influence',
  vocabExampleKorean: '음악은 우리 생활에 큰 영향을 미친다.',
  vocabExampleEnglish: 'Music has a big influence on our lives.',
  vocabSourceBook: 'vocab-2000-int',
};

/** A due-queue StudyCard exactly as `dueRealFn` would produce it. */
const DUE_STUDY: StudyCard[] = [
  {
    key: 'due:101',
    kr: '영향',
    en: 'influence',
    exKr: '음악은 우리 생활에 큰 영향을 미친다.',
    exEn: 'Music has a big influence on our lives.',
    source: 'vocab-2000-int',
    wire: { kind: 'due', snapshot: DUE_RAW },
  },
];

const GRAMMAR_DUE: DueCard[] = [
  {
    id: 555,
    face: 'production',
    due_at: new Date().toISOString(),
    stability: '3',
    difficulty: '5',
    fsrs_state: 'review',
    vocab_entry_id: null,
    grammar_entry_id: 11,
    source_sentence_id: null,
    topik_item_id: null,
    version: 2,
    grammarPatternDisplay: '-더라도',
    grammarSummaryEn: 'even if / even though',
    grammarPatternKey: 'KGIU-INT-007',
  },
];

/** Landing with both feeds settled — the default backdrop for most tests. */
function settleLanding(opts?: {
  lists?: ServerVocabList[];
  due?: StudyCard[];
}): void {
  hoisted.lists.state = {
    kind: 'data',
    data: opts?.lists ?? LISTS,
    isMock: false,
  };
  hoisted.due.state = { kind: 'data', data: opts?.due ?? [], isMock: false };
}

beforeEach(() => {
  hoisted.due.state = { kind: 'loading' };
  hoisted.lists.state = { kind: 'loading' };
  hoisted.refetchCalls = { due: 0, lists: 0 };
  hoisted.capturedRealFns = { due: null, lists: null };
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// Landing (F-060)
// ─────────────────────────────────────────────────────────────

describe('Review — landing (F-060)', () => {
  it('renders the skeleton while the feeds load', () => {
    renderReview();
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
  });

  it('is lists-first: all lists render, no session/all-cards tabs remain', () => {
    settleLanding();
    renderReview();

    expect(
      screen.getByRole('heading', { level: 1, name: '단어 카드 · Vocab' }),
    ).toBeInTheDocument();
    // Every list renders as a row with its count.
    expect(screen.getByRole('button', { name: /병원 어휘/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /뉴스 어휘/ })).toBeInTheDocument();
    expect(screen.getByText(/2 words/)).toBeInTheDocument();
    // The create-a-list section is on the landing.
    expect(screen.getByLabelText('New list name')).toBeInTheDocument();
    // The old tabbed IA is gone — no tablist, no All-cards search.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Search banked vocab')).not.toBeInTheDocument();
  });

  it('shows the due strip with a Study entry when cards are due', async () => {
    settleLanding({ due: DUE_STUDY });
    const user = userEvent.setup();
    renderReview();

    expect(screen.getByText('1 card due')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '학습 · Study' }));
    // The due study session opens on the first due card's front.
    expect(screen.getByRole('button', { name: 'Flip card' })).toBeInTheDocument();
    expect(screen.getAllByText('영향').length).toBeGreaterThan(0);
  });

  it('hides the due strip when nothing is due', () => {
    settleLanding({ due: [] });
    renderReview();
    expect(screen.queryByText(/card due/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '학습 · Study' })).not.toBeInTheDocument();
  });

  it('renders an ErrorCard with a working Retry when the lists fetch fails', async () => {
    hoisted.lists.state = {
      kind: 'error',
      error: new ApiError('boom', { status: 500, code: 'server_error' }),
    };
    hoisted.due.state = { kind: 'data', data: [], isMock: false };
    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('button', { name: /Retry/i }));
    expect(hoisted.refetchCalls.lists).toBeGreaterThan(0);
  });

  it('creates a list and lands inside it (F-060 create section)', async () => {
    settleLanding();
    const created: ServerVocabList = {
      ...LISTS[1]!,
      id: 99,
      name_kr: '새 목록',
      entry_count: 0,
    };
    vi.mocked(vocabService.createList).mockResolvedValue({
      list: created,
      appended: 0,
    });
    vi.mocked(vocabService.getListDetail).mockResolvedValue({
      list: created,
      entries: [],
      entry_limit: 100,
      entry_offset: 0,
    });

    const user = userEvent.setup();
    renderReview();

    await user.type(screen.getByLabelText('New list name'), '새 목록');
    await user.click(screen.getByRole('button', { name: /Create list/ }));

    await waitFor(() => {
      expect(vocabService.createList).toHaveBeenCalledWith({
        name_kr: '새 목록',
        kind: 'vocab',
      });
    });
    // Landed on the new list's detail view (fetched by id).
    await waitFor(() => {
      expect(vocabService.getListDetail).toHaveBeenCalledWith(99, expect.anything());
    });
    expect(await screen.findByRole('heading', { name: '새 목록' })).toBeInTheDocument();
    // The landing's list rows refresh for the return trip.
    expect(hoisted.refetchCalls.lists).toBeGreaterThan(0);
  });

  it('surfaces a fixed-copy alert and re-enables the form when create fails', async () => {
    settleLanding();
    vi.mocked(vocabService.createList).mockRejectedValue(
      new ApiError('constraint violated: vocab_lists_name_kr_check', {
        status: 400,
        code: 'bad_request',
      }),
    );
    const user = userEvent.setup();
    renderReview();

    await user.type(screen.getByLabelText('New list name'), '새 목록');
    await user.click(screen.getByRole('button', { name: /Create list/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not create the list.');
    // Server prose never reaches the DOM.
    expect(alert).not.toHaveTextContent('constraint violated');
    expect(screen.getByRole('button', { name: /Create list/ })).not.toBeDisabled();
  });

  it('degrades hostile URL params to the landing view', () => {
    settleLanding();
    renderReview('/learn/vocab?list=../../etc&study=1');
    expect(screen.getByLabelText('New list name')).toBeInTheDocument();
    expect(vocabService.getListDetail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// List detail (F-060) + edit mode (F-061)
// ─────────────────────────────────────────────────────────────

describe('Review — list detail (F-060/F-061)', () => {
  it('opens a list into the detail view with Study at the top and a BackButton (F-024)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('button', { name: /병원 어휘/ }));

    expect(await screen.findByRole('heading', { name: '병원 어휘' })).toBeInTheDocument();
    expect(vocabService.getListDetail).toHaveBeenCalledWith(7, expect.anything());
    // Words render.
    expect(screen.getByText('학교')).toBeInTheDocument();
    expect(screen.getByText('school')).toBeInTheDocument();
    // Study is available at the top; BackButton names the parent surface.
    expect(screen.getByRole('button', { name: '학습 · Study' })).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Back to Vocab lists' }),
    ).toBeInTheDocument();
  });

  it('disables Study for a list with no studyable words', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue({
      ...LIST_DETAIL,
      list: LISTS[1]!,
      entries: [],
    });
    renderReview('/learn/vocab?list=8');

    expect(await screen.findByRole('heading', { name: '뉴스 어휘' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '학습 · Study' })).toBeDisabled();
  });

  it('renames the list title through edit mode (F-061)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.patchList).mockResolvedValue({
      list: { ...LISTS[0]!, name_kr: '진료 어휘', version: 2 },
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(await screen.findByRole('button', { name: /Edit list/ }));
    const nameInput = screen.getByLabelText('List name (Korean)');
    expect(nameInput).toHaveValue('병원 어휘');
    await user.clear(nameInput);
    await user.type(nameInput, '진료 어휘');
    await user.click(screen.getByRole('button', { name: /Save title/ }));

    await waitFor(() => {
      expect(vocabService.patchList).toHaveBeenCalledWith(7, {
        name_kr: '진료 어휘',
        name_en: 'Hospital words',
      });
    });
    // Leave edit mode → the header shows the server-confirmed name.
    await user.click(screen.getByRole('button', { name: /Done editing/ }));
    expect(screen.getByRole('heading', { name: '진료 어휘' })).toBeInTheDocument();
  });

  it('removes a word optimistically in edit mode (F-061)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.removeListEntry).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(await screen.findByRole('button', { name: /Edit list/ }));
    await user.click(
      screen.getByRole('button', { name: 'Remove 학교 from the list' }),
    );

    // Optimistic: the row is gone before the server settles.
    expect(screen.queryByText('학교')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(vocabService.removeListEntry).toHaveBeenCalledWith(7, 42);
    });
  });

  it('rolls the removed word back and alerts when the delete fails (F-061)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.removeListEntry).mockRejectedValue(
      new ApiError('fk violation', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(await screen.findByRole('button', { name: /Edit list/ }));
    await user.click(
      screen.getByRole('button', { name: 'Remove 학교 from the list' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not remove the word.');
    expect(alert).not.toHaveTextContent('fk violation');
    // Rollback: the row is back.
    expect(screen.getByText('학교')).toBeInTheDocument();
  });

  it('disables ALL remove buttons while one removal is in flight (SF-1 — concurrent rollback corruption)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    let releaseRemove!: () => void;
    vi.mocked(vocabService.removeListEntry).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRemove = () => {
            resolve();
          };
        }),
    );
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(await screen.findByRole('button', { name: /Edit list/ }));
    await user.click(
      screen.getByRole('button', { name: 'Remove 학교 from the list' }),
    );

    // While 학교's delete is in flight, 영향's remove must be disabled too —
    // a second removal's failure rollback would resurrect the first row.
    expect(
      screen.getByRole('button', { name: 'Remove 영향 from the list' }),
    ).toBeDisabled();

    await act(async () => {
      releaseRemove();
    });
    expect(
      screen.getByRole('button', { name: 'Remove 영향 from the list' }),
    ).toBeEnabled();
  });

  it('states the truncation honestly when the list is bigger than the fetched page (SF-3)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue({
      ...LIST_DETAIL,
      list: { ...LISTS[0]!, entry_count: 150 },
    });
    renderReview('/learn/vocab?list=7');

    expect(
      await screen.findByText(
        'Showing the first 2 of 150 words — a study session covers these 2.',
      ),
    ).toBeInTheDocument();
  });

  it('hands off to the library with the open list in router state (F-061 add words)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(await screen.findByRole('button', { name: /Edit list/ }));
    await user.click(screen.getByRole('button', { name: /Add words/ }));

    expect(await screen.findByTestId('library-vocab-stub')).toBeInTheDocument();
    const state = JSON.parse(
      screen.getByTestId('library-vocab-state').textContent ?? 'null',
    ) as { addToList?: { id: number; name: string } };
    expect(state.addToList).toEqual({ id: 7, name: '병원 어휘' });
  });
});

// ─────────────────────────────────────────────────────────────
// Study session
// ─────────────────────────────────────────────────────────────

describe('Review — study session', () => {
  it('pins the displayed rating intervals to the server FSRS tuning (B-021)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7&study=1');

    await user.click(await screen.findByRole('button', { name: 'Flip card' }));

    // RELEARN_DELAY_MS = 50s → '<1m'; HARD_STEP_DELAY_MS = 6min → '6m';
    // BASE_STABILITY good = 1 day → '1d'; easy = 4 days → '4d'
    // (server/src/services/fsrs.ts). A drifted label = a lying UI.
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

  it('persists a list-card rating via the bank→review pair', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.bankEntry).mockResolvedValue({
      card: { id: 900, version: 3 },
    });
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 4,
      due_at: new Date().toISOString(),
      scheduled_days: 1,
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7&study=1');

    await user.click(await screen.findByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));

    await waitFor(() => {
      expect(vocabService.bankEntry).toHaveBeenCalledWith(42);
      // The review rides the bank call's fresh version snapshot — the
      // server owns the FSRS transition, so the payload is rating+version
      // ONLY.
      expect(vocabService.submitReview).toHaveBeenCalledWith(900, {
        rating: 'good',
        expected_version: 3,
      });
    });
  });

  it('persists a due-queue rating directly against the card snapshot', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 0,
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Again/ }));

    await waitFor(() => {
      expect(vocabService.submitReview).toHaveBeenCalledWith(101, {
        rating: 'again',
        expected_version: 1,
      });
    });
    expect(vocabService.bankEntry).not.toHaveBeenCalled();
  });

  it('spacebar reveals the answer face', async () => {
    settleLanding({ due: DUE_STUDY });
    renderReview('/learn/vocab?study=due');

    const flip = screen.getByRole('button', { name: 'Flip card' });
    expect(flip.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });
    expect(flip.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Again/ })).toBeInTheDocument();
  });

  it('Space on a focused rating button rates the card — it must not flip it and drop the rating (BLOCKER-2)', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 1,
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    const good = screen.getByRole('button', { name: /Good/ });
    good.focus();

    // The global space-to-flip handler must NOT preventDefault (which would
    // cancel the button's native Space activation) nor flip the card away.
    const notPrevented = fireEvent.keyDown(good, { key: ' ' });
    expect(notPrevented).toBe(true);
    expect(
      screen.getByRole('group', { name: 'FSRS rating' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Flip card' }).getAttribute('aria-expanded'),
    ).toBe('true');

    // The browser delivers the button's click on keyup — the rating lands.
    fireEvent.click(good);
    await waitFor(() => {
      expect(vocabService.submitReview).toHaveBeenCalledWith(101, {
        rating: 'good',
        expected_version: 1,
      });
    });
  });

  it('the progressbar carries its accessible name (SF-4)', () => {
    settleLanding({ due: DUE_STUDY });
    renderReview('/learn/vocab?study=due');
    expect(
      screen.getByRole('progressbar', { name: 'Session progress' }),
    ).toBeInTheDocument();
  });

  it('mounts the answer face only while flipped (B-014 regression)', async () => {
    settleLanding({ due: DUE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    expect(screen.queryByText('influence')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    expect(screen.getByText('influence')).toBeInTheDocument();
    expect(
      screen.getByText('Music has a big influence on our lives.'),
    ).toBeInTheDocument();
  });

  it('logs study time on unmount when at least one card was rated', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 0,
    });
    const user = userEvent.setup();
    const { unmount } = renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));
    unmount();

    expect(progressService.logStudy).toHaveBeenCalledWith(
      expect.objectContaining({ activity: 'review' }),
    );
  });

  it('does NOT log study time when no card was rated', () => {
    settleLanding({ due: DUE_STUDY });
    const { unmount } = renderReview('/learn/vocab?study=due');
    unmount();
    expect(progressService.logStudy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// Examples tile (B-022)
// ─────────────────────────────────────────────────────────────

describe('Review — examples tile (B-022)', () => {
  async function openTile(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    vi.mocked(defineEntry).mockResolvedValue({
      word: '영향',
      entries: [
        {
          id: 1,
          headword: '영향',
          part_of_speech: null,
          definition_korean: null,
          definition_english: null,
          examples: [
            { korean: '음악은 영향을 준다.', english: 'Music has an influence.' },
          ],
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    expect(defineEntry).not.toHaveBeenCalled(); // lazy until opened
    await user.click(screen.getByRole('button', { name: /More examples/ }));
    expect(await screen.findByText('음악은 영향을 준다.')).toBeInTheDocument();
  }

  it('loads lazily and closes via its own close button', async () => {
    settleLanding({ due: DUE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await openTile(user);
    expect(defineEntry).toHaveBeenCalledWith('영향', expect.anything());

    await user.click(screen.getByRole('button', { name: 'Close examples' }));
    expect(screen.queryByText('음악은 영향을 준다.')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /More examples/ }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('auto-closes when the page is tapped', async () => {
    settleLanding({ due: DUE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await openTile(user);
    // Tap somewhere on the page outside the card — the deck strip.
    await user.click(screen.getByText('학습 중'));
    expect(screen.queryByText('음악은 영향을 준다.')).not.toBeInTheDocument();
  });

  it('auto-closes and resets when the card is flipped', async () => {
    settleLanding({ due: DUE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await openTile(user);
    // Flip back to the front — the tile must not survive the flip.
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    expect(screen.queryByText('음악은 영향을 준다.')).not.toBeInTheDocument();
    // Flip forward again: the tile starts closed (state was reset).
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    expect(
      screen.getByRole('button', { name: /More examples/ }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('the drawer toggle and close button are keyboard-operable — Enter/Space must not flip the card instead (BLOCKER-1)', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(defineEntry).mockResolvedValue({
      word: '영향',
      entries: [
        {
          id: 1,
          headword: '영향',
          part_of_speech: null,
          definition_korean: null,
          definition_english: null,
          examples: [
            { korean: '음악은 영향을 준다.', english: 'Music has an influence.' },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    const toggle = screen.getByRole('button', { name: /More examples/ });
    toggle.focus();

    // Enter keydown bubbles into the Flashcard's flip handler — pre-fix it
    // preventDefault()'d the toggle's activation and flipped to the FRONT
    // (unmounting the drawer toggle entirely).
    expect(fireEvent.keyDown(toggle, { key: 'Enter' })).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Flip card' }).getAttribute('aria-expanded'),
    ).toBe('true');
    // The browser's synthesized click opens the drawer.
    fireEvent.click(toggle);
    expect(await screen.findByText('음악은 영향을 준다.')).toBeInTheDocument();

    // Space on the close button: same contract (window handler + bubbling).
    const close = screen.getByRole('button', { name: 'Close examples' });
    close.focus();
    expect(fireEvent.keyDown(close, { key: ' ' })).toBe(true);
    expect(screen.getByText('음악은 영향을 준다.')).toBeInTheDocument();
    fireEvent.click(close);
    expect(screen.queryByText('음악은 영향을 준다.')).not.toBeInTheDocument();
  });

  it('a failed examples fetch shows a real error with retry — not a false "No additional examples" (SF-2)', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(defineEntry)
      .mockRejectedValueOnce(
        new ApiError('krdict down', { status: 502, code: 'upstream' }),
      )
      .mockResolvedValueOnce({
        word: '영향',
        entries: [
          {
            id: 1,
            headword: '영향',
            part_of_speech: null,
            definition_korean: null,
            definition_english: null,
            examples: [
              { korean: '음악은 영향을 준다.', english: 'Music has an influence.' },
            ],
          },
        ],
      });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /More examples/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load examples.");
    expect(alert).not.toHaveTextContent('krdict down');
    expect(
      screen.queryByText('No additional examples.'),
    ).not.toBeInTheDocument();

    // Retry re-fetches and renders the examples.
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('음악은 영향을 준다.')).toBeInTheDocument();
    expect(defineEntry).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────
// Completion page (F-062)
// ─────────────────────────────────────────────────────────────

describe('Review — completion (F-062)', () => {
  it('shows session stats after the last card: count, breakdown, next-due summary', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.bankEntry)
      .mockResolvedValueOnce({ card: { id: 900, version: 1 } })
      .mockResolvedValueOnce({ card: { id: 901, version: 1 } });
    vi.mocked(vocabService.submitReview)
      .mockResolvedValueOnce({
        version: 2,
        due_at: new Date().toISOString(),
        scheduled_days: 1,
      })
      .mockResolvedValueOnce({
        version: 2,
        due_at: new Date().toISOString(),
        scheduled_days: 4,
      });
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7&study=1');

    // Card 1 → Good, card 2 → Easy.
    await user.click(await screen.findByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Easy/ }));

    expect(
      await screen.findByRole('heading', { name: '세션 완료 · Session complete' }),
    ).toBeInTheDocument();
    expect(screen.getByText('2 cards reviewed')).toBeInTheDocument();

    // Rating breakdown: 1 Good, 1 Easy, 0 Again/Hard.
    const breakdown = screen.getByLabelText('Rating breakdown');
    const cell = (name: RegExp): HTMLElement => {
      const dt = within(breakdown).getByText(name);
      return dt.closest('.km-review__breakCell') as HTMLElement;
    };
    expect(within(cell(/Good/)).getByText('1')).toBeInTheDocument();
    expect(within(cell(/Easy/)).getByText('1')).toBeInTheDocument();
    expect(within(cell(/Again/)).getByText('0')).toBeInTheDocument();
    expect(within(cell(/Hard/)).getByText('0')).toBeInTheDocument();

    // Next-due summary from the server's scheduled_days (1 → tomorrow,
    // 4 → 2+ days) — appears once the saves settle.
    expect(await screen.findByText('1 due in 1 day')).toBeInTheDocument();
    expect(screen.getByText('1 due in 2+ days')).toBeInTheDocument();
    // Nothing failed → no unsaved alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports unsaved ratings when persistence fails', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.submitReview).mockRejectedValue(
      new ApiError('stale version', { status: 409, code: 'conflict' }),
    );
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));

    expect(
      await screen.findByRole('heading', { name: '세션 완료 · Session complete' }),
    ).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 rating couldn’t be saved.');
    expect(alert).not.toHaveTextContent('stale version');
  });

  it('offers a retry for failed saves that re-persists the failed (card, rating) pairs (SF-5)', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.submitReview)
      .mockRejectedValueOnce(
        new ApiError('flaky network', { status: 0, code: 'network' }),
      )
      .mockResolvedValueOnce({
        version: 2,
        due_at: new Date().toISOString(),
        scheduled_days: 1,
      });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));

    await screen.findByRole('heading', { name: '세션 완료 · Session complete' });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 rating couldn’t be saved.',
    );

    await user.click(screen.getByRole('button', { name: /Retry saving/ }));

    // The retry re-submits the SAME card + rating pair…
    await waitFor(() => {
      expect(vocabService.submitReview).toHaveBeenCalledTimes(2);
    });
    expect(vocabService.submitReview).toHaveBeenLastCalledWith(101, {
      rating: 'good',
      expected_version: 1,
    });
    // …and on success the failure alert clears and the save counts.
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('1 due in 1 day')).toBeInTheDocument();
  });

  it('Study again restarts the same deck from the first card', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 1,
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));
    await screen.findByRole('heading', { name: '세션 완료 · Session complete' });

    await user.click(screen.getByRole('button', { name: /Study again/ }));
    // Back on the first card, front face up.
    const flip = screen.getByRole('button', { name: 'Flip card' });
    expect(flip.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
  });

  it('Done returns to the list detail view', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.bankEntry).mockResolvedValue({
      card: { id: 900, version: 1 },
    });
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 1,
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7&study=1');

    await user.click(await screen.findByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));
    await screen.findByRole('heading', { name: '세션 완료 · Session complete' });

    await user.click(screen.getByRole('button', { name: '완료 · Done' }));
    // Detail view again: the list heading + Study button.
    expect(await screen.findByRole('heading', { name: '병원 어휘' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '학습 · Study' })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// Grammar production cards (FU-NF-42) + corpus seeding (B-013)
// ─────────────────────────────────────────────────────────────

describe('Review — grammar production + seeding', () => {
  it('partitions due grammar production cards into their own landing section', async () => {
    vi.mocked(vocabService.getDueCards).mockResolvedValue(GRAMMAR_DUE);
    settleLanding({ due: [] });
    renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    expect(
      await screen.findByText('Grammar production · 1 due'),
    ).toBeInTheDocument();
    expect(screen.getByText('-더라도')).toBeInTheDocument();
  });

  it('deep-links a grammar card into the Grammar Drill tab with the pattern key', async () => {
    vi.mocked(vocabService.getDueCards).mockResolvedValue(GRAMMAR_DUE);
    settleLanding({ due: [] });
    const user = userEvent.setup();
    renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });
    await user.click(await screen.findByRole('button', { name: /Drill -더라도/ }));

    expect(await screen.findByTestId('grammar-stub')).toBeInTheDocument();
    const state = JSON.parse(
      screen.getByTestId('grammar-state').textContent ?? 'null',
    ) as { drillTarget?: { patternKey: string; display: string; meaning: string } };
    expect(state.drillTarget).toEqual({
      patternKey: 'KGIU-INT-007',
      display: '-더라도',
      meaning: 'even if / even though',
    });
  });

  it('seeds both corpora from the collapsed Add-to-review tile and refetches the queue (B-013)', async () => {
    settleLanding();
    vi.mocked(vocabService.initCards)
      .mockResolvedValueOnce({ inserted: 12 })
      .mockResolvedValueOnce({ inserted: 3 });
    const user = userEvent.setup();
    renderReview();

    // Expand the tile (disclosure header), then hit the seed action inside.
    const header = screen
      .getAllByRole('button', { name: '복습에 추가 · Add to review' })
      .find((b) => b.hasAttribute('aria-expanded'));
    expect(header).toBeDefined();
    await user.click(header!);
    const seedBtn = screen
      .getAllByRole('button', { name: '복습에 추가 · Add to review' })
      .find((b) => !b.hasAttribute('aria-expanded'));
    expect(seedBtn).toBeDefined();

    const before = hoisted.refetchCalls.due;
    await user.click(seedBtn!);

    await waitFor(() => {
      expect(screen.getByText('Added 15 cards to review.')).toBeInTheDocument();
    });
    expect(vocabService.initCards).toHaveBeenNthCalledWith(1, {
      corpus: 'vocab_2000_beginner',
      limit: 100,
    });
    expect(vocabService.initCards).toHaveBeenNthCalledWith(2, {
      corpus: 'vocab_2000_intermediate',
      limit: 100,
    });
    expect(hoisted.refetchCalls.due).toBeGreaterThan(before);
  });

  it('seed failure surfaces fixed copy and stops after the first corpus', async () => {
    settleLanding();
    vi.mocked(vocabService.initCards).mockRejectedValueOnce(
      new ApiError('rate limited', { status: 429, code: 'rate_limited' }),
    );
    const user = userEvent.setup();
    renderReview();

    const header = screen
      .getAllByRole('button', { name: '복습에 추가 · Add to review' })
      .find((b) => b.hasAttribute('aria-expanded'));
    await user.click(header!);
    const seedBtn = screen
      .getAllByRole('button', { name: '복습에 추가 · Add to review' })
      .find((b) => !b.hasAttribute('aria-expanded'));
    await user.click(seedBtn!);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Rate-limited right now. Wait a moment and try again.',
      );
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent('rate limited');
    expect(vocabService.initCards).toHaveBeenCalledTimes(1);
  });
});
