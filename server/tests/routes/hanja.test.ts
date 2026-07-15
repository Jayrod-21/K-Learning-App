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
 *
 * FSRS cards (F-075, migration 050):
 *   - POST /:char/card: seed → 201 + real vocab_cards row (hanja XOR leg),
 *     idempotent re-seed → 200 same card, unknown char → 404, user-scoped,
 *     soft-deleted card doesn't block a re-seed
 *   - GET /cards/due: joined display fields + version on the wire; excludes
 *     future / suspended / deleted / cross-user / non-hanja cards; and the
 *     vocab due queue excludes hanja cards (no double-present)
 *   - POST /cards/:cardId/reviews: real future due_at via the shared FSRS
 *     engine, card_reviews BEFORE/AFTER row logged, again → <1 min relearn,
 *     409 stale version writes nothing, 404 unknown / cross-user (IDOR) /
 *     non-hanja card, 400 bad rating / missing version / unknown key (strict)
 *   - migration 050 constraints through the applied chain: five-leg XOR
 *     rejects a two-target row; the partial unique rejects a duplicate live
 *     (user, character, face) card
 *
 * hanja_attempts (F-171, migration 059):
 *   - POST /cards/:cardId/reviews ALSO appends a hanja_attempts row in the
 *     SAME transaction: correct rating/char/card_id captured, correct=false
 *     only on 'again', a 409 (stale version) writes NEITHER card_reviews NOR
 *     hanja_attempts (whole-transaction rollback)
 *   - GET /attempts: user-scoped, newest-first, paged with `total` riding
 *     along on every row (COUNT(*) OVER ()), 401 unauthenticated
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
    ['POST', '/hanja/學/card'],
    ['GET', '/hanja/cards/due'],
    ['POST', '/hanja/cards/1/reviews'],
    ['GET', '/hanja/attempts'],
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

// ---------------------------------------------------------------------------
// FSRS cards (F-075, migration 050) — hanja rides the shared scheduler.
// ---------------------------------------------------------------------------

