/**
 * MFA login challenges — the short-lived pending-token store for the two-step
 * login (PASS_LOGIN_CONTRACT D2 / B4). Mirrors sessions.ts: opaque 32-byte
 * tokens, SHA-256 hex at rest, atomic single-use consume.
 *
 * Lifecycle:
 *   1. Password step succeeds → `issueChallenge(userId, purpose)` mints a raw
 *      token (returned to the client once, memory-only) and stores its hash.
 *   2. Code / enroll-confirm step → `getActiveChallenge(raw, purpose)` validates
 *      the presented token (shape → hash → lookup WHERE not-consumed AND unexpired
 *      AND purpose matches).
 *   3. On success → `consumeChallenge(id)` atomically marks it consumed (rowCount
 *      gate; a racing double-submit consumes at most once → no double session
 *      issue). On a failed code → `bumpChallengeAttempts(id)`.
 *
 * The challenge confers NO session powers — it can only advance its own one
 * step, and only for its scoped purpose. We NEVER log the raw token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { query, type Querier } from '../db/pool.js';

/** Purpose scope — a challenge can only be consumed by the matching endpoint. */
export type ChallengePurpose = 'totp' | 'enroll';

/** 32 random bytes → base64url, identical entropy to a session token. */
const TOKEN_BYTES = 32;

/**
 * base64url alphabet, 32 bytes → ceil(32*4/3) = 43 chars (no padding). Same
 * shape gate sessions.getActiveSession uses to reject obvious noise before the
 * DB round-trip.
 */
const RAW_TOKEN_SHAPE = /^[A-Za-z0-9_-]{42,44}$/;

export interface ActiveChallenge {
  id: number;
  user_id: number;
  attempts: number;
}

export interface NewChallenge {
  raw: string;
  id: number;
}

/** Mint a raw pending token. Same generator as sessions.mintRawToken. */
function mintRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** SHA-256 hex of the raw token — the at-rest representation. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Issue a new challenge for `userId` scoped to `purpose`, valid for `ttlSec`
 * seconds. Returns the raw token (to hand to the client once) and the row id.
 */
export async function issueChallenge(
  userId: number,
  purpose: ChallengePurpose,
  ttlSec = 300,
): Promise<NewChallenge> {
  const raw = mintRawToken();
  const tokenHash = hashToken(raw);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO mfa_login_challenges (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4::int))
     RETURNING id`,
    [userId, tokenHash, purpose, ttlSec],
  );
  const row = rows[0];
  if (!row) throw new Error('challenge insert returned no rows');
  return { raw, id: row.id };
}

/**
 * Look up an active (unconsumed, unexpired, purpose-matching) challenge by its
 * raw token. Returns null on any miss — malformed shape, wrong purpose, expired,
 * consumed, or simply not found. Does NOT consume; the caller consumes on
 * success via consumeChallenge.
 */
export async function getActiveChallenge(
  raw: string,
  purpose: ChallengePurpose,
): Promise<ActiveChallenge | null> {
  if (!raw || !RAW_TOKEN_SHAPE.test(raw)) return null;
  const tokenHash = hashToken(raw);
  const { rows } = await query<{ id: number; user_id: number; attempts: number }>(
    `SELECT id, user_id, attempts
       FROM mfa_login_challenges
      WHERE token_hash = $1
        AND purpose = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      LIMIT 1`,
    [tokenHash, purpose],
  );
  return rows[0] ?? null;
}

/**
 * Atomically consume a challenge (single-use gate). Returns true iff THIS call
 * flipped consumed_at from NULL → now() (rowCount === 1). A racing second call
 * sees rowCount 0 and returns false — the caller must treat false as "already
 * consumed, do not issue a session".
 *
 * Pass a transaction-bound `Querier` (via `clientQuerier(client)`) to run the
 * consume on the caller's connection. This lets a multi-step operation make the
 * consume atomic with an earlier write (e.g. a recovery-code spend): if the
 * consume loses the race the caller rolls the whole transaction back, un-doing
 * the earlier write. Defaults to the standalone pool `query` otherwise.
 */
export async function consumeChallenge(id: number, exec: Querier = query): Promise<boolean> {
  const { rowCount } = await exec(
    `UPDATE mfa_login_challenges
        SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL`,
    [id],
  );
  return rowCount === 1;
}

/**
 * Increment the per-challenge bad-attempt counter. This is telemetry only — the
 * counter is recorded but nothing reads it as a cap; the per-account lockout
 * (user_totp.failed_attempts / locked_until, enforced in the /login/totp route)
 * is the actual brute-force gate. Best-effort: gated on still-unconsumed so a
 * consumed challenge's counter is never bumped.
 */
export async function bumpChallengeAttempts(id: number): Promise<void> {
  await query(
    `UPDATE mfa_login_challenges
        SET attempts = attempts + 1
      WHERE id = $1 AND consumed_at IS NULL`,
    [id],
  );
}
