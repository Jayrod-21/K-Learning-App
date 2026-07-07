/**
 * ReviewDictionary — the library's KRDICT page (P1.2, D2: separate page).
 *
 * Ports the old Reference.tsx Dictionary-tab tests: browse-first on open,
 * search on type, browse again on clear, and the 초성 section index. The
 * krdict service is module-mocked; debounce/pagination run for real.
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
import type { KrdictSearchEntry } from '../../types/domain';

const krdictSvc = vi.hoisted(() => ({ searchKrdict: vi.fn() }));

vi.mock('../../services/krdict', () => krdictSvc);

import ReviewDictionary from './ReviewDictionary';

const KRDICT_HIT: KrdictSearchEntry = {
  id: 5,
  headword: '학교',
  part_of_speech: 'n.',
  definition_korean: '학생을 가르치는 곳',
  definition_english: 'a school',
};

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/review/dictionary']}>
      <Routes>
        <Route path="/review/dictionary" element={<ReviewDictionary />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  (krdictSvc.searchKrdict as Mock).mockReset();
  krdictSvc.searchKrdict.mockResolvedValue({ entries: [KRDICT_HIT], total: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    renderPage();
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

  it('browses one 초성 section when a consonant is tapped', async () => {
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
