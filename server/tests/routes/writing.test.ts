/**
 * Per-route tests for src/routes/writing.ts (F-014).
 *
 * Routes:
 *   GET /writing/prompts?rubric=        — active, rubric-tagged prompt bank
 *   GET /writing/prompts/random?rubric= — one random active prompt (B-027)
 *   GET /writing/series?days=           — daily normalized grade series (F-017)
 *
 * The prompt bank under test is the REAL migration-038 seed (the six TOPIK II
 * prompts ported from the client's WRITING_TASKS) — no mocked reference data,
 * per the project's real-corpus-data testing rule. writing_attempts rows are
 * user-owned and cleared by the users CASCADE in beforeEach.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
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
  // users CASCADE clears writing_attempts (user FK). writing_prompts is
  // migration reference data and is intentionally NOT truncated — the prompts
  // tests assert against the real 038 seed.
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  resetLimiters();
});

// ---------------------------------------------------------------------------
// GET /writing/prompts
// ---------------------------------------------------------------------------

describe('GET /writing/prompts — auth required', () => {
  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/writing/prompts?rubric=topik_ii_53');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /writing/prompts — rubric-filtered active bank', () => {
  interface PromptDTO {
    id: number;
    promptKr: string;
    promptEn: string | null;
    level: string;
    rubric: 'topik_ii_53' | 'topik_ii_54';
    estMinutes: number | null;
  }

  it('rubric=topik_ii_53 → exactly the three 038-seeded Q53 prompts, ascending by id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/writing/prompts?rubric=topik_ii_53');
    expect(res.status).toBe(200);
    const prompts = (res.body as { prompts: PromptDTO[] }).prompts;

    // The 8 legacy register-drill rows are inactive + untagged after 038 —
    // only the three seeded Q53 prompts qualify.
    expect(prompts).toHaveLength(3);
    for (const p of prompts) {
      expect(p.rubric).toBe('topik_ii_53');
      expect(typeof p.id).toBe('number');
      expect(typeof p.promptKr).toBe('string');
      expect(p.promptKr.length).toBeGreaterThan(0);
      expect(['L3', 'L4', 'L5+']).toContain(p.level);
      expect(typeof p.estMinutes).toBe('number');
    }
    // Stable ascending-id order (LOCKED contract: stable order).
    const ids = prompts.map((p) => p.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // Real seed content: the stress-relief prompt ported verbatim from
    // Writing.tsx WRITING_TASKS must be present, character for character.
    expect(prompts.map((p) => p.promptKr)).toContain(
      '여러분은 스트레스를 받을 때 어떻게 해소합니까? 자신의 스트레스 해소 방법과 그 방법의 좋은 점을 200~300자로 쓰십시오.',
    );
  });

  it('rubric=topik_ii_54 → exactly the three 038-seeded Q54 prompts', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/writing/prompts?rubric=topik_ii_54');
    expect(res.status).toBe(200);
    const prompts = (res.body as { prompts: PromptDTO[] }).prompts;
    expect(prompts).toHaveLength(3);
    for (const p of prompts) {
      expect(p.rubric).toBe('topik_ii_54');
    }
    expect(prompts.map((p) => p.promptKr)).toContain(
      '환경 보호와 경제 발전 중 무엇이 더 중요하다고 생각합니까? 자신의 의견을 근거와 함께 600~700자로 논술하십시오.',
    );
  });

  it('absent rubric → the whole active tagged bank (both rubrics, 6 prompts)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/writing/prompts');
    expect(res.status).toBe(200);
    const prompts = (res.body as { prompts: PromptDTO[] }).prompts;
    expect(prompts).toHaveLength(6);
    const byRubric = new Map<string, number>();
    for (const p of prompts) {
      byRubric.set(p.rubric, (byRubric.get(p.rubric) ?? 0) + 1);
    }
    expect(byRubric.get('topik_ii_53')).toBe(3);
    expect(byRubric.get('topik_ii_54')).toBe(3);
  });

  it('invalid rubric → 400 (never a silent empty list)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/writing/prompts?rubric=topik_ii_99');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('a deactivated prompt disappears from the list', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // Retire one seeded Q53 row, assert it vanishes, then restore it —
    // writing_prompts is shared reference data other tests read.
    await pg.pool.query(
      `UPDATE writing_prompts SET is_active = FALSE WHERE source_id = 'wp-topik53-01'`,
    );
    try {
      const res = await agent.get('/writing/prompts?rubric=topik_ii_53');
      expect(res.status).toBe(200);
      expect((res.body as { prompts: PromptDTO[] }).prompts).toHaveLength(2);
    } finally {
      await pg.pool.query(
        `UPDATE writing_prompts SET is_active = TRUE WHERE source_id = 'wp-topik53-01'`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// GET /writing/prompts/random (B-027)
// ---------------------------------------------------------------------------

describe('GET /writing/prompts/random — one random active prompt per rubric (B-027)', () => {
  interface PromptDTO {
    id: number;
    promptKr: string;
    promptEn: string | null;
    level: string;
    rubric: 'topik_ii_53' | 'topik_ii_54';
    estMinutes: number | null;
  }

  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/writing/prompts/random?rubric=topik_ii_53');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it.each([['topik_ii_53'], ['topik_ii_54']] as const)(
    'rubric=%s → 200 with exactly one active prompt of that rubric, from the seeded pool',
    async (rubric) => {
      const { agent } = await registerUser(t.app, pg.pool);
      // The legitimate pool is whatever the deterministic list endpoint serves.
      const bank = await agent.get(`/writing/prompts?rubric=${rubric}`);
      const poolIds = (bank.body as { prompts: PromptDTO[] }).prompts.map((p) => p.id);
      expect(poolIds).toHaveLength(3); // real 038 seed

      const res = await agent.get(`/writing/prompts/random?rubric=${rubric}`);
      expect(res.status).toBe(200);
      const prompt = (res.body as { prompt: PromptDTO }).prompt;
      expect(prompt.rubric).toBe(rubric);
      expect(poolIds).toContain(prompt.id);
      expect(typeof prompt.promptKr).toBe('string');
      expect(prompt.promptKr.length).toBeGreaterThan(0);
      expect(['L3', 'L4', 'L5+']).toContain(prompt.level);
      expect(typeof prompt.estMinutes).toBe('number');
    },
  );

  it('is genuinely randomized — repeated calls are not pinned to one prompt', async () => {
    // B-027's symptom: the client always landed on the lowest-id prompt of
    // each rubric. With a 3-prompt pool and 40 uniform draws, P(all 40
    // identical) = 3 * (1/3)^40 ≈ 8e-19 — a flake would mean the RNG is
    // broken, which is exactly what this test exists to catch.
    const { agent } = await registerUser(t.app, pg.pool);
    for (const rubric of ['topik_ii_53', 'topik_ii_54'] as const) {
      const seen = new Set<number>();
      for (let i = 0; i < 40; i++) {
        const res = await agent.get(`/writing/prompts/random?rubric=${rubric}`);
        expect(res.status).toBe(200);
        seen.add((res.body as { prompt: PromptDTO }).prompt.id);
      }
      expect(seen.size).toBeGreaterThan(1);
    }
  });

  it('missing rubric → 400 (a random pick is per question type)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/writing/prompts/random');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('invalid rubric → 400 (never a silent fallback)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/writing/prompts/random?rubric=topik_ii_99');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('empty pool (every prompt of the rubric retired) → 404, not a null 200', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // Retire the whole Q53 pool, then restore — writing_prompts is shared
    // reference data other tests read.
    await pg.pool.query(
      `UPDATE writing_prompts SET is_active = FALSE WHERE rubric = 'topik_ii_53'`,
    );
    try {
      const res = await agent.get('/writing/prompts/random?rubric=topik_ii_53');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    } finally {
      await pg.pool.query(
        `UPDATE writing_prompts SET is_active = TRUE WHERE rubric = 'topik_ii_53'`,
      );
    }
  });

  it('never serves an inactive prompt even when the pool shrinks', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    // Retire one seeded Q53 row; over repeated draws its id must never appear.
    const { rows } = await pg.pool.query<{ id: string }>(
      `UPDATE writing_prompts SET is_active = FALSE
        WHERE source_id = 'wp-topik53-01' RETURNING id`,
    );
    const retiredId = Number(rows[0]!.id);
    try {
      for (let i = 0; i < 15; i++) {
        const res = await agent.get('/writing/prompts/random?rubric=topik_ii_53');
        expect(res.status).toBe(200);
        expect((res.body as { prompt: PromptDTO }).prompt.id).not.toBe(retiredId);
      }
    } finally {
      await pg.pool.query(
        `UPDATE writing_prompts SET is_active = TRUE WHERE source_id = 'wp-topik53-01'`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// GET /writing/series
// ---------------------------------------------------------------------------

describe('GET /writing/series — daily normalized grade series (F-017)', () => {
  /** The UTC calendar day `daysAgo` days back, formatted as the route emits it. */
  async function utcDay(daysAgo: number): Promise<string> {
    const { rows } = await pg.pool.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE 'UTC')::date - $1::int, 'YYYY-MM-DD') AS d`,
      [daysAgo],
    );
    return rows[0]!.d;
  }

  /** Append a writing_attempts row `daysAgo` days back (the series time axis). */
  async function insertAttempt(
    userId: number,
    opts: {
      total: number;
      max: number;
      rubric?: 'topik_ii_53' | 'topik_ii_54';
      daysAgo?: number;
    },
  ): Promise<void> {
    await pg.pool.query(
      `INSERT INTO writing_attempts
          (user_id, rubric, prompt_kr, sample, total_score, max_total, result, graded_at)
       VALUES ($1, $2, '테스트 프롬프트', '테스트 답안입니다.', $3, $4,
               '{"overallComment":"test"}'::jsonb,
               now() - make_interval(days => $5))`,
      [userId, opts.rubric ?? 'topik_ii_53', opts.total, opts.max, opts.daysAgo ?? 0],
    );
  }

  it('unauthenticated → 401', async () => {
    const res = await request(t.app).get('/writing/series');
    expect(res.status).toBe(401);
  });

  it('normalizes Q53 (/30) and Q54 (/50) to comparable % before the daily avg, ascending', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);

    // Two days ago: Q53 21/30 = 70% + Q54 40/50 = 80% → avg 75. A raw-score
    // average (61/80 → 76) or a summed-then-normalized day (76) would drift on
    // other mixes; the chosen pair keeps the normalized avg exact.
    await insertAttempt(userId, { total: 21, max: 30, rubric: 'topik_ii_53', daysAgo: 2 });
    await insertAttempt(userId, { total: 40, max: 50, rubric: 'topik_ii_54', daysAgo: 2 });
    // Yesterday: Q53 20/30 = 66.67% → round 67, where integer division /
    // trunc would give 66. This day alone makes a `trunc` regression visible.
    await insertAttempt(userId, { total: 20, max: 30, rubric: 'topik_ii_53', daysAgo: 1 });
    // Today: Q54 25/50 → 50.
    await insertAttempt(userId, { total: 25, max: 50, rubric: 'topik_ii_54' });

    const res = await agent.get('/writing/series');
    expect(res.status).toBe(200);
    const series = res.body.series as {
      metric: string;
      unit: string;
      points: { date: string; value: number }[];
    };
    expect(series.metric).toBe('score');
    expect(series.unit).toBe('%');
    expect(series.points).toEqual([
      { date: await utcDay(2), value: 75 },
      { date: await utcDay(1), value: 67 },
      { date: await utcDay(0), value: 50 },
    ]);
  });

  it("is user-scoped (no IDOR) — another user's attempts never appear", async () => {
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await insertAttempt(a.userId, { total: 30, max: 30 }); // 100%
    await insertAttempt(b.userId, { total: 0, max: 30 }); // 0%

    const resA = await a.agent.get('/writing/series');
    expect(resA.status).toBe(200);
    expect(resA.body.series.points).toEqual([{ date: await utcDay(0), value: 100 }]);

    const resB = await b.agent.get('/writing/series');
    expect(resB.body.series.points).toEqual([{ date: await utcDay(0), value: 0 }]);
  });

  it('honors the days window (default 30, widenable to 90)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await insertAttempt(userId, { total: 24, max: 30 }); // today, 80%
    await insertAttempt(userId, { total: 15, max: 30, daysAgo: 40 }); // 50%

    const res = await agent.get('/writing/series');
    expect(res.status).toBe(200);
    expect(res.body.series.points).toEqual([{ date: await utcDay(0), value: 80 }]);

    const wide = await agent.get('/writing/series?days=90');
    expect(wide.body.series.points).toEqual([
      { date: await utcDay(40), value: 50 },
      { date: await utcDay(0), value: 80 },
    ]);
  });

  it('no attempts → 200 with empty points (not an error)', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/writing/series');
    expect(res.status).toBe(200);
    expect(res.body.series).toEqual({ metric: 'score', unit: '%', points: [] });
  });

  it.each([['days=0'], ['days=91']])('%s → 400 (window is 1..90)', async (qs) => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get(`/writing/series?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});
