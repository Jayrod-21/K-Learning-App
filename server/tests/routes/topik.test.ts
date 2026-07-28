/**
 * Integration tests for /topik routes (Pass 6 — TOPIK Prep Study mode live +
 * Mock-Test server route).
 *
 * Routes:
 *   GET  /topik/items
 *   POST /topik/mock          (answer-stripped — FU-NF-39)
 *   POST /topik/mock/submit   (server-graded — FU-NF-39)
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
 *   - POST /mock: a section's items, answer-STRIPPED (no options[].correct, no
 *     explanation on the wire — FU-NF-39); server-picks a sourceTest when omitted
 *     (highest test_number with items in the section); 400 on the writing section
 *   - POST /mock/submit: grades right/wrong/skipped server-side, writes
 *     topik_responses(mode='mock') rows user-scoped, returns percentage+band+
 *     reveals; 400 on writing/empty
 *   - POST /study: shuffled cross-test draw, filter honored, count ≤ limit
 *   - POST /:itemId/answer: grades correct AND wrong; inserts a user-scoped
 *     topik_responses row; 404 on a missing item
 *   - section Korean ↔ enum normalization (읽기 ⇄ reading)
 *   - the inline-answer design: study DTOs carry options[].correct + explanation
 *   - shared reading passages (B-008): topik_tests.passages resolved onto the
 *     browse/study/mock DTOs by item_number range; the mock wire keeps the
 *     passage (question content) while staying answer-stripped
 *   - attempt lifecycle (046 / A1): GET/PUT/DELETE /topik/attempt against the
 *     status column — one ACTIVE attempt per user (partial unique), completed/
 *     abandoned rows retained as history, /mock/submit stamps responses'
 *     attempt_id, F-UP-014 resurrect race guarded by the fresh-completed check
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  ensureCorpusSource,
  registerUser,
  seedTopikItem,
  seedTopikResponse,
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
  // users CASCADE clears topik_responses (user FK). topik_items / topik_tests
  // are truncated explicitly so each test controls exactly what is selectable.
  // corpus_sources is left alone (idempotent seeding via ensureCorpusSource).
  await pg.pool.query('TRUNCATE TABLE topik_responses, sessions, users RESTART IDENTITY CASCADE');
  await pg.pool.query('TRUNCATE TABLE topik_items, topik_tests CASCADE');
  resetLimiters();
});

/**
 * Seed one topik_items row under a (test_number, topik_level, section) paper —
 * the LEVEL-AWARE cousin of the shared seedTopikItem (which hardcodes
 * 'TOPIK II' and reuses tests by (test_number, section) alone, so it cannot
 * assemble the two-papers-one-sitting state migration 029 exists to enable).
 * Raw SQL on purpose: the shared helper is owned by another surface.
 */
async function seedTopikItemAtLevel(
  level: 'TOPIK I' | 'TOPIK II',
  opts: {
    section?: 'reading' | 'listening';
    testNumber: number;
    itemNumber: number;
    options?: string[];
    answer?: number;
    stem?: string | null;
    prompt?: string | null;
    extra?: Record<string, unknown>;
  },
): Promise<number> {
  const section = opts.section ?? 'reading';
  const corpusSourceId = await ensureCorpusSource(pg.pool, 'topik', 'intermediate');
  const existing = await pg.pool.query<{ id: string }>(
    `SELECT id FROM topik_tests
      WHERE test_number = $1 AND topik_level = $2 AND section = $3::topik_section`,
    [opts.testNumber, level, section],
  );
  let testId: number;
  if (existing.rows[0]) {
    testId = Number(existing.rows[0].id);
  } else {
    const created = await pg.pool.query<{ id: string }>(
      `INSERT INTO topik_tests (corpus_source_id, corpus, test_number, topik_level, section)
       VALUES ($1, 'topik'::corpus, $2, $3, $4::topik_section)
       RETURNING id`,
      [corpusSourceId, opts.testNumber, level, section],
    );
    testId = Number(created.rows[0]!.id);
  }
  const sourceId = `topik-${level === 'TOPIK I' ? 'I' : 'II'}-${opts.testNumber}-${opts.itemNumber}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO topik_items (
        topik_test_id, corpus_source_id, corpus, source_id, item_number,
        section, item_type, proficiency, stem, prompt, underline,
        options, answer, extra, has_image, image_text)
     VALUES ($1, $2, 'topik'::corpus, $3, $4, $5::topik_section,
             'multiple_choice'::topik_item_type, 'L4'::proficiency_level,
             $6, $7, NULL, $8::jsonb, $9::jsonb, $10::jsonb, false, NULL)
     RETURNING id`,
    [
      testId,
      corpusSourceId,
      sourceId,
      opts.itemNumber,
      section,
      opts.stem === undefined ? '다음 글을 읽고 물음에 답하십시오.' : opts.stem,
      opts.prompt === undefined ? '알맞은 것을 고르십시오.' : opts.prompt,
      JSON.stringify(opts.options ?? ['보기 1', '보기 2', '보기 3', '보기 4']),
      JSON.stringify(opts.answer ?? 1),
      JSON.stringify(opts.extra ?? {}),
    ],
  );
  return Number(rows[0]!.id);
}

describe('topik — auth required', () => {
  it.each([
    ['GET', '/topik/items'],
    ['GET', '/topik/series'],
    ['GET', '/topik/attempts'],
    ['GET', '/topik/tests'],
    ['POST', '/topik/mock'],
    ['POST', '/topik/mock/submit'],
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

  it('carries hasImage (+ imageText only when captured) on the study DTO', async () => {
    // An image-dependent item (has_image, no curated image_text — the live
    // corpus's common case) and a plain item, in one browsable test.
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 860,
      itemNumber: 1,
      hasImage: true,
      stem: '남자: 어서 오세요.\n[알맞은 그림 고르기: ①가게 ②병원 ③학교 ④공원]',
      prompt: null,
    });
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 860,
      itemNumber: 2,
      hasImage: true,
      imageText: '두 사람이 카페에서 이야기하는 그림',
    });
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 860, itemNumber: 3 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/topik/items').query({ source_test: 860 });
    expect(res.status).toBe(200);
    const [img, imgText, plain] = res.body.items;
    expect(img.hasImage).toBe(true);
    expect(img).not.toHaveProperty('imageText'); // NULL image_text stays off the wire
    // With prompt NULL the bracketed description in stem still reaches the client.
    expect(img.prompt).toContain('[알맞은 그림 고르기');
    expect(imgText.hasImage).toBe(true);
    expect(imgText.imageText).toBe('두 사람이 카페에서 이야기하는 그림');
    expect(plain.hasImage).toBe(false);
    expect(plain).not.toHaveProperty('imageText');
  });

  it('excludes picture-choice items + enforces the survivor guard on study and mock (P2-1, P3-3)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const normal = await seedTopikItem(pg.pool, {
      section: 'listening',
      options: ['가', '나', '다', '라'],
      answer: 2,
      testNumber: 950,
      itemNumber: 1,
    });
    // Bare ①②③④ options with no image asset — visually unanswerable (P2-1).
    const picture = await seedTopikItem(pg.pool, {
      section: 'listening',
      options: ['①', '②', '③', '④'],
      answer: 1,
      hasImage: true,
      testNumber: 950,
      itemNumber: 2,
    });
    // <2 options — exercises the survivor guard the study draw previously lacked
    // (P3-3): it must be excluded from the study pool.
    const tooFew = await seedTopikItem(pg.pool, {
      section: 'listening',
      options: ['가'],
      answer: 1,
      testNumber: 950,
      itemNumber: 3,
    });

    const study = await agent
      .post('/topik/study')
      .send({ section: 'listening', limit: 50 });
    expect(study.status).toBe(200);
    const studyIds = (study.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(studyIds).toContain(String(normal));
    expect(studyIds).not.toContain(String(picture));
    expect(studyIds).not.toContain(String(tooFew));

    const mock = await agent.post('/topik/mock').send({ section: 'listening' });
    expect(mock.status).toBe(200);
    const mockIds = (mock.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(mockIds).toContain(String(normal));
    expect(mockIds).not.toContain(String(picture));
  });

  it('caps a mock section to the official 50 items (F-UP-007)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // 60 answerable reading items in one test — more than the official exam.
    for (let n = 1; n <= 60; n++) {
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber: 1300,
        itemNumber: n,
        options: ['가', '나', '다', '라'],
        answer: 1,
      });
    }
    const res = await agent.post('/topik/mock').send({ section: 'reading' });
    expect(res.status).toBe(200);
    // Capped to 50, not the 60 that exist.
    expect(res.body.items.length).toBe(50);
    // Item numbers are the first 50 (ORDER BY item_number).
    expect(res.body.items[0].number).toBe(1);
    expect(res.body.items[49].number).toBe(50);
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

describe('GET /topik/mistakes — recent wrong answers for review (F-021)', () => {
  it('returns misses with the wrong pick + correct answer + explanation; excludes correct answers', async () => {
    const wrongId = await seedTopikItem(pg.pool, {
      section: 'reading',
      options: ['가', '나', '다', '라'],
      answer: 2, // correct = 'b'
      prompt: '알맞은 것을 고르십시오.',
      extra: { explanation: '정답은 나입니다.' },
      itemNumber: 1,
    });
    const rightId = await seedTopikItem(pg.pool, {
      section: 'reading',
      options: ['가', '나', '다', '라'],
      answer: 1, // correct = 'a'
      itemNumber: 2,
    });
    const { agent } = await registerUser(t.app, pg.pool);

    // Miss the first (pick 'a' when 'b' is right); ace the second (pick 'a').
    expect(
      (await agent.post(`/topik/${wrongId}/answer`).send({ picked: 'a', mode: 'study' }))
        .status,
    ).toBe(200);
    expect(
      (await agent.post(`/topik/${rightId}/answer`).send({ picked: 'a', mode: 'study' }))
        .status,
    ).toBe(200);

    const res = await agent.get('/topik/mistakes');
    expect(res.status).toBe(200);
    expect(res.body.mistakes.length).toBe(1); // only the miss, not the ace
    const m = res.body.mistakes[0];
    expect(m.item.id).toBe(String(wrongId));
    expect(m.picked).toBe('a');
    expect(m.mode).toBe('study');
    expect(typeof m.answeredAt).toBe('string');
    // Full review payload: the explanation + the correct option ARE served here
    // (unlike /items) — the user already attempted the item.
    expect(m.item.explanation).toBe('정답은 나입니다.');
    expect(
      m.item.options.find((o: { correct: boolean }) => o.correct).id,
    ).toBe('b');
  });

  it('is user-scoped (no IDOR) and honors the 30-day window', async () => {
    const itemId = await seedTopikItem(pg.pool, {
      section: 'reading',
      options: ['가', '나', '다', '라'],
      answer: 2,
    });
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);

    // A misses it now, and ALSO has an old miss (40 days ago) outside the window.
    await a.agent.post(`/topik/${itemId}/answer`).send({ picked: 'a', mode: 'study' });
    await pg.pool.query(
      `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, answered_at)
       VALUES ($1, $2, 'c', false, 'study', now() - interval '40 days')`,
      [a.userId, itemId],
    );

    // A sees only the RECENT miss (the 40-day-old one is outside the default 30d).
    const resA = await a.agent.get('/topik/mistakes');
    expect(resA.status).toBe(200);
    expect(resA.body.mistakes.length).toBe(1);
    expect(resA.body.mistakes[0].picked).toBe('a');

    // B sees NONE of A's mistakes.
    const resB = await b.agent.get('/topik/mistakes');
    expect(resB.body.mistakes.length).toBe(0);

    // Widening the window to 90 days surfaces the old miss too.
    const resWide = await a.agent.get('/topik/mistakes?days=90');
    expect(resWide.body.mistakes.length).toBe(2);
  });

  // F-105: attempt_id in the DTO, so the client can link a mistake back to
  // its exam attempt.
  it('F-105: a mock-mode miss carries its attemptId; a study-mode miss carries null', async () => {
    const studyId = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 5000,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2, // correct 'b'
    });
    const mockId = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 5001,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2, // correct 'b'
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Study-mode miss — no attempt.
    await agent.post(`/topik/${studyId}/answer`).send({ picked: 'a', mode: 'study' });

    // Mock-mode miss — grouped under a completed attempt.
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 5001,
      section: 'reading',
      answers: [{ itemId: mockId, picked: 'a' }], // wrong — 'b' is correct
    });
    expect(submit.status).toBe(200);
    const { rows: attemptRows } = await pg.pool.query<{ id: string }>(
      `SELECT id FROM topik_attempts WHERE user_id = $1 AND status = 'completed'`,
      [userId],
    );
    expect(attemptRows).toHaveLength(1);
    const attemptId = attemptRows[0]!.id;

    const res = await agent.get('/topik/mistakes?days=90');
    expect(res.status).toBe(200);
    expect(res.body.mistakes.length).toBe(2);
    const byMode = Object.fromEntries(
      (res.body.mistakes as { mode: string; attemptId: string | null }[]).map(
        (m) => [m.mode, m.attemptId],
      ),
    );
    expect(byMode.study).toBeNull();
    expect(byMode.mock).toBe(attemptId);
  });
});

