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
import { setClaudeProxy } from '../../src/services/claudeProxy.js';
import {
  registerUser,
  seedTopikItem,
  seedVocabEntry,
  seedKgiuEntry,
  seedDiagnosticSnapshot,
} from '../helpers/seed.js';
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
  await pg.pool.query(
    `TRUNCATE TABLE diagnostic_responses, diagnostic_runs, diagnostic_snapshots,
                     sessions, users
     RESTART IDENTITY CASCADE`,
  );
  // topik_items / topik_tests / vocab_entries / kgiu_entries: clear per-test so
  // each scenario controls exactly what is selectable. corpus_sources is left
  // alone (idempotent seeding).
  await pg.pool.query(`TRUNCATE TABLE topik_items, topik_tests CASCADE`);
  await pg.pool.query(`DELETE FROM vocab_entries`);
  await pg.pool.query(`DELETE FROM kgiu_entries`);
  resetLimiters();
});

/** Seed a corpus rich enough to serve a full 16-item diagnostic
 *  (ITEMS_PER_DIMENSION = 4 → 4 reading + 4 listening topik rows needed;
 *  one spare each for slack against the already-served exclusion). */
async function seedFullPool(): Promise<void> {
  // 5 reading + 5 listening at L4 (answer index 1 → choice 'a').
  for (let i = 0; i < 5; i += 1) {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
    await seedTopikItem(pg.pool, { section: 'listening', proficiency: 'L4', answer: 1 });
  }
  // vocab + grammar seeds for the Claude stub's seed-picker queries.
  await seedVocabEntry(pg.pool, { proficiency: 'L4', korean: '단어' });
  await seedVocabEntry(pg.pool, { proficiency: 'L3', korean: '낱말' });
  await seedKgiuEntry(pg.pool, { proficiency: 'L4', pattern: '-는 바람에' });
  await seedKgiuEntry(pg.pool, { proficiency: 'L3', pattern: '-기 마련이다' });
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
    expect(res.body.progress).toEqual({ ordinal: 1, total: 16 });

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
    expect(res.body.progress).toEqual({ ordinal: 1, total: 16 });

    const nxt = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(nxt.status).toBe(200);
    expect(nxt.body.next).not.toBeNull();
    expect(nxt.body.next.section).toBe('listening'); // schedule[1]
    expect(nxt.body.progress).toEqual({ ordinal: 2, total: 16 });
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

    // θ after one correct answer at SEED_THETA (4.0), step n=1 (1.0) → 5.0.
    const thetaAfterFirst = await pg.pool.query<{ ability_estimate: string }>(
      `SELECT ability_estimate::text AS ability_estimate
         FROM diagnostic_runs WHERE id = $1`,
      [runId],
    );
    expect(Number(thetaAfterFirst.rows[0]?.ability_estimate)).toBeCloseTo(5.0);

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
    expect(Number(thetaAfterReplay.rows[0]?.ability_estimate)).toBeCloseTo(5.0);

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
    // The full 16-slot schedule was servable, so the final grade says done and
    // points progress at the last ordinal.
    expect(lastAnswer?.done).toBe(true);
    expect(lastAnswer?.progress).toEqual({ ordinal: 16, total: 16 });
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

  it('produces a 4-dimension snapshot (writing omitted) and is idempotent', async () => {
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
    expect(keys).toEqual(['grammar', 'listening', 'reading', 'vocab']);
    // No writing dimension (deferred to Pass 8).
    expect(keys).not.toContain('writing');
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

    // Exact reading/listening result: the topik dimensions are seeded at L4
    // (difficulty 4) and answered all-correct (4/4), so estimateForDimension =
    // base(4) + ESTIMATE_SPREAD·(1 − 0.5) = 4.75, and estimateToScore(4.75) =
    // 66. The band: pTilde = 6/8, margin = 1.5·√(0.75·0.25/8) ≈ 0.2296 in
    // estimate units → scores 63..70. This pins the route↔scoring wiring, not
    // just a range. (Vocab/grammar difficulty tracks the θ staircase and the
    // band anchors, so those are not asserted exactly here.)
    const reading = dims.find((d) => d.key === 'reading');
    const listening = dims.find((d) => d.key === 'listening');
    expect(reading?.score).toBe(66);
    expect(listening?.score).toBe(66);
    expect(reading?.scoreLow).toBe(63);
    expect(reading?.scoreHigh).toBe(70);
    expect(listening?.scoreLow).toBe(63);
    expect(listening?.scoreHigh).toBe(70);

    // The band evidence is persisted in the snapshot's JSONB (rubric v1.1.0):
    // per-dimension { n, correct, estimate, score, scoreLow, scoreHigh } that
    // /latest and /history rebuild the DTO band from.
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
          }
        >;
      };
    }>(
      `SELECT rubric_version, evidence FROM diagnostic_snapshots WHERE user_id = $1`,
      [userId],
    );
    expect(snapRow.rows[0]?.rubric_version).toBe('v1.1.0');
    const stats = snapRow.rows[0]?.evidence.dimensionStats;
    expect(stats).toBeDefined();
    expect(Object.keys(stats!).sort()).toEqual(['grammar', 'listening', 'reading', 'vocab']);
    expect(stats!['reading']).toEqual({
      n: 4,
      correct: 4,
      estimate: 4.75,
      score: 66,
      scoreLow: 63,
      scoreHigh: 70,
    });

    // /latest rebuilds the SAME band from evidence.dimensionStats.
    const latestAfterFinish = await agent.get('/diagnostic/latest');
    expect(latestAfterFinish.status).toBe(200);
    const latestReading = (latestAfterFinish.body.dimensions as typeof dims).find(
      (d) => d.key === 'reading',
    );
    expect(latestReading?.score).toBe(66);
    expect(latestReading?.scoreLow).toBe(63);
    expect(latestReading?.scoreHigh).toBe(70);

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

    // /latest now returns the populated snapshot.
    const latest = await agent.get('/diagnostic/latest');
    expect(latest.status).toBe(200);
    expect((latest.body.dimensions as unknown[]).length).toBe(4);
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
    // reading/listening are seeded at fixed difficulty, so the comparison is
    // apples-to-apples: all-correct est 4.75 → 66; all-wrong est
    // 4 − 0.75 = 3.25 → 44.
    expect(score(wrongRun.snapshot, 'reading')).toBe(44);
    expect(score(wrongRun.snapshot, 'listening')).toBe(44);
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
    // empty reading/listening pools end the run early: /next returns null
    // before the full 8-slot schedule is used.
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
    expect(keys.sort()).toEqual(['grammar', 'vocab']);
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
