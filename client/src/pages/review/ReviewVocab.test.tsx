/**
 * ReviewVocab — the library's vocabulary page (P3B redesign).
 *
 * Covers the stacked single-surface layout: My Lists on TOP (F-052), the
 * vocab-only "This Week" strip (F-047 — grammar content removed), the
 * browse with genre/difficulty DROPDOWN filters (F-049), the 15/+15/30
 * client window (F-051), the create-a-list-from-the-picker flow (F-048),
 * the conditional My-Uploads section (F-053 — empty until the backend
 * exists), and the BackButton (F-024).
 *
 * Services are module-mocked; the component's own state/effects run for
 * real so debounce, pagination windowing, optimistic flips, and
 * 409-idempotency participate in the assertions.
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
import type { ServerVocabList, VocabEntry } from '../../types/domain';

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

// U1 sort-by-source filter scaffolding (SourceFilterRow) — listUploads is
// best-effort and defaults to empty so every test that knows nothing about
// uploads sees no source row at all.
const uploadsSvc = vi.hoisted(() => ({
  listUploads: vi.fn(),
}));

vi.mock('../../services/vocab', () => vocabSvc);
vi.mock('../../services/grammar', () => grammarSvc);
vi.mock('../../services/suggestions', () => suggestSvc);
vi.mock('../../services/uploads', () => uploadsSvc);

import ReviewVocab from './ReviewVocab';
import type { BookUpload } from '../../types/domain';

const VOCAB_ROWS: VocabEntry[] = [
  { id: 1, corpus: 'vocab_2000_intermediate', korean: '영향', english: 'influence', proficiency: 'L3', theme: null },
  { id: 2, corpus: 'vocab_2000_intermediate', korean: '환경', english: 'environment', proficiency: 'L3', theme: null },
];

/** A full 30-row server page for the F-051 windowing tests. */
function fullPage(offset = 0): VocabEntry[] {
  return Array.from({ length: 30 }, (_, i) => ({
    id: offset + i + 100,
    corpus: 'vocab_2000_intermediate',
    korean: `단어${String(offset + i + 1)}`,
    english: `word ${String(offset + i + 1)}`,
    proficiency: 'L3',
    theme: null,
  }));
}

