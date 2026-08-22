/**
 * Integration tests for /diagnostic routes (Pass 5 — Diagnostic goes live).
 *
 * Routes:
 *   POST /diagnostic
 *   POST /diagnostic/:runId/answer   (grades only — never generates; B-006)
 *   POST /diagnostic/:runId/next     (serves/generates the next item)
 *   POST /diagnostic/:runId/finish
 *   GET  /diagnostic/latest
 *   GET  /diagnostic/trajectory
 *   GET  /diagnostic/history
 *
 * Real Postgres via testcontainers per Bar §"Testing". The Claude proxy is the
 * default deterministic stub (generateDiagnosticItem returns a 4-choice item,
 * answerIndex 0 → choice 'a'). reading/listening items are drawn from seeded
 * topik_items.
 *
 * Security coverage:
 *   - ClientItem NEVER contains correct_answer or explain (the security property)
 *   - run ownership / IDOR (another user's run → 404)
 *   - double-answer / out-of-order responseId → 409
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, makeStubProxy, teardownTestApp, type TestApp } from '../helpers/app.js';
import { setClaudeProxy, maxClaudeCallDurationMs } from '../../src/services/claudeProxy.js';
import {
  SCHEDULE,
  TARGET_ITEM_COUNT,
  WEIGHTS,
  writingClaimTtlSeconds,
} from '../../src/routes/diagnostic.js';
import { SEED_THETA, bandForTheta, nextTheta, thetaToNumeric } from '../../src/services/diagnostic/cat.js';
import { dimensionResultForEstimate, type ScoredResponse } from '../../src/services/diagnostic/scoring.js';
import {
  registerUser,
  seedTopikItem,
  seedVocabEntry,
  seedKgiuEntry,
  seedDiagnosticSnapshot,
  seedHanjaCharacter,
  type RegisteredAgent,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';
import { ClaudeRateLimitError } from '../../src/services/claude/errors.js';

/**
 * All 1-based ordinals SCHEDULE assigns to `section` — tests derive expected
 * serve positions from the REAL schedule instead of hardcoding a second copy
 * of it (diagnostic-upgrade Phase C: WEIGHTS/SCHEDULE changed shape, so any
 * hardcoded ordinal list here would silently drift from production).
 */
function ordinalsFor(section: string): number[] {
  const out: number[] = [];
  SCHEDULE.forEach((s, i) => {
    if (s === section) out.push(i + 1);
  });
  return out;
}
const READING_ORDINALS = ordinalsFor('reading');
const LISTENING_ORDINALS = ordinalsFor('listening');
const HANJA_ORDINALS = ordinalsFor('hanja');
const WRITING_ORDINALS = ordinalsFor('writing');

/**
 * Mirror the production per-answer θ stepping EXACTLY — both the GLOBAL
 * ladder (`ability_estimate`) and each LEVELED dimension's own per-category
 * ladder (`dimension_estimates`, diagnostic-upgrade Phase C) — for a run
 * that serves every SCHEDULE ordinal with no empty-pool skips, using the
 * REAL exported `nextTheta`/`SEED_THETA`/`thetaToNumeric` (cat.ts) so this
 * can never drift from `routes/diagnostic.ts`'s `/answer` handler. Tests use
 * this to derive exact expected per-dimension estimates instead of manual
 * arithmetic.
 *
 * COLD START (fix-pass S1): each dimension's ladder seeds at SEED_THETA on
 * its own first answer, NOT from whatever the GLOBAL θ has climbed/fallen to
 * by the time that dimension is first served — mirrors production's
 * `dimensionEstimates[section] ?? SEED_THETA` at both the serve site
 * (`serveNextItem`) and the step site (`/answer`). This makes every leveled
 * ladder purely a function of its own answers, independent of SCHEDULE
 * order/position.
 */
function simulateLadders(
  isCorrect: (section: string, ordinal: number) => boolean,
): { global: number; sections: Partial<Record<string, number>> } {
  let global = SEED_THETA;
  const sections: Partial<Record<string, number>> = {};
  const sectionCounts: Partial<Record<string, number>> = {};
  let globalAnswerNumber = 0;
  SCHEDULE.forEach((section, i) => {
    if (section === 'hanja') return; // coverage-only — never steps any ladder
    const ordinal = i + 1;
    const correct = isCorrect(section, ordinal);
    globalAnswerNumber += 1;
    global = thetaToNumeric(nextTheta(global, correct, globalAnswerNumber));

    const priorSectionCount = sectionCounts[section] ?? 0;
    const sectionAnswerNumber = priorSectionCount + 1;
    sectionCounts[section] = sectionAnswerNumber;
    const priorSection = sections[section] ?? SEED_THETA;
    sections[section] = thetaToNumeric(nextTheta(priorSection, correct, sectionAnswerNumber));
  });
  return { global, sections };
}

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
    `TRUNCATE TABLE diagnostic_responses, diagnostic_runs, diagnostic_snapshots,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  // topik_items / topik_tests / vocab_entries / kgiu_entries: clear per-test so
  // each scenario controls exactly what is selectable. corpus_sources is left
  // alone (idempotent seeding). hanja_characters is normally shared reference
  // data NOT cleared by a generic beforeEach (see seedHanjaCharacter's own
  // doc) — but THIS file already locally overrides that posture for
  // topik/vocab/kgiu, so hanja_characters joins the same local per-test-clear
  // list (diagnostic-upgrade Phase A): otherwise a test that does not seed
  // its own hanja rows would inherit leftover rows from whichever earlier
  // test in this file last called `seedFullPool`, making the diagnostic's
  // hanja dimension (and the 8-vs-12 `source_kind='generated'` row counts a
  // few tests below assert) depend on test execution order.
  await pg.pool.query(`TRUNCATE TABLE topik_items, topik_tests CASCADE`);
  await pg.pool.query(`DELETE FROM vocab_entries`);
  await pg.pool.query(`DELETE FROM kgiu_entries`);
  await pg.pool.query(`TRUNCATE TABLE hanja_characters CASCADE`);
  resetLimiters();
});

/** Seed a corpus rich enough to serve a full 30-item diagnostic (WEIGHTS,
 *  diagnostic-upgrade Phase C: reading/listening/vocab/grammar = 6 each,
 *  hanja = 4, writing = 2 — reading/listening/vocab/grammar bumped from 4 to
 *  6 so each gets its OWN adaptive ladder with enough of its OWN evidence to
 *  genuinely diverge from the others). 6 reading + 6 listening topik rows
 *  needed, one spare each (7) for slack against the already-served
 *  exclusion; hanja needs >=4 distinct chars per level so a 4-item hanja
 *  slate never repeats a character within one run; writing draws from the
 *  SAME kgiu_entries seeds grammar does, so no separate writing seed is
 *  needed here). */
async function seedFullPool(): Promise<void> {
  // 7 reading + 7 listening at L4 (answer index 1 → choice 'a') — WEIGHTS
  // needs 6 of each; the 7th is slack.
  for (let i = 0; i < 7; i += 1) {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
  }
  // vocab + grammar seeds for the Claude stub's seed-picker queries.
  await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
  await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '낱말' });
  await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
  await seedKgiuEntry(pg.pool, { proficiency: 'L3', pattern: '-기 마련이다' });
  // hanja: 6 distinct L2 + 6 distinct L3 characters (distinct char/sound/
  // gloss_en each) — comfortably above the 4 needed to build a 4-choice MC
  // item (1 answer + 3 distinct-valued distractors) at either level.
  const l2Chars: ReadonlyArray<{ char: string; sound: string; glossEn: string }> = [
    { char: '學', sound: '학', glossEn: 'learn' },
    { char: '校', sound: '교', glossEn: 'school' },
    { char: '生', sound: '생', glossEn: 'life' },
    { char: '大', sound: '대', glossEn: 'big' },
    { char: '國', sound: '국', glossEn: 'country' },
    { char: '人', sound: '인', glossEn: 'person' },
  ];
  const l3Chars: ReadonlyArray<{ char: string; sound: string; glossEn: string }> = [
    { char: '水', sound: '수', glossEn: 'water' },
    { char: '火', sound: '화', glossEn: 'fire' },
    { char: '木', sound: '목', glossEn: 'tree' },
    { char: '金', sound: '금', glossEn: 'gold' },
    { char: '土', sound: '토', glossEn: 'earth' },
    { char: '山', sound: '산', glossEn: 'mountain' },
  ];
  for (const c of l2Chars) await seedHanjaCharacter(pg.pool, { ...c, level: 'L2' });
  for (const c of l3Chars) await seedHanjaCharacter(pg.pool, { ...c, level: 'L3' });
}

/**
 * Drive a run to completion skipping every item. A skip (picked: null) is
 * ALWAYS graded incorrect, which keeps the θ trajectory deterministic even for
 * generated items (whose correct choice is shuffled to a random position):
 * 4.0 → 3.0 → 2.1 → 1.3 → 1.0 (clamped) → stays. Returns the runId.
 */
async function runAllSkip(agent: RegisteredAgent['agent']): Promise<number> {
  const start = await agent.post('/diagnostic').send({});
  expect(start.status).toBe(201);
  const runId = start.body.runId as number;
  let current: { responseId: number } | null = start.body.item;
  while (current !== null) {
    const ans = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: current.responseId, picked: null });
    expect(ans.status).toBe(200);
    if (ans.body.done === true) {
      current = null;
      continue;
    }
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    current = nxt.body.next;
  }
  return runId;
}

describe('diagnostic — auth required', () => {
  it.each([
    ['POST', '/diagnostic'],
    ['POST', '/diagnostic/1/answer'],
    ['POST', '/diagnostic/1/next'],
    ['POST', '/diagnostic/1/finish'],
    ['GET', '/diagnostic/latest'],
    ['GET', '/diagnostic/trajectory'],
    ['GET', '/diagnostic/history'],
  ])('%s %s unauthenticated → 401', async (method, p) => {
    const m = method as 'GET' | 'POST';
    const res = m === 'GET' ? await request(t.app).get(p) : await request(t.app).post(p).send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /diagnostic/latest — empty', () => {
  it('returns 200 with dimensions:[] when no run exists', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/diagnostic/latest');
    expect(res.status).toBe(200);
    expect(res.body.dimensions).toEqual([]);
    expect(Array.isArray(res.body.references)).toBe(true);
    expect(res.body.defaultRef).toBe('L4');
    expect(res.body.goals).toEqual([]);
  });
});

describe('POST /diagnostic — start', () => {
  it('creates a run and serves a reading item #1, answer-stripped', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/diagnostic').send({});
    expect(res.status).toBe(201);
    expect(typeof res.body.runId).toBe('number');
    expect(res.body.progress).toEqual({ ordinal: 1, total: TARGET_ITEM_COUNT });

    const item = res.body.item;
    expect(item.ordinal).toBe(1);
    expect(item.section).toBe('reading'); // schedule[0]
    expect(typeof item.responseId).toBe('number');
    expect(Array.isArray(item.choices)).toBe(true);
    // THE security property: no correct answer / explanation reaches the client.
    expect(item).not.toHaveProperty('correctAnswer');
    expect(item).not.toHaveProperty('correct_answer');
    expect(item).not.toHaveProperty('explain');
    for (const c of item.choices) {
      expect(c).not.toHaveProperty('correct');
    }
  });
});

describe('POST /diagnostic — glyph-option items excluded (data sweep D-4)', () => {
  it('a bare ①②③④ picture-choice item is never served', async () => {
    // The corpus has 60 picture-choice listening items whose options are bare
    // ①②③④ glyphs with has_image=true, NO image asset, and NULL image_text —
    // all four choices render identically, so the item is unanswerable. The
    // study/mock guard (topik.ts ANSWERABLE_ITEM_SQL) excludes them; the
    // diagnostic's pickTopikRow must apply the SAME exclusion so an
    // unanswerable item cannot move θ. Here the ONLY topik row is a glyph
    // item: the diagnostic must skip the reading dimension entirely rather
    // than serve it.
    await seedTopikItem(pg.pool, {
      section: 'reading',
      proficiency: 'L4',
      answer: 1,
      options: ['①', '②', '③', '④'],
      hasImage: true,
      imageText: null,
    });
    // vocab + grammar seeds so the generated dimensions can serve items.
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });

    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    // Without the guard, the glyph item is served as reading item #1.
    expect(start.body.item.section).not.toBe('reading');
    const served = await pg.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM diagnostic_responses WHERE source_kind = 'topik'`,
    );
    expect(served.rows[0]!.n).toBe(0);
  });
});

