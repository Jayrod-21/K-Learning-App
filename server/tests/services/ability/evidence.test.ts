/**
 * evidence — ability-evidence read API against real Postgres (F-212 P1).
 *
 * Bar §"Testing": real Postgres via testcontainers — the whole point of
 * `getAbilityEvidence` is the `ability_evidence` view's UNION ALL projection
 * (migration 084), so only a real engine running the real migration chain
 * proves the read: user-scoping, newest-first ordering, dimension/since/limit
 * filtering, the writing default-exclusion, and the rollup's difficulty
 * coverage counters.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../../helpers/pg.js';
import { setPoolForTesting } from '../../../src/db/pool.js';
import {
  getAbilityEvidence,
  getAbilityRollup,
} from '../../../src/services/ability/evidence.js';

let pg: PgHandle;

const FAKE_HASH = `$argon2id$${'x'.repeat(70)}`;

beforeAll(async () => {
  pg = await startPostgres();
  setPoolForTesting(pg.pool);
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  // ability_evidence is a view over these logs — truncating the bases (and
  // users, cascading the rest) resets it.
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

/** A scored grammar drill at an exact instant — the b-less evidence source. */
async function seedDrill(userId: number, scoredAt: string, score = 73): Promise<void> {
  await pg.pool.query(
    `INSERT INTO grammar_drill_attempts
        (user_id, pattern_key, pattern_display, drill_type, item,
         user_answer, score, verdict, scored_at)
     VALUES ($1, 'GR-f212-eo-yo', '-어요', 'transformation',
             '{"prompt":"바꾸세요"}'::jsonb, '했어요', $2, 'good', $3)`,
    [userId, score, scoredAt],
  );
}

/** A graded writing attempt (dimension 'writing', rubric-anchored b). */
async function seedWriting(userId: number, gradedAt: string): Promise<void> {
  await pg.pool.query(
    `INSERT INTO writing_attempts
        (user_id, rubric, prompt_kr, sample, total_score, max_total, result, graded_at)
     VALUES ($1, 'topik_ii_54', '글을 쓰십시오.', '제 생각에는 그렇습니다.',
             42, 50, '{"overallComment":"좋아요"}'::jsonb, $2)`,
    [userId, gradedAt],
  );
}