describe('GET /topik/series — per-skill daily accuracy time-series (F-017)', () => {
  /** The UTC calendar day `daysAgo` days back, formatted as the route emits it. */
  async function utcDay(daysAgo: number): Promise<string> {
    const { rows } = await pg.pool.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE 'UTC')::date - $1::int, 'YYYY-MM-DD') AS d`,
      [daysAgo],
    );
    return rows[0]!.d;
  }

  /** Append a topik_responses row `daysAgo` days back (the series time axis). */
  async function insertResponse(
    userId: number,
    itemId: number,
    opts: { correct: boolean; daysAgo?: number },
  ): Promise<void> {
    await pg.pool.query(
      `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, answered_at)
       VALUES ($1, $2, 'a', $3, 'study', now() - make_interval(days => $4))`,
      [userId, itemId, opts.correct, opts.daysAgo ?? 0],
    );
  }

  it('buckets accuracy per UTC day, split by section, ascending; writing never counts', async () => {
    const readingId = await seedTopikItem(pg.pool, { section: 'reading' });
    const listeningId = await seedTopikItem(pg.pool, { section: 'listening' });
    const writingId = await seedTopikItem(pg.pool, { section: 'writing' });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Reading, two days ago: 1 correct of 3 → round(100 * 1/3) = 33.
    await insertResponse(userId, readingId, { correct: true, daysAgo: 2 });
    await insertResponse(userId, readingId, { correct: false, daysAgo: 2 });
    await insertResponse(userId, readingId, { correct: false, daysAgo: 2 });
    // Reading, yesterday: 2 correct of 3 → round(100.0 * 2/3) = 67, where
    // integer division would truncate to 66. Every other case in this test
    // has round == trunc, so this day alone makes a regression to
    // `round(100 * c / n)` (bigint division) detectable.
    await insertResponse(userId, readingId, { correct: true, daysAgo: 1 });
    await insertResponse(userId, readingId, { correct: true, daysAgo: 1 });
    await insertResponse(userId, readingId, { correct: false, daysAgo: 1 });
    // Reading, today: 3 correct of 4 → 75.
    await insertResponse(userId, readingId, { correct: true });
    await insertResponse(userId, readingId, { correct: true });
    await insertResponse(userId, readingId, { correct: true });
    await insertResponse(userId, readingId, { correct: false });
    // Listening, today: 1 of 1 → 100.
    await insertResponse(userId, listeningId, { correct: true });
    // A writing answer exists in the log but writing is not a charted skill.
    await insertResponse(userId, writingId, { correct: false });

    const res = await agent.get('/topik/series');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['listening', 'reading']);

    expect(res.body.reading.metric).toBe('accuracy');
    expect(res.body.reading.unit).toBe('%');
    expect(res.body.reading.points).toEqual([
      { date: await utcDay(2), value: 33 },
      { date: await utcDay(1), value: 67 },
      { date: await utcDay(0), value: 75 },
    ]);

    expect(res.body.listening.metric).toBe('accuracy');
    expect(res.body.listening.unit).toBe('%');
    expect(res.body.listening.points).toEqual([
      { date: await utcDay(0), value: 100 },
    ]);
  });

  it("is user-scoped (no IDOR) — another user's answers never appear", async () => {
    const itemId = await seedTopikItem(pg.pool, { section: 'reading' });
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await insertResponse(a.userId, itemId, { correct: true });
    await insertResponse(b.userId, itemId, { correct: false });

    // B sees only B's own (wrong) answer, never A's.
    const resB = await b.agent.get('/topik/series');
    expect(resB.status).toBe(200);
    expect(resB.body.reading.points).toEqual([{ date: await utcDay(0), value: 0 }]);

    // A's accuracy is unpolluted by B's miss.
    const resA = await a.agent.get('/topik/series');
    expect(resA.body.reading.points).toEqual([{ date: await utcDay(0), value: 100 }]);
  });

  it('honors the days window (default 30, widenable to 90)', async () => {
    const itemId = await seedTopikItem(pg.pool, { section: 'reading' });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await insertResponse(userId, itemId, { correct: true });
    await insertResponse(userId, itemId, { correct: false, daysAgo: 40 });

    // Default 30-day window: the 40-day-old answer is outside it.
    const res = await agent.get('/topik/series');
    expect(res.status).toBe(200);
    expect(res.body.reading.points).toEqual([{ date: await utcDay(0), value: 100 }]);

    // Widening to 90 days surfaces it as its own (older-first) day bucket.
    const wide = await agent.get('/topik/series?days=90');
    expect(wide.body.reading.points).toEqual([
      { date: await utcDay(40), value: 0 },
      { date: await utcDay(0), value: 100 },
    ]);
  });

  it('no activity → 200 with empty points (not an error)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/series');
    expect(res.status).toBe(200);
    expect(res.body.reading).toEqual({ metric: 'accuracy', unit: '%', points: [] });
    expect(res.body.listening).toEqual({ metric: 'accuracy', unit: '%', points: [] });
  });

  it('pins day buckets to UTC even under a non-UTC DB session TimeZone', async () => {
    // A response at 00:30 UTC today is YESTERDAY afternoon in
    // America/Anchorage (UTC-9/-8). The route buckets with
    // `(answered_at AT TIME ZONE 'UTC')::date`; a regression to a bare
    // `answered_at::date` would follow the session TimeZone and land this
    // row on yesterday's bucket. The main suite pool runs in UTC (where the
    // two expressions agree), so this ephemeral app pins every one of its
    // pool connections to Anchorage — the documented node-postgres
    // per-connection setup hook — making the two expressions disagree.
    const tz = buildTestApp({ connectionString: pg.connectionString });
    tz.pool.on('connect', (client) => {
      client.query("SET TimeZone = 'America/Anchorage'").catch(() => {
        // Swallowed on purpose: the SHOW TimeZone assertion below fails
        // loudly if the pin did not apply.
      });
    });
    try {
      // Prove the pin actually applied — otherwise this test could silently
      // degrade back into the tz-neutral variant it exists to strengthen.
      const shown = await tz.pool.query('SHOW TimeZone');
      expect(shown.rows[0]).toEqual({ TimeZone: 'America/Anchorage' });

      // Capture "today" (UTC) BEFORE inserting so a midnight rollover
      // between insert and assert can't flake the expected bucket.
      const today = await utcDay(0);
      const itemId = await seedTopikItem(pg.pool, { section: 'reading' });
      const { agent, userId } = await registerUser(tz.app, pg.pool);
      await pg.pool.query(
        `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, answered_at)
         VALUES ($1, $2, 'a', true, 'study', ($3::date + time '00:30') AT TIME ZONE 'UTC')`,
        [userId, itemId, today],
      );

      const res = await agent.get('/topik/series');
      expect(res.status).toBe(200);
      expect(res.body.reading.points).toEqual([{ date: today, value: 100 }]);
    } finally {
      await teardownTestApp(tz);
    }
  });

  it.each([['days=0'], ['days=91']])('%s → 400 (window is 1..90)', async (qs) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/topik/series?${qs}`);
    expect(res.status).toBe(400);
  });
});

describe('TOPIK mock-attempt persistence — resume (F-007)', () => {
  it('GET /attempt returns null when there is no in-progress attempt', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/attempt');
    expect(res.status).toBe(200);
    expect(res.body.attempt).toBeNull();
  });

  it('PUT saves an attempt; GET returns it; a second PUT upserts (one row per user)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const save1 = await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 1300,
      currentIdx: 5,
      picks: { '11': 'a', '12': 'c' },
      remainingMs: 2_400_000,
    });
    expect(save1.status).toBe(204);

    const g1 = await agent.get('/topik/attempt');
    expect(g1.status).toBe(200);
    expect(g1.body.attempt).toMatchObject({
      section: 'reading',
      sourceTest: 1300,
      currentIdx: 5,
      picks: { '11': 'a', '12': 'c' },
      remainingMs: 2_400_000,
      answered: 2,
    });
    expect(typeof g1.body.attempt.updatedAt).toBe('string');

    // A second save REPLACES the first (upsert on user_id — one attempt per user).
    const save2 = await agent.put('/topik/attempt').send({
      section: 'listening',
      sourceTest: 1301,
      currentIdx: 8,
      picks: { '20': 'd' },
      remainingMs: 1_000_000,
    });
    expect(save2.status).toBe(204);
    const g2 = await agent.get('/topik/attempt');
    expect(g2.body.attempt).toMatchObject({
      section: 'listening',
      sourceTest: 1301,
      currentIdx: 8,
      answered: 1,
    });
  });

  it('DELETE clears the attempt (idempotent)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent
      .put('/topik/attempt')
      .send({ section: 'reading', sourceTest: 1, currentIdx: 0, picks: {}, remainingMs: 100 });
    expect((await agent.delete('/topik/attempt')).status).toBe(204);
    expect((await agent.get('/topik/attempt')).body.attempt).toBeNull();
    // Deleting again is still 204 (idempotent).
    expect((await agent.delete('/topik/attempt')).status).toBe(204);
  });

  it('is user-scoped — one user cannot see or clobber another user\'s attempt', async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await a.agent
      .put('/topik/attempt')
      .send({ section: 'reading', sourceTest: 42, currentIdx: 3, picks: { '9': 'b' }, remainingMs: 500 });
    // B sees nothing of A's.
    expect((await b.agent.get('/topik/attempt')).body.attempt).toBeNull();
    // B saving its own does NOT disturb A's (distinct user_id rows).
    await b.agent
      .put('/topik/attempt')
      .send({ section: 'listening', sourceTest: 99, currentIdx: 1, picks: {}, remainingMs: 10 });
    expect((await a.agent.get('/topik/attempt')).body.attempt).toMatchObject({ sourceTest: 42 });
  });

  it('rejects a malformed body (bad section / choice / picks key / oversized / INT4 overflow) with 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const bad = async (body: object): Promise<number> =>
      (await agent.put('/topik/attempt').send(body)).status;
    // Writing is not a mock section.
    expect(await bad({ section: 'writing', sourceTest: 1, currentIdx: 0, picks: {}, remainingMs: 1 })).toBe(400);
    // Choice value outside a..d.
    expect(await bad({ section: 'reading', sourceTest: 1, currentIdx: 0, picks: { '1': 'e' }, remainingMs: 1 })).toBe(400);
    // Non-numeric picks KEY (the `^\d+$` guard — the item id must be an integer).
    expect(await bad({ section: 'reading', sourceTest: 1, currentIdx: 0, picks: { abc: 'a' }, remainingMs: 1 })).toBe(400);
    // More than 60 picks (a mock section is <= 50).
    const tooMany = Object.fromEntries(
      Array.from({ length: 61 }, (_, i) => [String(i + 1), 'a']),
    );
    expect(await bad({ section: 'reading', sourceTest: 1, currentIdx: 0, picks: tooMany, remainingMs: 1 })).toBe(400);
    // Above INT4 max → rejected at the boundary (400), never reaching the
    // INTEGER column to overflow (which would 500).
    expect(await bad({ section: 'reading', sourceTest: 2_147_483_648, currentIdx: 0, picks: {}, remainingMs: 1 })).toBe(400);
    expect(await bad({ section: 'reading', sourceTest: 1, currentIdx: 0, picks: {}, remainingMs: 2_147_483_648 })).toBe(400);
  });

  it('submitting a mock clears the in-progress attempt', async () => {
    const id = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 1500,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
      extra: { explanation: 'x' },
    });
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 1500,
      currentIdx: 0,
      picks: { [String(id)]: 'b' },
      remainingMs: 999,
    });
    expect((await agent.get('/topik/attempt')).body.attempt).not.toBeNull();
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 1500,
      section: 'reading',
      answers: [{ itemId: id, picked: 'b' }],
      durationMs: 1000,
    });
    expect(submit.status).toBe(200);
    // The finished section's attempt is gone — the resume banner won't re-offer it.
    expect((await agent.get('/topik/attempt')).body.attempt).toBeNull();
  });
});