describe('POST /diagnostic — placeholder-stem listening items excluded (B-038)', () => {
  it('a no-transcript placeholder item with NO mapped audio is never served', async () => {
    // The live corpus has listening items whose stem is the curator
    // placeholder "[듣기 지문 없음 — …]" (no transcript was available at
    // ingest). topik.ts excludes them (NO_TRANSCRIPT_STEM_PREFIX) unless a
    // real audio span is mapped (F-119 RE-ADMIT); the diagnostic's
    // pickTopikRow now mirrors that exact re-admit condition (SF-1 fix-pass)
    // instead of excluding every placeholder-stem row unconditionally. This
    // row carries NO mapped span, so it stays excluded either way — nothing
    // to read, nothing to play. The re-admit case (span + test mp3 present)
    // is covered separately below ('SF-1 fix: … RE-ADMITTED …').
    // Setup mirrors the glyph-exclusion test above: the ONLY topik row is a
    // placeholder listening item, so the listening dimension must be skipped
    // entirely rather than serve it.
    await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      stem: '[듣기 지문 없음 — 대화/담화가 오디오로만 제공됨(전사 파일 없음)]',
    });
    // vocab + grammar seeds so the generated dimensions can serve items.
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });

    const { agent } = await registerUser(t.app, pg.pool);
    // Drive the whole run (runAllSkip protocol), asserting no served item is
    // ever a listening/topik row — the only candidate is the placeholder.
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId as number;
    let current: { responseId: number; section?: string } | null = start.body.item;
    while (current !== null) {
      expect(current.section).not.toBe('listening');
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: null });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) break;
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }
    const served = await pg.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM diagnostic_responses WHERE source_kind = 'topik'`,
    );
    expect(served.rows[0]!.n).toBe(0);
  });
});

describe('POST /diagnostic — shared reading passage (F4)', () => {
  it('serves the test-shared passage on an item whose own stem is empty', async () => {
    // A reading item whose body lives in the parent test's `passages` JSONB
    // (migration 005), keyed by item-number range. Its own `stem` is empty, so
    // before the fix the item rendered with NO question text. The diagnostic
    // must surface the shared passage covering item_number 20 ("19-20").
    const passageText = '다음은 어느 회사의 안내문입니다. 잘 읽고 물음에 답하십시오. 본문 내용…';
    const itemId = await seedTopikItem(pg.pool, {
      section: 'reading',
      proficiency: 'L4',
      answer: 1,
      stem: '', // empty own stem → depends on the shared passage
      testNumber: 909_001,
      itemNumber: 20,
    });
    // Attach the shared passage to the item's parent test, keyed by the range
    // that covers item_number 20.
    await pg.pool.query(
      `UPDATE topik_tests t
          SET passages = $1::jsonb
         FROM topik_items i
        WHERE i.id = $2 AND t.id = i.topik_test_id`,
      [JSON.stringify({ '19-20': passageText }), itemId],
    );

    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/diagnostic').send({});
    expect(res.status).toBe(201);
    const item = res.body.item;
    expect(item.section).toBe('reading');
    // The shared passage is surfaced on the live item so the question renders.
    expect(item.passage).toBe(passageText);
  });

  it('does not invent a passage when no range covers the item', async () => {
    const itemId = await seedTopikItem(pg.pool, {
      section: 'reading',
      proficiency: 'L4',
      answer: 1,
      stem: '',
      testNumber: 909_002,
      itemNumber: 5,
    });
    // Passage range "19-20" does NOT cover item_number 5.
    await pg.pool.query(
      `UPDATE topik_tests t
          SET passages = $1::jsonb
         FROM topik_items i
        WHERE i.id = $2 AND t.id = i.topik_test_id`,
      [JSON.stringify({ '19-20': '관계없는 본문' }), itemId],
    );

    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/diagnostic').send({});
    expect(res.status).toBe(201);
    // No covering range → no passage field (the item falls back to inference).
    expect(res.body.item).not.toHaveProperty('passage');
  });
});

describe('POST /diagnostic/:runId/answer — grading (reveal only, B-006)', () => {
  it('grades server-side, reveals correctAnswer + explain; /next serves the following item', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const { runId, item } = start.body;

    // reading item #1: seeded answer=1 → correct choice 'a'. Pick 'a'.
    const res = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'a', timeMs: 1234 });

    expect(res.status).toBe(200);
    expect(res.body.result.correct).toBe(true);
    expect(res.body.result.correctAnswer).toBe('a');
    expect(typeof res.body.result.explain).toBe('string');
    // The answer response carries the reveal + run-progress only — the next
    // item is served by the separate /next call.
    expect(res.body).not.toHaveProperty('next');
    expect(res.body.done).toBe(false);
    expect(res.body.progress).toEqual({ ordinal: 1, total: TARGET_ITEM_COUNT });

    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    expect(nxt.body.next).not.toBeNull();
    expect(nxt.body.next.section).toBe('listening'); // schedule[1]
    expect(nxt.body.progress).toEqual({ ordinal: 2, total: TARGET_ITEM_COUNT });
    // The next item is still answer-stripped.
    expect(nxt.body.next).not.toHaveProperty('correctAnswer');
    expect(nxt.body.next).not.toHaveProperty('correct_answer');
    expect(nxt.body.next).not.toHaveProperty('explain');
  });

  it('a wrong pick grades incorrect', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const { runId, item } = start.body;
    const res = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'b' });
    expect(res.status).toBe(200);
    expect(res.body.result.correct).toBe(false);
    expect(res.body.result.correctAnswer).toBe('a');
  });

  it('a skip (picked:null) is graded incorrect but the run advances', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const { runId, item } = start.body;
    const res = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: null });
    expect(res.status).toBe(200);
    expect(res.body.result.correct).toBe(false);
    expect(res.body.done).toBe(false);
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    expect(nxt.body.next).not.toBeNull();
  });

  it('rejects an out-of-order / stale responseId with 409', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const { runId, item } = start.body;
    const res = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId + 9999, picked: 'a' });
    expect(res.status).toBe(409);
  });

  it('rejects double-answering the same item with 409', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const { runId, item } = start.body;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'a' });
    const dup = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'a' });
    expect(dup.status).toBe(409);
    // Fix-pass 2 FIX B: the generic "already recorded" 409 carries the
    // ordinary ConflictError code — DISTINCT from the writing-claim-
    // collision 409's `writing_grade_in_progress` code below, so the client
    // can tell the two apart and not misroute a claim collision into the
    // "already recorded — continuing" resync flow.
    expect(dup.body.error.code).toBe('conflict');
  });

  it("another user cannot answer someone else's run (IDOR → 404)", async () => {
    await seedFullPool();
    const a = await registerUser(t.app, pg.pool);
    const start = await a.agent.post('/diagnostic').send({});
    const { runId, item } = start.body;

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'a' });
    expect(res.status).toBe(404);
  });

  it("another user cannot finish someone else's run (IDOR → 404)", async () => {
    await seedFullPool();
    const a = await registerUser(t.app, pg.pool);
    const start = await a.agent.post('/diagnostic').send({});
    const { runId } = start.body;

    const b = await registerUser(t.app, pg.pool);
    const res = await b.agent.post(`/diagnostic/${runId}/finish`).send({});
    // loadUserRun filters WHERE user_id = $2, so B's finish on A's run 404s
    // before any snapshot write — the run-ownership gate is shared by /answer
    // and /finish, but this proves /finish is scoped too, not just /answer.
    expect(res.status).toBe(404);
  });

  it("another user's /latest and /trajectory never see someone else's snapshot", async () => {
    const a = await registerUser(t.app, pg.pool);
    await seedDiagnosticSnapshot(pg.pool, a.userId, { reading: 5, grammar: 4 });

    const b = await registerUser(t.app, pg.pool);
    // B has no run of their own: /latest is the empty snapshot, /trajectory empty.
    const latest = await b.agent.get('/diagnostic/latest');
    expect(latest.status).toBe(200);
    expect(latest.body.dimensions).toEqual([]);
    const traj = await b.agent.get('/diagnostic/trajectory');
    expect(traj.status).toBe(200);
    expect(traj.body.points).toEqual([]);

    // A still sees their own snapshot — proves the isolation isn't a blanket empty.
    const aLatest = await a.agent.get('/diagnostic/latest');
    expect((aLatest.body.dimensions as unknown[]).length).toBe(2);
  });
});

describe('POST /diagnostic/:runId/answer — concurrent double-answer (B1)', () => {
  it('a second answer for the same responseId is rejected and does not double-bump θ or serve a second item', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const { runId, item } = start.body;

    // First answer succeeds; /next then serves item #2.
    const first = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'a' });
    expect(first.status).toBe(200);
    expect(first.body.done).toBe(false);
    const served = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(served.status).toBe(200);
    expect(served.body.next).not.toBeNull();

    // θ after one correct answer at SEED_THETA (1.2), step n=1 (0.7) → 1.9.
    const thetaAfterFirst = await pg.pool.query<{ ability_estimate: string }>(
      `SELECT ability_estimate::text AS ability_estimate
         FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    expect(Number(thetaAfterFirst.rows[0]?.ability_estimate)).toBeCloseTo(1.9);

    // Count in-flight (unanswered) responses: exactly one — item #2.
    const inflightBefore = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM diagnostic_responses
         WHERE run_id = $1 AND answered_at IS NULL`,
      [runId],
    );
    expect(inflightBefore.rows[0]?.n).toBe('1');

    // Replay the SAME (now-answered) responseId. The single-shot UPDATE matches
    // zero rows under the lock, so the handler must 409 — NOT bump θ again and
    // NOT serve another item. (Pre-fix, the θ UPDATE + next-item serve ran
    // regardless of the response rowCount, leaving two items in flight.)
    const replay = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'a' });
    expect(replay.status).toBe(409);

    // θ is unchanged by the rejected replay.
    const thetaAfterReplay = await pg.pool.query<{ ability_estimate: string }>(
      `SELECT ability_estimate::text AS ability_estimate
         FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    expect(Number(thetaAfterReplay.rows[0]?.ability_estimate)).toBeCloseTo(1.9);

    // Still exactly one item in flight — the replay served no second item.
    const inflightAfter = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM diagnostic_responses
         WHERE run_id = $1 AND answered_at IS NULL`,
      [runId],
    );
    expect(inflightAfter.rows[0]?.n).toBe('1');
  });
});

describe('answer/next decoupling (B-006)', () => {
  afterEach(() => {
    // Restore the default deterministic stub for the rest of the suite.
    setClaudeProxy(makeStubProxy());
    resetLimiters();
  });

  it('/answer never calls the Claude proxy — the reveal returns even when generation is down', async () => {
    // A proxy whose generation is hard-down AND counts invocations. Pre-fix,
    // /answer generated the next item inline, so answering the item BEFORE a
    // vocab/grammar ordinal called Claude in the request path and a Claude
    // outage turned the reveal into a 502. Post-fix, /answer must succeed
    // without ever touching the proxy; only /next pays the generation cost.
    let genCalls = 0;
    setClaudeProxy(
      makeStubProxy({
        generateDiagnosticItem: async () => {
          genCalls += 1;
          throw new Error('claude is down — generation must not run inline');
        },
      }),
    );
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);

    // Schedule: 1 reading, 2 listening, 3 vocab. Start serves reading (topik).
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);

    // Grade item 1 — reveal arrives, no Claude call in the request path.
    const ans1 = await agent
      .post(`/diagnostic/${start.body.runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: 'a' });
    expect(ans1.status).toBe(200);
    expect(ans1.body.result.correctAnswer).toBe('a');
    expect(genCalls).toBe(0);

    // Serve + grade item 2 (listening — also topik, still no Claude).
    const next2 = await agent.post(`/diagnostic/${start.body.runId}/next`).send({});
    expect(next2.status).toBe(200);
    expect(next2.body.next.section).toBe('listening');
    expect(genCalls).toBe(0);
    const ans2 = await agent
      .post(`/diagnostic/${start.body.runId}/answer`)
      .send({ responseId: next2.body.next.responseId, picked: 'a' });
    // Ordinal 3 is vocab (Claude-generated). Pre-fix THIS call generated it
    // inline and 502'd under the outage; now it grades cleanly.
    expect(ans2.status).toBe(200);
    expect(ans2.body.result.correct).toBe(true);
    expect(genCalls).toBe(0);

    // The generation cost (and its failure) lives on /next alone.
    const next3 = await agent.post(`/diagnostic/${start.body.runId}/next`).send({});
    expect(next3.status).toBe(502);
    expect(genCalls).toBe(1);
  });

  it('/next is idempotent: re-serving the pending item burns no extra generation', async () => {
    let genCalls = 0;
    setClaudeProxy(
      makeStubProxy({
        generateDiagnosticItem: async (input) => {
          genCalls += 1;
          return {
            result: {
              kind: input.section === 'grammar' ? ('pattern' as const) : ('synonym' as const),
              prompt: `mock ${input.section} question`,
              choices: [
                { kr: '정답', en: '' },
                { kr: '오답 1', en: '' },
                { kr: '오답 2', en: '' },
                { kr: '오답 3', en: '' },
              ],
              answerIndex: 0,
              explain: 'mock explain',
            },
            metadata: {
              model: 'claude-sonnet-4-6' as const,
              cacheHit: false,
              latencyMs: 1,
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              costEstimateUsd: 0,
              requestId: 'test-idempotent-next',
            },
          };
        },
      }),
    );
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;

    // Before anything is answered, /next re-serves the CURRENT pending item
    // (lost-response recovery), answer-stripped, without a new row.
    const reServe = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(reServe.status).toBe(200);
    expect(reServe.body.next.responseId).toBe(start.body.item.responseId);
    expect(reServe.body.next).not.toHaveProperty('correctAnswer');
    expect(reServe.body.next).not.toHaveProperty('explain');

    // Walk to ordinal 3 (vocab — generated).
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: 'a' });
    const n2 = await agent.post(`/diagnostic/${runId}/next`).send({});
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: n2.body.next.responseId, picked: 'a' });

    const n3a = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(n3a.status).toBe(200);
    expect(n3a.body.next.section).toBe('vocab');
    expect(genCalls).toBe(1);

    // A duplicate /next (double-fired prefetch / retry) re-serves the SAME
    // pending item and does NOT generate again.
    const n3b = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(n3b.status).toBe(200);
    expect(n3b.body.next.responseId).toBe(n3a.body.next.responseId);
    expect(genCalls).toBe(1);

    // Exactly one unanswered item in flight — the invariant held.
    const inflight = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM diagnostic_responses
        WHERE run_id = $1 AND answered_at IS NULL`,
      [runId],
    );
    expect(inflight.rows[0]?.n).toBe('1');
  });

  it("/next 404s on another user's run and 409s on a finished run", async () => {
    await seedFullPool();
    const a = await registerUser(t.app, pg.pool);
    const start = await a.agent.post('/diagnostic').send({});
    const runId = start.body.runId;

    // IDOR: B cannot pull items from A's run.
    const b = await registerUser(t.app, pg.pool);
    const idor = await b.agent.post(`/diagnostic/${runId}/next`).send({});
    expect(idor.status).toBe(404);

    // Drive A's run to finished, then /next must 409 (not serve or generate).
    let current: { responseId: number } | null = start.body.item;
    while (current !== null) {
      const ans = await a.agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: 'a' });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await a.agent.post(`/diagnostic/${runId}/next`).send({});
      current = nxt.body.next;
    }
    const fin = await a.agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(fin.status).toBe(200);
    const afterFinish = await a.agent.post(`/diagnostic/${runId}/next`).send({});
    expect(afterFinish.status).toBe(409);
  });

  it('answering the last scheduled item reports done:true (client finishes without /next)', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;

    let current: { responseId: number } | null = start.body.item;
    let lastAnswer: Record<string, unknown> | null = null;
    while (current !== null) {
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: 'a' });
      expect(ans.status).toBe(200);
      lastAnswer = ans.body;
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      current = nxt.body.next;
    }
    // The full 30-slot schedule was servable (diagnostic-upgrade Phase C), so
    // the final grade says done and points progress at the last ordinal.
    expect(lastAnswer?.done).toBe(true);
    expect(lastAnswer?.progress).toEqual({ ordinal: TARGET_ITEM_COUNT, total: TARGET_ITEM_COUNT });
  });
});

describe('buildGeneratedItem error mapping (B1 fix regression, F-192)', () => {
  // buildGeneratedItem's .catch (routes/diagnostic.ts) is the B1 fix site: a
  // RAW (non-ClaudeProxyError) thrown error must never leak its .message to
  // the client (only a fixed generic UpstreamError message), while a real
  // ClaudeProxyError's httpStatus must pass through mapClaudeError unmapped
  // to a flat 502 (mirrors tests/routes/generation.test.ts's status-mapping
  // pins for the writing/reading pair). No production code changes here —
  // test-only, per F-192.
  afterEach(() => {
    setClaudeProxy(makeStubProxy());
    resetLimiters();
  });

  /** Walk a fresh run to the point where /next MUST generate (ordinal 3,
   *  vocab — mirrors the "answer/next decoupling" describe block above).
   *  Returns the runId; the CALLER's proxy override decides what ordinal 3's
   *  generation does. */
  async function walkToGeneratedOrdinal(
    agent: RegisteredAgent['agent'],
  ): Promise<number> {
    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: 'a' });
    const next2 = await agent.post(`/diagnostic/${runId}/next`).send({});
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: next2.body.next.responseId, picked: 'a' });
    return runId;
  }

  it('a RAW (non-ClaudeProxyError) throw never leaks its message text to the client', async () => {
    const RAW_MESSAGE = 'ECONNRESET: raw socket detail must never reach the client';
    setClaudeProxy(
      makeStubProxy({
        generateDiagnosticItem: async () => {
          throw new Error(RAW_MESSAGE);
        },
      }),
    );
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await walkToGeneratedOrdinal(agent);

    const next3 = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(next3.status).toBe(502);
    expect(next3.body.error.message).not.toContain(RAW_MESSAGE);
    expect(next3.body.error.message).not.toContain('ECONNRESET');
    // Only the fixed, generic UpstreamError message reaches the client.
    expect(typeof next3.body.error.message).toBe('string');
  });

  it('a ClaudeProxyError with httpStatus reaching the catch passes its 4xx through (not flattened to 502)', async () => {
    setClaudeProxy(
      makeStubProxy({
        generateDiagnosticItem: async () => {
          throw new ClaudeRateLimitError(
            'diagnostic vocab/grammar generation rate limit exhausted',
          );
        },
      }),
    );
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await walkToGeneratedOrdinal(agent);

    const next3 = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(next3.status).toBe(429);
    expect(next3.body.error.code).toBe('upstream_error');
  });
});

describe('full run → finish → latest', () => {
  /** Drive a run start→finish, picking `pick` each time. Returns the snapshot. */
  async function runToFinish(
    agent: ReturnType<typeof request.agent>,
    pick: 'a' | 'b',
  ): Promise<{ runId: number; snapshot: Record<string, unknown> }> {
    const start = await agent.post('/diagnostic').send({});
    const runId: number = start.body.runId;
    // Answer every served item; between answers fetch the next item via /next
    // (the B-006 split) until `done` or `next: null`.
    let current: { responseId: number } | null = start.body.item;
    while (current !== null) {
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: pick });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }
    const fin = await agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(fin.status).toBe(200);
    return { runId, snapshot: fin.body.snapshot };
  }

  it('produces a 6-dimension snapshot (writing joins as a full leveled dimension, hanja stays coverage-only) and is idempotent', async () => {
    await seedFullPool();
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const { runId, snapshot } = await runToFinish(agent, 'a');

    const dims = snapshot.dimensions as Array<{
      key: string;
      score: number;
      scoreLow: number;
      scoreHigh: number;
    }>;
    const keys = dims.map((d) => d.key).sort();
    // diagnostic-upgrade Phase A: hanja joined the 4 original dims.
    // diagnostic-upgrade Phase B: writing joins as a 6th — a FULL leveled
    // dimension (it bumps θ, unlike hanja), scored via the SAME
    // generateGrammarDrill/scoreGrammarDrill pipeline the stub proxy already
    // fakes deterministically (picked='a' is a valid free-text answer; the
    // stub's scoreGrammarDrill grades 'good' unless the answer contains its
    // BAD_ANSWER_SENTINEL — see tests/helpers/app.ts).
    expect(keys).toEqual(['grammar', 'hanja', 'listening', 'reading', 'vocab', 'writing']);
    for (const d of dims) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
      // F-011 band: present on every dimension, ordered around the score, and
      // NON-zero-width even on an all-correct run (Agresti-Coull smoothing —
      // 4/4 must not read as certainty).
      expect(d.scoreLow).toBeLessThanOrEqual(d.score);
      expect(d.scoreHigh).toBeGreaterThanOrEqual(d.score);
      expect(d.scoreHigh).toBeGreaterThan(d.scoreLow);
      expect(d.scoreLow).toBeGreaterThanOrEqual(0);
      expect(d.scoreHigh).toBeLessThanOrEqual(100);
    }

    // Exact reading/listening result (diagnostic-upgrade Phase C / rubric
    // v1.5.0): the topik dimensions are answered all-correct and their
    // point estimate is now that section's FINAL per-category ladder θ, not
    // the old mean-difficulty+p heuristic. `simulateLadders` mirrors the
    // production stepping exactly (same real `nextTheta`/`SEED_THETA`/
    // `thetaToNumeric` this route uses) to derive the expected θ.
    //
    // COLD START (fix-pass S1): both reading and listening cold-start at
    // SEED_THETA on their own first answer (not warm-started from whatever
    // the GLOBAL θ happened to be when each was first served). Since both
    // are answered all-correct with the SAME per-section step count (6),
    // their trajectories are now IDENTICAL by construction — this is the
    // intended fix: a dimension's final θ depends ONLY on its own answers,
    // never on schedule position. (The genuine per-category DIVERGENCE case
    // — a dimension answered differently from another — is covered by the
    // headline 'per-category ladders DIVERGE' test below.)
    const { sections: allCorrectLadders } = simulateLadders(() => true);
    const expectedReading = dimensionResultForEstimate(
      Array.from({ length: 6 }, () => ({ section: 'reading', difficulty: 4, isCorrect: true })),
      allCorrectLadders['reading']!,
    )!;
    const expectedListening = dimensionResultForEstimate(
      Array.from({ length: 6 }, () => ({ section: 'listening', difficulty: 4, isCorrect: true })),
      allCorrectLadders['listening']!,
    )!;
    const reading = dims.find((d) => d.key === 'reading');
    const listening = dims.find((d) => d.key === 'listening');
    expect(reading?.score).toBe(expectedReading.score);
    expect(listening?.score).toBe(expectedListening.score);
    expect(reading?.scoreLow).toBe(expectedReading.scoreLow);
    expect(reading?.scoreHigh).toBe(expectedReading.scoreHigh);
    expect(listening?.scoreLow).toBe(expectedListening.scoreLow);
    expect(listening?.scoreHigh).toBe(expectedListening.scoreHigh);
    // Cold-started + identically all-correct → the two dimensions land on the
    // SAME score, proving the estimate is order-independent (no more
    // schedule-position bias between a dimension served 1st vs 2nd).
    expect(listening?.score).toBe(reading?.score);

    // The band evidence is persisted in the snapshot's JSONB (rubric
    // v1.1.0+): per-dimension { n, correct, estimate, score, scoreLow,
    // scoreHigh, theta? } that /latest and /history rebuild the DTO band
    // from.
    const snapRow = await pg.pool.query<{
      rubric_version: string;
      evidence: {
        dimensionStats?: Record<
          string,
          {
            n: number;
            correct: number;
            estimate: number;
            score: number;
            scoreLow: number;
            scoreHigh: number;
            theta?: number;
          }
        >;
      };
    }>(
      `SELECT rubric_version, evidence FROM diagnostic_snapshots WHERE user_id = $1`,
      [userId],
    );
    expect(snapRow.rows[0]?.rubric_version).toBe('v1.5.0');
    const stats = snapRow.rows[0]?.evidence.dimensionStats;
    expect(stats).toBeDefined();
    expect(Object.keys(stats!).sort()).toEqual([
      'grammar',
      'hanja',
      'listening',
      'reading',
      'vocab',
      'writing',
    ]);
    expect(stats!['reading']).toEqual({
      n: 6,
      correct: 6,
      estimate: expectedReading.estimate,
      score: expectedReading.score,
      scoreLow: expectedReading.scoreLow,
      scoreHigh: expectedReading.scoreHigh,
      theta: allCorrectLadders['reading'],
    });
    // hanja stays coverage-only — it never gets a `theta` field (no ladder).
    expect(stats!['hanja']).not.toHaveProperty('theta');

    // /latest rebuilds the SAME band from evidence.dimensionStats.
    const latestAfterFinish = await agent.get('/diagnostic/latest');
    expect(latestAfterFinish.status).toBe(200);
    const latestReading = (latestAfterFinish.body.dimensions as typeof dims).find(
      (d) => d.key === 'reading',
    );
    expect(latestReading?.score).toBe(expectedReading.score);
    expect(latestReading?.scoreLow).toBe(expectedReading.scoreLow);
    expect(latestReading?.scoreHigh).toBe(expectedReading.scoreHigh);

    // Idempotent re-finish: the SAME snapshot row is returned, not a duplicate.
    // Assert (a) the run's snapshot_id is unchanged, and (b) the user has
    // exactly ONE snapshot row — removing the FOR UPDATE re-check in /finish
    // would insert a second row and fail this, where a dimension-count check
    // would not.
    const before = await pg.pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id::text AS snapshot_id FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const refin = await agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(refin.status).toBe(200);
    expect((refin.body.snapshot.dimensions as unknown[]).length).toBe(dims.length);

    const after = await pg.pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id::text AS snapshot_id FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    expect(after.rows[0]?.snapshot_id).toBe(before.rows[0]?.snapshot_id);

    const snapCount = await pg.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM diagnostic_snapshots WHERE user_id = $1`,
      [userId],
    );
    expect(snapCount.rows[0]?.n).toBe('1');

    // /latest now returns the populated snapshot — including hanja, which
    // has NO dedicated diagnostic_snapshots column (unlike reading/listening/
    // vocab/grammar): buildSnapshotDTO must source its estimate from
    // evidence.dimensionStats alone, and this proves that round-trip. writing
    // DOES have a dedicated column (`writing_estimate`, populated for the
    // first time by this Phase B change) but loadSnapshotDTO doesn't re-SELECT
    // it — it too round-trips purely through evidence.dimensionStats, same
    // path as hanja (see buildSnapshotDTO's doc in diagnostic.ts).
    const latest = await agent.get('/diagnostic/latest');
    expect(latest.status).toBe(200);
    expect((latest.body.dimensions as unknown[]).length).toBe(6);
    expect((latest.body.dimensions as Array<{ key: string }>).map((d) => d.key).sort()).toEqual([
      'grammar',
      'hanja',
      'listening',
      'reading',
      'vocab',
      'writing',
    ]);

    // writing_estimate — the pre-existing diagnostic_snapshots column
    // plan.ts's /plan/today already reads — is now actually populated
    // (previously hardcoded NULL; no rubric before v1.4.0 ever scored writing).
    const writingCol = await pg.pool.query<{ writing_estimate: string | null }>(
      `SELECT writing_estimate::text AS writing_estimate FROM diagnostic_snapshots WHERE user_id = $1`,
      [userId],
    );
    expect(writingCol.rows[0]?.writing_estimate).not.toBeNull();
  });

  it('an all-wrong run scores every dimension lower than an all-correct run', async () => {
    // Mixed-scoring branch: runToFinish(_, 'b') answers 'b' on every item. For
    // topik items the correct choice is 'a' (answer=1) — so 'b' is wrong on
    // every topik item, exercising the p=0 (base − ESTIMATE_SPREAD/2) end of
    // the proportion estimate and the θ-decrement path end-to-end (which the
    // all-'a' happy path never touches).
    const correctRun = await (async () => {
      await seedFullPool();
      const { agent } = await registerUser(t.app, pg.pool);
      return runToFinish(agent, 'a');
    })();
    const wrongRun = await (async () => {
      await seedFullPool();
      const { agent } = await registerUser(t.app, pg.pool);
      return runToFinish(agent, 'b');
    })();

    const score = (snap: Record<string, unknown>, key: string): number => {
      const dims = snap.dimensions as Array<{ key: string; score: number }>;
      return dims.find((d) => d.key === key)?.score ?? -1;
    };
    // Diagnostic-upgrade Phase C: reading/listening's point estimate is now
    // that section's ladder θ, not the old mean-difficulty+p heuristic. An
    // ALL-WRONG run floors both dimensions' ladders at THETA_MIN (1.0)
    // within their first couple of answers (θ never recovers once floored,
    // and further wrong answers just clamp) — `simulateLadders` confirms
    // this exactly, and BOTH dimensions floor at the SAME value (1.0). With
    // the fix-pass S1 cold start this is no longer a coincidence of flooring
    // erasing a warm-start difference — both ladders were already identical
    // from their own first (cold-started) answer, same as the all-correct
    // case above.
    const { sections: allWrongLadders } = simulateLadders(() => false);
    const expectedWrongReading = dimensionResultForEstimate(
      Array.from({ length: 6 }, () => ({ section: 'reading', difficulty: 4, isCorrect: false })),
      allWrongLadders['reading']!,
    )!;
    const expectedWrongListening = dimensionResultForEstimate(
      Array.from({ length: 6 }, () => ({ section: 'listening', difficulty: 4, isCorrect: false })),
      allWrongLadders['listening']!,
    )!;
    expect(score(wrongRun.snapshot, 'reading')).toBe(expectedWrongReading.score);
    expect(score(wrongRun.snapshot, 'listening')).toBe(expectedWrongListening.score);
    expect(score(wrongRun.snapshot, 'reading')).toBeLessThan(
      score(correctRun.snapshot, 'reading'),
    );
    expect(score(wrongRun.snapshot, 'listening')).toBeLessThan(
      score(correctRun.snapshot, 'listening'),
    );
  });

  it('finish rejects (409) when a served item is still unanswered', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    const res = await agent.post(`/diagnostic/${start.body.runId}/finish`).send({});
    expect(res.status).toBe(409);
  });
});

