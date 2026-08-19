/**
 * Per-route tests for the F-205 comprehension-check pair in
 * src/routes/reading.ts (reading_questions, migration 086):
 *
 *   GET  /reading/chapters/:chapterId/questions
 *   POST /reading/chapters/:chapterId/questions/generate
 *
 * Focus: the read gate (owned-or-shared parent, uniform 404 — the
 * chapter-detail route's exact posture) vs the STRICT owner gate on generate
 * (a paid call — a shared-book reader must not spend the owner's budget);
 * ships-empty (`{ questions: [] }` until generated); generate persists the
 * mocked proxy's set and returns the GET's DTO (correct + explanation inline,
 * 4 options, exactly one correct); idempotency ($0 second POST) vs
 * ?regenerate=true (replaces, fresh rows); the per-user daily cap against the
 * claude_usage ledger (429 BEFORE the Claude call); a passage-less chapter
 * (409); and a Claude failure persisting nothing (502, zero rows).
 *
 * The Claude proxy is the shared test stub (helpers/app.ts) with
 * generateReadingComprehension wrapped in a spy — NO live API is ever called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import {
  buildTestApp,
  makeStubProxy,
  teardownTestApp,
  type TestApp,
} from '../helpers/app.js';
import {
  registerUser,
  seedBookUpload,
  seedReadingChapter,
  seedReadingPassage,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import type { ClaudeProxy } from '../../src/services/claudeProxy.js';

let pg: PgHandle;
let t: TestApp;

/** Spy over the default stub's generateReadingComprehension so tests can
 *  count paid calls (idempotency = zero) and inspect the prose the route
 *  sent, while keeping the stub's deterministic output. */
const defaultGenerate = makeStubProxy().generateReadingComprehension;
const genSpy = vi.fn<ClaudeProxy['generateReadingComprehension']>(defaultGenerate);

beforeAll(async () => {
  pg = await startPostgres();
  t = buildTestApp({
    connectionString: pg.connectionString,
    claudeProxy: { generateReadingComprehension: genSpy },
  });
});

afterAll(async () => {
  await teardownTestApp(t);
  await stopPostgres(pg);
});

beforeEach(async () => {
  // reading_questions CASCADEs from reading_chapters (and, transitively, from
  // book_uploads/users) — listed explicitly for clarity like every other
  // suite. claude_usage is the daily-cap ledger the generate route counts, so
  // it must reset per test (its user_id FK is SET NULL, not CASCADE).
  await pg.pool.query(
    'TRUNCATE TABLE reading_questions, reading_passages, reading_chapters, book_uploads, claude_usage, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
  genSpy.mockClear();
  genSpy.mockImplementation(defaultGenerate);
});

/** users → book_uploads('literature','ready') → chapter (+2 passages). */
async function seedChapterWithProse(
  userId: number,
  opts: { title?: string | null; passages?: string[] } = {},
): Promise<{ uploadId: number; chapterId: number }> {
  const uploadId = await seedBookUpload(pg.pool, userId, {
    type: 'literature',
    status: 'ready',
  });
  const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
    chapterNumber: 1,
    title: opts.title === undefined ? '해와 달이 된 오누이' : opts.title,
  });
  const bodies = opts.passages ?? ['옛날 옛적에 오누이가 살았습니다.', '호랑이가 떡을 달라고 했습니다.'];
  for (const [i, body] of bodies.entries()) {
    await seedReadingPassage(pg.pool, chapterId, { passageNumber: i + 1, body });
  }
  return { uploadId, chapterId };
}

/** Insert one stored question directly (the pre-seed loader's write shape). */
async function insertQuestion(
  chapterId: number,
  questionNumber: number,
  correctIndex = 0,
): Promise<void> {
  const options = [0, 1, 2, 3].map((i) => ({
    text: `보기 ${questionNumber}-${i + 1}`,
    correct: i === correctIndex,
  }));
  await pg.pool.query(
    `INSERT INTO reading_questions
       (chapter_id, question_number, question_text, options, explanation, kind, model)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'comprehension', 'claude-sonnet-4-6')`,
    [
      chapterId,
      questionNumber,
      `질문 ${questionNumber}?`,
      JSON.stringify(options),
      `정답 설명 ${questionNumber}. Explanation ${questionNumber}.`,
    ],
  );
}

/** Spend N slots of the caller's daily generation budget (the claude_usage
 *  ledger the route counts — the real proxy writes one row per call). */
