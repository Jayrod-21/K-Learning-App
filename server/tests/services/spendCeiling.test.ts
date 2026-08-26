/**
 * Tests for src/services/spendCeiling.ts (Phase 2.6 — the global daily
 * spend-ceiling circuit breaker), against real Postgres (testcontainers).
 *
 * Coverage:
 *   - startOfUtcDay: pure UTC-midnight math, including the just-after/
 *     just-before-midnight boundary instants.
 *   - getGlobalSpendUsdSince: sums claude_usage + story_audio_jobs(done) +
 *     story_image_jobs(done) + generated_items (audio_synthesized_at set,
 *     F-220 slice 3); excludes rows outside the window; excludes a non-done
 *     job / a not-yet-synthesized listening item even when it carries a
 *     (direct-SQL-seeded) cost value.
 *   - getSpendCeilingStatus: exact/uncached breakdown; disabled (ceiling 0)
 *     reads enabled=false + remaining_usd=0; remaining_usd floors at 0 when
 *     already over.
 *   - assertUnderSpendCeiling: disabled is a true no-op (no query at all);
 *     under/at/over-ceiling pass/throw (>= is inclusive); TTL=0 always
 *     recomputes; a nonzero TTL reuses a stale total within the window then
 *     recomputes past it; a transient sum-query error fails OPEN (resolves,
 *     never throws) — the module's documented fail-safe posture.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { setPoolForTesting } from '../../src/db/pool.js';
import { _setConfigForTesting, resetConfig } from '../../src/config/index.js';
import { SpendCeilingExceededError } from '../../src/middleware/errors.js';
import {
  _resetSpendCeilingCacheForTesting,
  assertUnderSpendCeiling,
  getGlobalSpendUsdSince,
  getSpendCeilingStatus,
  startOfUtcDay,
} from '../../src/services/spendCeiling.js';

let pg: PgHandle;

const FAKE_HASH = `$argon2id$${'x'.repeat(70)}`;

beforeAll(async () => {
  pg = await startPostgres();
  setPoolForTesting(pg.pool);
  // Minimal env for loadConfig()'s Zod parse — mirrors tts.test.ts's
  // no-full-app pattern. The real pool is already installed above;
  // DATABASE_URL is only here to satisfy the schema, never dialed.
  process.env.DATABASE_URL = pg.connectionString;
  process.env.KIWI_URL = 'http://kiwi.invalid/';
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(
    `TRUNCATE TABLE claude_usage, story_audio_jobs, story_image_jobs,
                    generated_stories, generated_items, users RESTART IDENTITY CASCADE`,
  );
  _resetSpendCeilingCacheForTesting();
});

afterEach(() => {
  resetConfig();
});

async function seedUser(email: string): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

async function seedStory(userId: number): Promise<number> {
  const { rows } = await pg.pool.query<{ id: number }>(
    `INSERT INTO generated_stories (user_id, title, body_ko, level)
     VALUES ($1, 'T', '본문', 'basic') RETURNING id`,
    [userId],
  );
  return rows[0]!.id;
}

async function seedClaudeUsage(cost: number, occurredAt: Date): Promise<void> {
  await pg.pool.query(
    `INSERT INTO claude_usage (request_id, route, model, cost_estimate_usd, latency_ms, occurred_at)
     VALUES ($1, 'enrich'::claude_route, 'claude-haiku-4-5'::claude_model, $2, 5, $3)`,
    [randomUUID(), cost, occurredAt],
  );
}

async function seedAudioJob(
  userId: number,
  storyId: number,
  status: 'pending' | 'running' | 'done' | 'failed',
  cost: number | null,
  finishedAt: Date | null,
): Promise<void> {
  await pg.pool.query(
    `INSERT INTO story_audio_jobs
        (generated_story_id, user_id, status, char_count, cost_estimate_usd, finished_at)
     VALUES ($1, $2, $3, 100, $4, $5)`,
    [storyId, userId, status, cost, finishedAt],
  );
}

async function seedImageJob(
  userId: number,
  storyId: number,
  status: 'pending' | 'running' | 'done' | 'failed',
  cost: number | null,
  finishedAt: Date | null,
): Promise<void> {
  await pg.pool.query(
    `INSERT INTO story_image_jobs
        (generated_story_id, user_id, status, image_count, cost_estimate_usd, finished_at)
     VALUES ($1, $2, $3, 3, $4, $5)`,
    [storyId, userId, status, cost, finishedAt],
  );
}

let listeningHashSeq = 0;
/** F-220 slice 3 — a generated_items listening row with a given audio cost +
 *  synthesized timestamp (or NULL/NULL to model a not-yet-synthesized draft
 *  item — the settle-only contract getGlobalSpendUsdSince's WHERE clause
 *  relies on). Not gated on migration 103's FK (audio_source_id stays NULL
 *  here — this test only cares about the cost-sum WHERE clause, not the
 *  audio_sources join). */