const SUGGEST_VOCAB: VocabEntry[] = [
  { id: 11, corpus: 'vocab_2000_intermediate', korean: '결과', english: 'result', proficiency: 'L3', theme: null },
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

/** `initialPath` lets a test land with the legacy `?tab=lists` deep link. */
function renderPage(initialPath = '/review/vocab'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <Routes>
          <Route path="/review/vocab" element={<ReviewVocab />} />
          <Route path="/review" element={<div data-testid="review-index" />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const READY_UPLOAD: BookUpload = {
  id: '9',
  title: '한국어 문법 사전',
  type: 'grammar',
  status: 'ready',
  byteSize: 4_200_000,
  createdAt: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  for (const fn of Object.values(vocabSvc)) (fn as Mock).mockReset();
  (grammarSvc.bankPattern as Mock).mockReset();
  for (const fn of Object.values(suggestSvc)) (fn as Mock).mockReset();
  uploadsSvc.listUploads.mockReset();
  uploadsSvc.listUploads.mockResolvedValue([]);

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
  suggestSvc.fetchWeeklyGrammarSuggestions.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewVocab — stacked layout (F-052) + chrome', () => {
  it('renders My Lists ABOVE the corpus browse with no tab switch needed', async () => {
    renderPage();
    // Both surfaces are present simultaneously — no tabs.
    expect(await screen.findByText('병원 어휘')).toBeInTheDocument();
    expect(await screen.findByText('영향')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    // And My Lists comes FIRST in document order (F-052).
    const listsHeading = screen.getByRole('heading', { name: '내 단어장 · My lists' });
    const browseHeading = screen.getByRole('heading', { name: '말뭉치 둘러보기 · Browse the corpus' });
    const position = listsHeading.compareDocumentPosition(browseHeading);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('still lands correctly on the legacy ?tab=lists deep link (lists are on top now)', async () => {
    renderPage('/review/vocab?tab=lists');
    expect(await screen.findByText('병원 어휘')).toBeInTheDocument();
  });

  it('has a BackButton to the library index (F-024)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');
    // The label comes from navItem('review') — the tab is "Library" (F-043).
    await user.click(screen.getByRole('button', { name: 'Back to Library' }));
    expect(screen.getByTestId('review-index')).toBeInTheDocument();
  });

  it('renders the title + the manifest "Library" eyebrow with Korean in both-mode', async () => {
    renderPage();
    await screen.findByText('영향');
    expect(
      screen.getByRole('heading', { level: 1, name: '단어 · Vocabulary' }),
    ).toBeInTheDocument();
    // Eyebrow = the parent tab's nav-manifest pair (Library · 자료실).
    // getAllByText for 'Library': the BackButton's visible label carries
    // the same manifest string on this page.
    expect(screen.getByText('자료실')).toBeInTheDocument();
    expect(screen.getAllByText('Library').length).toBeGreaterThan(0);
    // The stale hand-written pair must not linger (F-043 sweep).
    expect(screen.queryByText('Review library')).not.toBeInTheDocument();
    expect(screen.queryByText('복습 자료실')).not.toBeInTheDocument();
  });

  it('shows no "My uploads" section while no saved-from-upload vocab exists (F-053)', async () => {
    renderPage();
    await screen.findByText('영향');
    expect(screen.queryByText(/My uploads/i)).not.toBeInTheDocument();
  });
});

describe('ReviewVocab — This Week is vocab-only (F-047)', () => {
  it('never fetches or renders grammar suggestions on the vocabulary page', async () => {
    // Even a server that WOULD return grammar picks never gets asked, and
    // no grammar suggestion ever renders.
    suggestSvc.fetchWeeklyGrammarSuggestions.mockResolvedValue([
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
    ]);
    renderPage();
    // The vocab pick renders…
    expect(
      await screen.findByRole('button', { name: 'Add 결과' }),
    ).toBeInTheDocument();
    // …but the grammar suggestion fetch is skipped entirely and no grammar
    // pick exists anywhere on the page.
    expect(suggestSvc.fetchWeeklyGrammarSuggestions).not.toHaveBeenCalled();
    expect(screen.queryByText('-는 반면에')).not.toBeInTheDocument();
  });

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
});

describe('ReviewVocab — Browse (search + F-049 dropdown filters)', () => {
  it('renders the curated corpus rows', async () => {
    renderPage();
    expect(await screen.findByText('영향')).toBeInTheDocument();
    expect(screen.getByText('환경')).toBeInTheDocument();
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

  it('genre + difficulty dropdowns refetch with the matching params and reset paging (F-049)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');

    const genre = screen.getByRole('combobox', { name: 'Genre' });
    const difficulty = screen.getByRole('combobox', { name: 'Difficulty' });

    vocabSvc.searchEntriesPage.mockClear();
    await user.selectOptions(genre, 'business');
    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'business', offset: 0 }),
        expect.anything(),
      );
    });

    vocabSvc.searchEntriesPage.mockClear();
    await user.selectOptions(difficulty, 'beginner');
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

    // Back to the "All" placeholder → the params are omitted again (never
    // sent as 'all' or '').
    vocabSvc.searchEntriesPage.mockClear();
    await user.selectOptions(genre, '');
    await user.selectOptions(difficulty, '');
    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalled();
      const lastArgs: unknown = vocabSvc.searchEntriesPage.mock.lastCall?.[0];
      expect(lastArgs).not.toHaveProperty('domain');
      expect(lastArgs).not.toHaveProperty('book_level');
    });
  });

  it('offers all 3 difficulty bands in the dropdown (F-049)', async () => {
    renderPage();
    await screen.findByText('영향');
    const difficulty = screen.getByRole('combobox', { name: 'Difficulty' });
    const labels = within(difficulty)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual(['All', 'Beginner', 'Intermediate', 'Advanced']);
  });
});

