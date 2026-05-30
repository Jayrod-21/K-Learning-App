/**
 * Integration tests for /vocab/lists routes (Pass 3).
 *
 * Real Postgres via testcontainers per Bar §"Testing". Each describe block
 * truncates the relevant tables in beforeEach so scenarios are independent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedVocabEntry } from '../helpers/seed.js';
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
    `TRUNCATE TABLE vocab_list_entries, vocab_lists,
                     vocab_cards, card_reviews,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  // vocab_entries: clear per-test so each scenario seeds its own corpus rows.
  // corpus_sources is left alone — migration 002 seeds it and ensureCorpusSource
  // is idempotent (finds the existing seed).
  await pg.pool.query(`DELETE FROM vocab_entries`);
  resetLimiters();
});

describe('vocab lists — auth required', () => {
  it.each([
    ['GET', '/vocab/lists'],
    ['POST', '/vocab/lists'],
    ['GET', '/vocab/lists/1'],
    ['PATCH', '/vocab/lists/1'],
    ['DELETE', '/vocab/lists/1'],
    ['POST', '/vocab/lists/1/entries'],
    ['DELETE', '/vocab/lists/1/entries/1'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const m = method as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    let res;
    if (m === 'GET') res = await request(t.app).get(p);
    else if (m === 'POST') res = await request(t.app).post(p).send({});
    else if (m === 'PATCH') res = await request(t.app).patch(p).send({});
    else res = await request(t.app).delete(p);
    expect(res.status).toBe(401);
  });
});

describe('POST /vocab/lists', () => {
  it('creates a list → 201 with the new row', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/lists').send({
      name_kr: '기초 단어',
      name_en: 'Basics',
      kind: 'vocab',
    });
    expect(res.status).toBe(201);
    expect(res.body.list.name_kr).toBe('기초 단어');
    expect(res.body.list.kind).toBe('vocab');
    expect(res.body.appended).toBe(0);
  });

  it('rejects empty name_kr → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/lists').send({ name_kr: '' });
    expect(res.status).toBe(400);
  });

  it('rejects extra fields under .strict() → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/lists').send({
      name_kr: '단어',
      is_admin: true,
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown kind → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/lists').send({
      name_kr: '단어',
      kind: 'not-a-kind',
    });
    expect(res.status).toBe(400);
  });

  it('seeds entries inline — append count matches', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const e1 = await seedVocabEntry(pg.pool);
    const e2 = await seedVocabEntry(pg.pool, { korean: '가다' });
    const res = await agent.post('/vocab/lists').send({
      name_kr: '오늘',
      seed_entry_ids: [e1, e2, e1], // duplicate id → deduped server-side
    });
    expect(res.status).toBe(201);
    expect(res.body.appended).toBe(2);
  });
});

describe('GET /vocab/lists', () => {
  it('returns user own lists only', async () => {
    const a = await registerUser(t.app, pg.pool);
    await a.agent.post('/vocab/lists').send({ name_kr: 'A' });
    const b = await registerUser(t.app, pg.pool);
    await b.agent.post('/vocab/lists').send({ name_kr: 'B' });
    const res = await b.agent.get('/vocab/lists');
    expect(res.status).toBe(200);
    expect(res.body.lists).toHaveLength(1);
    expect(res.body.lists[0].name_kr).toBe('B');
  });

  it('respects kind filter', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.post('/vocab/lists').send({ name_kr: 'V', kind: 'vocab' });
    await agent.post('/vocab/lists').send({ name_kr: 'H', kind: 'hanja' });
    const res = await agent.get('/vocab/lists?kind=hanja');
    expect(res.status).toBe(200);
    expect(res.body.lists).toHaveLength(1);
    expect(res.body.lists[0].kind).toBe('hanja');
  });
});

describe('GET /vocab/lists/:id', () => {
  it('returns the list + entries in display order', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const e1 = await seedVocabEntry(pg.pool, { korean: '먹다' });
    const e2 = await seedVocabEntry(pg.pool, { korean: '가다' });
    const create = await agent.post('/vocab/lists').send({
      name_kr: 'L',
      seed_entry_ids: [e1, e2],
    });
    const id = create.body.list.id;
    const res = await agent.get(`/vocab/lists/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { korean: string }) => e.korean)).toEqual([
      '먹다',
      '가다',
    ]);
  });

  it("404 when the list belongs to someone else", async () => {
    const a = await registerUser(t.app, pg.pool);
    const create = await a.agent.post('/vocab/lists').send({ name_kr: 'A' });
    const idA = create.body.list.id;
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get(`/vocab/lists/${idA}`);
    expect(res.status).toBe(404);
  });

  it('404 after the list is soft-deleted', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'X' });
    const id = create.body.list.id;
    await agent.delete(`/vocab/lists/${id}`);
    const res = await agent.get(`/vocab/lists/${id}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /vocab/lists/:id', () => {
  it('renames the list', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'old' });
    const id = create.body.list.id;
    const res = await agent.patch(`/vocab/lists/${id}`).send({ name_kr: 'new' });
    expect(res.status).toBe(200);
    expect(res.body.list.name_kr).toBe('new');
    expect(res.body.list.version).toBe(2);
  });

  it('rejects empty body → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'x' });
    const id = create.body.list.id;
    const res = await agent.patch(`/vocab/lists/${id}`).send({});
    expect(res.status).toBe(400);
  });

  it('404 on other-user list', async () => {
    const a = await registerUser(t.app, pg.pool);
    const create = await a.agent.post('/vocab/lists').send({ name_kr: 'A' });
    const id = create.body.list.id;
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.patch(`/vocab/lists/${id}`).send({ name_kr: 'B' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /vocab/lists/:id', () => {
  it('soft-deletes the list', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'x' });
    const id = create.body.list.id;
    const del = await agent.delete(`/vocab/lists/${id}`);
    expect(del.status).toBe(204);
    // Subsequent delete is 404 (already gone) — distinguishable from "list
    // never existed".
    const second = await agent.delete(`/vocab/lists/${id}`);
    expect(second.status).toBe(404);
  });
});

describe('POST /vocab/lists/:id/entries', () => {
  it('appends entries → 201 with positions', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const e1 = await seedVocabEntry(pg.pool, { korean: '먹다' });
    const e2 = await seedVocabEntry(pg.pool, { korean: '가다' });
    const create = await agent.post('/vocab/lists').send({ name_kr: 'L' });
    const id = create.body.list.id;
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ entry_ids: [e1, e2] });
    expect(res.status).toBe(201);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0].position).toBe(0);
    expect(res.body.entries[1].position).toBe(1);
  });

  it('409 on duplicate add', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const e1 = await seedVocabEntry(pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'L' });
    const id = create.body.list.id;
    await agent.post(`/vocab/lists/${id}/entries`).send({ entry_ids: [e1] });
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ entry_ids: [e1] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('404 when an entry_id does not exist', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'L' });
    const id = create.body.list.id;
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ entry_ids: [99_999_999] });
    expect(res.status).toBe(404);
  });

  it('404 on other-user list', async () => {
    const a = await registerUser(t.app, pg.pool);
    const create = await a.agent.post('/vocab/lists').send({ name_kr: 'A' });
    const idA = create.body.list.id;
    const e1 = await seedVocabEntry(pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent
      .post(`/vocab/lists/${idA}/entries`)
      .send({ entry_ids: [e1] });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /vocab/lists/:id/entries/:entryId', () => {
  it('removes a single entry → 204', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const e1 = await seedVocabEntry(pg.pool);
    const create = await agent
      .post('/vocab/lists')
      .send({ name_kr: 'L', seed_entry_ids: [e1] });
    const id = create.body.list.id;
    const res = await agent.delete(`/vocab/lists/${id}/entries/${e1}`);
    expect(res.status).toBe(204);
  });

  it('404 when the entry is not in the list', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'L' });
    const id = create.body.list.id;
    const res = await agent.delete(`/vocab/lists/${id}/entries/12345`);
    expect(res.status).toBe(404);
  });

  it('404 on other-user list', async () => {
    const a = await registerUser(t.app, pg.pool);
    const e1 = await seedVocabEntry(pg.pool);
    const create = await a.agent
      .post('/vocab/lists')
      .send({ name_kr: 'A', seed_entry_ids: [e1] });
    const id = create.body.list.id;
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.delete(`/vocab/lists/${id}/entries/${e1}`);
    expect(res.status).toBe(404);
  });
});
