/**
 * Review — Phase 3C-1 lists-first flashcards page.
 *
 * The page pipes two useEndpointOrMock feeds through the vocab service:
 *   - 'review:due'   → vocab.getDueCardsPage (StudyCard[] adapter + grammar
 *                       split + the real due `total`, count reconciliation)
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
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
  getDueCardsPage: vi.fn(),
  removeCard: vi.fn(),
  clearDueCards: vi.fn(),
  submitReview: vi.fn(),
  gradeCloze: vi.fn(),
  listLists: vi.fn(),
  getListDetail: vi.fn(),
  getListDueCards: vi.fn(),
  seedListCards: vi.fn(),
  createList: vi.fn(),
  patchList: vi.fn(),
  deleteList: vi.fn(),
  searchEntries: vi.fn(),
  addListEntries: vi.fn(),
  removeListEntry: vi.fn(),
  initCards: vi.fn(),
  getEntry: vi.fn(),
  seedClozePrompts: vi.fn(),
}));

vi.mock('../services/progress', () => ({
  logStudy: vi.fn().mockResolvedValue({ id: 1, minutes_studied: '0' }),
  fetchProgress: vi.fn(),
  updateMetric: vi.fn(),
}));

vi.mock('../services/define', () => ({ defineEntry: vi.fn() }));

// F-208 follow-up — the cloze toggle's pref read/write. The factory default
// (pref off) keeps every non-toggle test rendering the landing exactly as
// before; the toggle tests override per-case with vi.mocked(...).
vi.mock('../services/settings', () => ({
  fetchPrefs: vi.fn(async () => ({
    notif: {
      channel: { email: false, sms: false },
      reviewsDue: false,
      daily: false,
      weekly: false,
    },
    palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
    languageDisplay: { mode: 'both', primary: 'ko', subScale: 0.7 },
    textSize: 'md',
    toursSeen: [],
    clozeEnabled: false,
  })),
  patchClozeEnabled: vi.fn(),
}));

// F-208 — the flashcard-vs-cloze coin flip is a module seam precisely so
// tests can force each branch deterministically.
vi.mock('../lib/clozePresentation', () => ({
  pickPresentation: vi.fn(() => 'flashcard' as const),
}));

import { Review, type StudyCard } from './Review';
import * as vocabService from '../services/vocab';
import * as progressService from '../services/progress';
import { defineEntry } from '../services/define';
import { pickPresentation } from '../lib/clozePresentation';
import {
  fetchPrefs,
  patchClozeEnabled,
  type Prefs,
} from '../services/settings';
import { DUE_CLOZE_CARD_FIXTURE } from '../data/mocks/review';

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

/**
 * F-113 — the list-due queue's wire shape is byte-identical to the global
 * due queue's (both go through `normalizeDueCard`), so these are plain
 * `DueCard`s matching LIST_DETAIL's two entries (42 → 학교, 43 → 영향), as
 * `vocabService.getListDueCards` would resolve them post-normalization.
 */
const LIST_DUE_SCHOOL: DueCard = {
  id: 900,
  face: 'recognition',
  due_at: new Date().toISOString(),
  stability: '0',
  difficulty: '0',
  fsrs_state: 'new',
  vocab_entry_id: 42,
  grammar_entry_id: null,
  source_sentence_id: null,
  topik_item_id: null,
  version: 1,
  vocabKorean: '학교',
  vocabEnglish: 'school',
};

const LIST_DUE_INFLUENCE: DueCard = {
  id: 901,
  face: 'recognition',
  due_at: new Date().toISOString(),
  stability: '0',
  difficulty: '0',
  fsrs_state: 'new',
  vocab_entry_id: 43,
  grammar_entry_id: null,
  source_sentence_id: null,
  topik_item_id: null,
  version: 1,
  vocabKorean: '영향',
  vocabEnglish: 'influence',
};

/** F-208 — a due-queue StudyCard whose snapshot carries the cloze object,
 *  exactly as `dueRealFn` would produce it from the shared fixture. */