describe('GET /topik/attempt — F-173 resumed-exam totalItems/topikLevel', () => {
  it('reuses resolveServedTotal to report the exam\'s served item count + level alongside the answered count', async () => {
    // 3 answerable reading items under test_number 4000 (seedTopikItem
    // defaults to TOPIK II — same corpus fixture convention the F-104
    // history tests above rely on).
    const id1 = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 4000,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
    });
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 4000,
      itemNumber: 2,
      options: ['가', '나', '다', '라'],
      answer: 3,
    });
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 4000,
      itemNumber: 3,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 4000,
      currentIdx: 1,
      picks: { [String(id1)]: 'b' },
      remainingMs: 500_000,
    });

    const res = await agent.get('/topik/attempt');
    expect(res.status).toBe(200);
    expect(res.body.attempt).toMatchObject({
      section: 'reading',
      sourceTest: 4000,
      topikLevel: 'TOPIK II',
      answered: 1,
      totalItems: 3, // the paper's served size, not just the 1 answered so far
    });
  });

  it('falls back to the answered count (never a fabricated total) when the backing paper can no longer be resolved', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // No topik_items exist for sourceTest 4001 — resolveMockTest (and
    // therefore resolveServedTotal) resolves to null, mirroring the
    // documented "corpus row backing this paper is gone" fallback the
    // GET /topik/attempts history route already has coverage for.
    await agent.put('/topik/attempt').send({
      section: 'listening',
      sourceTest: 4001,
      currentIdx: 2,
      picks: { '1': 'a', '2': 'b' },
      remainingMs: 100_000,
    });

    const res = await agent.get('/topik/attempt');
    expect(res.status).toBe(200);
    expect(res.body.attempt).toMatchObject({
      sourceTest: 4001,
      topikLevel: null,
      answered: 2,
      totalItems: 2, // real lower bound = answered, never a guessed exam size
    });
  });

  it('is capped at OFFICIAL_MOCK_SECTION_SIZE, matching what POST /topik/mock would actually serve', async () => {
    for (let i = 1; i <= 55; i += 1) {
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber: 4002,
        itemNumber: i,
        options: ['가', '나', '다', '라'],
        answer: 1,
      });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 4002,
      currentIdx: 0,
      picks: {},
      remainingMs: 1000,
    });

    const res = await agent.get('/topik/attempt');
    expect(res.status).toBe(200);
    expect(res.body.attempt.totalItems).toBe(50); // OFFICIAL_MOCK_SECTION_SIZE
  });
});

describe('F-122 (migration 066) — persisted topik_level on topik_attempts', () => {
  it('PUT with an explicit topikLevel persists it; GET reports it WITHOUT re-deriving via resolveServedTotal', async () => {
    // Two papers sharing test_number 4100 (TOPIK I + TOPIK II) — the D-1
    // "one test_number, two papers" collision. Without a persisted level,
    // resolveServedTotal's tie-break would report TOPIK II regardless of
    // which paper the client actually saved progress against.
    await seedTopikItemAtLevel('TOPIK I', {
      section: 'reading',
      testNumber: 4100,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    await seedTopikItemAtLevel('TOPIK II', {
      section: 'reading',
      testNumber: 4100,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 4100,
      topikLevel: 'TOPIK I',
      currentIdx: 0,
      picks: {},
      remainingMs: 1000,
    });

    const res = await agent.get('/topik/attempt');
    expect(res.status).toBe(200);
    expect(res.body.attempt).toMatchObject({
      sourceTest: 4100,
      topikLevel: 'TOPIK I', // the persisted fact, never the TOPIK II tie-break guess
      totalItems: 1,
    });
  });

  it('PUT with a MISMATCHED topikLevel (batch-2 fix-pass SF-3) is dropped to NULL, never persisted or reported as the wrong level', async () => {
    // Only a TOPIK II paper exists at test_number 4110's reading section — no
    // TOPIK I paper shares that number. A client claiming 'TOPIK I' for this
    // (sourceTest, section) is sending a value that cannot possibly be
    // correct; the route must not take it on faith.
    await seedTopikItemAtLevel('TOPIK II', {
      section: 'reading',
      testNumber: 4110,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 4110,
      topikLevel: 'TOPIK I', // mismatched — no such paper exists
      currentIdx: 0,
      picks: {},
      remainingMs: 1000,
    });

    // The mismatched value must not land in the row at all.
    const { rows } = await pg.pool.query<{ topik_level: string | null }>(
      `SELECT topik_level FROM topik_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([{ topik_level: null }]);

    // GET must never echo the client's fabricated 'TOPIK I' either — with
    // topik_level NULL in the row, it falls back to the legacy
    // resolveServedTotal re-derivation, which correctly finds the REAL
    // TOPIK II paper (the only one that actually exists for this test
    // number/section).
    const res = await agent.get('/topik/attempt');
    expect(res.status).toBe(200);
    expect(res.body.attempt).toMatchObject({
      sourceTest: 4110,
      topikLevel: 'TOPIK II',
    });
  });

  it('PUT with no topikLevel (pre-F-122 client) leaves it NULL — GET falls back to the legacy guess, unchanged from before F-122', async () => {
    const id = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 4101,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 4101,
      currentIdx: 0,
      picks: { [String(id)]: 'a' },
      remainingMs: 1000,
    });
    const { rows } = await pg.pool.query<{ topik_level: string | null }>(
      `SELECT topik_level FROM topik_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([{ topik_level: null }]);

    const res = await agent.get('/topik/attempt');
    expect(res.body.attempt).toMatchObject({
      sourceTest: 4101,
      topikLevel: 'TOPIK II', // seedTopikItem's default level — the legacy re-derivation
    });
  });

  it('/mock/submit ALWAYS stamps the authoritative resolved level, overwriting whatever the in-progress save had (or omitted)', async () => {
    const id = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 4102,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Progress save omits topikLevel entirely (an old-client shape).
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 4102,
      currentIdx: 0,
      picks: { [String(id)]: 'a' },
      remainingMs: 1000,
    });
    await agent.post('/topik/mock/submit').send({
      sourceTest: 4102,
      section: 'reading',
      answers: [{ itemId: id, picked: 'a' }],
    });

    const { rows } = await pg.pool.query<{ topik_level: string | null; status: string }>(
      `SELECT topik_level, status FROM topik_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([{ topik_level: 'TOPIK II', status: 'completed' }]);
  });

  it('/mock/submit stamps the level even with NO prior progress save (the direct-INSERT branch)', async () => {
    const id = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 4103,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Straight to submit — no PUT /topik/attempt ever fired, so the
    // completed row is INSERTed fresh inside /mock/submit.
    await agent.post('/topik/mock/submit').send({
      sourceTest: 4103,
      section: 'reading',
      answers: [{ itemId: id, picked: 'a' }],
    });

    const { rows } = await pg.pool.query<{ topik_level: string | null }>(
      `SELECT topik_level FROM topik_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([{ topik_level: 'TOPIK II' }]);
  });
});

describe('shared reading passages on the item DTO (B-008)', () => {
  const PASSAGE =
    '도시의 도로는 대부분 아스팔트로 뒤덮여 있다. 그래서 비가 오면 빗물이 지하로 잘 흘러 들어가지 ( ㉠ ) 도로가 물에 잠기는 일도 자주 발생한다.';

  /** Attach a `passages` JSONB to the seeded test (topik_tests, migration 005). */
  async function setTestPassages(
    testNumber: number,
    passages: Record<string, unknown>,
  ): Promise<void> {
    await pg.pool.query(
      `UPDATE topik_tests SET passages = $1::jsonb WHERE test_number = $2`,
      [JSON.stringify(passages), testNumber],
    );
  }

  it('resolves the passage covering the item_number onto study + browse DTOs', async () => {
    // Item 19's own stem is only the question — the reading text lives in the
    // parent test's passages under the "19-20" range key. Item 21 is outside
    // every range and must NOT pick up a passage.
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 1100,
      itemNumber: 19,
      stem: '( ㉠ )에 들어갈 말로 가장 알맞은 것을 고르십시오.',
      prompt: null,
    });
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 1100,
      itemNumber: 21,
      // Self-contained item: its own stem IS the text (no prompt, no shared
      // passage) — the DTO must carry no `passage` for it.
      stem: '북극여우는 계절에 따라 털 색깔을 바꾸는 동물이다.',
      prompt: null,
    });
    await setTestPassages(1100, { '19-20': PASSAGE });
    const { agent } = await registerUser(t.app, pg.pool);

    // GET /items (browse) — passage resolved, question text intact.
    const browse = await agent.get('/topik/items').query({ source_test: 1100 });
    expect(browse.status).toBe(200);
    const [covered, uncovered] = browse.body.items;
    expect(covered.number).toBe(19);
    expect(covered.passage).toBe(PASSAGE);
    expect(covered.prompt).toBe('( ㉠ )에 들어갈 말로 가장 알맞은 것을 고르십시오.');
    expect(uncovered.number).toBe(21);
    expect(uncovered).not.toHaveProperty('passage'); // no covering range key

    // POST /study — the same mapping serves the draw.
    const study = await agent.post('/topik/study').send({ section: 'reading', limit: 10 });
    expect(study.status).toBe(200);
    const studyCovered = study.body.items.find((i: { number: number }) => i.number === 19);
    expect(studyCovered.passage).toBe(PASSAGE);
  });

  it('mock items carry the passage but STILL no answer fields (answer-strip holds)', async () => {
    // Two items sharing one passage — both must render it in the timed exam
    // (the passage is question content), while the wire stays answer-stripped.
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 1101,
      itemNumber: 19,
      stem: '( ㉠ )에 들어갈 말로 가장 알맞은 것을 고르십시오.',
      answer: 2,
      extra: { explanation: 'must NOT reach the mock wire' },
    });
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 1101,
      itemNumber: 20,
      stem: '윗글의 주제로 가장 알맞은 것을 고르십시오.',
      answer: 3,
    });
    await setTestPassages(1101, { '19-20': PASSAGE });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 1101, section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    for (const item of res.body.items as Array<{
      passage?: unknown;
      explanation?: unknown;
      options: Array<Record<string, unknown>>;
    }>) {
      // The passage reaches the exam — the item is answerable…
      expect(item.passage).toBe(PASSAGE);
      // …but the strip holds: no explanation, no correct flag anywhere.
      expect(item).not.toHaveProperty('explanation');
      expect(JSON.stringify(item)).not.toContain('correct');
      for (const opt of item.options) {
        expect(opt).not.toHaveProperty('correct');
        expect(Object.keys(opt).sort()).toEqual(['en', 'id', 'kr']);
      }
    }
  });

  it('surfaces the stem as the passage when a prompt would otherwise mask it', async () => {
    // B-008 defect (1): `prompt ?? stem` used to DROP the stem whenever a
    // prompt existed. With both present and no shared passage, the stem must
    // now ride in `passage` and the prompt stays the question.
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 1102,
      itemNumber: 1,
      stem: '한복은 한국의 전통 의상이다. 요즘은 명절에 주로 입는다.',
      prompt: '윗글의 내용과 같은 것을 고르십시오.',
    });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/topik/items').query({ source_test: 1102 });
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.prompt).toBe('윗글의 내용과 같은 것을 고르십시오.');
    expect(item.passage).toBe('한복은 한국의 전통 의상이다. 요즘은 명절에 주로 입는다.');
  });

  it('skips malformed passages entries instead of failing the request', async () => {
    // Hostile/malformed corpus data must degrade to "no shared passage":
    // non-string values, empty strings, and non-numeric range keys are skipped.
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 1103,
      itemNumber: 19,
      stem: '( ㉠ )에 들어갈 말로 가장 알맞은 것을 고르십시오.',
      prompt: null,
    });
    await setTestPassages(1103, {
      '19-20': 42, // non-string → skipped
      'intro-note': PASSAGE, // non-numeric key → skipped
      '18': '   ', // blank string → skipped
    });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/topik/items').query({ source_test: 1103 });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).not.toHaveProperty('passage');
    expect(res.body.items[0].prompt).toContain('㉠'); // the item still renders its stem
  });
});

