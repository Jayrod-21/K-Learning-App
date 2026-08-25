/**
 * `pickGeneratedItem` (F-220 slice 1 draw path) — real Postgres via
 * testcontainers (full migration chain, including migration 101's
 * `generated_items`). Route-level wiring (the DIAGNOSTIC_USE_GENERATED_BANK
 * gate) is covered separately in
 * tests/routes/diagnosticGeneratedBank.test.ts; this file exercises
 * `pickGeneratedItem` directly against the table.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../../helpers/pg.js';
import type { Querier } from '../../../src/db/pool.js';
import { pickGeneratedItem } from '../../../src/services/diagnostic/generatedBank.js';

let pg: PgHandle;
let exec: Querier;

/** Adapts a `Pool` into the `Querier` shape `pickGeneratedItem` expects —
 *  mirrors `src/db/pool.ts`'s `clientQuerier` (same adaptation for a
 *  transaction-bound `PoolClient`). Lets this suite exercise the real
 *  `pg.pool` from `startPostgres()` without installing it as the global
 *  pool. */
function poolQuerier(pool: Pool): Querier {
  return async (text, params = []) => {
    const result = await pool.query(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  exec = poolQuerier(pg.pool);
});

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.pool.query(`DELETE FROM generated_items`);
});

let hashSeq = 0;
function nextHash(): string {
  hashSeq += 1;
  return `${hashSeq.toString(16).padStart(8, '0')}${'b'.repeat(56)}`;
}

async function insertItem(overrides: {
  section?: 'vocab' | 'grammar';
  level?: string;
  kind?: string;
  status?: 'draft' | 'approved' | 'retired';
  stem?: string;
  choices?: readonly { kr: string; en?: string }[];
  answerIndex?: number;
  explain?: string | null;
}): Promise<number> {
  const section = overrides.section ?? 'vocab';
  const kind = overrides.kind ?? (section === 'grammar' ? 'pattern' : 'synonym');
  const choices = overrides.choices ?? [
    { kr: '정답', en: 'correct' },
    { kr: '오답1' },
    { kr: '오답2' },
    { kr: '오답3' },
  ];
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO generated_items
       (section, level, kind, stem, choices, answer_index, explain, source_ref,
        status, created_by, model_id, prompt_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'test-seed-ref',
             $8, 'test-fixture', 'claude-sonnet-4-6', $9)
     RETURNING id`,
    [
      section,
      overrides.level ?? 'L3',
      kind,
      overrides.stem ?? 'mock stem',
      JSON.stringify(choices),
      overrides.answerIndex ?? 0,
      overrides.explain ?? 'mock explain',
      overrides.status ?? 'approved',
      nextHash(),
    ],
  );
  return Number(rows[0]!.id);
}

describe('pickGeneratedItem', () => {
  it('returns null when the bank is empty for the cell', async () => {
    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).toBeNull();
  });

  it('returns null when only OTHER cells / OTHER statuses are populated', async () => {
    await insertItem({ section: 'vocab', level: 'L4', status: 'approved' }); // wrong level
    await insertItem({ section: 'grammar', level: 'L3', status: 'approved' }); // wrong section
    await insertItem({ section: 'vocab', level: 'L3', status: 'draft' }); // wrong status
    await insertItem({ section: 'vocab', level: 'L3', status: 'retired' }); // wrong status

    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).toBeNull();
  });

  it('draws an approved row matching section+level, mapped to the ServerItem-compatible shape', async () => {
    const id = await insertItem({
      section: 'vocab',
      level: 'L3',
      kind: 'synonym',
      stem: '다음 중 뜻이 가장 비슷한 것은?',
      choices: [
        { kr: '학교', en: 'school' },
        { kr: '병원' },
        { kr: '공원', en: 'park' },
        { kr: '도서관' },
      ],
      answerIndex: 2,
      explain: 'because reasons',
    });

    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).not.toBeNull();
    expect(result!.sourceRef).toBe(`bank:${String(id)}`);
    expect(result!.kind).toBe('synonym');
    expect(result!.level).toBe('L3');
    expect(result!.prompt).toBe('다음 중 뜻이 가장 비슷한 것은?');
    expect(result!.explain).toBe('because reasons');
    expect(result!.choices).toEqual([
      { id: 'a', kr: '학교', en: 'school' },
      { id: 'b', kr: '병원', en: '' }, // missing `en` coerced to ''
      { id: 'c', kr: '공원', en: 'park' },
      { id: 'd', kr: '도서관', en: '' },
    ]);
    // answerIndex 2 -> choice 'c'.
    expect(result!.correctAnswer).toBe('c');
  });

  it('vocab draw excludes a mismatched kind="pattern" row even if approved for the cell (defense-in-depth)', async () => {
    await insertItem({ section: 'vocab', level: 'L3', kind: 'pattern', status: 'approved' });
    const result = await pickGeneratedItem('vocab', 'L3', exec);
    expect(result).toBeNull();
  });

  it('grammar draw only matches kind="pattern" rows (never synonym/cloze)', async () => {
    await insertItem({ section: 'grammar', level: 'L3', kind: 'synonym', status: 'approved' });
    const miss = await pickGeneratedItem('grammar', 'L3', exec);
    expect(miss).toBeNull();

    const id = await insertItem({ section: 'grammar', level: 'L3', kind: 'pattern', status: 'approved' });
    const hit = await pickGeneratedItem('grammar', 'L3', exec);
    expect(hit).not.toBeNull();
    expect(hit!.sourceRef).toBe(`bank:${String(id)}`);
  });

  it('draws only from the requested (section, level) cell when multiple cells are populated', async () => {
    const wantedId = await insertItem({ section: 'vocab', level: 'L1', status: 'approved' });
    await insertItem({ section: 'vocab', level: 'L2', status: 'approved' });
    await insertItem({ section: 'vocab', level: 'L5+', status: 'approved' });
    await insertItem({ section: 'grammar', level: 'L1', kind: 'pattern', status: 'approved' });

    for (let i = 0; i < 5; i += 1) {
      const result = await pickGeneratedItem('vocab', 'L1', exec);
      expect(result).not.toBeNull();
      expect(result!.sourceRef).toBe(`bank:${String(wantedId)}`);
    }
  });
});
