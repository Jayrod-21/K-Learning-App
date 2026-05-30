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
  getList: vi.fn(),
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

import { Review } from './Review';
import * as vocabService from '../services/vocab';
import * as progressService from '../services/progress';

// ── Fixtures ─────────────────────────────────────────────────────────
const DUE_VOCAB: Vocab[] = [
  {
    id: 'd:101',
    kr: '영향',
    pos: 'n.',
    en: '',
    ex_kr: '',
    ex_en: '',
    extra: [],
  },
];

const DUE_RAW: DueCard[] = [
  {
    id: 101,
    face: '영향',
    due_at: new Date().toISOString(),
    stability: '0',
    difficulty: '0',
    fsrs_state: 'new',
    vocab_entry_id: 1,
    grammar_entry_id: null,
    source_sentence_id: null,
    topik_item_id: null,
    version: 1,
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
  name: '병원 어휘',
  kind: 'vocab',
  description: 'Hospital words',
  entry_count: 5,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
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
    render(<Review />);
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the session panel with the first due card', () => {
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };
    render(<Review />);

    expect(screen.getByText('복습 · Review')).toBeInTheDocument();
    expect(screen.getByText('Active list')).toBeInTheDocument();
    expect(screen.getAllByText('영향').length).toBeGreaterThan(0);
    expect(screen.getByText(/Tap card or press/)).toBeInTheDocument();
  });

  it('rate Again calls submitReview when the card has a wire snapshot', async () => {
    // Wire the realFn to populate the dueCardIndex so submitReview can resolve
    // the numeric cardId. The hook mock captures realFn; we invoke it manually.
    vi.mocked(vocabService.getDueCards).mockResolvedValue(DUE_RAW);
    vi.mocked(vocabService.submitReview).mockResolvedValue({
      version: 2,
      due_at: new Date().toISOString(),
    });
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    render(<Review />);

    // Prime the index by invoking the captured realFn.
    await act(async () => {
      await hoisted.capturedRealFns.due?.();
    });

    // Reveal the back so the rating buttons appear.
    await user.click(screen.getByRole('button', { name: 'Flip card' }));

    await user.click(screen.getByRole('button', { name: /Again/ }));

    expect(vocabService.submitReview).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ rating: 'again' }),
    );
  });

  it('switches to Lists tab and opens ListDetailSheet via getList', async () => {
    vi.mocked(vocabService.getList).mockResolvedValue(SERVER_LIST);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    render(<Review />);

    await user.click(screen.getByRole('tab', { name: 'Lists' }));
    expect(screen.getByText('My lists')).toBeInTheDocument();
    // The custom list row is a button labelled by its KR name.
    await user.click(screen.getByRole('button', { name: /병원 어휘/ }));

    await waitFor(() => {
      expect(vocabService.getList).toHaveBeenCalledWith(7);
    });
  });

  it('All tab debounces query input and calls searchEntries', async () => {
    vi.mocked(vocabService.searchEntries).mockResolvedValue(SERVER_ENTRIES);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };
    hoisted.all.state = { kind: 'data', data: [], isMock: false };

    const user = userEvent.setup();
    render(<Review />);

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
    render(<Review />);

    expect(screen.getByText(/0 cards in your bank yet/)).toBeInTheDocument();
    // No vermilion ErrorCard / Retry button on an empty bank.
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });

  it('renders ErrorCard with Retry when a fetch errors and refetch fires', async () => {
    const err = new ApiError('boom', { status: 500, code: 'server_error' });
    hoisted.due.state = { kind: 'error', error: err };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    render(<Review />);

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

    render(<Review />);

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
    vi.mocked(vocabService.getList).mockResolvedValue(SERVER_LIST);
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    render(<Review />);

    // Open ListDetailSheet by switching to Lists and tapping the active row.
    await user.click(screen.getByRole('tab', { name: 'Lists' }));
    await user.click(screen.getByRole('button', { name: /병원 어휘/ }));
    await waitFor(() => {
      expect(vocabService.getList).toHaveBeenCalledWith(7);
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
    });
    hoisted.due.state = { kind: 'data', data: DUE_VOCAB, isMock: false };
    hoisted.lists.state = { kind: 'data', data: BUNDLE, isMock: false };

    const user = userEvent.setup();
    const { unmount } = render(<Review />);

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
});
