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
import {
  registerUser,
  seedHanjaCharacter,
  seedKgiuEntry,
  seedVocabEntry,
} from '../helpers/seed.js';
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
  // vocab_entries / kgiu_entries / hanja_characters: clear per-test so each
  // scenario seeds its own reference rows. corpus_sources is left alone —
  // migration 002 seeds it and ensureCorpusSource is idempotent (finds the
  // existing seed).
  await pg.pool.query(`DELETE FROM vocab_entries`);
  await pg.pool.query(`DELETE FROM kgiu_entries`);
  await pg.pool.query(`DELETE FROM hanja_characters`);
  resetLimiters();
});

describe('vocab lists — overflowing ids → 400, not a pg 500 (routes sweep #3)', () => {
  // Number.isInteger(1e20) is true, so without an upper bound a 20-digit id
  // passes Zod and overflows BIGINT in pg (22003) → 500 where the contract is
  // 400/404 for a garbage id.
  it('GET /vocab/lists/99999999999999999999 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/lists/99999999999999999999');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('POST /vocab/lists/:id/entries with an overflowing entry id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: '목록' });
    expect(create.status).toBe(201);
    const res = await agent
      .post(`/vocab/lists/${create.body.list.id}/entries`)
      .send({ entry_ids: [1e20] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
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

describe('POST /vocab/lists/:id/entries — multi-type items (migration 049)', () => {
  it('adds a grammar item → 201 with item_type=grammar, lands in kgiu_entry_id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const g1 = await seedKgiuEntry(pg.pool, { pattern: '-(으)ㄹ 만하다' });
    const create = await agent.post('/vocab/lists').send({ name_kr: 'ㄱ', kind: 'grammar' });
    const id = create.body.list.id;
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'grammar', id: g1 }] });
    expect(res.status).toBe(201);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].item_type).toBe('grammar');
    expect(res.body.entries[0].entry_id).toBe(g1);
    // XOR column routing proven at the row level.
    const { rows } = await pg.pool.query(
      `SELECT vocab_entry_id, kgiu_entry_id, hanja_character_id
         FROM vocab_list_entries WHERE list_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].vocab_entry_id).toBeNull();
    expect(Number(rows[0].kgiu_entry_id)).toBe(g1);
    expect(rows[0].hanja_character_id).toBeNull();
  });

  it('adds a hanja item → 201, lands in hanja_character_id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const h1 = await seedHanjaCharacter(pg.pool, { char: '水', sound: '수' });
    const create = await agent.post('/vocab/lists').send({ name_kr: 'ㅎ', kind: 'hanja' });
    const id = create.body.list.id;
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'hanja', id: h1 }] });
    expect(res.status).toBe(201);
    expect(res.body.entries[0].item_type).toBe('hanja');
    const { rows } = await pg.pool.query(
      `SELECT vocab_entry_id, kgiu_entry_id, hanja_character_id
         FROM vocab_list_entries WHERE list_id = $1`,
      [id],
    );
    expect(rows[0].vocab_entry_id).toBeNull();
    expect(rows[0].kgiu_entry_id).toBeNull();
    expect(Number(rows[0].hanja_character_id)).toBe(h1);
  });

  it('mixed batch keeps client order in positions', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const v1 = await seedVocabEntry(pg.pool, { korean: '물' });
    const g1 = await seedKgiuEntry(pg.pool);
    const h1 = await seedHanjaCharacter(pg.pool, { char: '火', sound: '화' });
    const create = await agent.post('/vocab/lists').send({ name_kr: 'M', kind: 'mixed' });
    const id = create.body.list.id;
    const res = await agent.post(`/vocab/lists/${id}/entries`).send({
      items: [
        { type: 'grammar', id: g1 },
        { type: 'vocab', id: v1 },
        { type: 'hanja', id: h1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(
      res.body.entries.map((e: { item_type: string; position: number }) => [
        e.item_type,
        e.position,
      ]),
    ).toEqual([
      ['grammar', 0],
      ['vocab', 1],
      ['hanja', 2],
    ]);
  });

  it('409 on duplicate grammar membership', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const g1 = await seedKgiuEntry(pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'G' });
    const id = create.body.list.id;
    await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'grammar', id: g1 }] });
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'grammar', id: g1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('the same numeric id may exist under two types (per-target uniqueness)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // Force id collision odds by just using whatever ids come out — the
    // point is that a vocab membership never blocks a grammar membership,
    // even when their target ids happen to collide numerically.
    const v1 = await seedVocabEntry(pg.pool, { korean: '불' });
    const g1 = await seedKgiuEntry(pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'X', kind: 'mixed' });
    const id = create.body.list.id;
    const res = await agent.post(`/vocab/lists/${id}/entries`).send({
      items: [
        { type: 'vocab', id: v1 },
        { type: 'grammar', id: g1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.entries).toHaveLength(2);
  });

  it('404 when a grammar id does not exist (checked against kgiu_entries, not vocab)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // A REAL vocab id submitted as type=grammar must 404 — proves per-type
    // table validation (no cross-table smuggling into the wrong XOR column).
    const v1 = await seedVocabEntry(pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'L' });
    const id = create.body.list.id;
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'grammar', id: v1 }] });
    expect(res.status).toBe(404);
  });

  it('rejects unknown item type → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'L' });
    const id = create.body.list.id;
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'sentence', id: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('rejects both entry_ids and items in one request → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'L' });
    const id = create.body.list.id;
    const res = await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ entry_ids: [1], items: [{ type: 'vocab', id: 1 }] });
    expect(res.status).toBe(400);
  });

  it('404 (IDOR) when adding typed items to another user list', async () => {
    const a = await registerUser(t.app, pg.pool);
    const create = await a.agent.post('/vocab/lists').send({ name_kr: 'A' });
    const idA = create.body.list.id;
    const g1 = await seedKgiuEntry(pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent
      .post(`/vocab/lists/${idA}/entries`)
      .send({ items: [{ type: 'grammar', id: g1 }] });
    expect(res.status).toBe(404);
  });
});

describe('GET /vocab/lists/:id — multi-type contents (migration 049)', () => {
  it('joins each membership to its own entity and discriminates item_type', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const v1 = await seedVocabEntry(pg.pool, { korean: '학교', english: 'school' });
    const g1 = await seedKgiuEntry(pg.pool, { pattern: '-기로 하다' });
    const h1 = await seedHanjaCharacter(pg.pool, {
      char: '學',
      sound: '학',
      glossEn: 'learning',
    });
    const create = await agent.post('/vocab/lists').send({ name_kr: 'C', kind: 'mixed' });
    const id = create.body.list.id;
    await agent.post(`/vocab/lists/${id}/entries`).send({
      items: [
        { type: 'vocab', id: v1 },
        { type: 'grammar', id: g1 },
        { type: 'hanja', id: h1 },
      ],
    });
    const res = await agent.get(`/vocab/lists/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.list.entry_count).toBe(3);
    const [ev, eg, eh] = res.body.entries;
    expect(ev.item_type).toBe('vocab');
    expect(ev.korean).toBe('학교');
    expect(ev.english).toBe('school');
    expect(ev.pattern).toBeNull();
    expect(ev.hanja_char).toBeNull();
    expect(eg.item_type).toBe('grammar');
    expect(eg.pattern).toBe('-기로 하다');
    expect(eg.korean).toBeNull();
    expect(eh.item_type).toBe('hanja');
    expect(eh.hanja_char).toBe('學');
    expect(eh.hanja_sound).toBe('학');
    expect(eh.hanja_gloss_en).toBe('learning');
    expect(eh.korean).toBeNull();
  });
});

