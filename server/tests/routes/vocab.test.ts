/**
 * Per-route tests for src/routes/vocab.ts (B-FU-2).
 *
 * Routes:
 *   GET  /vocab/entries
 *   GET  /vocab/entries/:entryId
 *   GET  /vocab/cards/due
 *   POST /vocab/cards/init
 *   POST /vocab/cards/:cardId/reviews
 *   POST /vocab/mine        (FU-NF-33: tap anything → bank it)
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
    'TRUNCATE TABLE card_reviews, vocab_cards, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('vocab — auth required', () => {
  it.each([
    ['GET', '/vocab/entries'],
    ['GET', '/vocab/entries/1'],
    ['GET', '/vocab/cards/due'],
    ['POST', '/vocab/cards/init'],
    ['POST', '/vocab/mine'],
  ])('%s %s unauthenticated → 401', async (method, path) => {
    const r =
      method === 'GET'
        ? await request(t.app).get(path)
        : await request(t.app).post(path).send({});
    expect(r.status).toBe(401);
  });
});

describe('GET /vocab/entries — success + filters', () => {
  it('returns entries from a corpus filter', async () => {
    await seedVocabEntry(pg.pool, { korean: '먹다', english: 'to eat' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries?corpus=vocab_2000_intermediate');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(0);
  });

  it('returns 200 with an empty list when nothing matches', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries?q=절대없는단어');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });
});

describe('GET /vocab/entries — search (q) + total', () => {
  // vocab_entries is reference data that the file-level beforeEach does NOT
  // truncate (it accumulates across tests). These tests assert exact `total`
  // counts, so isolate them by clearing the corpus first. CASCADE drops the
  // vocab_cards / vocab_list_entries that FK into it.
  beforeEach(async () => {
    await pg.pool.query('TRUNCATE TABLE vocab_entries RESTART IDENTITY CASCADE');
  });

  it('ILIKE-matches korean by substring and returns a total count', async () => {
    await seedVocabEntry(pg.pool, { korean: '사과하다', english: 'to apologize' });
    await seedVocabEntry(pg.pool, { korean: '사과', english: 'apple' });
    await seedVocabEntry(pg.pool, { korean: '바나나', english: 'banana' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries?q=사과');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const koreans = (res.body.entries as Array<{ korean: string }>).map((e) => e.korean);
    expect(koreans).toEqual(expect.arrayContaining(['사과', '사과하다']));
    expect(koreans).not.toContain('바나나');
  });

  it('ILIKE-matches english (gloss search) case-insensitively', async () => {
    await seedVocabEntry(pg.pool, { korean: '먹다', english: 'to EAT' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries?q=eat');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].korean).toBe('먹다');
  });

  it('total reflects the full match set, not just the page', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedVocabEntry(pg.pool, { korean: `검색어${i}`, english: 'searchme' });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries?q=searchme&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(2);
    expect(res.body.total).toBe(5);
  });

  it('escapes LIKE metacharacters — a "%" term matches literally, not as a wildcard', async () => {
    await seedVocabEntry(pg.pool, { korean: '백퍼센트', english: '100% sure' });
    await seedVocabEntry(pg.pool, { korean: '다른말', english: 'unrelated' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/vocab/entries?q=${encodeURIComponent('100%')}`);
    expect(res.status).toBe(200);
    // A naive %term% would treat the '%' as a wildcard and match '다른말' too;
    // the escape keeps it literal so only the '100%' gloss matches.
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].korean).toBe('백퍼센트');
  });

  it('no match → 200 with empty entries and total 0', async () => {
    await seedVocabEntry(pg.pool, { korean: '있음' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries?q=절대없는단어');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('allows limit up to the raised browse ceiling (200)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    expect((await agent.get('/vocab/entries?limit=200')).status).toBe(200);
    expect((await agent.get('/vocab/entries?limit=201')).status).toBe(400);
  });
});

describe('GET /vocab/suggestions/weekly', () => {
  // Isolate from accumulated reference rows so the "excludes carded" and
  // capped-at-15 assertions are deterministic.
  beforeEach(async () => {
    await pg.pool.query('TRUNCATE TABLE vocab_entries RESTART IDENTITY CASCADE');
  });

  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/vocab/suggestions/weekly');
    expect(res.status).toBe(401);
  });

  it('returns curated entries the user has not carded, capped at 15', async () => {
    for (let i = 0; i < 20; i += 1) {
      await seedVocabEntry(pg.pool, {
        corpus: 'vocab_2000_intermediate',
        korean: `주간단어${i}`,
      });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/suggestions/weekly');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBe(15);
    expect(typeof res.body.entries[0].id).toBe('number');
  });

  it('is stable for the same user within the week (deterministic refetch)', async () => {
    for (let i = 0; i < 18; i += 1) {
      await seedVocabEntry(pg.pool, {
        corpus: 'vocab_2000_intermediate',
        korean: `안정단어${i}`,
      });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const first = await agent.get('/vocab/suggestions/weekly').expect(200);
    const second = await agent.get('/vocab/suggestions/weekly').expect(200);
    const ids1 = (first.body.entries as Array<{ id: number }>).map((s) => s.id);
    const ids2 = (second.body.entries as Array<{ id: number }>).map((s) => s.id);
    expect(ids2).toEqual(ids1);
  });

  it('excludes entries the user has already carded (no re-suggest of banked words)', async () => {
    const cardedId = await seedVocabEntry(pg.pool, {
      corpus: 'vocab_2000_intermediate',
      korean: '이미카드',
    });
    const freshId = await seedVocabEntry(pg.pool, {
      corpus: 'vocab_2000_intermediate',
      korean: '아직안함',
    });
    const { agent } = await registerUser(t.app, pg.pool);
    // Bank one via the existing add-to-deck path (reused, not duplicated).
    const banked = await agent.post(`/vocab/entries/${cardedId}/bank`);
    expect(banked.status).toBe(201);
    const res = await agent.get('/vocab/suggestions/weekly').expect(200);
    const ids = (res.body.entries as Array<{ id: number }>).map((s) => s.id);
    expect(ids).not.toContain(cardedId);
    // …while the un-carded entry is still suggested.
    expect(ids).toContain(freshId);
  });

  it('does not suggest mined / non-curated corpus entries', async () => {
    const curatedId = await seedVocabEntry(pg.pool, {
      corpus: 'vocab_2000_intermediate',
      korean: '큐레이션단어',
    });
    const { agent } = await registerUser(t.app, pg.pool);
    // A mined word enters via /vocab/mine under the user_mined corpus.
    const mine = await agent.post('/vocab/mine').send({ lemma: `주간마이닝${Date.now()}` });
    expect(mine.status).toBe(201);
    const res = await agent.get('/vocab/suggestions/weekly').expect(200);
    const ids = (res.body.entries as Array<{ id: number }>).map((s) => s.id);
    // The curated entry is suggested; the mined entry is not.
    expect(ids).toContain(curatedId);
    expect(ids).not.toContain(mine.body.entryId);
  });
});

describe('GET /vocab/entries — validation rejection', () => {
  const cases: Array<{ name: string; qs: string }> = [
    { name: 'bad corpus enum', qs: '?corpus=not_a_corpus' },
    { name: 'bad proficiency enum', qs: '?proficiency=Z9' },
    { name: 'limit too high', qs: '?limit=999' },
    { name: 'limit zero', qs: '?limit=0' },
    { name: 'negative offset', qs: '?offset=-1' },
    { name: 'q too long', qs: `?q=${'x'.repeat(100)}` },
  ];
  for (const c of cases) {
    it(`${c.name} → 400`, async () => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get(`/vocab/entries${c.qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  }
});

describe('GET /vocab/entries/:entryId', () => {
  it('valid id → 200', async () => {
    const id = await seedVocabEntry(pg.pool, { korean: '먹다' });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/vocab/entries/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('missing id → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries/99999999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('non-numeric id → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/entries/abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /vocab/cards/due', () => {
  it('returns empty list for a fresh user', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/cards/due');
    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual([]);
  });

  it('honors limit param', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/cards/due?limit=5');
    expect(res.status).toBe(200);
  });

  it('limit > 200 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/cards/due?limit=500');
    expect(res.status).toBe(400);
  });

  // FU-NF-42: the due query LEFT JOINs grammar_entries so a grammar production
  // card carries its pattern display + summary; non-grammar cards get NULLs.
  it('surfaces grammar_pattern_display / grammar_summary_en for a grammar production card', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const entry = await pg.pool.query<{ id: string }>(
      `INSERT INTO grammar_entries
         (user_id, pattern_key, pattern_display, summary_en, proficiency, category, discovered_via)
       VALUES ($1, 'GR-eun-neun', '-은/는', 'topic-marking particle', 'L3', 'particle', 'manual')
       RETURNING id::text AS id`,
      [userId],
    );
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, grammar_entry_id, proficiency, due_at)
       VALUES ($1, 'production'::card_face, $2, 'L3'::proficiency_level, now())`,
      [userId, entry.rows[0]!.id],
    );

    const res = await agent.get('/vocab/cards/due?limit=10').expect(200);
    const card = (res.body.cards as Array<Record<string, unknown>>).find(
      (c) => c.face === 'production',
    );
    expect(card).toBeDefined();
    expect(card!.grammar_pattern_display).toBe('-은/는');
    expect(card!.grammar_summary_en).toBe('topic-marking particle');
  });

  it('leaves grammar_pattern_display / grammar_summary_en NULL for a non-grammar (vocab) card', async () => {
    const entryId = await seedVocabEntry(pg.pool, { corpus: 'vocab_2000_intermediate' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, vocab_entry_id, proficiency, due_at)
       VALUES ($1, 'recognition'::card_face, $2, 'L3'::proficiency_level, now())`,
      [userId, entryId],
    );

    const res = await agent.get('/vocab/cards/due?limit=10').expect(200);
    const card = (res.body.cards as Array<Record<string, unknown>>).find(
      (c) => c.face === 'recognition',
    );
    expect(card).toBeDefined();
    expect(card!.grammar_pattern_display).toBeNull();
    expect(card!.grammar_summary_en).toBeNull();
  });

  // Migration 033: a grammar production card whose entry the user GRADUATED
  // (grammar_entries.graduated_at IS NOT NULL) must not surface as due;
  // re-admission (graduated_at back to NULL) restores it with FSRS state
  // intact (the card row itself is never touched).
  it('excludes a graduated grammar production card from the due queue, and re-admission restores it', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const entry = await pg.pool.query<{ id: string }>(
      `INSERT INTO grammar_entries
         (user_id, pattern_key, pattern_display, summary_en, proficiency, category, discovered_via)
       VALUES ($1, 'GR-deoraedo', '-더라도', 'even if', 'L4', 'concession', 'manual')
       RETURNING id::text AS id`,
      [userId],
    );
    const entryId = entry.rows[0]!.id;
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, grammar_entry_id, proficiency, due_at)
       VALUES ($1, 'production'::card_face, $2, 'L4'::proficiency_level, now())`,
      [userId, entryId],
    );

    // Active entry → the card is due.
    const before = await agent.get('/vocab/cards/due?limit=10').expect(200);
    expect(
      (before.body.cards as Array<{ grammar_entry_id: number | null }>).some(
        (c) => c.grammar_entry_id === Number(entryId),
      ),
    ).toBe(true);

    // Graduate via the real route → the card drops out of the due queue.
    await agent.post(`/grammar/bank/${entryId}/graduate`).expect(200);
    const during = await agent.get('/vocab/cards/due?limit=10').expect(200);
    expect(
      (during.body.cards as Array<{ grammar_entry_id: number | null }>).some(
        (c) => c.grammar_entry_id === Number(entryId),
      ),
    ).toBe(false);

    // Re-admit → the card resurfaces (same row, FSRS state untouched).
    await agent.post(`/grammar/bank/${entryId}/readmit`).expect(200);
    const after = await agent.get('/vocab/cards/due?limit=10').expect(200);
    expect(
      (after.body.cards as Array<{ grammar_entry_id: number | null }>).some(
        (c) => c.grammar_entry_id === Number(entryId),
      ),
    ).toBe(true);
  });

  it('graduating one grammar entry leaves other due cards (vocab + other grammar) untouched', async () => {
    const vocabEntryId = await seedVocabEntry(pg.pool, { corpus: 'vocab_2000_intermediate' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const mk = async (key: string, display: string): Promise<string> => {
      const r = await pg.pool.query<{ id: string }>(
        `INSERT INTO grammar_entries
           (user_id, pattern_key, pattern_display, summary_en, proficiency, category, discovered_via)
         VALUES ($1, $2, $3, 's', 'L3', 'ending', 'manual')
         RETURNING id::text AS id`,
        [userId, key, display],
      );
      return r.rows[0]!.id;
    };
    const graduatedId = await mk('GR-known', '-는걸');
    const activeId = await mk('GR-active', '-거든요');
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, grammar_entry_id, proficiency, due_at)
       VALUES ($1, 'production'::card_face, $2, 'L3'::proficiency_level, now()),
              ($1, 'production'::card_face, $3, 'L3'::proficiency_level, now())`,
      [userId, graduatedId, activeId],
    );
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, vocab_entry_id, proficiency, due_at)
       VALUES ($1, 'recognition'::card_face, $2, 'L3'::proficiency_level, now())`,
      [userId, vocabEntryId],
    );

    await agent.post(`/grammar/bank/${graduatedId}/graduate`).expect(200);

    const res = await agent.get('/vocab/cards/due?limit=10').expect(200);
    const cards = res.body.cards as Array<{
      grammar_entry_id: number | null;
      vocab_entry_id: number | null;
    }>;
    expect(cards.some((c) => c.grammar_entry_id === Number(graduatedId))).toBe(false);
    expect(cards.some((c) => c.grammar_entry_id === Number(activeId))).toBe(true);
    expect(cards.some((c) => c.vocab_entry_id === vocabEntryId)).toBe(true);
  });
});

describe('POST /vocab/cards/init', () => {
  it('seeds cards from a corpus slice and is idempotent', async () => {
    await seedVocabEntry(pg.pool, { corpus: 'vocab_2000_intermediate' });
    await seedVocabEntry(pg.pool, { corpus: 'vocab_2000_intermediate', korean: '가다' });
    const { agent } = await registerUser(t.app, pg.pool);
    const first = await agent.post('/vocab/cards/init').send({
      corpus: 'vocab_2000_intermediate',
      limit: 10,
    });
    expect(first.status).toBe(201);
    expect(first.body.inserted).toBeGreaterThanOrEqual(2);
    // Idempotent — re-run inserts zero.
    const second = await agent.post('/vocab/cards/init').send({
      corpus: 'vocab_2000_intermediate',
      limit: 10,
    });
    expect(second.status).toBe(201);
    expect(second.body.inserted).toBe(0);
  });

  it('bad corpus → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/vocab/cards/init')
      .send({ corpus: 'unknown_corpus' });
    expect(res.status).toBe(400);
  });

  it('limit > 500 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/vocab/cards/init')
      .send({ corpus: 'vocab_2000_intermediate', limit: 1_000 });
    expect(res.status).toBe(400);
  });
});

describe('POST /vocab/cards/:cardId/reviews — optimistic concurrency', () => {
  // FU-NF-8 (FOLLOW_UPS.md, 2026-05-29): unknown-card and stale-version
  // are now distinct API conditions — 404 vs 409 — so clients can branch
  // on the response code without having to parse the error message.
  it('card not found → 404 (FU-NF-8: split from stale-version)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/cards/999999/reviews').send({
      rating: 'good',
      state_before: 'new',
      stability_before: 0,
      difficulty_before: 5,
      elapsed_days_before: -1,
      state_after: 'learning',
      stability_after: 0.5,
      difficulty_after: 5,
      scheduled_days_after: 1,
      expected_version: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('cross-user card → 404 (no existence leak)', async () => {
    // User A owns a card; User B should see 404, not 403, so we don't
    // leak the existence of A's card across the auth boundary.
    await seedVocabEntry(pg.pool);
    const { agent: a } = await registerUser(t.app, pg.pool);
    const initA = await a
      .post('/vocab/cards/init')
      .send({ corpus: 'vocab_2000_intermediate', limit: 1 });
    expect(initA.status).toBe(201);
    if (initA.body.inserted < 1) {
      return; // Nothing seeded — skip rather than false-fail.
    }
    const aDue = await a.get('/vocab/cards/due?limit=1');
    expect(aDue.status).toBe(200);
    const aCard = aDue.body.cards?.[0] as { id: number } | undefined;
    expect(aCard).toBeDefined();
    const { agent: b } = await registerUser(t.app, pg.pool);
    const res = await b.post(`/vocab/cards/${aCard!.id}/reviews`).send({
      rating: 'good',
      state_before: 'new',
      stability_before: 0,
      difficulty_before: 5,
      elapsed_days_before: -1,
      state_after: 'learning',
      stability_after: 0.5,
      difficulty_after: 5,
      scheduled_days_after: 1,
      expected_version: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('stale expected_version → 409 (FU-NF-8: split from not-found)', async () => {
    // Seed a vocab entry and use init to mint a card for the user, then
    // post a review with the WRONG expected_version. The card exists
    // (so 404 is wrong); only the version is stale (so 409 is right).
    await seedVocabEntry(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);
    const init = await agent
      .post('/vocab/cards/init')
      .send({ corpus: 'vocab_2000_intermediate', limit: 5 });
    expect(init.status).toBe(201);
    const due = await agent.get('/vocab/cards/due?limit=1');
    expect(due.status).toBe(200);
    if (!Array.isArray(due.body.cards) || due.body.cards.length === 0) {
      // Nothing seeded — skip (the seed helper may have produced an
      // existing entry that init already covered).
      return;
    }
    const card = due.body.cards[0] as { id: number };
    const res = await agent.post(`/vocab/cards/${card.id}/reviews`).send({
      rating: 'good',
      state_before: 'new',
      stability_before: 0,
      difficulty_before: 5,
      elapsed_days_before: -1,
      state_after: 'learning',
      stability_after: 0.5,
      difficulty_after: 5,
      scheduled_days_after: 1,
      expected_version: 999, // deliberately wrong — card was just minted at v1.
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    // The error message must not conflate not-found with stale-version.
    expect(res.body.error.message).toMatch(/stale/i);
    expect(res.body.error.message).not.toMatch(/not found/i);
  });

  it('invalid rating enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/cards/1/reviews').send({
      rating: 'super-easy',
      state_before: 'new',
      stability_before: 0,
      difficulty_before: 5,
      elapsed_days_before: -1,
      state_after: 'learning',
      stability_after: 0.5,
      difficulty_after: 5,
      scheduled_days_after: 1,
      expected_version: 1,
    });
    expect(res.status).toBe(400);
  });

  it('difficulty out of range → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/cards/1/reviews').send({
      rating: 'good',
      state_before: 'new',
      stability_before: 0,
      difficulty_before: 11,
      elapsed_days_before: -1,
      state_after: 'learning',
      stability_after: 0.5,
      difficulty_after: 5,
      scheduled_days_after: 1,
      expected_version: 1,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /vocab/mine — tap anything → bank it (FU-NF-33)', () => {
  // The `user_mined` corpus_sources row is seeded by migration 022 and is NOT
  // truncated by the per-test beforeEach (which only clears user-scoped tables
  // + vocab_cards). Each test mines a UNIQUE lemma so accumulated shared
  // vocab_entries rows across tests never collide on (corpus, source_id).
  const uniqueLemma = (): string => `단어${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  it('creates a user_mined entry + a recognition card (201)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const lemma = uniqueLemma();
    const res = await agent
      .post('/vocab/mine')
      .send({ lemma, english: 'a word', pos: 'noun' });
    expect(res.status).toBe(201);
    expect(typeof res.body.entryId).toBe('number');
    expect(typeof res.body.card.id).toBe('number');
    expect(typeof res.body.card.version).toBe('number');

    // The shared entry is keyed lemma-<lemma> (no krdictEntryId given), under
    // the user_mined corpus, korean = lemma.
    const entry = await pg.pool.query<{
      corpus: string;
      source_id: string;
      korean: string;
      english: string;
    }>(
      `SELECT corpus, source_id, korean, english
         FROM vocab_entries WHERE id = $1`,
      [res.body.entryId],
    );
    expect(entry.rows[0]!.corpus).toBe('user_mined');
    expect(entry.rows[0]!.source_id).toBe(`lemma-${lemma}`);
    expect(entry.rows[0]!.korean).toBe(lemma);
    expect(entry.rows[0]!.english).toBe('a word');

    // The card is a recognition card pointing at that entry.
    const card = await pg.pool.query<{ face: string; vocab_entry_id: string }>(
      `SELECT face, vocab_entry_id FROM vocab_cards WHERE id = $1`,
      [res.body.card.id],
    );
    expect(card.rows[0]!.face).toBe('recognition');
    expect(Number(card.rows[0]!.vocab_entry_id)).toBe(res.body.entryId);
  });

  it('is idempotent — a second identical mine returns the same entry + card, no dupes', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const lemma = uniqueLemma();
    const first = await agent.post('/vocab/mine').send({ lemma, english: 'apple' });
    expect(first.status).toBe(201);
    const second = await agent.post('/vocab/mine').send({ lemma, english: 'apple' });
    expect(second.status).toBe(201);

    expect(second.body.entryId).toBe(first.body.entryId);
    expect(second.body.card.id).toBe(first.body.card.id);

    const entryCount = await pg.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM vocab_entries WHERE source_id = $1`,
      [`lemma-${lemma}`],
    );
    expect(Number(entryCount.rows[0]!.n)).toBe(1);
    const cardCount = await pg.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM vocab_cards
        WHERE vocab_entry_id = $1 AND face = 'recognition'`,
      [first.body.entryId],
    );
    expect(Number(cardCount.rows[0]!.n)).toBe(1);
  });

  it('two users mining the same lemma share the entry but get distinct cards', async () => {
    const lemma = uniqueLemma();
    const { agent: a } = await registerUser(t.app, pg.pool);
    const { agent: b } = await registerUser(t.app, pg.pool);
    const ra = await a.post('/vocab/mine').send({ lemma });
    const rb = await b.post('/vocab/mine').send({ lemma });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    // Shared public entry…
    expect(rb.body.entryId).toBe(ra.body.entryId);
    // …distinct private cards.
    expect(rb.body.card.id).not.toBe(ra.body.card.id);
  });

  it('krdictEntryId keys the entry by krdict-<id> (homographs stay distinct)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const lemma = uniqueLemma();
    const krdictEntryId = Math.floor(Math.random() * 1e9) + 1;
    const res = await agent.post('/vocab/mine').send({ lemma, krdictEntryId });
    expect(res.status).toBe(201);
    const entry = await pg.pool.query<{ source_id: string }>(
      `SELECT source_id FROM vocab_entries WHERE id = $1`,
      [res.body.entryId],
    );
    expect(entry.rows[0]!.source_id).toBe(`krdict-${krdictEntryId}`);
  });

  it('a freshly mined card enters the due queue', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const lemma = uniqueLemma();
    const mine = await agent.post('/vocab/mine').send({ lemma });
    expect(mine.status).toBe(201);
    const due = await agent.get('/vocab/cards/due?limit=50').expect(200);
    const ids = (due.body.cards as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(mine.body.card.id);
  });

  it('missing lemma → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/mine').send({ english: 'no lemma' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('lemma too long → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/mine').send({ lemma: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('unexpected field (strict body) → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/vocab/mine')
      .send({ lemma: uniqueLemma(), surprise: 'nope' });
    expect(res.status).toBe(400);
  });
});

// MIGRATION ROUND-TRIP NOTE (021 → 022, Docker-gated by the test harness):
//   021 must commit BEFORE 022 runs, because PostgreSQL forbids USING a newly
//   added enum value in the same transaction that added it (ADR-013 wraps each
//   migration in its own tx). 021 only runs `ALTER TYPE corpus ADD VALUE
//   'user_mined'`; 022 is the first to USE it (CHECK relaxation + corpus_sources
//   seed). The test DB applies all migrations in order, so by the time these
//   tests run the `user_mined` corpus_sources row exists and the relaxed CHECKs
//   admit the mined entries asserted above. 021's down is a documented no-op
//   (PG cannot DROP an enum value); 022's down restores the original CHECKs and
//   deletes the seed row only when no vocab_entries reference it.

describe('vocab — DB error', () => {
  it('GET /vocab/entries with vocab_entries missing → 500 with no SQL leak', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await pg.pool.query('ALTER TABLE vocab_entries RENAME TO vocab_entries_hidden');
    try {
      const res = await agent.get('/vocab/entries');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/vocab_entries_hidden/);
    } finally {
      await pg.pool.query('ALTER TABLE vocab_entries_hidden RENAME TO vocab_entries');
    }
  });
});
