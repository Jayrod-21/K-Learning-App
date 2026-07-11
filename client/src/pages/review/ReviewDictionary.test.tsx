/**
 * ReviewDictionary — the library's "All Words" page (F-050 rename).
 *
 * Ports the old Dictionary-tab tests (browse-first on open, search on type,
 * browse again on clear, the 초성 section index) and adds the P3B coverage:
 * the F-050 genre lens (pivots onto the curated-corpus search — the only
 * genre-tagged data) and the F-024 BackButton. The krdict + vocab services
 * are module-mocked; debounce/pagination run for real.
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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { KrdictSearchEntry, VocabEntry } from '../../types/domain';

const krdictSvc = vi.hoisted(() => ({ searchKrdict: vi.fn() }));
const vocabSvc = vi.hoisted(() => ({ searchEntriesPage: vi.fn() }));

vi.mock('../../services/krdict', () => krdictSvc);
vi.mock('../../services/vocab', () => vocabSvc);

import ReviewDictionary from './ReviewDictionary';

const KRDICT_HIT: KrdictSearchEntry = {
  id: 5,
  headword: '학교',
  part_of_speech: 'n.',
  definition_korean: '학생을 가르치는 곳',
  definition_english: 'a school',
};

const VOCAB_HIT: VocabEntry = {
  id: 42,
  corpus: 'vocab_2000_intermediate',
  korean: '회의',
  english: 'meeting',
  proficiency: 'L3',
  theme: null,
};

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/review/dictionary']}>
      <Routes>
        <Route path="/review/dictionary" element={<ReviewDictionary />} />
        <Route path="/review" element={<div data-testid="review-index" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  (krdictSvc.searchKrdict as Mock).mockReset();
  (vocabSvc.searchEntriesPage as Mock).mockReset();
  krdictSvc.searchKrdict.mockResolvedValue({ entries: [KRDICT_HIT], total: 1 });
  vocabSvc.searchEntriesPage.mockResolvedValue({
    entries: [VOCAB_HIT],
    total: 812,
    limit: 30,
    offset: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewDictionary — "All Words" chrome (F-050 rename + F-024)', () => {
  it('titles the page "All Words", not "Dictionary"', async () => {
    renderPage();
    await screen.findByText('학교');
    expect(
      screen.getByRole('heading', { level: 1, name: '전체 단어 · All Words' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Dictionary/ }),
    ).not.toBeInTheDocument();
  });

  it('has a BackButton to the library index (F-024)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');
    await user.click(screen.getByRole('button', { name: 'Back to Review' }));
    expect(screen.getByTestId('review-index')).toBeInTheDocument();
  });
});

describe('ReviewDictionary (browse + search)', () => {
  it('browses the dictionary on open (no query needed), then searches on type', async () => {
    const user = userEvent.setup();
    renderPage();

    // Browse-all on mount: page 1 loads WITHOUT a query.
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
      screen.getByRole('searchbox', { name: 'Search all words' }),
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
    renderPage();
    await screen.findByText('학교');

    const box = screen.getByRole('searchbox', { name: 'Search all words' });
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

  it('browses one 초성 section when a consonant is tapped (first-Hangul search, F-050)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교'); // browse-all loaded

    krdictSvc.searchKrdict.mockClear();
    await user.click(screen.getByRole('button', { name: 'ㅁ' }));
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ initial: 'ㅁ' }),
        expect.anything(),
      );
    });
    expect(screen.getByRole('button', { name: 'ㅁ' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('ReviewDictionary — genre lens (F-050)', () => {
  it('pivots onto the curated-corpus search when a genre is chosen', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');

    krdictSvc.searchKrdict.mockClear();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Genre' }),
      'business',
    );

    // The genre-tagged corpus answers…
    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'business', offset: 0 }),
        expect.anything(),
      );
    });
    expect(await screen.findByText('회의')).toBeInTheDocument();
    // …the KRDICT rows are replaced, KRDICT is not re-queried, and the 초성
    // index (KRDICT-only) is hidden.
    expect(screen.queryByText('학교')).not.toBeInTheDocument();
    expect(krdictSvc.searchKrdict).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('group', { name: 'Browse by initial consonant' }),
    ).not.toBeInTheDocument();
  });

  it('combines the genre lens with free-text search', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Genre' }),
      'research',
    );
    await screen.findByText('회의');

    vocabSvc.searchEntriesPage.mockClear();
    await user.type(
      screen.getByRole('searchbox', { name: 'Search all words' }),
      '실험',
    );
    await waitFor(() => {
      expect(vocabSvc.searchEntriesPage).toHaveBeenCalledWith(
        expect.objectContaining({ q: '실험', domain: 'research', offset: 0 }),
        expect.anything(),
      );
    });
  });

  it('returns to the KRDICT browse when the genre is cleared', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');

    const genre = screen.getByRole('combobox', { name: 'Genre' });
    await user.selectOptions(genre, 'business');
    await screen.findByText('회의');

    krdictSvc.searchKrdict.mockClear();
    await user.selectOptions(genre, '');
    expect(await screen.findByText('학교')).toBeInTheDocument();
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 0 }),
        expect.anything(),
      );
    });
  });
});
