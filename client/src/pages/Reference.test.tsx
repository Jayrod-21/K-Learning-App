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
  getPattern: vi.fn(),
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
import { grammarKey } from '../lib/grammarKey';

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

const KGIU_DETAIL = {
  ...SUGGEST_GRAMMAR[0]!,
  explanation: 'Contrasts two clauses — "whereas / while on the other hand".',
  formation_rules: null,
  examples: null,
  dialogues: null,
  vocabulary: null,
  tips: null,
  compare_with: null,
  exercises: null,
  cultural_notes: null,
};

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
  grammarSvc.getPattern.mockResolvedValue(KGIU_DETAIL);

  krdictSvc.searchKrdict.mockResolvedValue({ entries: [KRDICT_HIT], total: 1 });

  suggestSvc.fetchWeeklyVocabSuggestions.mockResolvedValue(SUGGEST_VOCAB);
  suggestSvc.fetchWeeklyGrammarSuggestions.mockResolvedValue(SUGGEST_GRAMMAR);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('grammarKey — always emits a server-valid GR- key (F2)', () => {
  const GR_KEY = /^GR-[a-z0-9_-]{1,64}$/;
  const base: Omit<KgiuEntrySummary, 'id' | 'source_id' | 'pattern'> = {
    corpus: 'kgiu_intermediate',
    title_en: null,
    category: null,
    proficiency: null,
    unit: null,
    source_pages: null,
  };
  const make = (
    over: Partial<KgiuEntrySummary> & Pick<KgiuEntrySummary, 'id'>,
  ): KgiuEntrySummary => ({
    source_id: null,
    pattern: '-는 반면에',
    ...base,
    ...over,
  });

  it('slugifies an ASCII source_id to the allowed alphabet', () => {
    const key = grammarKey(make({ id: 100, source_id: 'KGIU-INT-009' }));
    expect(key).toBe('GR-kgiu-int-009');
    expect(key).toMatch(GR_KEY);
  });

  it('falls back to kgiu-${id} when source_id is null', () => {
    const key = grammarKey(make({ id: 42, source_id: null }));
    expect(key).toBe('GR-kgiu-42');
    expect(key).toMatch(GR_KEY);
  });

  it('falls back to kgiu-${id} when source_id slugs to empty (all-Korean)', () => {
    // A Korean source_id has no [a-z0-9_-] chars → slug collapses to '' →
    // kgiu-${id} fallback rather than an invalid `GR-` key.
    const key = grammarKey(make({ id: 7, source_id: '한국어' }));
    expect(key).toBe('GR-kgiu-7');
    expect(key).toMatch(GR_KEY);
  });

  it('a Korean pattern never leaks into the key', () => {
    const key = grammarKey(make({ id: 3, source_id: null, pattern: '-(으)면' }));
    expect(key).toMatch(GR_KEY);
    expect(key).not.toContain('(');
    expect(key).not.toContain('으');
  });

  it('truncates an over-long slug to 64 chars (after the GR- prefix)', () => {
    const longId = 'a'.repeat(200);
    const key = grammarKey(make({ id: 9, source_id: longId }));
    expect(key.startsWith('GR-')).toBe(true);
    expect(key.slice(3).length).toBe(64);
    expect(key).toMatch(GR_KEY);
  });

  it('collapses runs of disallowed chars and trims edges', () => {
    const key = grammarKey(make({ id: 1, source_id: '--A  B__C!!--' }));
    // lowercase, collapse non-alnum runs to single '-', trim edges; '_' kept.
    expect(key).toBe('GR-a-b__c');
    expect(key).toMatch(GR_KEY);
  });
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

  it('adds a grammar pick through the bank path with a GR-shaped key', async () => {
    const user = userEvent.setup();
    renderResources();
    await user.click(await screen.findByRole('button', { name: 'Add -는 반면에' }));

    await waitFor(() => {
      // The key is derived to satisfy the server's /^GR-[a-z0-9_-]{1,64}$/ —
      // 'KGIU-INT-009' slugifies to 'GR-kgiu-int-009' (the raw source_id would
      // have been rejected with a 400).
      expect(grammarSvc.bankPattern).toHaveBeenCalledWith(
        expect.objectContaining({
          pattern_key: 'GR-kgiu-int-009',
          pattern_display: '-는 반면에',
        }),
      );
    });
  });
});

