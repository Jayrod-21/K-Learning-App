/**
 * F-220 P3 — the generated-bank MOCK-EXAM surface's 3 flag-gated routes:
 *   POST /topik/mock/generated             (assemble / resume)
 *   PUT  /topik/mock/generated/:id         (save progress)
 *   POST /topik/mock/generated/:id/submit  (server-graded scoring)
 *
 * Real Postgres via testcontainers (full migration chain, including
 * migration 107's `generated_mock_attempts`). Separate from the
 * (already 3000+ line) tests/routes/topik.test.ts — mirrors
 * diagnosticGeneratedBank.test.ts's own-file posture for the same reason.
 *
 * WHAT THIS PROVES:
 *   1. Flag OFF (the default) — every one of the 3 routes 404s, and the
 *      REAL /topik/mock + /topik/mock/submit stay completely unaffected
 *      (regression: they still work normally with the flag off).
 *   2. Flag ON — assemble creates an attempt + returns answer-stripped
 *      items; a second assemble call for the SAME (tier, section) resumes
 *      the SAME attempt rather than creating a second one; PUT saves
 *      progress (IDOR-safe: another user's attempt id 404s); submit grades
 *      server-side from the STORED snapshot (never a client 'correct'),
 *      persists the completed row, and a second submit 404s (no
 *      double-grading / no resurrecting a completed attempt).
 *   3. NO-LEAK — a served listening item carries `audioUrl` only, never a
 *      transcript/turns field, on the assemble response AND the DB row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, teardownTestApp, type TestApp } from '../helpers/app.js';
import { registerUser } from '../helpers/seed.js';
import { _setConfigForTesting } from '../../src/config/index.js';
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
  // users CASCADE clears generated_mock_attempts (user FK) + topik_responses/
  // topik_attempts + audio_sources/audio_tracks (the listening-fixture
  // owner) + generated_items has no user FK — cleared explicitly.
  await pg.pool.query('TRUNCATE TABLE topik_responses, topik_attempts, sessions, users RESTART IDENTITY CASCADE');
  await pg.pool.query('TRUNCATE TABLE topik_items, topik_tests CASCADE');
  await pg.pool.query('DELETE FROM generated_items');
  // The users truncation above cascades away the cached fixture owner
  // (audio_sources FK) — reset the cache so seedAudioTrack recreates it
  // fresh on the NEXT call rather than reusing a now-deleted id.
  listeningFixtureUserId = null;
  resetLimiters();
});

afterEach(() => {
  // Every test in this file touches TOPIK_MOCK_USE_GENERATED_BANK — reset to
  // the documented default so a later file in the same worker never inherits
  // an override (mirrors diagnosticGeneratedBank.test.ts's identical guard).
  _setConfigForTesting({ TOPIK_MOCK_USE_GENERATED_BANK: false });
});

let hashSeq = 0;
function nextHash(): string {
  hashSeq += 1;
  return `${hashSeq.toString(16).padStart(8, '0')}${'d'.repeat(56)}`;
}

async function insertItem(overrides: {
  section?: 'reading' | 'listening';
  level?: string;
  kind?: string;
  audioSourceId?: number | null;
  audioStartMs?: number | null;
  audioEndMs?: number | null;
  turns?: readonly { speaker: string; gender: string; text: string }[] | null;
}): Promise<number> {
  const section = overrides.section ?? 'listening';
  const kind = overrides.kind ?? (section === 'reading' ? 'passage-mc' : 'whats-next');
  const choices = [{ kr: '정답' }, { kr: '오답1' }, { kr: '오답2' }, { kr: '오답3' }];
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_items
       (section, level, kind, stem, passage, choices, answer_index, explain, source_ref,
        status, created_by, model_id, prompt_hash, audio_source_id, audio_start_ms, audio_end_ms, turns)
     VALUES ($1, $2, $3, 'stem text', $4, $5::jsonb, 0, 'explain text', 'test-seed-ref',
             'approved', 'test-fixture', 'claude-sonnet-4-6', $6, $7, $8, $9, $10::jsonb)
     RETURNING id`,
    [
      section,
      overrides.level ?? 'L4',
      kind,
      section === 'reading' ? '지문' : null,
      JSON.stringify(choices),
      nextHash(),
      overrides.audioSourceId ?? null,
      overrides.audioStartMs ?? null,
      overrides.audioEndMs ?? null,
      overrides.turns !== undefined ? JSON.stringify(overrides.turns) : null,
    ],
  );
  return Number(rows[0]!.id);
}

let listeningFixtureUserId: number | null = null;
let audioSlugSeq = 0;

async function seedAudioTrack(opts: { durationMs?: number } = {}): Promise<{ sourceId: number; trackId: number }> {
  if (listeningFixtureUserId === null) {
    const { rows } = await pg.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('route-mock-fixture@test.dev', '$argon2id$' || repeat('x', 70))
       RETURNING id`,
    );
    listeningFixtureUserId = Number(rows[0]!.id);
  }
  audioSlugSeq += 1;
  const src = await pg.pool.query<{ id: string }>(
    `INSERT INTO audio_sources (user_id, slug, title, kind, status, is_shared)
     VALUES ($1, $2, 'route mock listening audio', 'generated_listening', 'ready', true)
     RETURNING id`,
    [listeningFixtureUserId, `route-mock-listening-${String(audioSlugSeq)}`],
  );
  const sourceId = Number(src.rows[0]!.id);
  const trk = await pg.pool.query<{ id: string }>(
    `INSERT INTO audio_tracks (source_id, user_id, track_number, title, blob_ref, byte_size, duration_ms, transcript_status)
     VALUES ($1, $2, 1, 'mock', $3, 100, $4, 'done')
     RETURNING id`,
    [sourceId, listeningFixtureUserId, `${String(listeningFixtureUserId)}/route-mock-${String(audioSlugSeq)}.mp3`, opts.durationMs ?? 5000],
  );
  return { sourceId, trackId: Number(trk.rows[0]!.id) };
}

/** Fund every kind slot in TOPIK II's listening blueprint with one approved,
 *  audio-ready row each, plus one 2-question paired-audio-mc group — enough
 *  for a real, non-empty assembled section across every test in this file
 *  that needs one. */