/** Seed a recognition card for `char` through the real endpoint. */
async function seedCardViaApi(
  agent: ReturnType<typeof request.agent>,
  char: string,
): Promise<{ cardId: number; version: number }> {
  const res = await agent.post(`/hanja/${char}/card`).send();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`seedCardViaApi failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { cardId: res.body.card_id as number, version: res.body.version as number };
}

describe('POST /hanja/:char/card — seed a recognition card (F-075)', () => {
  it('creates a real vocab_cards row on the hanja XOR leg (201)', async () => {
    const characterId = await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/hanja/學/card').send();
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.ch).toBe('學');
    expect(res.body.face).toBe('recognition');
    expect(res.body.character_id).toBe(characterId);
    expect(res.body.version).toBe(1);

    const row = await pg.pool.query(
      `SELECT user_id::int, face, hanja_character_id::int, vocab_entry_id,
              grammar_entry_id, fsrs_state, due_at
         FROM vocab_cards WHERE id = $1`,
      [res.body.card_id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].user_id).toBe(userId); // session user, never client-supplied
    expect(row.rows[0].face).toBe('recognition');
    expect(row.rows[0].hanja_character_id).toBe(characterId);
    expect(row.rows[0].vocab_entry_id).toBeNull(); // exactly ONE XOR leg set
    expect(row.rows[0].grammar_entry_id).toBeNull();
    expect(row.rows[0].fsrs_state).toBe('new');
    // A fresh card is immediately due (due_at defaults to now()).
    expect(new Date(row.rows[0].due_at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('is idempotent: re-seeding converges on the SAME card (200)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent } = await registerUser(t.app, pg.pool);

    const first = await agent.post('/hanja/學/card').send();
    expect(first.status).toBe(201);
    const second = await agent.post('/hanja/學/card').send();
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.card_id).toBe(first.body.card_id);

    const n = await pg.pool.query(`SELECT count(*)::int AS n FROM vocab_cards`);
    expect(n.rows[0].n).toBe(1); // one live card, not two
  });

  it('404s on a character that is not in the corpus', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/hanja/龜/card').send();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('rejects a multi-character param (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/hanja/學校/card').send();
    expect(res.status).toBe(400);
  });

  it('is user-scoped: two users get two distinct cards for the same character', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);

    const cardA = await seedCardViaApi(a.agent, '學');
    const cardB = await seedCardViaApi(b.agent, '學');
    expect(cardA.cardId).not.toBe(cardB.cardId);
  });

  it('a soft-deleted card does not block a fresh seed (partial unique)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent } = await registerUser(t.app, pg.pool);

    const first = await seedCardViaApi(agent, '學');
    await pg.pool.query(`UPDATE vocab_cards SET deleted_at = now() WHERE id = $1`, [
      first.cardId,
    ]);
    const res = await agent.post('/hanja/學/card').send();
    expect(res.status).toBe(201); // a NEW card — the dead one is out of the index
    expect(res.body.card_id).not.toBe(first.cardId);
  });
});

describe('GET /hanja/cards/due — the hanja due queue (F-075)', () => {
  it('serves a due card with the joined display fields + version', async () => {
    await seedHanjaCharacter(pg.pool, {
      char: '學',
      sound: '학',
      glossEn: 'learning, knowledge; school',
      strokes: 16,
      level: 'L3',
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId } = await seedCardViaApi(agent, '學');

    const res = await agent.get('/hanja/cards/due');
    expect(res.status).toBe(200);
    expect(res.body.cards.length).toBe(1);
    const c = res.body.cards[0];
    expect(c.id).toBe(cardId);
    expect(c.face).toBe('recognition');
    expect(c.ch).toBe('學');
    expect(c.sound).toBe('학');
    expect(c.en).toBe('learning, knowledge; school');
    expect(c.level).toBe('L3');
    expect(c.strokes).toBe(16);
    expect(c.fsrs_state).toBe('new');
    expect(c.version).toBe(1); // expected_version threading, mirrors vocab
    expect(typeof c.hanja_character_id).toBe('number');
  });

  it('excludes future-due, suspended, and soft-deleted cards', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    await seedHanjaCharacter(pg.pool, { char: '人' });
    await seedHanjaCharacter(pg.pool, { char: '水' });
    await seedHanjaCharacter(pg.pool, { char: '火' });
    const { agent } = await registerUser(t.app, pg.pool);
    const due = await seedCardViaApi(agent, '學');
    const future = await seedCardViaApi(agent, '人');
    const suspended = await seedCardViaApi(agent, '水');
    const deleted = await seedCardViaApi(agent, '火');
    await pg.pool.query(
      `UPDATE vocab_cards SET due_at = now() + interval '2 days' WHERE id = $1`,
      [future.cardId],
    );
    await pg.pool.query(`UPDATE vocab_cards SET suspended_at = now() WHERE id = $1`, [
      suspended.cardId,
    ]);
    await pg.pool.query(`UPDATE vocab_cards SET deleted_at = now() WHERE id = $1`, [
      deleted.cardId,
    ]);

    const res = await agent.get('/hanja/cards/due');
    expect(res.status).toBe(200);
    expect(res.body.cards.map((c: { id: number }) => c.id)).toEqual([due.cardId]);
  });

  it('is user-scoped: another user\'s due card never appears (IDOR)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const a = await registerUser(t.app, pg.pool);
    await seedCardViaApi(a.agent, '學');
    const b = await registerUser(t.app, pg.pool);

    const res = await b.agent.get('/hanja/cards/due');
    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual([]);
  });

  it('excludes non-hanja cards; and the vocab due queue excludes hanja cards', async () => {
    // The two queues partition the card space — no card is served twice.
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const hanja = await seedCardViaApi(agent, '學');
    const vocabCardId = await seedVocabCard(pg.pool, userId); // due 1 min ago

    const hanjaDue = await agent.get('/hanja/cards/due');
    expect(hanjaDue.body.cards.map((c: { id: number }) => c.id)).toEqual([hanja.cardId]);

    const vocabDue = await agent.get('/vocab/cards/due');
    expect(vocabDue.status).toBe(200);
    const vocabIds = vocabDue.body.cards.map((c: { id: number }) => c.id);
    expect(vocabIds).toContain(vocabCardId);
    expect(vocabIds).not.toContain(hanja.cardId);
  });

  it('rejects a bogus limit (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/hanja/cards/due').query({ limit: 'lots' });
    expect(res.status).toBe(400);
  });
});

describe('POST /hanja/cards/:cardId/reviews — shared FSRS engine (F-075)', () => {
  it('good on a new card → learning, stability 1, due ~1 day out, card_reviews logged', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await seedCardViaApi(agent, '學');
    const before = Date.now();

    const res = await agent.post(`/hanja/cards/${cardId}/reviews`).send({
      rating: 'good',
      duration_ms: 4200,
      expected_version: version,
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);
    expect(res.body.scheduled_days).toBe(1); // BASE_STABILITY.good (B-021: 1d graduation) — server-computed
    // A REAL future due_at (> half a day out), not the "due immediately" stub bug.
    expect(new Date(res.body.due_at as string).getTime()).toBeGreaterThan(
      before + 0.5 * 86_400_000,
    );

    // The card advanced through the SAME storage shape as every other family.
    const card = await pg.pool.query(
      `SELECT fsrs_state, stability::float8 AS stability, reps, lapses, version
         FROM vocab_cards WHERE id = $1`,
      [cardId],
    );
    expect(card.rows[0].fsrs_state).toBe('learning');
    expect(card.rows[0].stability).toBe(1);
    expect(card.rows[0].reps).toBe(1);
    expect(card.rows[0].lapses).toBe(0);
    expect(card.rows[0].version).toBe(2);

    // Append-only card_reviews row: BEFORE from the DB row, AFTER from the engine.
    const log = await pg.pool.query(
      `SELECT user_id::int, rating, state_before, stability_before::float8 AS sb,
              state_after, stability_after::float8 AS sa,
              elapsed_days_before, scheduled_days_after, duration_ms
         FROM card_reviews WHERE card_id = $1`,
      [cardId],
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].user_id).toBe(userId);
    expect(log.rows[0].rating).toBe('good');
    expect(log.rows[0].state_before).toBe('new');
    expect(log.rows[0].sb).toBe(0);
    expect(log.rows[0].state_after).toBe('learning');
    expect(log.rows[0].sa).toBe(1);
    expect(log.rows[0].elapsed_days_before).toBe(-1); // never-reviewed sentinel
    expect(log.rows[0].scheduled_days_after).toBe(1);
    expect(log.rows[0].duration_ms).toBe(4200);

    // F-171: the SAME transaction ALSO appended a hanja_attempts row.
    const attempt = await pg.pool.query(
      `SELECT user_id::int, card_id::int, char, rating, correct
         FROM hanja_attempts WHERE card_id = $1`,
      [cardId],
    );
    expect(attempt.rowCount).toBe(1);
    expect(attempt.rows[0].user_id).toBe(userId);
    expect(attempt.rows[0].card_id).toBe(cardId);
    expect(attempt.rows[0].char).toBe('學');
    expect(attempt.rows[0].rating).toBe('good');
    expect(attempt.rows[0].correct).toBe(true); // good ≠ 'again'
  });

  it('again → relearning, <1-minute re-queue (never due-now)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await seedCardViaApi(agent, '學');
    const before = Date.now();

    const res = await agent.post(`/hanja/cards/${cardId}/reviews`).send({
      rating: 'again',
      expected_version: version,
    });
    expect(res.status).toBe(200);
    expect(res.body.scheduled_days).toBe(0);
    const dueAt = new Date(res.body.due_at as string).getTime();
    // B-021: the again re-queue is <1 minute (the UI's `<1m` label), not 10 min.
    expect(dueAt).toBeGreaterThan(before);
    expect(dueAt).toBeLessThan(before + 60_000);

    const card = await pg.pool.query(
      `SELECT fsrs_state, lapses FROM vocab_cards WHERE id = $1`,
      [cardId],
    );
    expect(card.rows[0].fsrs_state).toBe('relearning');
    expect(card.rows[0].lapses).toBe(1);

    // F-171: 'again' logs correct=false — the derived-outcome rule.
    const attempt = await pg.pool.query(
      `SELECT rating, correct FROM hanja_attempts WHERE card_id = $1`,
      [cardId],
    );
    expect(attempt.rowCount).toBe(1);
    expect(attempt.rows[0].rating).toBe('again');
    expect(attempt.rows[0].correct).toBe(false);
  });

  it('stale expected_version → 409, and nothing is written', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId } = await seedCardViaApi(agent, '學');

    const res = await agent.post(`/hanja/cards/${cardId}/reviews`).send({
      rating: 'good',
      expected_version: 999,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toMatch(/stale/i);
    // The whole tx rolled back: no card advance, no review log row.
    const log = await pg.pool.query(`SELECT 1 FROM card_reviews WHERE card_id = $1`, [cardId]);
    expect(log.rowCount).toBe(0);
    const card = await pg.pool.query(`SELECT version FROM vocab_cards WHERE id = $1`, [cardId]);
    expect(card.rows[0].version).toBe(1);
    // F-171: the attempt-log insert is in the SAME transaction — a 409 must
    // not leave a hanja_attempts row for a review that never actually applied.
    const attempt = await pg.pool.query(`SELECT 1 FROM hanja_attempts WHERE card_id = $1`, [
      cardId,
    ]);
    expect(attempt.rowCount).toBe(0);
  });

  it('unknown card → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/hanja/cards/999999/reviews').send({
      rating: 'good',
      expected_version: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('cross-user card → 404 (IDOR: no existence leak, no cross-user advance)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const a = await registerUser(t.app, pg.pool);
    const { cardId } = await seedCardViaApi(a.agent, '學');
    const b = await registerUser(t.app, pg.pool);

    const res = await b.agent.post(`/hanja/cards/${cardId}/reviews`).send({
      rating: 'good',
      expected_version: 1,
    });
    expect(res.status).toBe(404);
    // A's card is untouched.
    const card = await pg.pool.query(`SELECT version FROM vocab_cards WHERE id = $1`, [cardId]);
    expect(card.rows[0].version).toBe(1);
  });

  it('a NON-hanja card 404s on this route (no side door across families)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const vocabCardId = await seedVocabCard(pg.pool, userId);

    const res = await agent.post(`/hanja/cards/${vocabCardId}/reviews`).send({
      rating: 'good',
      expected_version: 1,
    });
    expect(res.status).toBe(404);
  });

  it('invalid rating → 400; missing expected_version → 400; unknown key → 400 (strict)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bad = await agent.post('/hanja/cards/1/reviews').send({
      rating: 'super-easy',
      expected_version: 1,
    });
    expect(bad.status).toBe(400);

    const missing = await agent.post('/hanja/cards/1/reviews').send({ rating: 'good' });
    expect(missing.status).toBe(400);

    const extra = await agent.post('/hanja/cards/1/reviews').send({
      rating: 'good',
      expected_version: 1,
      scheduled_days_after: 0, // tamper probe — strict schema rejects
    });
    expect(extra.status).toBe(400);
  });
});

describe('migration 050 constraints (through the applied chain)', () => {
  it('the five-leg XOR rejects a card with two targets', async () => {
    const characterId = await seedHanjaCharacter(pg.pool, { char: '學' });
    const { userId } = await registerUser(t.app, pg.pool);
    const entryId = await seedVocabEntry(pg.pool);

    await expect(
      pg.pool.query(
        `INSERT INTO vocab_cards (user_id, face, vocab_entry_id, hanja_character_id)
         VALUES ($1, 'recognition'::card_face, $2, $3)`,
        [userId, entryId, characterId],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_vocab_cards_target_xor' });
  });

  it('the partial unique rejects a duplicate live (user, character, face) card', async () => {
    const characterId = await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedCardViaApi(agent, '學');

    await expect(
      pg.pool.query(
        `INSERT INTO vocab_cards (user_id, face, hanja_character_id)
         VALUES ($1, 'recognition'::card_face, $2)`,
        [userId, characterId],
      ),
    ).rejects.toMatchObject({ constraint: 'uq_vocab_cards_user_hanja_face' });
  });
});

describe('GET /hanja/attempts — hanja-attempt history (F-171)', () => {
  it('returns this user\'s attempts newest-first with the DTO fields', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    await seedHanjaCharacter(pg.pool, { char: '人' });
    const { agent } = await registerUser(t.app, pg.pool);
    const first = await seedCardViaApi(agent, '學');
    const second = await seedCardViaApi(agent, '人');

    await agent.post(`/hanja/cards/${first.cardId}/reviews`).send({
      rating: 'good',
      expected_version: first.version,
    });
    await agent.post(`/hanja/cards/${second.cardId}/reviews`).send({
      rating: 'again',
      expected_version: second.version,
    });
    // Force a deterministic ordering independent of real-clock granularity —
    // mirrors this file's own `UPDATE ... due_at`/`suspended_at` idiom.
    await pg.pool.query(
      `UPDATE hanja_attempts SET created_at = now() - interval '1 hour' WHERE char = '學'`,
    );

    const res = await agent.get('/hanja/attempts');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(0);
    expect(res.body.attempts).toHaveLength(2);

    // Newest first: 人 (again) before 學 (good, backdated).
    const [newest, oldest] = res.body.attempts;
    expect(newest.char).toBe('人');
    expect(newest.rating).toBe('again');
    expect(newest.correct).toBe(false);
    expect(typeof newest.id).toBe('number');
    expect(newest.cardId).toBe(second.cardId);
    expect(oldest.char).toBe('學');
    expect(oldest.rating).toBe('good');
    expect(oldest.correct).toBe(true);
    expect(oldest.cardId).toBe(first.cardId);
  });

  it('is user-scoped: another user\'s attempts never appear (IDOR)', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const a = await registerUser(t.app, pg.pool);
    const { cardId, version } = await seedCardViaApi(a.agent, '學');
    await a.agent.post(`/hanja/cards/${cardId}/reviews`).send({
      rating: 'good',
      expected_version: version,
    });

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.get('/hanja/attempts');
    expect(res.status).toBe(200);
    expect(res.body.attempts).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('pages with limit/offset while `total` reflects the FULL count', async () => {
    await seedHanjaCharacter(pg.pool, { char: '學' });
    const { agent } = await registerUser(t.app, pg.pool);
    // Three reviews of the SAME live card (seedCardViaApi is idempotent —
    // each call returns the one live card) → three hanja_attempts rows, one
    // per rating, each carrying the next `version` the previous rating left.
    const ratings: Array<'good' | 'again' | 'hard'> = ['good', 'again', 'hard'];
    for (const rating of ratings) {
      const { cardId, version } = await seedCardViaApi(agent, '學');
      await agent.post(`/hanja/cards/${cardId}/reviews`).send({
        rating,
        expected_version: version,
      });
    }

    const page1 = await agent.get('/hanja/attempts').query({ limit: 2, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.attempts).toHaveLength(2);
    expect(page1.body.total).toBe(3);

    const page2 = await agent.get('/hanja/attempts').query({ limit: 2, offset: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.attempts).toHaveLength(1);
    expect(page2.body.total).toBe(3);
  });

  it('returns an empty page (never an error) for a user with no attempts', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/hanja/attempts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attempts: [], total: 0, limit: 20, offset: 0 });
  });

  it('rejects a bogus limit (400)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/hanja/attempts').query({ limit: 'lots' });
    expect(res.status).toBe(400);
  });
});
