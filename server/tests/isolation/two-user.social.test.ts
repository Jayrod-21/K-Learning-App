/**
 * Cross-user isolation — conversations, hanja progress, and tickets
 * (Phase 2.10).
 *
 * Tickets carve-out (F-023): `tickets` is a DELIBERATELY shared community
 * board (see routes/tickets.ts's module header and RECON_server.md §3) — a
 * non-owner's GET /tickets/:id is NOT denied, it returns the ANONYMIZED
 * community shape (no `version`, no owner identity). That is not an
 * isolation bug; this suite asserts the anonymization contract holds (no
 * `version`/user-identifying field leaks) and that the owner-only PATCH
 * mutation + the private /tickets/mine list stay strictly scoped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { seedHanjaCharacter, seedHanjaProgress } from '../helpers/seed.js';
import { twoUsers, expectDenied, type TwoUsers } from '../helpers/twoUsers.js';
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
    `TRUNCATE TABLE image_words, image_captures, conversations,
                     ticket_comments, tickets,
                     hanja_progress, vocab_cards,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  await pg.pool.query(`TRUNCATE TABLE hanja_characters RESTART IDENTITY CASCADE`);
  resetLimiters();
});

describe('cross-user isolation — conversations', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  async function startConversation(agent: TwoUsers['a']['agent']): Promise<number> {
    const res = await agent.post('/conversation').send({ mode: 'casual' });
    expect(res.status).toBe(201);
    return res.body.conversation.id as number;
  }

  it("B cannot GET A's conversation by id (404)", async () => {
    const convId = await startConversation(users.a.agent);

    const res = await users.b.agent.get(`/conversation/${String(convId)}`);
    expectDenied(res);
  });

  it("B's conversation list excludes A's conversation", async () => {
    const aConvId = await startConversation(users.a.agent);
    const bConvId = await startConversation(users.b.agent);

    const res = await users.b.agent.get('/conversation');
    expect(res.status).toBe(200);
    const ids = (res.body.conversations as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(bConvId);
    expect(ids).not.toContain(aConvId);
  });

  it("B cannot post a message into A's conversation", async () => {
    const convId = await startConversation(users.a.agent);

    const res = await users.b.agent
      .post(`/conversation/${String(convId)}/messages`)
      .send({ content: '안녕하세요', expected_version: 1 });
    expectDenied(res);
  });

  it("B cannot rename (PATCH) A's conversation", async () => {
    const convId = await startConversation(users.a.agent);

    const res = await users.b.agent
      .patch(`/conversation/${String(convId)}`)
      .send({ title: 'hijacked title' });
    expectDenied(res);

    const { rows } = await pg.pool.query<{ title: string | null }>(
      `SELECT title FROM conversations WHERE id = $1`,
      [convId],
    );
    expect(rows[0]!.title).toBeNull();
  });
});

describe('cross-user isolation — hanja progress', () => {
  let users: TwoUsers;
  const CHAR = '學';
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
    await seedHanjaCharacter(pg.pool, { char: CHAR });
  });

  it("A's banked state is not visible in B's GET /hanja list — B sees the character as 'new'", async () => {
    await seedHanjaProgress(pg.pool, users.a.userId, { char: CHAR, state: 'banked' });

    const res = await users.b.agent.get('/hanja');
    expect(res.status).toBe(200);
    const entry = (res.body.characters as Array<{ ch: string; state: string }>).find(
      (c) => c.ch === CHAR,
    );
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('new');
  });

  it("filtering B's GET /hanja?filter=banked never includes A's banked character", async () => {
    await seedHanjaProgress(pg.pool, users.a.userId, { char: CHAR, state: 'banked' });

    const res = await users.b.agent.get('/hanja').query({ filter: 'banked' });
    expect(res.status).toBe(200);
    const chars = (res.body.characters as Array<{ ch: string }>).map((c) => c.ch);
    expect(chars).not.toContain(CHAR);
  });

  it("A's progress does not shift B's aggregate /hanja/progress counts", async () => {
    await seedHanjaProgress(pg.pool, users.a.userId, { char: CHAR, state: 'banked' });

    const res = await users.b.agent.get('/hanja/progress');
    expect(res.status).toBe(200);
    expect(res.body.banked).toBe(0);
    expect(res.body.encountered).toBe(0);
  });
});

describe('cross-user isolation — tickets (F-023 shared community board carve-out)', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  async function fileTicket(agent: TwoUsers['a']['agent'], title: string): Promise<number> {
    const res = await agent
      .post('/tickets')
      .send({ type: 'bug', title, body: "A's private description" });
    expect(res.status).toBe(201);
    return res.body.ticket.id as number;
  }

  it("A's ticket, read by B, is the ANONYMIZED community shape — not the owner shape, not a 404 (intentional F-023 design)", async () => {
    const ticketId = await fileTicket(users.a.agent, 'a filed bug');

    const res = await users.b.agent.get(`/tickets/${String(ticketId)}`);
    expect(res.status).toBe(200);
    // Owner-only fields must be absent — this is what distinguishes the
    // anonymized shape from a genuine cross-user leak.
    expect(res.body.ticket).not.toHaveProperty('version');
    expect(res.body.ticket).not.toHaveProperty('user_id');
    expect(res.body.ticket.is_mine).toBe(false);
    expect(res.body.ticket.title).toBe('a filed bug');
  });

  it("B's /tickets/mine excludes A's ticket (the private per-owner list stays scoped)", async () => {
    const aTicketId = await fileTicket(users.a.agent, "a's bug");
    const bTicketId = await fileTicket(users.b.agent, "b's bug");

    const res = await users.b.agent.get('/tickets/mine');
    expect(res.status).toBe(200);
    const ids = (res.body.tickets as Array<{ id: number }>).map((tk) => tk.id);
    expect(ids).toContain(bTicketId);
    expect(ids).not.toContain(aTicketId);
  });

  it("B cannot PATCH (edit) A's ticket — the owner-only mutation stays denied on the shared board", async () => {
    const ticketId = await fileTicket(users.a.agent, 'original title');

    const res = await users.b.agent
      .patch(`/tickets/${String(ticketId)}`)
      .send({ title: 'hijacked by B', expected_version: 1 });
    expectDenied(res);

    const { rows } = await pg.pool.query<{ title: string }>(
      `SELECT title FROM tickets WHERE id = $1`,
      [ticketId],
    );
    expect(rows[0]!.title).toBe('original title');
  });
});