async function spendDailyBudget(userId: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await pg.pool.query(
      `INSERT INTO claude_usage (request_id, user_id, route, model, latency_ms)
       VALUES ($1, $2, 'reading_comprehension'::claude_route,
               'claude-sonnet-4-6'::claude_model, 5)`,
      [randomUUID(), userId],
    );
  }
}

describe('reading questions — auth required', () => {
  it('GET /reading/chapters/:id/questions unauthenticated → 401', async () => {
    const res = await request(t.app).get('/reading/chapters/1/questions');
    expect(res.status).toBe(401);
  });

  it('POST /reading/chapters/:id/questions/generate unauthenticated → 401', async () => {
    const res = await request(t.app).post('/reading/chapters/1/questions/generate');
    expect(res.status).toBe(401);
  });
});

describe('GET /reading/chapters/:chapterId/questions', () => {
  it('ships EMPTY: a chapter with no generated questions → 200 { questions: [] }', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);
    const res = await agent.get(`/reading/chapters/${chapterId}/questions`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
  });

  it('returns stored questions in question_number order, correct + explanation inline', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);
    // Seed out of order to prove the ORDER BY, not insertion order.
    await insertQuestion(chapterId, 2, 1);
    await insertQuestion(chapterId, 1, 0);

    const res = await agent.get(`/reading/chapters/${chapterId}/questions`);
    expect(res.status).toBe(200);
    const qs = res.body.questions as Array<{
      id: number;
      questionNumber: number;
      questionText: string;
      options: Array<{ text: string; correct: boolean }>;
      explanation: string;
      kind: string;
    }>;
    expect(qs.map((q) => q.questionNumber)).toEqual([1, 2]);
    expect(typeof qs[0]!.id).toBe('number');
    expect(qs[0]!.questionText).toBe('질문 1?');
    expect(qs[0]!.kind).toBe('comprehension');
    // The reveal payload rides inline (Diagnostic study mode's model).
    expect(qs[0]!.options).toHaveLength(4);
    expect(qs[0]!.options.filter((o) => o.correct)).toHaveLength(1);
    expect(qs[0]!.options[0]!.correct).toBe(true);
    expect(qs[1]!.options[1]!.correct).toBe(true);
    expect(qs[0]!.explanation).toContain('Explanation 1');
  });

  it("returns only THIS chapter's questions", async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { uploadId, chapterId } = await seedChapterWithProse(userId);
    const otherChapter = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 2,
    });
    await insertQuestion(chapterId, 1);
    await insertQuestion(otherChapter, 1);

    const res = await agent.get(`/reading/chapters/${chapterId}/questions`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
  });

  it("another user's PRIVATE chapter → 404 (IDOR: identical to missing)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(owner.userId);
    await insertQuestion(chapterId, 1);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(`/reading/chapters/${chapterId}/questions`);
    expect(res.status).toBe(404);
  });

  it('a non-existent chapter → 404', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/reading/chapters/99999999/questions');
    expect(res.status).toBe(404);
  });

  it("a SHARED book's chapter is readable by a non-owner (F-207 read gate)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const { uploadId, chapterId } = await seedChapterWithProse(owner.userId);
    await insertQuestion(chapterId, 1);
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get(`/reading/chapters/${chapterId}/questions`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
  });
});

