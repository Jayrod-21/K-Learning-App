/**
 * Integration tests for /topik routes (Pass 6 — TOPIK Prep Study mode live +
 * Mock-Test server route).
 *
 * Routes:
 *   GET  /topik/items
 *   POST /topik/mock
 *   POST /topik/study
 *   POST /topik/:itemId/answer
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in). No
 * Claude proxy is involved — every item is a pure DB read of the public
 * topik_items pool.
 *
 * Coverage:
 *   - auth required on every route (401 unauthenticated)
 *   - GET /items: section/level/source_test filters + pagination (limit/offset/total)
 *   - POST /mock: ALL items of a test in original item_number order
 *   - POST /study: shuffled cross-test draw, filter honored, count ≤ limit
 *   - POST /:itemId/answer: grades correct AND wrong; inserts a user-scoped
 *     topik_responses row; 404 on a missing item
 *   - section Korean ↔ enum normalization (읽기 ⇄ reading)
 *   - the inline-answer design: study DTOs carry options[].correct + explanation
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser, seedTopikItem, seedTopikResponse } from '../helpers/seed.js';
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
  // users CASCADE clears topik_responses (user FK). topik_items / topik_tests
  // are truncated explicitly so each test controls exactly what is selectable.
  // corpus_sources is left alone (idempotent seeding via ensureCorpusSource).
  await pg.pool.query('TRUNCATE TABLE topik_responses, sessions, users RESTART IDENTITY CASCADE');
  await pg.pool.query('TRUNCATE TABLE topik_items, topik_tests CASCADE');
  resetLimiters();
});

describe('topik — auth required', () => {
  it.each([
    ['GET', '/topik/items'],
    ['POST', '/topik/mock'],
    ['POST', '/topik/study'],
    ['POST', '/topik/1/answer'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const m = method as 'GET' | 'POST';
    const res = m === 'GET' ? await request(t.app).get(p) : await request(t.app).post(p).send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /topik/items — filters + pagination', () => {
  it('returns mapped DTOs with inline answers + the matching total', async () => {
    await seedTopikItem(pg.pool, {
      section: 'reading',
      proficiency: 'L4',
      options: ['가', '나', '다', '라'],
      answer: 2, // 1-based → choice 'b'
      prompt: '알맞은 것을 고르십시오.',
      extra: { explanation: '정답은 나입니다.' },
    });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/topik/items');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items.length).toBe(1);

    const item = res.body.items[0];
    expect(typeof item.id).toBe('string');
    expect(item.section).toBe('읽기'); // enum → Korean
    expect(item.number).toBe(1);
    expect(item.level).toBe(4); // L4 → 4
    expect(item.prompt).toBe('알맞은 것을 고르십시오.');
    expect(item.explanation).toBe('정답은 나입니다.');
    // Inline answer: choice 'b' (answer=2) is the only `correct`. en is ''.
    expect(item.options.map((o: { id: string }) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(item.options.find((o: { correct: boolean }) => o.correct).id).toBe('b');
    expect(item.options.filter((o: { correct: boolean }) => o.correct).length).toBe(1);
    for (const o of item.options) expect(o.en).toBe('');
  });

  it('filters by section (Korean label) and by level', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L3' });
    await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4' });
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4' });
    const { agent } = await registerUser(t.app, pg.pool);

    // Korean section label normalizes to the reading enum.
    const reading = await agent.get('/topik/items').query({ section: '읽기' });
    expect(reading.body.total).toBe(2);
    for (const i of reading.body.items) expect(i.section).toBe('읽기');

    // Level filter: only the single L3 reading item.
    const l3 = await agent.get('/topik/items').query({ section: 'reading', level: 'L3' });
    expect(l3.body.total).toBe(1);
    expect(l3.body.items[0].level).toBe(3);
  });

  it('filters by source_test (test_number)', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 700, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 700, itemNumber: 2 });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 701, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/topik/items').query({ source_test: 700 });
    expect(res.body.total).toBe(2);
    expect(res.body.items.every((i: { number: number }) => i.number <= 2)).toBe(true);
  });

  it('paginates with limit/offset while total reflects the full filtered pool', async () => {
    // 5 items in one test, ordered item_number 1..5.
    for (let n = 1; n <= 5; n += 1) {
      await seedTopikItem(pg.pool, { section: 'reading', testNumber: 800, itemNumber: n });
    }
    const { agent } = await registerUser(t.app, pg.pool);

    const page1 = await agent.get('/topik/items').query({ source_test: 800, limit: 2, offset: 0 });
    expect(page1.body.total).toBe(5);
    expect(page1.body.items.map((i: { number: number }) => i.number)).toEqual([1, 2]);

    const page2 = await agent.get('/topik/items').query({ source_test: 800, limit: 2, offset: 2 });
    expect(page2.body.total).toBe(5);
    expect(page2.body.items.map((i: { number: number }) => i.number)).toEqual([3, 4]);
  });

  it('excludes ungradeable rows from BOTH total and items (total == browsable pool)', async () => {
    // Two gradeable reading items + one ungradeable (<2 options). The survivor
    // guard is pushed into the count AND page WHERE, so `total` counts only the
    // browsable pool and the ungradeable row never consumes an offset slot.
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 850, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 850, itemNumber: 2 });
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 850,
      itemNumber: 3,
      options: ['only-one'], // <2 options → excluded by jsonb_array_length guard
    });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/topik/items').query({ source_test: 850 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // ungradeable row excluded from total
    expect(res.body.items.length).toBe(2); // and from the page
    expect(res.body.items.map((i: { number: number }) => i.number)).toEqual([1, 2]);
  });

  it('rejects an unknown section value with 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/items').query({ section: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('POST /topik/mock — full test in original order', () => {
  it('returns every item of the test in item_number order', async () => {
    // Seed out of order to prove the route, not the insert order, sorts.
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 900, itemNumber: 3 });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 900, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 900, itemNumber: 2 });
    // A different test must not bleed in.
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 901, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 900 });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { number: number }) => i.number)).toEqual([1, 2, 3]);
  });

  it('honors the optional section filter within a test', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 910, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 910, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 910, section: 'listening' });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].section).toBe('듣기');
  });
});

describe('POST /topik/study — shuffled cross-test draw', () => {
  it('honors the filter and caps the count at limit', async () => {
    // 4 reading + 2 listening, across distinct tests.
    for (let i = 0; i < 4; i += 1) {
      await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4' });
    }
    for (let i = 0; i < 2; i += 1) {
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4' });
    }
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/study').send({ section: 'reading', limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(3); // capped at limit (4 available)
    for (const i of res.body.items) expect(i.section).toBe('읽기'); // filter honored
  });

  it('empty filter draws from the whole pool', async () => {
    await seedTopikItem(pg.pool, { section: 'reading' });
    await seedTopikItem(pg.pool, { section: 'listening' });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/study').send({ limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
  });

  it('returns the whole filtered pool (as a set) when limit >= pool size', async () => {
    // Pool > 2 with limit well above it: the draw must surface EVERY filtered
    // item exactly once. Assert set membership (not order — random() is shuffled
    // and an order assertion would be flaky), so a filter that silently
    // truncates the pool would fail here.
    const readingIds: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      readingIds.push(await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4' }));
    }
    // A non-matching listening item must NOT appear in a reading draw.
    await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4' });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/study').send({ section: 'reading', limit: 10 });
    expect(res.status).toBe(200);
    const drawnIds = (res.body.items as { id: string }[]).map((i) => i.id).sort();
    expect(drawnIds).toEqual(readingIds.map(String).sort());
  });
});

describe('POST /topik/:itemId/answer — grade + log + reveal', () => {
  it('grades a correct pick, logs a user-scoped row, reveals the answer', async () => {
    const itemId = await seedTopikItem(pg.pool, {
      section: 'reading',
      options: ['가', '나', '다', '라'],
      answer: 3, // 1-based → choice 'c'
      extra: { explanation: '정답 설명.' },
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const res = await agent
      .post(`/topik/${itemId}/answer`)
      .send({ picked: 'c', mode: 'study', timeMs: 1234 });
    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(true);
    expect(res.body.correctChoiceId).toBe('c');
    expect(res.body.explanation).toBe('정답 설명.');

    // A user-scoped append-only row was written, stamped with the SESSION user.
    const log = await pg.pool.query<{
      user_id: string;
      topik_item_id: string;
      picked: string;
      is_correct: boolean;
      mode: string;
      time_ms: number | null;
    }>(
      `SELECT user_id::text AS user_id, topik_item_id::text AS topik_item_id,
              picked, is_correct, mode, time_ms
         FROM topik_responses`,
    );
    expect(log.rows.length).toBe(1);
    expect(log.rows[0]?.user_id).toBe(String(userId));
    expect(log.rows[0]?.topik_item_id).toBe(String(itemId));
    expect(log.rows[0]?.picked).toBe('c');
    expect(log.rows[0]?.is_correct).toBe(true);
    expect(log.rows[0]?.mode).toBe('study');
    expect(log.rows[0]?.time_ms).toBe(1234); // timeMs round-trips into time_ms
  });

  it('grades a wrong pick and still logs it (is_correct=false)', async () => {
    const itemId = await seedTopikItem(pg.pool, { answer: 1 }); // correct = 'a'
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post(`/topik/${itemId}/answer`).send({ picked: 'b' });
    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(false);
    expect(res.body.correctChoiceId).toBe('a');

    const log = await pg.pool.query<{ is_correct: boolean; mode: string }>(
      `SELECT is_correct, mode FROM topik_responses`,
    );
    expect(log.rows[0]?.is_correct).toBe(false);
    expect(log.rows[0]?.mode).toBe('study'); // schema default when omitted
  });

  it("stores mode='mock' when the answer is posted in mock mode", async () => {
    const itemId = await seedTopikItem(pg.pool, { answer: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post(`/topik/${itemId}/answer`).send({ picked: 'a', mode: 'mock' });
    expect(res.status).toBe(200);

    // The mode column carries the posted value, not the schema default. This
    // catches a regression that hard-coded 'study' into the insert.
    const log = await pg.pool.query<{ mode: string }>(`SELECT mode FROM topik_responses`);
    expect(log.rows[0]?.mode).toBe('mock');
  });

  it('appends a new row on re-answer (append-only, not an update)', async () => {
    const itemId = await seedTopikItem(pg.pool, { answer: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    await agent.post(`/topik/${itemId}/answer`).send({ picked: 'a' });
    await agent.post(`/topik/${itemId}/answer`).send({ picked: 'b' });

    const log = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM topik_responses WHERE topik_item_id = $1`,
      [itemId],
    );
    expect(log.rows[0]?.n).toBe('2');
  });

  it('records under the session user, never a cross-user id', async () => {
    const itemId = await seedTopikItem(pg.pool, { answer: 1 });
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);

    await a.agent.post(`/topik/${itemId}/answer`).send({ picked: 'a' });
    await b.agent.post(`/topik/${itemId}/answer`).send({ picked: 'b' });

    const aRows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM topik_responses WHERE user_id = $1`,
      [a.userId],
    );
    const bRows = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM topik_responses WHERE user_id = $1`,
      [b.userId],
    );
    expect(aRows.rows[0]?.n).toBe('1');
    expect(bRows.rows[0]?.n).toBe('1');
  });

  it('returns 404 for a missing item', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/999999/answer').send({ picked: 'a' });
    expect(res.status).toBe(404);
    // Nothing logged for a missing item.
    const log = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM topik_responses`);
    expect(log.rows[0]?.n).toBe('0');
  });

  it('returns 404 for an existing-but-ungradeable item and logs nothing', async () => {
    // The item exists but its answer is an object (a writing-style item), so
    // mapRowToDTO yields null and the route refuses to log an ungradeable
    // attempt — a clean 404, not a meaningless row.
    const itemId = await seedTopikItem(pg.pool, { rawAnswer: { graded: false } });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post(`/topik/${itemId}/answer`).send({ picked: 'a' });
    expect(res.status).toBe(404);

    const log = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM topik_responses`);
    expect(log.rows[0]?.n).toBe('0'); // no row written for an ungradeable item
  });

  it('appends a 2nd distinct row when a prior attempt was pre-seeded', async () => {
    // Pre-seed a baseline attempt via seedTopikResponse, then answer through the
    // route and assert the append-only log now holds TWO distinct rows — the
    // route never overwrites the seeded attempt.
    const itemId = await seedTopikItem(pg.pool, { answer: 1 });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const seededId = await seedTopikResponse(pg.pool, userId, itemId, {
      picked: 'b',
      isCorrect: false,
      mode: 'study',
    });

    const res = await agent.post(`/topik/${itemId}/answer`).send({ picked: 'a' });
    expect(res.status).toBe(200);

    const log = await pg.pool.query<{ id: string; picked: string }>(
      `SELECT id::text AS id, picked FROM topik_responses
        WHERE user_id = $1 AND topik_item_id = $2
        ORDER BY id`,
      [userId, itemId],
    );
    expect(log.rows.length).toBe(2); // append-only: seeded + route row coexist
    expect(log.rows[0]?.id).toBe(String(seededId)); // seeded row untouched
    expect(log.rows[0]?.picked).toBe('b');
    expect(log.rows[1]?.picked).toBe('a'); // the route appended a distinct row
    expect(log.rows[1]?.id).not.toBe(String(seededId));
  });
});

describe('section Korean ↔ enum normalization', () => {
  it('GET /items?section=reading and section=읽기 select the same rows', async () => {
    await seedTopikItem(pg.pool, { section: 'reading' });
    await seedTopikItem(pg.pool, { section: 'listening' });
    const { agent } = await registerUser(t.app, pg.pool);

    const byEnum = await agent.get('/topik/items').query({ section: 'reading' });
    const byKr = await agent.get('/topik/items').query({ section: '읽기' });
    expect(byEnum.body.total).toBe(1);
    expect(byKr.body.total).toBe(1);
    expect(byKr.body.items[0].id).toBe(byEnum.body.items[0].id);
    expect(byKr.body.items[0].section).toBe('읽기');
  });
});