async function seedTierIIListeningBank(): Promise<void> {
  const singleKinds = ['whats-next', 'audio-mc'];
  for (const kind of singleKinds) {
    for (let i = 0; i < 6; i += 1) {
      const { sourceId } = await seedAudioTrack();
      await insertItem({
        section: 'listening',
        level: 'L4',
        kind,
        audioSourceId: sourceId,
        audioStartMs: 0,
        audioEndMs: 5000,
      });
    }
  }
  const { sourceId } = await seedAudioTrack({ durationMs: 8000 });
  await pg.pool.query(
    `INSERT INTO generated_items
       (section, level, kind, stem, choices, answer_index, explain, source_ref,
        status, created_by, model_id, prompt_hash, audio_source_id, audio_start_ms, audio_end_ms,
        stimulus_group_id, stimulus_group_ordinal, turns)
     VALUES
       ('listening', 'L4', 'paired-audio-mc', 'q1', $1::jsonb, 0, 'e1', 'seed',
        'approved', 'test-fixture', 'claude-sonnet-4-6', $2, $3, 0, 8000, 'route-seed-grp', 1, $4::jsonb),
       ('listening', 'L4', 'paired-audio-mc', 'q2', $1::jsonb, 0, 'e2', 'seed',
        'approved', 'test-fixture', 'claude-sonnet-4-6', $5, $3, 0, 8000, 'route-seed-grp', 2, $4::jsonb)`,
    [
      JSON.stringify([{ kr: '정답' }, { kr: '오답1' }, { kr: '오답2' }, { kr: '오답3' }]),
      nextHash(),
      sourceId,
      JSON.stringify([{ speaker: 'narrator', gender: 'narrator', text: 'SEED TRANSCRIPT — must never reach the client' }]),
      nextHash(),
    ],
  );
}

