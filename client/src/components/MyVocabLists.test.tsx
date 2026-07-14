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
 *   - action failures are NEVER silent while rows are on screen (P2 fix for
 *     QA RISK-1): a failed delete toasts fixed copy; a failed background
 *     refresh shows a stale banner above the still-rendered rows
 *
 * `vocabService` is module-mocked; the component's own state and effects
 * run for real so the optimistic flip and rollback participate in the
 * assertions. Renders sit inside a real `<ToastProvider>` because the
 * component toasts failures.
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
import { ToastProvider } from './ToastProvider';

/** The component calls `useToast`, so every render needs the provider. */
function renderLists(): void {
  render(
    <ToastProvider>
      <MyVocabLists />
    </ToastProvider>,
  );
}

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
  /** Opens the "New list" Sheet popup (F-147) and returns its dialog. */
  async function openCreateSheet(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: /New list/ }));
    return screen.findByRole('dialog', { name: 'New list' });
  }

  it('F-147: the create form is a Sheet popup, not an always-inline card', async () => {
    const user = userEvent.setup();
    renderLists();
    await screen.findByText('병원 어휘');

    // Not on the page until the trigger is tapped.
    expect(screen.queryByRole('dialog', { name: 'New list' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'New list name' }),
    ).not.toBeInTheDocument();

    const dialog = await openCreateSheet(user);
    expect(
      within(dialog).getByRole('textbox', { name: 'New list name' }),
    ).toBeInTheDocument();
  });

  it('creates a list from the Korean name alone (kind defaults, name_en omitted), then closes the popup and refreshes', async () => {
    const user = userEvent.setup();
    renderLists();
    await screen.findByText('병원 어휘');

    const dialog = await openCreateSheet(user);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'New list name' }),
      '새 단어장',
    );
    await user.click(
      within(dialog).getByRole('button', { name: /^만들기 · Create$/ }),
    );

    // Exact body: name_en must be ABSENT (not null/empty), kind defaulted.
    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '새 단어장',
        kind: 'vocab',
      });
    });
    // Success closes the popup (not just clears the form — F-147's whole
    // point is that the create flow is a transient popup) and refreshes the
    // rows behind it.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New list' })).not.toBeInTheDocument();
    });
    expect(vocabSvc.listLists).toHaveBeenCalledTimes(2);
  });

  it('sends the optional English label and the chosen kind in the create body (default kinds — the full picker is available)', async () => {
    const user = userEvent.setup();
    renderLists();
    await screen.findByText('병원 어휘');

    const dialog = await openCreateSheet(user);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'New list name' }),
      '문법 목록',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: 'English label' }),
      'Grammar list',
    );
    await user.click(within(dialog).getByRole('radio', { name: '문법 · grammar' }));
    await user.click(
      within(dialog).getByRole('button', { name: /^만들기 · Create$/ }),
    );

    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '문법 목록',
        kind: 'grammar',
        name_en: 'Grammar list',
      });
    });
  });

  it('a mount narrowed to kinds=["vocab"] skips the kind picker entirely (F-144)', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <MyVocabLists kinds={['vocab']} />
      </ToastProvider>,
    );
    await screen.findByText('병원 어휘');

    const dialog = await openCreateSheet(user);
    expect(
      within(dialog).queryByRole('radiogroup', { name: 'List kind' }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();

    await user.type(
      within(dialog).getByRole('textbox', { name: 'New list name' }),
      '단어 목록',
    );
    await user.click(
      within(dialog).getByRole('button', { name: /^만들기 · Create$/ }),
    );
    await waitFor(() => {
      expect(vocabSvc.createList).toHaveBeenCalledWith({
        name_kr: '단어 목록',
        kind: 'vocab',
      });
    });
  });

  it('a mount narrowed to kinds=["vocab"] never DISPLAYS an existing list of another kind (root cause: `kinds` used to gate only the create picker, not the fetched rows — the actual bug behind "grammar still shows" after two prior fixes)', async () => {
    vocabSvc.listLists.mockResolvedValue([
      SERVER_LIST,
      {
        id: 42,
        name_kr: '중급 문법',
        name_en: 'Intermediate grammar',
        kind: 'grammar',
        version: 1,
        entry_count: 5,
        created_at: 'x',
        updated_at: 'y',
      },
    ]);
    render(
      <ToastProvider>
        <MyVocabLists kinds={['vocab']} />
      </ToastProvider>,
    );

    // The vocab-kind row renders as before…
    expect(await screen.findByText('병원 어휘')).toBeInTheDocument();
    // …but the grammar-kind row the server returned is filtered out of the
    // render entirely — not just unreachable via the create form.
    expect(screen.queryByText('중급 문법')).not.toBeInTheDocument();
    expect(screen.queryByText('Intermediate grammar')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /중급 문법/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the honest empty invitation when the server has lists but none match this mount\'s kinds', async () => {
    vocabSvc.listLists.mockResolvedValue([
      {
        id: 42,
        name_kr: '중급 문법',
        name_en: 'Intermediate grammar',
        kind: 'grammar',
        version: 1,
        entry_count: 5,
        created_at: 'x',
        updated_at: 'y',
      },
    ]);
    render(
      <ToastProvider>
        <MyVocabLists kinds={['vocab']} />
      </ToastProvider>,
    );

    expect(
      await screen.findByText(/No lists yet\. Create one above/),
    ).toBeInTheDocument();
    expect(screen.queryByText('중급 문법')).not.toBeInTheDocument();
  });

  it('gates delete behind confirm — cancel aborts, accept deletes and reloads', async () => {
    // happy-dom ships no window.confirm — stub it (cancel first, then accept).
    const confirmFn = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal('confirm', confirmFn);
    try {
      const user = userEvent.setup();
      renderLists();
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
    renderLists();

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
    renderLists();

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
    renderLists();

    await user.click(
      await screen.findByRole('button', { name: 'Open 병원 어휘' }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('영향');

    await user.click(within(dialog).getByRole('button', { name: '이름 변경 · Rename' }));
    const nameInput = within(dialog).getByRole('textbox', {
      name: 'List name',
    });
    await user.clear(nameInput);
    await user.type(nameInput, '새 이름');
    await user.click(within(dialog).getByRole('button', { name: '이름 저장 · Save name' }));

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

  it('surfaces a failed delete via toast while rows are still on screen (QA RISK-1)', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    try {
      vocabSvc.deleteList.mockRejectedValue(
        new Error('fk_list_entries constraint violated'),
      );
      const user = userEvent.setup();
      renderLists();
      await screen.findByText('병원 어휘');

      await user.click(screen.getByRole('button', { name: 'Delete 병원 어휘' }));

      // FIXED copy, never the server prose. The feedback must appear even
      // though a list is rendered — the old `error && lists.length === 0`
      // error-card gate could never show it (this assertion fails against
      // that gate, so a revert to it is caught here).
      expect(
        await screen.findByText('Could not delete the list.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/constraint/)).not.toBeInTheDocument();
      // The row survives (nothing was deleted server-side) and no refresh
      // fired on the failure path.
      expect(screen.getByText('병원 어휘')).toBeInTheDocument();
      expect(vocabSvc.listLists).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('flags a failed background refresh instead of silently rendering stale rows', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    try {
      // Initial load succeeds; the post-delete reload fails; Retry recovers.
      vocabSvc.listLists
        .mockResolvedValueOnce([SERVER_LIST])
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue([]);
      const user = userEvent.setup();
      renderLists();
      await screen.findByText('병원 어휘');

      await user.click(screen.getByRole('button', { name: 'Delete 병원 어휘' }));

      // The delete succeeded but the refresh did not — the rows on screen
      // may be stale, so the component must say so (not render silently).
      expect(
        await screen.findByText(
          "Couldn't refresh your lists — showing the last loaded set.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('병원 어휘')).toBeInTheDocument();

      // Retry re-runs the load; the recovered state clears the banner.
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(
        await screen.findByText(/No lists yet\. Create one above/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Couldn't refresh your lists/),
      ).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows the honest empty invitation when there are no lists yet', async () => {
    vocabSvc.listLists.mockResolvedValue([]);
    renderLists();

    expect(
      await screen.findByText(/No lists yet\. Create one above/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument();
  });
});
