/**
 * Per-route tests for src/routes/plan.ts (Pass 4 — Today screen goes live;
 * Wave 2 backend batch re-sources Reading + adds deep-link fields).
 *
 * Route:
 *   GET /plan/today
 *
 * Coverage:
 *   - auth required (401 unauthenticated)
 *   - dueCount counts only live, due, non-suspended, non-deleted, non-hanja
 *     cards (hanja excluded until the F-075 review UI can drain them)
 *   - reading is sourced from THIS user's own reading_chapters /
 *     generated_stories (Wave 2 re-source — replaces the old public
 *     ttmik_lessons pick, TODAY_NAV_SCOPING.md B4 Option 2), carrying
 *     sourceKind/chapterId/storyId for the Today tile's deep-link
 *   - listening carries corpus + episodeNumber (Wave 2, B5)
 *   - writing carries promptId (Wave 2, B6)
 *   - reading/writing band-preference follows the diagnostic estimate
 *   - largestGap is the weakest of reading/listening/writing
 *   - selection is deterministic per (user, day) — refetch returns the same plan
 *   - empty corpus → that task is null (graceful), others still resolve
 *
 * writing_prompts is reference data seeded by migration 013, so the Writing
 * branch resolves without per-test seeding. The ttmik/iyagi corpora are
 * truncated per-test; reading_chapters/generated_stories/book_uploads are
 * user-owned and CASCADE away for free when `users` is truncated per-test —
 * no explicit truncation needed for them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import {
  registerUser,
  seedHanjaCharacter,
  seedTtmikLesson,
  seedIyagiEpisode,
  seedVocabCard,
  seedDiagnosticSnapshot,
  seedWritingPrompt,
  seedBookUpload,
  seedReadingChapter,
  seedReadingPassage,
  seedGeneratedStory,
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
  it('returns dueCount + reading + listening + writing + largestGap, with Wave 2 deep-link fields', async () => {
    // Reading (Wave 2): sourced from THIS user's own reading_chapters — an
    // owned book + one chapter + one passage — not the public ttmik_lessons
    // corpus the route used before the re-source.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
      title: '1장',
    });
    // 120 chars → round(120 / 120) = 1, clamped up to the 2-min floor.
    // Pinned exactly so a wrong pace constant or a broken clamp fails.
    await seedReadingPassage(pg.pool, chapterId, { body: '가'.repeat(120) });
    await seedIyagiEpisode(pg.pool, { number: 7 });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);

    const body = res.body as {
      dueCount: number;
      reading: {
        title: string;
        mins: number;
        level: string;
        tag: string;
        sourceKind: string;
        chapterId: number | null;
        storyId: number | null;
      } | null;
      listening: {
        title: string;
        mins: number;
        level: string;
        tag: string;
        corpus: string;
        episodeNumber: number;
      } | null;
      writing: {
        title: string;
        mins: number;
        level: string;
        tag: string;
        promptId: number;
        // Optional in the wire contract (older envelopes omit it) — this
        // test still asserts it is PRESENT and matches the bank row.
        promptKr?: string;
      } | null;
      largestGap: string | null;
    };

    expect(body.dueCount).toBe(0); // no cards seeded

    expect(body.reading).not.toBeNull();
    expect(body.reading?.tag).toBe('Reading');
    expect(body.reading?.sourceKind).toBe('chapter');
    expect(body.reading?.chapterId).toBe(chapterId);
    expect(body.reading?.storyId).toBeUndefined();
    expect(body.reading?.title).toBe('1장');
    expect(body.reading?.mins).toBe(2);
    // reading_chapters carries no proficiency band at all → centre default.
    expect(body.reading?.level).toBe('L4');

    expect(body.listening).not.toBeNull();
    expect(body.listening?.tag).toBe('Listening');
    expect(body.listening?.level).toBe('L3→L4');
    expect(body.listening?.corpus).toBe('iyagi');
    expect(body.listening?.episodeNumber).toBe(7);
    // 2 seeded sentences → round(2 * 15 / 60) = 1, clamped up to the 3-min
    // floor. Pinned exactly for the same reason as reading above.
    expect(body.listening?.mins).toBe(3);

    expect(body.writing).not.toBeNull();
    expect(body.writing?.tag).toBe('Writing');
    expect(['L3', 'L4', 'L5+']).toContain(body.writing?.level);
    expect(typeof body.writing?.promptId).toBe('number');
    // F-134: the tile preview carries the FULL prompt body of the SAME bank
    // row promptId names — never a different row's text.
    const promptRow = await pg.pool.query<{ prompt_kr: string }>(
      'SELECT prompt_kr FROM writing_prompts WHERE id = $1',
      [body.writing!.promptId],
    );
    expect(body.writing?.promptKr).toBe(promptRow.rows[0]!.prompt_kr);

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

  it('excludes due hanja cards — the Review queue cannot drain them yet', async () => {
    // /vocab/cards/due filters hanja cards out and no client consumes
    // /hanja/cards/due, so counting them in dueCount would show phantom
    // workload the Review screen can never clear. Re-visit with the F-075
    // hanja review UI (see plan.ts).
    await seedTtmikLesson(pg.pool);
    const { agent, userId } = await registerUser(t.app, pg.pool);

    await seedVocabCard(pg.pool, userId, { dueOffsetMs: -60_000 }); // counts
    const hanjaId = await seedHanjaCharacter(pg.pool, { char: '計', sound: '계' });
    await pg.pool.query(
      `INSERT INTO vocab_cards (user_id, face, hanja_character_id, due_at)
       VALUES ($1, 'recognition'::card_face, $2, now() - interval '1 minute')`,
      [userId, hanjaId],
    ); // due, live — but hanja → must NOT count

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    expect((res.body as { dueCount: number }).dueCount).toBe(1);
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

describe('GET /plan/today — reading re-source (Wave 2)', () => {
  it('prefers a generated_stories row whose band matches the reading estimate, over a bandless chapter', async () => {
    // A low reading estimate (<3.5) → estimateToProficiency → 'L3', so the
    // band CASE must surface the L3 story even though a bandless chapter
    // (reading_chapters carries no level at all — it can never win the
    // band-match tier) and an L5+ story are also selectable.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId);
    await seedReadingPassage(pg.pool, chapterId);
    const storyId = await seedGeneratedStory(pg.pool, userId, {
      level: 'L3',
      title: 'L3 story',
    });
    await seedGeneratedStory(pg.pool, userId, { level: 'L5+', title: 'L5+ story' });
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 2.0 });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const reading = (
      res.body as {
        reading: { sourceKind: string; storyId: number | null; level: string } | null;
      }
    ).reading;
    expect(reading?.sourceKind).toBe('story');
    expect(reading?.storyId).toBe(storyId);
    expect(reading?.level).toBe('L3');
  });

  it('falls back to the chapter when no story exists, and defaults a NULL chapter title to "Chapter N"', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
      chapterNumber: 1,
      title: null,
    });
    await seedReadingPassage(pg.pool, chapterId);
    // A band preference exists but there is no story to match it — the
    // chapter must still surface (never a fabricated null just because
    // nothing matched the band).
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 5.0 });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const reading = (
      res.body as {
        reading: { sourceKind: string; chapterId: number | null; title: string } | null;
      }
    ).reading;
    expect(reading?.sourceKind).toBe('chapter');
    expect(reading?.chapterId).toBe(chapterId);
    // NULL chapter title → server-derived "Chapter N" fallback (mirrors the
    // POST /reading/attempts route's own fallback), never an empty string.
    expect(reading?.title).toBe('Chapter 1');
  });

  it('never surfaces another user’s reading_chapters or generated_stories — unlike the old public ttmik_lessons pick, this content is user-owned', async () => {
    const other = await registerUser(t.app, pg.pool);
    const otherUploadId = await seedBookUpload(pg.pool, other.userId, { type: 'literature' });
    const otherChapterId = await seedReadingChapter(pg.pool, other.userId, otherUploadId);
    await seedReadingPassage(pg.pool, otherChapterId);
    await seedGeneratedStory(pg.pool, other.userId);

    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    expect((res.body as { reading: unknown | null }).reading).toBeNull();
  });
});

describe('GET /plan/today — deterministic per day', () => {
  it('returns the same plan across repeated fetches in a day', async () => {
    // Several selectable candidates across BOTH reading sources + iyagi, so
    // a non-deterministic pick would likely differ between the two fetches.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    for (let i = 1; i <= 3; i += 1) {
      const chapterId = await seedReadingChapter(pg.pool, userId, uploadId, {
        chapterNumber: i,
        title: `chapter ${String(i)}`,
      });
      await seedReadingPassage(pg.pool, chapterId);
    }
    for (let i = 1; i <= 2; i += 1) {
      await seedGeneratedStory(pg.pool, userId, { title: `story ${String(i)}` });
    }
    for (let i = 1; i <= 5; i += 1) {
      await seedIyagiEpisode(pg.pool, { number: i });
    }

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
    // No reading_chapters/generated_stories seeded for this user → reading is
    // null (an empty personal library, same honest contract as before the
    // Wave 2 re-source). Iyagi seeded → listening real.
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
// F-212 P4 — the additive `recommendation` field. Evidence is seeded through
// the diagnostic_responses log (the same placed-evidence source the
// estimate.test.ts suite uses) so the Phase-2 estimator finds a sufficient
// dimension; the recommender then ranks it against the candidate pools.
// ---------------------------------------------------------------------------

/** One diagnostic run for a user (evidence container). */
async function seedRun(userId: number): Promise<string> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO diagnostic_runs (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  return rows[0]!.id;
}

