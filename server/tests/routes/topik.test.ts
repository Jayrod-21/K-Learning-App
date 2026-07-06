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