describe('generated mock surface — flag OFF (default): all 3 routes 404, real /mock untouched', () => {
  it('POST /topik/mock/generated 404s when the flag is off', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    expect(res.status).toBe(404);
  });

  it('PUT /topik/mock/generated/:id 404s when the flag is off', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/topik/mock/generated/1')
      .send({ currentIndex: 0, picks: {}, remainingMs: 1000 });
    expect(res.status).toBe(404);
  });

  it('POST /topik/mock/generated/:id/submit 404s when the flag is off', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock/generated/1/submit').send({});
    expect(res.status).toBe(404);
  });

  it('the REAL /topik/mock stays byte-identical (empty pool → items:[] like always) with the flag off', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock').send({ section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sourceTest: null,
      topikLevel: null,
      section: 'reading',
      audioUrl: null,
      items: [],
    });
  });
});

describe('POST /topik/mock/generated — assemble + resume (flag ON)', () => {
  beforeEach(() => {
    _setConfigForTesting({ TOPIK_MOCK_USE_GENERATED_BANK: true });
  });

  it('requires auth', async () => {
    const r = await request(t.app).post('/topik/mock/generated').send({ tier: 'II', section: 'reading' });
    expect(r.status).toBe(401);
  });

  it('a thin/empty bank is a valid 200 with items:[] and NO attempt row created', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body.attemptId).toBeNull();
    expect(res.body.items).toEqual([]);
    expect(res.body.requestedCount).toBeGreaterThan(0);

    const { rows } = await pg.pool.query('SELECT count(*)::int AS n FROM generated_mock_attempts');
    expect(rows[0].n).toBe(0);
  });

  it('assembles a non-empty section, answer-stripped, and persists a snapshot attempt row', async () => {
    await seedTierIIListeningBank();
    const { agent, userId } = await registerUser(t.app, pg.pool);

    const res = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(false);
    expect(res.body.attemptId).not.toBeNull();
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.currentIndex).toBe(0);
    expect(res.body.picks).toEqual({});

    // Answer-strip, type-level AND on the wire: no item carries correctChoiceId/explanation.
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty('correctChoiceId');
      expect(item).not.toHaveProperty('explanation');
      expect(typeof item.id).toBe('string');
      expect(Array.isArray(item.choices)).toBe(true);
    }

    // NO-LEAK: every listening item on the wire carries audioUrl, never a
    // transcript/turns field, and the SEED TRANSCRIPT text never appears
    // anywhere in the response body.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('SEED TRANSCRIPT');
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty('turns');
      if (item.audioUrl !== undefined) {
        expect(typeof item.audioUrl).toBe('string');
      }
    }

    // The persisted row's server-side snapshot has the answers (server-only,
    // never shipped) AND still no transcript anywhere.
    const { rows } = await pg.pool.query(
      'SELECT user_id, tier, section, status, item_set FROM generated_mock_attempts WHERE id = $1',
      [res.body.attemptId],
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].user_id)).toBe(String(userId));
    expect(rows[0].tier).toBe('II');
    expect(rows[0].section).toBe('listening');
    expect(rows[0].status).toBe('in_progress');
    expect(JSON.stringify(rows[0].item_set)).not.toContain('SEED TRANSCRIPT');
    for (const snapItem of rows[0].item_set) {
      expect(typeof snapItem.correctChoiceId).toBe('string');
    }
  });

  it('a second assemble call for the SAME (tier, section) RESUMES the existing attempt, not a fresh draw', async () => {
    await seedTierIIListeningBank();
    const { agent } = await registerUser(t.app, pg.pool);

    const first = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    expect(first.status).toBe(200);
    const attemptId = first.body.attemptId;

    const second = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    expect(second.status).toBe(200);
    expect(second.body.resumed).toBe(true);
    expect(second.body.attemptId).toBe(attemptId);
    expect(second.body.items).toEqual(first.body.items);

    const { rows } = await pg.pool.query('SELECT count(*)::int AS n FROM generated_mock_attempts');
    expect(rows[0].n).toBe(1);
  });

  it('a DIFFERENT (tier, section) creates its OWN attempt — no cross-slot collision', async () => {
    await seedTierIIListeningBank();
    const { agent } = await registerUser(t.app, pg.pool);

    const listening = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    expect(listening.status).toBe(200);
    const reading = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'reading' });
    expect(reading.status).toBe(200); // thin bank on reading → items:[], attemptId: null — still 200, not an error

    const { rows } = await pg.pool.query('SELECT count(*)::int AS n FROM generated_mock_attempts');
    expect(rows[0].n).toBe(1); // only listening's row (reading's thin-bank draw created none)
  });
});

