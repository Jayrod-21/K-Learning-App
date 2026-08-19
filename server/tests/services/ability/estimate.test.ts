/**
 * estimate — continuous ability estimation over real Postgres (F-212 P2).
 *
 * Bar §"Testing": testcontainers again — the estimator's value is the wiring
 * (evidence fetch → recency weights → EAP → gate → user_progress sampling),
 * so only a real engine running the real migration chain proves: per-dim
 * emission in DIMENSION_ORDER, the nUsed/effN gate, the 180-day window, the
 * ≤1-row/dim/UTC-day sampled persist (+ DISTINCT ON read + JSONB
 * round-trip), the writing opt-in (estimated, never sampled), and tenant
 * scoping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { startPostgres, stopPostgres, type PgHandle } from '../../helpers/pg.js';
import { setPoolForTesting } from '../../../src/db/pool.js';
import { setLoggerForTesting } from '../../../src/logging.js';
import { estimateAbility } from '../../../src/services/ability/estimate.js';
import {
  DEFAULT_ESTIMATOR_CONFIG,
  ESTIMATOR_VERSION,
} from '../../../src/services/ability/irt.js';
import {
  RUBRIC_VERSION,
  estimateToScore,
} from '../../../src/services/diagnostic/scoring.js';
import { bandForTheta } from '../../../src/services/diagnostic/cat.js';

let pg: PgHandle;

const FAKE_HASH = `$argon2id$${'x'.repeat(70)}`;

/** Deterministic clock for every estimate in this suite. */
const NOW = new Date('2026-08-10T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

beforeAll(async () => {
  pg = await startPostgres();
  setPoolForTesting(pg.pool);
  // The persist-failure path logs through getLogger(), which lazily parses the
  // full env config — inject a silent logger so this service-level suite never
  // depends on app-level env being present.
  setLoggerForTesting(pino({ level: 'silent' }));
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    'TRUNCATE TABLE users, topik_tests, topik_items, corpus_sources RESTART IDENTITY CASCADE',
  );
});

