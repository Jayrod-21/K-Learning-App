/**
 * MyVocabLists — DIRECT tests for THE canonical My-Lists surface (P1.2
 * dedup). ReviewVocab.test.tsx exercises this surface through the page
 * integration (deep link, tab switching); these tests pin the component's
 * own contract so the surface is directly covered:
 *   - create a list (name_kr only → name_en omitted, kind defaults 'vocab';
 *     with English label + kind → full body)
 *   - delete is confirm-gated (cancel aborts, accept deletes)
 *   - open a list → REAL entries via getListDetail
 *   - remove-entry is optimistic and ROLLS BACK on failure (the view never
 *     lies about what the server holds)
 *   - rename via patchList (the capability ported from the old Review sheet
 *     that Reference's ListsTab lacked)
 *
 * `vocabService` is module-mocked; the component's own state and effects
 * run for real so the optimistic flip and rollback participate in the
 * assertions.
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
import type { ServerVocabList } from '../types/domain';

const vocabSvc = vi.hoisted(() => ({
  listLists: vi.fn(),
  createList: vi.fn(),
  getListDetail: vi.fn(),
  patchList: vi.fn(),
  deleteList: vi.fn(),
  removeListEntry: vi.fn(),
}));

vi.mock('../services/vocab', () => vocabSvc);

import { MyVocabLists } from './MyVocabLists';

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

const LIST_DETAIL = {
  list: SERVER_LIST,
  entries: [
    {
      entry_id: 1,
      position: 0,
      added_at: 'x',
      korean: '영향',
      english: 'influence',
      proficiency: 'L3',
    },
    {
      entry_id: 2,
      position: 1,
      added_at: 'x',
      korean: '환경',
      english: 'environment',
      proficiency: 'L3',
    },
  ],
  entry_limit: 100,
  entry_offset: 0,
};

beforeEach(() => {
  for (const fn of Object.values(vocabSvc)) (fn as Mock).mockReset();

  vocabSvc.listLists.mockResolvedValue([SERVER_LIST]);
  vocabSvc.createList.mockResolvedValue({ list: SERVER_LIST, appended: 0 });
  vocabSvc.getListDetail.mockResolvedValue(LIST_DETAIL);
  vocabSvc.patchList.mockResolvedValue({
    list: { ...SERVER_LIST, name_kr: '새 이름' },
  });
  vocabSvc.deleteList.mockResolvedValue(undefined);
  vocabSvc.removeListEntry.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MyVocabLists — the canonical dedup’d My-Lists surface', () => {
  it('creates a list from the Korean name alone (kind defaults, name_en omitted)', async () => {
    const user = userEvent.setup();
    render(<MyVocabLists />);
    await screen.findByText('병원 어휘');

    const nameInput = screen.getByRole('textbox', { name: 'New list name' });
    await user.type(nameInput, '새 단어장');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    // Exact body: name_en must be ABSENT (not null/empty), kind defaulted.
    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '새 단어장',
        kind: 'vocab',
      });
    });
    // Success clears the form and refreshes the rows.
    await waitFor(() => {
      expect(nameInput).toHaveValue('');
    });
    expect(vocabSvc.listLists).toHaveBeenCalledTimes(2);
  });

  it('sends the optional English label and the chosen kind in the create body', async () => {
    const user = userEvent.setup();
    render(<MyVocabLists />);
    await screen.findByText('병원 어휘');

    await user.type(
      screen.getByRole('textbox', { name: 'New list name' }),
      '문법 목록',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'English label' }),
      'Grammar list',
    );
    await user.click(screen.getByRole('radio', { name: 'grammar' }));
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '문법 목록',
        kind: 'grammar',
        name_en: 'Grammar list',
      });
    });
  });

  it('gates delete behind confirm — cancel aborts, accept deletes and reloads', async () => {
    // happy-dom ships no window.confirm — stub it (cancel first, then accept).
    const confirmFn = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal('confirm', confirmFn);
    try {
      const user = userEvent.setup();
      render(<MyVocabLists />);
      await screen.findByText('병원 어휘');

      // First tap: the user cancels the dialog → nothing is deleted.
      await user.click(screen.getByRole('button', { name: 'Delete 병원 어휘' }));
      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(vocabSvc.deleteList).not.toHaveBeenCalled();

      // Second tap: accepted → DELETE fires and the rows refresh.
      await user.click(screen.getByRole('button', { name: 'Delete 병원 어휘' }));
      await waitFor(() => {
        expect(vocabSvc.deleteList).toHaveBeenCalledWith(7);
      });
      expect(vocabSvc.deleteList).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(vocabSvc.listLists).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a list and shows its REAL entries via getListDetail', async () => {
    const user = userEvent.setup();
    render(<MyVocabLists />);

    await user.click(
      await screen.findByRole('button', { name: 'Open 병원 어휘' }),
    );
    await waitFor(() => {
      expect(vocabSvc.getListDetail).toHaveBeenCalledWith(7, expect.anything());
    });

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('영향')).toBeInTheDocument();
    expect(within(dialog).getByText('influence')).toBeInTheDocument();
    expect(within(dialog).getByText('환경')).toBeInTheDocument();
  });

  it('removes an entry optimistically and ROLLS BACK when the delete fails', async () => {
    // Deferred rejection so the optimistic window is observable.
    let rejectRemove!: (err: unknown) => void;
    vocabSvc.removeListEntry.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRemove = reject;
        }),
    );
    const user = userEvent.setup();
    render(<MyVocabLists />);

    await user.click(
      await screen.findByRole('button', { name: 'Open 병원 어휘' }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('영향');

    await user.click(
      within(dialog).getByRole('button', { name: 'Remove 영향 from the list' }),
    );
    expect(vocabSvc.removeListEntry).toHaveBeenCalledWith(7, 1);
    // Optimistic: the row is gone BEFORE the server answers; its sibling stays.
    expect(within(dialog).queryByText('영향')).not.toBeInTheDocument();
    expect(within(dialog).getByText('환경')).toBeInTheDocument();

    // The server refuses → the row comes back and fixed error copy shows
    // (never server prose) — the view must not keep lying.
    rejectRemove(new Error('boom'));
    expect(await within(dialog).findByText('영향')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Could not remove the word.'),
    ).toBeInTheDocument();
  });

  it('renames the list from the detail sheet (the capability kept from Review)', async () => {
    const user = userEvent.setup();
    render(<MyVocabLists />);

    await user.click(
      await screen.findByRole('button', { name: 'Open 병원 어휘' }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('영향');

    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    const nameInput = within(dialog).getByRole('textbox', {
      name: 'List name',
    });
    await user.clear(nameInput);
    await user.type(nameInput, '새 이름');
    await user.click(within(dialog).getByRole('button', { name: 'Save name' }));

    await waitFor(() => {
      expect(vocabSvc.patchList).toHaveBeenCalledWith(7, { name_kr: '새 이름' });
    });
    // The header reflects the SERVER-confirmed name (not the raw input),
    // and the parent rows are refreshed.
    expect(await within(dialog).findByText('새 이름')).toBeInTheDocument();
    await waitFor(() => {
      expect(vocabSvc.listLists).toHaveBeenCalledTimes(2);
    });
  });

  it('shows the honest empty invitation when there are no lists yet', async () => {
    vocabSvc.listLists.mockResolvedValue([]);
    render(<MyVocabLists />);

    expect(
      await screen.findByText(/No lists yet\. Create one above/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument();
  });
});
