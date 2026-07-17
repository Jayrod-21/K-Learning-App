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
  fetchTicket: vi.fn(),
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
  sourcePage: null,
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
  sourcePage: null,
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

function renderPage(
  initialEntry: string | { pathname: string; state?: unknown } = '/tickets',
): ReturnType<typeof render> {
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

/**
 * F-128: the file-a-ticket form now lives inside the shared `Sheet`
 * (triggered by the header's "New ticket" action) instead of always
 * rendering inline — tests open it the way a user does before touching any
 * of its fields.
 */
async function openFileSheet(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: /New ticket/ }));
}

beforeEach(() => {
  ticketsSvc.createTicket.mockReset();
  ticketsSvc.fetchTicket.mockReset();
  ticketsSvc.listMyTickets.mockReset();
  ticketsSvc.listCommunityTickets.mockReset();
  ticketsSvc.patchTicket.mockReset();
  ticketsSvc.addTicketComment.mockReset();
  ticketsSvc.listTicketComments.mockReset();

  ticketsSvc.listMyTickets.mockResolvedValue([]);
  ticketsSvc.listCommunityTickets.mockResolvedValue([]);
  ticketsSvc.listTicketComments.mockResolvedValue([]);
  // Default: the id-addressed detail fetch finds nothing — tests that rely
  // on the cached-list fast path (or never open a detail) keep working, and
  // any test that needs the fetch to resolve overrides this per-test.
  ticketsSvc.fetchTicket.mockRejectedValue(
    new ApiError('ticket not found', { status: 404, code: 'not_found' }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tickets — filing a ticket', () => {
  it('rejects an empty submit with inline field errors and never calls the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await openFileSheet(user);

    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    expect(await screen.findByText('Give it a short title.')).toBeInTheDocument();
    expect(screen.getByText('Describe what happened.')).toBeInTheDocument();
    expect(ticketsSvc.createTicket).not.toHaveBeenCalled();
  });

  it('programmatically associates each field error with its input via aria-describedby (WCAG AA)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await openFileSheet(user);

    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    const titleInput = screen.getByRole('textbox', { name: 'Title' });
    const titleError = await screen.findByText('Give it a short title.');
    const bodyInput = screen.getByRole('textbox', { name: 'Description' });
    const bodyError = screen.getByText('Describe what happened.');

    // A screen reader resolves `aria-describedby` to the node it names — the
    // fix is this exact id round-trip, not merely that error text exists
    // somewhere on the page.
    expect(titleInput).toHaveAttribute('aria-invalid', 'true');
    expect(titleInput.getAttribute('aria-describedby')).toBe(titleError.id);
    expect(titleError.id).toBeTruthy();

    expect(bodyInput).toHaveAttribute('aria-invalid', 'true');
    expect(bodyInput.getAttribute('aria-describedby')).toBe(bodyError.id);
    expect(bodyError.id).toBeTruthy();
  });

  it('files a ticket and adds it to My tickets', async () => {
    const created: OwnTicket = {
      id: 5,
      type: 'suggestion',
      title: 'Add export to CSV',
      body: 'Would help with tracking progress externally.',
      status: 'open',
      version: 1,
      sourcePage: null,
      commentCount: 0,
      createdAt: '2026-07-05T00:00:00Z',
      updatedAt: '2026-07-05T00:00:00Z',
    };
    ticketsSvc.createTicket.mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await openFileSheet(user);

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
    // F-128: a successful file closes the Sheet (matching the
    // km-final.html "file → sheet closes → toast" beat) — the form (and
    // its now-stale values) is gone, not merely cleared in place.
    expect(await screen.findByText('Ticket filed.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
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
        sourcePage: null,
        commentCount: 0,
        createdAt: '2026-07-06T00:00:00Z',
        updatedAt: '2026-07-06T00:00:00Z',
      });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await openFileSheet(user);

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

describe('Tickets — F-127 (global "!" FAB hand-off)', () => {
  it('arriving via the FAB (compose + sourcePage state) autofocuses the title, shows "Filing from", and submits source_page', async () => {
    ticketsSvc.createTicket.mockResolvedValue({
      ...MINE_1,
      id: 7,
      title: 'Timer looks wrong',
      sourcePage: '/learn/topik',
    });
    const user = userEvent.setup();
    renderPage({
      pathname: '/tickets',
      state: {
        compose: true,
        sourcePage: { path: '/learn/topik', name: 'TOPIK' },
      },
    });
    await screen.findByText(/No tickets yet/);

    expect(screen.getByText('Filing from: TOPIK')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();

    await user.type(
      screen.getByRole('textbox', { name: 'Title' }),
      'Timer looks wrong',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      'The mock timer freezes.',
    );
    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    expect(ticketsSvc.createTicket).toHaveBeenCalledWith({
      type: 'bug',
      title: 'Timer looks wrong',
      body: 'The mock timer freezes.',
      sourcePage: '/learn/topik',
    });
  });

  it('a plain navigation to /tickets (no FAB state) shows no "Filing from" hint and omits source_page entirely', async () => {
    ticketsSvc.createTicket.mockResolvedValue({ ...MINE_1, id: 8 });
    const user = userEvent.setup();
    renderPage('/tickets');
    await screen.findByText(/No tickets yet/);

    // No compose state → the Sheet starts closed; the "Filing from" hint
    // check therefore happens BEFORE opening it too (a closed sheet renders
    // nothing to search, so this also proves no stray hint leaks outside it).
    expect(screen.queryByText(/Filing from:/)).not.toBeInTheDocument();
    await openFileSheet(user);
    expect(screen.queryByText(/Filing from:/)).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'x');
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'y');
    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    // No `sourcePage` key at all — never a bare `undefined`/empty string —
    // so the server sees a genuinely absent field (routes/tickets.ts stores
    // a real SQL NULL only when the key is missing).
    expect(ticketsSvc.createTicket).toHaveBeenCalledWith({
      type: 'bug',
      title: 'x',
      body: 'y',
    });
  });

  it('BLOCKER-2 fix-pass: an explicit `sourcePage: null` router-state (not merely absent) does not crash and falls back to "no page context"', async () => {
    // `null !== undefined` in JS — a router-state guard that only checks
    // `!== undefined` lets this shape slip through and then crashes reading
    // `.path` off `null`. Reproduces REVIEW_batch4-cst.md BLOCKER-2 exactly:
    // `compose: true` (so the Sheet opens, exercising the same render path a
    // real FAB tap would) with `sourcePage: null` instead of a real object or
    // a missing key.
    ticketsSvc.createTicket.mockResolvedValue({ ...MINE_1, id: 9 });
    const user = userEvent.setup();
    renderPage({
      pathname: '/tickets',
      state: { compose: true, sourcePage: null },
    });

    // No crash: the page renders normally and the Sheet is already open
    // (compose: true), same as any other malformed-state arrival.
    await screen.findByText(/No tickets yet/);
    expect(screen.getByRole('dialog', { name: 'File a ticket' })).toBeInTheDocument();
    // Graceful fallback — treated exactly like "no page context", not a
    // half-populated hint.
    expect(screen.queryByText(/Filing from:/)).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'x');
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'y');
    await user.click(screen.getByRole('button', { name: /File ticket/ }));

    // No `sourcePage` key sent — the null falls back the same as "absent".
    expect(ticketsSvc.createTicket).toHaveBeenCalledWith({
      type: 'bug',
      title: 'x',
      body: 'y',
    });
  });

  it('shows "Reported from: <name>" on a My-tickets row, and again on its detail view', async () => {
    const withSource: OwnTicket = { ...MINE_1, sourcePage: '/learn/writing' };
    ticketsSvc.listMyTickets.mockResolvedValue([withSource]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(withSource.title);

    expect(screen.getByText('Reported from: Writing')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: `View ticket: ${withSource.title}` }),
    );
    expect(await screen.findByText('Reported from: Writing')).toBeInTheDocument();
  });

  it('renders no "Reported from" line for a ticket with no source page', async () => {
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(MINE_1.title);

    expect(screen.queryByText(/Reported from:/)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: `View ticket: ${MINE_1.title}` }),
    );
    expect(screen.queryByText(/Reported from:/)).not.toBeInTheDocument();
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
    // F-128: the list view's filing entry point is now the header's "New
    // ticket" action (the form itself lives in a closed-by-default Sheet).
    expect(screen.getByRole('button', { name: /New ticket/ })).toBeInTheDocument();
  });

  it('REGRESSION (file → open → NOT FOUND): a just-filed ticket ABSENT from the filtered /mine list still opens, resolved by GET /tickets/:id', async () => {
    // The exact beta bug: /mine is filtered by the board's status/type
    // filter, so a just-filed ticket can be missing from BOTH cached lists
    // when its detail is opened. The old list-only lookup rendered "We
    // couldn't find that ticket." Reverting the fix to that lookup makes
    // this test fail (the id-addressed fetch is the only thing that resolves
    // the row here — both lists are empty).
    ticketsSvc.listMyTickets.mockResolvedValue([]);
    ticketsSvc.listCommunityTickets.mockResolvedValue([]);
    const filed: OwnTicket = {
      ...MINE_1,
      id: 42,
      title: 'Freshly filed, not in any list',
    };
    ticketsSvc.fetchTicket.mockResolvedValue({ kind: 'own', ticket: filed });

    // Land straight on the detail URL (the state after navigating to a
    // just-filed ticket whose row the filtered list never showed).
    renderPage(`/tickets?tab=mine&ticket=${String(filed.id)}`);

    // The detail renders from the id-addressed fetch, with edit rights
    // (owner shape → the Title field is editable), NOT the not-found card.
    expect(
      await screen.findByRole('textbox', { name: 'Title' }),
    ).toHaveValue(filed.title);
    expect(
      screen.queryByText(/couldn.t find that ticket/i),
    ).not.toBeInTheDocument();
    expect(ticketsSvc.fetchTicket).toHaveBeenCalledWith(
      filed.id,
      expect.anything(),
    );
  });

  it("REGRESSION: detail loads under an active status filter that would exclude the ticket from /mine (the fetch is authoritative, not the filtered list)", async () => {
    // An active `status=resolved` board filter means /mine returns only
    // resolved rows — an open ticket is absent. Opening it must still work
    // because the detail view reads GET /tickets/:id, not the filtered list.
    ticketsSvc.listMyTickets.mockResolvedValue([]); // filter excludes it
    const openTicket: OwnTicket = {
      ...MINE_1,
      id: 77,
      status: 'open',
      title: 'Open ticket hidden by a resolved-only filter',
    };
    ticketsSvc.fetchTicket.mockResolvedValue({
      kind: 'own',
      ticket: openTicket,
    });
    renderPage(`/tickets?tab=mine&ticket=${String(openTicket.id)}`);

    expect(
      await screen.findByRole('textbox', { name: 'Title' }),
    ).toHaveValue(openTicket.title);
  });

  it('opening ANOTHER user\'s ticket by id renders it VIEW-ONLY (community shape, no edit form)', async () => {
    // GET /tickets/:id returns the anonymized community shape for a ticket
    // that isn't the caller's own — no `version`, so no edit rights, even
    // though it's reachable by id.
    ticketsSvc.listMyTickets.mockResolvedValue([]);
    const othersTicket: CommunityTicket = {
      ...COMMUNITY_1,
      id: 88,
      isMine: false,
      title: "Someone else's ticket, opened by id",
    };
    ticketsSvc.fetchTicket.mockResolvedValue({
      kind: 'community',
      ticket: othersTicket,
    });
    renderPage(`/tickets?tab=community&ticket=${String(othersTicket.id)}`);

    expect(await screen.findByText(othersTicket.title)).toBeInTheDocument();
    // View-only: no edit affordances.
    expect(
      screen.queryByRole('textbox', { name: 'Title' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
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
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]); // initial mount list
    // Both the detail OPEN and the 409 recovery route through the
    // id-addressed GET /tickets/:id (= `fetchTicket`), which returns a
    // `TicketDetailResult`, not an array: first the owner-shape row the
    // detail view loads, then the freshly-bumped row the conflict recovery
    // pulls.
    ticketsSvc.fetchTicket
      .mockResolvedValueOnce({ kind: 'own', ticket: MINE_1 })
      .mockResolvedValueOnce({
        kind: 'own',
        ticket: {
          ...MINE_1,
          title: 'Someone already renamed this',
          version: 2,
        },
      });
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
    // The id-addressed read is hit twice: once for the detail open, once for
    // the conflict recovery (the initial /mine list is a separate call).
    expect(ticketsSvc.fetchTicket).toHaveBeenCalledTimes(2);
    expect(ticketsSvc.fetchTicket).toHaveBeenLastCalledWith(
      MINE_1.id,
      expect.anything(),
    );
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

  it('resets the expanded window back to the initial 15 when a filter changes', async () => {
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
    await user.click(screen.getByRole('button', { name: /Show more tickets/ }));
    expect(await screen.findByText('Community ticket #16')).toBeInTheDocument();

    // Changing a filter re-queries the server (mocked to return the same 18
    // rows again) and must also collapse the client-side window back to
    // `initial` (15) via `communityPage.reset()` — without that call, `count`
    // would stay at 30 and all 18 already-fetched rows would remain visible.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by status' }),
      'resolved',
    );
    await waitFor(() => {
      expect(ticketsSvc.listCommunityTickets).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'resolved' }),
        expect.anything(),
      );
    });

    expect(await screen.findByText('Community ticket #15')).toBeInTheDocument();
    expect(screen.queryByText('Community ticket #16')).not.toBeInTheDocument();
  });
});