async function seedUser(email: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

async function seedRun(userId: number): Promise<string> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO diagnostic_runs (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  return rows[0]!.id;
}

/** One answered diagnostic response — placed evidence (diff_served = b). */
async function seedResponse(
  runId: string,
  ordinal: number,
  section: 'reading' | 'listening' | 'vocab' | 'grammar',
  answeredAt: string,
  isCorrect: boolean,
  difficulty = 3.5,
): Promise<void> {
  await pg.pool.query(
    `INSERT INTO diagnostic_responses
        (run_id, ordinal, section, source_kind, source_ref, difficulty,
         kind, item_payload, correct_answer, picked, is_correct, answered_at)
     VALUES ($1, $2, $3, 'topik', 'f212-p2-ref', $4, 'mc',
             '{"prompt":"고르세요"}'::jsonb, 'a', $5, $6, $7)`,
    [runId, ordinal, section, difficulty, isCorrect ? 'a' : 'b', isCorrect, answeredAt],
  );
}

/** A b-less grammar drill (raises n, never nUsed). */
async function seedDrill(userId: number, scoredAt: string, score = 73): Promise<void> {
  await pg.pool.query(
    `INSERT INTO grammar_drill_attempts
        (user_id, pattern_key, pattern_display, drill_type, item,
         user_answer, score, verdict, scored_at)
     VALUES ($1, 'GR-f212p2-eo-yo', '-어요', 'transformation',
             '{"prompt":"바꾸세요"}'::jsonb, '했어요', $2, 'good', $3)`,
    [userId, score, scoredAt],
  );
}

/** A graded writing attempt at the topik_ii_54 rubric anchor (b = 5.0). */
async function seedWriting(userId: number, gradedAt: string): Promise<void> {
  await pg.pool.query(
    `INSERT INTO writing_attempts
        (user_id, rubric, prompt_kr, sample, total_score, max_total, result, graded_at)
     VALUES ($1, 'topik_ii_54', '글을 쓰십시오.', '제 생각에는 그렇습니다.',
             42, 50, '{"overallComment":"좋아요"}'::jsonb, $2)`,
    [userId, gradedAt],
  );
}

/** Latest value per metric — the routes/progress.ts DISTINCT ON read. */
async function currentMetrics(
  userId: number,
): Promise<Array<{ metric_type: string; value: Record<string, unknown> }>> {
  const { rows } = await pg.pool.query<{
    metric_type: string;
    value: Record<string, unknown>;
  }>(
    `SELECT DISTINCT ON (metric_type) metric_type, value, captured_at
       FROM user_progress
      WHERE user_id = $1
      ORDER BY metric_type, captured_at DESC`,
    [userId],
  );
  return rows;
}

/** Seed 6 recent placed listening responses (5 right, 1 wrong) — enough to
 *  clear the gate with fresh weights. */
async function seedSufficientListening(userId: number): Promise<void> {
  const runId = await seedRun(userId);
  for (let i = 0; i < 6; i += 1) {
    await seedResponse(runId, i + 1, 'listening', daysAgo(i + 1), i !== 5);
  }
}

describe('estimateAbility — per-dimension wiring', () => {
  it('emits DIMENSION_ORDER; a sufficient dimension carries θ/SE/band/score', async () => {
    const userId = await seedUser('est-wiring@example.com');
    await seedSufficientListening(userId);

    const estimates = await estimateAbility(userId, { now: NOW });
    expect(estimates.map((e) => e.dimension)).toEqual([
      'reading',
      'listening',
      'vocab',
      'grammar',
    ]);

    const listening = estimates[1]!;
    expect(listening.insufficient).toBe(false);
    expect(listening.n).toBe(6);
    expect(listening.nUsed).toBe(6);
    // Fresh evidence (1–6 days old, half-life 30): effN just under 6.
    expect(listening.effN).toBeGreaterThan(5);
    expect(listening.effN).toBeLessThanOrEqual(6);
    expect(listening.lastEvidenceAt).toBe(daysAgo(1));
    expect(listening.theta).not.toBeNull();
    expect(listening.theta!).toBeGreaterThanOrEqual(1);
    expect(listening.theta!).toBeLessThanOrEqual(6);
    // 5/6 right at b=3.5 → θ̂ above the anchor.
    expect(listening.theta!).toBeGreaterThan(3.5);
    expect(listening.se).not.toBeNull();
    expect(listening.se!).toBeGreaterThan(0);
    // band/score are the REUSED diagnostic mappings of the rounded θ.
    expect(listening.band).toBe(bandForTheta(listening.theta!));
    expect(listening.score).toBe(estimateToScore(listening.theta!));
    expect(listening.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(listening.rubricVersion).toBe(RUBRIC_VERSION);

    // Evidence-free dimensions are insufficient with null fields.
    for (const dim of [estimates[0]!, estimates[2]!, estimates[3]!]) {
      expect(dim.insufficient).toBe(true);
      expect(dim.theta).toBeNull();
      expect(dim.se).toBeNull();
      expect(dim.band).toBeNull();
      expect(dim.score).toBeNull();
      expect(dim.n).toBe(0);
      expect(dim.lastEvidenceAt).toBeNull();
    }
  });

  it('excludes writing by default and appends it (estimated) on opt-in', async () => {
    const userId = await seedUser('est-writing@example.com');
    for (let i = 0; i < 5; i += 1) {
      await seedWriting(userId, daysAgo(i + 1));
    }

    const defaults = await estimateAbility(userId, { now: NOW });
    expect(defaults.map((e) => e.dimension)).not.toContain('writing');

    const withWriting = await estimateAbility(userId, {
      now: NOW,
      includeWriting: true,
    });
    expect(withWriting.map((e) => e.dimension)).toEqual([
      'reading',
      'listening',
      'vocab',
      'grammar',
      'writing',
    ]);
    const writing = withWriting[4]!;
    expect(writing.insufficient).toBe(false); // 5 placed rows at b = 5.0
    expect(writing.nUsed).toBe(5);
    expect(writing.theta).not.toBeNull();
  });
});

describe('estimateAbility — min-evidence gate + window', () => {
  it('nUsed < 5 → insufficient even with placed evidence', async () => {
    const userId = await seedUser('est-gate-nused@example.com');
    const runId = await seedRun(userId);
    for (let i = 0; i < 4; i += 1) {
      await seedResponse(runId, i + 1, 'listening', daysAgo(i + 1), true);
    }
    const estimates = await estimateAbility(userId, { now: NOW });
    const listening = estimates[1]!;
    expect(listening.nUsed).toBe(4);
    expect(listening.insufficient).toBe(true);
    expect(listening.theta).toBeNull();
  });

  it('b-less evidence raises n but never nUsed (grammar drills stay unplaced)', async () => {
    const userId = await seedUser('est-gate-unplaced@example.com');
    for (let i = 0; i < 6; i += 1) {
      await seedDrill(userId, daysAgo(i + 1));
    }
    const estimates = await estimateAbility(userId, { now: NOW });
    const grammar = estimates[3]!;
    expect(grammar.n).toBe(6);
    expect(grammar.nUsed).toBe(0);
    expect(grammar.effN).toBe(0);
    expect(grammar.insufficient).toBe(true);
    expect(grammar.lastEvidenceAt).toBe(daysAgo(1)); // still reported
  });

  it('effN < 3 → insufficient when all evidence is stale (recency decay)', async () => {
    const userId = await seedUser('est-gate-effn@example.com');
    const runId = await seedRun(userId);
    // 5 placed rows, all ~150 days old: w = 0.5^(150/30) ≈ 0.031 each,
    // effN ≈ 0.16 — clears nUsed but not effN.
    for (let i = 0; i < 5; i += 1) {
      await seedResponse(runId, i + 1, 'listening', daysAgo(150), true);
    }
    const estimates = await estimateAbility(userId, { now: NOW });
    const listening = estimates[1]!;
    expect(listening.nUsed).toBe(5);
    expect(listening.effN).toBeLessThan(3);
    expect(listening.insufficient).toBe(true);
  });

  it('the 180-day hard window excludes older evidence from n entirely', async () => {
    const userId = await seedUser('est-window@example.com');
    const runId = await seedRun(userId);
    await seedResponse(runId, 1, 'listening', daysAgo(181), true);
    await seedResponse(runId, 2, 'listening', daysAgo(10), true);
    const estimates = await estimateAbility(userId, { now: NOW });
    const listening = estimates[1]!;
    expect(listening.n).toBe(1); // only the in-window row
    expect(listening.lastEvidenceAt).toBe(daysAgo(10));
  });
});

describe('estimateAbility — sampled persist', () => {
  it('appends at most one user_progress row per dimension per UTC day', async () => {
    const userId = await seedUser('est-persist@example.com');
    await seedSufficientListening(userId);

    const first = await estimateAbility(userId, { now: NOW });
    await estimateAbility(userId, { now: NOW }); // same UTC day → sampled out
    await estimateAbility(userId, {
      now: new Date('2026-08-10T23:59:00Z'), // still 2026-08-10 UTC
    });

    const { rows } = await pg.pool.query<{ metric_type: string; value: unknown }>(
      `SELECT metric_type, value FROM user_progress WHERE user_id = $1
        ORDER BY captured_at`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metric_type).toBe('ability_theta_listening');

    // JSONB round-trip: the persisted object IS the served estimate.
    const listening = first[1]!;
    expect(rows[0]!.value).toEqual({
      theta: listening.theta,
      se: listening.se,
      band: listening.band,
      score: listening.score,
      n: listening.n,
      nUsed: listening.nUsed,
      effN: listening.effN,
      lastEvidenceAt: listening.lastEvidenceAt,
      rubricVersion: RUBRIC_VERSION,
      estimatorVersion: ESTIMATOR_VERSION,
    });

    // The next UTC day appends a second sample; DISTINCT ON reads the newest.
    const nextDay = new Date('2026-08-11T00:30:00Z');
    await estimateAbility(userId, { now: nextDay });
    const after = await pg.pool.query(
      `SELECT id FROM user_progress WHERE user_id = $1 AND metric_type = 'ability_theta_listening'`,
      [userId],
    );
    expect(after.rows).toHaveLength(2);

    const metrics = await currentMetrics(userId);
    expect(metrics).toHaveLength(1); // DISTINCT ON collapses to the current value
    expect(metrics[0]!.metric_type).toBe('ability_theta_listening');
    expect(metrics[0]!.value['estimatorVersion']).toBe(ESTIMATOR_VERSION);
  });

  it('insufficient dimensions and writing are never sampled', async () => {
    const userId = await seedUser('est-persist-skip@example.com');
    // Sufficient WRITING evidence only — every DIMENSION_ORDER dim is
    // insufficient, and writing (though estimated) is not in the metric set.
    for (let i = 0; i < 5; i += 1) {
      await seedWriting(userId, daysAgo(i + 1));
    }
    const estimates = await estimateAbility(userId, {
      now: NOW,
      includeWriting: true,
    });
    expect(estimates[4]!.insufficient).toBe(false);

    const { rows } = await pg.pool.query(
      `SELECT metric_type FROM user_progress WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('scopes evidence and samples to the requesting user (tenant isolation)', async () => {
    const alice = await seedUser('est-alice@example.com');
    const bob = await seedUser('est-bob@example.com');
    await seedSufficientListening(alice);

    const bobEstimates = await estimateAbility(bob, { now: NOW });
    expect(bobEstimates.every((e) => e.insufficient)).toBe(true);

    await estimateAbility(alice, { now: NOW });
    const { rows } = await pg.pool.query<{ user_id: number }>(
      `SELECT user_id FROM user_progress`,
    );
    expect(rows).toHaveLength(1);
    // user_id is BIGINT — a safe-integer number via the int8 parser
    // (db/pool.ts); Number() on both sides keeps the comparison shape-proof.
    expect(Number(rows[0]!.user_id)).toBe(Number(alice));
  });

  it('persist:false skips the daily sample entirely; the default still writes (F-212 P4)', async () => {
    const userId = await seedUser('est-persist-flag@example.com');
    await seedSufficientListening(userId);

    // The pure-read path (/plan/today): a sufficient estimate is served but
    // NO user_progress row is appended.
    const estimates = await estimateAbility(userId, { now: NOW, persist: false });
    expect(estimates[1]!.insufficient).toBe(false);
    const afterPure = await pg.pool.query(
      `SELECT count(*)::int AS n FROM user_progress WHERE user_id = $1`,
      [userId],
    );
    expect(afterPure.rows[0]!.n).toBe(0);

    // Default (persist omitted) — /ability/estimate behavior unchanged: the
    // day's sample is written exactly as before the flag existed.
    await estimateAbility(userId, { now: NOW });
    const afterDefault = await pg.pool.query<{ metric_type: string }>(
      `SELECT metric_type FROM user_progress WHERE user_id = $1`,
      [userId],
    );
    expect(afterDefault.rows).toHaveLength(1);
    expect(afterDefault.rows[0]!.metric_type).toBe('ability_theta_listening');
  });

  it('a failed sample write is swallowed — the estimate is still served', async () => {
    const userId = await seedUser('est-persist-fail@example.com');
    await seedSufficientListening(userId);
    await pg.pool.query('ALTER TABLE user_progress RENAME TO user_progress_hidden');
    try {
      const estimates = await estimateAbility(userId, { now: NOW });
      expect(estimates[1]!.insufficient).toBe(false);
      expect(estimates[1]!.theta).not.toBeNull();
    } finally {
      await pg.pool.query(
        'ALTER TABLE user_progress_hidden RENAME TO user_progress',
      );
    }
  });
});

describe('estimateAbility — config override seam', () => {
  it('a tightened gate flips a passing dimension to insufficient', async () => {
    const userId = await seedUser('est-config@example.com');
    await seedSufficientListening(userId);
    const estimates = await estimateAbility(userId, {
      now: NOW,
      config: { ...DEFAULT_ESTIMATOR_CONFIG, minNUsed: 7 },
    });
    expect(estimates[1]!.insufficient).toBe(true);
  });
});
