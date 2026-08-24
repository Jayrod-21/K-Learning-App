/**
 * Tests for src/auth/inviteCodes.ts (Phase 2.3 — invite-only self-signup,
 * D1), against real Postgres (testcontainers). Mirrors spendCeiling.test.ts's
 * no-app, direct-pool pattern — this module has no HTTP surface of its own
 * (routes/admin.ts and routes/auth.ts are the callers, covered by their own
 * route-level suites).
 *
 * Coverage:
 *   - issueInviteCode -> validateInviteCode -> consumeInviteCode happy path,
 *     including the SafeInviteView shape (never carries code_hash).
 *   - Every non-ok reason (unknown code, revoked, expired, exhausted,
 *     email-mismatch) collapses to `{ ok: false }` from BOTH validate and
 *     consume, and none of them mutate `uses`.
 *   - The atomic consume is single-use: a max_uses=1 code's 2nd consume
 *     fails; a max_uses=3 code consumes exactly 3 times then fails the 4th.
 *   - Concurrent consume of a 1-use code: exactly one of two racing
 *     transactions wins (the rowCount-gated UPDATE's WHERE re-check, not a
 *     pre-read snapshot).
 *   - A tampered/garbage raw code never matches (timingSafeEqual path).
 *   - listInviteCodes / revokeInviteCode behavior, including the derived
 *     `status` classification.
 *   - The intended caller composition: a successful consume + an
 *     invite_redemptions insert land together on the same connection.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { clientQuerier, setPoolForTesting, withTransaction } from '../../src/db/pool.js';
import {
  consumeInviteCode,
  hashCode,
  issueInviteCode,
  listInviteCodes,
  mintRawCode,
  revokeInviteCode,
  validateInviteCode,
} from '../../src/auth/inviteCodes.js';

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
    `TRUNCATE TABLE invite_redemptions, invite_codes, sessions, users RESTART IDENTITY CASCADE`,
  );
});

async function seedUser(pool: Pool, email: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, FAKE_HASH],
  );
  return rows[0]!.id;
}

async function usesOf(pool: Pool, id: number): Promise<number> {
  const { rows } = await pool.query<{ uses: number }>(
    `SELECT uses FROM invite_codes WHERE id = $1`,
    [id],
  );
  return rows[0]!.uses;
}

describe('mintRawCode / hashCode', () => {
  it('mints a base64url code and hashes it to 64-char lowercase hex', () => {
    const raw = mintRawCode();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{42,44}$/);
    const hash = hashCode(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic — the same raw code always hashes the same.
    expect(hashCode(raw)).toBe(hash);
  });

  it('different codes hash differently', () => {
    expect(hashCode(mintRawCode())).not.toBe(hashCode(mintRawCode()));
  });
});

describe('issueInviteCode -> validateInviteCode -> consumeInviteCode', () => {
  it('happy path: issued code validates and consumes, uses increments, hash never in the safe view', async () => {
    const adminId = await seedUser(pg.pool, 'admin1@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId, note: 'for Jane' });

    expect(issued.rawCode).toMatch(/^[A-Za-z0-9_-]{42,44}$/);
    expect(issued.status).toBe('active');
    expect(issued.uses).toBe(0);
    expect(issued.max_uses).toBe(1);
    expect(issued.note).toBe('for Jane');
    expect(issued.issued_by_user_id).toBe(adminId);
    // NEVER carries the hash or anything shaped like one.
    expect(JSON.stringify(issued)).not.toContain('code_hash');

    const email = 'invitee@test.dev';
    const check = await validateInviteCode(issued.rawCode, email);
    expect(check).toEqual({ ok: true, id: issued.id });
    // Non-consuming: uses is unchanged after a validate.
    expect(await usesOf(pg.pool, issued.id)).toBe(0);

    const consumed = await withTransaction((client) =>
      consumeInviteCode(issued.rawCode, email, clientQuerier(client)),
    );
    expect(consumed).toEqual({ ok: true, id: issued.id });
    expect(await usesOf(pg.pool, issued.id)).toBe(1);
  });

  it('an unknown/garbage raw code never matches (timingSafeEqual path) and does not touch uses', async () => {
    const adminId = await seedUser(pg.pool, 'admin2@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId });

    // Same length/shape as a real code, but not one that was ever minted.
    const garbage = mintRawCode();
    expect(await validateInviteCode(garbage, 'x@test.dev')).toEqual({ ok: false });
    const consumed = await withTransaction((client) =>
      consumeInviteCode(garbage, 'x@test.dev', clientQuerier(client)),
    );
    expect(consumed).toEqual({ ok: false });
    expect(await usesOf(pg.pool, issued.id)).toBe(0);

    // Malformed shape (too short) is rejected before any DB round-trip too.
    expect(await validateInviteCode('short', 'x@test.dev')).toEqual({ ok: false });
  });

  it('a revoked code is rejected by both validate and consume, and consume does not burn it', async () => {
    const adminId = await seedUser(pg.pool, 'admin3@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId });
    const flipped = await revokeInviteCode(issued.id);
    expect(flipped).toBe(true);

    expect(await validateInviteCode(issued.rawCode, 'x@test.dev')).toEqual({ ok: false });
    const consumed = await withTransaction((client) =>
      consumeInviteCode(issued.rawCode, 'x@test.dev', clientQuerier(client)),
    );
    expect(consumed).toEqual({ ok: false });
    expect(await usesOf(pg.pool, issued.id)).toBe(0);
  });

  it('an expired code is rejected by both validate and consume', async () => {
    const adminId = await seedUser(pg.pool, 'admin4@test.dev');
    // ck_invite_codes_expiry (expires_at > created_at) forbids setting
    // expires_at into the past relative to created_at via UPDATE — a code
    // can never be RETROACTIVELY expired after the fact, only born with a
    // window that has since elapsed. So this simulates "issued long ago,
    // window has since elapsed" by inserting directly with BOTH timestamps
    // in the past (created_at older than expires_at, expires_at still
    // before now()) rather than going through issueInviteCode (which only
    // accepts a positive expiresInDays from the current moment).
    const raw = mintRawCode();
    const { rows } = await pg.pool.query<{ id: number }>(
      `INSERT INTO invite_codes (code_hash, issued_by_user_id, created_at, expires_at)
       VALUES ($1, $2, now() - interval '2 days', now() - interval '1 hour')
       RETURNING id`,
      [hashCode(raw), adminId],
    );
    const id = rows[0]!.id;

    expect(await validateInviteCode(raw, 'x@test.dev')).toEqual({ ok: false });
    const consumed = await withTransaction((client) =>
      consumeInviteCode(raw, 'x@test.dev', clientQuerier(client)),
    );
    expect(consumed).toEqual({ ok: false });
    expect(await usesOf(pg.pool, id)).toBe(0);
  });

  it('an exhausted code (uses already at max_uses) is rejected by both validate and consume', async () => {
    const adminId = await seedUser(pg.pool, 'admin5@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 1 });
    await pg.pool.query(`UPDATE invite_codes SET uses = 1 WHERE id = $1`, [issued.id]);

    expect(await validateInviteCode(issued.rawCode, 'x@test.dev')).toEqual({ ok: false });
    const consumed = await withTransaction((client) =>
      consumeInviteCode(issued.rawCode, 'x@test.dev', clientQuerier(client)),
    );
    expect(consumed).toEqual({ ok: false });
    expect(await usesOf(pg.pool, issued.id)).toBe(1); // unchanged, not double-incremented
  });

  it('an email-bound code rejects a mismatched email but accepts a case-different match (citext)', async () => {
    const adminId = await seedUser(pg.pool, 'admin6@test.dev');
    const issued = await issueInviteCode({
      issuedByUserId: adminId,
      email: 'Jane@Example.com',
    });

    expect(await validateInviteCode(issued.rawCode, 'someone-else@test.dev')).toEqual({
      ok: false,
    });
    expect(await usesOf(pg.pool, issued.id)).toBe(0);

    // Case-insensitive match against the bound address succeeds.
    expect(await validateInviteCode(issued.rawCode, 'jane@example.com')).toEqual({
      ok: true,
      id: issued.id,
    });
    const consumed = await withTransaction((client) =>
      consumeInviteCode(issued.rawCode, 'JANE@EXAMPLE.COM', clientQuerier(client)),
    );
    expect(consumed).toEqual({ ok: true, id: issued.id });
  });

  it('single-use: a 2nd consume of a max_uses=1 code fails and does not re-increment', async () => {
    const adminId = await seedUser(pg.pool, 'admin7@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 1 });
    const email = 'once@test.dev';

    const first = await withTransaction((client) =>
      consumeInviteCode(issued.rawCode, email, clientQuerier(client)),
    );
    expect(first).toEqual({ ok: true, id: issued.id });

    const second = await withTransaction((client) =>
      consumeInviteCode(issued.rawCode, email, clientQuerier(client)),
    );
    expect(second).toEqual({ ok: false });
    expect(await usesOf(pg.pool, issued.id)).toBe(1);
  });

  it('a max_uses=3 code consumes exactly 3 times then fails the 4th', async () => {
    const adminId = await seedUser(pg.pool, 'admin8@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 3 });

    for (let i = 0; i < 3; i += 1) {
      const result = await withTransaction((client) =>
        consumeInviteCode(issued.rawCode, `redeemer${String(i)}@test.dev`, clientQuerier(client)),
      );
      expect(result).toEqual({ ok: true, id: issued.id });
    }
    expect(await usesOf(pg.pool, issued.id)).toBe(3);

    const fourth = await withTransaction((client) =>
      consumeInviteCode(issued.rawCode, 'redeemer3@test.dev', clientQuerier(client)),
    );
    expect(fourth).toEqual({ ok: false });
    expect(await usesOf(pg.pool, issued.id)).toBe(3);
  });

  it('concurrent consume of a 1-use code: exactly one of two racing transactions wins', async () => {
    const adminId = await seedUser(pg.pool, 'admin9@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId, maxUses: 1 });
    const email = 'racer@test.dev';

    const results = await Promise.all([
      withTransaction((client) => consumeInviteCode(issued.rawCode, email, clientQuerier(client))),
      withTransaction((client) => consumeInviteCode(issued.rawCode, email, clientQuerier(client))),
    ]);
    const wins = results.filter((r) => r.ok).length;
    expect(wins).toBe(1);
    expect(await usesOf(pg.pool, issued.id)).toBe(1);
  });

  it('the intended caller composition: consume + an invite_redemptions insert land together', async () => {
    const adminId = await seedUser(pg.pool, 'admin10@test.dev');
    const userId = await seedUser(pg.pool, 'redeemer10@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId });

    await withTransaction(async (client) => {
      const tx = clientQuerier(client);
      const result = await consumeInviteCode(issued.rawCode, 'redeemer10@test.dev', tx);
      expect(result).toEqual({ ok: true, id: issued.id });
      await tx(
        `INSERT INTO invite_redemptions (invite_code_id, user_id) VALUES ($1, $2)`,
        [issued.id, userId],
      );
    });

    const { rows } = await pg.pool.query<{ invite_code_id: number; user_id: number }>(
      `SELECT invite_code_id, user_id FROM invite_redemptions`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ invite_code_id: issued.id, user_id: userId });
  });
});

describe('issueInviteCode input validation', () => {
  it('rejects a non-positive maxUses before any DB round-trip', async () => {
    const adminId = await seedUser(pg.pool, 'admin11@test.dev');
    await expect(issueInviteCode({ issuedByUserId: adminId, maxUses: 0 })).rejects.toThrow();
  });

  it('rejects a note over the DB length ceiling before any DB round-trip', async () => {
    const adminId = await seedUser(pg.pool, 'admin12@test.dev');
    await expect(
      issueInviteCode({ issuedByUserId: adminId, note: 'x'.repeat(501) }),
    ).rejects.toThrow();
  });

  it('rejects a non-positive expiresInDays before any DB round-trip', async () => {
    const adminId = await seedUser(pg.pool, 'admin13@test.dev');
    await expect(
      issueInviteCode({ issuedByUserId: adminId, expiresInDays: 0 }),
    ).rejects.toThrow();
  });

  it('an expiresInDays sets expires_at that far out; omitting it leaves expires_at NULL (never expires)', async () => {
    const adminId = await seedUser(pg.pool, 'admin14@test.dev');
    const withExpiry = await issueInviteCode({ issuedByUserId: adminId, expiresInDays: 7 });
    expect(withExpiry.expires_at).not.toBeNull();

    const noExpiry = await issueInviteCode({ issuedByUserId: adminId });
    expect(noExpiry.expires_at).toBeNull();
  });
});

describe('listInviteCodes / revokeInviteCode', () => {
  it('lists newest-first, never carries code_hash, and derives status correctly', async () => {
    const adminId = await seedUser(pg.pool, 'admin15@test.dev');
    const active = await issueInviteCode({ issuedByUserId: adminId });
    const toRevoke = await issueInviteCode({ issuedByUserId: adminId });
    const toExhaust = await issueInviteCode({ issuedByUserId: adminId, maxUses: 1 });

    await revokeInviteCode(toRevoke.id);
    await pg.pool.query(`UPDATE invite_codes SET uses = 1 WHERE id = $1`, [toExhaust.id]);
    // ck_invite_codes_expiry forbids retroactively expiring a row via
    // UPDATE (see the dedicated expired-code test above for why) — insert
    // an already-elapsed-window row directly instead.
    const { rows: expiredRows } = await pg.pool.query<{ id: number }>(
      `INSERT INTO invite_codes (code_hash, issued_by_user_id, created_at, expires_at)
       VALUES ($1, $2, now() - interval '2 days', now() - interval '1 hour')
       RETURNING id`,
      [hashCode(mintRawCode()), adminId],
    );
    const toExpireId = expiredRows[0]!.id;

    const list = await listInviteCodes();
    expect(JSON.stringify(list)).not.toContain('code_hash');
    const byId = new Map(list.map((v) => [v.id, v]));
    expect(byId.get(active.id)?.status).toBe('active');
    expect(byId.get(toRevoke.id)?.status).toBe('revoked');
    expect(byId.get(toExpireId)?.status).toBe('expired');
    expect(byId.get(toExhaust.id)?.status).toBe('exhausted');

    // Newest-first.
    expect(list[0]!.id).toBe(toExhaust.id);
  });

  it('revoke is idempotent: the 2nd call on an already-revoked code returns false', async () => {
    const adminId = await seedUser(pg.pool, 'admin16@test.dev');
    const issued = await issueInviteCode({ issuedByUserId: adminId });

    expect(await revokeInviteCode(issued.id)).toBe(true);
    expect(await revokeInviteCode(issued.id)).toBe(false);
  });

  it('revoking a nonexistent id returns false', async () => {
    expect(await revokeInviteCode(999_999_999)).toBe(false);
  });
});
