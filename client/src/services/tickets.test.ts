/**
 * tickets service — wire↔domain boundary coercion.
 *
 * REGRESSION GUARD (the ticket-detail "we couldn't find that ticket" bug):
 * `tickets.id`/`ticket_comments.id` are Postgres `bigint`, which node-postgres
 * serializes as a JSON *string* (`"1"`, not `1`). The client derives the
 * addressed id as a `number` from the URL, so a raw string id made every
 * `ticket.id === ticketId` comparison in Tickets.tsx `false` → every ticket
 * rendered as "not found". These tests feed the REAL wire shape (string ids)
 * and assert the mappers coerce to `number`. Asserting `=== <number>` (strict)
 * is deliberate: revert the coercion and `"1" === 1` fails the test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addTicketComment,
  createTicket,
  fetchTicket,
  listMyTickets,
  listCommunityTickets,
  listTicketComments,
  patchTicket,
} from './tickets';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

// A `GET /tickets/:id` owner-shape response exactly as the server wire delivers
// it: bigint `id` as a string, integer `version` as a number.
const ownWire = {
  id: '1',
  type: 'bug',
  title: 'T',
  body: 'B',
  status: 'open',
  version: 1,
  source_page: null,
  comment_count: 2,
  created_at: '2026-07-17T00:00:00.000Z',
  updated_at: '2026-07-17T00:00:00.000Z',
};

const communityWire = {
  id: '42',
  type: 'suggestion',
  title: 'C',
  body: 'B',
  status: 'open',
  source_page: null,
  comment_count: 0,
  is_mine: false,
  created_at: '2026-07-17T00:00:00.000Z',
  updated_at: '2026-07-17T00:00:00.000Z',
};

describe('fetchTicket — bigint id coercion', () => {
  it('coerces a string owner id to a number (kind: own)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ ticket: ownWire });

    const result = await fetchTicket(1);

    expect(result.kind).toBe('own');
    // Strict equality against the numeric addressed id — the exact comparison
    // Tickets.tsx performs. A string id ("1") would fail this.
    expect(result.ticket.id).toBe(1);
    expect(typeof result.ticket.id).toBe('number');
  });

  it('coerces a string community id to a number (kind: community)', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ ticket: communityWire });

    const result = await fetchTicket(42);

    expect(result.kind).toBe('community');
    expect(result.ticket.id).toBe(42);
    expect(typeof result.ticket.id).toBe('number');
  });
});

describe('list endpoints — bigint id coercion', () => {
  it('listMyTickets coerces every row id to a number', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      tickets: [ownWire, { ...ownWire, id: '2' }],
      limit: 100,
      offset: 0,
    });

    const rows = await listMyTickets();

    expect(rows.map((t) => t.id)).toEqual([1, 2]);
    expect(rows.every((t) => typeof t.id === 'number')).toBe(true);
  });

  it('listCommunityTickets coerces every row id to a number', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      tickets: [communityWire],
      limit: 100,
      offset: 0,
    });

    const rows = await listCommunityTickets();

    expect(rows[0].id).toBe(42);
    expect(typeof rows[0].id).toBe('number');
  });

  it('listTicketComments coerces every comment id to a number', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({
      comments: [
        { id: '7', body: 'hi', is_mine: true, created_at: '2026-07-17T00:00:00.000Z' },
      ],
      limit: 100,
      offset: 0,
    });

    const rows = await listTicketComments(1);

    expect(rows[0].id).toBe(7);
    expect(typeof rows[0].id).toBe('number');
  });
});

// The mutating endpoints reuse the same three mappers the reads exercise, but
// each response path is asserted DIRECTLY here so the wire boundary stays
// covered even if the mappers are ever split or a path stops routing through
// them (review NIT-2).
describe('mutating endpoints — bigint id coercion on the response', () => {
  it('createTicket coerces the created ticket id to a number', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      ticket: { ...ownWire, id: '9' },
    });

    const created = await createTicket({ type: 'bug', title: 'T', body: 'B' });

    expect(created.id).toBe(9);
    expect(typeof created.id).toBe('number');
  });

  it('patchTicket coerces the updated ticket id to a number', async () => {
    vi.spyOn(api, 'patch').mockResolvedValueOnce({
      ticket: { ...ownWire, id: '1', version: 2 },
    });

    const updated = await patchTicket(1, {
      status: 'resolved',
      expectedVersion: 1,
    });

    expect(updated.id).toBe(1);
    expect(typeof updated.id).toBe('number');
  });

  it('addTicketComment coerces the created comment id to a number', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({
      comment: {
        id: '8',
        body: 'hi',
        is_mine: true,
        created_at: '2026-07-17T00:00:00.000Z',
      },
    });

    const comment = await addTicketComment(1, 'hi');

    expect(comment.id).toBe(8);
    expect(typeof comment.id).toBe('number');
  });
});
