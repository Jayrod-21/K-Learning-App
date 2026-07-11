/**
 * Tickets (F-023) — in-app beta feedback/ticketing.
 *
 * Covers: filing a ticket (validation, success, error+retry), the "My
 * tickets"/"Community" tab switch, status/type filters driving the server
 * query, opening a ticket into its nested detail view, editing an owned
 * ticket (including the 409 stale-version recovery), adding a comment, the
 * empty states, and the F-023 anonymity contract (no author ever renders,
 * even for the caller's own ticket viewed from the Community tab).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import type { CommunityTicket, OwnTicket, TicketComment } from '../types/domain';

const ticketsSvc = vi.hoisted(() => ({
  createTicket: vi.fn(),
  listMyTickets: vi.fn(),
  listCommunityTickets: vi.fn(),
  patchTicket: vi.fn(),
  addTicketComment: vi.fn(),
  listTicketComments: vi.fn(),
}));

vi.mock('../services/tickets', () => ticketsSvc);

import Tickets from './Tickets';

const MINE_1: OwnTicket = {
  id: 1,
  type: 'bug',
  title: 'Login fails on Safari',
  body: 'Tapping Sign in does nothing on iOS Safari.',
  status: 'open',
  version: 1,
  commentCount: 0,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

const COMMUNITY_1: CommunityTicket = {
  id: 2,
  type: 'suggestion',
  title: 'Add a dark mode toggle to onboarding',
  body: 'Would be nice to pick the theme before signing in.',
  status: 'open',
  commentCount: 1,
  isMine: false,
  createdAt: '2026-07-02T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
};

const COMMENT_1: TicketComment = {
  id: 10,
  body: 'Same issue here on Firefox too.',
  isMine: false,
  createdAt: '2026-07-02T01:00:00Z',
};

function renderPage(initialEntry = '/tickets'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <Routes>
          <Route path="/tickets" element={<Tickets />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ticketsSvc.createTicket.mockReset();
  ticketsSvc.listMyTickets.mockReset();
  ticketsSvc.listCommunityTickets.mockReset();
  ticketsSvc.patchTicket.mockReset();
  ticketsSvc.addTicketComment.mockReset();
  ticketsSvc.listTicketComments.mockReset();

  ticketsSvc.listMyTickets.mockResolvedValue([]);
  ticketsSvc.listCommunityTickets.mockResolvedValue([]);
  ticketsSvc.listTicketComments.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tickets — filing a ticket', () => {
  it('rejects an empty submit with inline field errors and never calls the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);

    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    expect(await screen.findByText('Give it a short title.')).toBeInTheDocument();
    expect(screen.getByText('Describe what happened.')).toBeInTheDocument();
    expect(ticketsSvc.createTicket).not.toHaveBeenCalled();
  });

  it('files a ticket and adds it to My tickets', async () => {
    const created: OwnTicket = {
      id: 5,
      type: 'suggestion',
      title: 'Add export to CSV',
      body: 'Would help with tracking progress externally.',
      status: 'open',
      version: 1,
      commentCount: 0,
      createdAt: '2026-07-05T00:00:00Z',
      updatedAt: '2026-07-05T00:00:00Z',
    };
    ticketsSvc.createTicket.mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'suggestion');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), created.title);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), created.body);
    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    expect(ticketsSvc.createTicket).toHaveBeenCalledWith({
      type: 'suggestion',
      title: created.title,
      body: created.body,
    });
    expect(await screen.findByText(created.title)).toBeInTheDocument();
    // The form clears on success.
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
  });

  it('a failed submit keeps the typed values so Retry resends the same payload', async () => {
    ticketsSvc.createTicket
      .mockRejectedValueOnce(new ApiError('boom', { status: 500, code: 'server_error' }))
      .mockResolvedValueOnce({
        id: 6,
        type: 'bug',
        title: 'Crash on launch',
        body: 'App crashes immediately on a cold start.',
        status: 'open',
        version: 1,
        commentCount: 0,
        createdAt: '2026-07-06T00:00:00Z',
        updatedAt: '2026-07-06T00:00:00Z',
      });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Crash on launch');
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      'App crashes immediately on a cold start.',
    );
    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    expect(await screen.findByText('Could not file that ticket.')).toBeInTheDocument();
    // Values survive the failure.
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Crash on launch');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Crash on launch')).toBeInTheDocument();
    expect(ticketsSvc.createTicket).toHaveBeenCalledTimes(2);
  });
});

describe('Tickets — My tickets / Community lists', () => {
  it('shows an honest empty state on both tabs when there are no tickets', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('No tickets yet — file the first one.')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Community/ }));
    expect(
      await screen.findByText('No tickets yet — file the first one.'),
    ).toBeInTheDocument();
  });

  it('lists My tickets with a status/type badge, and shows an error+retry on a failed load', async () => {
    ticketsSvc.listMyTickets.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText('Could not load your tickets.'),
    ).toBeInTheDocument();

    ticketsSvc.listMyTickets.mockResolvedValueOnce([MINE_1]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(MINE_1.title)).toBeInTheDocument();
    const row = screen.getByRole('button', {
      name: `View ticket: ${MINE_1.title}`,
    });
    expect(within(row).getByText(/Bug/)).toBeInTheDocument();
    expect(within(row).getByText(/Open/)).toBeInTheDocument();
  });

  it('lists the Community feed, and status/type filters refetch both lists with the right query', async () => {
    ticketsSvc.listCommunityTickets.mockResolvedValue([COMMUNITY_1]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);

    await user.click(screen.getByRole('tab', { name: /Community/ }));
    expect(await screen.findByText(COMMUNITY_1.title)).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by status' }),
      'resolved',
    );
    await waitFor(() => {
      expect(ticketsSvc.listMyTickets).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'resolved' }),
        expect.anything(),
      );
    });
    expect(ticketsSvc.listCommunityTickets).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'resolved' }),
      expect.anything(),
    );
  });
});

describe('Tickets — anonymity contract (F-023)', () => {
  it('the Community feed never renders an author — only isMine-derived "Yours" tags', async () => {
    const mine: CommunityTicket = { ...COMMUNITY_1, id: 3, isMine: true, title: 'My own filed suggestion' };
    ticketsSvc.listCommunityTickets.mockResolvedValue([COMMUNITY_1, mine]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);

    await user.click(screen.getByRole('tab', { name: /Community/ }));
    expect(await screen.findByText(COMMUNITY_1.title)).toBeInTheDocument();
    expect(screen.getByText(mine.title)).toBeInTheDocument();

    // No email-shaped or author-shaped string anywhere on the page — the
    // wire type (`CommunityTicket`) structurally carries no author field,
    // so there is nothing for the UI to render even by accident.
    expect(document.body.textContent).not.toMatch(/@/);
    expect(screen.queryByText(/^By /)).not.toBeInTheDocument();
  });

  it("opening the caller's own ticket from the Community tab still renders it view-only unless it's also in My tickets", async () => {
    const mine: CommunityTicket = { ...COMMUNITY_1, id: 3, isMine: true, title: 'My own filed suggestion' };
    ticketsSvc.listMyTickets.mockResolvedValue([]); // not (yet) loaded into `mine` array
    ticketsSvc.listCommunityTickets.mockResolvedValue([mine]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await user.click(screen.getByRole('tab', { name: /Community/ }));
    await user.click(screen.getByRole('button', { name: `View ticket: ${mine.title}` }));

    expect(await screen.findByText(mine.title)).toBeInTheDocument();
    // No edit form — canEdit is false because this row never appeared in
    // GET /tickets/mine (the client never assumes ownership from `isMine`).
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
  });
});

describe('Tickets — ticket detail + editing', () => {
  it('opens a ticket into its detail view, and Back returns to the tab it came from', async () => {
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(MINE_1.title);

    await user.click(screen.getByRole('button', { name: `View ticket: ${MINE_1.title}` }));
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue(MINE_1.title);

    await user.click(screen.getByRole('button', { name: 'Back to My tickets' }));
    expect(await screen.findByText(MINE_1.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /File ticket/ })).toBeInTheDocument();
  });

  it('edits title/body/status and saves via PATCH with the expected_version', async () => {
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]);
    ticketsSvc.patchTicket.mockResolvedValue({
      ...MINE_1,
      title: 'Login fails on Safari 17',
      status: 'in_progress',
      version: 2,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(MINE_1.title);
    await user.click(screen.getByRole('button', { name: `View ticket: ${MINE_1.title}` }));

    const titleInput = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(titleInput);
    await user.type(titleInput, 'Login fails on Safari 17');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'in_progress');

    const saveButton = screen.getByRole('button', { name: /Save/ });
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() => {
      expect(ticketsSvc.patchTicket).toHaveBeenCalledWith(MINE_1.id, {
        expectedVersion: 1,
        title: 'Login fails on Safari 17',
        status: 'in_progress',
      });
    });
    // Save is disabled again once the draft matches the (now updated) server row.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    });
  });

  it('a stale PATCH (409) reloads the fresh row and shows a friendly recovery notice', async () => {
    ticketsSvc.listMyTickets
      .mockResolvedValueOnce([MINE_1]) // initial mount load
      .mockResolvedValueOnce([
        { ...MINE_1, title: 'Someone already renamed this', version: 2 },
      ]); // conflict-triggered refetch (unfiltered)
    ticketsSvc.patchTicket.mockRejectedValueOnce(
      new ApiError('stale version', { status: 409, code: 'conflict' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(MINE_1.title);
    await user.click(screen.getByRole('button', { name: `View ticket: ${MINE_1.title}` }));

    const titleInput = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(titleInput);
    await user.type(titleInput, 'My attempted rename');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(
      await screen.findByText(/This ticket changed since you loaded it/),
    ).toBeInTheDocument();
    // The draft was replaced with the fresh server row, not silently merged.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
        'Someone already renamed this',
      );
    });
    expect(ticketsSvc.listMyTickets).toHaveBeenCalledTimes(2);
  });
});

describe('Tickets — comments', () => {
  it('loads the thread and posts a new comment', async () => {
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]);
    ticketsSvc.listTicketComments.mockResolvedValue([COMMENT_1]);
    const created: TicketComment = {
      id: 11,
      body: 'Thanks — looking into it now.',
      isMine: true,
      createdAt: '2026-07-03T00:00:00Z',
    };
    ticketsSvc.addTicketComment.mockResolvedValue(created);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText(MINE_1.title);
    await user.click(screen.getByRole('button', { name: `View ticket: ${MINE_1.title}` }));

    expect(await screen.findByText(COMMENT_1.body)).toBeInTheDocument();

    const commentBox = screen.getByRole('textbox', { name: /Add a comment/ });
    await user.type(commentBox, created.body);
    await user.click(screen.getByRole('button', { name: /Post comment/ }));

    expect(ticketsSvc.addTicketComment).toHaveBeenCalledWith(MINE_1.id, created.body);
    expect(await screen.findByText(created.body)).toBeInTheDocument();
    expect(commentBox).toHaveValue('');
  });

  it('a failed comment post shows error+retry without losing the typed text', async () => {
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]);
    ticketsSvc.addTicketComment.mockRejectedValueOnce(
      new ApiError('boom', { status: 500, code: 'server_error' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(MINE_1.title);
    await user.click(screen.getByRole('button', { name: `View ticket: ${MINE_1.title}` }));
    await screen.findByText(/No comments yet/);

    const commentBox = screen.getByRole('textbox', { name: /Add a comment/ });
    await user.type(commentBox, 'Does this still happen?');
    await user.click(screen.getByRole('button', { name: /Post comment/ }));

    expect(
      await screen.findByText('Could not post that comment.'),
    ).toBeInTheDocument();
    expect(commentBox).toHaveValue('Does this still happen?');
  });
});

describe('Tickets — Community windowing (usePagination/ShowMore)', () => {
  it('windows a long community feed and reveals more on demand', async () => {
    const many: CommunityTicket[] = Array.from({ length: 18 }, (_, i) => ({
      ...COMMUNITY_1,
      id: 100 + i,
      title: `Community ticket #${String(i + 1)}`,
    }));
    ticketsSvc.listCommunityTickets.mockResolvedValue(many);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await user.click(screen.getByRole('tab', { name: /Community/ }));

    await screen.findByText('Community ticket #1');
    expect(screen.getByText('Community ticket #15')).toBeInTheDocument();
    expect(screen.queryByText('Community ticket #16')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Show more tickets/ }));
    expect(await screen.findByText('Community ticket #16')).toBeInTheDocument();
  });
});