describe('per-category ladders DIVERGE (diagnostic-upgrade Phase C headline test)', () => {
  it('an all-wrong category is served at a LOWER band than an all-correct category, in the SAME run', async () => {
    // THE point of this build: before Phase C, every dimension shared one
    // global θ ladder, so a weak category could never be served easier
    // items than a strong one — the shared ramp mis-targeted it regardless.
    // Now reading answers ALL-CORRECT ('a' — topik answer=1) while listening
    // answers ALL-WRONG ('b') in the SAME run; vocab/grammar/hanja/writing
    // are skipped (irrelevant to this test, and a skip never crashes any of
    // them — verified elsewhere in this file). If the two categories still
    // shared one ladder, listening's items would track reading's climb
    // exactly (both driven by the same θ) — they must NOT.
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;

    const servedLevelBySection: Record<string, string[]> = {};
    let current: { responseId: number; section: string; level: string } | null = start.body.item;
    while (current !== null) {
      (servedLevelBySection[current.section] ??= []).push(current.level);
      const picked =
        current.section === 'reading' ? 'a' : current.section === 'listening' ? 'b' : null;
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }

    const readingLevels = servedLevelBySection['reading'];
    const listeningLevels = servedLevelBySection['listening'];
    expect(readingLevels).toBeDefined();
    expect(listeningLevels).toBeDefined();
    expect(readingLevels!.length).toBe(READING_ORDINALS.length);
    expect(listeningLevels!.length).toBe(LISTENING_ORDINALS.length);

    // The two dimensions' LAST served band is where the divergence is
    // starkest: reading (all-correct) has climbed; listening (all-wrong)
    // has floored back toward L1. Compare via bandForTheta's own band order
    // (the REAL function, not a hand-copied enum) so this can never drift
    // from what bandForTheta actually returns.
    const BAND_RANK: Record<string, number> = { L1: 0, L2: 1, L3: 2, L4: 3, 'L5+': 4 };
    const lastReadingLevel = readingLevels![readingLevels!.length - 1]!;
    const lastListeningLevel = listeningLevels![listeningLevels!.length - 1]!;
    expect(BAND_RANK[lastReadingLevel]).toBeGreaterThan(BAND_RANK[lastListeningLevel]!);

    // Direct confirmation via the persisted per-category θ cache itself
    // (migration 089's `dimension_estimates`) — the most literal proof the
    // two ladders genuinely diverged, not just their served bands.
    const run = await pg.pool.query<{ dimension_estimates: Record<string, number> }>(
      `SELECT dimension_estimates FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const estimates = run.rows[0]!.dimension_estimates;
    expect(estimates['reading']).toBeGreaterThan(estimates['listening']!);
    // Reading actually climbed off its seed; listening actually fell to the
    // floor — not just "reading > listening" by a fluke of warm-start order.
    expect(estimates['reading']).toBeGreaterThan(SEED_THETA);
    expect(estimates['listening']).toBe(1.0); // THETA_MIN — floored

    // bandForTheta itself confirms the same divergence directly on the
    // final cached θ values (belt-and-suspenders against the served-levels
    // read above ever drifting from the persisted cache).
    expect(bandForTheta(estimates['reading']!)).not.toBe(bandForTheta(estimates['listening']!));
  });
});

describe('per-category cold start (fix-pass S1): a late-served weak dimension floors correctly', () => {
  it('grammar (always scheduled 4th) floors to L1 on all-wrong answers even when reading/listening/vocab are all-correct', async () => {
    // Regression pin for fix-pass SHOULD-FIX 1 (REVIEW_engine.md's "grammar-
    // weak" case). Before this fix, every leveled dimension WARM-STARTED
    // from the run's live GLOBAL θ (`dimensionEstimates[section] ??
    // priorTheta`/`?? globalTheta`), so a dimension served later in the
    // fixed SCHEDULE inherited momentum from whichever OTHER dimensions were
    // served first. Grammar is always ordinal 4 (after reading/listening/
    // vocab) — so a learner genuinely strong in those three but genuinely
    // weak in grammar (true θ≈SEED_THETA, band L1) got grammar's ladder
    // warm-started at ~3.21 (after 3 dimensions' correct answers), and even
    // 6/6 wrong answers could only claw it back to ~1.96 (L2) — a full band
    // above the truth, defeating the point of a per-category ladder. The fix
    // (cat.ts's SEED_THETA cold start at both the serve and step sites)
    // makes grammar's ladder depend ONLY on grammar's own answers: its own
    // first wrong answer floors it straight to THETA_MIN, exactly as if it
    // had been served first.
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;

    // reading/listening all-correct ('a' — topik-seeded with answer: 1, so
    // 'a' is genuinely always correct); vocab all-correct too, but vocab is
    // a GENERATED item whose correct-letter position is shuffled per item
    // (`shuffleGeneratedChoices`), so a fixed 'a' pick is only ~25% correct —
    // echo the stored correct_answer instead, the same pattern used by
    // `pickTopikRow`'s test above. grammar all-wrong (skip — ALWAYS graded
    // incorrect regardless of the stub's shuffled/fixed answer position, see
    // `runAllSkip`'s doc comment above); hanja/writing skipped (irrelevant to
    // this test, and skips never crash any section).
    let current: { responseId: number; section: string } | null = start.body.item;
    while (current !== null) {
      let picked: string | null;
      if (current.section === 'reading' || current.section === 'listening') {
        picked = 'a';
      } else if (current.section === 'vocab') {
        const correct = await pg.pool.query<{ correct_answer: string }>(
          `SELECT correct_answer FROM diagnostic_responses WHERE id = $1`,
          [current.responseId],
        );
        picked = correct.rows[0]!.correct_answer;
      } else {
        picked = null;
      }
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }

    const run = await pg.pool.query<{ dimension_estimates: Record<string, number> }>(
      `SELECT dimension_estimates FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const estimates = run.rows[0]!.dimension_estimates;
    // Grammar floors to THETA_MIN (the true-L1 readout) — the fix-pass pin.
    expect(estimates['grammar']).toBe(1.0); // THETA_MIN, thetaToNumeric-rounded
    expect(bandForTheta(estimates['grammar']!)).toBe('L1');
    // Reading/listening/vocab genuinely climbed well above the seed — this is
    // a real divergence (three strong dimensions, one truly weak one), not
    // every dimension floored by some unrelated bug.
    expect(estimates['reading']).toBeGreaterThan(SEED_THETA);
    expect(estimates['listening']).toBeGreaterThan(SEED_THETA);
    expect(estimates['vocab']).toBeGreaterThan(SEED_THETA);
  });
});

describe('generated item — section↔kind enforcement (R2 SF-1)', () => {
  afterEach(() => {
    // Restore the default deterministic stub for the rest of the suite.
    setClaudeProxy(makeStubProxy());
    resetLimiters();
  });

  it('rejects (502) a generated vocab item whose kind is not synonym/cloze', async () => {
    // Override the proxy to emit a section-mismatched kind ('pattern' for a
    // vocab seed). The schema accepts the full kind union, so the route's
    // section↔kind guard is the only thing that catches it. Empty topik pools
    // force a generated item to be served first.
    setClaudeProxy(
      makeStubProxy({
        generateDiagnosticItem: async (input) => ({
          result: {
            kind: 'pattern' as const, // mismatched: vocab must be synonym/cloze
            prompt: `mock ${input.section}`,
            choices: [
              { kr: '가', en: '' },
              { kr: '나', en: '' },
              { kr: '다', en: '' },
              { kr: '라', en: '' },
            ],
            answerIndex: 0,
            explain: 'mock',
          },
          metadata: {
            model: 'claude-sonnet-4-6' as const,
            cacheHit: false,
            latencyMs: 1,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            costEstimateUsd: 0,
            requestId: 'test-mismatch',
          },
        }),
      }),
    );
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/diagnostic').send({});
    // The only servable section is vocab (topik empty), and its item is
    // rejected as a mismatched kind → mapped to a clean 502.
    expect(res.status).toBe(502);
  });
});

describe('empty pool handling', () => {
  it('scores only answered dims when reading/listening pools are empty', async () => {
    // Only vocab + grammar seeds; no topik_items at all.
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    // First served item must be a generated one (reading/listening empty).
    expect(['vocab', 'grammar']).toContain(start.body.item.section);

    // Answer through to finish, fetching each following item via /next. The
    // empty reading/listening/hanja pools end the run early: /next returns
    // null before the full 30-slot schedule is used.
    let current: { responseId: number } | null = start.body.item;
    const runId = start.body.runId;
    while (current !== null) {
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: 'a' });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }
    const fin = await agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(fin.status).toBe(200);
    const keys = (fin.body.snapshot.dimensions as Array<{ key: string }>).map((d) => d.key);
    expect(keys).not.toContain('reading');
    expect(keys).not.toContain('listening');
    // writing (diagnostic-upgrade Phase B) ALSO scores here — its seed draws
    // from the SAME kgiu_entries pool grammar does, so the one seeded row is
    // enough to serve writing's 2 appended slots too (hanja stays absent —
    // hanja_characters is unseeded in this test).
    expect(keys.sort()).toEqual(['grammar', 'vocab', 'writing']);
  });
});

describe('partial short pool — a dimension exhausted mid-run still scores (F-011 fixpass R2 SF-2)', () => {
  it('scores reading from the 2 items it got, with the true n persisted in dimensionStats', async () => {
    // Only 2 reading rows (schedule wants 4), NO listening rows at all, and
    // vocab/grammar generated by the stub. Reading's pool exhausts mid-run —
    // the already-served exclusion returns null at its 3rd slot — so the
    // skip-and-continue loop and pickTopikItem's exclusion must compose:
    // reading still scores from the 2 items it DID get (the acceptance
    // criterion's ">=1 items" middle ground the full/empty extremes miss).
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;
    let current: { responseId: number } | null = start.body.item;
    while (current !== null) {
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: 'a' });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }
    const fin = await agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(fin.status).toBe(200);

    // reading survives on 2/4 items; listening (0 items) is the only omission.
    const dims = fin.body.snapshot.dimensions as Array<{
      key: string;
      score: number;
      scoreLow: number;
      scoreHigh: number;
    }>;
    // writing (diagnostic-upgrade Phase B) also scores — same kgiu_entries
    // seed pool as grammar.
    expect(dims.map((d) => d.key).sort()).toEqual(['grammar', 'reading', 'vocab', 'writing']);

    // Exact 2-item scoring (diagnostic-upgrade Phase C / rubric v1.5.0):
    // reading is ALWAYS schedule ordinal 1 (the run's very first item), so
    // it cold-starts at SEED_THETA regardless of pool size — its estimate is
    // now the ladder θ after exactly 2 correct answers (its own step counts
    // 1, 2), computed via the SAME real `nextTheta`/`thetaToNumeric` the
    // route uses, not the old mean-difficulty+p heuristic. The band still
    // reflects the true n=2 (WIDER than a 6-item run's band would be).
    let readingLadderTheta = SEED_THETA;
    readingLadderTheta = thetaToNumeric(nextTheta(readingLadderTheta, true, 1));
    readingLadderTheta = thetaToNumeric(nextTheta(readingLadderTheta, true, 2));
    const readingResponses: ScoredResponse[] = [
      { section: 'reading', difficulty: 4, isCorrect: true },
      { section: 'reading', difficulty: 4, isCorrect: true },
    ];
    const expectedReading = dimensionResultForEstimate(readingResponses, readingLadderTheta)!;
    const reading = dims.find((d) => d.key === 'reading');
    expect(reading?.score).toBe(expectedReading.score);
    expect(reading?.scoreLow).toBe(expectedReading.scoreLow);
    expect(reading?.scoreHigh).toBe(expectedReading.scoreHigh);

    // The persisted evidence records the TRUE served count (n=2, not 4).
    const snapRow = await pg.pool.query<{
      evidence: { dimensionStats?: Record<string, { n: number; correct: number }> };
    }>(`SELECT evidence FROM diagnostic_snapshots WHERE user_id = $1`, [userId]);
    const stats = snapRow.rows[0]?.evidence.dimensionStats;
    expect(stats).toBeDefined();
    expect(Object.keys(stats!).sort()).toEqual(['grammar', 'reading', 'vocab', 'writing']);
    expect(stats!['reading']?.n).toBe(2);
    expect(stats!['reading']?.correct).toBe(2);
  });
});

describe('corrupt evidence.dimensionStats (F-011 fixpass R2 SF-1)', () => {
  it('/latest and /history survive malformed + inverted stored stats — valid DTO, no throw', async () => {
    // Hostile evidence that only direct DB corruption (or a future writer
    // bug) could produce. Each entry probes a different guard:
    //   reading   → wrong-typed field ({ n: "x" })  — field validation
    //   listening → array entry ([1])               — object-but-not-record
    //   vocab     → null entry                      — null guard
    //   grammar   → finite but INVERTED band (scoreLow 90 > scoreHigh 10)
    //               — the Math.min/Math.max re-anchor in buildSnapshotDTO
    // Deleting the parser's Number.isFinite/typeof validation, or replacing
    // the re-anchor with a passthrough, must turn this test red.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const snapId = await seedDiagnosticSnapshot(pg.pool, userId, {
      reading: 5, // → 70
      listening: 4, // → 55
      vocab: 4, // → 55
      grammar: 4.75, // → 66
    });
    await pg.pool.query(
      `UPDATE diagnostic_snapshots
          SET evidence = $1::jsonb, rubric_version = 'v1.1.0'
        WHERE id = $2`,
      [
        JSON.stringify({
          dimensionStats: {
            reading: { n: 'x' },
            listening: [1],
            vocab: null,
            grammar: {
              n: 4,
              correct: 4,
              estimate: 4.75,
              score: 66,
              scoreLow: 90,
              scoreHigh: 10,
            },
          },
        }),
        snapId,
      ],
    );

    const res = await agent.get('/diagnostic/latest');
    expect(res.status).toBe(200); // never a 500 on corrupt evidence
    const dims = res.body.dimensions as Array<{
      key: string;
      score: number;
      scoreLow: number;
      scoreHigh: number;
    }>;
    expect(dims.length).toBe(4);
    // The client-facing invariant holds unconditionally:
    // 0 ≤ scoreLow ≤ score ≤ scoreHigh ≤ 100, all finite.
    for (const d of dims) {
      expect(Number.isFinite(d.scoreLow)).toBe(true);
      expect(Number.isFinite(d.scoreHigh)).toBe(true);
      expect(d.scoreLow).toBeGreaterThanOrEqual(0);
      expect(d.scoreLow).toBeLessThanOrEqual(d.score);
      expect(d.scoreHigh).toBeGreaterThanOrEqual(d.score);
      expect(d.scoreHigh).toBeLessThanOrEqual(100);
    }
    // Malformed entries degrade to a zero-width band at the recomputed score…
    const byKey = (k: string): { score: number; scoreLow: number; scoreHigh: number } =>
      dims.find((d) => d.key === k)!;
    expect(byKey('reading')).toMatchObject({ score: 70, scoreLow: 70, scoreHigh: 70 });
    expect(byKey('listening')).toMatchObject({ score: 55, scoreLow: 55, scoreHigh: 55 });
    expect(byKey('vocab')).toMatchObject({ score: 55, scoreLow: 55, scoreHigh: 55 });
    // …and the inverted grammar pair is re-anchored onto the score (min/max
    // pulls 90→66 and 10→66), not passed through inverted.
    expect(byKey('grammar')).toMatchObject({ score: 66, scoreLow: 66, scoreHigh: 66 });

    // /history shares the parser + DTO builder — same row, same degradation.
    const hist = await agent.get('/diagnostic/history');
    expect(hist.status).toBe(200);
    const histDims = (hist.body.snapshots as Array<{ dimensions: typeof dims }>)[0]!
      .dimensions;
    const histGrammar = histDims.find((d) => d.key === 'grammar')!;
    expect(histGrammar.scoreLow).toBe(66);
    expect(histGrammar.scoreHigh).toBe(66);
  });
});

describe('legacy v1.0.0 snapshots (no evidence.dimensionStats)', () => {
  it('/latest loads a v1.0.0 row without throwing — band degrades to zero width', async () => {
    // seedDiagnosticSnapshot writes evidence '{}' and rubric 'v1.0.0' — the
    // exact pre-F-011 shape. The reader must not 500 on it; each dimension
    // degrades to scoreLow = scoreHigh = score (no band) instead.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 5, grammar: 4 });

    const res = await agent.get('/diagnostic/latest');
    expect(res.status).toBe(200);
    const dims = res.body.dimensions as Array<{
      key: string;
      score: number;
      scoreLow: number;
      scoreHigh: number;
    }>;
    expect(dims.length).toBe(2);
    for (const d of dims) {
      expect(d.scoreLow).toBe(d.score);
      expect(d.scoreHigh).toBe(d.score);
    }
    expect(dims.find((d) => d.key === 'reading')?.score).toBe(70);
    expect(dims.find((d) => d.key === 'grammar')?.score).toBe(55);
  });

  it('/history loads v1.0.0 rows the same way (zero-width band, no throw)', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 4 });
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 5 });

    const res = await agent.get('/diagnostic/history');
    expect(res.status).toBe(200);
    const snapshots = res.body.snapshots as Array<{
      dimensions: Array<{ key: string; score: number; scoreLow: number; scoreHigh: number }>;
    }>;
    expect(snapshots.length).toBe(2);
    for (const snap of snapshots) {
      for (const d of snap.dimensions) {
        expect(d.scoreLow).toBe(d.score);
        expect(d.scoreHigh).toBe(d.score);
      }
    }
  });
});

describe('F-002 — L1/L2 in the diagnostic', () => {
  it('a low-ability run descends into L1/L2 bands (never the retired basic collapse) and scores at the low anchors', async () => {
    await seedFullPool();
    const { agent } = await registerUser(t.app, pg.pool);

    // Skip every item (picked: null) — a skip is ALWAYS graded incorrect,
    // which keeps the trajectory deterministic even for generated items,
    // whose correct choice is shuffled to a random position ('b' would be
    // right ~25% of the time).
    // θ staircase, all wrong (diagnostic-upgrade Phase B gradual start-easy
    // ramp): seed 1.2, step1 = 0.7 → 1.2 − 0.7 = 0.5 → clamped to 1.0
    // (THETA_MIN) — a struggling learner floors after a SINGLE wrong answer
    // (see cat.test.ts's reachability tests), so the generated dims are served
    // at L1 the whole run. Hanja items (HANJA_ORDINALS) interleave
    // too but are COVERAGE-ONLY — graded and scored, yet excluded from this θ
    // ladder; they're served at L2 (the hanja corpus has no L1 tier), so
    // servedLevels shows both L1 and L2 while θ never moves off the floor
    // (verified below).
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;
    const servedLevels: string[] = [];
    const servedPrompts: string[] = [];
    let current: { responseId: number; level: string; prompt: string } | null = start.body.item;
    while (current !== null) {
      servedLevels.push(current.level);
      servedPrompts.push(current.prompt);
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: null });
      expect(ans.status).toBe(200);
      expect(ans.body.result.correct).toBe(false);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }

    // The run resolved to L1/L2 item levels — not collapsed to 'basic'.
    expect(servedLevels).toContain('L2');
    expect(servedLevels).toContain('L1');
    expect(servedLevels).not.toContain('basic');
    // The GENERATOR received the L1 target too (the stub echoes targetLevel
    // into its prompt) — proving targetLevelForTheta no longer floors at L3.
    expect(servedPrompts.some((p) => p.includes('(L1)'))).toBe(true);

    // θ descended to the new 1.0 floor (pre-F-002 it froze at 2.00) — a
    // SINGLE wrong answer under the new seed/step, and every hanja answer in
    // between never nudged it (coverage-only: /answer skips nextTheta for
    // section='hanja').
    const run = await pg.pool.query<{ ability_estimate: string }>(
      `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]?.ability_estimate).toBe('1.00');

    // Finish: the generated dims were served ENTIRELY at L1 difficulty (θ
    // floored before the first vocab/grammar ordinal was even served: 1,1,1,1
    // each → estimate clamps at 1), so their score is the new 1→10 low
    // anchor — anchored, not extrapolated.
    const fin = await agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(fin.status).toBe(200);
    const dims = fin.body.snapshot.dimensions as Array<{ key: string; score: number }>;
    expect(dims.find((d) => d.key === 'vocab')?.score).toBe(10);
    expect(dims.find((d) => d.key === 'grammar')?.score).toBe(10);

    // Hanja still produced its OWN dimensionStats/snapshot entry (coverage —
    // it was answered, just never fed the θ ladder above). Served at L2 the
    // whole run (band L1 → preferredHanjaLevel L2) and all-wrong (skip), so
    // its estimate/score sit at the same kind of floor as vocab/grammar —
    // this is what "coverage-only" delivers: a real read-out, decoupled θ.
    const hanja = dims.find((d) => d.key === 'hanja');
    expect(hanja).toBeDefined();
    expect(hanja!.score).toBeGreaterThanOrEqual(0);
    expect(hanja!.score).toBeLessThanOrEqual(100);
  });

  it('pickTopikRow prefers TOPIK I items for L1/L2 bands and falls back to any when the pool runs short', async () => {
    // Reading pool: ONE TOPIK I item (proficiency untagged — the real corpus
    // shape) + five TOPIK II items tagged L4 (WEIGHTS.reading = 6 total).
    // Listening: TOPIK II only.
    const topik1Id = await seedTopikItem(pg.pool, {
      section: 'reading',
      topikLevel: 'TOPIK I',
      proficiency: null,
      answer: 1,
    });
    for (let i = 0; i < 5; i += 1) {
      await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    }
    for (let i = 0; i < 6; i += 1) {
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
    }
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    // All-skip run (a skip is deterministically incorrect): ordinal 1
    // (reading) serves at SEED_THETA=1.2 → band L1 (diagnostic-upgrade Phase B
    // gradual start-easy ramp) → L1/L2 bands skip the
    // proficiency-targeted attempt entirely and go straight to the TOPIK-I
    // paper preference, which matches EXACTLY the one untagged TOPIK I row
    // (deterministic despite ORDER BY random()) — so ordinal 1 itself is the
    // TOPIK I item this time, not a later slot. θ floors to 1.00 after that
    // very first (wrong) answer, so every later reading slot
    // (READING_ORDINALS[1..]) serves at L1 too, but the TOPIK-I-targeted
    // attempt is empty by then (the one TOPIK I row was already excluded)
    // and falls back to "any", which is the 5-row TOPIK II pool.
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;
    let current: { responseId: number } | null = start.body.item;
    while (current !== null) {
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: null });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }

    const served = await pg.pool.query<{
      ordinal: number;
      source_ref: string;
      topik_level: string;
    }>(
      `SELECT r.ordinal, r.source_ref, t.topik_level
         FROM diagnostic_responses r
         JOIN topik_items i ON i.id::text = r.source_ref
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE r.run_id = $1 AND r.section = 'reading' AND r.source_kind = 'topik'
        ORDER BY r.ordinal`,
      [runId],
    );
    // All six reading slots were served (the fallback kept the run whole).
    expect(served.rows.map((r) => r.ordinal)).toEqual(READING_ORDINALS);
    // Ordinal 1 — served at the seed's L2 band — is THE TOPIK I item.
    const atOrd1 = served.rows.find((r) => r.ordinal === READING_ORDINALS[0]);
    expect(atOrd1?.source_ref).toBe(String(topik1Id));
    expect(atOrd1?.topik_level).toBe('TOPIK I');
    // Every LATER reading slot: TOPIK I exhausted after ordinal 1 → band→any
    // fallback served TOPIK II for the rest of the run.
    for (const ordinal of READING_ORDINALS.slice(1)) {
      expect(served.rows.find((r) => r.ordinal === ordinal)?.topik_level).toBe('TOPIK II');
    }
  });

  it('L1/L2 vocab/grammar items seed from basic-tagged content, not a random any-level row (fixpass B-1)', async () => {
    // Reading/listening pools so the run stays whole.
    for (let i = 0; i < 6; i += 1) {
      await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
    }
    // ONE basic seed vs NINE L3 seeds per section. With the band→'basic'
    // mapping, every L1/L2 slot's targeted attempt matches exactly the basic
    // row (deterministic despite ORDER BY random()); without it, the targeted
    // attempt matched zero rows and the any-level fallback picked uniformly —
    // the odds all 8 slots land on basic by chance are (1/10)^8.
    const basicVocabId = await seedVocabEntry(pg.pool, { proficiency: 'basic', korean: '사과' });
    const basicKgiuId = await seedKgiuEntry(pg.pool, { proficiency: 'basic', pattern: '-아/어요' });
    for (let i = 0; i < 9; i += 1) {
      await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: `낱말${i}` });
      await seedKgiuEntry(pg.pool, { proficiency: 'L3', pattern: `-기 마련이다${i}` });
    }
    const { agent } = await registerUser(t.app, pg.pool);

    // All-skip staircase (diagnostic-upgrade Phase B ramp: seed 1.2, step1
    // 0.7 → floors to θ=1.0/L1 after the very first wrong answer): vocab
    // slots and grammar slots (WEIGHTS.vocab/grammar = 6 each) all serve at
    // band L1 — ALL beginner-band, all six items each. hanja_characters is
    // unseeded here, so every hanja ordinal is silently skipped — the
    // `source_kind='generated'` query below is vocab+grammar+writing
    // (WEIGHTS.vocab + WEIGHTS.grammar + WEIGHTS.writing rows,
    // diagnostic-upgrade Phase B: writing's 2 slots ALSO reuse
    // source_kind='generated', seeded from the SAME kgiu_entries pool
    // grammar draws from), unaffected by hanja sharing that source_kind (see
    // seedFullPool's beforeEach-truncate note above). By writing's slots
    // this all-skip staircase has long since floored θ at L1 (every answer
    // is wrong), so writing's seed pick is beginner-band too — the per-row
    // assertion below already generalizes to it (a writing row's
    // `source_ref` is a kgiu_entries id exactly like grammar's, so it falls
    // into the SAME `: basicKgiuId` branch).
    const runId = await runAllSkip(agent);

    const seeds = await pg.pool.query<{ section: string; source_ref: string; difficulty: string }>(
      `SELECT section::text AS section, source_ref, difficulty::text AS difficulty
         FROM diagnostic_responses
        WHERE run_id = $1 AND source_kind = 'generated'
        ORDER BY ordinal`,
      [runId],
    );
    expect(seeds.rows).toHaveLength(WEIGHTS.vocab + WEIGHTS.grammar + WEIGHTS.writing);
    for (const row of seeds.rows) {
      // Every beginner-band generated item was seeded from the basic pool…
      expect(row.source_ref).toBe(
        row.section === 'vocab' ? String(basicVocabId) : String(basicKgiuId),
      );
      // …and recorded at the beginner difficulty it was targeted at (1 or 2),
      // never an intermediate seed masquerading as L1/L2.
      expect(Number(row.difficulty)).toBeLessThanOrEqual(2);
    }
  });

  it('L1/L2 seed picking falls back to any level when no basic content exists (fixpass B-1)', async () => {
    for (let i = 0; i < 6; i += 1) {
      await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
    }
    // NO basic rows anywhere — the targeted attempt is empty, the fallback
    // must still supply a seed so the run never shrinks.
    const l3VocabId = await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '낱말' });
    const l3KgiuId = await seedKgiuEntry(pg.pool, { proficiency: 'L3', pattern: '-기 마련이다' });
    const { agent } = await registerUser(t.app, pg.pool);

    const runId = await runAllSkip(agent);

    const seeds = await pg.pool.query<{ section: string; source_ref: string }>(
      `SELECT section::text AS section, source_ref
         FROM diagnostic_responses
        WHERE run_id = $1 AND source_kind = 'generated'
        ORDER BY ordinal`,
      [runId],
    );
    // All generated slots served (vocab+grammar+writing, diagnostic-upgrade
    // Phase B) — the empty basic pool never starved a slot.
    expect(seeds.rows).toHaveLength(WEIGHTS.vocab + WEIGHTS.grammar + WEIGHTS.writing);
    for (const row of seeds.rows) {
      expect(row.source_ref).toBe(
        row.section === 'vocab' ? String(l3VocabId) : String(l3KgiuId),
      );
    }
  });

  it('snapshot references include the L1/L2 ladder, lowest-first (fixpass SF-1)', async () => {
    // The live REFERENCES const must carry the same TOPIK 1/2 rungs the client
    // fixture promises — a beginner scoring 10/25 needs reference lines below
    // TOPIK 3 = 40. /latest (empty) emits the shared const; /finish and
    // /history reuse it, so pinning it here pins all three.
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/diagnostic/latest');
    expect(res.status).toBe(200);
    const refs = res.body.references as Array<{
      id: string;
      label: string;
      kr: string;
      value: number;
    }>;
    expect(refs.map((r) => r.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'native']);
    expect(refs[0]).toEqual({ id: 'L1', label: 'TOPIK 1', kr: '1급', value: 10 });
    expect(refs[1]).toEqual({ id: 'L2', label: 'TOPIK 2', kr: '2급', value: 25 });
    // Lowest-first and strictly increasing — the chart renders them as rungs.
    for (let i = 1; i < refs.length; i += 1) {
      expect(refs[i]!.value).toBeGreaterThan(refs[i - 1]!.value);
    }
  });

  it('pickTopikRow prefers TOPIK II items for L3+ bands and falls back to any when TOPIK II runs short (fixpass SF-2)', async () => {
    // Reading pool, ALL proficiency-untagged (the real corpus shape): TWO
    // TOPIK II items + nine TOPIK I items — thin enough that TOPIK II runs
    // dry before the run's 4 reading slots are served, exercising the
    // any-fallback in the SAME test as the preference itself.
    //
    // Ordinal 1 is unavoidably served at SEED_THETA=1.2 → band L1
    // (diagnostic-upgrade Phase B gradual start-easy ramp), which prefers
    // TOPIK I, not TOPIK II — that opener is covered by the L1/L2 test above,
    // not here. To reach the L3+ bands this test cares about, it answers EVERY
    // item correctly by echoing each item's stored correct_answer (the only
    // deterministic way UP: generated MC choices are shuffled server-side, so a
    // fixed pick is only ~25% correct). Under the gradual ramp an all-correct
    // run climbs steadily out of the L1 seed — 1.2 → 1.9 → 2.57 → 3.21 → 3.82
    // over the first four θ-bumping answers (hanja is coverage-only) — so the
    // LATER reading slots (ordinals 6/11/16) are served in the L3+ bands, where
    // pickTopikRow prefers TOPIK II. The OBSERVABLE property pinned here is
    // paper selection by band, not the exact θ trajectory.
    const topik2Ids = [
      await seedTopikItem(pg.pool, {
        section: 'reading',
        topikLevel: 'TOPIK II',
        proficiency: null,
        answer: 1,
      }),
      await seedTopikItem(pg.pool, {
        section: 'reading',
        topikLevel: 'TOPIK II',
        proficiency: null,
        answer: 1,
      }),
    ];
    for (let i = 0; i < 9; i += 1) {
      await seedTopikItem(pg.pool, {
        section: 'reading',
        topikLevel: 'TOPIK I',
        proficiency: null,
        answer: 1,
      });
    }
    for (let i = 0; i < 6; i += 1) {
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: null, answer: 1 });
    }
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;
    let current: { responseId: number; section: string } | null = start.body.item;
    while (current !== null) {
      // Answer correctly by echoing the item's stored correct_answer: the
      // shuffled correct letter for MC items, and the 'writing' sentinel for
      // the writing item (a non-empty, non-BAD_ANSWER_SENTINEL string, which
      // the scoreGrammarDrill stub grades 'good' → also correct). This drives a
      // monotonic θ climb into the L3+ bands.
      const correct = await pg.pool.query<{ correct_answer: string }>(
        `SELECT correct_answer FROM diagnostic_responses WHERE id = $1`,
        [current.responseId],
      );
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: correct.rows[0]!.correct_answer });
      expect(ans.status).toBe(200);
      if (ans.body.done === true) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }

    const served = await pg.pool.query<{
      ordinal: number;
      source_ref: string;
      topik_level: string;
    }>(
      `SELECT r.ordinal, r.source_ref, t.topik_level
         FROM diagnostic_responses r
         JOIN topik_items i ON i.id::text = r.source_ref
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE r.run_id = $1 AND r.section = 'reading' AND r.source_kind = 'topik'
        ORDER BY r.ordinal`,
      [runId],
    );
    // All six reading slots served.
    expect(served.rows).toHaveLength(READING_ORDINALS.length);
    expect(served.rows.map((r) => r.ordinal)).toEqual(READING_ORDINALS);

    const laterRows = served.rows.filter((r) => r.ordinal !== READING_ORDINALS[0]);
    const topikIIRefs = new Set(topik2Ids.map(String));
    const laterTopikII = laterRows.filter((r) => topikIIRefs.has(r.source_ref));
    const laterTopikI = laterRows.filter((r) => !topikIIRefs.has(r.source_ref));
    // Both TOPIK II rows were consumed by later (L3+-band) slots — the
    // preference worked, not a random 2-in-11 coincidence.
    expect(laterTopikII).toHaveLength(2);
    // The pool being only 2-deep forced at least one later slot to fall back
    // to TOPIK I (the any-fallback).
    expect(laterTopikI.length).toBeGreaterThanOrEqual(1);
    for (const row of laterTopikI) {
      expect(row.topik_level).toBe('TOPIK I');
    }
  });

  it('an L3+ band with NO TOPIK II items still serves (paper preference falls back to any) (fixpass SF-2)', async () => {
    // Reading: ONLY TOPIK I, untagged — the paper-preference attempt for an
    // L3+ band matches ZERO rows here (no TOPIK II item exists at all in
    // this pool, unlike the sibling test above which merely runs a thin
    // TOPIK II pool dry); the final "any" attempt must still keep the run
    // whole.
    for (let i = 0; i < 6; i += 1) {
      await seedTopikItem(pg.pool, {
        section: 'reading',
        topikLevel: 'TOPIK I',
        proficiency: null,
        answer: 1,
      });
    }
    for (let i = 0; i < 6; i += 1) {
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: null, answer: 1 });
    }
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    // This pool is TOPIK-I-ONLY: no TOPIK II item exists at all. So whatever
    // band each reading slot lands in under the gradual ramp (ordinal 1 opens
    // at the seed's L1 band), the paper-preference attempt that would want a
    // TOPIK II row for an L3+ slot matches nothing, and the final "any" attempt
    // still serves the TOPIK I rows — keeping the run whole. We drive reading +
    // listening correct (deterministic answer:1 → 'a') and skip the generated
    // dims; the OBSERVABLE property is that every reading slot is filled from
    // the any-fallback, never left empty. Reading's OWN per-category ladder
    // (diagnostic-upgrade Phase C) climbs 1.2(L1) → 1.9(L2) → 2.57(L3) over
    // its own first two correct answers, so its THIRD occurrence is the
    // first one served at an L3+ band — stop once that ordinal is reached.
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;
    let current: { responseId: number; section: string; ordinal: number } | null = start.body.item;
    while (current !== null) {
      const picked = current.section === 'reading' || current.section === 'listening' ? 'a' : null;
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked });
      expect(ans.status).toBe(200);
      if (ans.body.done === true || current.ordinal >= READING_ORDINALS[2]!) {
        current = null;
        continue;
      }
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }

    const served = await pg.pool.query<{ ordinal: number; topik_level: string }>(
      `SELECT r.ordinal, t.topik_level
         FROM diagnostic_responses r
         JOIN topik_items i ON i.id::text = r.source_ref
         JOIN topik_tests t ON t.id = i.topik_test_id
        WHERE r.run_id = $1 AND r.section = 'reading'
        ORDER BY r.ordinal`,
      [runId],
    );
    expect(served.rows.map((r) => r.ordinal)).toEqual(READING_ORDINALS.slice(0, 3));
    // The THIRD reading ordinal — served at an L3+ band (θ climbed via
    // reading's own two prior correct answers) with zero TOPIK II rows in
    // the pool — still served, via the any-fallback, never starved.
    expect(served.rows[2]?.topik_level).toBe('TOPIK I');
  });

  it('an old v1.1.0 snapshot still loads after the RUBRIC_VERSION bump (band intact, no throw)', async () => {
    // A snapshot written by the F-011 (v1.1.0) rubric, exactly as /finish
    // persisted it then: estimate columns + evidence.dimensionStats. History
    // reads are version-agnostic — bumping RUBRIC_VERSION to v1.3.0 must not
    // strand old rows.
    const { agent, userId } = await registerUser(t.app, pg.pool);
    const snapId = await seedDiagnosticSnapshot(pg.pool, userId, { reading: 4.75, vocab: 4 });
    await pg.pool.query(
      `UPDATE diagnostic_snapshots
          SET rubric_version = 'v1.1.0', evidence = $1::jsonb
        WHERE id = $2`,
      [
        JSON.stringify({
          dimensionStats: {
            reading: { n: 4, correct: 4, estimate: 4.75, score: 66, scoreLow: 63, scoreHigh: 70 },
          },
        }),
        snapId,
      ],
    );

    const latest = await agent.get('/diagnostic/latest');
    expect(latest.status).toBe(200);
    const dims = latest.body.dimensions as Array<{
      key: string;
      score: number;
      scoreLow: number;
      scoreHigh: number;
    }>;
    // The v1.1.0 band is rebuilt verbatim from the stored stats…
    const reading = dims.find((d) => d.key === 'reading');
    expect(reading?.score).toBe(66);
    expect(reading?.scoreLow).toBe(63);
    expect(reading?.scoreHigh).toBe(70);
    // …and a dimension without stats degrades to a zero-width band as ever.
    const vocab = dims.find((d) => d.key === 'vocab');
    expect(vocab?.score).toBe(55);
    expect(vocab?.scoreLow).toBe(55);
    expect(vocab?.scoreHigh).toBe(55);

    // /history serves the same row through the same reader.
    const hist = await agent.get('/diagnostic/history');
    expect(hist.status).toBe(200);
    expect((hist.body.snapshots as unknown[]).length).toBe(1);
  });
});