describe('POST /topik/mock — answer-stripped section assembly (FU-NF-39)', () => {
  it('returns the section in item_number order, ANSWER-STRIPPED, echoing sourceTest+section', async () => {
    // Seed out of order to prove the route, not the insert order, sorts.
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 900,
      itemNumber: 3,
      options: ['가', '나', '다', '라'],
      answer: 2,
      extra: { explanation: 'should NOT reach the wire' },
    });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 900, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 900, itemNumber: 2 });
    // A different test must not bleed in.
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 901, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 900, section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body.sourceTest).toBe(900);
    expect(res.body.section).toBe('reading'); // normalized enum echoed
    expect(res.body.items.map((i: { number: number }) => i.number)).toEqual([1, 2, 3]);

    // The strip: NO item carries `explanation`, NO choice carries `correct`.
    // `hasImage` (question metadata, not answer data) DOES survive the strip.
    for (const item of res.body.items as Array<{ explanation?: unknown; hasImage?: unknown; options: Array<Record<string, unknown>> }>) {
      expect(item).not.toHaveProperty('explanation');
      expect(JSON.stringify(item)).not.toContain('correct');
      expect(typeof item.hasImage).toBe('boolean');
      for (const opt of item.options) {
        expect(opt).not.toHaveProperty('correct');
        // The choice keeps exactly the public fields.
        expect(Object.keys(opt).sort()).toEqual(['en', 'id', 'kr']);
      }
    }
  });

  it('honors the section filter within a test (listening only)', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 910, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 910, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 910, section: 'listening' });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    // The stripped item omits the Korean section label entirely? No — section is
    // still on each item DTO (kept from the study DTO); only correct/explanation
    // are stripped. The item-level section is the Korean label.
    expect(res.body.items[0].section).toBe('듣기');
  });

  it('server-picks the HIGHEST test_number with items in the section when sourceTest omitted', async () => {
    // Two reading tests; the picker must choose 921 (the higher), and a listening
    // item under an even-higher test must NOT influence a reading pick.
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 920, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 921, itemNumber: 1 });
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 999, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body.sourceTest).toBe(921); // highest reading test, not the listening 999
    expect(res.body.items.length).toBe(1);
  });

  it('rejects the writing section with 400 (writing mock is FU-NF-47)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const byEnum = await agent.post('/topik/mock').send({ section: 'writing' });
    const byKr = await agent.post('/topik/mock').send({ section: '쓰기' });
    expect(byEnum.status).toBe(400);
    expect(byKr.status).toBe(400);
  });

  it('requires the section field (400 when omitted)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock').send({ sourceTest: 900 });
    expect(res.status).toBe(400);
  });
});

