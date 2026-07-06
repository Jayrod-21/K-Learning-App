/**
 * Per-route tests for src/routes/plan.ts (Pass 4 — Today screen goes live).
 *
 * Route:
 *   GET /plan/today
 *
 * Coverage:
 *   - auth required (401 unauthenticated)
 *   - dueCount counts only live, due, non-suspended, non-deleted cards
 *   - reading / listening / writing tasks are surfaced from the corpora
 *   - reading band-preference follows the diagnostic reading estimate
 *   - largestGap is the weakest of reading/listening/writing
 *   - selection is deterministic per (user, day) — refetch returns the same plan
 *   - empty corpus → that task is null (graceful), others still resolve
 *
 * writing_prompts is reference data seeded by migration 013, so the Writing
 * branch resolves without per-test seeding. The corpora (ttmik/iyagi) are
 * truncated per-test so each case controls exactly what is selectable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedTtmikLesson,
  seedIyagiEpisode,
  seedVocabCard,
  seedDiagnosticSnapshot,
  seedWritingPrompt,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { planDateSql } from '../../src/routes/plan.js';

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
  // users CASCADE clears vocab_cards + diagnostic_snapshots (user FK). The
  // ttmik_lessons / iyagi_episodes tables are truncated explicitly so each test
  // starts from a known-empty reading/listening corpus and seeds only what it
  // asserts on. Two tables are intentionally NOT truncated here:
  //   - writing_prompts: migration-013 reference data. Tests that need an exact
  //     bank truncate + reseed it themselves and run LAST (the truncating
  //     writing tests below) — beforeEach does not restore the 8 seed rows.
  //   - corpus_sources: the backing catalog rows accumulate across tests. This
  //     is benign — the route reads ttmik_lessons.book_level / writing_prompts,
  //     never corpus_sources — and ensureCorpusSource reuses an existing row.
  await pg.pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  await pg.pool.query('TRUNCATE TABLE ttmik_lessons, iyagi_episodes CASCADE');
  resetLimiters();
});

describe('plan — auth required', () => {
  it('GET /plan/today unauthenticated → 401', async () => {
    const res = await request(t.app).get('/plan/today');
    expect(res.status).toBe(401);
  });
});

describe('GET /plan/today — shape + content', () => {
  it('returns dueCount + reading + listening + writing + largestGap', async () => {
    await seedTtmikLesson(pg.pool, { level: 1, number: 1 });
    await seedIyagiEpisode(pg.pool, { number: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);

    const body = res.body as {
      dueCount: number;
      reading: { title: string; mins: number; level: string; tag: string } | null;
      listening: { title: string; mins: number; level: string; tag: string } | null;
      writing: { title: string; mins: number; level: string; tag: string } | null;
      largestGap: string | null;
    };

    expect(body.dueCount).toBe(0); // no cards seeded
    expect(body.reading).not.toBeNull();
    expect(body.reading?.tag).toBe('Reading');
    // 2 seeded sentences → round(2 * 12 / 60) = 0, clamped up to the 2-min
    // floor. Pinned exactly so a wrong pace constant or a broken clamp fails.
    expect(body.reading?.mins).toBe(2);
    expect(body.listening).not.toBeNull();
    expect(body.listening?.tag).toBe('Listening');
    expect(body.listening?.level).toBe('L3→L4');
    // 2 seeded sentences → round(2 * 15 / 60) = 1, clamped up to the 3-min
    // floor. Pinned exactly for the same reason as reading above.
    expect(body.listening?.mins).toBe(3);
    expect(body.writing).not.toBeNull();
    expect(body.writing?.tag).toBe('Writing');
    expect(['L3', 'L4', 'L5+']).toContain(body.writing?.level);
    // No diagnostic snapshot yet → no gap highlight.
    expect(body.largestGap).toBeNull();
  });
});

describe('GET /plan/today — dueCount filters', () => {
  it('counts only live, due, non-suspended, non-deleted cards', async () => {
    await seedTtmikLesson(pg.pool);
    await seedIyagiEpisode(pg.pool);
    const { agent, userId } = await registerUser(t.app, pg.pool);

    await seedVocabCard(pg.pool, userId, { dueOffsetMs: -60_000 }); // due → counts
    await seedVocabCard(pg.pool, userId, { dueOffsetMs: -1_000 }); // due → counts
    await seedVocabCard(pg.pool, userId, { dueOffsetMs: 86_400_000 }); // future → no
    await seedVocabCard(pg.pool, userId, { dueOffsetMs: -60_000, suspended: true }); // no
    await seedVocabCard(pg.pool, userId, { dueOffsetMs: -60_000, deleted: true }); // no

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    expect((res.body as { dueCount: number }).dueCount).toBe(2);
  });

  it('does not count another user’s due cards', async () => {
    await seedTtmikLesson(pg.pool);
    const a = await registerUser(t.app, pg.pool);
    const b = await registerUser(t.app, pg.pool);
    await seedVocabCard(pg.pool, b.userId, { dueOffsetMs: -60_000 });

    const res = await a.agent.get('/plan/today');
    expect((res.body as { dueCount: number }).dueCount).toBe(0);
  });
});

describe('GET /plan/today — largestGap', () => {
  it('reports the weakest of reading/listening/writing', async () => {
    await seedTtmikLesson(pg.pool);
    await seedIyagiEpisode(pg.pool);
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // listening is the lowest estimate among the three surfaced modalities.
    await seedDiagnosticSnapshot(pg.pool, userId, {
      reading: 5.0,
      listening: 2.0,
      writing: 4.0,
      grammar: 1.0, // not one of the three → must be ignored
    });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    expect((res.body as { largestGap: string | null }).largestGap).toBe('Listening');
  });

  it('is null when the snapshot exercised none of the three modalities', async () => {
    await seedTtmikLesson(pg.pool);
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedDiagnosticSnapshot(pg.pool, userId, { grammar: 3.0, vocab: 4.0 });

    const res = await agent.get('/plan/today');
    expect((res.body as { largestGap: string | null }).largestGap).toBeNull();
  });
});

describe('GET /plan/today — reading band preference', () => {
  it('prefers a reading passage whose band matches the reading estimate', async () => {
    // A low reading estimate (<3) → prefer a 'beginner' lesson (label L3) even
    // though an 'advanced' lesson (label L5+) is also selectable.
    await seedTtmikLesson(pg.pool, { number: 1, bookLevel: 'beginner' });
    await seedTtmikLesson(pg.pool, { number: 2, bookLevel: 'advanced' });
    await seedIyagiEpisode(pg.pool);
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 2.0 });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    expect((res.body as { reading: { level: string } | null }).reading?.level).toBe('L3');
  });
});

describe('GET /plan/today — deterministic per day', () => {
  it('returns the same plan across repeated fetches in a day', async () => {
    // Several selectable rows so a non-deterministic pick would likely differ.
    for (let i = 1; i <= 5; i += 1) {
      await seedTtmikLesson(pg.pool, { number: i, title: `lesson ${String(i)}` });
      await seedIyagiEpisode(pg.pool, { number: i });
    }
    const { agent } = await registerUser(t.app, pg.pool);

    const first = await agent.get('/plan/today');
    const second = await agent.get('/plan/today');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Guard against a vacuous pass: if a refactor nulled every task, two
    // identical all-null bodies would still satisfy toEqual. Assert the plan
    // is non-trivially populated before comparing.
    expect((first.body as { reading: unknown | null }).reading).not.toBeNull();
    expect(second.body).toEqual(first.body);
  });
});

describe('GET /plan/today — rollover boundary is timezone-pinned', () => {
  // Regression guard for the day-rollover boundary (REVIEW_P4_server_sql B1).
  // The selection hash must pin the date to 'Asia/Seoul', NOT use a bare
  // `current_date` — the latter evaluates in the session TimeZone GUC and would
  // slide the plan's rollover to a mid-morning hour for a Korea-based user (and
  // reshuffle it under them at that hour).
  //
  // This test exercises the PRODUCTION expression itself: it imports
  // `planDateSql` from the route and evaluates it (against a fixed instant, so
  // the assertion is deterministic with no midnight-crossing flake) under two
  // extreme session zones. If someone weakens `planDateSql` — drops the
  // `AT TIME ZONE 'Asia/Seoul'` pin, or reverts it toward a session-relative
  // date — the invariance assertion below fails. (The remaining gap, asserting
  // the route's query strings still INTERPOLATE `planDateSql` rather than a bare
  // `current_date`, needs an injectable clock since the route calls real
  // `now()` through a shared-UTC pool — tracked as FU-NF-38.)
  it('pins the selection date to Asia/Seoul regardless of session timezone', async () => {
    const client = await pg.pool.connect();
    try {
      // Fixed instant: 2026-01-01 14:30 UTC = 2026-01-01 23:30 in Asia/Seoul,
      // so the pinned date is 2026-01-01 and must NOT depend on the session
      // zone. The same instant is 2026-01-01 02:30 under Etc/GMT+12 but
      // 2026-01-02 04:30 under Etc/GMT-14 — a bare session-zone date drifts a
      // full day across these two zones (26h apart); the pin does not.
      const INSTANT = "TIMESTAMPTZ '2026-01-01 14:30:00+00'";
      // Build the date SQL from the EXACT production helper, substituting the
      // fixed instant for now(). This is what ties the guard to the route.
      const pinnedExpr = planDateSql(INSTANT);
      const pinnedDate = async (): Promise<string> => {
        const r = await client.query<{ d: string }>(`SELECT ${pinnedExpr} AS d`);
        return r.rows[0]!.d;
      };
      const sessionDate = async (): Promise<string> => {
        // Mirror a bare-current_date boundary: the instant cast to a date in
        // the *session* zone — what `current_date` would yield at this instant.
        const r = await client.query<{ d: string }>(`SELECT (${INSTANT})::date::text AS d`);
        return r.rows[0]!.d;
      };

      await client.query("SET TIME ZONE 'Etc/GMT+12'");
      const pinnedFarWest = await pinnedDate();
      const bareFarWest = await sessionDate();

      await client.query("SET TIME ZONE 'Etc/GMT-14'");
      const pinnedFarEast = await pinnedDate();
      const bareFarEast = await sessionDate();

      // The production pinned expression yields the same Seoul date under both
      // session zones. Fails if planDateSql drops the Asia/Seoul pin.
      expect(pinnedFarWest).toBe('2026-01-01');
      expect(pinnedFarEast).toBe('2026-01-01');
      // A bare session-zone date is the thing that would drift: the two zones
      // are 26h apart, so they cannot both equal the pinned Seoul date.
      expect(bareFarWest === pinnedFarWest && bareFarEast === pinnedFarEast).toBe(false);
      expect(bareFarEast).toBe('2026-01-02'); // proves the drift concretely
    } finally {
      // Reset the session TZ before returning the connection to the pool, so a
      // later test that happens to reuse it does not inherit Etc/GMT-14.
      await client.query('SET TIME ZONE DEFAULT');
      client.release();
    }
  });
});

describe('GET /plan/today — graceful empty corpus', () => {
  it('returns null for a task whose corpus is empty, others still resolve', async () => {
    // No TTMIK lessons seeded → reading is null. Iyagi seeded → listening real.
    await seedIyagiEpisode(pg.pool, { number: 1 });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const body = res.body as {
      reading: unknown | null;
      listening: unknown | null;
      writing: unknown | null;
    };
    expect(body.reading).toBeNull();
    expect(body.listening).not.toBeNull();
    expect(body.writing).not.toBeNull(); // migration-013 seed guarantees one
  });
});

describe('GET /plan/today — writing task after F-014 prompt reconciliation', () => {
  it('advertises an active rubric-tagged prompt (the retired legacy rows never surface)', async () => {
    // Migration 038 retired the 8 legacy register-drill rows (rubric IS NULL →
    // is_active = FALSE) and seeded six rubric-tagged TOPIK II prompts. The
    // active pool must therefore be entirely rubric-tagged…
    const untaggedActive = await pg.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM writing_prompts
        WHERE is_active AND rubric IS NULL`,
    );
    expect(untaggedActive.rows[0]!.n).toBe(0);
    const taggedActive = await pg.pool.query<{ title: string }>(
      `SELECT title FROM writing_prompts WHERE is_active AND rubric IS NOT NULL`,
    );
    expect(taggedActive.rows.length).toBeGreaterThan(0);

    // …and /plan/today still resolves a Writing task, drawn from that pool —
    // i.e. a prompt GET /writing/prompts also serves, closing the old
    // tile-vs-screen mismatch.
    await seedTtmikLesson(pg.pool);
    await seedIyagiEpisode(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const writing = (res.body as { writing: { title: string } | null }).writing;
    expect(writing).not.toBeNull();
    expect(taggedActive.rows.map((r) => r.title)).toContain(writing!.title);
  });
});

// ---------------------------------------------------------------------------
// Writing-branch tests that TRUNCATE the shared writing_prompts bank to control
// it exactly. These MUST stay LAST in the file: beforeEach does NOT restore the
// migration seed rows, so any earlier test that relies on the bank (the shape
// test, the graceful-empty test, the F-014 reconciliation test) would find it
// empty if these ran first.
// ---------------------------------------------------------------------------

describe('GET /plan/today — writing band preference', () => {
  it('prefers a writing prompt whose band matches the writing estimate', async () => {
    // Control the bank exactly: one L3 prompt and one L5+ prompt, nothing else.
    // CASCADE: writing_attempts.prompt_id now FKs writing_prompts (F-014, mig 038),
    // so a bare TRUNCATE is refused even when writing_attempts is empty.
    await pg.pool.query('TRUNCATE TABLE writing_prompts RESTART IDENTITY CASCADE');
    await seedWritingPrompt(pg.pool, { level: 'L3', title: 'L3 prompt' });
    await seedWritingPrompt(pg.pool, { level: 'L5+', title: 'L5+ prompt' });
    await seedTtmikLesson(pg.pool);
    await seedIyagiEpisode(pg.pool);
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // A low writing estimate (<3.5) → estimateToProficiency → 'L3', so the band
    // CASE must surface the L3 prompt even though the L5+ prompt is selectable.
    await seedDiagnosticSnapshot(pg.pool, userId, { writing: 2.0 });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    expect((res.body as { writing: { level: string } | null }).writing?.level).toBe('L3');
  });
});

describe('GET /plan/today — writing empty corpus', () => {
  it('returns null writing when the prompt bank is empty', async () => {
    // Empty the bank entirely → the Writing branch's else-arm must yield null
    // (a regression that threw or returned a malformed row on an empty bank
    // would surface here). Reading/listening still resolve from their corpora.
    await pg.pool.query('TRUNCATE TABLE writing_prompts RESTART IDENTITY CASCADE');
    await seedTtmikLesson(pg.pool);
    await seedIyagiEpisode(pg.pool);
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const body = res.body as {
      reading: unknown | null;
      listening: unknown | null;
      writing: unknown | null;
    };
    expect(body.writing).toBeNull();
    expect(body.reading).not.toBeNull();
    expect(body.listening).not.toBeNull();
  });
});