describe('hanja — coverage-only dimension (diagnostic-upgrade Phase A)', () => {
  /** Seed just enough for a run that reaches the hanja ordinal: reading/
   *  listening pools (topik) + vocab/grammar seeds (Claude stub) + a small
   *  distinct-valued L2 hanja pool (>=4 distinct char/sound/gloss_en rows —
   *  1 answer + 3 distractors). */
  async function seedForHanja(): Promise<void> {
    for (let i = 0; i < 7; i += 1) {
      await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
    }
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const l2Chars: ReadonlyArray<{ char: string; sound: string; glossEn: string }> = [
      { char: '學', sound: '학', glossEn: 'learn' },
      { char: '校', sound: '교', glossEn: 'school' },
      { char: '生', sound: '생', glossEn: 'life' },
      { char: '大', sound: '대', glossEn: 'big' },
      { char: '國', sound: '국', glossEn: 'country' },
    ];
    for (const c of l2Chars) await seedHanjaCharacter(pg.pool, { ...c, level: 'L2' });
  }

  /** Drive a run with all-skip answers up to (not including) ordinal
   *  `target`, returning the still-unanswered item AT that ordinal. */
  async function serveToOrdinal(
    agent: RegisteredAgent['agent'],
    target: number,
  ): Promise<{
    runId: number;
    item: {
      responseId: number;
      ordinal: number;
      section: string;
      kind: string;
      choices: Array<{ id: string; kr: string; en: string }>;
    };
  }> {
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId as number;
    let current = start.body.item;
    while (current.ordinal < target) {
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: null });
      expect(ans.status).toBe(200);
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }
    return { runId, item: current };
  }

  it('serves a well-formed 4-choice MC item at the hanja ordinal — the section CHECK accepts it', async () => {
    await seedForHanja();
    const { agent } = await registerUser(t.app, pg.pool);
    // HANJA_ORDINALS[0] is the run's first hanja slot.
    const { item } = await serveToOrdinal(agent, HANJA_ORDINALS[0]!);

    expect(item.section).toBe('hanja');
    expect(['hanja-reading', 'hanja-meaning']).toContain(item.kind);
    expect(item.choices).toHaveLength(4);
    expect(item.choices.map((c) => c.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    // Distractors are distinct-valued — no two choices read identically.
    const texts = item.choices.map((c) => c.kr);
    expect(new Set(texts).size).toBe(4);
    // Answer-stripped like every other item — the security property holds
    // for hanja too.
    expect(item).not.toHaveProperty('correctAnswer');
    expect(item).not.toHaveProperty('explain');
    for (const c of item.choices) {
      expect(c).not.toHaveProperty('correct');
    }
  });

  it("a hanja answer does NOT bump θ (coverage-only) but DOES record the character's real level and produce a dimensionStats entry", async () => {
    await seedForHanja();
    const { agent } = await registerUser(t.app, pg.pool);
    const { runId, item } = await serveToOrdinal(agent, HANJA_ORDINALS[0]!);

    const before = await pg.pool.query<{ ability_estimate: string | null }>(
      `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const thetaBefore = before.rows[0]?.ability_estimate;

    const ans = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'a' });
    expect(ans.status).toBe(200);

    const after = await pg.pool.query<{ ability_estimate: string | null }>(
      `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    // θ is UNCHANGED by the hanja answer, whether it was graded correct or
    // wrong — coverage-only excludes hanja from the global ladder entirely.
    expect(after.rows[0]?.ability_estimate).toBe(thetaBefore);

    // The served item's persisted difficulty is the CHARACTER'S real corpus
    // level (2, for L2 — seedForHanja seeds L2 chars only), NOT derived from
    // the CAT band at serve time (which was L1 by the run's first hanja
    // ordinal — a single wrong answer floors θ, see the F-002 describe block
    // above for the exact staircase).
    const stored = await pg.pool.query<{ difficulty: string; section: string }>(
      `SELECT difficulty::text AS difficulty, section::text AS section
         FROM diagnostic_responses WHERE id = $1`,
      [item.responseId],
    );
    expect(stored.rows[0]?.section).toBe('hanja');
    expect(Number(stored.rows[0]?.difficulty)).toBe(2);

    // Finish the run (skip everything remaining) and confirm hanja still
    // gets its own dimensionStats entry in the snapshot — coverage-only
    // means "excluded from θ", never "excluded from the read-out".
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    let current: { responseId: number } | null = nxt.body.next;
    while (current !== null) {
      const a = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked: null });
      expect(a.status).toBe(200);
      if (a.body.done === true) {
        current = null;
        continue;
      }
      const n = await agent.post(`/diagnostic/${runId}/next`).send({});
      current = n.body.next;
    }
    const fin = await agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(fin.status).toBe(200);
    const dims = fin.body.snapshot.dimensions as Array<{ key: string; score: number }>;
    const hanja = dims.find((d) => d.key === 'hanja');
    expect(hanja).toBeDefined();
    expect(hanja!.score).toBeGreaterThanOrEqual(0);
    expect(hanja!.score).toBeLessThanOrEqual(100);
  });
});