/** Six recent placed listening responses (5 right, 1 wrong) — clears the
 *  Phase-2 min-evidence gate for the listening dimension (nUsed ≥ 5, fresh
 *  recency weights), same recipe as estimate.test.ts. */
async function seedSufficientListening(userId: number): Promise<void> {
  const runId = await seedRun(userId);
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 6; i += 1) {
    await pg.pool.query(
      `INSERT INTO diagnostic_responses
          (run_id, ordinal, section, source_kind, source_ref, difficulty,
           kind, item_payload, correct_answer, picked, is_correct, answered_at)
       VALUES ($1, $2, 'listening', 'topik', 'f212-p4-ref', 3.5, 'mc',
               '{"prompt":"고르세요"}'::jsonb, 'a', $3, $4, $5)`,
      [
        runId,
        i + 1,
        i !== 5 ? 'a' : 'b',
        i !== 5,
        new Date(Date.now() - (i + 1) * DAY_MS).toISOString(),
      ],
    );
  }
}

describe('GET /plan/today — recommendation (F-212 P4)', () => {
  it('recommends the evidence-backed dimension, deterministically, without writing user_progress', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedSufficientListening(userId);
    await seedIyagiEpisode(pg.pool, { number: 11 });
    await seedIyagiEpisode(pg.pool, { number: 12 });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const body = res.body as {
      recommendation: {
        dimension: string;
        exploratory: boolean;
        reasonCode: string;
        reasonEn: string;
        reasonKr: string;
        level: string;
        deepLink: string;
        title: string;
        mins: number;
        corpus?: string;
        episodeNumber?: number;
      } | null;
      alternatives?: unknown[];
    };

    // Listening is the ONLY sufficient dimension, and the other three have no
    // content to explore (no library, no cards, no bank) — so listening is
    // both the Stage-A winner and the only candidate-bearing dimension.
    expect(body.recommendation).not.toBeNull();
    const rec = body.recommendation!;
    expect(rec.dimension).toBe('listening');
    expect(rec.exploratory).toBe(false);
    expect(['weakest_dimension', 'due_backlog', 'low_confidence', 'baseline']).toContain(
      rec.reasonCode,
    );
    expect(rec.reasonEn.length).toBeGreaterThan(0);
    expect(rec.reasonKr.length).toBeGreaterThan(0);
    expect(rec.corpus).toBe('iyagi');
    expect([11, 12]).toContain(rec.episodeNumber);
    expect(rec.deepLink).toBe(
      `/learn/listen?corpus=iyagi&episode=${String(rec.episodeNumber)}`,
    );
    expect(typeof rec.mins).toBe('number');
    // The internal scoring fields never leak onto the wire.
    expect(rec).not.toHaveProperty('itemKey');
    expect(rec).not.toHaveProperty('b');
    // No other dimension has candidates → no alternatives.
    expect(body.alternatives).toEqual([]);

    // Deterministic per (user, Seoul-day): a refetch returns the SAME plan +
    // recommendation.
    const second = await agent.get('/plan/today');
    expect(second.body).toEqual(res.body);

    // /plan/today stays a PURE READ: estimateAbility ran with persist:false,
    // so the estimator's daily θ sample was NOT appended.
    const progress = await pg.pool.query(
      `SELECT count(*)::int AS n FROM user_progress WHERE user_id = $1`,
      [userId],
    );
    expect(progress.rows[0]!.n).toBe(0);
  });

  it('cold start (no evidence at all) → recommendation null, tiles intact', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Content exists — but with zero evidence every dimension is insufficient,
    // and recommending on nothing would be a dishonest guess.
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId);
    await seedReadingPassage(pg.pool, chapterId);
    await seedIyagiEpisode(pg.pool, { number: 3 });

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const body = res.body as {
      recommendation: unknown | null;
      alternatives?: unknown[];
      reading: unknown | null;
      listening: unknown | null;
      writing: unknown | null;
    };
    expect(body.recommendation).toBeNull();
    expect(body.alternatives).toBeUndefined(); // omitted alongside the null
    // The existing deterministic tiles are untouched by the cold start.
    expect(body.reading).not.toBeNull();
    expect(body.listening).not.toBeNull();
    expect(body.writing).not.toBeNull();
  });

  it('is per-user isolated: one user’s evidence never leaks into another’s plan', async () => {
    const a = await registerUser(t.app, pg.pool);
    await seedSufficientListening(a.userId);
    await seedIyagiEpisode(pg.pool, { number: 21 });

    const b = await registerUser(t.app, pg.pool);
    const resB = await b.agent.get('/plan/today');
    expect(resB.status).toBe(200);
    expect((resB.body as { recommendation: unknown | null }).recommendation).toBeNull();

    const resA = await a.agent.get('/plan/today');
    expect(
      (resA.body as { recommendation: { dimension: string } | null }).recommendation
        ?.dimension,
    ).toBe('listening');
  });

  it('surfaces the due backlog through the vocab dimension when cards pile up', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Listening sufficient (so the run is NOT a cold start) …
    await seedSufficientListening(userId);
    await seedIyagiEpisode(pg.pool, { number: 5 });
    // … and a saturated vocab due backlog. Vocab itself is insufficient
    // (no vocab evidence), so it wins on EXPLORE_BASE — the point here is
    // that the due cards give the vocab dimension real candidates and the
    // recommendation deep-links into the review queue.
    for (let i = 0; i < 3; i += 1) {
      await seedVocabCard(pg.pool, userId, { dueOffsetMs: -60_000 * (i + 1) });
    }

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const rec = (res.body as {
      recommendation: { dimension: string; deepLink: string; exploratory: boolean } | null;
    }).recommendation;
    expect(rec).not.toBeNull();
    expect(rec!.dimension).toBe('vocab');
    expect(rec!.exploratory).toBe(true); // honest: vocab evidence is insufficient
    expect(rec!.deepLink).toBe('/learn/vocab');
    // The sufficient listening dimension rides along as an alternative.
    const alts = (res.body as { alternatives?: Array<{ dimension: string }> }).alternatives;
    expect(alts?.map((x) => x.dimension)).toContain('listening');
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
    // Rubric-tagged: the /plan/today writing pick filters `rubric IS NOT NULL`
    // (F-014 reconciliation), so untagged rows would never surface here.
    await pg.pool.query('TRUNCATE TABLE writing_prompts RESTART IDENTITY CASCADE');
    await seedWritingPrompt(pg.pool, { level: 'L3', title: 'L3 prompt', rubric: 'topik_ii_53' });
    await seedWritingPrompt(pg.pool, { level: 'L5+', title: 'L5+ prompt', rubric: 'topik_ii_54' });
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

describe('GET /plan/today — rubric-NULL prompts are structurally excluded', () => {
  it('does NOT advertise an active but rubric-NULL (legacy) prompt', async () => {
    // F-014 fix-pass (SF-1): the reconciliation invariant must hold by QUERY
    // SHAPE, not just by data state. An operator re-activating a retired
    // legacy row (is_active = TRUE, rubric = NULL) must not let /plan/today
    // advertise a prompt GET /writing/prompts will never serve. Bank contains
    // ONLY such a row → the writing task must be null, exactly as if the bank
    // were empty. A regression that drops `rubric IS NOT NULL` from the
    // plan.ts writing SELECT fails here.
    await pg.pool.query('TRUNCATE TABLE writing_prompts RESTART IDENTITY CASCADE');
    await seedWritingPrompt(pg.pool, {
      title: 'reactivated legacy drill',
      isActive: true,
      rubric: null,
    });
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Reading (Wave 2) is user-scoped — seed a chapter for THIS user so the
    // "other tasks still resolve" assertion below has something to resolve.
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId);
    await seedReadingPassage(pg.pool, chapterId);
    await seedIyagiEpisode(pg.pool);

    const res = await agent.get('/plan/today');
    expect(res.status).toBe(200);
    const body = res.body as { writing: unknown | null; reading: unknown | null };
    expect(body.writing).toBeNull();
    expect(body.reading).not.toBeNull(); // the exclusion is writing-scoped
  });
});

describe('GET /plan/today — writing empty corpus', () => {
  it('returns null writing when the prompt bank is empty', async () => {
    // Empty the bank entirely → the Writing branch's else-arm must yield null
    // (a regression that threw or returned a malformed row on an empty bank
    // would surface here). Reading/listening still resolve from their corpora.
    await pg.pool.query('TRUNCATE TABLE writing_prompts RESTART IDENTITY CASCADE');
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const uploadId = await seedBookUpload(pg.pool, userId, { type: 'literature' });
    const chapterId = await seedReadingChapter(pg.pool, userId, uploadId);
    await seedReadingPassage(pg.pool, chapterId);
    await seedIyagiEpisode(pg.pool);

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