describe('PUT /topik/mock/generated/:id — save progress (flag ON)', () => {
  beforeEach(() => {
    _setConfigForTesting({ TOPIK_MOCK_USE_GENERATED_BANK: true });
  });

  it('saves currentIndex/picks/remainingMs onto the caller\'s own attempt', async () => {
    await seedTierIIListeningBank();
    const { agent } = await registerUser(t.app, pg.pool);
    const started = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    const attemptId = started.body.attemptId;
    const firstItemId = started.body.items[0].id;

    const save = await agent
      .put(`/topik/mock/generated/${attemptId}`)
      .send({ currentIndex: 1, picks: { [firstItemId]: 'a' }, remainingMs: 500_000 });
    expect(save.status).toBe(204);

    const { rows } = await pg.pool.query(
      'SELECT current_index, picks, remaining_ms FROM generated_mock_attempts WHERE id = $1',
      [attemptId],
    );
    expect(rows[0].current_index).toBe(1);
    expect(rows[0].picks).toEqual({ [firstItemId]: 'a' });
    expect(rows[0].remaining_ms).toBe(500_000);

    // A resumed assemble call echoes the saved progress back.
    const resumed = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    expect(resumed.body.currentIndex).toBe(1);
    expect(resumed.body.picks).toEqual({ [firstItemId]: 'a' });
    expect(resumed.body.remainingMs).toBe(500_000);
  });

  it('IDOR: another user\'s attempt id 404s, and their row is unaffected', async () => {
    await seedTierIIListeningBank();
    const a = await registerUser(t.app, pg.pool);
    const started = await a.agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    const attemptId = started.body.attemptId;

    const b = await registerUser(t.app, pg.pool);
    const attack = await b.agent
      .put(`/topik/mock/generated/${attemptId}`)
      .send({ currentIndex: 5, picks: {}, remainingMs: 1 });
    expect(attack.status).toBe(404);

    const { rows } = await pg.pool.query(
      'SELECT current_index FROM generated_mock_attempts WHERE id = $1',
      [attemptId],
    );
    expect(rows[0].current_index).toBe(0); // untouched by b's attempt
  });

  it('404s for a nonexistent attempt id', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent
      .put('/topik/mock/generated/999999')
      .send({ currentIndex: 0, picks: {}, remainingMs: 1000 });
    expect(res.status).toBe(404);
  });
});

