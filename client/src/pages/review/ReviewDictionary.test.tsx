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
import { ApiError } from '../../services/api';
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

/** F-150 — a KRDICT row tagged as a grammar ENDING (어미); must never render
 *  on this vocab-only lens. */
const KRDICT_GRAMMAR_ENDING: KrdictSearchEntry = {
  id: 6,
  headword: '-는데',
  part_of_speech: '어미',
  definition_korean: '뒤 절과 대조되는 상황을 나타내는 연결 어미',
  definition_english: 'a connective ending marking contrast',
};

/** F-150 — a KRDICT row tagged as a grammar PARTICLE (조사); must never
 *  render either. */
const KRDICT_GRAMMAR_PARTICLE: KrdictSearchEntry = {
  id: 7,
  headword: '조차',
  part_of_speech: '조사',
  definition_korean: '이미 어떤 것이 포함되고 그 위에 더함을 나타내는 조사',
  definition_english: 'a particle meaning "even"',
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

  it('F-128: reskins with the hub-header recipe — skyline + dancheong rail', async () => {
    const { container } = renderPage();
    await screen.findByText('학교');
    expect(container.querySelector('.km-skyline')).not.toBeNull();
    expect(container.querySelector('.km-dancheong-rail')).not.toBeNull();
  });

  it('F-149: labels the search field "Search for a word" (visible caption + accessible name)', async () => {
    renderPage();
    await screen.findByText('학교');
    expect(
      screen.getByRole('searchbox', { name: 'Search for a word' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Search for a word')).toBeInTheDocument();
  });

  it('has a BackButton to the library index (F-024)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');
    // The label comes from navItem('review') — the tab is "Library" (F-043).
    await user.click(screen.getByRole('button', { name: 'Back to Library' }));
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
      screen.getByRole('searchbox', { name: 'Search for a word' }),
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

    const box = screen.getByRole('searchbox', { name: 'Search for a word' });
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

describe('ReviewDictionary — 초성 × search interplay (F-050)', () => {
  it('a typed search supersedes the 초성 selection — no double filter, no resurfacing on clear', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');

    await user.click(screen.getByRole('button', { name: 'ㅁ' }));
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ initial: 'ㅁ' }),
        expect.anything(),
      );
    });

    // Typing switches to a whole-dictionary search: `q` rides the wire and
    // `initial` must NOT combine with it (double-filtering would silently
    // hide matches outside the ㅁ section).
    krdictSvc.searchKrdict.mockClear();
    await user.type(
      screen.getByRole('searchbox', { name: 'Search for a word' }),
      '문',
    );
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ q: '문' }),
        expect.anything(),
      );
    });
    for (const call of krdictSvc.searchKrdict.mock.calls) {
      expect(call[0]).not.toHaveProperty('initial');
    }

    // Clearing the search returns to browse-ALL — the superseded 초성 was
    // reset, not parked: no fetch carries it and "전체" is the pressed chip.
    krdictSvc.searchKrdict.mockClear();
    await user.clear(screen.getByRole('searchbox', { name: 'Search for a word' }));
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalled();
    });
    for (const call of krdictSvc.searchKrdict.mock.calls) {
      expect(call[0]).not.toHaveProperty('initial');
    }
    // The browse chip-row re-renders asynchronously after the search clears;
    // await it rather than a bare getByRole, which races the re-render under
    // CI timing (green locally, flaky in CI until this was awaited).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(screen.getByRole('button', { name: 'ㅁ' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('the 초성 selection survives a genre pivot and reapplies when the genre clears', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');

    await user.click(screen.getByRole('button', { name: 'ㅁ' }));
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ initial: 'ㅁ' }),
        expect.anything(),
      );
    });

    // Pivot to the curated-corpus backend — the KRDICT-only 초성 bar hides.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Genre' }),
      'business',
    );
    await screen.findByText('회의');
    expect(
      screen.queryByRole('group', { name: 'Browse by initial consonant' }),
    ).not.toBeInTheDocument();

    // Clearing the genre returns to KRDICT with the SAME 초성 section, the
    // chip pressed again.
    krdictSvc.searchKrdict.mockClear();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Genre' }), '');
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ initial: 'ㅁ', offset: 0 }),
        expect.anything(),
      );
    });
    expect(screen.getByRole('button', { name: 'ㅁ' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('ReviewDictionary — error paths + Retry', () => {
  it('surfaces the 503 "not available yet" copy with a Retry that recovers', async () => {
    krdictSvc.searchKrdict
      .mockRejectedValueOnce(
        new ApiError('krdict table missing', { status: 503, code: 'unavailable' }),
      )
      .mockResolvedValue({ entries: [KRDICT_HIT], total: 1 });
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText('The dictionary isn’t available yet.'),
    ).toBeInTheDocument();
    // Fixed copy only — the server prose must not render.
    expect(screen.queryByText('krdict table missing')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('학교')).toBeInTheDocument();
  });

  it('a failed browse shows fixed copy with a Retry that recovers', async () => {
    krdictSvc.searchKrdict
      .mockRejectedValueOnce(
        new ApiError('boom', { status: 500, code: 'server' }),
      )
      .mockResolvedValue({ entries: [KRDICT_HIT], total: 1 });
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText('Could not load the words.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('학교')).toBeInTheDocument();
  });
});

describe('ReviewDictionary — pager', () => {
  it('pages the KRDICT browse with Prev/Next and an honest range readout', async () => {
    krdictSvc.searchKrdict.mockResolvedValue({
      entries: [KRDICT_HIT],
      total: 90,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');

    expect(screen.getByText('1–30 of 90')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();

    krdictSvc.searchKrdict.mockClear();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 30 }),
        expect.anything(),
      );
    });
    expect(await screen.findByText('31–60 of 90')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeEnabled();

    // Prev returns to page 1.
    krdictSvc.searchKrdict.mockClear();
    await user.click(screen.getByRole('button', { name: 'Prev' }));
    await waitFor(() => {
      expect(krdictSvc.searchKrdict).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 0 }),
        expect.anything(),
      );
    });
    expect(await screen.findByText('1–30 of 90')).toBeInTheDocument();
  });
});