describe('DELETE /vocab/lists/:id/entries/:entryId?type= (migration 049)', () => {
  it('removes a grammar membership with ?type=grammar → 204', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const g1 = await seedKgiuEntry(pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'G' });
    const id = create.body.list.id;
    await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'grammar', id: g1 }] });
    const res = await agent.delete(
      `/vocab/lists/${id}/entries/${g1}?type=grammar`,
    );
    expect(res.status).toBe(204);
    const after = await agent.get(`/vocab/lists/${id}`);
    expect(after.body.entries).toHaveLength(0);
  });

  it('type defaults to vocab — a grammar membership is NOT removed without ?type', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const g1 = await seedKgiuEntry(pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'G' });
    const id = create.body.list.id;
    await agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'grammar', id: g1 }] });
    // Same id, no type → addresses the vocab column → nothing matches → 404.
    const res = await agent.delete(`/vocab/lists/${id}/entries/${g1}`);
    expect(res.status).toBe(404);
    const after = await agent.get(`/vocab/lists/${id}`);
    expect(after.body.entries).toHaveLength(1);
  });

  it('rejects an unknown ?type → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'G' });
    const id = create.body.list.id;
    const res = await agent.delete(
      `/vocab/lists/${id}/entries/1?type=sentence`,
    );
    expect(res.status).toBe(400);
  });

  it('404 (IDOR) removing a typed item from another user list', async () => {
    const a = await registerUser(t.app, pg.pool);
    const h1 = await seedHanjaCharacter(pg.pool, { char: '金', sound: '금' });
    const create = await a.agent.post('/vocab/lists').send({ name_kr: 'A' });
    const id = create.body.list.id;
    await a.agent
      .post(`/vocab/lists/${id}/entries`)
      .send({ items: [{ type: 'hanja', id: h1 }] });
    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.delete(
      `/vocab/lists/${id}/entries/${h1}?type=hanja`,
    );
    expect(res.status).toBe(404);
  });
});

describe('vocab_list_entries XOR CHECK (migration 049, DB level)', () => {
  it('rejects a row with two targets set and a row with none', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const v1 = await seedVocabEntry(pg.pool);
    const g1 = await seedKgiuEntry(pg.pool);
    const create = await agent.post('/vocab/lists').send({ name_kr: 'X' });
    const id = create.body.list.id;
    await expect(
      pg.pool.query(
        `INSERT INTO vocab_list_entries
                (list_id, vocab_entry_id, kgiu_entry_id, position)
         VALUES ($1, $2, $3, 0)`,
        [id, v1, g1],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_vocab_list_entries_target_xor' });
    await expect(
      pg.pool.query(
        `INSERT INTO vocab_list_entries (list_id, position) VALUES ($1, 0)`,
        [id],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_vocab_list_entries_target_xor' });
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
