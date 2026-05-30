/**
 * Integration tests for /grammar-drill (Pass 9 — grammar production drills).
 *
 * Routes:
 *   POST /grammar-drill
 *   POST /grammar-drill/:attemptId/submit
 *
 * Real Postgres via testcontainers per Bar §"Testing" (no SQLite stand-in). The
 * Claude proxy is the deterministic `generateGrammarDrill`/`scoreGrammarDrill`
 * STUB from makeStubProxy (per-type item + a fixed score) so the flow runs
 * without Anthropic; failure-path tests override the proxy to throw.
 *
 * Coverage:
 *   - auth required on both routes (401 unauthenticated)
 *   - POST persists the attempt (with reference) + the RESPONSE strips the
 *     reference model (answer-stripping)
 *   - POST Claude-fail → 502 and NO attempt row written (no half-state)
 *   - POST/submit scores + updates the row + reveals the reference
 *   - submit 404 for another user's attempt (IDOR)
 *   - submit 409 when already scored (scored-once)
 *   - history-based drill-type rotation is deterministic
 *     (transformation → cloze → conversation → transformation)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

let pg: PgHandle;
let t: TestApp;

const GEN_BODY = {
  patternKey: '-아/어 버리다',
  patternDisplay: '-아/어 버리다',
  meaning: 'completion / regret aspectual',
};

/** A Claude-proxy-shaped error: carries httpStatus so the route maps it to 502. */
function proxyError(): Error {
  const e = new Error('simulated claude failure') as Error & {
    httpStatus: number;
    code: string;
  };
  e.httpStatus = 502;
  e.code = 'upstream_unavailable';
  return e;
}

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
    'TRUNCATE TABLE grammar_drill_attempts, sessions, users RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

describe('grammar-drill — auth required', () => {
  it.each([
    ['POST', '/grammar-drill'],
    ['POST', '/grammar-drill/1/submit'],
  ])('%s %s unauthenticated → 401', async (_method, p) => {
    const res = await request(t.app).post(p).send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /grammar-drill — generate + persist + answer-strip', () => {
  it('persists the attempt (with reference) and strips the reference from the response', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/grammar-drill').send(GEN_BODY);
    expect(res.status).toBe(201);
    expect(typeof res.body.attemptId).toBe('number');

    // Answer-stripping: the response item must NOT carry the reference model.
    expect(res.body.item).toBeDefined();
    expect(res.body.item.referenceModelKr).toBeUndefined();
    expect(res.body.item.referenceModelEn).toBeUndefined();
    // First drill for a fresh pattern → 'transformation' (rotation start).
    expect(res.body.item.type).toBe('transformation');

    // The stored row keeps the reference (server-only).
    const { rows } = await pg.pool.query<{ item: { referenceModelKr?: string }; user_id: string }>(
      `SELECT item, user_id::text AS user_id FROM grammar_drill_attempts WHERE id = $1`,
      [res.body.attemptId],
    );
    expect(rows[0]!.user_id).toBe(String(userId));
    expect(rows[0]!.item.referenceModelKr).toBe('모델 답안입니다.');
  });

  it('drill-type invariant violation (model returns a foreign type) → 500 and writes NO row', async () => {
    // The persisted drill_type is the SERVER-CHOSEN requested type, and the route
    // asserts the model echoed that exact type. A drifted proxy that returns a
    // different type must fail loudly (500, not a silent desync) and write no row
    // — the assertion runs BEFORE the INSERT.
    const badApp = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        generateGrammarDrill: async (input) => ({
          // Requested type is 'transformation' (fresh pattern), but echo 'cloze'.
          result: {
            type: 'cloze' as const,
            patternKey: input.patternKey,
            patternDisplay: input.patternDisplay,
            instruction: 'drifted',
            referenceModelKr: 'x',
            referenceModelEn: 'x',
            context: 'c',
            seedKr: '___',
          },
          metadata: {
            requestId: 'test-invariant',
            model: 'claude-sonnet-4-6' as const,
            cacheHit: false,
            latencyMs: 1,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            costEstimateUsd: 0,
          },
        }),
      },
    });
    try {
      const { agent } = await registerUser(badApp.app, pg.pool);
      const res = await agent.post('/grammar-drill').send(GEN_BODY);
      expect(res.status).toBe(500);
      const { rows } = await pg.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM grammar_drill_attempts`,
      );
      expect(rows[0]!.n).toBe('0');
    } finally {
      await teardownTestApp(badApp);
    }
  });

  it('Claude failure → 502 and writes NO attempt row', async () => {
    const failApp = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        generateGrammarDrill: async () => {
          throw proxyError();
        },
      },
    });
    try {
      const { agent } = await registerUser(failApp.app, pg.pool);
      const res = await agent.post('/grammar-drill').send(GEN_BODY);
      expect(res.status).toBe(502);
      const { rows } = await pg.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM grammar_drill_attempts`,
      );
      expect(rows[0]!.n).toBe('0');
    } finally {
      await teardownTestApp(failApp);
    }
  });
});