describe('POST /reading/chapters/:chapterId/questions/generate', () => {
  it('generates via the (mocked) proxy, persists the set, and returns the GET DTO', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);

    const res = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(res.status).toBe(200);
    const qs = res.body.questions as Array<{
      id: number;
      questionNumber: number;
      options: Array<{ text: string; correct: boolean }>;
      explanation: string;
      kind: string;
    }>;
    // The stub authors READING_QUESTION_COUNT (default 4) questions.
    expect(qs).toHaveLength(4);
    expect(qs.map((q) => q.questionNumber)).toEqual([1, 2, 3, 4]);
    for (const q of qs) {
      expect(q.options).toHaveLength(4);
      expect(q.options.filter((o) => o.correct)).toHaveLength(1);
      expect(q.explanation.length).toBeGreaterThan(0);
      expect(q.kind).toBe('comprehension');
    }

    // Persisted — the GET serves the same rows, and provenance was recorded.
    const get = await agent.get(`/reading/chapters/${chapterId}/questions`);
    expect(get.status).toBe(200);
    expect(get.body.questions).toEqual(res.body.questions);
    const { rows } = await pg.pool.query<{ n: string; model: string }>(
      `SELECT count(*)::text AS n, min(model) AS model
         FROM reading_questions WHERE chapter_id = $1`,
      [chapterId],
    );
    expect(Number(rows[0]!.n)).toBe(4);
    expect(rows[0]!.model).toBe('claude-sonnet-4-6');

    // The chapter's OWN prose (both passages, in order) rode the call.
    expect(genSpy).toHaveBeenCalledTimes(1);
    const input = genSpy.mock.calls[0]![0];
    expect(input.prose).toContain('옛날 옛적에 오누이가 살았습니다.');
    expect(input.prose).toContain('호랑이가 떡을 달라고 했습니다.');
    expect(input.chapterTitle).toBe('해와 달이 된 오누이');
  });

  it('is idempotent: a second POST returns the stored set at $0 (no proxy call)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);

    const first = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(first.status).toBe(200);
    expect(genSpy).toHaveBeenCalledTimes(1);

    const second = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(second.status).toBe(200);
    expect(second.body.questions).toEqual(first.body.questions);
    expect(genSpy).toHaveBeenCalledTimes(1);
  });

  it('?regenerate=true replaces the set (fresh rows, a second paid call)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);

    const first = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(first.status).toBe(200);
    const firstIds = (first.body.questions as Array<{ id: number }>).map((q) => q.id);

    const regen = await agent.post(
      `/reading/chapters/${chapterId}/questions/generate?regenerate=true`,
    );
    expect(regen.status).toBe(200);
    expect(genSpy).toHaveBeenCalledTimes(2);
    const regenIds = (regen.body.questions as Array<{ id: number }>).map((q) => q.id);
    // Replaced, not appended: same count, all-new rows.
    expect(regenIds).toHaveLength(firstIds.length);
    for (const id of regenIds) expect(firstIds).not.toContain(id);
    const { rows } = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reading_questions WHERE chapter_id = $1`,
      [chapterId],
    );
    expect(Number(rows[0]!.n)).toBe(4);
  });

  it("another user's chapter → 404, no proxy call (IDOR)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(owner.userId);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(res.status).toBe(404);
    expect(genSpy).not.toHaveBeenCalled();
  });

  it("a SHARED book's chapter is still generate-locked to its OWNER (readers can't spend)", async () => {
    const owner = await registerUser(t.app, pg.pool);
    const { uploadId, chapterId } = await seedChapterWithProse(owner.userId);
    await pg.pool.query(`UPDATE book_uploads SET is_shared = true WHERE id = $1`, [
      uploadId,
    ]);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(res.status).toBe(404);
    expect(genSpy).not.toHaveBeenCalled();
  });

  it('over the per-user daily cap → 429 BEFORE the Claude call, nothing persisted', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);
    // READING_QUESTION_DAILY_CAP defaults to 20 — spend it all.
    await spendDailyBudget(userId, 20);

    const res = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(genSpy).not.toHaveBeenCalled();
    const { rows } = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reading_questions WHERE chapter_id = $1`,
      [chapterId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("the cap only counts the CALLER's ledger rows, not other users'", async () => {
    const other = await registerUser(t.app, pg.pool);
    await spendDailyBudget(other.userId, 20);
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);

    const res = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(res.status).toBe(200);
  });

  it('a chapter with no passages → 409, no proxy call', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId, { passages: [] });

    const res = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(res.status).toBe(409);
    expect(genSpy).not.toHaveBeenCalled();
  });

  it('a Claude failure → 502 and NOTHING persisted (call-before-write)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);
    // The proxy's error contract: typed errors carry httpStatus; a 5xx maps
    // to a generic 502 UpstreamError via the shared mapClaudeError.
    genSpy.mockRejectedValueOnce({
      httpStatus: 503,
      code: 'upstream_unavailable',
      message: 'stub upstream failure',
    });

    const res = await agent.post(`/reading/chapters/${chapterId}/questions/generate`);
    expect(res.status).toBe(502);
    const { rows } = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reading_questions WHERE chapter_id = $1`,
      [chapterId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('a garbage regenerate value → 400 (closed literal, not coerced)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { chapterId } = await seedChapterWithProse(userId);
    const res = await agent.post(
      `/reading/chapters/${chapterId}/questions/generate?regenerate=yes`,
    );
    expect(res.status).toBe(400);
    expect(genSpy).not.toHaveBeenCalled();
  });
});
