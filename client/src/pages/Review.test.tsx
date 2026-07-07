/**
 * Review — Pass 3 wired flow.
 *
 * The screen pipes three useEndpointOrMock fetches through the vocab service:
 *   - 'review:due'   → vocab.getDueCards    (Vocab[] adapter)
 *   - 'review:lists' → vocab.listLists      (VocabListBundle adapter)
 *   - 'review:all:Q' → vocab.searchEntries  (debounced query → Vocab[])
 *
 * Tests cover:
 *   - happy path (due cards render on session tab)
 *   - rating Again calls vocab.submitReview
 *   - lists tab opens ListDetailSheet which calls vocab.getList
 *   - all tab debounces input and calls vocab.searchEntries
 *   - empty bank renders EmptyCard (not ErrorCard)
 *   - fetch error renders ErrorCard with Retry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import type {
  DueCard,
  ServerVocabList,
  Vocab,
  VocabEntry,
  VocabListBundle,
} from '../types/domain';
import { ApiError } from '../services/api';

// ── Hoisted hook / service mock state ─────────────────────────────────
const hoisted = vi.hoisted(() => {
  type HookState<T> =
    | { kind: 'loading' }
    | { kind: 'data'; data: T; isMock: boolean }
    | { kind: 'error'; error: ApiError };
  return {
    due: { state: { kind: 'loading' } as HookState<Vocab[]> },
    lists: { state: { kind: 'loading' } as HookState<VocabListBundle> },
    all: { state: { kind: 'loading' } as HookState<Vocab[]> },
    refetchCalls: { due: 0, lists: 0, all: 0 },
    capturedRealFns: {
      due: null as null | (() => Promise<Vocab[]>),
      lists: null as null | (() => Promise<VocabListBundle>),
      all: null as null | (() => Promise<Vocab[]>),
    },
    lastAllKey: '',
  };
});

type AnyHookState =
  | { kind: 'loading' }
  | { kind: 'data'; data: unknown; isMock: boolean }
  | { kind: 'error'; error: ApiError };

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: <T,>(
    key: string,
    _mockFn: () => Promise<T>,
    opts?: { realFn?: () => Promise<T> },
  ) => {
    let s: AnyHookState;
    if (key === 'review:due') {
      s = hoisted.due.state as AnyHookState;
      if (opts?.realFn) {
        hoisted.capturedRealFns.due = opts.realFn as () => Promise<Vocab[]>;
      }
    } else if (key === 'review:lists') {
      s = hoisted.lists.state as AnyHookState;
      if (opts?.realFn) {
        hoisted.capturedRealFns.lists =
          opts.realFn as () => Promise<VocabListBundle>;
      }
    } else if (key.startsWith('review:all')) {
      s = hoisted.all.state as AnyHookState;
      hoisted.lastAllKey = key;
      if (opts?.realFn) {
        hoisted.capturedRealFns.all = opts.realFn as () => Promise<Vocab[]>;
      }
    } else {
      s = { kind: 'loading' };
    }
    const refetch = (): void => {
      if (key === 'review:due') hoisted.refetchCalls.due++;
      else if (key === 'review:lists') hoisted.refetchCalls.lists++;
      else if (key.startsWith('review:all')) hoisted.refetchCalls.all++;
    };
    if (s.kind === 'loading') {
      return {
        data: null,
        loading: true,
        error: null,
        isMock: false,
        refetch,
      };
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

import { Review } from './Review';
import * as vocabService from '../services/vocab';
import * as progressService from '../services/progress';
import { defineEntry } from '../services/define';

/**
 * Captures the most recent navigation target + router state so the FU-NF-42
 * deep-link test can assert that activating a grammar production card routes to
 * `/grammar` with the right `drillTarget`. A sibling route under the same
 * MemoryRouter renders its own location into the DOM for inspection.
 */
function GrammarStub(): JSX.Element {
  const loc = useLocation();
  return (
    <div data-testid="grammar-stub">
      GRAMMAR PAGE
      <span data-testid="grammar-state">{JSON.stringify(loc.state)}</span>
    </div>
  );
}

