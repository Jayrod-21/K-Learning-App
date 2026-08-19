/**
 * F-203: the global int8 (OID 20) type parser registered at db/pool module
 * load. Every PK/FK in this schema is `BIGINT ... IDENTITY`, which
 * node-postgres returns as a STRING by default; the parser deserializes an
 * int8 to a JS number when it is a safe integer and keeps the string
 * otherwise, so precision is never silently lost.
 *
 * Runs against a real Testcontainers Postgres with the full migration set
 * applied, and reads through the module's own `query` helper (the exact path
 * production rows take), so this pins the RUNTIME shape the rest of the
 * codebase's row types now declare (`id: number` for identity ids).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
// Importing the pool module is what registers the parser (top-level, at
// module load) — the assertions below fail without that side effect.
import { getPoolForTesting, query, setPoolForTesting } from '../../src/db/pool.js';

let pg: PgHandle;
let previousPool: Pool | null = null;

beforeAll(async () => {
  pg = await startPostgres();
  previousPool = getPoolForTesting();
  setPoolForTesting(pg.pool);
});

afterAll(async () => {
  if (previousPool) setPoolForTesting(previousPool);
  await stopPostgres(pg);
});

describe('int8 type parser (db/pool, F-203)', () => {
  it('returns a BIGINT IDENTITY id as a JS number with the correct value', async () => {
    // A scratch table with the same identity shape every real PK uses, so the
    // assertion does not couple to any one domain table's columns.
    await query(
      `CREATE TABLE int8_parser_probe (
         id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         label TEXT NOT NULL
       )`,
    );
    const ins = await query<{ id: number }>(
      `INSERT INTO int8_parser_probe (label) VALUES ('a'), ('b') RETURNING id`,
    );
    expect(ins.rows).toHaveLength(2);
    for (const row of ins.rows) {
      expect(typeof row.id).toBe('number');
    }
    expect(ins.rows.map((r) => r.id)).toEqual([1, 2]);

    const sel = await query<{ id: number }>(
      `SELECT id FROM int8_parser_probe ORDER BY id`,
    );
    expect(sel.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(sel.rows.every((r) => typeof r.id === 'number')).toBe(true);
  });

  it('keeps the largest safe integer as a number', async () => {
    const { rows } = await query<{ v: number }>(
      `SELECT 9007199254740991::int8 AS v`, // Number.MAX_SAFE_INTEGER
    );
    expect(typeof rows[0]!.v).toBe('number');
    expect(rows[0]!.v).toBe(9007199254740991);
  });

  it('preserves an oversized int8 as the exact string (safe-integer guard)', async () => {
    // 2^63 - 1: the int8 maximum, far past Number.MAX_SAFE_INTEGER — the
    // parser must hand back the untouched string, never a rounded number.
    const { rows } = await query<{ v: string }>(
      `SELECT 9223372036854775807::int8 AS v`,
    );
    expect(typeof rows[0]!.v).toBe('string');
    expect(rows[0]!.v).toBe('9223372036854775807');
  });

  it('keeps the first unsafe integer past 2^53 - 1 as a string', async () => {
    const { rows } = await query<{ v: number | string }>(
      `SELECT 9007199254740992::int8 AS v`, // MAX_SAFE_INTEGER + 1
    );
    expect(typeof rows[0]!.v).toBe('string');
    expect(rows[0]!.v).toBe('9007199254740992');
  });

  it('still parses a NULL int8 as null', async () => {
    const { rows } = await query<{ v: number | null }>(
      `SELECT NULL::int8 AS v`,
    );
    expect(rows[0]!.v).toBeNull();
  });
});