describe('ReviewVocab — 15/+15/30 client window (F-051)', () => {
  it('shows 15 rows, expands to 30 via Show more, then exposes the pager', async () => {
    vocabSvc.searchEntriesPage.mockResolvedValue({
      entries: fullPage(0),
      total: 3131,
      limit: 30,
      offset: 0,
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('단어1');
    expect(screen.getByText('단어15')).toBeInTheDocument();
    expect(screen.queryByText('단어16')).not.toBeInTheDocument();
    // The pager stays hidden while the window is collapsed — its "1–30"
    // range would over-claim what is on screen.
    expect(screen.queryByText(/of 3131/)).not.toBeInTheDocument();

    // The expander announces exactly what the next click reveals.
    await user.click(screen.getByRole('button', { name: 'Show more (15)' }));
    expect(screen.getByText('단어30')).toBeInTheDocument();
    // Window exhausted → expander gone, server pager appears with a range
    // that now matches the visible rows exactly.
    expect(
      screen.queryByRole('button', { name: /Show more/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/1–30 of 3131/)).toBeInTheDocument();
  });

  it('collapses the window back to 15 when a filter changes', async () => {
    vocabSvc.searchEntriesPage.mockResolvedValue({
      entries: fullPage(0),
      total: 3131,
      limit: 30,
      offset: 0,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('단어1');

    await user.click(screen.getByRole('button', { name: 'Show more (15)' }));
    expect(screen.getByText('단어30')).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Genre' }),
      'business',
    );
    await waitFor(() => {
      expect(screen.queryByText('단어16')).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'Show more (15)' }),
    ).toBeInTheDocument();
  });

  it('a failed Next-page fetch shows an ErrorCard + Retry instead of stale rows', async () => {
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
        entries: fullPage(0),
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
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('단어1');

    // Expand the window fully to reach the pager, then move to page 2.
    await user.click(screen.getByRole('button', { name: 'Show more (15)' }));
    expect(screen.getByText(/1–30 of 3131/)).toBeInTheDocument();

    // The Next-page fetch fails — the failure must surface, not the stale
    // page-1 rows under an advanced pager range.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      await screen.findByText('Could not load vocabulary.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('vocab page failed')).not.toBeInTheDocument();
    expect(screen.queryByText('단어1')).not.toBeInTheDocument();
    expect(screen.queryByText(/31–60/)).not.toBeInTheDocument();

    // Retry re-runs the failed page fetch and renders the real page 2.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('사회')).toBeInTheDocument();
    expect(screen.getByText(/31–60 of 3131/)).toBeInTheDocument();
  });
});

describe('ReviewVocab — add a corpus word to a list (F-048)', () => {
  it('opens the picker and posts the entry id to an existing list', async () => {
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

  it('creates a NEW list from the picker, seeded with the tapped word', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');

    await user.click(screen.getByRole('button', { name: /Add 영향 to a list/ }));
    const dialog = await screen.findByRole('dialog');

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Name for the new list' }),
      '새 목록',
    );
    await user.click(
      within(dialog).getByRole('button', { name: /Create list/ }),
    );

    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '새 목록',
        kind: 'vocab',
        seed_entry_ids: [1],
      });
    });
    // One round-trip — no separate addListEntries call for the new list.
    expect(vocabSvc.addListEntries).not.toHaveBeenCalled();
  });

  it('offers the create-a-list affordance even when the user has no lists yet', async () => {
    vocabSvc.listLists.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');

    await user.click(screen.getByRole('button', { name: /Add 영향 to a list/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/No lists yet — create one below/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('textbox', { name: 'Name for the new list' }),
    ).toBeInTheDocument();
  });

  it('surfaces a create failure inside the sheet without closing it', async () => {
    vocabSvc.createList.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');

    await user.click(screen.getByRole('button', { name: /Add 영향 to a list/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Name for the new list' }),
      '새 목록',
    );
    await user.click(
      within(dialog).getByRole('button', { name: /Create list/ }),
    );

    expect(
      await within(dialog).findByText('Could not create the list.'),
    ).toBeInTheDocument();
    // The raw server prose is never echoed.
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });
});

describe('ReviewVocab — My lists (the top-of-page surface)', () => {
  it('creates a list and opens it to show entries', async () => {
    const user = userEvent.setup();
    renderPage();
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
    renderPage();
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
    renderPage();

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

  it('renames a list from the detail sheet', async () => {
    const user = userEvent.setup();
    renderPage();

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
      renderPage();
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

describe('ReviewVocab — U1 sort-by-source filter scaffolding', () => {
  it('renders no source row when the user has no ready uploads', async () => {
    uploadsSvc.listUploads.mockResolvedValue([]);
    renderPage();
    await screen.findByText('영향');
    expect(
      screen.queryByRole('group', { name: 'Filter vocabulary by source book' }),
    ).not.toBeInTheDocument();
  });

  it('lists ready uploads as filter chips and sets source_upload_id on select', async () => {
    uploadsSvc.listUploads.mockResolvedValue([
      READY_UPLOAD,
      { ...READY_UPLOAD, id: '10', title: '처리 중인 책', status: 'processing' },
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('영향');

    const group = await screen.findByRole('group', {
      name: 'Filter vocabulary by source book',
    });
    // Only the READY upload becomes a chip — the processing one is filtered out.
    expect(within(group).getByText('한국어 문법 사전')).toBeInTheDocument();
    expect(within(group).queryByText('처리 중인 책')).not.toBeInTheDocument();

    await user.click(within(group).getByText('한국어 문법 사전'));

    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ source_upload_id: '9' }),
        expect.anything(),
      );
    });

    // Selecting a source reveals the "View PDF" affordance.
    expect(
      screen.getByRole('button', { name: /View PDF/ }),
    ).toBeInTheDocument();
  });
});