/** Render `<Review />` inside a MemoryRouter with a `/grammar` deep-link target. */
function renderReview(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/review']}>
      <Routes>
        <Route path="/review" element={<Review />} />
        <Route path="/grammar" element={<GrammarStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────
const DUE_VOCAB: Vocab[] = [
  {
    id: 'd:101',
    kr: '영향',
    pos: 'n.',
    en: '',
    ex_kr: '',
    ex_en: '',
  },
];

// B-009: `face` is the card_face ENUM ('recognition'), NOT the word — the
// real word/gloss/example/source arrive on the vocab* fields the service
// normalised from the vocab_entries JOIN. The old fixture put the word in
// `face`, which masked the bug where the flashcard rendered the enum label.
const DUE_RAW: DueCard[] = [
  {
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
  },
];

// FU-NF-42: a grammar PRODUCTION due card (face 'production' + JOINed display).
// `getDueCards` has already normalised the snake-case wire fields to camelCase,
// so the fixture mirrors the normalised `DueCard`.
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

const BUNDLE: VocabListBundle = {
  active: 'e:7',
  custom: [
    {
      id: 'e:7',
      name: '병원 어휘',
      en: 'Hospital words',
      kind: 'vocab',
      count: 5,
      mature: 2,
      due: 1,
      lastStudied: 'today',
      preview: ['진료', '처방전'],
    },
  ],
  sources: [],
};

const SERVER_LIST: ServerVocabList = {
  id: 7,
  name_kr: '병원 어휘',
  name_en: 'Hospital words',
  kind: 'vocab',
  version: 1,
  entry_count: 5,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const SERVER_LIST_DETAIL = {
  list: SERVER_LIST,
  entries: [],
  entry_limit: 100,
  entry_offset: 0,
};

const SERVER_ENTRIES: VocabEntry[] = [
  {
    id: 42,
    corpus: 'vocab_2000_intermediate',
    korean: '학교',
    english: 'school',
    proficiency: 'L3',
    theme: null,
  },
];

beforeEach(() => {
  hoisted.due.state = { kind: 'loading' };
  hoisted.lists.state = { kind: 'loading' };
  hoisted.all.state = { kind: 'loading' };
  hoisted.refetchCalls = { due: 0, lists: 0, all: 0 };
  hoisted.capturedRealFns = { due: null, lists: null, all: null };
  hoisted.lastAllKey = '';
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Review', () => {
  it('renders the skeleton while loading', () => {
    renderReview();
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the session panel with the first due card', () => {
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };
    renderReview();

    expect(screen.getByText('복습 · Review')).toBeInTheDocument();
    expect(screen.getByText('Active list')).toBeInTheDocument();
    expect(screen.getAllByText('영향').length).toBeGreaterThan(0);
    expect(screen.getByText(/Tap card or press/)).toBeInTheDocument();
  });

  it('lazily loads KRDICT examples into the More examples drawer (F-UP-008)', async () => {
    const user = userEvent.setup();
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };
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
            { korean: '큰 영향을 받았다.', english: null },
          ],
        },
      ],
    });
    renderReview();

    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    // Lazy: nothing is fetched until the user opens the drawer.
    expect(defineEntry).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /More examples/ }));
    expect(
      await screen.findByText('음악은 영향을 준다.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Music has an influence.')).toBeInTheDocument();
    expect(defineEntry).toHaveBeenCalledWith('영향', expect.anything());
  });

  it('mounts the answer face only when flipped (B-014 — no answer flash on advance)', async () => {
    // Regression for B-014: the answer face must NOT be in the DOM while the
    // card shows its front. If it were (as before this fix), the next card's
    // English would sit in the back face and flash through during the 480ms
    // flip-back rotation when a rating advances the deck.
    const CARD_WITH_ANSWER: Vocab[] = [
      {
        id: 'd:101',
        kr: '영향',
        pos: 'n.',
        en: 'influence',
        ex_kr: '음악은 우리 생활에 큰 영향을 미친다.',
        ex_en: 'Music has a big influence on our lives.',
      },
    ];
    hoisted.due.state = { kind: 'data', data: CARD_WITH_ANSWER, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    // Front is showing → the gloss and example translation are absent.
    expect(screen.queryByText('influence')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Music has a big influence on our lives.'),
    ).not.toBeInTheDocument();

    // Reveal → the answer face mounts.
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    expect(screen.getByText('influence')).toBeInTheDocument();
    expect(
      screen.getByText('Music has a big influence on our lives.'),
    ).toBeInTheDocument();
  });

  it('rate Again calls submitReview when the card has a wire snapshot', async () => {
    // Wire the realFn to populate the dueCardIndex so submitReview can resolve
    // the numeric cardId. The hook mock captures realFn; we invoke it manually.
    vi.mocked(vocabService.getDueCards).mockResolvedValue(DUE_RAW);
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 0,
    });
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    // Prime the index by invoking the captured realFn.
    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    // Reveal the back so the rating buttons appear.
    await user.click(screen.getByRole('button', { name: 'Flip card' }));

    await user.click(screen.getByRole('button', { name: /Again/ }));

    // EXACT payload: rating + version snapshot only. The server owns the FSRS
    // transition — no client-computed state or interval fields on the wire.
    expect(vocabService.submitReview).toHaveBeenCalledWith(101, {
      rating: 'again',
      expected_version: 1,
    });
  });

  // B-009 regression: dueCardToVocab (exercised through the real dueRealFn)
  // must map the JOINed vocab-entry fields onto the UI card — front = Korean
  // headword, back = English gloss + example pair + source — instead of
  // rendering `face` (the card_face enum) with hardcoded empties.
  it('maps a due vocab card onto the UI shape from the vocab-entry fields (B-009)', async () => {
    vi.mocked(vocabService.getDueCards).mockResolvedValue(DUE_RAW);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    renderReview();

    let ui: Vocab[] = [];
    await act(async () => {
      ui = (await hoisted.capturedRealFns.due?.()) ?? [];
    });

    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({
      id: 'd:101',
      kr: '영향', // the Korean headword — NOT the 'recognition' face enum
      en: 'influence',
      ex_kr: '음악은 우리 생활에 큰 영향을 미친다.',
      ex_en: 'Music has a big influence on our lives.',
      mined_in: 'vocab-2000-int',
    });
  });

  it('falls back to the face label only when a card carries no vocab fields (B-009)', async () => {
    // A sentence/topik card (no vocab_entry_id, nothing better on the wire
    // yet) keeps the pre-fix degraded rendering rather than a blank card.
    vi.mocked(vocabService.getDueCards).mockResolvedValue([
      {
        id: 300,
        face: 'cloze',
        due_at: new Date().toISOString(),
        stability: '0',
        difficulty: '0',
        fsrs_state: 'new',
        vocab_entry_id: null,
        grammar_entry_id: null,
        source_sentence_id: 12,
        topik_item_id: null,
        version: 1,
      },
    ]);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    renderReview();

    let ui: Vocab[] = [];
    await act(async () => {
      ui = (await hoisted.capturedRealFns.due?.()) ?? [];
    });

    expect(ui[0]).toMatchObject({ id: 'd:300', kr: 'cloze', en: '', ex_kr: '', ex_en: '' });
  });

  it('switches to Lists tab and opens ListDetailSheet via getListDetail', async () => {
    vi.mocked(vocabService.getListDetail).mockResolvedValue(SERVER_LIST_DETAIL);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('tab', { name: 'Lists' }));
    expect(screen.getByText('My lists')).toBeInTheDocument();
    // The custom list row is a button labelled by its KR name.
    await user.click(screen.getByRole('button', { name: /병원 어휘/ }));

    await waitFor(() => {
      expect(vocabService.getListDetail).toHaveBeenCalledWith(7);
    });
  });

  it('Add to review seeds both corpora and refetches the due queue (B-013)', async () => {
    vi.mocked(vocabService.initCards)
      .mockResolvedValueOnce({ inserted: 12 })
      .mockResolvedValueOnce({ inserted: 3 });
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('tab', { name: 'Lists' }));
    const seedBefore = hoisted.refetchCalls.due;
    await user.click(screen.getByRole('button', { name: 'Add to review' }));

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
    // The Session tab's due queue is re-pulled so the freshly-seeded cards
    // appear without a manual "Start new session" tap.
    expect(hoisted.refetchCalls.due).toBeGreaterThan(seedBefore);
  });

  it('Add to review reports the idempotent zero-inserted case without refetching (B-013)', async () => {
    vi.mocked(vocabService.initCards).mockResolvedValue({ inserted: 0 });
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('tab', { name: 'Lists' }));
    const seedBefore = hoisted.refetchCalls.due;
    await user.click(screen.getByRole('button', { name: 'Add to review' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "You're all caught up — every loaded word already has a review card.",
        ),
      ).toBeInTheDocument();
    });
    // Nothing changed server-side, so there's nothing new for the Session
    // tab to pick up — a refetch here would just be a wasted round trip.
    expect(hoisted.refetchCalls.due).toBe(seedBefore);
  });

  it('Add to review surfaces an ApiError message and re-enables the button on failure (B-013)', async () => {
    vi.mocked(vocabService.initCards).mockRejectedValueOnce(
      new ApiError('rate limited', { status: 429, code: 'rate_limited' }),
    );
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('tab', { name: 'Lists' }));
    const seedButton = screen.getByRole('button', { name: 'Add to review' });
    await user.click(seedButton);

    await waitFor(() => {
      // Fixed 429 copy (F-UP-018) — never the raw server prose.
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Rate-limited right now. Wait a moment and try again.',
      );
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent('rate limited');
    expect(seedButton).not.toBeDisabled();
    // The second corpus call never fires — the loop bails on the first
    // rejection rather than silently swallowing it and moving on.
    expect(vocabService.initCards).toHaveBeenCalledTimes(1);
  });

  it('All tab debounces query input and calls searchEntries', async () => {
    vi.mocked(vocabService.searchEntries).mockResolvedValue(SERVER_ENTRIES);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };
    hoisted.all.state = { kind: 'data', data: [], isMock: false };

    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole('tab', { name: 'All cards' }));

    const input = screen.getByLabelText('Search banked vocab');
    await user.type(input, '학교');

    // Allow the 200ms debounce to flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    // The hook key now reflects the debounced value.
    expect(hoisted.lastAllKey).toBe('review:all:학교');

    // Invoke the captured realFn — the component would do this through the
    // hook on key change; the test's hook mock only captures it.
    await act(async () => {
      await hoisted.capturedRealFns.all?.();
    });

    expect(vocabService.searchEntries).toHaveBeenCalledWith({ q: '학교' });
  });

  it('renders EmptyCard (not ErrorCard) when the bank is empty', () => {
    hoisted.due.state = { kind: 'data', data: [], isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };
    renderReview();

    expect(screen.getByText(/0 cards in your bank yet/)).toBeInTheDocument();
    // No vermilion ErrorCard / Retry button on an empty bank.
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });

  it('renders ErrorCard with Retry when a fetch errors and refetch fires', async () => {
    const err = new ApiError('boom', { status: 500, code: 'server_error' });
    hoisted.due.state = { kind: 'error', error: err };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    const retry = screen.getByRole('button', { name: /Retry/i });
    expect(retry).toBeInTheDocument();
    await user.click(retry);
    // SessionPanel's retry routes through both refetches.
    expect(hoisted.refetchCalls.due).toBeGreaterThan(0);
    expect(hoisted.refetchCalls.lists).toBeGreaterThan(0);
  });

  it('spacebar reveals the flashcard back (D-B3)', async () => {
    // Hook captures the realFn but the spacebar listener doesn't need the
    // DueCard snapshot — it only flips the local `flipped` state.
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    renderReview();

    // Before reveal: the Flashcard's aria-expanded reads false. (The
    // component uses aria-expanded — semantically appropriate for a flip
    // that reveals a hidden face.)
    const flip = screen.getByRole('button', { name: 'Flip card' });
    expect(flip.getAttribute('aria-expanded')).toBe('false');

    // Pass-2 idiom: fireEvent.keyDown on window — userEvent + fake timers
    // deadlocks in happy-dom for the window-bound listener path.
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });

    // After reveal: aria-expanded flips true.
    expect(flip.getAttribute('aria-expanded')).toBe('true');
    // And the rating buttons appear (rendered only while `flipped`).
    expect(screen.getByRole('button', { name: /Again/ })).toBeInTheDocument();
  });

  it('spacebar is ignored while a Sheet is open (D-B3 sheet-open guard)', async () => {
    vi.mocked(vocabService.getListDetail).mockResolvedValue(SERVER_LIST_DETAIL);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    // Open ListDetailSheet by switching to Lists and tapping the active row.
    await user.click(screen.getByRole('tab', { name: 'Lists' }));
    await user.click(screen.getByRole('button', { name: /병원 어휘/ }));
    await waitFor(() => {
      expect(vocabService.getListDetail).toHaveBeenCalledWith(7);
    });

    // Back to the Session tab so the flashcard is rendered behind the open
    // sheet. The session-tab effect re-mounts the spacebar listener but the
    // sheet-open guard suppresses the reveal. `fireEvent.click` instead of
    // `user.click` here so the Sheet's backdrop (which would otherwise
    // intercept a pointer-event-simulated click via elementFromPoint in
    // some happy-dom configs) can't accidentally close the sheet before
    // we get to assert the guard.
    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));

    const flip = screen.getByRole('button', { name: 'Flip card' });
    expect(flip.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });

    // Sheet-open guard preserved from Pass 2: no reveal.
    expect(flip.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.queryByRole('button', { name: /Again/ }),
    ).not.toBeInTheDocument();
  });

  it('logs study time on unmount when at least one card was rated', async () => {
    vi.mocked(vocabService.getDueCards).mockResolvedValue(DUE_RAW);
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 3,
    });
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    const { unmount } = renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Good/ }));

    unmount();

    expect(progressService.logStudy).toHaveBeenCalledWith(
      expect.objectContaining({ activity: 'review' }),
    );
  });

  // ── FU-NF-42 B3: grammar production cards in the Review loop ─────────────

  it('renders a grammar production section from due grammar cards', async () => {
    // getDueCards returns ONLY a grammar production card; the realFn partitions
    // it into the grammar section (and out of the vocab deck). The hook's data
    // is the vocab deck (empty here), so we drive `setGrammarCards` via the
    // captured realFn.
    vi.mocked(vocabService.getDueCards).mockResolvedValue(GRAMMAR_DUE);
    hoisted.due.state = { kind: 'data', data: [], isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    expect(
      await screen.findByText('Grammar production · 1 due'),
    ).toBeInTheDocument();
    expect(screen.getByText('-더라도')).toBeInTheDocument();
    expect(screen.getByText('even if / even though')).toBeInTheDocument();
    // The vocab "empty bank" state must NOT show — there is work to do.
    expect(screen.queryByText(/0 cards in your bank yet/)).not.toBeInTheDocument();
  });

  it('navigates to the Grammar Drill tab with the pattern when a grammar card is activated', async () => {
    vi.mocked(vocabService.getDueCards).mockResolvedValue(GRAMMAR_DUE);
    hoisted.due.state = { kind: 'data', data: [], isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    await user.click(screen.getByRole('button', { name: /Drill -더라도/ }));

    // The deep-link landed on /grammar carrying the drillTarget in router state.
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

  it('keeps the vocab flashcard flow intact alongside a grammar card (no regression)', async () => {
    // Both a grammar production card AND a vocab card are due. The vocab card
    // must still flow through the flashcard deck untouched.
    vi.mocked(vocabService.getDueCards).mockResolvedValue([
      ...GRAMMAR_DUE,
      ...DUE_RAW,
    ]);
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
      scheduled_days: 0,
    });
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    renderReview();

    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    // Grammar section renders…
    expect(
      await screen.findByText('Grammar production · 1 due'),
    ).toBeInTheDocument();
    // …and the vocab flashcard rating still works exactly as before.
    await user.click(screen.getByRole('button', { name: 'Flip card' }));
    await user.click(screen.getByRole('button', { name: /Again/ }));
    expect(vocabService.submitReview).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ rating: 'again' }),
    );
  });
});
