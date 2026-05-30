/**
 * Per-route tests for src/routes/enrich.ts (B-FU-2).
 *
 * Auth-required, expensive-bucket, proxies to Claude (B4). We swap the
 * proxy via `buildTestApp({ claudeProxy: ... })` to assert downstream
 * mapping without touching Anthropic.
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
  // Reset proxy to default stub.
  t = buildTestApp({ connectionString: pg.connectionString });
});

const EnrichResponseSchema = z.object({
  result: z.object({
    nuance: z.string(),
    usageNote: z.string(),
    examples: z.array(z.object({ korean: z.string(), english: z.string() })),
  }),
  metadata: z.object({ requestId: z.string(), model: z.string() }),
});

describe('POST /enrich — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app)
      .post('/enrich')
      .send({ lemma: '먹다', sourceSentence: '저는 밥을 먹어요' });
    expect(res.status).toBe(401);
  });
});

describe('POST /enrich — success', () => {
  it('200 with enrichment shape from the (stubbed) claude proxy', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .post('/enrich')
      .send({ lemma: '먹다', sourceSentence: '저는 밥을 먹어요' });
    expect(res.status).toBe(200);
    const parsed = EnrichResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
  });
});

describe('POST /enrich — validation rejection', () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'missing lemma', body: { sourceSentence: '저는 밥을 먹어요' } },
    { name: 'missing sourceSentence', body: { lemma: '먹다' } },
    { name: 'lemma too long', body: { lemma: 'x'.repeat(100), sourceSentence: '안녕' } },
    { name: 'sourceSentence too long', body: { lemma: '먹다', sourceSentence: 'x'.repeat(3_000) } },
    { name: 'lemma wrong type', body: { lemma: 123, sourceSentence: '안녕' } },
  ];
  for (const c of cases) {
    it(`${c.name} → 400`, async () => {
      const { agent } = await registerUser(t.app, pg.pool);
      const res = await agent.post('/enrich').send(c.body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  }
});

describe('POST /enrich — downstream error', () => {
  it('B4 throws with httpStatus → mapped to that status + upstream_error code', async () => {
    // Re-build with a proxy that throws a B4-shaped error.
    const broken = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        enrich: async () => {
          const e = new Error('rate_limited: too many tokens') as Error & {
            httpStatus: number;
            code: string;
          };
          e.httpStatus = 429;
          e.code = 'b4_rate_limited';
          throw e;
        },
      },
    });
    try {
      const { agent } = await registerUser(broken.app, pg.pool);
      const res = await agent
        .post('/enrich')
        .send({ lemma: '먹다', sourceSentence: '저는 밥을 먹어요' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('upstream_error');
    } finally {
      await teardownTestApp(broken);
    }
  });

  it('B4 throws plain Error → mapped to 500 internal_error (no leak)', async () => {
    const broken = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        enrich: async () => {
          throw new Error('boom internal stack here');
        },
      },
    });
    try {
      const { agent } = await registerUser(broken.app, pg.pool);
      const res = await agent
        .post('/enrich')
        .send({ lemma: '먹다', sourceSentence: '저는 밥을 먹어요' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('internal_error');
      expect(JSON.stringify(res.body)).not.toContain('boom internal stack');
    } finally {
      await teardownTestApp(broken);
    }
  });
});

describe('POST /enrich — rate limit', () => {
  it('expensive-bucket exceeded → 429 rate_limited', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const res = await agent
        .post('/enrich')
        .send({ lemma: '먹다', sourceSentence: '안녕하세요' });
      if (res.status === 429) {
        expect(res.body.error.code).toBe('rate_limited');
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});
