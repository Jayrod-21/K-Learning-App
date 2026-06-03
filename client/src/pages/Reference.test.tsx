/**
 * Resources (Reference) — tabbed browse + This Week suggest-only + lists.
 *
 * Services are module-mocked; the component's own state/effects run for real
 * so the debounce, pagination, optimistic add-flip, and 409-idempotency paths
 * participate in the assertions.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import type {
  KgiuEntrySummary,
  KrdictSearchEntry,
  ServerVocabList,
  VocabEntry,
} from '../types/domain';

const vocabSvc = vi.hoisted(() => ({
  searchEntriesPage: vi.fn(),
  bankEntry: vi.fn(),
  listLists: vi.fn(),
  createList: vi.fn(),
  getListDetail: vi.fn(),
  deleteList: vi.fn(),
  addListEntries: vi.fn(),
  removeListEntry: vi.fn(),
}));

const grammarSvc = vi.hoisted(() => ({
  listPatterns: vi.fn(),
  bankPattern: vi.fn(),
}));

const krdictSvc = vi.hoisted(() => ({ searchKrdict: vi.fn() }));

const suggestSvc = vi.hoisted(() => ({
  fetchWeeklyVocabSuggestions: vi.fn(),
  fetchWeeklyGrammarSuggestions: vi.fn(),
}));

vi.mock('../services/vocab', () => vocabSvc);
vi.mock('../services/grammar', () => grammarSvc);
vi.mock('../services/krdict', () => krdictSvc);
vi.mock('../services/suggestions', () => suggestSvc);

import Reference from './Reference';

const VOCAB_ROWS: VocabEntry[] = [
  { id: 1, corpus: 'vocab_2000_intermediate', korean: '영향', english: 'influence', proficiency: 'L3', theme: null },
  { id: 2, corpus: 'vocab_2000_intermediate', korean: '환경', english: 'environment', proficiency: 'L3', theme: null },
];

const SUGGEST_VOCAB: VocabEntry[] = [
  { id: 11, corpus: 'vocab_2000_intermediate', korean: '결과', english: 'result', proficiency: 'L3', theme: null },
];

const SUGGEST_GRAMMAR: KgiuEntrySummary[] = [
  {
    id: 100,
    corpus: 'kgiu_intermediate',
    source_id: 'KGIU-INT-009',
    pattern: '-는 반면에',
    title_en: 'whereas',
    category: 'contrast',
    proficiency: 'L4',
    unit: 'Unit 9',
    source_pages: null,
  },
];

const KRDICT_HIT: KrdictSearchEntry = {
  id: 5,
  headword: '학교',
  part_of_speech: 'n.',
  definition_korean: '학생을 가르치는 곳',
  definition_english: 'a school',
};

const SERVER_LIST: ServerVocabList = {
  id: 7,
  name_kr: '병원 어휘',
  name_en: 'Hospital words',
  kind: 'vocab',
  version: 1,
  entry_count: 2,
  created_at: 'x',
  updated_at: 'y',
};

function renderResources(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <Reference />
    </ToastProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(vocabSvc)) (fn as Mock).mockReset();
  for (const fn of Object.values(grammarSvc)) (fn as Mock).mockReset();
  (krdictSvc.searchKrdict as Mock).mockReset();
  for (const fn of Object.values(suggestSvc)) (fn as Mock).mockReset();

  vocabSvc.searchEntriesPage.mockResolvedValue({
    entries: VOCAB_ROWS,
    total: 3131,
    limit: 30,
    offset: 0,
  });
  vocabSvc.bankEntry.mockResolvedValue({ card: { id: 1, version: 1 } });
  vocabSvc.listLists.mockResolvedValue([SERVER_LIST]);
  vocabSvc.createList.mockResolvedValue({ list: SERVER_LIST, appended: 0 });
  vocabSvc.getListDetail.mockResolvedValue({
    list: SERVER_LIST,
    entries: [
      { entry_id: 1, position: 0, added_at: 'x', korean: '영향', english: 'influence', proficiency: 'L3' },
    ],
    entry_limit: 100,
    entry_offset: 0,
  });
  vocabSvc.deleteList.mockResolvedValue(undefined);
  vocabSvc.addListEntries.mockResolvedValue({ entries: [{ entry_id: 1, position: 0, added_at: 'x' }] });
  vocabSvc.removeListEntry.mockResolvedValue(undefined);

  grammarSvc.listPatterns.mockResolvedValue(SUGGEST_GRAMMAR);
  grammarSvc.bankPattern.mockResolvedValue({ id: 1 });

  krdictSvc.searchKrdict.mockResolvedValue({ entries: [KRDICT_HIT], total: 1 });

  suggestSvc.fetchWeeklyVocabSuggestions.mockResolvedValue(SUGGEST_VOCAB);
  suggestSvc.fetchWeeklyGrammarSuggestions.mockResolvedValue(SUGGEST_GRAMMAR);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Resources — default Vocabulary tab', () => {
  it('renders the curated corpus rows with the real total in the pager', async () => {
    renderResources();
    expect(await screen.findByText('영향')).toBeInTheDocument();
    expect(screen.getByText('환경')).toBeInTheDocument();
    // Pager reflects the server's real total (3,131), not the page length.
    expect(screen.getByText(/of 3131/)).toBeInTheDocument();
  });

  it('searches the corpus after the debounce', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');
    vocabSvc.searchEntriesPage.mockClear();

    await user.type(screen.getByRole('searchbox', { name: 'Search vocabulary' }), '환경');

    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.objectContaining({ q: '환경', limit: 30, offset: 0 }),
        expect.anything(),
      );
    });
  });
});

describe('Resources — This Week (suggest-only)', () => {
  it('adds a vocab pick and flips the button to ✓ Added', async () => {
    const user = userEvent.setup();
    renderResources();
    // The suggestion strip renders the vocab pick with its own Add button.
    const addBtn = await screen.findByRole('button', { name: 'Add 결과' });
    await user.click(addBtn);

    expect(vocabSvc.bankEntry).toHaveBeenCalledWith(11);
    expect(await screen.findByText('✓ Added')).toBeInTheDocument();
  });

  it('treats a 409 (already banked) as success — idempotent flip, no error', async () => {
    vocabSvc.bankEntry.mockRejectedValueOnce(
      new ApiError('already banked', { status: 409, code: 'conflict' }),
    );
    const user = userEvent.setup();
    renderResources();
    await user.click(await screen.findByRole('button', { name: 'Add 결과' }));

    expect(await screen.findByText('✓ Added')).toBeInTheDocument();
  });

  it('adds a grammar pick through the bank path', async () => {
    const user = userEvent.setup();
    renderResources();
    await user.click(await screen.findByRole('button', { name: 'Add -는 반면에' }));

    await waitFor(() => {
      expect(grammarSvc.bankPattern).toHaveBeenCalledWith(
        expect.objectContaining({ pattern_key: 'KGIU-INT-009', pattern_display: '-는 반면에' }),
      );
    });
  });
});

describe('Resources — Dictionary tab (search-first)', () => {
  it('prompts to type before any search, then shows paginated KRDICT hits', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향'); // wait for first paint

    await user.click(screen.getByRole('tab', { name: 'Dictionary' }));
    // Empty state — no network call yet.
    expect(
      screen.getByText(/Type a Korean or English word/i),
    ).toBeInTheDocument();
    expect(krdictSvc.searchKrdict).not.toHaveBeenCalled();

    await user.type(screen.getByRole('searchbox', { name: 'Search dictionary' }), '학교');
    expect(await screen.findByText('학교')).toBeInTheDocument();
    expect(screen.getByText('a school')).toBeInTheDocument();
    expect(krdictSvc.searchKrdict).toHaveBeenCalled();
  });
});

describe('Resources — Grammar tab', () => {
  it('lists every pattern from the full (raised-limit) fetch', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: 'Grammar' }));
    // The pattern-count line is unique to the Grammar tab (This Week has no
    // such line), so it disambiguates from the suggestion strip's copy of the
    // same pattern text.
    expect(await screen.findByText(/1 pattern/)).toBeInTheDocument();
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 400 }),
        expect.anything(),
      );
    });
  });
});

describe('Resources — My Lists tab', () => {
  it('creates a list and opens it to show entries', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: 'My Lists' }));
    expect(await screen.findByText('병원 어휘')).toBeInTheDocument();

    // Create flow.
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), '새 단어장');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '새 단어장',
        kind: 'vocab',
      });
    });

    // Open detail → entries load via getListDetail.
    await user.click(screen.getByRole('button', { name: /Open 병원 어휘/ }));
    await waitFor(() => {
      expect(vocabSvc.getListDetail).toHaveBeenCalledWith(7, expect.anything());
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('영향')).toBeInTheDocument();
  });

  it('removes an entry from an open list (optimistic)', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: 'My Lists' }));
    await user.click(await screen.findByRole('button', { name: /Open 병원 어휘/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('영향');

    await user.click(
      within(dialog).getByRole('button', { name: /Remove 영향 from the list/ }),
    );
    expect(vocabSvc.removeListEntry).toHaveBeenCalledWith(7, 1);
  });
});

describe('Resources — add a corpus word to a list', () => {
  it('opens the picker and posts the entry id', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    // The Vocabulary row's "List" affordance opens the picker sheet.
    await user.click(screen.getByRole('button', { name: /Add 영향 to a list/ }));
    const dialog = await screen.findByRole('dialog');
    // Pick the only list.
    await user.click(within(dialog).getByRole('button', { name: /병원 어휘/ }));

    await waitFor(() => {
      expect(vocabSvc.addListEntries).toHaveBeenCalledWith(7, [1]);
    });
  });
});