describe('POST /topik/mock/generated/:id/submit — server-side grading (flag ON)', () => {
  beforeEach(() => {
    _setConfigForTesting({ TOPIK_MOCK_USE_GENERATED_BANK: true });
  });

  it('grades from the STORED snapshot, ignoring any client-asserted correctness, and persists the score', async () => {
    await seedTierIIListeningBank();
    const { agent } = await registerUser(t.app, pg.pool);
    const started = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    const attemptId = started.body.attemptId;
    const items: { id: string }[] = started.body.items;

    // Look up the SERVER's actual correct answers directly from the DB
    // snapshot (never trusted from the client wire, which never carries
    // them) so this test can construct a deterministic all-correct submit.
    const { rows } = await pg.pool.query(
      'SELECT item_set FROM generated_mock_attempts WHERE id = $1',
      [attemptId],
    );
    const snapshot: { id: string; correctChoiceId: string }[] = rows[0].item_set;
    const correctPicks: Record<string, string> = {};
    for (const it of snapshot) correctPicks[it.id] = it.correctChoiceId;

    // Deliberately answer the FIRST item WRONG (any choice that isn't the
    // correct one) to prove grading is server-computed, not a pass-through.
    const first = snapshot[0]!;
    const wrongChoice = (['a', 'b', 'c', 'd'] as const).find((c) => c !== first.correctChoiceId)!;
    const picks = { ...correctPicks, [first.id]: wrongChoice };

    const submit = await agent.post(`/topik/mock/generated/${attemptId}/submit`).send({ picks });
    expect(submit.status).toBe(200);
    expect(submit.body.totalItems).toBe(items.length);
    expect(submit.body.correct).toBe(items.length - 1); // exactly one wrong
    expect(submit.body.answered).toBe(items.length);
    expect(typeof submit.body.percentage).toBe('number');
    expect(typeof submit.body.band).toBe('string');

    const reveal = submit.body.items.find((r: { itemId: string }) => r.itemId === first.id);
    expect(reveal.isCorrect).toBe(false);
    expect(reveal.correctChoiceId).toBe(first.correctChoiceId);

    const { rows: after } = await pg.pool.query(
      'SELECT status, score_percentage, band, finished_at FROM generated_mock_attempts WHERE id = $1',
      [attemptId],
    );
    expect(after[0].status).toBe('completed');
    expect(after[0].score_percentage).not.toBeNull();
    expect(after[0].band).not.toBeNull();
    expect(after[0].finished_at).not.toBeNull();
  });

  it('an unanswered item grades as incorrect/skipped (picked: null), never crashes', async () => {
    await seedTierIIListeningBank();
    const { agent } = await registerUser(t.app, pg.pool);
    const started = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    const attemptId = started.body.attemptId;

    const submit = await agent.post(`/topik/mock/generated/${attemptId}/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.answered).toBe(0);
    expect(submit.body.correct).toBe(0);
    for (const r of submit.body.items) {
      expect(r.picked).toBeNull();
      expect(r.isCorrect).toBe(false);
    }
  });

  it('a second submit on the SAME attempt 404s — no double-grading, no resurrecting a completed sitting', async () => {
    await seedTierIIListeningBank();
    const { agent } = await registerUser(t.app, pg.pool);
    const started = await agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    const attemptId = started.body.attemptId;

    const first = await agent.post(`/topik/mock/generated/${attemptId}/submit`).send({});
    expect(first.status).toBe(200);
    const second = await agent.post(`/topik/mock/generated/${attemptId}/submit`).send({});
    expect(second.status).toBe(404);
  });

  it('IDOR: another user cannot submit against someone else\'s attempt id', async () => {
    await seedTierIIListeningBank();
    const a = await registerUser(t.app, pg.pool);
    const started = await a.agent.post('/topik/mock/generated').send({ tier: 'II', section: 'listening' });
    const attemptId = started.body.attemptId;

    const b = await registerUser(t.app, pg.pool);
    const attack = await b.agent.post(`/topik/mock/generated/${attemptId}/submit`).send({});
    expect(attack.status).toBe(404);

    const { rows } = await pg.pool.query(
      'SELECT status FROM generated_mock_attempts WHERE id = $1',
      [attemptId],
    );
    expect(rows[0].status).toBe('in_progress'); // untouched by b's attack
  });
});

describe('flag ON — the REAL /topik/mock + /mock/submit stay unaffected', () => {
  beforeEach(() => {
    _setConfigForTesting({ TOPIK_MOCK_USE_GENERATED_BANK: true });
  });

  it('POST /topik/mock still behaves identically with the generated flag on', async () => {
    const { agent } = await registerUser(t.app, pg.pool);
    const res = await agent.post('/topik/mock').send({ section: 'reading' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sourceTest: null,
      topikLevel: null,
      section: 'reading',
      audioUrl: null,
      items: [],
    });
  });
});