describe('POST /topik/mock/submit — bulk server-graded scoring (FU-NF-39)', () => {
  /** Seed a 3-item reading mock under one test; answers are b/c/a (2/3/1). */
  async function seedThreeItemReadingMock(testNumber: number): Promise<number[]> {
    const ids: number[] = [];
    ids.push(
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber,
        itemNumber: 1,
        options: ['가', '나', '다', '라'],
        answer: 2, // correct 'b'
        extra: { explanation: '1번 설명' },
      }),
    );
    ids.push(
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber,
        itemNumber: 2,
        options: ['가', '나', '다', '라'],
        answer: 3, // correct 'c'
        extra: { explanation: '2번 설명' },
      }),
    );
    ids.push(
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber,
        itemNumber: 3,
        options: ['가', '나', '다', '라'],
        answer: 1, // correct 'a'
        extra: { explanation: '3번 설명' },
      }),
    );
    return ids;
  }

  it('grades right/wrong/skipped server-side, returns percentage+band+reveals', async () => {
    const [id1, id2, id3] = await seedThreeItemReadingMock(1000);
    const { agent } = await registerUser(t.app, pg.pool);

    // id1 correct ('b'), id2 wrong ('a' vs 'c'), id3 skipped (absent).
    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 1000,
      section: 'reading',
      answers: [
        { itemId: id1, picked: 'b', timeMs: 5000 },
        { itemId: id2, picked: 'a' },
      ],
      durationMs: 120000,
    });
    expect(res.status).toBe(200);
    expect(res.body.sourceTest).toBe(1000);
    expect(res.body.section).toBe('reading');
    expect(res.body.totalItems).toBe(3);
    expect(res.body.answered).toBe(2); // skipped item is NOT counted as answered
    expect(res.body.correct).toBe(1);
    expect(res.body.percentage).toBe(33.3); // 1/3 → 33.3 (1-dp)
    expect(res.body.band).toBe('Below L3'); // <40

    // Reveals: one per served item, in item_number order, answer revealed NOW.
    expect(res.body.items.map((r: { itemId: string }) => r.itemId)).toEqual([
      String(id1),
      String(id2),
      String(id3),
    ]);
    const [r1, r2, r3] = res.body.items;
    expect(r1).toMatchObject({ picked: 'b', correctChoiceId: 'b', isCorrect: true, explanation: '1번 설명' });
    expect(r2).toMatchObject({ picked: 'a', correctChoiceId: 'c', isCorrect: false, explanation: '2번 설명' });
    expect(r3).toMatchObject({ picked: null, correctChoiceId: 'a', isCorrect: false, explanation: '3번 설명' });
  });

  it('mock grading excludes picture-choice items so the graded universe matches the served set (P2-1)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const a = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 1200,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2, // correct 'b'
      extra: { explanation: 'A' },
    });
    const b = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 1200,
      itemNumber: 2,
      options: ['가', '나', '다', '라'],
      answer: 1, // correct 'a'
      extra: { explanation: 'B' },
    });
    // Picture-choice item in the SAME test — must be excluded from BOTH the
    // assembly and the grading universe (or scores grade against an item that
    // was never served).
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 1200,
      itemNumber: 3,
      options: ['①', '②', '③', '④'],
      answer: 1,
      hasImage: true,
      extra: { explanation: 'PIC' },
    });

    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 1200,
      section: 'listening',
      answers: [
        { itemId: a, picked: 'b' },
        { itemId: b, picked: 'a' },
      ],
    });
    expect(res.status).toBe(200);
    // 2, not 3 — the picture item is not in the graded universe.
    expect(res.body.totalItems).toBe(2);
    expect(res.body.correct).toBe(2);
    expect(
      (res.body.items as Array<{ itemId: string }>).map((r) => r.itemId),
    ).toEqual([String(a), String(b)]);
  });

  it("writes one topik_responses(mode='mock') row per ANSWERED item, server-computed is_correct", async () => {
    const [id1, id2, id3] = await seedThreeItemReadingMock(1001);
    const { agent, userId } = await registerUser(t.app, pg.pool);

    await agent.post('/topik/mock/submit').send({
      sourceTest: 1001,
      section: 'reading',
      answers: [
        { itemId: id1, picked: 'b', timeMs: 3000 }, // correct
        { itemId: id2, picked: 'd' }, // wrong
      ],
    });

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
         FROM topik_responses
        ORDER BY topik_item_id`,
    );
    // Two rows (the skipped id3 is NOT logged), both mode='mock', user-scoped.
    expect(log.rows.length).toBe(2);
    for (const r of log.rows) {
      expect(r.user_id).toBe(String(userId));
      expect(r.mode).toBe('mock');
    }
    const byItem = new Map(log.rows.map((r) => [r.topik_item_id, r]));
    expect(byItem.get(String(id1))).toMatchObject({ picked: 'b', is_correct: true, time_ms: 3000 });
    expect(byItem.get(String(id2))).toMatchObject({ picked: 'd', is_correct: false, time_ms: null });
    expect(byItem.has(String(id3))).toBe(false);
  });

  it('computes the band from percentage (all correct → On track for L5+)', async () => {
    const [id1, id2, id3] = await seedThreeItemReadingMock(1002);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 1002,
      section: 'reading',
      answers: [
        { itemId: id1, picked: 'b' },
        { itemId: id2, picked: 'c' },
        { itemId: id3, picked: 'a' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(3);
    expect(res.body.percentage).toBe(100);
    expect(res.body.band).toBe('On track for L5+');
  });

  it('is user-scoped — two users submitting the same mock each write their own rows', async () => {
    const [id1] = await seedThreeItemReadingMock(1003);
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);

    await a.agent.post('/topik/mock/submit').send({
      sourceTest: 1003,
      section: 'reading',
      answers: [{ itemId: id1, picked: 'b' }],
    });
    await b.agent.post('/topik/mock/submit').send({
      sourceTest: 1003,
      section: 'reading',
      answers: [{ itemId: id1, picked: 'a' }],
    });

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

  it('ignores a pick for an item NOT in the served section/test', async () => {
    const [id1] = await seedThreeItemReadingMock(1004);
    // A foreign item in a different test — a pick for it must not be graded/logged.
    const foreign = await seedTopikItem(pg.pool, { section: 'reading', testNumber: 1005, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 1004,
      section: 'reading',
      answers: [
        { itemId: id1, picked: 'b' },
        { itemId: foreign, picked: 'a' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(3); // only the 1004 section items
    expect(res.body.answered).toBe(1); // the foreign pick is ignored

    const log = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM topik_responses`);
    expect(log.rows[0]?.n).toBe('1'); // foreign pick not logged
  });

  it('404s when the test/section has no gradeable items', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 9999,
      section: 'reading',
      answers: [{ itemId: 1, picked: 'a' }],
    });
    expect(res.status).toBe(404);
  });

  it('rejects the writing section with 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 1000,
      section: 'writing',
      answers: [{ itemId: 1, picked: 'a' }],
    });
    expect(res.status).toBe(400);
  });

  it('accepts an empty answers array (timed-out blank exam) — grades all skipped, reveals the key', async () => {
    await seedThreeItemReadingMock(1006);
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 1006,
      section: 'reading',
      answers: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(3);
    expect(res.body.answered).toBe(0);
    expect(res.body.correct).toBe(0);
    // Every item is revealed (so the learner sees what they missed), all skipped.
    expect(res.body.items.length).toBe(3);
    for (const r of res.body.items) {
      expect(r.picked).toBeNull();
      expect(r.isCorrect).toBe(false);
      expect(typeof r.correctChoiceId).toBe('string'); // the answer key is revealed
    }
    // Nothing answered → no analytics rows written.
    const log = await pg.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM topik_responses`);
    expect(log.rows[0]?.n).toBe('0');
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

describe('D-1 — a mock is ONE exam paper, never a TOPIK I + TOPIK II merge (migration 029)', () => {
  /**
   * The exact live-verified failure state: both a TOPIK-I and a TOPIK-II paper
   * of the SAME sitting (test_number) in the same section — 029 widened the
   * natural key precisely to allow this. A test-number-only mock merges them.
   */
  async function seedTwoPapers(testNumber: number): Promise<{
    topikI: number[];
    topikII: number[];
  }> {
    const topikI = [
      await seedTopikItemAtLevel('TOPIK I', { testNumber, itemNumber: 1, answer: 1 }),
      await seedTopikItemAtLevel('TOPIK I', { testNumber, itemNumber: 2, answer: 2 }),
    ];
    const topikII = [
      await seedTopikItemAtLevel('TOPIK II', { testNumber, itemNumber: 1, answer: 3 }),
      await seedTopikItemAtLevel('TOPIK II', { testNumber, itemNumber: 2, answer: 4 }),
    ];
    return { topikI, topikII };
  }

  it('POST /mock with an explicit sourceTest serves ONE paper (no duplicate item numbers)', async () => {
    const { topikII } = await seedTwoPapers(2100);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 2100, section: 'reading' });
    expect(res.status).toBe(200);
    // 2 items, not the 4-item TOPIK I/II chimera — and each item_number once.
    expect(res.body.items.length).toBe(2);
    expect(res.body.items.map((i: { number: number }) => i.number)).toEqual([1, 2]);
    // The deterministic default paper is TOPIK II, echoed on the wire.
    expect(res.body.topikLevel).toBe('TOPIK II');
    expect(res.body.sourceTest).toBe(2100);
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id).sort()).toEqual(
      topikII.map(String).sort(),
    );
  });

  it('an explicit topikLevel selects that paper', async () => {
    const { topikI } = await seedTwoPapers(2101);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent
      .post('/topik/mock')
      .send({ sourceTest: 2101, section: 'reading', topikLevel: 'TOPIK I' });
    expect(res.status).toBe(200);
    expect(res.body.topikLevel).toBe('TOPIK I');
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id).sort()).toEqual(
      topikI.map(String).sort(),
    );
  });

  it('/mock/submit grades EXACTLY the paper /mock served (shared resolver, level omitted)', async () => {
    const { topikI, topikII } = await seedTwoPapers(2102);
    const { agent } = await registerUser(t.app, pg.pool);

    // Same body shape an old client sends: no topikLevel. Grading universe must
    // be the served (TOPIK II) paper — 2 items, not 4, and never TOPIK I rows.
    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 2102,
      section: 'reading',
      answers: [{ itemId: topikII[0], picked: 'c' }], // answer=3 → correct
    });
    expect(res.status).toBe(200);
    expect(res.body.topikLevel).toBe('TOPIK II');
    expect(res.body.totalItems).toBe(2);
    expect(res.body.correct).toBe(1);
    const revealIds = (res.body.items as Array<{ itemId: string }>).map((r) => r.itemId).sort();
    expect(revealIds).toEqual(topikII.map(String).sort());
    for (const id of topikI) expect(revealIds).not.toContain(String(id));
  });

  it('/mock/submit honors an explicit topikLevel (TOPIK I paper graded)', async () => {
    const { topikI } = await seedTwoPapers(2103);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 2103,
      section: 'reading',
      topikLevel: 'TOPIK I',
      answers: [{ itemId: topikI[0], picked: 'a' }], // answer=1 → correct
    });
    expect(res.status).toBe(200);
    expect(res.body.topikLevel).toBe('TOPIK I');
    expect(res.body.totalItems).toBe(2);
    expect(res.body.correct).toBe(1);
    expect((res.body.items as Array<{ itemId: string }>).map((r) => r.itemId).sort()).toEqual(
      topikI.map(String).sort(),
    );
  });

  it('server-picked default (sourceTest omitted) resolves one paper deterministically', async () => {
    await seedTwoPapers(2104);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body.sourceTest).toBe(2104);
    expect(res.body.topikLevel).toBe('TOPIK II'); // highest test, TOPIK II preferred
    expect(res.body.items.length).toBe(2);
  });

  it('GET /items narrows to one paper via topik_level (and spans both without it — browse)', async () => {
    const { topikI } = await seedTwoPapers(2105);
    const { agent } = await registerUser(t.app, pg.pool);

    // Browse without the discriminator deliberately spans the sitting's papers.
    const merged = await agent.get('/topik/items').query({ source_test: 2105 });
    expect(merged.status).toBe(200);
    expect(merged.body.total).toBe(4);

    const onePaper = await agent
      .get('/topik/items')
      .query({ source_test: 2105, topik_level: 'TOPIK I' });
    expect(onePaper.status).toBe(200);
    expect(onePaper.body.total).toBe(2);
    expect((onePaper.body.items as Array<{ id: string }>).map((i) => i.id).sort()).toEqual(
      topikI.map(String).sort(),
    );
  });
});

describe('numeric-bound validation — garbage ids 400 at the boundary, never 500', () => {
  // Without .max() bounds, these coerce to numbers Postgres cannot hold
  // (INT4/INT8 overflow, pg error 22003) and surface as 500s where every other
  // garbage id in the API contract is a 400/404.
  const HUGE = '99999999999999999999'; // 1e20 — Number.isInteger() still true
  const OVER_INT4 = 3_000_000_000; // > 2^31-1, fits int8 but not INTEGER

  it('GET /topik/items?source_test=<1e20> → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/items').query({ source_test: HUGE });
    expect(res.status).toBe(400);
  });

  it('POST /topik/mock with sourceTest above INT4 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/topik/mock')
      .send({ section: 'reading', sourceTest: OVER_INT4 });
    expect(res.status).toBe(400);
  });

  it('POST /topik/mock/submit with sourceTest above INT4 → 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/topik/mock/submit')
      .send({ sourceTest: OVER_INT4, section: 'reading', answers: [] });
    expect(res.status).toBe(400);
  });

  it('POST /topik/mock/submit with an answer itemId beyond MAX_SAFE_INTEGER → 400', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 2200, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock/submit').send({
      sourceTest: 2200,
      section: 'reading',
      answers: [{ itemId: Number(HUGE), picked: 'a' }],
    });
    expect(res.status).toBe(400);
  });

  it('POST /topik/<1e20>/answer → 400 (BIGINT id, not a 500)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post(`/topik/${HUGE}/answer`).send({ picked: 'a' });
    expect(res.status).toBe(400);
  });
});

describe('served-but-unanswerable exclusions (data sweep D-2 / D-5)', () => {
  const NO_TRANSCRIPT_STEM =
    '[듣기 지문 없음 — 대화/담화가 오디오로만 제공됨(전사 파일 없음)]';
  const WITHHELD_PASSAGE =
    '[저작권 관련 법령에 따라 본 문항의 지문은 공개하지 않습니다. 지문 내용은 원저작자의 요청으로 제공되지 않습니다.]';

  it('D-2: no-transcript listening items never reach study/mock/browse and 404 on /answer', async () => {
    const normal = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 2300,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
    });
    // Real options + a real answer key, but the only "question" is the curator
    // note that the audio was never transcribed — the D-2 class.
    const noTranscript = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 2300,
      itemNumber: 2,
      stem: NO_TRANSCRIPT_STEM,
      prompt: null,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const { agent } = await registerUser(t.app, pg.pool);

    const study = await agent.post('/topik/study').send({ section: 'listening', limit: 50 });
    expect(study.status).toBe(200);
    const studyIds = (study.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(studyIds).toContain(String(normal));
    expect(studyIds).not.toContain(String(noTranscript));

    const mock = await agent
      .post('/topik/mock')
      .send({ sourceTest: 2300, section: 'listening' });
    expect(mock.status).toBe(200);
    expect((mock.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
      String(normal),
    ]);

    // Browse: excluded from BOTH the page and total (the guard is in SQL).
    const browse = await agent.get('/topik/items').query({ source_test: 2300 });
    expect(browse.status).toBe(200);
    expect(browse.body.total).toBe(1);
    expect((browse.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
      String(normal),
    ]);

    // Direct answer-by-id: the render-time guard 404s and logs nothing.
    const answer = await agent.post(`/topik/${noTranscript}/answer`).send({ picked: 'a' });
    expect(answer.status).toBe(404);
    const log = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM topik_responses`,
    );
    expect(log.rows[0]?.n).toBe('0');
  });

  it('D-5: items whose shared passage is the copyright-withholding notice are excluded from serve AND grading', async () => {
    const normal = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 2301,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
    });
    // Two comprehension items asking about a passage the corpus deliberately
    // withholds — the "passage" is a notice that the passage is not disclosed.
    const withheldA = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 2301,
      itemNumber: 23,
      stem: '밑줄 친 부분에 나타난 나의 심정으로 가장 알맞은 것을 고르십시오.',
      prompt: null,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    const withheldB = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 2301,
      itemNumber: 24,
      stem: '윗글의 내용과 같은 것을 고르십시오.',
      prompt: null,
      options: ['가', '나', '다', '라'],
      answer: 4,
    });
    await pg.pool.query(
      `UPDATE topik_tests SET passages = $1::jsonb WHERE test_number = $2`,
      [JSON.stringify({ '23-24': WITHHELD_PASSAGE }), 2301],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    // Mock serve: only the answerable item.
    const mock = await agent.post('/topik/mock').send({ sourceTest: 2301, section: 'reading' });
    expect(mock.status).toBe(200);
    expect((mock.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
      String(normal),
    ]);

    // Grading universe agrees with the served set (mock ↔ submit coherence).
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 2301,
      section: 'reading',
      answers: [{ itemId: normal, picked: 'b' }],
    });
    expect(submit.status).toBe(200);
    expect(submit.body.totalItems).toBe(1);
    expect(submit.body.correct).toBe(1);

    // Study draw excludes them too.
    const study = await agent.post('/topik/study').send({ section: 'reading', limit: 50 });
    const studyIds = (study.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(studyIds).not.toContain(String(withheldA));
    expect(studyIds).not.toContain(String(withheldB));

    // Browse page excludes them. Documented residual: `total` is a pure SQL
    // count and cannot resolve passage-range keys, so it still counts the two
    // withheld rows (3) while the page serves only the answerable one.
    const browse = await agent.get('/topik/items').query({ source_test: 2301 });
    expect((browse.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
      String(normal),
    ]);
    expect(browse.body.total).toBe(3);
  });
});

