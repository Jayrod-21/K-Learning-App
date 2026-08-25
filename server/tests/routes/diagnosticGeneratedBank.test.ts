/**
 * F-220 slice 1 — DIAGNOSTIC_USE_GENERATED_BANK wiring regression tests.
 *
 * Separate from the (already 3000+ line) tests/routes/diagnostic.test.ts so
 * this specific default-off guarantee stays easy to find and doesn't grow
 * that file further. Real Postgres via testcontainers (full migration chain,
 * including migration 101's `generated_items`), the stub Claude proxy for
 * the live-generation path.
 *
 * WHAT THIS PROVES:
 *   1. Flag OFF (the default) — even with an APPROVED bank item seeded for
 *      every (section, level) cell the run could possibly draw, every
 *      vocab/grammar response is still served by the LIVE generation path
 *      (`source_ref` is a vocab_entries/kgiu_entries id, never `bank:*`).
 *      This is the byte-identical-until-an-operator-opts-in guarantee.
 *   2. Flag ON + an approved bank item for every cell — every vocab/grammar
 *      response is served FROM THE BANK (`source_ref` starts with `bank:`),
 *      and the stub Claude proxy's `generateDiagnosticItem` is configured to
 *      THROW on any call: the run completing successfully is itself the
 *      proof that live generation was never invoked for a cell the bank
 *      covers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { buildTestApp, makeStubProxy, teardownTestApp, type TestApp } from '../helpers/app.js';
import { setClaudeProxy } from '../../src/services/claudeProxy.js';
import { _setConfigForTesting } from '../../src/config/index.js';
import { WEIGHTS } from '../../src/routes/diagnostic.js';
import {
  registerUser,
  seedTopikItem,
  seedVocabEntry,
  seedKgiuEntry,
  seedHanjaCharacter,
  type RegisteredAgent,
} from '../helpers/seed.js';
import { resetLimiters } from '../../src/middleware/rateLimits.js';

const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5+'] as const;

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
  await pg.pool.query(`TRUNCATE TABLE topik_items, topik_tests CASCADE`);
  await pg.pool.query(`DELETE FROM vocab_entries`);
  await pg.pool.query(`DELETE FROM kgiu_entries`);
  await pg.pool.query(`TRUNCATE TABLE hanja_characters CASCADE`);
  await pg.pool.query(`DELETE FROM generated_items`);
  resetLimiters();
});

afterEach(() => {
  // Every test in this file touches DIAGNOSTIC_USE_GENERATED_BANK — reset to
  // the documented default so a later file in the same worker never inherits
  // an override from here.
  _setConfigForTesting({ DIAGNOSTIC_USE_GENERATED_BANK: false });
});

/** Enough of a reading/listening/hanja pool for a full run to complete
 *  (mirrors diagnostic.test.ts's seedFullPool — this file only cares about
 *  the vocab/grammar draw path, so the other dimensions just need to not
 *  starve the schedule). */
async function seedNonGeneratedPools(): Promise<void> {
  for (let i = 0; i < WEIGHTS.reading + 1; i += 1) {
    await seedTopikItem(pg.pool, { section: 'reading', proficiency: 'L4', answer: 1 });
  }
  for (let i = 0; i < WEIGHTS.listening + 1; i += 1) {
    await seedTopikItem(pg.pool, {
      section: 'listening',
      proficiency: 'L4',
      answer: 1,
      audioStartMs: 0,
      audioEndMs: 5_000,
      audioPath: `bank-fixture-audio-${String(i)}.mp3`,
    });
  }
  const hanjaSeeds: ReadonlyArray<{ char: string; sound: string; glossEn: string; level: 'L2' | 'L3' }> = [
    { char: '學', sound: '학', glossEn: 'learn', level: 'L2' },
    { char: '校', sound: '교', glossEn: 'school', level: 'L2' },
    { char: '生', sound: '생', glossEn: 'life', level: 'L2' },
    { char: '大', sound: '대', glossEn: 'big', level: 'L2' },
    { char: '水', sound: '수', glossEn: 'water', level: 'L3' },
    { char: '火', sound: '화', glossEn: 'fire', level: 'L3' },
    { char: '木', sound: '목', glossEn: 'tree', level: 'L3' },
    { char: '金', sound: '금', glossEn: 'gold', level: 'L3' },
  ];
  for (const h of hanjaSeeds) await seedHanjaCharacter(pg.pool, h);
}

/** Live-path seeds so the flag-OFF scenario can genuinely exercise
 *  generation (not just skip every vocab/grammar ordinal for want of a
 *  seed). */