describe('writing — full leveled dimension (diagnostic-upgrade Phase B)', () => {
  /** Seed just enough for a run that reaches writing's two slots
   *  (WRITING_ORDINALS): reading/listening pools (topik) + a vocab/grammar
   *  seed (Claude stub) — writing draws its own seed from the SAME
   *  kgiu_entries pool grammar does (buildWritingItem calls pickGrammarSeed
   *  exactly like buildGeneratedItem's grammar branch). hanja_characters is
   *  deliberately left unseeded (mirrors the 'empty pool handling' describe
   *  block above): every HANJA_ORDINALS slot silently skips, but the
   *  schedule still reaches WRITING_ORDINALS in the same /next call — this
   *  test only cares about writing, and unseeded hanja keeps the setup
   *  smaller. */
  async function seedForWriting(): Promise<void> {
    for (let i = 0; i < 7; i += 1) {
      await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
    }
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
  }

  /** Drive a run with all-skip answers up to (not including) ordinal
   *  `target`, returning the still-unanswered item AT that ordinal (mirrors
   *  the hanja describe block's own `serveToOrdinal` — duplicated locally
   *  rather than hoisted, matching this file's existing per-block idiom). */
  async function serveToOrdinal(
    agent: RegisteredAgent['agent'],
    target: number,
    // Picked value for every item ANSWERED on the way to `target` (the
    // target item itself is left unanswered, returned for the caller to
    // grade). Defaults to a skip (null) — the hanja block's own convention.
    // The BAD-writing-answer test overrides this to 'a': an all-skip drive
    // floors θ at THETA_MIN well before writing's first ordinal (reading/listening/vocab/
    // grammar all graded wrong), leaving no room for a bad writing answer to
    // move θ DOWN any further — 'a' is guaranteed-correct on every
    // topik-sourced reading/listening item (seedTopikItem's answer=1), which
    // keeps θ off the floor.
    picked: string | null = null,
  ): Promise<{
    runId: number;
    item: {
      responseId: number;
      ordinal: number;
      section: string;
      kind: string;
      prompt: string;
      passage?: string;
      hint?: string;
      choices: Array<{ id: string; kr: string; en: string }>;
    };
  }> {
    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId as number;
    let current = start.body.item;
    while (current.ordinal < target) {
      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: current.responseId, picked });
      expect(ans.status).toBe(200);
      const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
      expect(nxt.status).toBe(200);
      current = nxt.body.next;
    }
    return { runId, item: current };
  }

  it('serves a writing-production item with a prompt but NO reference answer on the wire', async () => {
    await seedForWriting();
    const { agent } = await registerUser(t.app, pg.pool);
    const { item } = await serveToOrdinal(agent, WRITING_ORDINALS[0]!);

    expect(item.section).toBe('writing');
    expect(item.kind).toBe('writing-production');
    expect(typeof item.prompt).toBe('string');
    expect(item.prompt.length).toBeGreaterThan(0);
    // No MC choices — a writing item has none to strip.
    expect(item.choices).toEqual([]);
    // Answer-stripping (THE security property) extends to writing's own
    // secrets: the reference model + grading pattern must never reach the
    // client before grading.
    expect(item).not.toHaveProperty('correctAnswer');
    expect(item).not.toHaveProperty('explain');
    expect(item).not.toHaveProperty('referenceModelKr');
    expect(item).not.toHaveProperty('referenceModelEn');
    expect(item).not.toHaveProperty('patternDisplay');
  });

  it('a GOOD writing answer maps verdict→isCorrect=true and BUMPS θ (unlike hanja)', async () => {
    await seedForWriting();
    const { agent } = await registerUser(t.app, pg.pool);
    const { runId, item } = await serveToOrdinal(agent, WRITING_ORDINALS[0]!);

    const before = await pg.pool.query<{ ability_estimate: string | null }>(
      `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const thetaBefore = Number(before.rows[0]?.ability_estimate);

    // No BAD_ANSWER_SENTINEL in the answer → the stub's scoreGrammarDrill
    // grades 'good' (see tests/helpers/app.ts).
    const ans = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: '그는 학생인 것 같다.' });
    expect(ans.status).toBe(200);
    expect(ans.body.result.correct).toBe(true);
    expect(ans.body.result.verdict).toBe('good');
    expect(typeof ans.body.result.summary).toBe('string');
    expect(ans.body.result.referenceModelKr).toBe('모델 답안입니다.');
    // Reference model is revealed ONLY now, post-answer.
    expect(ans.body.result.corrections).toEqual([
      { span: '___', issue: 'mock issue', fix: 'mock fix' },
    ]);

    const after = await pg.pool.query<{ ability_estimate: string | null }>(
      `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const thetaAfter = Number(after.rows[0]?.ability_estimate);
    // θ moved — and moved UP (correct), unlike a hanja answer which never
    // moves θ at all.
    expect(thetaAfter).not.toBe(thetaBefore);
    expect(thetaAfter).toBeGreaterThan(thetaBefore);
  });

  it('a BAD writing answer (verdict needs_work/incorrect) maps to isCorrect=false and BUMPS θ DOWN', async () => {
    await seedForWriting();
    const { agent } = await registerUser(t.app, pg.pool);
    const { runId, item } = await serveToOrdinal(agent, WRITING_ORDINALS[0]!);

    // serveToOrdinal answers every preceding item WRONG (picked:null), so θ has
    // already bottomed out at THETA_MIN (1.0) by writing's first ordinal — a further down-bump
    // would clamp and be unobservable. Park θ mid-range first so the DOWN move is
    // real, not a floor no-op. /answer reads the stored ability_estimate and
    // applies one step to it (diagnostic.ts:1782-1783), so this UPDATE takes.
    await pg.pool.query(`UPDATE diagnostic_runs SET ability_estimate = 4.0 WHERE id = $1`, [runId]);

    const before = await pg.pool.query<{ ability_estimate: string | null }>(
      `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const thetaBefore = Number(before.rows[0]?.ability_estimate);

    // BAD_ANSWER_SENTINEL flips the stub's scoreGrammarDrill to 'incorrect'.
    const ans = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: item.responseId, picked: 'BAD_ANSWER_SENTINEL' });
    expect(ans.status).toBe(200);
    expect(ans.body.result.correct).toBe(false);
    expect(ans.body.result.verdict).toBe('incorrect');

    const after = await pg.pool.query<{ ability_estimate: string | null }>(
      `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    const thetaAfter = Number(after.rows[0]?.ability_estimate);
    expect(thetaAfter).toBeLessThan(thetaBefore);
  });

  it('an empty/whitespace-only answer grades incorrect (θ down) WITHOUT calling Claude, and never crashes', async () => {
    // A scoreGrammarDrill override that FAILS the test if it's ever called —
    // proves the empty-answer path is graded locally, not via a wasted
    // Claude call (the graceful path the spec calls for). Fix-pass SF2: this
    // now also asserts the θ-down consequence of "graded incorrect", not
    // just the verdict string — the same real-decrease bar the BAD-answer
    // test above holds itself to.
    setClaudeProxy(
      makeStubProxy({
        scoreGrammarDrill: async () => {
          throw new Error('scoreGrammarDrill must not be called for an empty answer');
        },
      }),
    );
    try {
      await seedForWriting();
      const { agent } = await registerUser(t.app, pg.pool);
      const { runId, item } = await serveToOrdinal(agent, WRITING_ORDINALS[0]!);

      // serveToOrdinal's default all-skip drive already floors θ at
      // THETA_MIN by writing's first ordinal (same reasoning as the BAD-answer test
      // above) — a further down-bump would clamp and be unobservable. Park θ
      // mid-range first so the DOWN move asserted below is real, not a floor
      // no-op.
      await pg.pool.query(`UPDATE diagnostic_runs SET ability_estimate = 4.0 WHERE id = $1`, [
        runId,
      ]);
      const before = await pg.pool.query<{ ability_estimate: string | null }>(
        `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
        [runId],
      );
      const thetaBefore = Number(before.rows[0]?.ability_estimate);

      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: item.responseId, picked: '   ' });
      expect(ans.status).toBe(200);
      expect(ans.body.result.correct).toBe(false);
      expect(ans.body.result.verdict).toBe('incorrect');

      const after = await pg.pool.query<{ ability_estimate: string | null }>(
        `SELECT ability_estimate::text AS ability_estimate FROM diagnostic_runs WHERE id = $1`,
        [runId],
      );
      const thetaAfter = Number(after.rows[0]?.ability_estimate);
      expect(thetaAfter).toBeLessThan(thetaBefore);
    } finally {
      setClaudeProxy(makeStubProxy());
      resetLimiters();
    }
  });

  it('fix-pass SF1: a duplicate /answer for a writing item already being graded short-circuits to 409 WITHOUT a second Claude call', async () => {
    // Simulates the losing side of the race the SF1 fix closes: another
    // request has already won `claimWritingGrade` (item_payload carries a
    // live, un-expired gradingClaimedAt) and is presumably mid-Claude-call.
    // A duplicate /answer for the SAME still-pending responseId must find
    // the claim live and short-circuit to 409 WITHOUT itself calling Claude
    // — proven the same way the empty-answer test proves it, by making the
    // stub throw if invoked at all.
    setClaudeProxy(
      makeStubProxy({
        scoreGrammarDrill: async () => {
          throw new Error('scoreGrammarDrill must not be called for a claimed item');
        },
      }),
    );
    try {
      await seedForWriting();
      const { agent } = await registerUser(t.app, pg.pool);
      const { runId, item } = await serveToOrdinal(agent, WRITING_ORDINALS[0]!);

      // Simulate an in-flight claim from a "first" concurrent request, as
      // `claimWritingGrade` itself would have just written it.
      await pg.pool.query(
        `UPDATE diagnostic_responses
            SET item_payload = item_payload || jsonb_build_object('gradingClaimedAt', now())
          WHERE id = $1`,
        [item.responseId],
      );

      const ans = await agent
        .post(`/diagnostic/${runId}/answer`)
        .send({ responseId: item.responseId, picked: '그는 학생인 것 같다.' });
      expect(ans.status).toBe(409);
      // Fix-pass 2 FIX B: this is the DISTINCT `writing_grade_in_progress`
      // code, not the generic `conflict` code the double-answer test above
      // asserts — the client relies on this to avoid treating a claim
      // collision as "already recorded" (which would be factually wrong:
      // the item is still unanswered, per the assertion below).
      expect(ans.body.error.code).toBe('writing_grade_in_progress');

      // The item is still genuinely unanswered — the claim alone never wrote
      // answered_at, so a real retry (after the claim TTL or its release)
      // could still legitimately grade it.
      const row = await pg.pool.query<{ answered_at: Date | null }>(
        `SELECT answered_at FROM diagnostic_responses WHERE id = $1`,
        [item.responseId],
      );
      expect(row.rows[0]?.answered_at).toBeNull();
    } finally {
      setClaudeProxy(makeStubProxy());
      resetLimiters();
    }
  });

  it('fix-pass 2 FIX A: the writing-grade claim TTL is derived and strictly exceeds the worst-case Claude call duration', () => {
    // Guard against reintroducing NF-1 (the original hardcoded 30s TTL,
    // which was shorter than a single CLAUDE_TIMEOUT_MS attempt alone, let
    // alone the full retry budget). This does NOT exercise real TTL expiry
    // (that needs clock injection — out of scope, see FIX_REPORT2.md) but
    // DOES fail immediately if someone reverts `writingClaimTtlSeconds()`
    // back to a short hardcoded constant, since the derived value would
    // then be smaller than the config's own worst-case call duration.
    const worstCaseCallMs = maxClaudeCallDurationMs();
    const ttlMs = writingClaimTtlSeconds() * 1000;
    expect(ttlMs).toBeGreaterThan(worstCaseCallMs);
    // Sanity: the margin is a real buffer (seconds), not a rounding fluke.
    expect(ttlMs - worstCaseCallMs).toBeGreaterThanOrEqual(1000);
  });

  it('writing gets its own dimensionStats entry in the finished snapshot', async () => {
    await seedForWriting();
    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await runAllSkip(agent);

    const fin = await agent.post(`/diagnostic/${runId}/finish`).send({});
    expect(fin.status).toBe(200);
    const dims = fin.body.snapshot.dimensions as Array<{ key: string; score: number }>;
    const writing = dims.find((d) => d.key === 'writing');
    expect(writing).toBeDefined();
    expect(writing!.score).toBeGreaterThanOrEqual(0);
    expect(writing!.score).toBeLessThanOrEqual(100);
  });
});

describe('B1 — prompt is instruction, not stem (no duplicated question text)', () => {
  it('a reading item prompts with `instruction`; `passage` stays the stem — the two never match', async () => {
    // Before the fix, `stem` was BOTH the on-screen prompt AND the passage —
    // the same Korean string printed twice. `instruction` is the curator's
    // actual question directive and is a DIFFERENT string from the passage
    // body (`stem`) it asks about.
    const passage = '어제는 친구를 만나서 영화를 봤습니다. 영화가 정말 재미있었습니다.';
    const instruction = '이 글의 내용과 같은 것을 고르십시오.';
    await seedTopikItem(pg.pool, {
      section: 'reading',
      proficiency: 'L4',
      answer: 1,
      stem: passage,
      instruction,
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/diagnostic').send({});
    expect(res.status).toBe(201);
    const item = res.body.item;
    expect(item.section).toBe('reading');
    expect(item.prompt).toBe(instruction);
    expect(item.passage).toBe(passage);
    expect(item.prompt).not.toBe(item.passage);
  });

  it('a listening item prompts with `instruction`; `audio.transcript` stays the stem', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 }); // ordinal 1
    const transcript = '내일은 전국에 비가 오겠습니다.';
    const instruction = '다음을 듣고 물음에 알맞은 답을 고르십시오.';
    await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      stem: transcript,
      instruction,
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    expect(start.status).toBe(201);
    const runId = start.body.runId;
    const ans = await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    expect(ans.status).toBe(200);
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    const item = nxt.body.next;
    expect(item.section).toBe('listening');
    expect(item.prompt).toBe(instruction);
    expect(item.audio.transcript).toBe(transcript);
    expect(item.prompt).not.toBe(item.audio.transcript);
  });

  it('falls back to the generic prompt when `instruction` is null/blank', async () => {
    await seedTopikItem(pg.pool, {
      section: 'reading',
      proficiency: 'L4',
      answer: 1,
      instruction: null,
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/diagnostic').send({});
    expect(res.status).toBe(201);
    expect(res.body.item.prompt).toBe('다음 질문에 답하세요.');
  });
});

describe('F-119/F-206 — real listening audio on the diagnostic', () => {
  it('a listening item with a mapped span + a mapped test mp3 emits a real audioUrl/spans alongside the transcript', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 }); // ordinal 1
    const transcript = '내일은 전국에 비가 오겠습니다.';
    await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      stem: transcript,
      testNumber: 555_101,
      topikLevel: 'TOPIK II',
      audioStartMs: 12_000,
      audioEndMs: 34_000,
      audioPath: 'topik/555101/listening.mp3',
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    const item = nxt.body.next;
    expect(item.section).toBe('listening');
    // Exact URL shape mirrors topik.ts's own F-206 build — the client's
    // `buildAudioSrc` allow-list is anchored to this route shape already.
    expect(item.audioUrl).toBe('/topik/audio/555101/2');
    expect(item.audioStartMs).toBe(12_000);
    expect(item.audioEndMs).toBe(34_000);
    // The transcript still ships too (caption/reveal) — the real player does
    // not replace it.
    expect(item.audio.transcript).toBe(transcript);

    // The idempotent /next re-serve (double-call / lost-response retry) must
    // reproduce the SAME audio fields from the persisted item_payload.
    const again = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(again.status).toBe(200);
    expect(again.body.next.audioUrl).toBe('/topik/audio/555101/2');
    expect(again.body.next.audioStartMs).toBe(12_000);
    expect(again.body.next.audioEndMs).toBe(34_000);
  });

  it('a TOPIK I listening item resolves the level-1 stream path', async () => {
    // Only a TOPIK I candidate exists. Ordinal 2 (listening) serves after a
    // wrong ordinal-1 answer has floored θ to 1.0/L1 (diagnostic-upgrade
    // Phase B ramp), so the TOPIK-I-paper-targeted attempt matches this row
    // directly — deterministic either way (it is the sole row in the pool).
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      testNumber: 555_102,
      topikLevel: 'TOPIK I',
      audioStartMs: 1_000,
      audioEndMs: 5_000,
      audioPath: 'topik/555102/listening.mp3',
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.body.next.audioUrl).toBe('/topik/audio/555102/1');
  });

  it('a listening item with NO mapped span emits no audioUrl/spans — transcript only', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    const transcript = '오늘은 날씨가 맑습니다.';
    await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      stem: transcript,
      // No audioStartMs/audioEndMs/audioPath — the common live-corpus case.
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    const item = nxt.body.next;
    expect(item.section).toBe('listening');
    expect(item.audioUrl).toBeUndefined();
    expect(item.audioStartMs).toBeUndefined();
    expect(item.audioEndMs).toBeUndefined();
    expect(item.audio.transcript).toBe(transcript);
  });

  it('a half-mapped span (window without a test mp3) still emits no audioUrl', async () => {
    // The window alone is not enough — the DB CHECK forbids a half window,
    // but the TEST's audio_path is a separate table and can independently be
    // unmapped. Both must be present.
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      audioStartMs: 1_000,
      audioEndMs: 5_000,
      // audioPath omitted — the test's mp3 is not mapped.
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.body.next.audioUrl).toBeUndefined();
  });

  it('selection prefers an audio-carrying listening item over non-audio candidates in the same band', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    // 5 listening candidates with no mapped audio…
    for (let i = 0; i < 5; i += 1) {
      await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
    }
    // …and exactly one that carries a real span + mp3. The preference CASE
    // sorts it first deterministically (`random()` only breaks ties WITHIN
    // a CASE group), so this is not a statistical flake.
    const audioItemId = await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      testNumber: 555_103,
      audioStartMs: 2_000,
      audioEndMs: 9_000,
      audioPath: 'topik/555103/listening.mp3',
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.body.next.section).toBe('listening');
    expect(nxt.body.next.audioUrl).toBe('/topik/audio/555103/2');

    const served = await pg.pool.query<{ source_ref: string }>(
      `SELECT source_ref FROM diagnostic_responses WHERE run_id = $1 AND section = 'listening'`,
      [runId],
    );
    expect(served.rows[0]?.source_ref).toBe(String(audioItemId));
  });

  it('falls back to a non-audio listening item when none in the pool carry audio (never empties the pool)', async () => {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    expect(nxt.body.next.section).toBe('listening');
    expect(nxt.body.next.audioUrl).toBeUndefined();
  });

  it('SF-1 fix: a placeholder-stem item WITH a mapped audio span is RE-ADMITTED and carries audioUrl', async () => {
    // B-038 originally excluded EVERY placeholder-stem listening row
    // unconditionally, on the premise that the diagnostic served no audio
    // playback. This fix makes that premise false: a placeholder-stem row
    // that ALSO has a real mapped span + test mp3 is now a genuine, playable,
    // answerable listening question (the learner listens instead of reading
    // the stub stem) — exactly the case topik.ts's ANSWERABLE_ITEM_SQL
    // re-admits. Only the sole listening candidate is this row, so a served
    // listening item here proves re-admission, not just a lucky uniform draw.
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    const itemId = await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      stem: '[듣기 지문 없음 — 대화/담화가 오디오로만 제공됨(전사 파일 없음)]',
      testNumber: 555_104,
      topikLevel: 'TOPIK II',
      audioStartMs: 3_000,
      audioEndMs: 11_000,
      audioPath: 'topik/555104/listening.mp3',
    });
    await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
    await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
    const { agent } = await registerUser(t.app, pg.pool);

    const start = await agent.post('/diagnostic').send({});
    const runId = start.body.runId;
    await agent
      .post(`/diagnostic/${runId}/answer`)
      .send({ responseId: start.body.item.responseId, picked: null });
    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    const item = nxt.body.next;
    expect(item.section).toBe('listening');
    expect(item.audioUrl).toBe('/topik/audio/555104/2');
    expect(item.audioStartMs).toBe(3_000);
    expect(item.audioEndMs).toBe(11_000);

    const served = await pg.pool.query<{ source_ref: string }>(
      `SELECT source_ref FROM diagnostic_responses WHERE run_id = $1 AND section = 'listening'`,
      [runId],
    );
    expect(served.rows[0]?.source_ref).toBe(String(itemId));
  });

  // The counterpart negative case — a placeholder stem alone does not
  // re-admit a row; it must ALSO clear the audio-playability gate — is
  // covered by the B-038 describe block above
  // ('a no-transcript placeholder item with NO mapped audio is never
  // served'), which seeds the identical placeholder stem with no audio span.
});

describe('GET /diagnostic/trajectory', () => {
  it('returns snapshot history oldest→newest as 0-100 scores', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 4, listening: 5 });
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 5, grammar: 6 });

    const res = await agent.get('/diagnostic/trajectory');
    expect(res.status).toBe(200);
    expect(res.body.points.length).toBe(2);
    // reading 4 → 55, reading 5 → 70 (anchors).
    expect(res.body.points[0].reading).toBe(55);
    expect(res.body.points[1].reading).toBe(70);
    expect(res.body.points[1].grammar).toBe(85);
  });
});

describe('GET /diagnostic/history (F-010)', () => {
  it('returns 200 with snapshots:[] when the user has no runs', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.get('/diagnostic/history');
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toEqual([]);
  });

  it('returns every snapshot oldest→newest in the /latest DTO shape + capturedAt', async () => {
    const { agent, userId } = await registerUser(t.app, pg.pool);
    // Seeded sequentially, so captured_at (default now()) orders them; the
    // scores make the order observable (reading 4 → 55, reading 5 → 70).
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 4, listening: 5 });
    await seedDiagnosticSnapshot(pg.pool, userId, { reading: 5, grammar: 6 });

    const res = await agent.get('/diagnostic/history');
    expect(res.status).toBe(200);
    const snapshots = res.body.snapshots as Array<{
      capturedAt: string;
      dimensions: Array<{ key: string; label: string; kr: string; score: number; note: string }>;
      references: unknown[];
      defaultRef: string;
      goals: unknown[];
    }>;
    expect(snapshots.length).toBe(2);

    // Oldest first: attempt #1 carries reading 55, attempt #2 reading 70.
    const first = snapshots[0]!;
    const second = snapshots[1]!;
    expect(first.dimensions.find((d) => d.key === 'reading')?.score).toBe(55);
    expect(second.dimensions.find((d) => d.key === 'reading')?.score).toBe(70);
    expect(second.dimensions.find((d) => d.key === 'grammar')?.score).toBe(85);
    expect(new Date(first.capturedAt).getTime()).toBeLessThanOrEqual(
      new Date(second.capturedAt).getTime(),
    );

    // Each entry is the exact /latest SnapshotDTO shape plus capturedAt.
    expect(typeof first.capturedAt).toBe('string');
    expect(Number.isNaN(new Date(first.capturedAt).getTime())).toBe(false);
    const reading = first.dimensions.find((d) => d.key === 'reading')!;
    expect(reading.label).toBe('Reading');
    expect(reading.kr).toBe('읽기');
    expect(typeof reading.note).toBe('string');
    expect(Array.isArray(first.references)).toBe(true);
    expect(first.references.length).toBeGreaterThan(0);
    expect(first.defaultRef).toBe('L4');
    expect(Array.isArray(first.goals)).toBe(true);
  });

  it("is user-scoped — one user never sees another user's snapshots", async () => {
    const a = await registerUser(t.app, pg.pool);
    await seedDiagnosticSnapshot(pg.pool, a.userId, { reading: 5, vocab: 4 });

    // B has no history of their own: empty, NOT A's rows (IDOR/BOLA check).
    const b = await registerUser(t.app, pg.pool);
    const bRes = await b.agent.get('/diagnostic/history');
    expect(bRes.status).toBe(200);
    expect(bRes.body.snapshots).toEqual([]);

    // A still sees exactly their own — proves the isolation isn't blanket-empty.
    const aRes = await a.agent.get('/diagnostic/history');
    expect(aRes.status).toBe(200);
    expect(aRes.body.snapshots.length).toBe(1);
    expect(aRes.body.snapshots[0].dimensions.length).toBe(2);
  });
});