describe('POST /grammar-drill/:attemptId/submit — score + reveal', () => {
  it('scores the attempt, updates the row, and reveals the reference model', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const gen = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
    const attemptId = gen.body.attemptId as number;

    const res = await agent
      .post(`/grammar-drill/${attemptId}/submit`)
      .send({ answer: '다 먹어 버렸어요.' });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(82);
    expect(res.body.verdict).toBe('good');
    expect(res.body.usesPattern).toBe(true);
    expect(res.body.summary).toBe('mock score summary');
    expect(res.body.corrections).toHaveLength(1);
    // The reference model is revealed NOW (post-submit).
    expect(res.body.referenceModelKr).toBe('모델 답안입니다.');
    expect(res.body.referenceModelEn).toBe('this is the model answer.');

    // The row is now scored.
    const { rows } = await pg.pool.query<{
      score: number;
      verdict: string;
      user_answer: string;
      scored_at: Date | null;
    }>(
      `SELECT score, verdict, user_answer, scored_at FROM grammar_drill_attempts WHERE id = $1`,
      [attemptId],
    );
    expect(rows[0]!.score).toBe(82);
    expect(rows[0]!.verdict).toBe('good');
    expect(rows[0]!.user_answer).toBe('다 먹어 버렸어요.');
    expect(rows[0]!.scored_at).not.toBeNull();
  });

  it("another user's attempt → 404 (IDOR)", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    const gen = await a.agent.post('/grammar-drill').send(GEN_BODY).expect(201);
    const attemptId = gen.body.attemptId as number;

    const res = await b.agent
      .post(`/grammar-drill/${attemptId}/submit`)
      .send({ answer: '시도해 봅니다.' });
    expect(res.status).toBe(404);
  });

  it('already-scored attempt → 409 (scored-once)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const gen = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
    const attemptId = gen.body.attemptId as number;

    await agent.post(`/grammar-drill/${attemptId}/submit`).send({ answer: '첫 번째 답.' }).expect(200);
    const res = await agent
      .post(`/grammar-drill/${attemptId}/submit`)
      .send({ answer: '두 번째 답.' });
    expect(res.status).toBe(409);
  });

  it('Claude scoring failure → 502 and leaves the row UNSCORED', async () => {
    const failApp = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        scoreGrammarDrill: async () => {
          throw proxyError();
        },
      },
    });
    try {
      const { agent } = await registerUser(failApp.app, pg.pool);
      const gen = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
      const attemptId = gen.body.attemptId as number;
      const res = await agent
        .post(`/grammar-drill/${attemptId}/submit`)
        .send({ answer: '답안입니다.' });
      expect(res.status).toBe(502);
      const { rows } = await pg.pool.query<{ scored_at: Date | null }>(
        `SELECT scored_at FROM grammar_drill_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(rows[0]!.scored_at).toBeNull();
    } finally {
      await teardownTestApp(failApp);
    }
  });
});

describe('drill-type rotation — deterministic', () => {
  it('cycles transformation → cloze → conversation → transformation', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const seen: string[] = [];
    // Generate 4 drills for the SAME pattern; each new attempt advances the
    // rotation based on the prior attempts' types.
    for (let i = 0; i < 4; i += 1) {
      const res = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
      seen.push(res.body.item.type as string);
    }
    expect(seen).toEqual(['transformation', 'cloze', 'conversation', 'transformation']);
  });

  it('rotation is per-pattern (a different pattern starts fresh)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    await agent.post('/grammar-drill').send(GEN_BODY).expect(201); // transformation
    const other = await agent
      .post('/grammar-drill')
      .send({ ...GEN_BODY, patternKey: '-(으)면', patternDisplay: '-(으)면' })
      .expect(201);
    expect(other.body.item.type).toBe('transformation');
  });
});
