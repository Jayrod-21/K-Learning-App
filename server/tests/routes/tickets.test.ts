/**
 * Integration tests for /tickets routes (F-023 beta ticketing).
 *
 * Real Postgres via testcontainers per Bar §"Testing". Each describe block
 * relies on the beforeEach truncate so scenarios are independent.
 *
 * The load-bearing assertions here are the F-023 anonymity contract (community
 * reads never carry user_id/email — asserted structurally over the whole JSON
 * payload, not just spot-checked fields) and the IDOR posture (PATCH against
 * another user's ticket is a 404 indistinguishable from "no such ticket").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({ connectionString: pg.connectionString });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    `TRUNCATE TABLE ticket_comments, tickets, sessions, users
     RESTART IDENTITY CASCADE`,
  );
  resetLimiters();
});

/** Every key path in `value` must avoid author-identifying fields. */
function assertAnonymized(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain('user_id');
  expect(json).not.toContain('userId');
  expect(json).not.toContain('email');
}

describe('tickets — auth required', () => {
  it.each([
    ['POST', '/tickets'],
    ['GET', '/tickets/mine'],
    ['GET', '/tickets/community'],
    ['PATCH', '/tickets/1'],
    ['POST', '/tickets/1/comments'],
    ['GET', '/tickets/1/comments'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const m = method as 'GET' | 'POST' | 'PATCH';
    let res;
    if (m === 'GET') res = await request(t.app).get(p);
    else if (m === 'POST') res = await request(t.app).post(p).send({});
    else res = await request(t.app).patch(p).send({});
    expect(res.status).toBe(401);
  });
});

describe('tickets — overflowing ids → 400, not a pg 500 (routes sweep #3)', () => {
  it('PATCH /tickets/99999999999999999999 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .patch('/tickets/99999999999999999999')
      .send({ title: 'x', expected_version: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('GET /tickets/99999999999999999999/comments → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/tickets/99999999999999999999/comments');
    expect(res.status).toBe(400);
  });
});

describe('POST /tickets', () => {
  it('files a ticket → 201 with the new row (status=open, version=1)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/tickets').send({
      type: 'bug',
      title: 'Mock timer freezes at 1:09',
      body: 'The TOPIK mock timer stops counting down and shows wrong units.',
    });
    expect(res.status).toBe(201);
    expect(res.body.ticket.type).toBe('bug');
    expect(res.body.ticket.title).toBe('Mock timer freezes at 1:09');
    expect(res.body.ticket.status).toBe('open');
    expect(res.body.ticket.version).toBe(1);
    expect(res.body.ticket.created_at).toBeTruthy();
    // Even the owner's create response carries no identity columns — the
    // session already knows who the caller is.
    assertAnonymized(res.body);
  });

  it('rejects an unknown type → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/tickets')
      .send({ type: 'rant', title: 't', body: 'b' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('rejects a missing/empty title → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const missing = await agent.post('/tickets').send({ type: 'bug', body: 'b' });
    expect(missing.status).toBe(400);
    const empty = await agent
      .post('/tickets')
      .send({ type: 'bug', title: '   ', body: 'b' });
    expect(empty.status).toBe(400);
  });

  it('rejects an over-length body → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 't', body: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
  });

  it('rejects extra fields under .strict() (mass assignment) → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/tickets').send({
      type: 'bug',
      title: 't',
      body: 'b',
      user_id: 999,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /tickets — source_page (F-127 global "!" FAB)', () => {
  it('files a ticket with source_page → 201, the path comes back verbatim', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/tickets').send({
      type: 'suggestion',
      title: 'Add a dark mode toggle',
      body: 'Would be nice.',
      source_page: '/learn/writing',
    });
    expect(res.status).toBe(201);
    expect(res.body.ticket.source_page).toBe('/learn/writing');
    // source_page is UI context, not identity — the anonymity assertion
    // still holds with it present.
    assertAnonymized(res.body);
  });

  it('files a ticket WITHOUT source_page → 201, the column is null (not the Settings tile flow)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 'no page context', body: 'b' });
    expect(res.status).toBe(201);
    expect(res.body.ticket.source_page).toBeNull();
  });

  it('rejects an empty-string source_page → 400 (omit, don’t empty-string, when there is no context)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/tickets').send({
      type: 'bug',
      title: 't',
      body: 'b',
      source_page: '',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an over-length source_page → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/tickets').send({
      type: 'bug',
      title: 't',
      body: 'b',
      source_page: '/' + 'a'.repeat(200),
    });
    expect(res.status).toBe(400);
  });

  it('a ticket filed with source_page carries it on /mine and /community, still anonymized (REVIEW_backend.md SF-2)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.post('/tickets').send({
      type: 'bug',
      title: 'source-page round trip',
      body: 'b',
      source_page: '/progress',
    });

    const mine = await agent.get('/tickets/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.tickets[0].source_page).toBe('/progress');

    const community = await agent.get('/tickets/community');
    expect(community.status).toBe(200);
    expect(community.body.tickets[0].source_page).toBe('/progress');
    // The two properties ("carries source_page" and "still identity-free")
    // must hold SIMULTANEOUSLY on the same community payload — a careless
    // future `SELECT t.*`-style refactor that leaked identity alongside
    // source_page specifically wouldn't necessarily be caught by either
    // property being asserted in isolation elsewhere in this file.
    assertAnonymized(community.body);
  });
});