async function seedLiveGenerationSeeds(): Promise<void> {
  for (const level of ['basic', 'L3', 'L4', 'L5+'] as const) {
    await seedVocabEntry(pg.pool, { proficiency: level, korean: `단어-${level}` });
    await seedKgiuEntry(pg.pool, { proficiency: level, pattern: `-패턴-${level}` });
  }
}

let fakeHashSeq = 0;
function fakeHash(): string {
  fakeHashSeq += 1;
  return `${fakeHashSeq.toString(16).padStart(8, '0')}${'a'.repeat(56)}`;
}

/** One APPROVED generated_items row for (section, level). */
async function seedApprovedBankItem(
  section: 'vocab' | 'grammar',
  level: (typeof LEVELS)[number],
): Promise<number> {
  const kind = section === 'grammar' ? 'pattern' : 'synonym';
  const choices = JSON.stringify([
    { kr: `은행-정답-${section}-${level}`, en: '' },
    { kr: '오답1', en: '' },
    { kr: '오답2', en: '' },
    { kr: '오답3', en: '' },
  ]);
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_items
       (section, level, kind, stem, choices, answer_index, explain, source_ref,
        status, created_by, model_id, prompt_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'mock explain', 'test-seed',
             'approved', 'test-fixture', 'claude-sonnet-4-6', $6)
     RETURNING id`,
    [section, level, kind, `mock ${section} bank stem (${level})`, choices, fakeHash()],
  );
  return Number(rows[0]!.id);
}

async function seedApprovedBankForEveryCell(): Promise<void> {
  for (const level of LEVELS) {
    await seedApprovedBankItem('vocab', level);
    await seedApprovedBankItem('grammar', level);
  }
}

/** One APPROVED generated_items READING row (F-220 slice 2) for `level` —
 *  kind='passage-mc', carries a non-null passage. Mirrors
 *  `seedApprovedBankItem` but for the reading section. */
async function seedApprovedReadingBankItem(level: (typeof LEVELS)[number]): Promise<number> {
  const choices = JSON.stringify([
    { kr: `은행-정답-reading-${level}`, en: '' },
    { kr: '오답1', en: '' },
    { kr: '오답2', en: '' },
    { kr: '오답3', en: '' },
  ]);
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_items
       (section, level, kind, stem, passage, choices, answer_index, explain, source_ref,
        status, created_by, model_id, prompt_hash)
     VALUES ('reading', $1, 'passage-mc', $2, $3, $4::jsonb, 0, 'mock explain', 'test-seed',
             'approved', 'test-fixture', 'claude-sonnet-4-6', $5)
     RETURNING id`,
    [level, `mock reading bank stem (${level})`, `mock reading bank passage (${level}).`, choices, fakeHash()],
  );
  return Number(rows[0]!.id);
}

async function seedApprovedReadingBankForEveryCell(): Promise<void> {
  for (const level of LEVELS) {
    await seedApprovedReadingBankItem(level);
  }
}

/** Drive a run to completion, skipping every item (mirrors
 *  diagnostic.test.ts's runAllSkip). */
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
    const next = await agent.post(`/diagnostic/${runId}/next`).send({});
    expect(next.status).toBe(200);
    current = next.body.next;
  }
  return runId;
}

describe('F-220 DIAGNOSTIC_USE_GENERATED_BANK', () => {
  it('flag OFF (default): live generation is used even with an approved bank covering every cell', async () => {
    await seedNonGeneratedPools();
    await seedLiveGenerationSeeds();
    await seedApprovedBankForEveryCell();
    setClaudeProxy(makeStubProxy());
    _setConfigForTesting({ DIAGNOSTIC_USE_GENERATED_BANK: false });

    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await runAllSkip(agent);

    const rows = await pg.pool.query<{ section: string; source_ref: string | null }>(
      `SELECT section, source_ref FROM diagnostic_responses
        WHERE run_id = $1 AND source_kind = 'generated' AND section IN ('vocab', 'grammar')`,
      [runId],
    );
    // At least the vocab+grammar schedule slots got a seed (seedLiveGenerationSeeds
    // covers every band buildGeneratedItem can request).
    expect(rows.rows.length).toBeGreaterThanOrEqual(WEIGHTS.vocab + WEIGHTS.grammar);
    for (const row of rows.rows) {
      expect(row.source_ref).not.toBeNull();
      expect(row.source_ref).not.toMatch(/^bank:/);
    }
  });

  it('flag ON + approved bank for every cell: every generated item is served from the bank, live Claude is never called', async () => {
    await seedNonGeneratedPools();
    // Deliberately do NOT seed vocab_entries/kgiu_entries — if the draw path
    // ever silently fell through to live generation, pickVocabSeed/
    // pickGrammarSeed would find nothing and the ordinal would be null
    // (source_kind='generated' rows would fall short of WEIGHTS.vocab +
    // WEIGHTS.grammar), catching a regression even without the throwing stub.
    await seedApprovedBankForEveryCell();
    setClaudeProxy(
      makeStubProxy({
        generateDiagnosticItem: () => {
          throw new Error('live Claude generation must never be called when the bank covers every cell');
        },
      }),
    );
    _setConfigForTesting({ DIAGNOSTIC_USE_GENERATED_BANK: true });

    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await runAllSkip(agent);

    const rows = await pg.pool.query<{ section: string; source_ref: string | null }>(
      `SELECT section, source_ref FROM diagnostic_responses
        WHERE run_id = $1 AND source_kind = 'generated' AND section IN ('vocab', 'grammar')`,
      [runId],
    );
    expect(rows.rows.length).toBe(WEIGHTS.vocab + WEIGHTS.grammar);
    for (const row of rows.rows) {
      expect(row.source_ref).toMatch(/^bank:\d+$/);
    }
  });
});