describe('TOPIK mock audio (F-119 Phase 5) — item spans + envelope audioUrl', () => {
  const NO_TRANSCRIPT_STEM =
    '[듣기 지문 없음 — 대화/담화가 오디오로만 제공됨(전사 파일 없음)]';

  /** Write an item's (audio_start_ms, audio_end_ms) window — migration 078. */
  async function setAudioSpan(itemId: number, startMs: number, endMs: number): Promise<void> {
    await pg.pool.query(
      `UPDATE topik_items SET audio_start_ms = $2, audio_end_ms = $3 WHERE id = $1`,
      [itemId, startMs, endMs],
    );
  }

  /** Map a paper's whole-section MP3 (topik_tests.audio_path — migration 078). */
  async function setTestAudioPath(
    testNumber: number,
    topikLevel: 'TOPIK I' | 'TOPIK II',
    audioPath: string,
  ): Promise<void> {
    await pg.pool.query(
      `UPDATE topik_tests SET audio_path = $3
        WHERE test_number = $1 AND topik_level = $2 AND section = 'listening'::topik_section`,
      [testNumber, topikLevel, audioPath],
    );
  }

  it('mock items carry audioStartMs/audioEndMs (both-or-neither), paired items share one span, and the envelope names the paper stream', async () => {
    // Item 1's span starts at 0 — proves the mapper checks null-ness, not
    // truthiness (a 0 start must still emit).
    const q1 = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3100,
      itemNumber: 1,
    });
    await setAudioSpan(q1, 0, 10_000);
    // A paired dialogue (one recording, two questions — Q21/22) carries the
    // IDENTICAL span on both items (078's deliberate denormalization).
    const q21 = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3100,
      itemNumber: 21,
    });
    const q22 = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3100,
      itemNumber: 22,
    });
    await setAudioSpan(q21, 60_000, 95_000);
    await setAudioSpan(q22, 60_000, 95_000);
    // An unmapped item: no span → NEITHER field on the wire.
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 3100, itemNumber: 30 });
    await setTestAudioPath(
      3100,
      'TOPIK II',
      'TOPIK TEST/3100 - Test/TOPIK-II/3100th-TOPIK-II-Listening-Audio.mp3',
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 3100, section: 'listening' });
    expect(res.status).toBe(200);
    // ONE URL per exam — the items' windows index into it. TOPIK II → /2.
    expect(res.body.audioUrl).toBe('/topik/audio/3100/2');

    const items = res.body.items as Array<{
      number: number;
      audioStartMs?: number;
      audioEndMs?: number;
    }>;
    expect(items.map((i) => i.number)).toEqual([1, 21, 22, 30]);

    const [i1, i21, i22, i30] = items;
    expect(i1!.audioStartMs).toBe(0);
    expect(i1!.audioEndMs).toBe(10_000);
    // Paired items: identical spans on both.
    expect(i21!.audioStartMs).toBe(60_000);
    expect(i21!.audioEndMs).toBe(95_000);
    expect(i22!.audioStartMs).toBe(i21!.audioStartMs);
    expect(i22!.audioEndMs).toBe(i21!.audioEndMs);
    // Both-or-neither: the unmapped item carries NEITHER key.
    expect(i30).not.toHaveProperty('audioStartMs');
    expect(i30).not.toHaveProperty('audioEndMs');

    // The answer-strip is UNCHANGED by the audio fields: no `explanation`, no
    // `correct` anywhere on the wire (the span rides like hasImage/passage).
    for (const item of res.body.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('explanation');
      expect(JSON.stringify(item)).not.toContain('correct');
      for (const opt of item['options'] as Array<Record<string, unknown>>) {
        expect(Object.keys(opt).sort()).toEqual(['en', 'id', 'kr']);
      }
    }
  });

  it('study/browse DTOs carry the span too (question metadata on every item surface)', async () => {
    const q1 = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3105,
      itemNumber: 1,
    });
    await setAudioSpan(q1, 5_000, 20_000);
    const { agent } = await registerUser(t.app, pg.pool);

    const browse = await agent.get('/topik/items').query({ source_test: 3105 });
    expect(browse.status).toBe(200);
    expect(browse.body.items[0].audioStartMs).toBe(5_000);
    expect(browse.body.items[0].audioEndMs).toBe(20_000);
  });

  it('audioUrl uses /1 for a TOPIK I paper and is null when the paper has no audio_path', async () => {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3101,
      itemNumber: 1,
      topikLevel: 'TOPIK I',
    });
    await setTestAudioPath(
      3101,
      'TOPIK I',
      'TOPIK TEST/3101 - Test/TOPIK-I/3101th-TOPIK-I-Listening-Audio.mp3',
    );
    // A paper WITHOUT a mapped MP3 — envelope must say null, not fabricate a URL.
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 3102, itemNumber: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const topikI = await agent
      .post('/topik/mock')
      .send({ sourceTest: 3101, topikLevel: 'TOPIK I', section: 'listening' });
    expect(topikI.status).toBe(200);
    expect(topikI.body.audioUrl).toBe('/topik/audio/3101/1');

    const noAudio = await agent
      .post('/topik/mock')
      .send({ sourceTest: 3102, section: 'listening' });
    expect(noAudio.status).toBe(200);
    expect(noAudio.body.audioUrl).toBeNull();

    // The empty-resolve envelope (unknown paper) is null too.
    const unknown = await agent
      .post('/topik/mock')
      .send({ sourceTest: 999_999, section: 'listening' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
    expect(unknown.body.audioUrl).toBeNull();
  });

  it('D-2 re-admission (decision #1): a placeholder-stem item WITH an audio span is served + answerable everywhere; one WITHOUT stays excluded', async () => {
    const normal = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3103,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
    });
    // The D-2 placeholder — but its recording is now mapped, so the learner
    // LISTENS to the content the note stood in for: genuinely answerable.
    const readmitted = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3103,
      itemNumber: 2,
      stem: NO_TRANSCRIPT_STEM,
      prompt: null,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    await setAudioSpan(readmitted, 12_000, 30_000);
    // The same placeholder with NO span — still nothing to answer against.
    const stillExcluded = await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3103,
      itemNumber: 3,
      stem: NO_TRANSCRIPT_STEM,
      prompt: null,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    await setTestAudioPath(
      3103,
      'TOPIK II',
      'TOPIK TEST/3103 - Test/TOPIK-II/3103th-TOPIK-II-Listening-Audio.mp3',
    );
    const { agent } = await registerUser(t.app, pg.pool);

    // Mock serve: normal + re-admitted (with its span), NOT the span-less one.
    const mock = await agent.post('/topik/mock').send({ sourceTest: 3103, section: 'listening' });
    expect(mock.status).toBe(200);
    const mockItems = mock.body.items as Array<{
      id: string;
      audioStartMs?: number;
      audioEndMs?: number;
    }>;
    expect(mockItems.map((i) => i.id)).toEqual([String(normal), String(readmitted)]);
    expect(mockItems[1]!.audioStartMs).toBe(12_000);
    expect(mockItems[1]!.audioEndMs).toBe(30_000);

    // Grading universe agrees with the served set (mock ↔ submit coherence).
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 3103,
      section: 'listening',
      answers: [
        { itemId: normal, picked: 'b' },
        { itemId: readmitted, picked: 'a' },
      ],
    });
    expect(submit.status).toBe(200);
    expect(submit.body.totalItems).toBe(2);
    expect(submit.body.correct).toBe(2);

    // Browse: the SQL gate re-admits it in BOTH the page and total.
    const browse = await agent.get('/topik/items').query({ source_test: 3103 });
    expect(browse.status).toBe(200);
    expect(browse.body.total).toBe(2);
    expect((browse.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
      String(normal),
      String(readmitted),
    ]);

    // Study draw: re-admitted in, span-less placeholder out.
    const study = await agent.post('/topik/study').send({ section: 'listening', limit: 50 });
    expect(study.status).toBe(200);
    const studyIds = (study.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(studyIds).toContain(String(readmitted));
    expect(studyIds).not.toContain(String(stillExcluded));

    // /tests paper enumeration counts the re-admitted item.
    const tests = await agent.get('/topik/tests').query({ section: 'listening' });
    expect(tests.status).toBe(200);
    const paper = (
      tests.body.tests as Array<{ testNumber: number; itemCount: number }>
    ).find((p) => p.testNumber === 3103);
    expect(paper?.itemCount).toBe(2);

    // Direct answer-by-id: the render gate admits the re-admitted item (grades
    // + logs) and still 404s the span-less placeholder without logging.
    const graded = await agent.post(`/topik/${readmitted}/answer`).send({ picked: 'a' });
    expect(graded.status).toBe(200);
    expect(graded.body.correct).toBe(true);
    const blocked = await agent.post(`/topik/${stillExcluded}/answer`).send({ picked: 'a' });
    expect(blocked.status).toBe(404);
    const log = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM topik_responses WHERE mode = 'study'`,
    );
    expect(log.rows[0]?.n).toBe('1');
  });

  it('a READING mock never advertises an audio URL, even when its paper row carries a stray audio_path', async () => {
    // 078 deliberately does NOT CHECK-pin audio_path to listening rows (the
    // loader owns that scoping), so the envelope re-asserts it at render time:
    // a manual UPDATE putting audio_path on a reading paper must NOT make a
    // reading mock advertise the listening MP3 URL.
    await seedTopikItem(pg.pool, { section: 'reading', testNumber: 3104, itemNumber: 1 });
    await pg.pool.query(
      `UPDATE topik_tests SET audio_path = $3
        WHERE test_number = $1 AND topik_level = $2 AND section = 'reading'::topik_section`,
      [3104, 'TOPIK II', 'TOPIK TEST/3104 - Test/TOPIK-II/3104th-TOPIK-II-Listening-Audio.mp3'],
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock').send({ sourceTest: 3104, section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    // The key is PRESENT (stable envelope shape) and explicitly null.
    expect(res.body).toHaveProperty('audioUrl');
    expect(res.body.audioUrl).toBeNull();
  });

  it('the emitted audioUrl resolves to the Phase-4 streaming route (URL ↔ route contract, not just format)', async () => {
    // The envelope's URL must be a real route in THIS server, not a string that
    // happens to look right. The paper's audio_path names a file that does NOT
    // exist under the test corpus root, so a GET that reaches the Phase-4
    // route answers its UNIFORM 404 ('no audio for this unit' — the streamer's
    // deliberate non-oracle posture), while an Express route-miss would fall
    // through to the generic not-found handler with a different body.
    await seedTopikItem(pg.pool, { section: 'listening', testNumber: 3106, itemNumber: 1 });
    await setTestAudioPath(
      3106,
      'TOPIK II',
      'TOPIK TEST/3106 - Test/TOPIK-II/3106th-TOPIK-II-Listening-Audio.mp3',
    );
    const { agent } = await registerUser(t.app, pg.pool);

    const mock = await agent.post('/topik/mock').send({ sourceTest: 3106, section: 'listening' });
    expect(mock.status).toBe(200);
    expect(mock.body.audioUrl).toBe('/topik/audio/3106/2');

    const audio = await agent.get(mock.body.audioUrl as string);
    expect(audio.status).toBe(404);
    expect((audio.body as { error: unknown }).error).toEqual({
      code: 'not_found',
      message: 'no audio for this unit',
    });
  });
});

describe('F-UP-014 — a delayed save cannot resurrect a submitted attempt (fresh-completed guard)', () => {
  /** Seed a 1-item reading paper + save an in-progress attempt for it. */
  async function seedAndSave(
    agent: Awaited<ReturnType<typeof registerUser>>['agent'],
    testNumber: number,
  ): Promise<number> {
    const id = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
    });
    const save = await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: testNumber,
      currentIdx: 0,
      picks: { [String(id)]: 'b' },
      remainingMs: 999_000,
    });
    expect(save.status).toBe(204);
    return id;
  }

  it('the resurrect race: submit → mop-up DELETE → delayed same-paper PUT → still no resumable attempt', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const itemId = await seedAndSave(agent, 2400);

    // Submit the exam (grades + marks the attempt completed in one tx).
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 2400,
      section: 'reading',
      answers: [{ itemId, picked: 'b' }],
    });
    expect(submit.status).toBe(200);
    expect((await agent.get('/topik/attempt')).body.attempt).toBeNull();

    // The client's clearAttempt() mop-up — must NOT evict the completed row
    // whose freshness is the anti-resurrect guard (it only abandons ACTIVE rows).
    expect((await agent.delete('/topik/attempt')).status).toBe(204);

    // The racing save the server processed AFTER both deletes (the F-UP-014
    // window): same paper, pre-submit progress. It must be absorbed, not
    // resurrect a resume banner for a graded test.
    const delayed = await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 2400,
      currentIdx: 0,
      picks: { [String(itemId)]: 'b' },
      remainingMs: 998_000,
    });
    expect(delayed.status).toBe(204); // silently absorbed
    expect((await agent.get('/topik/attempt')).body.attempt).toBeNull(); // NOT resurrected
  });

  it('a PUT overlapping an OPEN submit transaction waits on the per-user advisory lock and is then refused', async () => {
    // The READ-COMMITTED window (Phase-2 G1 review, topik S-1): a PUT the
    // server processes while /mock/submit's transaction is still open takes
    // its guard snapshot BEFORE the submit commits — it sees no fresh
    // completed row, and the partial-unique arbiter's insert-retry after the
    // commit is NOT re-guarded, so pre-fix the PUT resurrected an active row
    // for the just-graded paper. Both writers now open with
    // pg_advisory_xact_lock(hashtextextended('topik_attempt:' || user_id, 0)),
    // so the racing PUT must BLOCK until the submit commits and then refuse.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const itemId = await seedAndSave(agent, 2405);

    // Simulate /mock/submit mid-flight: same lock, same close, tx held open.
    const submitTx = await pg.pool.connect();
    try {
      await submitTx.query('BEGIN');
      await submitTx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('topik_attempt:' || $1::text, 0))`,
        [userId],
      );
      await submitTx.query(
        `UPDATE topik_attempts SET status = 'completed', version = version + 1
          WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );

      // The racing same-paper PUT, dispatched while the submit tx is open.
      let putSettled = false;
      const putPromise = agent
        .put('/topik/attempt')
        .send({
          section: 'reading',
          sourceTest: 2405,
          currentIdx: 0,
          picks: { [String(itemId)]: 'b' },
          remainingMs: 998_000,
        })
        .then((r) => {
          putSettled = true;
          return r;
        });

      // It must be WAITING on the advisory lock, not completing against a
      // pre-commit snapshot.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(putSettled).toBe(false);

      await submitTx.query('COMMIT');
      const put = await putPromise;
      expect(put.status).toBe(204); // silently absorbed after the wait
    } finally {
      submitTx.release();
    }

    // The guard held: no resurrected active row, exactly the one completed row.
    expect((await agent.get('/topik/attempt')).body.attempt).toBeNull();
    const { rows } = await pg.pool.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM topik_attempts
        WHERE user_id = $1 GROUP BY status`,
      [userId],
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]))).toEqual({
      completed: 1,
    });
  });

  it('a save for a DIFFERENT paper right after submit wins (new mocks are never blocked)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const itemId = await seedAndSave(agent, 2401);
    await agent.post('/topik/mock/submit').send({
      sourceTest: 2401,
      section: 'reading',
      answers: [{ itemId, picked: 'b' }],
    });

    // Immediately start a different test — its save must overwrite the tombstone.
    const save = await agent.put('/topik/attempt').send({
      section: 'listening',
      sourceTest: 2402,
      currentIdx: 1,
      picks: {},
      remainingMs: 1_800_000,
    });
    expect(save.status).toBe(204);
    expect((await agent.get('/topik/attempt')).body.attempt).toMatchObject({
      section: 'listening',
      sourceTest: 2402,
    });
  });

  it('a STALE completed attempt yields — retaking the same paper later saves normally', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const itemId = await seedAndSave(agent, 2403);
    await agent.post('/topik/mock/submit').send({
      sourceTest: 2403,
      section: 'reading',
      answers: [{ itemId, picked: 'b' }],
    });

    // Age the completed attempt past the grace window. The updated_at trigger
    // would stamp now() on any UPDATE, so it is disabled around the backdate.
    await pg.pool.query(
      `ALTER TABLE topik_attempts DISABLE TRIGGER trg_topik_attempts_updated_at`,
    );
    try {
      await pg.pool.query(
        `UPDATE topik_attempts SET updated_at = now() - interval '60 seconds'
          WHERE user_id = $1`,
        [userId],
      );
    } finally {
      await pg.pool.query(
        `ALTER TABLE topik_attempts ENABLE TRIGGER trg_topik_attempts_updated_at`,
      );
    }

    // A later retake of the SAME paper saves + resumes normally.
    const save = await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 2403,
      currentIdx: 0,
      picks: {},
      remainingMs: 3_600_000,
    });
    expect(save.status).toBe(204);
    expect((await agent.get('/topik/attempt')).body.attempt).toMatchObject({
      section: 'reading',
      sourceTest: 2403,
    });
  });

  it('non-numeric picks keys cannot be smuggled from the wire (the pre-046 tombstone key shape)', async () => {
    // Lifecycle now lives in the status column, but the picks-key regex guard
    // (^\d+$) remains load-bearing: picks must stay a pure itemId→choice map.
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 1,
      currentIdx: 0,
      picks: { __closed__: 'a' },
      remainingMs: 1,
    });
    expect(res.status).toBe(400);
  });
});

