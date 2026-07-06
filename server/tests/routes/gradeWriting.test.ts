/**
 * Per-route tests for src/routes/gradeWriting.ts (B-FU-2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';

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
});

describe('POST /grade-writing — validation rejection', () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'missing prompt', body: { sample: 'x' } },
    { name: 'missing sample', body: { prompt: 'x' } },
    { name: 'empty sample', body: { prompt: 'x', sample: '' } },
    { name: 'oversized sample', body: { prompt: 'x', sample: 'x'.repeat(10_000) } },
    { name: 'oversized prompt', body: { prompt: 'x'.repeat(3_000), sample: 'x' } },
    { name: 'bad targetLevel', body: { prompt: 'x', sample: 'x', targetLevel: 'L9' } },
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
      const { agent } = await registerUser(broken.app, pg.pool);
      const res = await agent
        .post('/grade-writing')
        .send({ prompt: 'topic', sample: 'body' });
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('upstream_error');
    } finally {
      await teardownTestApp(broken);
    }
  });
});

describe('POST /grade-writing — rate limit', () => {
  it('expensive-bucket exceeded → 429 with a numeric retry_after (B-016)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let status429 = 0;
    let body429: unknown = null;
    for (let i = 0; i < 40; i++) {
      const res = await agent
        .post('/grade-writing')
        .send({ prompt: 'topic', sample: 'body' });
      if (res.status === 429) {
        status429 = res.status;
        body429 = res.body;
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
    expect(err?.retry_after as number).toBeGreaterThan(0);
  });
});