const DUE_CLOZE_STUDY: StudyCard[] = [
  {
    key: 'due:501',
    kr: '영향',
    en: 'influence; effect',
    exKr: '그 정책은 경제에 큰 영향을 미쳤다.',
    exEn: 'That policy had a big effect on the economy.',
    source: 'vocab-2000-int',
    wire: { kind: 'due', snapshot: DUE_CLOZE_CARD_FIXTURE },
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
    // F-157 — create-a-list is a Sheet popup: the trigger is on the
    // landing, but the name field only mounts once the sheet is open.
    expect(screen.getByRole('button', { name: /New list/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('New list name')).not.toBeInTheDocument();
    // The old tabbed IA is gone — no tablist, no All-cards search.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Search banked vocab')).not.toBeInTheDocument();
  });

  // The 4th grammar-in-vocab surface (`FIX_REPORT_mobile.md`): the Flashcards
  // landing's "My lists" is fed by this page's OWN `listLists()` call (not
  // `MyVocabLists`/`ReviewVocab`), and it used to be unfiltered. Two proofs:
  // (1) the fetch is narrowed to `kind: 'vocab'` server-side, and (2) even if
  // a grammar-kind row reached the render, the `visibleLists` filter keeps it
  // off the study-list surface. Flashcards study vocab — this list surface
  // must be vocab-only.
  it('narrows its own list fetch to kind:"vocab" (server-side) — the 4th grammar-in-vocab surface', async () => {
    settleLanding();
    vi.mocked(vocabService.listLists).mockResolvedValue([]);
    renderReview();

    // The page handed the hook a real fetch fn; invoking it must ask the
    // server for vocab-kind lists only (not every kind, then filter).
    await act(async () => {
      await hoisted.capturedRealFns.lists?.();
    });
    expect(vocabService.listLists).toHaveBeenCalledWith({ kind: 'vocab' });
  });

  it('never renders a grammar-kind list as a study-list row, even if the feed carries one (belt-and-suspenders)', () => {
    // Feed the landing a MIXED-kind response directly (the render path), the
    // exact leak the server-side filter is the first line of defense against.
    settleLanding({
      lists: [
        LISTS[0]!,
        {
          id: 42,
          name_kr: '중급 문법',
          name_en: 'Intermediate grammar',
          kind: 'grammar',
          version: 1,
          entry_count: 6,
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
        },
      ],
    });
    renderReview();

    // The vocab list still renders…
    expect(screen.getByRole('button', { name: /병원 어휘/ })).toBeInTheDocument();
    // …but the grammar-kind list never becomes a study-list row.
    expect(screen.queryByText('중급 문법')).not.toBeInTheDocument();
    expect(screen.queryByText('Intermediate grammar')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /중급 문법/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the empty-lists card when the only lists are non-vocab kinds', () => {
    settleLanding({
      lists: [
        {
          id: 42,
          name_kr: '중급 문법',
          name_en: 'Intermediate grammar',
          kind: 'grammar',
          version: 1,
          entry_count: 6,
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
        },
      ],
    });
    renderReview();

    // The empty state keys off the FILTERED list, not the raw feed — a
    // grammar-only response reads as "no vocab lists yet" here, not a row.
    expect(screen.getByText('No lists yet.')).toBeInTheDocument();
    expect(screen.queryByText('중급 문법')).not.toBeInTheDocument();
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

    // F-157 — open the create-list Sheet popup first.
    await user.click(screen.getByRole('button', { name: /New list/ }));
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

    // F-157 — open the create-list Sheet popup first.
    await user.click(screen.getByRole('button', { name: /New list/ }));
    await user.type(screen.getByLabelText('New list name'), '새 목록');
    await user.click(screen.getByRole('button', { name: /Create list/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not create the list.');
    // Server prose never reaches the DOM.
    expect(alert).not.toHaveTextContent('constraint violated');
    expect(screen.getByRole('button', { name: /Create list/ })).not.toBeDisabled();
  });

  it('F-157: create-list is a Sheet popup — closed by default, opens as a real dialog, and closes on Esc without creating anything', async () => {
    settleLanding();
    const user = userEvent.setup();
    renderReview();

    // Closed by default — no dialog, no name field.
    expect(screen.queryByRole('dialog', { name: 'New list' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New list/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New list' });
    expect(
      within(dialog).getByLabelText('New list name'),
    ).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'New list' })).not.toBeInTheDocument();
    expect(vocabService.createList).not.toHaveBeenCalled();
  });

  it('degrades hostile URL params to the landing view', () => {
    settleLanding();
    renderReview('/learn/vocab?list=../../etc&study=1');
    // Landing renders (the "New list" trigger, not the detail view).
    expect(screen.getByRole('button', { name: /New list/ })).toBeInTheDocument();
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
      // F-091: the type-qualified delete — LIST_DETAIL's fixture rows carry
      // no item_type, so the component defaults the missing field to
      // 'vocab' (the pre-049 shape every such row actually is).
      expect(vocabService.removeListEntry).toHaveBeenCalledWith(7, 42, 'vocab');
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

  it('F-091 collision: two rows sharing an entry_id but different item_type render + delete INDEPENDENTLY', async () => {
    // The literal motivating scenario the ticket names: a vocab entry and a
    // grammar entry happen to share the same numeric entry_id (different
    // corpus tables, no cross-table uniqueness). Composite (item_type,
    // entry_id) keying — both in the React `key` and in removeEntry's
    // optimistic filter — must resolve the collision.
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue({
      ...LIST_DETAIL,
      entries: [
        {
          entry_id: 42,
          item_type: 'vocab',
          position: 1,
          added_at: '2026-07-01T00:00:00Z',
          korean: '학교',
          english: 'school',
          proficiency: 'L1',
        },
        {
          entry_id: 42,
          item_type: 'grammar',
          position: 2,
          added_at: '2026-07-01T00:00:00Z',
          korean: '-으면',
          english: 'if/when',
          proficiency: null,
        },
      ],
    });
    vi.mocked(vocabService.removeListEntry).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(await screen.findByRole('button', { name: /Edit list/ }));
    // Both colliding rows render distinctly — no key clobbering.
    expect(screen.getByText('학교')).toBeInTheDocument();
    expect(screen.getByText('-으면')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Remove 학교 from the list' }),
    );

    // Optimistic removal targeted the VOCAB leg only — the grammar sibling
    // (same entry_id) survives.
    expect(screen.queryByText('학교')).not.toBeInTheDocument();
    expect(screen.getByText('-으면')).toBeInTheDocument();
    await waitFor(() => {
      expect(vocabService.removeListEntry).toHaveBeenCalledWith(7, 42, 'vocab');
    });
    expect(vocabService.removeListEntry).not.toHaveBeenCalledWith(7, 42, 'grammar');
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
// F-112 — example sentences on list-detail rows
// ─────────────────────────────────────────────────────────────

describe('Review — F-112 example sentences on list-detail rows', () => {
  it('renders the corpus example sentence under a row when the entry has one on file', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue({
      ...LIST_DETAIL,
      entries: [
        {
          ...LIST_DETAIL.entries[0]!,
          example_korean: '학교에 간다.',
          example_english: 'I go to school.',
        },
        LIST_DETAIL.entries[1]!,
      ],
    });
    renderReview('/learn/vocab?list=7');

    expect(await screen.findByText('학교에 간다.')).toBeInTheDocument();
    expect(screen.getByText(/I go to school\./)).toBeInTheDocument();
  });

  it('renders no example line for a row with none on file', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    renderReview('/learn/vocab?list=7');

    await screen.findByText('학교');
    expect(screen.queryByText('학교에 간다.')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// F-113 — bulk "add all to review" (list detail)
// ─────────────────────────────────────────────────────────────

describe('Review — bulk add-all-to-review (F-113)', () => {
  it('seeds every word in the list into review and reports the inserted count', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.seedListCards).mockResolvedValue({ inserted: 2 });
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(
      await screen.findByRole('button', { name: /Add all to review/ }),
    );

    await waitFor(() => {
      expect(vocabService.seedListCards).toHaveBeenCalledWith(7);
    });
    expect(
      await screen.findByText('Added 2 cards to review.'),
    ).toBeInTheDocument();
  });

  it('reports an honest "already in review" message when nothing new was inserted (idempotent re-seed)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.seedListCards).mockResolvedValue({ inserted: 0 });
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(
      await screen.findByRole('button', { name: /Add all to review/ }),
    );

    expect(
      await screen.findByText('Every word here is already in review.'),
    ).toBeInTheDocument();
  });

  it('surfaces a fixed-copy alert when seeding fails — never the server prose', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.seedListCards).mockRejectedValue(
      new ApiError('constraint violated', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderReview('/learn/vocab?list=7');

    await user.click(
      await screen.findByRole('button', { name: /Add all to review/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Could not add these words to review. Try again.',
    );
    expect(alert).not.toHaveTextContent('constraint violated');
  });

  it('disables Add all to review for a list with no studyable words', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue({
      ...LIST_DETAIL,
      list: LISTS[1]!,
      entries: [],
    });
    renderReview('/learn/vocab?list=8');

    expect(
      await screen.findByRole('heading', { name: '뉴스 어휘' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add all to review/ }),
    ).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────
// Study session
// ─────────────────────────────────────────────────────────────

describe('Review — study session', () => {
  it('pins the displayed rating intervals to the server FSRS tuning (B-021)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.getListDueCards).mockResolvedValue({
      cards: [LIST_DUE_SCHOOL],
      total: 1,
    });
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

  it('persists a list-study rating directly against the list-due card snapshot (F-113)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.getListDueCards).mockResolvedValue({
      cards: [LIST_DUE_SCHOOL],
      total: 1,
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

    // F-113: list study is due-aware — the card came from the list's own
    // due queue already carrying its version snapshot, so the rating posts
    // straight through submitReview, exactly like the global due queue (no
    // separate bank-then-review round trip).
    await waitFor(() => {
      expect(vocabService.submitReview).toHaveBeenCalledWith(900, {
        rating: 'good',
        expected_version: 1,
      });
    });
  });

  it('shows an honest empty state when nothing in the list is due, hinting at bulk-seeding (F-113)', async () => {
    settleLanding();
    vi.mocked(vocabService.getListDetail).mockResolvedValue(LIST_DETAIL);
    vi.mocked(vocabService.getListDueCards).mockResolvedValue({
      cards: [],
      total: 0,
    });
    renderReview('/learn/vocab?list=7&study=1');

    expect(
      await screen.findByText(
        'Nothing in this list is due for review right now.',
      ),
    ).toBeInTheDocument();
    expect(vocabService.getListDueCards).toHaveBeenCalledWith(
      7,
      undefined,
      expect.anything(),
    );
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
    vi.mocked(vocabService.getListDueCards).mockResolvedValue({
      cards: [LIST_DUE_SCHOOL, LIST_DUE_INFLUENCE],
      total: 2,
    });
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
      return dt.closest('.km-review__break-cell') as HTMLElement;
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
    vi.mocked(vocabService.getListDueCards).mockResolvedValue({
      cards: [LIST_DUE_SCHOOL, LIST_DUE_INFLUENCE],
      total: 2,
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
    vi.mocked(vocabService.getDueCardsPage).mockResolvedValue({
      cards: GRAMMAR_DUE,
      total: 1,
    });
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
    vi.mocked(vocabService.getDueCardsPage).mockResolvedValue({
      cards: GRAMMAR_DUE,
      total: 1,
    });
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
    // F-156 — one click seeds 15 per corpus (was 100 × 2 corpora = 200).
    expect(vocabService.initCards).toHaveBeenNthCalledWith(1, {
      corpus: 'vocab_2000_beginner',
      limit: 15,
    });
    expect(vocabService.initCards).toHaveBeenNthCalledWith(2, {
      corpus: 'vocab_2000_intermediate',
      limit: 15,
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

// ─────────────────────────────────────────────────────────────
// Count reconciliation — the "665 due" vs "0 cards due" bug
// (TODAY_NAV_SCOPING Part A)
// ─────────────────────────────────────────────────────────────

describe('Review — due-count reconciliation (real server total, not page length)', () => {
  it('shows the server-computed total, not the capped page length, when the real backlog exceeds one page', async () => {
    // The server's default page is capped at 20 rows; here it serves back
    // only ONE row (as it legitimately would once graduated/grammar rows are
    // partitioned out) while the real due backlog is 665 — the exact "665 vs
    // 0-ish" shape the bug report described. `dueCount` must read the real
    // `total`, never `.length` of whatever page happened to come back.
    vi.mocked(vocabService.getDueCardsPage).mockResolvedValue({
      cards: [DUE_RAW],
      total: 665,
    });
    settleLanding({ due: [] });
    renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    expect(await screen.findByText('665 cards due')).toBeInTheDocument();
    expect(screen.queryByText('1 card due')).not.toBeInTheDocument();
  });

  it('shows a real due count even when the served page is ALL grammar-production cards (page length would read 0)', async () => {
    // The exact proximate cause TODAY_NAV_SCOPING flags: if the oldest
    // overdue rows all happen to be grammar-production cards, the vocab
    // `ui` array partitioned out of the page is empty (`.length === 0`)
    // even though the real vocab backlog is large. The server `total`
    // reflects the SAME due predicate regardless of what a client-side
    // partition later does with the rows, so it must not collapse to 0 here.
    vi.mocked(vocabService.getDueCardsPage).mockResolvedValue({
      cards: GRAMMAR_DUE,
      total: 42,
    });
    settleLanding({ due: [] });
    renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    expect(await screen.findByText('42 cards due')).toBeInTheDocument();
  });

  it('falls back to the page length when the mock/dev fallback path never populated a real total', () => {
    // `settleLanding` mimics data injected directly into the hook (as most of
    // this suite's tests do) — `dueRealFn` never actually ran, so no real
    // `total` was ever captured. `dueCount` must still degrade to the
    // existing `.length`-based behavior every pre-existing test in this file
    // relies on, not silently show nothing/zero.
    settleLanding({ due: DUE_STUDY });
    renderReview();
    expect(screen.getByText('1 card due')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// F-128 "Seoul Day & Night" reskin + F-129 mobile
// ─────────────────────────────────────────────────────────────

describe('Review — F-128 Seoul reskin', () => {
  it('renders the shared PageHubHeader (skyline + rail) instead of a bare Topbar', () => {
    settleLanding();
    renderReview();

    // PageHubHeader's own DOM signature (components/PageHubHeader.tsx):
    // the skyline strip + the h1 it carries in its title slot.
    expect(document.querySelector('.km-hubheader')).not.toBeNull();
    expect(document.querySelector('.km-skyline')).not.toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: '단어 카드 · Vocab' }),
    ).toBeInTheDocument();
  });

  it('applies the rain-neon-sheen root class and a CityCard signboard around My lists (devices #1/#8)', () => {
    settleLanding();
    renderReview();

    expect(
      document.querySelector('section.km-review.km-rain-sheen'),
    ).not.toBeNull();
    expect(document.querySelector('.km-citycard')).not.toBeNull();
  });

  it('F-129: the page root carries its own overflow-x guard (mobile, no horizontal clip)', () => {
    settleLanding();
    renderReview();

    const root = document.querySelector('section.km-review');
    expect(root).not.toBeNull();

    // jsdom never computes real layout, so a DOM-only assertion (the old
    // version of this test) can't tell "the guard exists" from "the guard
    // was deleted" — `document.querySelector` finds the same element
    // either way. Reading the actual stylesheet source (same convention as
    // FeedbackFab.test.tsx's anchor-position test) makes this a REAL
    // regression check: deleting Review.css's `overflow-x: hidden` from
    // `.km-review` fails this assertion, which the prior version could not.
    const stylesheet = readFileSync(
      join(cwd(), 'src', 'pages', 'Review.css'),
      'utf8',
    );
    const rule = /\.km-review\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(rule).not.toBe('');
    expect(rule).toContain('overflow-x: hidden;');
  });

  it('flashcard flip + rate still work under the CityCard-tone signboard restyle (F-128 preserves the interaction)', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 1,
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    // The signboard wrapper is present and the flip/rate flow is unchanged.
    expect(document.querySelector('.km-review__flashcard-wrap')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));

    await waitFor(() => {
      expect(vocabService.submitReview).toHaveBeenCalledWith(101, {
        rating: 'good',
        expected_version: 1,
      });
    });
  });

  it('renders the subway-line SubwayProgress in place of the old plain bar (device #5)', () => {
    settleLanding({ due: DUE_STUDY });
    renderReview('/learn/vocab?study=due');

    expect(document.querySelector('.km-subway')).not.toBeNull();
    expect(
      screen.getByRole('progressbar', { name: 'Session progress' }),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// Remove from review + clear the queue (soft delete — words stay saved)
// ─────────────────────────────────────────────────────────────

describe('Review — remove one card from review (study session)', () => {
  /** Two-card due deck so removal can prove the NEXT card slides in. */
  const SECOND_RAW: DueCard = {
    ...DUE_RAW,
    id: 102,
    vocab_entry_id: 2,
    vocabKorean: '학교',
    vocabEnglish: 'school',
  };
  const TWO_CARD_DECK: StudyCard[] = [
    DUE_STUDY[0]!,
    {
      key: 'due:102',
      kr: '학교',
      en: 'school',
      exKr: '',
      exEn: '',
      wire: { kind: 'due', snapshot: SECOND_RAW },
    },
  ];

  it('removes the current card via DELETE and advances to the next card', async () => {
    settleLanding({ due: TWO_CARD_DECK });
    vi.mocked(vocabService.removeCard).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    );

    await waitFor(() => {
      expect(vocabService.removeCard).toHaveBeenCalledWith(101);
    });
    // The removed card's word is gone; the next card slid into its slot and
    // the session shrank honestly (1 of 1, not 1 of 2 with a phantom).
    expect(screen.queryByText('영향')).not.toBeInTheDocument();
    expect(screen.getByText('학교')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
  });

  it('removing the last card completes the session', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.removeCard).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    );

    expect(await screen.findByText('Session complete')).toBeInTheDocument();
    expect(vocabService.removeCard).toHaveBeenCalledWith(101);
  });

  it('keeps the card and shows an honest error when the removal fails', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.removeCard).mockRejectedValue(
      new ApiError('server exploded', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    );

    // The failure surfaces as an alert…
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('영향');
    // …and the card is STILL in the deck (nothing was optimistically lied
    // away) with the control re-enabled for a retry.
    expect(screen.getByText('영향')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    ).toBeEnabled();
  });

  it('blocks rating the card while its removal is in flight (no skipped card)', async () => {
    settleLanding({ due: TWO_CARD_DECK });
    // Deferred DELETE so the test controls the in-flight window.
    let resolveRemove!: () => void;
    vi.mocked(vocabService.removeCard).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        }),
    );
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    // Flip FIRST (the card freezes once the removal starts), then remove.
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    );

    // Mid-flight: the rating row is visibly pending and rating is a no-op —
    // without the guard, `idx` would advance and the DELETE resolving would
    // shift the deck under it, silently skipping 학교 for the session.
    const good = screen.getByRole('button', { name: /Good/ });
    expect(good).toBeDisabled();
    await user.click(good);
    expect(vocabService.submitReview).not.toHaveBeenCalled();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    await act(async () => {
      resolveRemove();
    });
    // The removal lands cleanly: the next card slid into this slot — the
    // session did NOT jump to complete over a skipped card — and no rating
    // was ever submitted for the removed card.
    expect(await screen.findByText('학교')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(screen.queryByText('Session complete')).not.toBeInTheDocument();
    expect(vocabService.submitReview).not.toHaveBeenCalled();
  });

  it('blocks the spacebar flip while the removal is in flight', async () => {
    settleLanding({ due: TWO_CARD_DECK });
    let resolveRemove!: () => void;
    vi.mocked(vocabService.removeCard).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        }),
    );
    renderReview('/learn/vocab?study=due');

    // fireEvent (not userEvent) so focus STAYS on `body`: userEvent's click
    // would focus the remove button, and the window space handler always
    // bails while focus sits on an interactive element (happy-dom's blur()
    // doesn't move activeElement back to body) — which would mask the very
    // in-flight guard this test exists to pin down.
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    );
    // The removal is genuinely in flight before the keypress…
    expect(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    ).toBeDisabled();
    // …and space must NOT reveal the card being removed.
    fireEvent.keyDown(window, { key: ' ' });
    expect(
      screen.queryByRole('group', { name: 'FSRS rating' }),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveRemove();
    });
    expect(await screen.findByText('학교')).toBeInTheDocument();
  });

  it('clears the stale remove-error once the user rates past the card (SF-2)', async () => {
    settleLanding({ due: TWO_CARD_DECK });
    vi.mocked(vocabService.removeCard).mockRejectedValue(
      new ApiError('server exploded', { status: 500, code: 'server_error' }),
    );
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 1,
    });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(
      screen.getByRole('button', { name: 'Remove 영향 from review' }),
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // The user shrugs and rates the card instead — the card-specific
    // "couldn't remove 영향" alert must not follow them onto the next card.
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));

    expect(screen.getByText('학교')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers no remove control on a fixture (local-wire) card', () => {
    const LOCAL_DECK: StudyCard[] = [
      { key: 'fixture:v1', kr: '물', en: 'water', exKr: '', exEn: '', wire: { kind: 'local' } },
    ];
    settleLanding({ due: LOCAL_DECK });
    renderReview('/learn/vocab?study=due');

    expect(
      screen.queryByRole('button', { name: /Remove .* from review/ }),
    ).not.toBeInTheDocument();
  });
});

describe('Review — clear the review queue (landing)', () => {
  it('clears only after an explicit confirmation that says the words are kept', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.clearDueCards).mockResolvedValue({ cleared: 5 });
    const user = userEvent.setup();
    renderReview('/learn/vocab');

    // Tapping Clear does NOT clear — it opens the confirmation sheet.
    await user.click(
      screen.getByRole('button', { name: 'Clear the review queue' }),
    );
    expect(vocabService.clearDueCards).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', {
      name: 'Clear the review queue?',
    });
    // The confirmation copy must state plainly that the saved words survive…
    expect(
      within(dialog).getByText(/your saved words and lists are kept/),
    ).toBeInTheDocument();
    // …and must not over-promise an empty session: only VOCAB cards are
    // cleared — grammar practice cards stay in the due feed by design.
    expect(
      within(dialog).getByText(/vocab cards from review \(grammar practice cards stay\)/),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: /Clear the queue/ }),
    );

    await waitFor(() => {
      expect(vocabService.clearDueCards).toHaveBeenCalledTimes(1);
    });
    // Removed-count status + a due refetch so the queue section reflects
    // the (now empty) server truth.
    expect(
      await screen.findByText(
        'Removed 5 cards from review. Your saved words are kept.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(hoisted.refetchCalls.due).toBeGreaterThan(0);
    });
  });

  it('cancelling the confirmation clears nothing', async () => {
    settleLanding({ due: DUE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab');

    await user.click(
      screen.getByRole('button', { name: 'Clear the review queue' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Clear the review queue?',
    });
    await user.click(within(dialog).getByRole('button', { name: /Cancel/ }));

    expect(vocabService.clearDueCards).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'Clear the review queue?' }),
    ).not.toBeInTheDocument();
  });

  it('surfaces an honest error (nothing removed) when the clear fails', async () => {
    settleLanding({ due: DUE_STUDY });
    vi.mocked(vocabService.clearDueCards).mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderReview('/learn/vocab');

    await user.click(
      screen.getByRole('button', { name: 'Clear the review queue' }),
    );
    await user.click(
      within(
        screen.getByRole('dialog', { name: 'Clear the review queue?' }),
      ).getByRole('button', { name: /Clear the queue/ }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was removed');
    // The queue strip (and its Clear affordance) is still there for a retry.
    expect(
      screen.getByRole('button', { name: 'Clear the review queue' }),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// F-208 — cloze presentation coin flip
// ─────────────────────────────────────────────────────────────

describe('Review — F-208 cloze presentation (coin flip)', () => {
  it('coin flip = cloze: renders the typed ClozeCard, and neither the headword nor the example reaches the DOM (answer leak)', () => {
    vi.mocked(pickPresentation).mockReturnValue('cloze');
    settleLanding({ due: DUE_CLOZE_STUDY });
    renderReview('/learn/vocab?study=due');

    // The flip was consulted exactly once, with the card's due snapshot.
    expect(pickPresentation).toHaveBeenCalledWith(DUE_CLOZE_CARD_FIXTURE);

    // Cloze face: blanked sentence + typed input; NO flip card, NO ratings.
    expect(
      screen.getByRole('textbox', { name: 'Your answer' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/그 정책은 경제에 큰/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Flip card' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'FSRS rating' })).toBeNull();

    // CRITICAL — the blanked sentence derives from the card's own example,
    // so the answer ('영향') must be NOWHERE in the rendered page: not the
    // headword, not the example pair, not the reveal.
    expect(document.body.textContent).not.toContain('영향');
    // …including accessible names: the remove control drops the headword.
    expect(
      screen.getByRole('button', { name: 'Remove this card from review' }),
    ).toBeInTheDocument();
  });

  it('coin flip = flashcard: the normal Flashcard renders even though the card carries a cloze object', () => {
    vi.mocked(pickPresentation).mockReturnValue('flashcard');
    settleLanding({ due: DUE_CLOZE_STUDY });
    renderReview('/learn/vocab?study=due');

    expect(
      screen.getByRole('button', { name: 'Flip card' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Your answer' })).toBeNull();
  });

  it('a card WITHOUT a cloze object never consults the coin flip and stays a flashcard', () => {
    // Even a flip forced to 'cloze' can't reach a cloze-less card — the
    // session guards on the snapshot's `cloze` before rolling.
    vi.mocked(pickPresentation).mockReturnValue('cloze');
    settleLanding({ due: DUE_STUDY });
    renderReview('/learn/vocab?study=due');

    expect(
      screen.getByRole('button', { name: 'Flip card' }),
    ).toBeInTheDocument();
    expect(pickPresentation).not.toHaveBeenCalled();
  });

  it('a committed cloze grade advances the session WITHOUT a second submitReview (no FSRS double-write)', async () => {
    vi.mocked(pickPresentation).mockReturnValue('cloze');
    vi.mocked(vocabService.gradeCloze).mockResolvedValue({
      correct: true,
      answerSurface: '영향',
      fullSentence: '그 정책은 경제에 큰 영향을 미쳤다.',
      rating: 'good',
      version: 4,
      due_at: '2026-08-12T00:00:00Z',
      scheduled_days: 1,
    });
    settleLanding({ due: DUE_CLOZE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.type(
      screen.getByRole('textbox', { name: 'Your answer' }),
      '영향',
    );
    await user.click(screen.getByRole('button', { name: /Submit/ }));

    // The grade went out against the card's own snapshot version…
    expect(vocabService.gradeCloze).toHaveBeenCalledExactlyOnceWith(501, {
      answer: '영향',
      expected_version: 3,
      attempt: 1,
    });
    // …the reveal shows, and Continue completes the one-card session.
    await user.click(await screen.findByRole('button', { name: /Continue/ }));
    expect(
      await screen.findByRole('heading', { name: /Session complete/ }),
    ).toBeInTheDocument();

    // The committed grade ALREADY advanced FSRS server-side — the client
    // must not follow it with a review write for the same card.
    expect(vocabService.submitReview).not.toHaveBeenCalled();
    // The completion stats counted the server-assigned rating ('good' → 1) —
    // proof the client ADOPTED the committed grade instead of re-rating.
    const breakdown = screen.getByLabelText('Rating breakdown');
    const goodCell = within(breakdown)
      .getByText(/Good/)
      .closest('.km-review__break-cell') as HTMLElement;
    expect(within(goodCell).getByText('1')).toBeInTheDocument();
    const againCell = within(breakdown)
      .getByText(/Again/)
      .closest('.km-review__break-cell') as HTMLElement;
    expect(within(againCell).getByText('0')).toBeInTheDocument();
  });

  it('a FAILED remove on a cloze face shows generic copy — the headword/answer never reaches the DOM (fix-pass M2)', async () => {
    vi.mocked(pickPresentation).mockReturnValue('cloze');
    vi.mocked(vocabService.removeCard).mockRejectedValue(
      new ApiError('server exploded', { status: 500, code: 'server_error' }),
    );
    settleLanding({ due: DUE_CLOZE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(
      screen.getByRole('button', { name: 'Remove this card from review' }),
    );

    // The failure surfaces honestly…
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't remove this card");
    // …but the cloze blank is STILL on screen, so the answer ('영향') must be
    // NOWHERE in the document — innerHTML covers attributes (aria-labels,
    // titles) as well as text content.
    expect(document.body.innerHTML).not.toContain('영향');
    // The card stayed (nothing optimistically lied away), still as a cloze.
    expect(
      screen.getByRole('textbox', { name: 'Your answer' }),
    ).toBeInTheDocument();
  });

  it('falls back to the flashcard face for THIS card when the cloze grade 404s (no prompt)', async () => {
    vi.mocked(pickPresentation).mockReturnValue('cloze');
    vi.mocked(vocabService.gradeCloze).mockRejectedValue(
      new ApiError('no cloze prompt for this card', {
        status: 404,
        code: 'not_found',
      }),
    );
    settleLanding({ due: DUE_CLOZE_STUDY });
    const user = userEvent.setup();
    renderReview('/learn/vocab?study=due');

    await user.click(screen.getByRole('button', { name: /Show answer/ }));

    // The same card re-presents as a normal flashcard (no skip, no crash) —
    // and it stays pinned there (no re-roll back into cloze).
    expect(
      await screen.findByRole('button', { name: 'Flip card' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Your answer' })).toBeNull();
    expect(vocabService.submitReview).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// F-208 follow-up — cloze drills enable toggle (landing)
// ─────────────────────────────────────────────────────────────

/** Prefs view as `fetchPrefs` resolves it, with the flag under test. */
function prefsWithCloze(clozeEnabled: boolean): Prefs {
  return {
    notif: {
      channel: { email: false, sms: false },
      reviewsDue: false,
      daily: false,
      weekly: false,
    },
    palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
    languageDisplay: { mode: 'both', primary: 'ko', subScale: 0.7 },
    textSize: 'md',
    toursSeen: [],
    clozeEnabled,
  };
}

/** One seed-run response with overridable counts. */
function seedRun(
  overrides: Partial<vocabService.ClozeSeedResult> = {},
): vocabService.ClozeSeedResult {
  return {
    eligible: 0,
    examined: 0,
    seeded: 0,
    skipped_no_span: 0,
    remaining: 0,
    aborted_upstream: false,
    ...overrides,
  };
}

/** The landing's cloze switch (the page's only `switch` role). */
function clozeSwitch(): HTMLElement {
  return screen.getByRole('switch', {
    name: 'Cloze drills — fill in the blank',
  });
}

describe('Review — F-208 follow-up cloze drills toggle', () => {
  beforeEach(() => {
    // clearAllMocks wipes call history but keeps stale per-test overrides —
    // pin the defaults explicitly so each case starts from pref OFF.
    vi.mocked(fetchPrefs).mockResolvedValue(prefsWithCloze(false));
    vi.mocked(patchClozeEnabled).mockResolvedValue(prefsWithCloze(true));
    vi.mocked(vocabService.seedClozePrompts).mockResolvedValue(seedRun());
  });

  it('reflects the persisted pref on load: OFF stays unchecked, ON hydrates checked', async () => {
    settleLanding();
    const { unmount } = renderReview();
    // Disabled until the pref hydrates — a tap can't race the load.
    expect(clozeSwitch()).toBeDisabled();
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });
    expect(clozeSwitch()).toHaveAttribute('aria-checked', 'false');
    unmount();

    vi.mocked(fetchPrefs).mockResolvedValue(prefsWithCloze(true));
    settleLanding();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('enable: writes the pref true, then loops the seeder until remaining hits 0, and reports the tally', async () => {
    vi.mocked(vocabService.seedClozePrompts)
      .mockResolvedValueOnce(
        seedRun({ eligible: 700, examined: 500, seeded: 480, remaining: 200 }),
      )
      .mockResolvedValueOnce(
        seedRun({ eligible: 700, examined: 200, seeded: 190, remaining: 0 }),
      );
    settleLanding();
    const user = userEvent.setup();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });

    await user.click(clozeSwitch());

    await waitFor(() => {
      expect(patchClozeEnabled).toHaveBeenCalledExactlyOnceWith(true);
    });
    // The loop ran exactly until remaining === 0 — two runs, max batch each.
    await waitFor(() => {
      expect(vocabService.seedClozePrompts).toHaveBeenCalledTimes(2);
    });
    expect(vocabService.seedClozePrompts).toHaveBeenNthCalledWith(1, 500);
    expect(vocabService.seedClozePrompts).toHaveBeenNthCalledWith(2, 500);
    // Accumulated tally (480 + 190) lands in the summary; toggle ends ON.
    expect(
      await screen.findByText('Cloze drills are on — 670 drills ready.'),
    ).toBeInTheDocument();
    expect(clozeSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(clozeSwitch()).not.toBeDisabled();
    // The due feed refetches so the open page picks up cloze presentations.
    expect(hoisted.refetchCalls.due).toBeGreaterThan(0);
  });

  it('enable with nothing left to seed reports the already-prepared copy', async () => {
    settleLanding();
    const user = userEvent.setup();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });

    await user.click(clozeSwitch());

    expect(
      await screen.findByText(
        'Cloze drills are on — your cards were already prepared.',
      ),
    ).toBeInTheDocument();
    expect(vocabService.seedClozePrompts).toHaveBeenCalledTimes(1);
  });

  it('a Kiwi outage (aborted_upstream) stops the loop but KEEPS the pref on — soft retry copy', async () => {
    vi.mocked(vocabService.seedClozePrompts).mockResolvedValue(
      seedRun({
        eligible: 700,
        examined: 120,
        seeded: 100,
        remaining: 580,
        aborted_upstream: true,
      }),
    );
    settleLanding();
    const user = userEvent.setup();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });

    await user.click(clozeSwitch());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/some drills couldn’t be prepared/);
    // No retry hammering against a dead upstream — one run, then stop.
    expect(vocabService.seedClozePrompts).toHaveBeenCalledTimes(1);
    // The pref stays true (idempotent seeder — re-enable resumes later).
    expect(clozeSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('a server whose `remaining` never shrinks stops at the 20-run cap — busy clears, pref stays on, soft-retry copy (not success)', async () => {
    // Every run reports the same non-zero remaining — without the cap the
    // loop would spin forever. The cap must be the exit: EXACTLY 20 calls.
    vi.mocked(vocabService.seedClozePrompts).mockResolvedValue(
      seedRun({ eligible: 10000, examined: 500, seeded: 500, remaining: 500 }),
    );
    settleLanding();
    const user = userEvent.setup();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });

    await user.click(clozeSwitch());

    // Busy clearing means the loop finished — then the call count is final.
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });
    expect(vocabService.seedClozePrompts).toHaveBeenCalledTimes(20);
    // The pref stays on (partial progress is committed; a later off/on
    // resumes) …
    expect(clozeSwitch()).toHaveAttribute('aria-checked', 'true');
    // … and with work still remaining the SOFT-RETRY copy shows — the
    // success "drills ready" copy would be a lie here.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/some drills couldn’t be prepared/);
  });

  it('a seed throw mid-loop keeps the pref on, surfaces the error, AND refetches due (earlier runs are committed)', async () => {
    vi.mocked(vocabService.seedClozePrompts)
      .mockResolvedValueOnce(
        seedRun({ eligible: 700, examined: 500, seeded: 480, remaining: 200 }),
      )
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 500, code: 'server_error' }),
      );
    settleLanding();
    const user = userEvent.setup();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });
    expect(hoisted.refetchCalls.due).toBe(0);

    await user.click(clozeSwitch());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // Pref persisted before the throw — the switch honestly reads ON.
    expect(clozeSwitch()).toHaveAttribute('aria-checked', 'true');
    // Run 1's 480 seeds are committed server-side; the due feed refetches
    // so they surface now (same contract as the aborted_upstream path).
    expect(hoisted.refetchCalls.due).toBeGreaterThan(0);
  });

  it('disable: writes the pref false and NEVER seeds (prompts persist server-side)', async () => {
    vi.mocked(fetchPrefs).mockResolvedValue(prefsWithCloze(true));
    vi.mocked(patchClozeEnabled).mockResolvedValue(prefsWithCloze(false));
    settleLanding();
    const user = userEvent.setup();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).toHaveAttribute('aria-checked', 'true');
    });

    await user.click(clozeSwitch());

    await waitFor(() => {
      expect(patchClozeEnabled).toHaveBeenCalledExactlyOnceWith(false);
    });
    expect(clozeSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(vocabService.seedClozePrompts).not.toHaveBeenCalled();
    // Refetch drops the in-memory page's cloze objects too.
    expect(hoisted.refetchCalls.due).toBeGreaterThan(0);
  });

  it('a failed pref write leaves the toggle where it was and surfaces an error', async () => {
    vi.mocked(patchClozeEnabled).mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    settleLanding();
    const user = userEvent.setup();
    renderReview();
    await waitFor(() => {
      expect(clozeSwitch()).not.toBeDisabled();
    });

    await user.click(clozeSwitch());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // Nothing changed server-side, so the switch honestly still reads OFF.
    expect(clozeSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(vocabService.seedClozePrompts).not.toHaveBeenCalled();
  });
});