describe('A1 (046) — attempt history: completed/abandoned attempts are retained', () => {
  /** Seed a 1-item reading paper + save an in-progress attempt for it. */
  async function seedAndSave(
    agent: Awaited<ReturnType<typeof registerUser>>['agent'],
    testNumber: number,
  ): Promise<number> {
    const id = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
      extra: { explanation: 'x' },
    });
    const save = await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: testNumber,
      currentIdx: 0,
      picks: { [String(id)]: 'b' },
      remainingMs: 999_000,
    });
    expect(save.status).toBe(204);
    return id;
  }

  it('a submitted mock is RETAINED as a completed attempt — the whole point of A1', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const itemId = await seedAndSave(agent, 3100);
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 3100,
      section: 'reading',
      answers: [{ itemId, picked: 'b' }],
    });
    expect(submit.status).toBe(200);

    // The resume banner no longer offers it…
    expect((await agent.get('/topik/attempt')).body.attempt).toBeNull();
    // …but the row SURVIVES as history: status='completed', no tombstone key
    // in picks (the lifecycle is a column now, not payload).
    const { rows } = await pg.pool.query<{
      status: string;
      source_test: number;
      picks: Record<string, string>;
    }>(
      `SELECT status, source_test, picks FROM topik_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'completed', source_test: 3100 });
    expect(Object.keys(rows[0]!.picks)).not.toContain('__closed__');
  });

  it('completed attempts ACCUMULATE across mocks, with only ever one active row per user', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Two full save→submit cycles on different papers.
    const item1 = await seedAndSave(agent, 3101);
    await agent.post('/topik/mock/submit').send({
      sourceTest: 3101,
      section: 'reading',
      answers: [{ itemId: item1, picked: 'b' }],
    });
    const item2 = await seedAndSave(agent, 3102);
    await agent.post('/topik/mock/submit').send({
      sourceTest: 3102,
      section: 'reading',
      answers: [{ itemId: item2, picked: 'a' }],
    });

    const { rows } = await pg.pool.query<{ status: string; source_test: number }>(
      `SELECT status, source_test FROM topik_attempts
        WHERE user_id = $1 ORDER BY source_test`,
      [userId],
    );
    expect(rows).toEqual([
      expect.objectContaining({ status: 'completed', source_test: 3101 }),
      expect.objectContaining({ status: 'completed', source_test: 3102 }),
    ]);

    // A third mock in progress: exactly ONE active row, alongside the history.
    await seedAndSave(agent, 3103);
    const counts = await pg.pool.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM topik_attempts
        WHERE user_id = $1 GROUP BY status`,
      [userId],
    );
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)]));
    expect(byStatus).toEqual({ active: 1, completed: 2 });
  });

  it("submit stamps the responses' attempt_id — answers group into their sitting", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const itemId = await seedAndSave(agent, 3104);
    await agent.post('/topik/mock/submit').send({
      sourceTest: 3104,
      section: 'reading',
      answers: [{ itemId, picked: 'b' }],
    });

    const attempt = await pg.pool.query<{ id: string }>(
      `SELECT id FROM topik_attempts WHERE user_id = $1 AND status = 'completed'`,
      [userId],
    );
    expect(attempt.rows).toHaveLength(1);
    const responses = await pg.pool.query<{ attempt_id: string | null; mode: string }>(
      `SELECT attempt_id, mode FROM topik_responses WHERE user_id = $1`,
      [userId],
    );
    expect(responses.rows).toHaveLength(1);
    expect(responses.rows[0]!.mode).toBe('mock');
    expect(responses.rows[0]!.attempt_id).toBe(attempt.rows[0]!.id);
  });

  it('a submit with NO saved progress still records a completed attempt (responses never orphaned)', async () => {
    const itemId = await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 3105,
      itemNumber: 1,
      options: ['가', '나', '다', '라'],
      answer: 2,
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Straight to submit — the progress PUT never fired.
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 3105,
      section: 'reading',
      answers: [{ itemId, picked: 'b' }],
    });
    expect(submit.status).toBe(200);

    const attempt = await pg.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM topik_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(attempt.rows).toHaveLength(1);
    expect(attempt.rows[0]!.status).toBe('completed');
    const responses = await pg.pool.query<{ attempt_id: string | null }>(
      `SELECT attempt_id FROM topik_responses WHERE user_id = $1`,
      [userId],
    );
    expect(responses.rows).toEqual([{ attempt_id: attempt.rows[0]!.id }]);
  });

  it('DELETE abandons (status=abandoned, retained as history) and never blocks an immediate retake', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedAndSave(agent, 3106);
    expect((await agent.delete('/topik/attempt')).status).toBe(204);

    // Gone from the resume banner, but kept as an abandoned history row.
    expect((await agent.get('/topik/attempt')).body.attempt).toBeNull();
    const { rows } = await pg.pool.query<{ status: string }>(
      `SELECT status FROM topik_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toEqual([{ status: 'abandoned' }]);

    // Abandon must NOT arm the F-UP-014 guard — restarting the SAME paper
    // immediately is a legitimate flow and saves normally.
    const resave = await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 3106,
      currentIdx: 0,
      picks: {},
      remainingMs: 3_600_000,
    });
    expect(resave.status).toBe(204);
    expect((await agent.get('/topik/attempt')).body.attempt).toMatchObject({
      sourceTest: 3106,
    });
  });

  it('the DB itself rejects a second active attempt per user (partial unique index)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedAndSave(agent, 3107);
    await expect(
      pg.pool.query(
        `INSERT INTO topik_attempts
           (user_id, section, source_test, current_idx, picks, remaining_ms)
         VALUES ($1, 'reading'::topik_section, 3108, 0, '{}'::jsonb, 100)`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });
});

describe('GET /topik/attempts — completed-attempt history (F-104 / A1)', () => {
  /** Seed a 3-item reading mock under one test; answers are b/c/a (2/3/1). */
  async function seedThreeItemReadingMockAt(testNumber: number): Promise<number[]> {
    const ids: number[] = [];
    ids.push(
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber,
        itemNumber: 1,
        options: ['가', '나', '다', '라'],
        answer: 2, // correct 'b'
      }),
    );
    ids.push(
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber,
        itemNumber: 2,
        options: ['가', '나', '다', '라'],
        answer: 3, // correct 'c'
      }),
    );
    ids.push(
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber,
        itemNumber: 3,
        options: ['가', '나', '다', '라'],
        answer: 1, // correct 'a'
      }),
    );
    return ids;
  }

  it('returns a completed attempt with the correct score + the re-derived topikLevel/totalItems', async () => {
    const [id1, id2] = await seedThreeItemReadingMockAt(2000);
    const { agent } = await registerUser(t.app, pg.pool);

    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 2000,
      section: 'reading',
      answers: [
        { itemId: id1, picked: 'b' }, // correct
        { itemId: id2, picked: 'a' }, // wrong
      ],
    });
    expect(submit.status).toBe(200);

    const res = await agent.get('/topik/attempts');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.attempts.length).toBe(1);
    const a = res.body.attempts[0];
    expect(a.section).toBe('읽기'); // enum → Korean
    expect(a.sourceTest).toBe(2000);
    expect(a.topikLevel).toBe('TOPIK II'); // seedTopikItem defaults to TOPIK II
    expect(a.correct).toBe(1);
    expect(a.totalItems).toBe(3); // the 3-item mock's served total
    expect(typeof a.attemptId).toBe('string');
    expect(typeof a.completedAt).toBe('string');
  });

  it('is user-scoped (no IDOR) — another user never sees these attempts', async () => {
    const [id1] = await seedThreeItemReadingMockAt(2001);
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await a.agent.post('/topik/mock/submit').send({
      sourceTest: 2001,
      section: 'reading',
      answers: [{ itemId: id1, picked: 'b' }],
    });

    const resB = await b.agent.get('/topik/attempts');
    expect(resB.status).toBe(200);
    expect(resB.body.attempts).toEqual([]);
    expect(resB.body.total).toBe(0);

    const resA = await a.agent.get('/topik/attempts');
    expect(resA.body.attempts.length).toBe(1);
  });

  it('empty case: no completed attempts → 200 with an empty list', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/attempts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attempts: [], total: 0 });
  });

  it('excludes an in-progress (active) attempt — only completed rows are history', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.put('/topik/attempt').send({
      section: 'reading',
      sourceTest: 2002,
      currentIdx: 0,
      picks: {},
      remainingMs: 1000,
    });
    const res = await agent.get('/topik/attempts');
    expect(res.status).toBe(200);
    expect(res.body.attempts).toEqual([]);
  });

  it('an all-skipped submit still records history: correct=0, totalItems re-derived from the corpus', async () => {
    await seedThreeItemReadingMockAt(2003);
    const { agent } = await registerUser(t.app, pg.pool);
    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 2003,
      section: 'reading',
      answers: [],
    });
    expect(submit.status).toBe(200);

    const res = await agent.get('/topik/attempts');
    expect(res.status).toBe(200);
    expect(res.body.attempts.length).toBe(1);
    expect(res.body.attempts[0]).toMatchObject({
      sourceTest: 2003,
      topikLevel: 'TOPIK II',
      correct: 0,
      totalItems: 3,
    });
  });

  it('orders newest-first and honors limit/offset paging', async () => {
    const [x1] = await seedThreeItemReadingMockAt(2010);
    const [y1] = await seedThreeItemReadingMockAt(2011);
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.post('/topik/mock/submit').send({
      sourceTest: 2010,
      section: 'reading',
      answers: [{ itemId: x1, picked: 'b' }],
    });
    await agent.post('/topik/mock/submit').send({
      sourceTest: 2011,
      section: 'reading',
      answers: [{ itemId: y1, picked: 'b' }],
    });

    const page1 = await agent.get('/topik/attempts').query({ limit: 1, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(2);
    expect(page1.body.attempts.length).toBe(1);
    expect(page1.body.attempts[0].sourceTest).toBe(2011); // most recently completed first

    const page2 = await agent.get('/topik/attempts').query({ limit: 1, offset: 1 });
    expect(page2.body.attempts.length).toBe(1);
    expect(page2.body.attempts[0].sourceTest).toBe(2010);
  });

  it.each([['limit=0'], ['limit=101'], ['offset=-1']])(
    '%s → 400 (paging out of bounds)',
    async (qs) => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.get(`/topik/attempts?${qs}`);
      expect(res.status).toBe(400);
    },
  );

  // F-122 update: before migration 066, a completed attempt carried NO
  // persisted topik_level, so this scenario (the backing corpus edited away
  // post-completion) exercised `resolveServedTotal`'s null-fallback and
  // reported `topikLevel: null`. Since 066, `/mock/submit` stamps the REAL
  // resolved level on the attempt AT GRADING TIME — before this test's later
  // corpus edit — so the level is a verified fact, not a guess, and SURVIVES
  // the edit (reported as 'TOPIK II', never null). `totalItems` still falls
  // back to the answered count: the live item-count lookup is re-run against
  // the (now-edited) corpus every time and legitimately finds 0 answerable
  // items for that known level, so `Math.max` with the real answered count
  // is what keeps this a non-fabricated lower bound rather than reporting an
  // impossible 0-item completed exam.
  it('F-122: a persisted topik_level survives a later corpus edit; totalItems still falls back to the answered count', async () => {
    const [id1] = await seedThreeItemReadingMockAt(2050);
    const { agent } = await registerUser(t.app, pg.pool);

    const submit = await agent.post('/topik/mock/submit').send({
      sourceTest: 2050,
      section: 'reading',
      answers: [{ itemId: id1, picked: 'b' }], // correct
    });
    expect(submit.status).toBe(200);

    // Corpus edit: the backing items no longer satisfy ANSWERABLE_ITEM_SQL by
    // the time GET /topik/attempts runs — AFTER the level was already
    // stamped at submit time. Nulling `answer` (rather than DELETE) avoids
    // tripping fk_topik_responses_topik_item (topik_responses still
    // references these item ids for its own correct/answered aggregates,
    // which must stay intact and untouched by this edit).
    await pg.pool.query(
      `UPDATE topik_items SET answer = NULL WHERE topik_test_id IN (
         SELECT id FROM topik_tests
          WHERE test_number = 2050 AND section = 'reading'::topik_section
       )`,
    );

    const res = await agent.get('/topik/attempts');
    expect(res.status).toBe(200);
    expect(res.body.attempts.length).toBe(1);
    expect(res.body.attempts[0]).toMatchObject({
      sourceTest: 2050,
      topikLevel: 'TOPIK II', // a verified fact, stamped before the edit — never re-guessed to null
      correct: 1,
      // Only 1 answer was submitted (the other 2 items were skipped and
      // never logged to topik_responses — "only ANSWERED items are
      // logged"), so the honest fallback total is 1, never the original
      // 3-item exam size the (now-edited) corpus can no longer confirm.
      totalItems: 1,
    });
  });

  // Coverage for the GENUINE legacy fallback path: a pre-066 completed
  // attempt with NO persisted topik_level at all (simulated via a direct
  // row insert, since every route-created attempt from here on always gets
  // one). This is the scenario `resolveServedTotal`'s null-fallback exists
  // for today — the case above no longer exercises it.
  it('a pre-066 attempt with no persisted topik_level falls back to resolveServedTotal\'s guess (topikLevel + totalItems both re-derived)', async () => {
    const [id1] = await seedThreeItemReadingMockAt(2051);
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Simulate a legacy (pre-066) completed row: no topik_level, inserted
    // directly rather than through the route (every route path now stamps
    // one). attempt_id stamps the response so /topik/attempts' correct/
    // answered aggregate is non-zero, matching a real completed sitting.
    const { rows } = await pg.pool.query<{ id: string }>(
      `INSERT INTO topik_attempts
         (user_id, section, source_test, current_idx, picks, remaining_ms, status, topik_level)
       VALUES ($1, 'reading'::topik_section, 2051, 0, '{}'::jsonb, 0, 'completed', NULL)
       RETURNING id`,
      [userId],
    );
    const attemptId = rows[0]!.id;
    await pg.pool.query(
      `INSERT INTO topik_responses (user_id, topik_item_id, picked, is_correct, mode, attempt_id)
       VALUES ($1, $2, 'b', true, 'mock', $3)`,
      [userId, id1, attemptId],
    );

    const res = await agent.get('/topik/attempts');
    expect(res.status).toBe(200);
    const entry = (res.body.attempts as { sourceTest: number }[]).find(
      (a) => a.sourceTest === 2051,
    );
    expect(entry).toMatchObject({
      sourceTest: 2051,
      topikLevel: 'TOPIK II', // re-derived by resolveServedTotal's tie-break guess
      correct: 1,
      totalItems: 3, // the 3-item mock's served total, re-resolved from the intact corpus
    });
  });
});

describe('GET /topik/tests — enumerate available TOPIK papers (F-118)', () => {
  it('returns test_number/topikLevel/section/itemCount for a seeded paper', async () => {
    for (let n = 1; n <= 5; n++) {
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber: 3000,
        itemNumber: n,
        options: ['가', '나', '다', '라'],
        answer: 1,
      });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/tests');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tests).toEqual([
      { testNumber: 3000, topikLevel: 'TOPIK II', section: '읽기', itemCount: 5 },
    ]);
  });

  it('caps itemCount at the official 50-item mock size (F-UP-007 parity)', async () => {
    for (let n = 1; n <= 60; n++) {
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber: 3001,
        itemNumber: n,
        options: ['가', '나', '다', '라'],
        answer: 1,
      });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/tests');
    expect(res.status).toBe(200);
    expect(res.body.tests.length).toBe(1);
    expect(res.body.tests[0].itemCount).toBe(50); // capped, not the 60 that exist
  });

  it('excludes a paper with zero answerable items', async () => {
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 3002,
      itemNumber: 1,
      options: ['only-one'], // <2 options → unanswerable (survivor guard)
    });
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/tests');
    expect(res.status).toBe(200);
    expect(res.body.tests).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('filters by section and by topik_level (D-1: one test_number, two papers)', async () => {
    await seedTopikItem(pg.pool, {
      section: 'reading',
      testNumber: 3010,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    await seedTopikItem(pg.pool, {
      section: 'listening',
      testNumber: 3011,
      options: ['가', '나', '다', '라'],
      answer: 1,
    });
    await seedTopikItemAtLevel('TOPIK I', {
      testNumber: 3010,
      itemNumber: 1,
      section: 'reading',
    });
    const { agent } = await registerUser(t.app, pg.pool);

    const reading = await agent.get('/topik/tests').query({ section: 'reading' });
    expect(reading.status).toBe(200);
    expect(reading.body.total).toBe(2); // 3010/TOPIK II + 3010/TOPIK I — distinct papers
    for (const test of reading.body.tests as Array<{ section: string }>) {
      expect(test.section).toBe('읽기');
    }

    const topikI = await agent.get('/topik/tests').query({ topik_level: 'TOPIK I' });
    expect(topikI.status).toBe(200);
    expect(topikI.body.total).toBe(1);
    expect(topikI.body.tests[0]).toMatchObject({ testNumber: 3010, topikLevel: 'TOPIK I' });
  });

  it('paginates with limit/offset while total reflects the full filtered paper count', async () => {
    for (let n = 1; n <= 3; n++) {
      await seedTopikItem(pg.pool, {
        section: 'reading',
        testNumber: 3100 + n,
        options: ['가', '나', '다', '라'],
        answer: 1,
      });
    }
    const { agent } = await registerUser(t.app, pg.pool);
    const page1 = await agent.get('/topik/tests').query({ limit: 2, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.tests.length).toBe(2);
    const page2 = await agent.get('/topik/tests').query({ limit: 2, offset: 2 });
    expect(page2.body.tests.length).toBe(1);
  });

  it('rejects an unknown section value with 400', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/topik/tests').query({ section: 'bogus' });
    expect(res.status).toBe(400);
  });
});