/** An answered diagnostic listening item — the diff_served evidence source. */
async function seedDiagnostic(userId: number, answeredAt: string): Promise<void> {
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO diagnostic_runs (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  await pg.pool.query(
    `INSERT INTO diagnostic_responses
        (run_id, ordinal, section, source_kind, source_ref, difficulty,
         kind, item_payload, correct_answer, picked, is_correct, answered_at)
     VALUES ($1, 1, 'listening', 'topik', 'f212-ref', 3.50, 'audio-mc',
             '{"prompt":"들으세요"}'::jsonb, 'b', 'b', TRUE, $2)`,
    [rows[0]!.id, answeredAt],
  );
}

describe('getAbilityEvidence', () => {
  it('returns only the requesting user’s rows (tenant isolation)', async () => {
    const alice = await seedUser('ability-alice@example.com');
    const bob = await seedUser('ability-bob@example.com');
    await seedDrill(alice, '2026-08-01T09:00:00Z');
    await seedDiagnostic(alice, '2026-08-01T10:00:00Z');

    expect(await getAbilityEvidence(alice)).toHaveLength(2);
    expect(await getAbilityEvidence(bob)).toEqual([]);
  });

  it('orders newest-first and honors limit', async () => {
    const userId = await seedUser('ability-order@example.com');
    await seedDrill(userId, '2026-08-01T09:00:00Z', 10);
    await seedDrill(userId, '2026-08-03T09:00:00Z', 30);
    await seedDrill(userId, '2026-08-02T09:00:00Z', 20);

    const all = await getAbilityEvidence(userId);
    expect(all.map((row) => row.outcome)).toEqual([0.3, 0.2, 0.1]);

    const limited = await getAbilityEvidence(userId, { limit: 2 });
    expect(limited.map((row) => row.outcome)).toEqual([0.3, 0.2]);
  });

  it('rejects a non-positive / non-integer limit', async () => {
    const userId = await seedUser('ability-badlimit@example.com');
    await expect(getAbilityEvidence(userId, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(getAbilityEvidence(userId, { limit: 2.5 })).rejects.toThrow(RangeError);
  });

  it('filters by dimension and by since', async () => {
    const userId = await seedUser('ability-filter@example.com');
    await seedDrill(userId, '2026-08-01T09:00:00Z');
    await seedDiagnostic(userId, '2026-08-05T09:00:00Z');

    const grammarOnly = await getAbilityEvidence(userId, { dimension: 'grammar' });
    expect(grammarOnly).toHaveLength(1);
    expect(grammarOnly[0]!.source).toBe('grammar_drill');

    const recent = await getAbilityEvidence(userId, {
      since: new Date('2026-08-04T00:00:00Z'),
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]!.source).toBe('diagnostic');
  });

  it('excludes writing by default; includeWriting or an explicit dimension admits it', async () => {
    const userId = await seedUser('ability-writing@example.com');
    await seedDrill(userId, '2026-08-01T09:00:00Z');
    await seedWriting(userId, '2026-08-02T09:00:00Z');

    const defaults = await getAbilityEvidence(userId);
    expect(defaults.map((row) => row.dimension)).toEqual(['grammar']);

    const withWriting = await getAbilityEvidence(userId, { includeWriting: true });
    expect(withWriting.map((row) => row.dimension)).toEqual(['writing', 'grammar']);

    // An explicit dimension ask wins over the default exclusion.
    const explicit = await getAbilityEvidence(userId, { dimension: 'writing' });
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.itemKey).toBe('topik_ii_54');
  });

  it('normalizes rows end-to-end (outcome ratio, served-b passthrough, rubric anchor)', async () => {
    const userId = await seedUser('ability-normalized@example.com');
    await seedDrill(userId, '2026-08-01T09:00:00Z', 73);
    await seedDiagnostic(userId, '2026-08-02T09:00:00Z');
    await seedWriting(userId, '2026-08-03T09:00:00Z');

    const rows = await getAbilityEvidence(userId, { includeWriting: true });
    const bySource = new Map(rows.map((row) => [row.source, row]));

    const drill = bySource.get('grammar_drill')!;
    expect(drill.outcome).toBeCloseTo(0.73);
    expect(drill.b).toBeNull();

    const diagnostic = bySource.get('diagnostic')!;
    expect(diagnostic.outcome).toBe(1);
    expect(diagnostic.b).toBe(3.5);

    const writing = bySource.get('writing')!;
    expect(writing.outcome).toBeCloseTo(0.84);
    expect(writing.b).toBe(5.0);
  });
});

describe('getAbilityRollup', () => {
  it('emits the 4 diagnostic dimensions in order, empty dims zeroed', async () => {
    const userId = await seedUser('rollup-empty@example.com');

    const rollup = await getAbilityRollup(userId);
    expect(rollup.map((entry) => entry.dimension)).toEqual([
      'reading',
      'listening',
      'vocab',
      'grammar',
    ]);
    for (const entry of rollup) {
      expect(entry.nTotal).toBe(0);
      expect(entry.nWithDifficulty).toBe(0);
      expect(entry.meanOutcome).toBe(0);
      expect(entry.meanDifficulty).toBeNull();
      expect(entry.lastOccurredAt).toBeNull();
    }
  });

  it('counts difficulty coverage separately from totals', async () => {
    const userId = await seedUser('rollup-coverage@example.com');
    // grammar: two b-less drills; listening: one b-carrying diagnostic row.
    await seedDrill(userId, '2026-08-01T09:00:00Z', 60);
    await seedDrill(userId, '2026-08-02T09:00:00Z', 80);
    await seedDiagnostic(userId, '2026-08-03T09:00:00Z');

    const rollup = await getAbilityRollup(userId);
    const byDimension = new Map(rollup.map((entry) => [entry.dimension, entry]));

    const grammar = byDimension.get('grammar')!;
    expect(grammar.nTotal).toBe(2);
    expect(grammar.nWithDifficulty).toBe(0);
    expect(grammar.meanOutcome).toBeCloseTo(0.7);
    expect(grammar.meanDifficulty).toBeNull(); // all-null b → null, not 0
    expect(grammar.lastOccurredAt).toBe('2026-08-02T09:00:00.000Z');
    expect(grammar.bySource.grammar_drill).toBe(2);
    expect(grammar.bySource.fsrs).toBe(0);

    const listening = byDimension.get('listening')!;
    expect(listening.nTotal).toBe(1);
    expect(listening.nWithDifficulty).toBe(1);
    expect(listening.meanDifficulty).toBe(3.5);
    expect(listening.bySource.diagnostic).toBe(1);
  });

  it('appends writing iff includeWriting', async () => {
    const userId = await seedUser('rollup-writing@example.com');
    await seedWriting(userId, '2026-08-01T09:00:00Z');

    const withoutWriting = await getAbilityRollup(userId);
    expect(withoutWriting.map((entry) => entry.dimension)).not.toContain('writing');

    const withWriting = await getAbilityRollup(userId, { includeWriting: true });
    expect(withWriting.map((entry) => entry.dimension)).toEqual([
      'reading',
      'listening',
      'vocab',
      'grammar',
      'writing',
    ]);
    const writing = withWriting[4]!;
    expect(writing.nTotal).toBe(1);
    expect(writing.meanOutcome).toBeCloseTo(0.84);
    expect(writing.meanDifficulty).toBe(5.0);
  });
});