describe('ReviewDictionary — excludes grammar entries (F-150)', () => {
  it('never renders a KRDICT row tagged as an ending (어미) or a particle (조사)', async () => {
    krdictSvc.searchKrdict.mockResolvedValue({
      entries: [KRDICT_HIT, KRDICT_GRAMMAR_ENDING, KRDICT_GRAMMAR_PARTICLE],
      total: 3,
    });
    renderPage();

    // The real word renders…
    expect(await screen.findByText('학교')).toBeInTheDocument();
    // …but neither grammar-tagged row ever does, even though the server
    // returned them.
    expect(screen.queryByText('-는데')).not.toBeInTheDocument();
    expect(screen.queryByText('조차')).not.toBeInTheDocument();
  });

  it('shows the honest empty state when a page is ALL grammar entries', async () => {
    krdictSvc.searchKrdict.mockResolvedValue({
      entries: [KRDICT_GRAMMAR_ENDING, KRDICT_GRAMMAR_PARTICLE],
      total: 2,
    });
    renderPage();

    expect(await screen.findByText('No words found.')).toBeInTheDocument();
    expect(screen.queryByText('-는데')).not.toBeInTheDocument();
    expect(screen.queryByText('조차')).not.toBeInTheDocument();
  });

  it('does not exclude a genre-pivoted vocab-corpus row (already vocab-only server-side)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('학교');

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Genre' }),
      'business',
    );
    // The curated vocab corpus is `entry_type = 'word'`-only server-side —
    // F-150's client filter only applies to the raw KRDICT path, and must
    // not accidentally hide a legitimate vocab-pivot row.
    expect(await screen.findByText('회의')).toBeInTheDocument();
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
      screen.getByRole('searchbox', { name: 'Search for a word' }),
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