// F-128 "Seoul Day & Night" reskin — both headers adopt the shared
// PageHubHeader (mirrors every other reskinned page's own fidelity test,
// e.g. Mistakes.test.tsx's "F-128 BLOCKER-2 fix"), rows/detail/thread ride
// CityCard signboards, and the file-a-ticket form moved into a Sheet.
describe('Tickets — F-128 reskin (PageHubHeader, CityCard rows, Sheet filing)', () => {
  it('the list view renders the shared PageHubHeader recipe (skyline + rail + a real h1) instead of a flat Topbar', async () => {
    const { container } = renderPage();
    await screen.findByText(/No tickets yet/);

    expect(
      container.querySelector('.km-hubheader__skyline'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('.km-hubheader__rail-divider'),
    ).toBeInTheDocument();
    const heading = screen.getByRole('heading', {
      level: 1,
      name: '베타 피드백 · Beta Feedback',
    });
    expect(heading).toHaveAttribute('id', 'km-tickets-title');
  });

  it('the detail view also renders the shared PageHubHeader recipe', async () => {
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]);
    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByText(MINE_1.title);

    await user.click(
      screen.getByRole('button', { name: `View ticket: ${MINE_1.title}` }),
    );

    expect(
      container.querySelector('.km-hubheader__skyline'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: '티켓 · Ticket' }),
    ).toBeInTheDocument();
  });

  it('each ticket row rides a CityCard signboard instead of a flat bordered row', async () => {
    ticketsSvc.listMyTickets.mockResolvedValue([MINE_1]);
    const { container } = renderPage();
    await screen.findByText(MINE_1.title);

    expect(
      container.querySelector('.km-tickets__card.km-citycard'),
    ).toBeInTheDocument();
  });

  it('the file-a-ticket form starts inside a CLOSED Sheet; "New ticket" opens it as a real dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);

    // Closed by default — no dialog, no Title field, until opened.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();

    await openFileSheet(user);

    expect(screen.getByRole('dialog', { name: 'File a ticket' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument();
  });
});