async function seedListeningItem(cost: number | null, synthesizedAt: Date | null): Promise<void> {
  listeningHashSeq += 1;
  const hash = `${listeningHashSeq.toString(16).padStart(8, '0')}${'c'.repeat(56)}`;
  await pg.pool.query(
    `INSERT INTO generated_items
       (section, level, kind, stem, choices, answer_index, status, created_by,
        prompt_hash, audio_cost_estimate_usd, audio_synthesized_at)
     VALUES ('listening', 'L2', 'audio-mc', 'mock stem',
             '[{"kr":"a"},{"kr":"b"},{"kr":"c"},{"kr":"d"}]'::jsonb, 0, 'draft',
             'test-fixture', $1, $2, $3)`,
    [hash, cost, synthesizedAt],
  );
}

// ---------------------------------------------------------------------------

describe('startOfUtcDay', () => {
  it('returns 00:00:00.000Z of the same UTC calendar day', () => {
    expect(startOfUtcDay(new Date('2026-08-23T15:42:07.123Z')).toISOString()).toBe(
      '2026-08-23T00:00:00.000Z',
    );
  });

  it('an instant just AFTER UTC midnight maps to the day that just started', () => {
    expect(startOfUtcDay(new Date('2026-08-23T00:00:00.001Z')).toISOString()).toBe(
      '2026-08-23T00:00:00.000Z',
    );
  });

  it('an instant just BEFORE UTC midnight maps to that day, not the next', () => {
    expect(startOfUtcDay(new Date('2026-08-23T23:59:59.999Z')).toISOString()).toBe(
      '2026-08-23T00:00:00.000Z',
    );
  });
});

describe('getGlobalSpendUsdSince', () => {
  it('sums cost_estimate_usd across claude_usage + story_audio_jobs(done) + story_image_jobs(done) + generated_items (synthesized)', async () => {
    const userId = await seedUser('sum@test.dev');
    const storyId = await seedStory(userId);
    const now = new Date();
    await seedClaudeUsage(1.5, now);
    await seedAudioJob(userId, storyId, 'done', 0.25, now);
    await seedImageJob(userId, storyId, 'done', 0.4, now);
    await seedListeningItem(0.05, now);

    const result = await getGlobalSpendUsdSince(startOfUtcDay(now));
    expect(result.claude).toBeCloseTo(1.5, 6);
    expect(result.tts).toBeCloseTo(0.25, 6);
    expect(result.images).toBeCloseTo(0.4, 6);
    expect(result.listeningAudio).toBeCloseTo(0.05, 6);
    expect(result.total).toBeCloseTo(2.2, 6);
  });

  it('excludes rows before the window (yesterday spend does not count toward today)', async () => {
    const userId = await seedUser('outside@test.dev');
    const storyId = await seedStory(userId);
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await seedClaudeUsage(5, yesterday);
    await seedAudioJob(userId, storyId, 'done', 5, yesterday);
    await seedImageJob(userId, storyId, 'done', 5, yesterday);
    await seedListeningItem(5, yesterday);

    const result = await getGlobalSpendUsdSince(startOfUtcDay(new Date()));
    expect(result.total).toBe(0);
  });

  it('excludes a job whose status is NOT done even when a cost value is present', async () => {
    // A direct-SQL-seeded 'failed' row with a non-null cost proves the
    // WHERE status = 'done' filter — not just "cost happens to be NULL on a
    // non-done row", which 096's own contract already guarantees in
    // production but this SQL-level test does not rely on.
    const userId = await seedUser('onlydone@test.dev');
    const doneStory = await seedStory(userId);
    const failedStory = await seedStory(userId);
    const now = new Date();
    await seedAudioJob(userId, doneStory, 'done', 0.1, now);
    await seedAudioJob(userId, failedStory, 'failed', 9, now);
    await seedImageJob(userId, doneStory, 'done', 0.2, now);
    await seedImageJob(userId, failedStory, 'failed', 9, now);

    const result = await getGlobalSpendUsdSince(startOfUtcDay(now));
    expect(result.tts).toBeCloseTo(0.1, 6);
    expect(result.images).toBeCloseTo(0.2, 6);
  });

  it('excludes a listening item that is NOT yet synthesized (audio_synthesized_at NULL), even one with a cost value', async () => {
    // 103's settle-only contract: audio_cost_estimate_usd and
    // audio_synthesized_at are always written together by the synth CLI, but
    // this SQL-level test directly seeds a row with a cost but no timestamp
    // to prove the WHERE clause is keyed on audio_synthesized_at, not just
    // "cost happens to be NULL until settled".
    const now = new Date();
    await seedListeningItem(9, null);
    await seedListeningItem(0.03, now);

    const result = await getGlobalSpendUsdSince(startOfUtcDay(now));
    expect(result.listeningAudio).toBeCloseTo(0.03, 6);
  });
});

