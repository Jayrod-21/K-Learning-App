/**
 * Per-route tests for src/routes/gradeWriting.ts (B-FU-2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { getLogger, setLoggerForTesting } from '../../src/logging.js';

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
    'TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE',
  );
  t = buildTestApp({ connectionString: pg.connectionString });
});

const GradeResponseSchema = z.object({
  result: z.object({
    content: z.object({ score: z.number(), maxScore: z.number() }),
    organization: z.object({ score: z.number() }),
    languageUse: z.object({ score: z.number() }),
    totalScore: z.number(),
    maxTotal: z.number(),
    estimatedLevel: z.string(),
  }),
});

describe('POST /grade-writing — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app)
      .post('/grade-writing')
      .send({ prompt: 'topic A', sample: 'my essay' });
    expect(res.status).toBe(401);
  });
});

describe('POST /grade-writing — success', () => {
  it('200 with rubric scores from the stub', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grade-writing')
      .send({ prompt: 'topic A', sample: 'my essay body' });
    expect(res.status).toBe(200);
    const parsed = GradeResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
  });

  // 056/F-117: free_write is a REAL rubric now — not the Q54 fallback the
  // client used before the taxonomy widened. The edge accepts it, the stub
  // proxy echoes it back (helpers/app.ts's gradeWriting stub echoes
  // `input.rubric` verbatim), and it persists on writing_attempts, whose
  // CHECK (ck_writing_attempts_rubric) migration 056 widened to allow it.
  it('rubric=free_write → 200 and the grade echoes free_write', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/grade-writing').send({
      prompt: '자유 주제로 글을 써 보세요.',
      sample: '오늘은 날씨가 좋아서 산책을 했습니다.',
      rubric: 'free_write',
    });
    expect(res.status).toBe(200);
    expect((res.body as { result: { rubric: string } }).result.rubric).toBe(
      'free_write',
    );
    const { rows } = await pg.pool.query<{ rubric: string; prompt_id: string | null }>(
      `SELECT rubric, prompt_id FROM writing_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rubric).toBe('free_write');
    // A free-write grade has no writing_prompts source row (Claude-generated,
    // not bank-drawn) — promptId is omitted at the edge in this test, so the
    // persisted soft link is NULL, exactly like a generated-topic grade.
    expect(rows[0]!.prompt_id).toBeNull();
  });
});

describe('POST /grade-writing — validation rejection', () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'missing prompt', body: { sample: 'x' } },
    { name: 'missing sample', body: { prompt: 'x' } },
    { name: 'empty sample', body: { prompt: 'x', sample: '' } },
    { name: 'oversized sample', body: { prompt: 'x', sample: 'x'.repeat(10_000) } },
    { name: 'oversized prompt', body: { prompt: 'x'.repeat(3_000), sample: 'x' } },
    { name: 'bad targetLevel', body: { prompt: 'x', sample: 'x', targetLevel: 'L9' } },
    { name: 'invalid rubric', body: { prompt: 'x', sample: 'x', rubric: 'nonsense' } },
    { name: 'non-integer promptId', body: { prompt: 'x', sample: 'x', promptId: 1.5 } },
    { name: 'non-positive promptId', body: { prompt: 'x', sample: 'x', promptId: 0 } },
    { name: 'string promptId', body: { prompt: 'x', sample: 'x', promptId: '7' } },
  ];
  for (const c of cases) {
    it(`${c.name} → 400`, async () => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.post('/grade-writing').send(c.body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  }
});

// ---------------------------------------------------------------------------
// F-014: a successful grade persists a writing_attempts row (best-effort).
// ---------------------------------------------------------------------------

describe('POST /grade-writing — attempt persistence (F-014)', () => {
  interface AttemptRow {
    user_id: string;
    prompt_id: string | null;
    rubric: string;
    prompt_kr: string;
    sample: string;
    total_score: number;
    max_total: number;
    estimated_level: string | null;
    result: { overallComment?: string; totalScore?: number };
  }

  async function attemptsFor(userId: number): Promise<AttemptRow[]> {
    const { rows } = await pg.pool.query<AttemptRow>(
      `SELECT user_id, prompt_id, rubric, prompt_kr, sample,
              total_score, max_total, estimated_level, result
         FROM writing_attempts
        WHERE user_id = $1
        ORDER BY id`,
      [userId],
    );
    return rows;
  }

  it('a successful grade with promptId writes a user-scoped row with the contract fields', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A REAL bank row (migration-038 seed) — the persisted soft link must
    // satisfy the prompt_id FK.
    const bank = await pg.pool.query<{ id: string; prompt_kr: string }>(
      `SELECT id, prompt_kr FROM writing_prompts
        WHERE rubric = 'topik_ii_53' AND is_active
        ORDER BY id LIMIT 1`,
    );
    const promptId = Number(bank.rows[0]!.id);
    const promptKr = bank.rows[0]!.prompt_kr;

    const res = await agent.post('/grade-writing').send({
      prompt: promptKr,
      sample: '스트레스를 받을 때 저는 산책을 합니다.',
      rubric: 'topik_ii_53',
      promptId,
    });
    expect(res.status).toBe(200);

    const rows = await attemptsFor(userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Number(row.user_id)).toBe(userId);
    expect(Number(row.prompt_id)).toBe(promptId);
    expect(row.rubric).toBe('topik_ii_53');
    expect(row.prompt_kr).toBe(promptKr);
    expect(row.sample).toBe('스트레스를 받을 때 저는 산책을 합니다.');
    // The stub proxy grades 21/30, estimatedLevel 'L3' (helpers/app.ts).
    expect(row.total_score).toBe(21);
    expect(row.max_total).toBe(30);
    expect(row.estimated_level).toBe('L3');
    // The full structured grade is snapshotted for a future history screen.
    expect(row.result.overallComment).toBe('mock overall');
    expect(row.result.totalScore).toBe(21);
  });

  it('promptId omitted → row persists with prompt_id NULL', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/grade-writing')
      .send({ prompt: 'topic A', sample: 'my essay body' });
    expect(res.status).toBe(200);
    const rows = await attemptsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt_id).toBeNull();
    // rubric defaults to topik_ii_54 at the edge; the row records what was graded.
    expect(rows[0]!.rubric).toBe('topik_ii_54');
  });

  it('a persist failure does NOT fail the grade (well-formed but nonexistent promptId → FK violation)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/grade-writing').send({
      prompt: 'topic A',
      sample: 'my essay body',
      promptId: 987_654_321, // passes zod, violates the prompt_id FK on insert
    });
    // The grade (a paid Claude call) still comes back whole…
    expect(res.status).toBe(200);
    expect(GradeResponseSchema.safeParse(res.body).success).toBe(true);
    // …and nothing was persisted.
    expect(await attemptsFor(userId)).toHaveLength(0);
  });

  it('an out-of-contract totalScore (> maxTotal) is clamped + warned and STILL persists a row', async () => {
    // Fix-pass SF-2: GradeResultSchema pins totalScore only to nonnegative()
    // — deliberately no totalScore <= maxTotal refinement, which would fail
    // the whole paid grade. Without clamping, a 31/30 grader response trips
    // ck_writing_attempts_total_in_range and the best-effort catch silently
    // drops the attempt on EVERY such grade (systematic, not transient). The
    // persist site must clamp to [0, max_total] and warn with the raw values.
    const overGrader = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        gradeWriting: async (input) => ({
          result: {
            rubric: input.rubric,
            content: { score: 11, maxScore: 10, evidence: ['e'], improvements: ['i'] },
            organization: { score: 10, maxScore: 10, evidence: ['e'], improvements: ['i'] },
            languageUse: { score: 10, maxScore: 10, evidence: ['e'], improvements: ['i'] },
            totalScore: 31, // out of contract: exceeds maxTotal
            maxTotal: 30,
            estimatedLevel: 'L4' as const,
            overallComment: 'mock over-max grade',
          },
          metadata: {
            model: 'claude-sonnet-4-6' as const,
            cacheHit: false,
            latencyMs: 1,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            costEstimateUsd: 0,
            requestId: randomUUID(),
          },
        }),
      },
    });
    // Capture structured warns: swap in a pino logger writing to an array
    // (LOG_LEVEL is 'silent' in tests, so the default logger drops warns).
    const originalLogger = getLogger();
    const warns: Array<Record<string, unknown>> = [];
    setLoggerForTesting(
      pino(
        { level: 'warn' },
        {
          write: (line: string) => {
            warns.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      ),
    );
    try {
      const { agent, userId } = await registerUser(overGrader.app, pg.pool);
      const res = await agent
        .post('/grade-writing')
        .send({ prompt: 'topic', sample: 'my essay body' });
      // The user's grade response is untouched — the raw grader output.
      expect(res.status).toBe(200);
      expect((res.body as { result: { totalScore: number } }).result.totalScore).toBe(31);
      // The attempt persists, clamped — NOT silently dropped by the CHECK.
      const rows = await attemptsFor(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.total_score).toBe(30);
      expect(rows[0]!.max_total).toBe(30);
      // The JSONB snapshot keeps the raw grader output (audit trail).
      expect(rows[0]!.result.totalScore).toBe(31);
      // The warn fired, structured with the raw + persisted values.
      const warn = warns.find(
        (w) => typeof w.msg === 'string' && w.msg.includes('out-of-contract totalScore'),
      );
      expect(warn).toBeDefined();
      expect(warn!.rawTotalScore).toBe(31);
      expect(warn!.rawMaxTotal).toBe(30);
      expect(warn!.persistedTotalScore).toBe(30);
    } finally {
      setLoggerForTesting(originalLogger);
      await teardownTestApp(overGrader);
    }
  });

  it('a near-zero maxTotal (0.4) is floored to 1 — the attempt persists instead of being dropped (services sweep #8)', async () => {
    // GradeResultSchema pins maxTotal only to positive(), so a contract-valid
    // 0.4 rounds to 0 and trips ck_writing_attempts_max_total_positive — the
    // best-effort catch then silently drops EVERY such attempt from the F-017
    // series. The persist site must floor the denominator at 1.
    const tinyGrader = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        gradeWriting: async (input) => ({
          result: {
            rubric: input.rubric,
            content: { score: 0.2, maxScore: 0.4, evidence: ['e'], improvements: ['i'] },
            organization: { score: 0.1, maxScore: 0.4, evidence: ['e'], improvements: ['i'] },
            languageUse: { score: 0.1, maxScore: 0.4, evidence: ['e'], improvements: ['i'] },
            totalScore: 0.2,
            maxTotal: 0.4, // rounds to 0 → would trip the CHECK without the floor
            estimatedLevel: 'below_L3' as const,
            overallComment: 'mock tiny grade',
          },
          metadata: {
            model: 'claude-sonnet-4-6' as const,
            cacheHit: false,
            latencyMs: 1,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            costEstimateUsd: 0,
            requestId: randomUUID(),
          },
        }),
      },
    });
    try {
      const { agent, userId } = await registerUser(tinyGrader.app, pg.pool);
      const res = await agent
        .post('/grade-writing')
        .send({ prompt: 'topic', sample: 'my essay body' });
      // The grade response is untouched (raw grader output)…
      expect(res.status).toBe(200);
      expect((res.body as { result: { maxTotal: number } }).result.maxTotal).toBe(0.4);
      // …and the row persists with the normalized denominator instead of
      // being silently dropped by the CHECK constraint.
      const rows = await attemptsFor(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.max_total).toBe(1);
      expect(rows[0]!.total_score).toBe(0); // round(0.2) → 0, clamped into [0, 1]
    } finally {
      await teardownTestApp(tinyGrader);
    }
  });
});

describe('POST /grade-writing — downstream error', () => {
  it('B4 httpStatus error → mapped to upstream_error with that status', async () => {
    const broken = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        gradeWriting: async () => {
          const e = new Error('upstream timeout') as Error & {
            httpStatus: number;
            code: string;
          };
          e.httpStatus = 504;
          e.code = 'b4_timeout';
          throw e;
        },
      },
    });
    try {
      const { agent, userId } = await registerUser(broken.app, pg.pool);
      const res = await agent
        .post('/grade-writing')
        .send({ prompt: 'topic', sample: 'body' });
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('upstream_error');
      // F-014: only a SUCCESSFUL grade persists — a failed one writes nothing.
      const { rows } = await pg.pool.query(
        `SELECT 1 FROM writing_attempts WHERE user_id = $1`,
        [userId],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await teardownTestApp(broken);
    }
  });
});

describe('POST /grade-writing — rate limit', () => {
  it('expensive-bucket exceeded → 429 with retry_after in the body AND a matching Retry-After header (B-016)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let status429 = 0;
    let body429: unknown = null;
    let headers429: Record<string, string | undefined> = {};
    for (let i = 0; i < 40; i++) {
      const res = await agent
        .post('/grade-writing')
        .send({ prompt: 'topic', sample: 'body' });
      if (res.status === 429) {
        status429 = res.status;
        body429 = res.body;
        headers429 = res.headers as Record<string, string | undefined>;
        break;
      }
    }
    expect(status429).toBe(429);
    const err = (
      body429 as { error?: { code?: string; retry_after?: unknown } }
    ).error;
    expect(err?.code).toBe('rate_limited');
    // B-016: the 429 must carry a numeric retry_after (seconds) so the client's
    // ApiError.retryAfter / Writing "try again in N s" branch has real data.
    expect(typeof err?.retry_after).toBe('number');
    const retryAfter = err?.retry_after as number;
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    // Units guard (fix-pass SF-3): header and body derive from ONE variable in
    // the shared 429 handler, so integer+equality alone would still pass if a
    // future edit dropped the ms→s division (retry_after ≈ 59_000). The value
    // can never exceed the limiter window — 60s here (helpers/app.ts sets
    // RATE_LIMIT_WINDOW_MS='60000') — so bound it to make a unit regression
    // fail loudly.
    expect(retryAfter).toBeLessThanOrEqual(60);
    // …and the standard Retry-After header, agreeing with the body exactly
    // (both are computed from one value in the shared 429 handler).
    expect(headers429['retry-after']).toBe(String(retryAfter));
  });
});