describe('F-220 slice 2 DIAGNOSTIC_USE_GENERATED_BANK — reading', () => {
  it('flag OFF (default): reading is served from topik even with an approved reading bank covering every level', async () => {
    await seedNonGeneratedPools();
    await seedLiveGenerationSeeds();
    await seedApprovedReadingBankForEveryCell();
    setClaudeProxy(makeStubProxy());
    _setConfigForTesting({ DIAGNOSTIC_USE_GENERATED_BANK: false });

    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await runAllSkip(agent);

    const rows = await pg.pool.query<{ source_kind: string; source_ref: string | null }>(
      `SELECT source_kind, source_ref FROM diagnostic_responses
        WHERE run_id = $1 AND section = 'reading'`,
      [runId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(WEIGHTS.reading);
    for (const row of rows.rows) {
      // Byte-identical-until-opt-in: still the live topik path, never the bank.
      expect(row.source_kind).toBe('topik');
      expect(row.source_ref).not.toMatch(/^bank:/);
    }
  });

  it('flag ON + approved reading bank for every level: reading is served from the bank; the topik pool is never touched even though it exists', async () => {
    await seedNonGeneratedPools(); // still seeds a real topik reading pool
    await seedLiveGenerationSeeds();
    await seedApprovedReadingBankForEveryCell();
    setClaudeProxy(makeStubProxy());
    _setConfigForTesting({ DIAGNOSTIC_USE_GENERATED_BANK: true });

    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await runAllSkip(agent);

    const rows = await pg.pool.query<{ source_kind: string; source_ref: string | null }>(
      `SELECT source_kind, source_ref FROM diagnostic_responses
        WHERE run_id = $1 AND section = 'reading'`,
      [runId],
    );
    expect(rows.rows.length).toBe(WEIGHTS.reading);
    for (const row of rows.rows) {
      expect(row.source_kind).toBe('generated');
      expect(row.source_ref).toMatch(/^bank:\d+$/);
    }
  });

  it('flag ON but the reading bank is EMPTY for a level: falls through to the live topik path for that level (never null-skips reading)', async () => {
    await seedNonGeneratedPools();
    await seedLiveGenerationSeeds();
    // Deliberately do NOT seed any reading bank rows.
    setClaudeProxy(makeStubProxy());
    _setConfigForTesting({ DIAGNOSTIC_USE_GENERATED_BANK: true });

    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await runAllSkip(agent);

    const rows = await pg.pool.query<{ source_kind: string }>(
      `SELECT source_kind FROM diagnostic_responses WHERE run_id = $1 AND section = 'reading'`,
      [runId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(WEIGHTS.reading);
    for (const row of rows.rows) {
      expect(row.source_kind).toBe('topik');
    }
  });

  it('flag ON: LISTENING is completely untouched — still served from topik even with the reading bank full', async () => {
    await seedNonGeneratedPools();
    await seedLiveGenerationSeeds();
    await seedApprovedReadingBankForEveryCell();
    setClaudeProxy(makeStubProxy());
    _setConfigForTesting({ DIAGNOSTIC_USE_GENERATED_BANK: true });

    const { agent } = await registerUser(t.app, pg.pool);
    const runId = await runAllSkip(agent);

    const rows = await pg.pool.query<{ source_kind: string }>(
      `SELECT source_kind FROM diagnostic_responses WHERE run_id = $1 AND section = 'listening'`,
      [runId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(WEIGHTS.listening);
    for (const row of rows.rows) {
      expect(row.source_kind).toBe('topik');
    }
  });
});