describe('getSpendCeilingStatus', () => {
  it('disabled (ceiling 0): enabled=false, remaining_usd=0 regardless of real spend', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 0 });
    await seedClaudeUsage(50, new Date());

    const status = await getSpendCeilingStatus();
    expect(status.enabled).toBe(false);
    expect(status.ceiling_usd).toBe(0);
    expect(status.window).toBe('utc_day');
    expect(status.spent_usd.claude).toBeCloseTo(50, 6);
    expect(status.remaining_usd).toBe(0);
  });

  it('enabled: exact breakdown + remaining_usd = ceiling - spent', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 10 });
    const userId = await seedUser('status-enabled@test.dev');
    const storyId = await seedStory(userId);
    const now = new Date();
    await seedClaudeUsage(3, now);
    await seedAudioJob(userId, storyId, 'done', 1, now);
    await seedImageJob(userId, storyId, 'done', 2, now);

    const status = await getSpendCeilingStatus();
    expect(status.enabled).toBe(true);
    expect(status.ceiling_usd).toBe(10);
    expect(status.spent_usd).toEqual({
      total: expect.closeTo(6, 6),
      claude: expect.closeTo(3, 6),
      tts: expect.closeTo(1, 6),
      images: expect.closeTo(2, 6),
      listeningAudio: expect.closeTo(0, 6),
    });
    expect(status.remaining_usd).toBeCloseTo(4, 6);
  });

  it('remaining_usd floors at 0 once spend has already passed the ceiling', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 5 });
    await seedClaudeUsage(9, new Date());

    const status = await getSpendCeilingStatus();
    expect(status.remaining_usd).toBe(0);
  });
});

describe('assertUnderSpendCeiling', () => {
  it('disabled (SPEND_CEILING_DAILY_USD <= 0): resolves WITHOUT querying the DB at all', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 0 });
    const throwingPool = {
      query: async () => {
        throw new Error('must never be called when the ceiling is disabled');
      },
      on: () => {},
    } as unknown as Pool;
    setPoolForTesting(throwingPool);
    try {
      await expect(assertUnderSpendCeiling()).resolves.toBeUndefined();
    } finally {
      setPoolForTesting(pg.pool);
    }
  });

  it('under the ceiling: resolves', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 10, SPEND_CEILING_CACHE_TTL_MS: 0 });
    await seedClaudeUsage(3, new Date());
    await expect(assertUnderSpendCeiling()).resolves.toBeUndefined();
  });

  it('at the ceiling: throws SpendCeilingExceededError (>= is inclusive)', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 5, SPEND_CEILING_CACHE_TTL_MS: 0 });
    await seedClaudeUsage(5, new Date());
    await expect(assertUnderSpendCeiling()).rejects.toBeInstanceOf(SpendCeilingExceededError);
  });

  it('over the ceiling: throws SpendCeilingExceededError', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 5, SPEND_CEILING_CACHE_TTL_MS: 0 });
    await seedClaudeUsage(9, new Date());
    await expect(assertUnderSpendCeiling()).rejects.toBeInstanceOf(SpendCeilingExceededError);
  });

  it('TTL=0 always recomputes: spend added after a passing check trips the very next check', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 5, SPEND_CEILING_CACHE_TTL_MS: 0 });
    await seedClaudeUsage(1, new Date());
    await expect(assertUnderSpendCeiling()).resolves.toBeUndefined();

    await seedClaudeUsage(9, new Date());
    await expect(assertUnderSpendCeiling()).rejects.toBeInstanceOf(SpendCeilingExceededError);
  });

  it('a nonzero TTL reuses the stale cached total within the window, then recomputes past it', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 5, SPEND_CEILING_CACHE_TTL_MS: 200 });
    await seedClaudeUsage(1, new Date());
    // Caches total=1 (well under the ceiling).
    await expect(assertUnderSpendCeiling()).resolves.toBeUndefined();

    // Real total is now 10 (over the ceiling of 5) — but within the TTL
    // window the STALE cached value (1) is reused, so this still resolves.
    await seedClaudeUsage(9, new Date());
    await expect(assertUnderSpendCeiling()).resolves.toBeUndefined();

    // Past the TTL: recompute picks up the real (over-ceiling) total.
    await new Promise((resolve) => setTimeout(resolve, 260));
    await expect(assertUnderSpendCeiling()).rejects.toBeInstanceOf(SpendCeilingExceededError);
  });

  it('a transient sum-query error FAILS OPEN — resolves rather than throwing', async () => {
    _setConfigForTesting({ SPEND_CEILING_DAILY_USD: 1, SPEND_CEILING_CACHE_TTL_MS: 0 });
    const throwingPool = {
      query: async () => {
        throw new Error('simulated connection failure');
      },
      on: () => {},
    } as unknown as Pool;
    setPoolForTesting(throwingPool);
    try {
      await expect(assertUnderSpendCeiling()).resolves.toBeUndefined();
    } finally {
      setPoolForTesting(pg.pool);
    }
  });
});