describe('Tickets — fix-pass batch-4 (T-1/T-3, REVIEW_batch4-cst.md)', () => {
  it('T-1: dismissing the file Sheet WITHOUT submitting (Esc) preserves the typed draft on reopen', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await openFileSheet(user);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'suggestion');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Add export to CSV');
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      'Would help with tracking progress externally.',
    );

    // Dismiss WITHOUT filing — Esc, not the "File ticket" button. `Sheet`
    // unmounts its children on close (Sheet.tsx: `if (!open) return null`),
    // so before this fix the draft lived in `FileTicketForm`'s own local
    // state and was silently destroyed here.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await openFileSheet(user);
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('suggestion');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Add export to CSV',
    );
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Would help with tracking progress externally.',
    );
  });

  it('T-1: a SUCCESSFUL file clears the draft, so the next "New ticket" open starts blank', async () => {
    ticketsSvc.createTicket.mockResolvedValue({
      ...MINE_1,
      id: 11,
      title: 'First ticket',
      body: 'First body',
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await openFileSheet(user);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'First ticket');
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'First body');
    await user.click(screen.getByRole('button', { name: /File ticket/ }));
    await screen.findByText('Ticket filed.');

    await openFileSheet(user);
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('bug');
  });

  it('T-3: retyping the (now parent-owned, T-1) draft repeatedly while the sheet stays open never steals focus off the Title field (useCallback focus-race regression)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No tickets yet/);
    await openFileSheet(user);

    const titleInput = screen.getByRole('textbox', { name: 'Title' });
    expect(titleInput).toHaveFocus();

    // Each keystroke now sets state that lives on `Tickets` itself (T-1
    // lifted the draft up), so this re-renders THE PAGE — exactly the
    // "Tickets re-renders while the sheet is open" scenario the closeFileSheet
    // useCallback (Tickets.tsx) guards against. An inline
    // `onClose={() => setFileOpen(false)}` would re-arm useModalA11y's
    // focus-capture/restore effect on every one of these renders, and the
    // queued microtask restore would eventually steal focus back to
    // whatever was active BEFORE the sheet opened (the "New ticket" button)
    // instead of leaving it on the field the user is actively typing into.
    await user.type(titleInput, 'Crash on launch');

    expect(titleInput).toHaveValue('Crash on launch');
    expect(titleInput).toHaveFocus();
  });
});
