/**
 * Integration tests for /hanja routes (Pass 7 — Hanja goes live).
 *
 * Routes:
 *   GET  /hanja
 *   GET  /hanja/today
 *   GET  /hanja/progress
 *   POST /hanja/:char/state
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in). No
 * Claude proxy is involved — every read is a pure DB read of the public hanja
 * corpus joined to the caller's own progress.
 *
 * Coverage:
 *   - auth required on every route (401 unauthenticated)
 *   - GET /hanja: list maps the DTO (incl. compounds + 'new' default), filter
 *     honored (banked/practicing/new), ORDER BY frequency DESC
 *   - GET /hanja/today: weighted toward a recently-mined vocab_card hanja; the
 *     frequency fallback; the empty-corpus null
 *   - GET /hanja/progress: counts (banked/practicing/new), targetL4, encountered
 *   - POST /:char/state: insert then update the SAME row (upsert), user-scoped,
 *     bad state → 400, bad char (multi-char) → 400
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedHanjaCharacter,
  seedHanjaProgress,
  seedVocabCard,
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
  // users CASCADE clears hanja_progress (user FK) + vocab_cards. The corpus
  // tables are reference data and ARE truncated here so each test controls the
  // exact character set (CASCADE on hanja_characters clears hanja_compounds).
  await pg.pool.query(
    'TRUNCATE TABLE hanja_progress, vocab_cards, sessions, users RESTART IDENTITY CASCADE',
  );
  await pg.pool.query('TRUNCATE TABLE hanja_characters RESTART IDENTITY CASCADE');
  resetLimiters();
});

describe('hanja — auth required', () => {
  it.each([
    ['GET', '/hanja'],
    ['GET', '/hanja/today'],
    ['GET', '/hanja/progress'],
    ['POST', '/hanja/學/state'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const m = method as 'GET' | 'POST';
    const res = m === 'GET' ? await request(t.app).get(p) : await request(t.app).post(p).send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /hanja — list + DTO mapping', () => {
  it('maps the DTO, defaults state to "new", and includes compounds', async () => {
    await seedHanjaCharacter(pg.pool, {
      char: '學',
      sound: '학',
      glossEn: 'learning, knowledge; school',
      strokes: 16,
      level: 'L3',
      frequency: 13,
      compounds: [{ kr: '학교', han: '學校', en: 'a school', with: '校' }],
    });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/hanja');
    expect(res.status).toBe(200);
    expect(res.body.characters.length).toBe(1);

    const h = res.body.characters[0];
    expect(h.id).toBe('學'); // id = char (stable key)
    expect(h.ch).toBe('學');
    expect(h.sound).toBe('학');
    expect(h.en).toBe('learning, knowledge; school');
    expect(h.gloss).toBe(''); // gloss_kr empty in v1 → ''
    expect(h.note).toBe(''); // etymology empty in v1 → ''
    expect(h.level).toBe('L3');
    expect(h.strokes).toBe(16);
    expect(h.state).toBe('new'); // no progress row → 'new'
    expect(h.compounds).toEqual([{ kr: '학교', han: '學校', en: 'a school', with: '校' }]);
  });

  it('orders by frequency DESC and folds in the user-specific state', async () => {
    await seedHanjaCharacter(pg.pool, { char: '人', frequency: 14, level: 'L2' });
    await seedHanjaCharacter(pg.pool, { char: '學', frequency: 13, level: 'L3' });
    await seedHanjaCharacter(pg.pool, { char: '水', frequency: 5, level: 'L3' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedHanjaProgress(pg.pool, userId, { char: '學', state: 'banked' });

    const res = await agent.get('/hanja');
    expect(res.status).toBe(200);
    const order = res.body.characters.map((h: { ch: string }) => h.ch);
    expect(order).toEqual(['人', '學', '水']); // frequency DESC

    const learn = res.body.characters.find((h: { ch: string }) => h.ch === '學');
    expect(learn.state).toBe('banked'); // this user's row
    const person = res.body.characters.find((h: { ch: string }) => h.ch === '人');
    expect(person.state).toBe('new'); // no row
  });

  it('does not leak another user\'s state', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const other = await registerUser(t.app, pg.pool);
    await seedHanjaProgress(pg.pool, other.userId, { char: '學', state: 'banked' });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/hanja');
    expect(res.body.characters[0].state).toBe('new'); // OUR state, not theirs
  });

  it('filter=banked / practicing / new honors the effective state', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學', frequency: 3 });
    await seedHanjaCharacter(pg.pool, { char: '人', frequency: 2 });
    await seedHanjaCharacter(pg.pool, { char: '水', frequency: 1 });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedHanjaProgress(pg.pool, userId, { char: '學', state: 'banked' });
    await seedHanjaProgress(pg.pool, userId, { char: '人', state: 'practicing' });
    // 水 has no row → effectively 'new'.

    const banked = await agent.get('/hanja').query({ filter: 'banked' });
    expect(banked.body.characters.map((h: { ch: string }) => h.ch)).toEqual(['學']);

    const practicing = await agent.get('/hanja').query({ filter: 'practicing' });
    expect(practicing.body.characters.map((h: { ch: string }) => h.ch)).toEqual(['人']);

    // 'new' includes the no-row character (水). An explicit 'new' row would also
    // qualify, but here only 水 lacks a non-new state.
    const fresh = await agent.get('/hanja').query({ filter: 'new' });
    expect(fresh.body.characters.map((h: { ch: string }) => h.ch)).toEqual(['水']);

    const all = await agent.get('/hanja').query({ filter: 'all' });
    expect(all.body.characters.length).toBe(3);
  });

  it('rejects an unknown filter value (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/hanja').query({ filter: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('GET /hanja/today — weighted featured pick', () => {
  it('weights toward a recently-mined word\'s hanja', async () => {
    // 學 appears in the user's mined vocab word; 水 is just a higher-frequency
    // corpus char. The mining signal must win over raw frequency.
    await seedHanjaCharacter(pg.pool, { char: '水', frequency: 99 });
    await seedHanjaCharacter(pg.pool, { char: '學', frequency: 1 });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // seedVocabCard creates a backing vocab_entry; set its hanja to contain 學.
    const cardId = await seedVocabCard(pg.pool, userId);
    await pg.pool.query(
      `UPDATE vocab_entries SET hanja = '學校'
        WHERE id = (SELECT vocab_entry_id FROM vocab_cards WHERE id = $1)`,
      [cardId],
    );

    const res = await agent.get('/hanja/today');
    expect(res.status).toBe(200);
    expect(res.body.character).not.toBeNull();
    expect(res.body.character.ch).toBe('學'); // mined wins over frequency
  });

  it('falls back to the highest-frequency not-yet-banked character', async () => {
    await seedHanjaCharacter(pg.pool, { char: '人', frequency: 14 });
    await seedHanjaCharacter(pg.pool, { char: '學', frequency: 13 });
    const { agent } = await registerUser(t.app, pg.pool);
    // No vocab cards → no mining signal → frequency fallback.

    const res = await agent.get('/hanja/today');
    expect(res.status).toBe(200);
    expect(res.body.character.ch).toBe('人');
  });

  it('returns a non-null character even when everything is banked', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學', frequency: 1 });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedHanjaProgress(pg.pool, userId, { char: '學', state: 'banked' });

    // Stages 1 + 2 yield nothing (no mining, all banked); stage 3 (deterministic
    // per-day) still surfaces a character.
    const res = await agent.get('/hanja/today');
    expect(res.status).toBe(200);
    expect(res.body.character.ch).toBe('學');
  });

  it('returns { character: null } on an empty corpus (never 500)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/hanja/today');
    expect(res.status).toBe(200);
    expect(res.body.character).toBeNull();
  });
});

describe('GET /hanja/progress — counts + target band', () => {
  it('counts banked/practicing/new, targetL4, and encountered', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學', level: 'L3' });
    await seedHanjaCharacter(pg.pool, { char: '人', level: 'L4' });
    await seedHanjaCharacter(pg.pool, { char: '水', level: 'L4' });
    await seedHanjaCharacter(pg.pool, { char: '火', level: 'L2' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedHanjaProgress(pg.pool, userId, { char: '學', state: 'banked' });
    await seedHanjaProgress(pg.pool, userId, { char: '人', state: 'practicing' });

    const res = await agent.get('/hanja/progress');
    expect(res.status).toBe(200);
    expect(res.body.banked).toBe(1);
    expect(res.body.practicing).toBe(1);
    expect(res.body.new).toBe(2); // 4 total − 1 banked − 1 practicing
    expect(res.body.targetL4).toBe(2); // 人 + 水
    expect(res.body.encountered).toBe(2); // any progress row (學 + 人)
    expect(typeof res.body.note).toBe('string');
  });

  it('reports all-new on an empty user with a non-empty corpus', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學', level: 'L3' });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/hanja/progress');
    expect(res.body.banked).toBe(0);
    expect(res.body.practicing).toBe(0);
    expect(res.body.new).toBe(1);
    expect(res.body.encountered).toBe(0);
  });
});

describe('POST /hanja/:char/state — user-scoped upsert', () => {
  it('inserts then updates the SAME row (idempotent upsert)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const first = await agent.post('/hanja/學/state').send({ state: 'practicing' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ char: '學', state: 'practicing' });

    const second = await agent.post('/hanja/學/state').send({ state: 'banked' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ char: '學', state: 'banked' });

    // Exactly ONE row, version bumped by the update (started at 1).
    const rows = await pg.pool.query<{ state: string; version: number; n: string }>(
      `SELECT state, version, count(*) OVER ()::text AS n
         FROM hanja_progress WHERE user_id = $1 AND char = '學'`,
      [userId],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.state).toBe('banked');
    expect(rows.rows[0]?.version).toBe(2); // 1 (insert) → 2 (one update)
  });

  it('stamps the SESSION user (no cross-user write)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    await agent.post('/hanja/學/state').send({ state: 'banked' });

    const rows = await pg.pool.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM hanja_progress`,
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.user_id).toBe(String(userId));
  });

  it('does not require the character to exist in the corpus', async () => {
    // Progress is decoupled from the corpus (migration 016) — a stamp on a char
    // with no hanja_characters row still succeeds.
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/hanja/龜/state').send({ state: 'practicing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ char: '龜', state: 'practicing' });
  });

  it('rejects an invalid state (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/hanja/學/state').send({ state: 'mastered' });
    expect(res.status).toBe(400);
  });

  it('rejects a multi-character param (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/hanja/學校/state').send({ state: 'banked' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown body field (strict schema, 400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/hanja/學/state')
      .send({ state: 'banked', userId: 999 });
    expect(res.status).toBe(400);
  });
});