describe('Resources — Dictionary tab (browse + search)', () => {
  it('browses the dictionary on open (no query needed), then searches on type', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향'); // wait for first paint

    await user.click(screen.getByRole('tab', { name: 'Dictionary' }));

    // Browse-all on mount: the tab loads page 1 WITHOUT a query (the service is
    // called with no `q`), so the user sees the dictionary immediately.
    expect(await screen.findByText('학교')).toBeInTheDocument();
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.not.objectContaining({ q: expect.anything() }),
        expect.anything(),
      );
    });

    // Typing a query switches to search results (now `q` is sent).
    krdictSvc.searchKrdict.mockClear();
    await user.type(
      screen.getByRole('searchbox', { name: 'Search dictionary' }),
      '학교',
    );
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ q: '학교' }),
        expect.anything(),
      );
    });
  });

  it('returns to browse when the query is cleared', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: 'Dictionary' }));
    await screen.findByText('학교');

    const box = screen.getByRole('searchbox', { name: 'Search dictionary' });
    await user.type(box, '학교');
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ q: '학교' }),
        expect.anything(),
      );
    });

    // Clearing the box returns to the browse-all path (no `q`).
    krdictSvc.searchKrdict.mockClear();
    await user.clear(box);
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.not.objectContaining({ q: expect.anything() }),
        expect.anything(),
      );
    });
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

  it('opens the detail Sheet on row tap — fetches getPattern(id) and renders the explanation (F-004)', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: 'Grammar' }));
    await screen.findByText(/1 pattern/);

    // The row is a real button (a11y: keyboard-operable), labelled with the
    // pattern + its English title.
    await user.click(
      screen.getByRole('button', { name: '-는 반면에 whereas' }),
    );
    expect(grammarSvc.getPattern).toHaveBeenCalledWith(100);

    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(
        'Contrasts two clauses — "whereas / while on the other hand".',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Unit 9/)).toBeInTheDocument();
  });

  it('a failed detail fetch surfaces an inline error in the Sheet (row list keeps working)', async () => {
    grammarSvc.getPattern.mockRejectedValueOnce(
      new ApiError('kgiu entry not found', { status: 404, code: 'not_found' }),
    );
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: 'Grammar' }));
    await screen.findByText(/1 pattern/);
    await user.click(
      screen.getByRole('button', { name: '-는 반면에 whereas' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('kgiu entry not found'),
    ).toBeInTheDocument();
  });

  it('domain + level filters refetch with the matching query params (F-005)', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: 'Grammar' }));
    await screen.findByText(/1 pattern/);

    grammarSvc.listPatterns.mockClear();
    const topicGroup = screen.getByRole('group', { name: 'Filter grammar by topic' });
    await user.click(within(topicGroup).getByRole('button', { name: 'Research' }));
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'research' }),
        expect.anything(),
      );
    });

    grammarSvc.listPatterns.mockClear();
    const levelGroup = screen.getByRole('group', { name: 'Filter grammar by level' });
    await user.click(within(levelGroup).getByRole('button', { name: 'Advanced' }));
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'research', book_level: 'advanced' }),
        expect.anything(),
      );
    });

    // Back to All → the param is omitted again (never sent as 'all').
    grammarSvc.listPatterns.mockClear();
    await user.click(within(topicGroup).getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(grammarSvc.listPatterns).toHaveBeenCalledWith(
        expect.not.objectContaining({ domain: expect.anything() }),
        expect.anything(),
      );
    });
  });
});

describe('Resources — Vocabulary tab filters (F-003)', () => {
  it('domain + level filters refetch with the matching query params and reset paging', async () => {
    const user = userEvent.setup();
    renderResources();
    await screen.findByText('영향');

    vocabSvc.searchEntriesPage.mockClear();
    const topicGroup = screen.getByRole('group', { name: 'Filter vocabulary by topic' });
    await user.click(within(topicGroup).getByRole('button', { name: 'Business' }));
    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'business', offset: 0 }),
        expect.anything(),
      );
    });

    vocabSvc.searchEntriesPage.mockClear();
    const levelGroup = screen.getByRole('group', { name: 'Filter vocabulary by level' });
    await user.click(within(levelGroup).getByRole('button', { name: 'Beginner' }));
    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'business',
          book_level: 'beginner',
          offset: 0,
        }),
        expect.anything(),
      );
    });

    // Back to All → the params are omitted again (never sent as 'all').
    vocabSvc.searchEntriesPage.mockClear();
    await user.click(within(topicGroup).getByRole('button', { name: 'All' }));
    await user.click(within(levelGroup).getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.not.objectContaining({ domain: expect.anything() }),
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
