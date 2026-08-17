/**
 * Per-route tests for src/routes/ability.ts (F-212 P2).
 *
 * Routes:
 *   GET /ability/estimate — continuous per-dimension ability estimate
 *
 * The estimator math is covered in tests/services/ability/{irt,estimate}; here
 * the contract under test is the HTTP surface: auth gate, server-bound tenant
 * isolation, the {estimates: AbilityEstimate[]} wire shape, the insufficient
 * path, and DIMENSION_ORDER ordering.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { ESTIMATOR_VERSION } from '../../src/services/ability/irt.js';
import {
  DIMENSION_ORDER,
  RUBRIC_VERSION,
} from '../../src/services/diagnostic/scoring.js';

let pg: PgHandle;
let t: TestApp;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
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
    'TRUNCATE TABLE users, topik_tests, topik_items, corpus_sources RESTART IDENTITY CASCADE',
  );
  resetLimiters();
});

/** Seed 6 recent answered diagnostic listening items — placed evidence that
 *  clears the estimator's min-evidence gate. */
async function seedListeningEvidence(userId: number): Promise<void> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO diagnostic_runs (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  for (let i = 0; i < 6; i += 1) {
    await pg.pool.query(
      `INSERT INTO diagnostic_responses
          (run_id, ordinal, section, source_kind, source_ref, difficulty,
           kind, item_payload, correct_answer, picked, is_correct, answered_at)
       VALUES ($1, $2, 'listening', 'topik', 'f212-route-ref', 3.50, 'mc',
               '{"prompt":"들으세요"}'::jsonb, 'a', 'a', $3, $4)`,
      [rows[0]!.id, i + 1, i !== 5, daysAgo(i + 1)],
    );
  }
}

const AbilityEstimateSchema = z.object({
  dimension: z.enum(['reading', 'listening', 'vocab', 'grammar', 'writing']),
  theta: z.number().min(1).max(6).nullable(),
  se: z.number().positive().nullable(),
  band: z.enum(['L1', 'L2', 'L3', 'L4', 'L5+']).nullable(),
  score: z.number().min(0).max(100).nullable(),
  n: z.number().int().nonnegative(),
  nUsed: z.number().int().nonnegative(),
  effN: z.number().nonnegative(),
  lastEvidenceAt: z.string().nullable(),
  insufficient: z.boolean(),
  estimatorVersion: z.literal(ESTIMATOR_VERSION),
  rubricVersion: z.literal(RUBRIC_VERSION),
});
const ResponseSchema = z.object({
  estimates: z.array(AbilityEstimateSchema).length(4),
});

describe('GET /ability/estimate — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/ability/estimate');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('GET /ability/estimate — shape + insufficient path', () => {
  it('a fresh user gets 4 insufficient estimates in DIMENSION_ORDER', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ability/estimate');
    expect(res.status).toBe(200);

    const parsed = ResponseSchema.parse(res.body);
    expect(parsed.estimates.map((e) => e.dimension)).toEqual([...DIMENSION_ORDER]);
    for (const estimate of parsed.estimates) {
      expect(estimate.insufficient).toBe(true);
      expect(estimate.theta).toBeNull();
      expect(estimate.se).toBeNull();
      expect(estimate.band).toBeNull();
      expect(estimate.score).toBeNull();
      expect(estimate.n).toBe(0);
      expect(estimate.nUsed).toBe(0);
      expect(estimate.effN).toBe(0);
      expect(estimate.lastEvidenceAt).toBeNull();
    }
  });

  it('writing is never in the default response', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/ability/estimate');
    expect(res.status).toBe(200);
    expect(
      (res.body.estimates as Array<{ dimension: string }>).map((e) => e.dimension),
    ).not.toContain('writing');
  });
});

describe('GET /ability/estimate — sufficient evidence', () => {
  it('serves a placed estimate for the evidenced dimension', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedListeningEvidence(userId);

    const res = await agent.get('/ability/estimate');
    expect(res.status).toBe(200);
    const parsed = ResponseSchema.parse(res.body);

    const listening = parsed.estimates[1]!;
    expect(listening.dimension).toBe('listening');
    expect(listening.insufficient).toBe(false);
    expect(listening.theta).not.toBeNull();
    expect(listening.se).not.toBeNull();
    expect(listening.band).not.toBeNull();
    expect(listening.score).not.toBeNull();
    expect(listening.n).toBe(6);
    expect(listening.nUsed).toBe(6);
    expect(listening.effN).toBeGreaterThan(3);

    // The other dimensions stay insufficient — no cross-dimension bleed.
    for (const idx of [0, 2, 3]) {
      expect(parsed.estimates[idx]!.insufficient).toBe(true);
    }
  });
});

describe('GET /ability/estimate — tenant isolation', () => {
  it('another user never sees the evidenced user’s estimate (server-bound userId)', async () => {
    const { userId: aliceId } = await registerUser(t.app, pg.pool);
    await seedListeningEvidence(aliceId);

    const { agent: bobAgent } = await registerUser(t.app, pg.pool);
    const res = await bobAgent.get('/ability/estimate');
    expect(res.status).toBe(200);
    const parsed = ResponseSchema.parse(res.body);
    expect(parsed.estimates.every((e) => e.insufficient)).toBe(true);
    expect(parsed.estimates.every((e) => e.n === 0)).toBe(true);
  });
});
