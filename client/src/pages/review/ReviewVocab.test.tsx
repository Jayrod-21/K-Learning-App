/**
 * ReviewVocab — the library's vocabulary page (P1.2).
 *
 * Ports the old Reference.tsx tests for the Vocabulary tab (corpus browse,
 * F-003 filters, the stale-rows fix), the "This Week" suggest-only strip,
 * and the add-to-list picker — plus the UNIFIED My-Lists surface (the P1.2
 * dedup): create / open / remove-entry (from Reference) and rename (from
 * the old Review.tsx sheet), reachable via the `?tab=lists` deep link.
 *
 * Services are module-mocked; the component's own state/effects run for
 * real so debounce, pagination, optimistic flips, and 409-idempotency
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
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ToastProvider';
import { ApiError } from '../../services/api';
import type {
  KgiuEntrySummary,
  ServerVocabList,
  VocabEntry,
} from '../../types/domain';

const vocabSvc = vi.hoisted(() => ({
  searchEntriesPage: vi.fn(),
  bankEntry: vi.fn(),
  listLists: vi.fn(),
  createList: vi.fn(),
  getListDetail: vi.fn(),
  patchList: vi.fn(),
  deleteList: vi.fn(),
  addListEntries: vi.fn(),
  removeListEntry: vi.fn(),
}));

const grammarSvc = vi.hoisted(() => ({
  bankPattern: vi.fn(),
}));

const suggestSvc = vi.hoisted(() => ({
  fetchWeeklyVocabSuggestions: vi.fn(),
  fetchWeeklyGrammarSuggestions: vi.fn(),
}));

vi.mock('../../services/vocab', () => vocabSvc);
vi.mock('../../services/grammar', () => grammarSvc);
vi.mock('../../services/suggestions', () => suggestSvc);

import ReviewVocab from './ReviewVocab';

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

/** `initialPath` lets a test land with the `?tab=lists` deep link. */
function renderPage(initialPath = '/review/vocab'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <Routes>
          <Route path="/review/vocab" element={<ReviewVocab />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(vocabSvc)) (fn as Mock).mockReset();
  (grammarSvc.bankPattern as Mock).mockReset();
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
  vocabSvc.patchList.mockResolvedValue({
    list: { ...SERVER_LIST, name_kr: '새 이름' },
  });
  vocabSvc.deleteList.mockResolvedValue(undefined);
  vocabSvc.addListEntries.mockResolvedValue({
    entries: [{ entry_id: 1, position: 0, added_at: 'x' }],
  });
  vocabSvc.removeListEntry.mockResolvedValue(undefined);

  grammarSvc.bankPattern.mockResolvedValue({ id: 1 });

  suggestSvc.fetchWeeklyVocabSuggestions.mockResolvedValue(SUGGEST_VOCAB);
  suggestSvc.fetchWeeklyGrammarSuggestions.mockResolvedValue(SUGGEST_GRAMMAR);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewVocab — default Browse view (the old Reference Vocabulary tab)', () => {
  it('renders the curated corpus rows with the real total in the pager', async () => {
    renderPage();
    expect(await screen.findByText('영향')).toBeInTheDocument();
    expect(screen.getByText('환경')).toBeInTheDocument();
    // Pager reflects the server's real total (3,131), not the page length.
    expect(screen.getByText(/of 3131/)).toBeInTheDocument();
  });

  it('searches the corpus after the debounce', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');
    vocabSvc.searchEntriesPage.mockClear();

    await user.type(
      screen.getByRole('searchbox', { name: 'Search vocabulary' }),
      '환경',
    );

    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.objectContaining({ q: '환경', limit: 30, offset: 0 }),
        expect.anything(),
      );
    });
  });

  it('domain + level filters refetch with the matching query params and reset paging (F-003)', async () => {
    const user = userEvent.setup();
    renderPage();
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

  it('a failed Next-page fetch shows an ErrorCard + Retry instead of stale rows (stale-rows fix)', async () => {
    const user = userEvent.setup();
    const PAGE_2: VocabEntry[] = [
      {
        id: 3,
        corpus: 'vocab_2000_intermediate',
        korean: '사회',
        english: 'society',
        proficiency: 'L3',
        theme: null,
      },
    ];
    vocabSvc.searchEntriesPage
      .mockResolvedValueOnce({
        entries: VOCAB_ROWS,
        total: 3131,
        limit: 30,
        offset: 0,
      })
      .mockRejectedValueOnce(
        new ApiError('vocab page failed', { status: 500, code: 'server' }),
      )
      .mockResolvedValue({
        entries: PAGE_2,
        total: 3131,
        limit: 30,
        offset: 30,
      });

    renderPage();
    await screen.findByText('영향');
    expect(screen.getByText(/1–30 of 3131/)).toBeInTheDocument();

    // The Next-page fetch fails — the failure must surface, not the stale
    // page-1 rows under an advanced pager range.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      await screen.findByText('Could not load vocabulary.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('vocab page failed')).not.toBeInTheDocument();
    expect(screen.queryByText('영향')).not.toBeInTheDocument();
    expect(screen.queryByText(/31–60/)).not.toBeInTheDocument();

    // Retry re-runs the failed page fetch and renders the real page 2.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('사회')).toBeInTheDocument();
    expect(screen.getByText(/31–60 of 3131/)).toBeInTheDocument();
  });
});

