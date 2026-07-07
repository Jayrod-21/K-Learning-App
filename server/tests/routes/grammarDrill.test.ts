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
 *   - FU-NF-42 production scheduling on submit: auto-bank + production card
 *     created on first drill, advanced (not duplicated) on the second, a
 *     card_reviews snapshot written, due_at moves, response.schedule present,
 *     usesPattern=false forces a lapse, and the scored-once gate keeps the whole
 *     scheduling tx idempotent (a second submit 409s with no second card/review)
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

describe('POST /grammar-drill/:attemptId/submit — fractional score (services sweep #3)', () => {
  it('a contract-valid fractional score (87.5) is rounded — 200 + persisted, not a 500 rollback', async () => {
    // GrammarDrillScoreSchema allows any number in [0,100], but the score
    // column is INTEGER. Without rounding, pg rejects '87.5' and the WHOLE
    // submit tx (score + auto-bank + FSRS advance) rolls back AFTER the paid
    // Claude call — and the attempt can never be scored with that answer.
    const fracApp = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        scoreGrammarDrill: async () => ({
          result: {
            score: 87.5,
            verdict: 'good' as const,
            usesPattern: true,
            summary: 'fractional score summary',
            corrections: [],
          },
          metadata: {
            requestId: 'test-fractional-score',
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
      const { agent } = await registerUser(fracApp.app, pg.pool);
      const gen = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
      const attemptId = gen.body.attemptId as number;

      const res = await agent
        .post(`/grammar-drill/${attemptId}/submit`)
        .send({ answer: '다 먹어 버렸어요.' });
      expect(res.status).toBe(200);
      // Response echoes the PERSISTED (rounded) value.
      expect(res.body.score).toBe(88);

      const { rows } = await pg.pool.query<{ score: number; scored_at: Date | null }>(
        `SELECT score, scored_at FROM grammar_drill_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(rows[0]!.score).toBe(88);
      expect(rows[0]!.scored_at).not.toBeNull();
    } finally {
      await teardownTestApp(fracApp);
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

describe('POST /grammar-drill/:attemptId/submit — production scheduling (FU-NF-42)', () => {
  it('auto-banks the pattern, creates a production card, advances it, logs a review, and returns schedule', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const gen = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
    const attemptId = gen.body.attemptId as number;

    const res = await agent
      .post(`/grammar-drill/${attemptId}/submit`)
      .send({ answer: '다 먹어 버렸어요.' })
      .expect(200);

    // Response carries the schedule block. The stub scores verdict 'good' +
    // usesPattern true → rating 'good' → a NEW card seeds stability 3 → 3 days.
    expect(res.body.schedule).toBeDefined();
    expect(res.body.schedule.rating).toBe('good');
    expect(res.body.schedule.scheduledDays).toBe(3);
    expect(typeof res.body.schedule.dueAt).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.schedule.dueAt))).toBe(false);
    // Existing fields are preserved alongside the new block.
    expect(res.body.score).toBe(82);
    expect(res.body.referenceModelKr).toBe('모델 답안입니다.');

    // Auto-bank: a grammar_entries row for this (user, patternKey) exists, with
    // summary_en falling back to pattern_display and discovered_via = 'drill'.
    const entry = await pg.pool.query<{
      id: string;
      summary_en: string;
      pattern_display: string;
      discovered_via: string;
      category: string;
    }>(
      `SELECT id::text AS id, summary_en, pattern_display, discovered_via, category
         FROM grammar_entries WHERE user_id = $1 AND pattern_key = $2`,
      [userId, GEN_BODY.patternKey],
    );
    expect(entry.rowCount).toBe(1);
    expect(entry.rows[0]!.summary_en).toBe(GEN_BODY.patternDisplay);
    expect(entry.rows[0]!.discovered_via).toBe('drill');
    expect(entry.rows[0]!.category).toBe('other');

    // Production card created, face 'production', advanced (reps 1), due ~3d out.
    const card = await pg.pool.query<{
      id: string;
      face: string;
      fsrs_state: string;
      reps: number;
      scheduled_days: number;
      version: number;
      due_at: Date;
    }>(
      `SELECT id::text AS id, face, fsrs_state, reps, scheduled_days, version, due_at
         FROM vocab_cards
        WHERE user_id = $1 AND grammar_entry_id = $2 AND face = 'production'`,
      [userId, entry.rows[0]!.id],
    );
    expect(card.rowCount).toBe(1);
    expect(card.rows[0]!.face).toBe('production');
    expect(card.rows[0]!.fsrs_state).toBe('learning');
    expect(card.rows[0]!.reps).toBe(1);
    expect(card.rows[0]!.scheduled_days).toBe(3);
    expect(card.rows[0]!.version).toBe(2); // 1 (insert) → +1 (advance)
    const dueMs = new Date(card.rows[0]!.due_at).getTime() - Date.now();
    expect(dueMs).toBeGreaterThan(2.5 * 86_400_000);
    expect(dueMs).toBeLessThan(3.5 * 86_400_000);

    // A card_reviews snapshot was appended (rating good, before → after).
    const reviews = await pg.pool.query<{ rating: string }>(
      `SELECT rating FROM card_reviews WHERE card_id = $1 AND user_id = $2`,
      [card.rows[0]!.id, userId],
    );
    expect(reviews.rowCount).toBe(1);
    expect(reviews.rows[0]!.rating).toBe('good');
  });

  it('advances the SAME production card on a second drill of the same pattern (no duplicate)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const gen1 = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
    await agent
      .post(`/grammar-drill/${gen1.body.attemptId as number}/submit`)
      .send({ answer: '다 먹어 버렸어요.' })
      .expect(200);

    const gen2 = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
    const res2 = await agent
      .post(`/grammar-drill/${gen2.body.attemptId as number}/submit`)
      .send({ answer: '다 써 버렸어요.' })
      .expect(200);

    // Second good review multiplies prior stability (3 → ×2.0 = 6) → 6 days.
    expect(res2.body.schedule.scheduledDays).toBe(6);

    // Exactly ONE production card for this pattern (the unique index holds).
    const cards = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM vocab_cards c
         JOIN grammar_entries g ON g.id = c.grammar_entry_id
        WHERE c.user_id = $1 AND g.pattern_key = $2 AND c.face = 'production'`,
      [userId, GEN_BODY.patternKey],
    );
    expect(cards.rows[0]!.n).toBe('1');

    // Two review rows now exist for that one card.
    const reviews = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM card_reviews WHERE user_id = $1`,
      [userId],
    );
    expect(reviews.rows[0]!.n).toBe('2');
  });

  it('does NOT advance the card when the answer ignores the pattern (usesPattern false → again)', async () => {
    // Override the scorer to return a fluent-but-off-pattern result.
    const offPatternApp = buildTestApp({
      connectionString: pg.connectionString,
      claudeProxy: {
        scoreGrammarDrill: async () => ({
          result: {
            score: 90,
            verdict: 'excellent' as const,
            usesPattern: false,
            summary: 'fluent but did not use the target pattern',
            corrections: [],
          },
          metadata: {
            requestId: 'test-off-pattern',
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
      const { agent, userId } = await registerUser(offPatternApp.app, pg.pool);
      const gen = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
      const res = await agent
        .post(`/grammar-drill/${gen.body.attemptId as number}/submit`)
        .send({ answer: '안녕하세요. 날씨가 좋네요.' })
        .expect(200);

      // usesPattern false forces 'again' even though the verdict is 'excellent'.
      expect(res.body.schedule.rating).toBe('again');
      expect(res.body.schedule.scheduledDays).toBe(0);

      // The card lapsed into relearning and is due ~10 min out, not days.
      const card = await pg.pool.query<{ fsrs_state: string; lapses: number; due_at: Date }>(
        `SELECT c.fsrs_state, c.lapses, c.due_at
           FROM vocab_cards c
           JOIN grammar_entries g ON g.id = c.grammar_entry_id
          WHERE c.user_id = $1 AND g.pattern_key = $2 AND c.face = 'production'`,
        [userId, GEN_BODY.patternKey],
      );
      expect(card.rows[0]!.fsrs_state).toBe('relearning');
      expect(card.rows[0]!.lapses).toBe(1);
      const dueMs = new Date(card.rows[0]!.due_at).getTime() - Date.now();
      expect(dueMs).toBeGreaterThan(0);
      expect(dueMs).toBeLessThan(30 * 60 * 1000);
    } finally {
      await teardownTestApp(offPatternApp);
    }
  });

  it('is idempotent under the scored-once gate (a second submit 409s and writes no second card/review)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const gen = await agent.post('/grammar-drill').send(GEN_BODY).expect(201);
    const attemptId = gen.body.attemptId as number;

    await agent.post(`/grammar-drill/${attemptId}/submit`).send({ answer: '첫 답.' }).expect(200);
    await agent.post(`/grammar-drill/${attemptId}/submit`).send({ answer: '둘째 답.' }).expect(409);

    // Still exactly one card + one review (the 409 rolled back its whole tx).
    const cards = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM vocab_cards WHERE user_id = $1 AND face = 'production'`,
      [userId],
    );
    expect(cards.rows[0]!.n).toBe('1');
    const reviews = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM card_reviews WHERE user_id = $1`,
      [userId],
    );
    expect(reviews.rows[0]!.n).toBe('1');
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