describe('GET /tickets/mine', () => {
  it('returns the caller own tickets only, recent first', async () => {
    const a = await registerUser(t.app, pg.pool);
    await a.agent.post('/tickets').send({ type: 'bug', title: 'A1', body: 'b' });
    const b = await registerUser(t.app, pg.pool);
    await b.agent
      .post('/tickets')
      .send({ type: 'suggestion', title: 'B1', body: 'b' });
    const res = await b.agent.get('/tickets/mine');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].title).toBe('B1');
    // Owner view still carries version (the PATCH concurrency token).
    expect(res.body.tickets[0].version).toBe(1);
    expect(res.body.tickets[0].comment_count).toBe(0);
  });

  it('respects the status filter', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const open = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 'stays open', body: 'b' });
    const toClose = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 'gets closed', body: 'b' });
    await agent
      .patch(`/tickets/${toClose.body.ticket.id}`)
      .send({ status: 'closed', expected_version: 1 });
    const res = await agent.get('/tickets/mine?status=open');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].id).toBe(open.body.ticket.id);
  });

  it('rejects an unknown status filter → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/tickets/mine?status=nope');
    expect(res.status).toBe(400);
  });
});

describe('GET /tickets/community — the anonymized feed', () => {
  it('returns ALL users tickets with NO author identity (F-023)', async () => {
    const a = await registerUser(t.app, pg.pool);
    await a.agent
      .post('/tickets')
      .send({ type: 'bug', title: 'from A', body: 'b' });
    const b = await registerUser(t.app, pg.pool);
    await b.agent
      .post('/tickets')
      .send({ type: 'request', title: 'from B', body: 'b' });

    const res = await b.agent.get('/tickets/community');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(2);
    const titles = res.body.tickets.map((x: { title: string }) => x.title);
    expect(titles).toContain('from A');
    expect(titles).toContain('from B');
    // The anonymity contract, asserted over the ENTIRE payload.
    assertAnonymized(res.body);
    // is_mine reveals only the caller's own relationship to each ticket.
    const byTitle = Object.fromEntries(
      res.body.tickets.map((x: { title: string; is_mine: boolean }) => [
        x.title,
        x.is_mine,
      ]),
    );
    expect(byTitle['from A']).toBe(false);
    expect(byTitle['from B']).toBe(true);
  });

  it('respects type filter + pagination shape', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.post('/tickets').send({ type: 'bug', title: 'b1', body: 'x' });
    await agent
      .post('/tickets')
      .send({ type: 'concern', title: 'c1', body: 'x' });
    const res = await agent.get('/tickets/community?type=concern&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].type).toBe('concern');
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
  });
});