describe('ReviewVocab — This Week (suggest-only, transitional home)', () => {
  it('adds a vocab pick and flips the button to ✓ Added', async () => {
    const user = userEvent.setup();
    renderPage();
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
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add 결과' }));

    expect(await screen.findByText('✓ Added')).toBeInTheDocument();
  });

  it('adds a grammar pick through the bank path with a GR-shaped key', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Add -는 반면에' }),
    );

    await waitFor(() => {
      // The key satisfies the server's /^GR-[a-z0-9_-]{1,64}$/ — the raw
      // source_id 'KGIU-INT-009' would have been rejected with a 400.
      expect(grammarSvc.bankPattern).toHaveBeenCalledWith(
        expect.objectContaining({
          pattern_key: 'GR-kgiu-int-009',
          pattern_display: '-는 반면에',
        }),
      );
    });
  });
});

describe('ReviewVocab — add a corpus word to a list', () => {
  it('opens the picker and posts the entry id', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');

    await user.click(screen.getByRole('button', { name: /Add 영향 to a list/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /병원 어휘/ }));

    await waitFor(() => {
      expect(vocabSvc.addListEntries).toHaveBeenCalledWith(7, [1]);
    });
  });
});

describe('ReviewVocab — bilingual chrome (P3b)', () => {
  it('renders the title + "Review library" eyebrow with Korean in both-mode', async () => {
    renderPage();
    await screen.findByText('영향');
    expect(
      screen.getByRole('heading', { level: 1, name: '단어 · Vocabulary' }),
    ).toBeInTheDocument();
    expect(screen.getByText('복습 자료실')).toBeInTheDocument();
    expect(screen.getByText('Review library')).toBeInTheDocument();
  });
});

describe('ReviewVocab — My lists (THE unified surface, P1.2 dedup)', () => {
  it('opens the lists view via the ?tab=lists deep link', async () => {
    renderPage('/review/vocab?tab=lists');
    expect(
      screen.getByRole('tab', { name: '내 단어장 · My lists' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('병원 어휘')).toBeInTheDocument();
  });

  it('creates a list and opens it to show entries', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');

    await user.click(screen.getByRole('tab', { name: '내 단어장 · My lists' }));
    expect(await screen.findByText('병원 어휘')).toBeInTheDocument();

    // Create flow — default kind stays 'vocab'.
    await user.type(
      screen.getByRole('textbox', { name: 'New list name' }),
      '새 단어장',
    );
    await user.click(screen.getByRole('button', { name: /^만들기 · Create$/ }));
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

  it('includes the optional English label and kind in the create body', async () => {
    const user = userEvent.setup();
    renderPage('/review/vocab?tab=lists');
    await screen.findByText('병원 어휘');

    await user.type(
      screen.getByRole('textbox', { name: 'New list name' }),
      '한자 목록',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'English label' }),
      'Hanja list',
    );
    await user.click(screen.getByRole('radio', { name: '한자 · hanja' }));
    await user.click(screen.getByRole('button', { name: /^만들기 · Create$/ }));

    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '한자 목록',
        kind: 'hanja',
        name_en: 'Hanja list',
      });
    });
  });

  it('removes an entry from an open list (optimistic)', async () => {
    const user = userEvent.setup();
    renderPage('/review/vocab?tab=lists');

    await user.click(
      await screen.findByRole('button', { name: /Open 병원 어휘/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('영향');

    await user.click(
      within(dialog).getByRole('button', { name: /Remove 영향 from the list/ }),
    );
    expect(vocabSvc.removeListEntry).toHaveBeenCalledWith(7, 1);
  });

  it('renames a list from the detail sheet (capability kept from the old Review sheet)', async () => {
    const user = userEvent.setup();
    renderPage('/review/vocab?tab=lists');

    await user.click(
      await screen.findByRole('button', { name: /Open 병원 어휘/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('영향');

    await user.click(within(dialog).getByRole('button', { name: '이름 변경 · Rename' }));
    const nameInput = within(dialog).getByRole('textbox', {
      name: 'List name',
    });
    await user.clear(nameInput);
    await user.type(nameInput, '새 이름');
    await user.click(
      within(dialog).getByRole('button', { name: '이름 저장 · Save name' }),
    );

    await waitFor(() => {
      expect(vocabSvc.patchList).toHaveBeenCalledWith(7, { name_kr: '새 이름' });
    });
    // The header reflects the server-confirmed name.
    expect(await within(dialog).findByText('새 이름')).toBeInTheDocument();
  });

  it('deletes a list behind a confirm gate', async () => {
    // happy-dom ships no window.confirm — stub it (accepting the dialog).
    const confirmFn = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmFn);
    try {
      const user = userEvent.setup();
      renderPage('/review/vocab?tab=lists');
      await screen.findByText('병원 어휘');

      await user.click(
        screen.getByRole('button', { name: 'Delete 병원 어휘' }),
      );
      await waitFor(() => {
        expect(vocabSvc.deleteList).toHaveBeenCalledWith(7);
      });
      expect(confirmFn).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
