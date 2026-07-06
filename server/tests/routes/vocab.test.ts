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
import {
  registerUser,
  seedTopikItem,
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
    ['GET', '/vocab/mastery'],
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

describe('GET /vocab/entries — domain + book_level filters (F-003)', () => {
  // vocab_entries is reference data the file-level beforeEach does NOT
  // truncate; these tests assert exact totals, so isolate the corpus.
  beforeEach(async () => {
    await pg.pool.query('TRUNCATE TABLE vocab_entries RESTART IDENTITY CASCADE');
  });

  it('domain filter narrows to matching rows only', async () => {
    await seedVocabEntry(pg.pool, { korean: '사과', english: 'apple' });
    const researchId = await seedVocabEntry(pg.pool, {
      korean: '가설',
      english: 'hypothesis',
    });
    // The seed helper leaves the column at its 'general' default; retag one
    // row so the filter has something to select.
    await pg.pool.query(
      `UPDATE vocab_entries SET domain = 'research'::content_domain WHERE id = $1`,
      [researchId],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/vocab/entries?domain=research');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].korean).toBe('가설');

    // Unfiltered still returns both — the param narrows, never re-shapes.
    const all = await agent.get('/vocab/entries').expect(200);
    expect(all.body.total).toBe(2);
  });

  it('book_level filter narrows to the matching band', async () => {
    await seedVocabEntry(pg.pool, { korean: '중급단어' });
    const beginnerId = await seedVocabEntry(pg.pool, { korean: '초급단어' });
    // Flip one row to the beginner band. corpus + book_level move together to
    // satisfy ck_vocab_entries_level_matches_corpus.
    await pg.pool.query(
      `UPDATE vocab_entries
          SET corpus = 'vocab_2000_beginner'::corpus,
              book_level = 'beginner'::book_level
        WHERE id = $1`,
      [beginnerId],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/vocab/entries?book_level=beginner');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].korean).toBe('초급단어');
  });

  it('domain + book_level + q compose (AND semantics)', async () => {
    // Three rows: only one is research AND intermediate AND matches the term.
    const hit = await seedVocabEntry(pg.pool, { korean: '연구결과', english: 'research result' });
    // Matches the term but stays 'general' — the domain filter must drop it.
    await seedVocabEntry(pg.pool, { korean: '연구실패', english: 'general row' });
    await seedVocabEntry(pg.pool, { korean: '무관단어', english: 'unrelated' });
    await pg.pool.query(
      `UPDATE vocab_entries SET domain = 'research'::content_domain WHERE id = $1`,
      [hit],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(
      `/vocab/entries?q=${encodeURIComponent('연구')}&domain=research&book_level=intermediate`,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].korean).toBe('연구결과');
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
    { name: 'bad domain enum', qs: '?domain=sports' },
    { name: 'bad book_level enum', qs: '?book_level=expert' },
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
    // B-009: a grammar card has no vocab entry — its vocab_* JOIN columns are NULL.
    expect(card!.vocab_korean).toBeNull();
    expect(card!.vocab_english).toBeNull();
    expect(card!.vocab_source_book).toBeNull();
  });

  // B-009 regression: the due query must JOIN vocab_entries so a vocab card
  // carries its real korean/english/example/source fields. Before the fix the
  // client only got `face` (the card_face ENUM — 'recognition', not the word)
  // and rendered it on both sides of the flashcard with empty examples/source.
  it('surfaces vocab_korean / vocab_english / examples / source_book for a vocab card (B-009)', async () => {
    const entryId = await seedVocabEntry(pg.pool, {
      korean: '영향',
      english: 'influence',
      exampleKorean: '음악은 우리 생활에 큰 영향을 미친다.',
      exampleEnglish: 'Music has a big influence on our lives.',
      sourceBook: 'vocab-2000-int',
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, vocab_entry_id, proficiency, due_at)
       VALUES ($1, 'recognition'::card_face, $2, 'L3'::proficiency_level, now())`,
      [userId, entryId],
    );

    const res = await agent.get('/vocab/cards/due?limit=10').expect(200);
    const card = (res.body.cards as Array<Record<string, unknown>>).find(
      (c) => c.vocab_entry_id === entryId,
    );
    expect(card).toBeDefined();
    expect(card!.vocab_korean).toBe('영향');
    expect(card!.vocab_english).toBe('influence');
    expect(card!.vocab_example_korean).toBe('음악은 우리 생활에 큰 영향을 미친다.');
    expect(card!.vocab_example_english).toBe('Music has a big influence on our lives.');
    expect(card!.vocab_source_book).toBe('vocab-2000-int');
    // The FSRS wire contract must survive the JOIN untouched: `version` is the
    // optimistic-concurrency snapshot the client echoes back on submitReview.
    expect(card!.version).toBe(1);
    expect(card!.face).toBe('recognition');
    expect(typeof card!.stability).toBe('string');
    expect(typeof card!.difficulty).toBe('string');
    expect(card!.fsrs_state).toBe('new');
  });

  it('leaves vocab example columns NULL when the entry has no example (B-009)', async () => {
    const entryId = await seedVocabEntry(pg.pool, { korean: '학교', english: 'school' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, vocab_entry_id, proficiency, due_at)
       VALUES ($1, 'recognition'::card_face, $2, 'L3'::proficiency_level, now())`,
      [userId, entryId],
    );

    const res = await agent.get('/vocab/cards/due?limit=10').expect(200);
    const card = (res.body.cards as Array<Record<string, unknown>>).find(
      (c) => c.vocab_entry_id === entryId,
    );
    expect(card).toBeDefined();
    expect(card!.vocab_korean).toBe('학교');
    expect(card!.vocab_example_korean).toBeNull();
    expect(card!.vocab_example_english).toBeNull();
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

/** Mint a fresh recognition card for the agent's user via the real per-entry
 *  bank route. Returns the card id + its version-1 snapshot, ready to review.
 *  A unique korean headword keeps the shared vocab_entries reference table
 *  (not truncated per-test) from colliding across tests. */
async function bankFreshCard(
  agent: Awaited<ReturnType<typeof registerUser>>['agent'],
): Promise<{ cardId: number; version: number }> {
  const entryId = await seedVocabEntry(pg.pool, {
    corpus: 'vocab_2000_intermediate',
    korean: `복습단어${Date.now()}${Math.floor(Math.random() * 1e6)}`,
  });
  const banked = await agent.post(`/vocab/entries/${entryId}/bank`).expect(201);
  return { cardId: banked.body.card.id as number, version: banked.body.card.version as number };
}

describe('POST /vocab/cards/:cardId/reviews — server-authoritative FSRS scheduling', () => {
  // The regression this whole feature exists for: the pre-cutover stub let the
  // client dictate scheduled_days_after (it sent 0), so every rated card came
  // back due IMMEDIATELY. The server now computes the transition itself.
  it('rating a fresh card "good" schedules a real FUTURE due_at (strictly > now, not now+0)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await bankFreshCard(agent);

    const before = Date.now();
    const res = await agent
      .post(`/vocab/cards/${cardId}/reviews`)
      .send({ rating: 'good', expected_version: version });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);
    // good on a new card seeds stability 3 → 3 whole days out.
    expect(res.body.scheduled_days).toBe(3);
    const dueAt = new Date(res.body.due_at as string).getTime();
    expect(dueAt).toBeGreaterThan(before); // the headline assertion: in the future
    expect(dueAt).toBeGreaterThan(before + 2 * 86_400_000); // ≈3 days, not minutes
    expect(dueAt).toBeLessThan(before + 4 * 86_400_000);

    // The card row itself advanced (server-computed, not client-claimed).
    const row = await pg.pool.query<{
      fsrs_state: string;
      stability: string;
      scheduled_days: number;
      reps: number;
      lapses: number;
      due_at: Date;
      version: number;
    }>(
      `SELECT fsrs_state, stability, scheduled_days, reps, lapses, due_at, version
         FROM vocab_cards WHERE id = $1`,
      [cardId],
    );
    const card = row.rows[0]!;
    expect(card.fsrs_state).toBe('learning');
    expect(Number(card.stability)).toBe(3);
    expect(card.scheduled_days).toBe(3);
    expect(card.reps).toBe(1);
    expect(card.lapses).toBe(0);
    expect(card.version).toBe(version + 1);
    expect(card.due_at.getTime()).toBeGreaterThan(before);
    // …and the card is no longer in the due queue.
    const due = await agent.get('/vocab/cards/due?limit=200').expect(200);
    expect((due.body.cards as Array<{ id: number }>).map((c) => c.id)).not.toContain(cardId);
  });

  it('Again/Hard/Good/Easy yield different, ordered intervals (~10min / 1d / 3d / 6d on a fresh card)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const ratings = ['again', 'hard', 'good', 'easy'] as const;
    const expectedDays: Record<(typeof ratings)[number], number> = {
      again: 0,
      hard: 1,
      good: 3,
      easy: 6,
    };
    const dueTimes: number[] = [];
    const before = Date.now();
    for (const rating of ratings) {
      const { cardId, version } = await bankFreshCard(agent);
      const res = await agent
        .post(`/vocab/cards/${cardId}/reviews`)
        .send({ rating, expected_version: version })
        .expect(200);
      expect(res.body.scheduled_days).toBe(expectedDays[rating]);
      const dueAt = new Date(res.body.due_at as string).getTime();
      expect(dueAt).toBeGreaterThan(before); // every rating lands in the future
      dueTimes.push(dueAt);
    }
    // Strictly increasing: again (~10 min) < hard (1d) < good (3d) < easy (6d).
    for (let i = 1; i < dueTimes.length; i += 1) {
      expect(dueTimes[i]!).toBeGreaterThan(dueTimes[i - 1]!);
    }
  });

  it('"again" re-queues ~10 minutes out (relearning + lapse), never due-now', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await bankFreshCard(agent);

    const before = Date.now();
    const res = await agent
      .post(`/vocab/cards/${cardId}/reviews`)
      .send({ rating: 'again', expected_version: version })
      .expect(200);
    expect(res.body.scheduled_days).toBe(0);
    const dueAt = new Date(res.body.due_at as string).getTime();
    expect(dueAt).toBeGreaterThan(before); // strictly in the future…
    expect(dueAt).toBeLessThanOrEqual(before + 60 * 60 * 1000); // …but within the hour (10-min relearn)

    const row = await pg.pool.query<{ fsrs_state: string; lapses: number }>(
      `SELECT fsrs_state, lapses FROM vocab_cards WHERE id = $1`,
      [cardId],
    );
    expect(row.rows[0]!.fsrs_state).toBe('relearning');
    expect(row.rows[0]!.lapses).toBe(1);
  });

  it('the card_reviews row snapshots the DB *_before and the computed *_after (ADR-003 D2)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await bankFreshCard(agent);

    await agent
      .post(`/vocab/cards/${cardId}/reviews`)
      .send({ rating: 'good', expected_version: version, duration_ms: 4200 })
      .expect(200);

    const log = await pg.pool.query<{
      user_id: string;
      rating: string;
      state_before: string;
      stability_before: string;
      difficulty_before: string;
      elapsed_days_before: number;
      state_after: string;
      stability_after: string;
      difficulty_after: string;
      scheduled_days_after: number;
      duration_ms: number;
    }>(
      `SELECT user_id, rating, state_before, stability_before, difficulty_before,
              elapsed_days_before, state_after, stability_after, difficulty_after,
              scheduled_days_after, duration_ms
         FROM card_reviews WHERE card_id = $1`,
      [cardId],
    );
    expect(log.rowCount).toBe(1);
    const r = log.rows[0]!;
    expect(Number(r.user_id)).toBe(Number(userId));
    expect(r.rating).toBe('good');
    // BEFORE = the freshly banked card's DB defaults, read server-side.
    expect(r.state_before).toBe('new');
    expect(Number(r.stability_before)).toBe(0);
    expect(Number(r.difficulty_before)).toBe(5);
    expect(r.elapsed_days_before).toBe(-1); // never-reviewed sentinel
    // AFTER = the engine's transition for good-on-new.
    expect(r.state_after).toBe('learning');
    expect(Number(r.stability_after)).toBe(3);
    expect(Number(r.difficulty_after)).toBe(5);
    expect(r.scheduled_days_after).toBe(3);
    expect(r.duration_ms).toBe(4200);
  });

  it('a second review compounds from the first (good → good: 3d → 6d), and the log chains', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await bankFreshCard(agent);

    const first = await agent
      .post(`/vocab/cards/${cardId}/reviews`)
      .send({ rating: 'good', expected_version: version })
      .expect(200);
    const second = await agent
      .post(`/vocab/cards/${cardId}/reviews`)
      .send({ rating: 'good', expected_version: first.body.version })
      .expect(200);
    // 3-day stability × 2.0 (good) = 6 days, and the card graduates to review.
    expect(second.body.scheduled_days).toBe(6);
    expect(second.body.version).toBe(version + 2);

    const row = await pg.pool.query<{ fsrs_state: string; stability: string; reps: number }>(
      `SELECT fsrs_state, stability, reps FROM vocab_cards WHERE id = $1`,
      [cardId],
    );
    expect(row.rows[0]!.fsrs_state).toBe('review');
    expect(Number(row.rows[0]!.stability)).toBe(6);
    expect(row.rows[0]!.reps).toBe(2);

    // Append-only chain: the 2nd row's *_before equals the 1st row's *_after.
    const log = await pg.pool.query<{
      state_before: string;
      stability_before: string;
      state_after: string;
      stability_after: string;
    }>(
      `SELECT state_before, stability_before, state_after, stability_after
         FROM card_reviews WHERE card_id = $1 ORDER BY id`,
      [cardId],
    );
    expect(log.rowCount).toBe(2);
    expect(log.rows[1]!.state_before).toBe(log.rows[0]!.state_after);
    expect(Number(log.rows[1]!.stability_before)).toBe(Number(log.rows[0]!.stability_after));
  });

  it('ignores client-supplied scheduling fields — a tampered scheduled_days_after: 0 cannot pin the card due-now', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await bankFreshCard(agent);

    const before = Date.now();
    // The exact pre-cutover stub payload (plus hostile *_after values): the
    // schema strips every unknown key, so none of it reaches the scheduler.
    const res = await agent
      .post(`/vocab/cards/${cardId}/reviews`)
      .send({
        rating: 'good',
        expected_version: version,
        state_before: 'new',
        stability_before: 0,
        difficulty_before: 5,
        elapsed_days_before: 0,
        state_after: 'new',
        stability_after: 0,
        difficulty_after: 1,
        scheduled_days_after: 0, // the stub/tamper value — must be ignored
      })
      .expect(200);
    expect(res.body.scheduled_days).toBe(3); // server-computed, not the client's 0
    expect(new Date(res.body.due_at as string).getTime()).toBeGreaterThan(
      before + 2 * 86_400_000,
    );
  });

  it('a reviewed card carries its version on the due queue (expected_version threading)', async () => {
    // The client can only echo expected_version if the due queue serves it.
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId, version } = await bankFreshCard(agent);
    const due = await agent.get('/vocab/cards/due?limit=200').expect(200);
    const card = (due.body.cards as Array<{ id: number; version: number }>).find(
      (c) => c.id === cardId,
    );
    expect(card).toBeDefined();
    expect(card!.version).toBe(version);
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
      expected_version: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('cross-user card → 404 (no existence leak)', async () => {
    // User A owns a card; User B should see 404, not 403, so we don't
    // leak the existence of A's card across the auth boundary.
    const { agent: a } = await registerUser(t.app, pg.pool);
    const { cardId } = await bankFreshCard(a);
    const { agent: b } = await registerUser(t.app, pg.pool);
    const res = await b.post(`/vocab/cards/${cardId}/reviews`).send({
      rating: 'good',
      expected_version: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('stale expected_version → 409 (FU-NF-8: split from not-found), and nothing is written', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const { cardId } = await bankFreshCard(agent);
    const res = await agent.post(`/vocab/cards/${cardId}/reviews`).send({
      rating: 'good',
      expected_version: 999, // deliberately wrong — card was just minted at v1.
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    // The error message must not conflate not-found with stale-version.
    expect(res.body.error.message).toMatch(/stale/i);
    expect(res.body.error.message).not.toMatch(/not found/i);
    // The whole tx rolled back: no card advance, no review log row.
    const log = await pg.pool.query(`SELECT 1 FROM card_reviews WHERE card_id = $1`, [cardId]);
    expect(log.rowCount).toBe(0);
  });

  it('invalid rating enum → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/cards/1/reviews').send({
      rating: 'super-easy',
      expected_version: 1,
    });
    expect(res.status).toBe(400);
  });

  it('missing expected_version → 400 (concurrency snapshot is mandatory)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/cards/1/reviews').send({ rating: 'good' });
    expect(res.status).toBe(400);
  });

  it('negative duration_ms → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/vocab/cards/1/reviews').send({
      rating: 'good',
      expected_version: 1,
      duration_ms: -5,
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

describe('GET /vocab/mastery — F-013 word mastery', () => {
  it('summarises buckets, lists words, and filters by bucket', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedVocabCard(pg.pool, userId); // default fsrs_state 'new'
    const learn = await seedVocabCard(pg.pool, userId);
    const mature = await seedVocabCard(pg.pool, userId);
    await pg.pool.query(
      `UPDATE vocab_cards SET fsrs_state = 'learning', stability = 6 WHERE id = $1`,
      [learn],
    );
    await pg.pool.query(
      `UPDATE vocab_cards SET fsrs_state = 'review', stability = 30 WHERE id = $1`,
      [mature],
    );

    const res = await agent.get('/vocab/mastery');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      new: 1,
      learning: 1,
      reviewing: 0,
      mastered: 1,
      total: 3,
    });
    expect(res.body.words).toHaveLength(3);
    // Sorted stability DESC → the mature (30d) card is first.
    expect(res.body.words[0].bucket).toBe('mastered');
    expect(res.body.words[0].stability).toBe(30);

    // Bucket filter narrows the LIST but the summary still reflects all cards.
    const only = await agent.get('/vocab/mastery?bucket=mastered');
    expect(only.status).toBe(200);
    expect(only.body.words).toHaveLength(1);
    expect(only.body.words[0].bucket).toBe('mastered');
    expect(only.body.total).toBe(1);
    expect(only.body.summary.total).toBe(3);
  });

  it("never counts another user's cards", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await seedVocabCard(pg.pool, b.userId);
    const res = await a.agent.get('/vocab/mastery');
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(0);
    expect(res.body.words).toHaveLength(0);
  });

  it('rejects an invalid bucket with 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/vocab/mastery?bucket=nope');
    expect(res.status).toBe(400);
  });

  it('buckets exactly at the 21-day maturity threshold (>= is mature)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const at21 = await seedVocabCard(pg.pool, userId);
    const below = await seedVocabCard(pg.pool, userId);
    await pg.pool.query(
      `UPDATE vocab_cards SET fsrs_state = 'review', stability = 21 WHERE id = $1`,
      [at21],
    );
    await pg.pool.query(
      `UPDATE vocab_cards SET fsrs_state = 'review', stability = 20.9 WHERE id = $1`,
      [below],
    );
    const res = await agent.get('/vocab/mastery');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ mastered: 1, reviewing: 1 });
    const byStab = new Map(
      (res.body.words as Array<{ stability: number; bucket: string }>).map(
        (w) => [w.stability, w.bucket],
      ),
    );
    expect(byStab.get(21)).toBe('mastered');
    expect(byStab.get(20.9)).toBe('reviewing');
  });

  it('excludes non-vocab (topik) cards from the summary and list', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedVocabCard(pg.pool, userId); // one real vocab card
    const topikId = await seedTopikItem(pg.pool);
    // A topik card has topik_item_id set and vocab_entry_id NULL — it is not a
    // "word" and must not appear in either the summary or the list.
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, topik_item_id, due_at)
       VALUES ($1, 'recognition'::card_face, $2, now())`,
      [userId, topikId],
    );
    const res = await agent.get('/vocab/mastery');
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.words).toHaveLength(1);
  });
});
