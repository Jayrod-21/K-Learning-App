/**
 * Tests for src/services/glossOverrides.ts (Phase 2.8 — user-scoped gloss
 * override), against real Postgres (testcontainers).
 *
 * Coverage:
 *   - normalizeLemma: trims + NFC-normalizes; an NFD-composed input and its
 *     NFC form normalize identically (the property the read-overlay join
 *     depends on).
 *   - upsertGlossOverride: insert, then update on a second call (last-write-
 *     wins, ON CONFLICT DO UPDATE); rejects empty/oversized lemma or gloss.
 *   - deleteGlossOverride: removes the row and reports true; reports false
 *     when nothing matched.
 *   - getGlossOverride: null when absent, the row when present.
 *   - user isolation: user A's override is invisible to and unaffected by
 *     user B writing/deleting the SAME lemma.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { setPoolForTesting } from '../../src/db/pool.js';
import { ValidationError } from '../../src/middleware/errors.js';
import {
  deleteGlossOverride,
  getGlossOverride,
  normalizeLemma,
  upsertGlossOverride,
} from '../../src/services/glossOverrides.js';

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
  await pg.pool.query(
    'TRUNCATE TABLE user_gloss_overrides, users RESTART IDENTITY CASCADE',
  );
});

async function seedUser(pool: Pool, email: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

describe('normalizeLemma', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeLemma('  사과  ')).toBe('사과');
  });

  it('NFC-normalizes so an NFD-composed lemma matches its NFC form', () => {
    // '가' as a precomposed NFC syllable vs. the same glyph built from its
    // NFD jamo decomposition (U+1100 U+1161) — visually identical, byte
    // different. The overlay join compares raw bytes, so both MUST
    // normalize to the identical string or the join silently misses.
    const nfc = '가나다';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc); // sanity: the fixture really is byte-different
    expect(normalizeLemma(nfd)).toBe(normalizeLemma(nfc));
    expect(normalizeLemma(nfd)).toBe(nfc);
  });
});

describe('upsertGlossOverride', () => {
  it('inserts a new override', async () => {
    const userId = await seedUser(pg.pool, 'u1@test.dev');
    const result = await upsertGlossOverride(userId, '사과', 'apple (mine)');
    expect(result).toEqual({ lemma: '사과', gloss: 'apple (mine)' });

    const row = await getGlossOverride(userId, '사과');
    expect(row).toEqual({ lemma: '사과', gloss: 'apple (mine)' });
  });

  it('updates an existing override (ON CONFLICT DO UPDATE, last-write-wins)', async () => {
    const userId = await seedUser(pg.pool, 'u2@test.dev');
    await upsertGlossOverride(userId, '사과', 'apple v1');
    await upsertGlossOverride(userId, '사과', 'apple v2 — corrected');

    const { rows } = await pg.pool.query(
      'SELECT gloss FROM user_gloss_overrides WHERE user_id = $1 AND lemma = $2',
      [userId, '사과'],
    );
    expect(rows).toHaveLength(1); // still one row — no duplicate insert
    expect(rows[0]!.gloss).toBe('apple v2 — corrected');
  });

  it('normalizes the lemma before writing, so a differently-normalized re-write updates the same row', async () => {
    const userId = await seedUser(pg.pool, 'u3@test.dev');
    await upsertGlossOverride(userId, '  사과  ', 'apple');
    await upsertGlossOverride(userId, '사과'.normalize('NFD'), 'apple corrected');

    const { rows } = await pg.pool.query(
      'SELECT lemma, gloss FROM user_gloss_overrides WHERE user_id = $1',
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lemma).toBe('사과');
    expect(rows[0]!.gloss).toBe('apple corrected');
  });

  it('rejects an empty gloss', async () => {
    const userId = await seedUser(pg.pool, 'u4@test.dev');
    await expect(upsertGlossOverride(userId, '사과', '   ')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects an oversized gloss (>2000 chars)', async () => {
    const userId = await seedUser(pg.pool, 'u5@test.dev');
    await expect(
      upsertGlossOverride(userId, '사과', 'x'.repeat(2001)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an empty lemma', async () => {
    const userId = await seedUser(pg.pool, 'u6@test.dev');
    await expect(upsertGlossOverride(userId, '   ', 'apple')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects an oversized lemma (>100 chars)', async () => {
    const userId = await seedUser(pg.pool, 'u7@test.dev');
    await expect(
      upsertGlossOverride(userId, '가'.repeat(101), 'apple'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('deleteGlossOverride', () => {
  it('removes an existing override and reports true', async () => {
    const userId = await seedUser(pg.pool, 'u8@test.dev');
    await upsertGlossOverride(userId, '사과', 'apple');
    const cleared = await deleteGlossOverride(userId, '사과');
    expect(cleared).toBe(true);
    expect(await getGlossOverride(userId, '사과')).toBeNull();
  });

  it('reports false when nothing matched', async () => {
    const userId = await seedUser(pg.pool, 'u9@test.dev');
    const cleared = await deleteGlossOverride(userId, '없는단어');
    expect(cleared).toBe(false);
  });
});

describe('user isolation', () => {
  it('user A override is invisible to user B for the same lemma', async () => {
    const userA = await seedUser(pg.pool, 'a@test.dev');
    const userB = await seedUser(pg.pool, 'b@test.dev');
    await upsertGlossOverride(userA, '사과', 'apple (A)');

    expect(await getGlossOverride(userB, '사과')).toBeNull();
    expect(await getGlossOverride(userA, '사과')).toEqual({
      lemma: '사과',
      gloss: 'apple (A)',
    });
  });

  it("user B deleting the same lemma does not affect user A's override", async () => {
    const userA = await seedUser(pg.pool, 'c@test.dev');
    const userB = await seedUser(pg.pool, 'd@test.dev');
    await upsertGlossOverride(userA, '사과', 'apple (A)');

    const clearedForB = await deleteGlossOverride(userB, '사과');
    expect(clearedForB).toBe(false); // B never had a row to delete

    expect(await getGlossOverride(userA, '사과')).toEqual({
      lemma: '사과',
      gloss: 'apple (A)',
    });
  });

  it("user B writing the same lemma does not affect user A's override", async () => {
    const userA = await seedUser(pg.pool, 'e@test.dev');
    const userB = await seedUser(pg.pool, 'f@test.dev');
    await upsertGlossOverride(userA, '사과', 'apple (A)');
    await upsertGlossOverride(userB, '사과', 'apple (B)');

    expect(await getGlossOverride(userA, '사과')).toEqual({
      lemma: '사과',
      gloss: 'apple (A)',
    });
    expect(await getGlossOverride(userB, '사과')).toEqual({
      lemma: '사과',
      gloss: 'apple (B)',
    });
  });
});