describe('PATCH /tickets/:id', () => {
  it('edits own ticket (title/body/status) and bumps version', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 'old', body: 'old body' });
    const id = create.body.ticket.id;
    const res = await agent.patch(`/tickets/${id}`).send({
      title: 'new',
      status: 'in_progress',
      expected_version: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.ticket.title).toBe('new');
    expect(res.body.ticket.body).toBe('old body');
    expect(res.body.ticket.status).toBe('in_progress');
    expect(res.body.ticket.version).toBe(2);
  });

  it('409 on a stale expected_version (optimistic concurrency)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 't', body: 'b' });
    const id = create.body.ticket.id;
    const first = await agent
      .patch(`/tickets/${id}`)
      .send({ title: 't2', expected_version: 1 });
    expect(first.status).toBe(200);
    const stale = await agent
      .patch(`/tickets/${id}`)
      .send({ title: 't3', expected_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('conflict');
  });

  it("404 on another user's ticket — no IDOR / ownership probe", async () => {
    const a = await registerUser(t.app, pg.pool);
    const create = await a.agent
      .post('/tickets')
      .send({ type: 'bug', title: 'A owns this', body: 'b' });
    const id = create.body.ticket.id;
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent
      .patch(`/tickets/${id}`)
      .send({ title: 'hijack', expected_version: 1 });
    expect(res.status).toBe(404);
    // Identical shape to a genuinely absent id.
    const absent = await b.agent
      .patch('/tickets/999999')
      .send({ title: 'x', expected_version: 1 });
    expect(absent.status).toBe(404);
    expect(res.body.error.code).toBe(absent.body.error.code);
    expect(res.body.error.message).toBe(absent.body.error.message);
  });

  it('400 when expected_version is missing', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 't', body: 'b' });
    const res = await agent
      .patch(`/tickets/${create.body.ticket.id}`)
      .send({ title: 'x' });
    expect(res.status).toBe(400);
  });

  it('400 when only expected_version is supplied (no fields)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 't', body: 'b' });
    const res = await agent
      .patch(`/tickets/${create.body.ticket.id}`)
      .send({ expected_version: 1 });
    expect(res.status).toBe(400);
  });

  it('400 on an unknown status value', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 't', body: 'b' });
    const res = await agent
      .patch(`/tickets/${create.body.ticket.id}`)
      .send({ status: 'wontfix', expected_version: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects source_page on PATCH — page context is set once at filing, never rewritten (REVIEW_backend.md SF-1)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/tickets').send({
      type: 'bug',
      title: 't',
      body: 'b',
      source_page: '/learn/writing',
    });
    const id = create.body.ticket.id;
    const res = await agent.patch(`/tickets/${id}`).send({
      title: 'still edits title fine',
      source_page: '/hijack',
      expected_version: 1,
    });
    // PatchBodySchema has no `source_page` key and is `.strict()` — an
    // unknown key 400s the whole request before the handler ever runs, it
    // is not silently dropped/ignored. This proves that guarantee rather
    // than just reading the schema: a future edit that added a
    // `source_page` key to PatchBodySchema (e.g. a "re-tag the page"
    // feature) would flip this test from 400 to 200 and be caught here.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    // The ticket itself must be untouched by the rejected request.
    const mine = await agent.get('/tickets/mine');
    expect(mine.body.tickets[0].source_page).toBe('/learn/writing');
    expect(mine.body.tickets[0].title).toBe('t');
  });
});

describe('POST /tickets/:id/comments + GET /tickets/:id/comments', () => {
  it('any user can comment on any community ticket; thread is chronological and anonymized', async () => {
    const a = await registerUser(t.app, pg.pool);
    const create = await a.agent
      .post('/tickets')
      .send({ type: 'suggestion', title: 'dark mode', body: 'please' });
    const id = create.body.ticket.id;

    const c1 = await a.agent
      .post(`/tickets/${id}/comments`)
      .send({ body: 'author follow-up' });
    expect(c1.status).toBe(201);
    expect(c1.body.comment.body).toBe('author follow-up');
    expect(c1.body.comment.is_mine).toBe(true);
    expect(c1.body.comment.created_at).toBeTruthy();
    assertAnonymized(c1.body);

    const b = await registerUser(t.app, pg.pool);
    const c2 = await b.agent
      .post(`/tickets/${id}/comments`)
      .send({ body: 'me too' });
    expect(c2.status).toBe(201);

    const thread = await b.agent.get(`/tickets/${id}/comments`);
    expect(thread.status).toBe(200);
    expect(
      thread.body.comments.map((c: { body: string }) => c.body),
    ).toEqual(['author follow-up', 'me too']);
    // Anonymized for the reader: no identity, only is_mine relative to B.
    assertAnonymized(thread.body);
    expect(
      thread.body.comments.map((c: { is_mine: boolean }) => c.is_mine),
    ).toEqual([false, true]);
  });

  it('commenting bumps nothing on the ticket but shows in comment_count', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 't', body: 'b' });
    const id = create.body.ticket.id;
    await agent.post(`/tickets/${id}/comments`).send({ body: 'one' });
    await agent.post(`/tickets/${id}/comments`).send({ body: 'two' });
    const mine = await agent.get('/tickets/mine');
    expect(mine.body.tickets[0].comment_count).toBe(2);
    const community = await agent.get('/tickets/community');
    expect(community.body.tickets[0].comment_count).toBe(2);
  });

  it('404 when the ticket does not exist', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const post = await agent
      .post('/tickets/999999/comments')
      .send({ body: 'ghost' });
    expect(post.status).toBe(404);
    const get = await agent.get('/tickets/999999/comments');
    expect(get.status).toBe(404);
  });

  it('rejects empty / over-length / extra-field comment bodies → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent
      .post('/tickets')
      .send({ type: 'bug', title: 't', body: 'b' });
    const id = create.body.ticket.id;
    const empty = await agent.post(`/tickets/${id}/comments`).send({ body: ' ' });
    expect(empty.status).toBe(400);
    const long = await agent
      .post(`/tickets/${id}/comments`)
      .send({ body: 'x'.repeat(2001) });
    expect(long.status).toBe(400);
    const extra = await agent
      .post(`/tickets/${id}/comments`)
      .send({ body: 'ok', user_id: 1 });
    expect(extra.status).toBe(400);
  });
});
