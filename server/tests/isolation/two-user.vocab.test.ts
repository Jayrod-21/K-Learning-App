/**
 * Cross-user isolation — vocab cards, vocab lists, and gloss overrides
 * (Phase 2.10 — turns the multi-user isolation audit into a regression
 * guard).
 *
 * Authenticated as B, reaching A's data. A separate suite
 * (tests/routes.auth-required.test.ts) already proves UNauthenticated access
 * is blocked; this suite is strictly about the CROSS-user boundary.
 *
 * Non-vacuous by construction: every "denied" assertion seeds A's REAL
 * resource, captures its REAL id, then issues the request as B against THAT
 * id — never a fabricated/nonexistent id. Every "list excludes" assertion
 * checks that A's SPECIFIC row is absent from B's response, not merely that
 * the list is non-empty.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { seedVocabCard, seedKrdictEntry } from '../helpers/seed.js';
import { twoUsers, expectDenied, type TwoUsers } from '../helpers/twoUsers.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { resetKrdictReadyCache } from '../../src/routes/define.js';

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
    `TRUNCATE TABLE vocab_list_entries, vocab_lists,
                     vocab_cards, card_reviews,
                     user_gloss_overrides,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  // Shared reference tables — clear per-test so each scenario controls its
  // own corpus (mirrors vocabLists.test.ts's convention).
  await pg.pool.query(`DELETE FROM vocab_entries`);
  await pg.pool.query(`DELETE FROM krdict_entries`);
  resetLimiters();
  resetKrdictReadyCache();
});

describe('cross-user isolation — vocab cards', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  it("B cannot read A's card in B's /vocab/cards/due, and A's card is not present", async () => {
    await seedVocabCard(pg.pool, users.a.userId, { dueOffsetMs: -60_000 });
    // B has a card of their own too, so the due list is non-empty either way
    // — the assertion below checks A's SPECIFIC card is absent, not just
    // "list has something".
    const bCardId = await seedVocabCard(pg.pool, users.b.userId, {
      dueOffsetMs: -60_000,
    });

    const res = await users.b.agent.get('/vocab/cards/due');
    expect(res.status).toBe(200);
    const ids = (res.body.cards as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(bCardId);
    // No id in B's due list may equal A's card id — that's the isolation
    // property (A's card is a DIFFERENT row than B's).
    const aCards = await pg.pool.query<{ id: string }>(
      `SELECT id FROM vocab_cards WHERE user_id = $1`,
      [users.a.userId],
    );
    const aCardId = Number(aCards.rows[0]!.id);
    expect(ids).not.toContain(aCardId);
  });

  it("B cannot delete A's card by id (404)", async () => {
    const aCardId = await seedVocabCard(pg.pool, users.a.userId);

    const res = await users.b.agent.delete(`/vocab/cards/${String(aCardId)}`);
    expectDenied(res);

    // The card must genuinely survive — a true isolation guard, not just a
    // status-code check.
    const { rows } = await pg.pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM vocab_cards WHERE id = $1`,
      [aCardId],
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it("B cannot review (mutate FSRS state of) A's card", async () => {
    const aCardId = await seedVocabCard(pg.pool, users.a.userId);

    const res = await users.b.agent
      .post(`/vocab/cards/${String(aCardId)}/reviews`)
      .send({ rating: 'good', expected_version: 1 });
    expectDenied(res);
  });
});

describe('cross-user isolation — vocab lists', () => {
  let users: TwoUsers;
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
  });

  async function createList(
    agent: TwoUsers['a']['agent'],
    nameKr: string,
  ): Promise<number> {
    const res = await agent.post('/vocab/lists').send({ name_kr: nameKr });
    expect(res.status).toBe(201);
    return res.body.list.id as number;
  }

  it("B cannot GET A's list by id (404)", async () => {
    const listId = await createList(users.a.agent, 'A의 목록');

    const res = await users.b.agent.get(`/vocab/lists/${String(listId)}`);
    expectDenied(res);
  });

  it("B's GET /vocab/lists index excludes A's list", async () => {
    const aListId = await createList(users.a.agent, 'A의 목록');
    const bListId = await createList(users.b.agent, 'B의 목록');

    const res = await users.b.agent.get('/vocab/lists');
    expect(res.status).toBe(200);
    const ids = (res.body.lists as Array<{ id: number }>).map((l) => l.id);
    expect(ids).toContain(bListId);
    expect(ids).not.toContain(aListId);
  });

  it("B cannot PATCH A's list (rename)", async () => {
    const listId = await createList(users.a.agent, 'A의 목록');

    const res = await users.b.agent
      .patch(`/vocab/lists/${String(listId)}`)
      .send({ name_kr: '해킹 시도' });
    expectDenied(res);

    const { rows } = await pg.pool.query<{ name_kr: string }>(
      `SELECT name_kr FROM vocab_lists WHERE id = $1`,
      [listId],
    );
    expect(rows[0]!.name_kr).toBe('A의 목록');
  });

  it("B cannot DELETE A's list", async () => {
    const listId = await createList(users.a.agent, 'A의 목록');

    const res = await users.b.agent.delete(`/vocab/lists/${String(listId)}`);
    expectDenied(res);

    const { rows } = await pg.pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM vocab_lists WHERE id = $1`,
      [listId],
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

describe('cross-user isolation — gloss overrides (Phase 2.8, the freshest surface)', () => {
  let users: TwoUsers;
  const LEMMA = '먹다';
  beforeEach(async () => {
    users = await twoUsers(t.app, pg.pool);
    // Shared default gloss both users read absent an override.
    await seedKrdictEntry(pg.pool, {
      headword: LEMMA,
      definitionEn: 'shared default gloss',
    });
  });

  it("A's override is invisible to B through GET /define — B sees the shared default", async () => {
    const put = await users.a.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: 'A-only gloss' });
    expect(put.status).toBe(200);

    // A sees their own override.
    const aRead = await users.a.agent.get('/define').query({ word: LEMMA });
    expect(aRead.status).toBe(200);
    expect(aRead.body.entries[0].definition_english).toBe('A-only gloss');
    expect(aRead.body.entries[0].overridden).toBe(true);

    // B sees the untouched shared default, not A's override.
    const bRead = await users.b.agent.get('/define').query({ word: LEMMA });
    expect(bRead.status).toBe(200);
    expect(bRead.body.entries[0].definition_english).toBe('shared default gloss');
    expect(bRead.body.entries[0].overridden).toBe(false);
  });

  it("A's override is invisible through a corpus surface (B's own /vocab/cards/due for the same lemma)", async () => {
    await users.a.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: 'A-only gloss' });

    // B mines/owns a card for a vocab_entries row with the SAME surface
    // lemma but a DIFFERENT underlying entry (the overlay matches on lemma
    // TEXT, not entry id — see services/glossOverrides.ts's header).
    await seedVocabCard(pg.pool, users.b.userId, { dueOffsetMs: -60_000 });
    // seedVocabCard's default entry korean is '먹다' (matches LEMMA) and
    // english defaults to 'to eat' — the shared value B must see.

    const res = await users.b.agent.get('/vocab/cards/due');
    expect(res.status).toBe(200);
    const card = (res.body.cards as Array<{ vocab_korean: string; vocab_english: string }>).find(
      (c) => c.vocab_korean === LEMMA,
    );
    expect(card).toBeDefined();
    expect(card!.vocab_english).toBe('to eat');
    expect(card!.vocab_english).not.toBe('A-only gloss');
  });

  it('B can independently override the SAME lemma without colliding with (or clobbering) A', async () => {
    await users.a.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: 'A-only gloss' });

    const bPut = await users.b.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: 'B-only gloss' });
    expect(bPut.status).toBe(200);

    // Two independent rows coexist — UNIQUE(user_id, lemma) allows one per
    // user, not one globally.
    const rows = await pg.pool.query<{ user_id: string; gloss: string }>(
      `SELECT user_id, gloss FROM user_gloss_overrides WHERE lemma = $1 ORDER BY user_id`,
      [LEMMA],
    );
    expect(rows.rows).toHaveLength(2);

    const aRead = await users.a.agent.get('/define').query({ word: LEMMA });
    expect(aRead.body.entries[0].definition_english).toBe('A-only gloss');
    const bRead = await users.b.agent.get('/define').query({ word: LEMMA });
    expect(bRead.body.entries[0].definition_english).toBe('B-only gloss');
  });

  it("B deleting their own override never touches A's — A's override survives intact", async () => {
    await users.a.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: 'A-only gloss' });
    await users.b.agent
      .put('/vocab/gloss-override')
      .send({ lemma: LEMMA, gloss: 'B-only gloss' });

    const del = await users.b.agent.delete('/vocab/gloss-override').send({ lemma: LEMMA });
    expect(del.status).toBe(200);
    expect(del.body.cleared).toBe(true);

    // A's row is untouched.
    const aRead = await users.a.agent.get('/define').query({ word: LEMMA });
    expect(aRead.body.entries[0].definition_english).toBe('A-only gloss');
    expect(aRead.body.entries[0].overridden).toBe(true);

    // B is back to the shared default.
    const bRead = await users.b.agent.get('/define').query({ word: LEMMA });
    expect(bRead.body.entries[0].definition_english).toBe('shared default gloss');
    expect(bRead.body.entries[0].overridden).toBe(false);

    const rows = await pg.pool.query(
      `SELECT 1 FROM user_gloss_overrides WHERE lemma = $1`,
      [LEMMA],
    );
    expect(rows.rowCount).toBe(1); // only A's row remains
  });
});
