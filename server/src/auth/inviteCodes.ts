/**
 * Invite codes (Phase 2.3, invite-only self-signup, D1). Mirrors
 * passwordReset.ts's token-hygiene structure: opaque 32-byte codes, SHA-256
 * hex at rest, `timingSafeEqual` defense-in-depth — adapted for a credential
 * an ADMIN mints (rather than the system, on the user's own behalf) and that
 * may legitimately be redeemed more than once (`max_uses`), not a strictly
 * single-use link.
 *
 * Lifecycle:
 *   1. An admin calls `POST /admin/invites` (routes/admin.ts), which resolves
 *      to `issueInviteCode` here: mint a raw code, store its hash, return the
 *      raw code ONCE in the response body. The raw code exists ONLY in that
 *      response — the issuing admin copies it out-of-band (email, chat,
 *      whatever channel the operator uses) and it is never stored, logged,
 *      or shown again. `GET /admin/invites` (`listInviteCodes`) exposes only
 *      the safe, hash-free view.
 *   2. A prospective user submits the raw code with their registration
 *      (`POST /auth/register`, `body.invite_code`). When `INVITE_REQUIRED` is
 *      on, the route runs a cheap `validateInviteCode` pre-check BEFORE the
 *      Argon2 hash (so a bad code is rejected before spending that CPU), then
 *      the AUTHORITATIVE `consumeInviteCode` INSIDE THE SAME TRANSACTION as
 *      the `users` INSERT.
 *   3. Success = the atomic consume's `uses` increment and the `users` INSERT
 *      commit or roll back TOGETHER. This is the single most important
 *      correctness property in this module: a duplicate-email 23505 on the
 *      users INSERT rolls back the whole transaction, which UN-BURNS the
 *      code — a failed registration attempt must never cost a legitimate
 *      invite holder their one use. See `consumeInviteCode`'s docstring for
 *      the full contract (mirrors passwordReset.ts's consume, which documents
 *      the identical atomicity requirement for its own token+password-change
 *      pairing).
 *
 * Threat model (each defense in code below; mirrors SECURITY.md §19):
 *   - Code guessing: 32 CSPRNG bytes (256-bit) via `randomBytes`; a shape
 *     gate (implicit — the hash lookup simply misses) rejects noise before
 *     any further DB work.
 *   - DB theft → usable codes: only SHA-256 hashes at rest; the raw code is
 *     never persisted anywhere.
 *   - Timing oracle: `timingSafeEqual` over the hashes (defense-in-depth on
 *     top of the indexed hash lookup).
 *   - Enumeration: `validateInviteCode`/`consumeInviteCode` collapse EVERY
 *     rejection reason (not-found, revoked, expired, exhausted, email-
 *     mismatch) into a single non-committal `{ ok: false }` — the caller
 *     (the register route) maps that to ONE generic `invite_invalid` code, so
 *     an attacker probing codes learns nothing about WHY a given guess
 *     failed.
 *   - Race on a limited-use code: `consumeInviteCode`'s UPDATE re-checks
 *     `uses < max_uses` (among every other condition) in its OWN WHERE
 *     clause, not from a pre-read snapshot — see the docstring for why that
 *     closes the TOCTOU window a naive check-then-increment would leave.
 *   - Secrets in logs: the raw code is never logged here — callers that log
 *     issuance (routes/admin.ts) log the id/note/email, never the code.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { clientQuerier, query, withTransaction, type Querier } from '../db/pool.js';

/** 32 random bytes → base64url; identical entropy to a session token / the
 *  password-reset and email-verification tokens. */
const CODE_BYTES = 32;

/** base64url alphabet, 32 bytes → 43 chars (no padding). Same pre-DB shape
 *  gate as sessions / passwordReset / emailVerification. */
const RAW_CODE_SHAPE = /^[A-Za-z0-9_-]{42,44}$/;

/** Sane ceiling on an admin's free-text label — mirrors the DB's
 *  `ck_invite_codes_note_length` (migration 097); enforced here too so a
 *  bad request 400s before ever reaching Postgres. */
const NOTE_MAX_LENGTH = 500;

export function mintRawCode(): string {
  return randomBytes(CODE_BYTES).toString('base64url');
}

export function hashCode(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Run `fn` inside the caller's transaction when `exec` is provided, else in
 *  a fresh one. Mirrors passwordReset.ts / emailVerification.ts's identical
 *  helper — the exec path is what lets the register route make the consume
 *  and the `users` INSERT one atomic unit. */
async function inTransaction<T>(
  exec: Querier | undefined,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  if (exec) return fn(exec);
  return withTransaction((client) => fn(clientQuerier(client)));
}

export interface IssueInviteCodeParams {
  /** The admin minting this code (invite_codes.issued_by_user_id). */
  issuedByUserId: number;
  /** Optional email binding — case-insensitive (citext) at redemption. */
  email?: string;
  /** Optional lifetime in whole days from issuance. Omit for "never expires". */
  expiresInDays?: number;
  /** How many times this code may be redeemed. Defaults to 1 (single-use). */
  maxUses?: number;
  /** The issuing admin's own free-text label (e.g. "for Jane's cohort"). */
  note?: string;
}

/** The admin-facing view of an invite code — NEVER carries `code_hash` or
 *  the raw code. `status` is derived server-side so the client never
 *  reimplements the active/expired/revoked/exhausted logic. */
export interface SafeInviteView {
  id: number;
  status: 'active' | 'expired' | 'revoked' | 'exhausted';
  email: string | null;
  note: string | null;
  max_uses: number;
  uses: number;
  issued_by_user_id: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

interface InviteCodeRow {
  id: number;
  status: SafeInviteView['status'];
  email: string | null;
  note: string | null;
  max_uses: number;
  uses: number;
  issued_by_user_id: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

/** The SELECT projection shared by issue/list — derives `status` in SQL so
 *  every caller sees the identical classification. */
const SAFE_VIEW_SELECT = `
  id, email::text AS email, note, max_uses, uses, issued_by_user_id,
  expires_at, revoked_at, created_at,
  CASE
    WHEN revoked_at IS NOT NULL THEN 'revoked'
    WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
    WHEN uses >= max_uses THEN 'exhausted'
    ELSE 'active'
  END AS status
`;

/**
 * Mint a fresh invite code: insert the hash, return the RAW code ONCE (the
 * caller — `POST /admin/invites` — surfaces it in the response body and
 * nowhere else). Validates `maxUses`/`note` shape defensively (the DB CHECKs
 * are the authoritative gate; this just fails fast with a clearer error
 * before a round-trip).
 */
export async function issueInviteCode(
  params: IssueInviteCodeParams,
  exec?: Querier,
): Promise<{ rawCode: string } & SafeInviteView> {
  const maxUses = params.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1) {
    throw new Error('maxUses must be a positive integer');
  }
  if (params.note !== undefined && params.note.length > NOTE_MAX_LENGTH) {
    throw new Error(`note must be at most ${String(NOTE_MAX_LENGTH)} characters`);
  }
  if (
    params.expiresInDays !== undefined &&
    (!Number.isInteger(params.expiresInDays) || params.expiresInDays < 1)
  ) {
    throw new Error('expiresInDays must be a positive integer');
  }

  const raw = mintRawCode();
  const codeHash = hashCode(raw);
  return inTransaction(exec, async (q) => {
    const { rows } = await q<InviteCodeRow>(
      `INSERT INTO invite_codes
         (code_hash, issued_by_user_id, email, expires_at, max_uses, note)
       VALUES ($1, $2, $3::citext,
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE now() + make_interval(days => $4::int) END,
               $5, $6)
       RETURNING ${SAFE_VIEW_SELECT}`,
      [
        codeHash,
        params.issuedByUserId,
        params.email ?? null,
        params.expiresInDays ?? null,
        maxUses,
        params.note ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('invite code insert returned no rows');
    return { rawCode: raw, ...row };
  });
}

/**
 * Admin listing (`GET /admin/invites`) — safe view only, newest first,
 * bounded to 200 rows (mirrors admin.ts's GET /admin/users list posture; a
 * first-pass operator listing, not a paginated API).
 */
export async function listInviteCodes(exec?: Querier): Promise<SafeInviteView[]> {
  const q = exec ?? clientQuerierFromPool();
  const { rows } = await q<InviteCodeRow>(
    `SELECT ${SAFE_VIEW_SELECT}
       FROM invite_codes
      ORDER BY created_at DESC
      LIMIT 200`,
  );
  return rows;
}

/**
 * Fetch one code's safe view by id (`POST /admin/invites/:id/revoke`'s
 * post-revoke read) — unlike `listInviteCodes`, not bounded by the 200-row
 * admin-listing cap, so this stays correct once the invite table outgrows
 * one page. Returns null if the id doesn't exist.
 */
export async function getInviteCodeById(
  id: number,
  exec?: Querier,
): Promise<SafeInviteView | null> {
  const q = exec ?? clientQuerierFromPool();
  const { rows } = await q<InviteCodeRow>(
    `SELECT ${SAFE_VIEW_SELECT} FROM invite_codes WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Revoke a code (admin kill switch, `POST /admin/invites/:id/revoke`).
 * Idempotent — gates on `revoked_at IS NULL`, so revoking an
 * already-revoked code is a no-op. Returns whether THIS call flipped it
 * (false = not found, or already revoked).
 */
export async function revokeInviteCode(id: number, exec?: Querier): Promise<boolean> {
  const q = exec ?? clientQuerierFromPool();
  const { rowCount } = await q(
    `UPDATE invite_codes SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return rowCount === 1;
}

interface LookupRow {
  id: number;
  code_hash: string;
}

/** Shared hash-lookup + timingSafeEqual step for validate/consume. Returns
 *  the row id on a byte-for-byte match, else null (unknown/garbage code). */
async function lookupByHash(codeHash: string, q: Querier): Promise<number | null> {
  const { rows } = await q<LookupRow>(
    `SELECT id, code_hash FROM invite_codes WHERE code_hash = $1 LIMIT 1`,
    [codeHash],
  );
  const row = rows[0];
  if (!row) return null;
  // Constant-time hash comparison (defense-in-depth; the indexed lookup
  // already matched byte-for-byte) — same posture as passwordReset.ts /
  // emailVerification.ts's consume paths.
  const a = Buffer.from(row.code_hash, 'hex');
  const b = Buffer.from(codeHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row.id;
}

export type InviteCheckOutcome = { ok: true; id: number } | { ok: false };

/**
 * NON-consuming pre-check: does `rawCode` (redeemed against `email`) resolve
 * to a currently-usable invite code? Used by the register route as a cheap
 * early-exit BEFORE the Argon2 password hash — a bad code fails fast without
 * spending that CPU.
 *
 * Non-enumerating by construction: every rejection reason (unknown/garbage
 * code, revoked, expired, exhausted, email-mismatch) collapses to the same
 * `{ ok: false }` — the caller must not branch on WHY this returned false.
 * This function does NOT mutate anything; only `consumeInviteCode` is
 * authoritative, and the register route MUST still call that inside the
 * users-INSERT transaction (this check can go stale between the two calls —
 * e.g. a racing redemption exhausting the code — which is exactly why the
 * atomic consume, not this probe, is the real gate).
 */
export async function validateInviteCode(
  rawCode: string,
  email: string,
  exec?: Querier,
): Promise<InviteCheckOutcome> {
  if (!rawCode || !RAW_CODE_SHAPE.test(rawCode)) return { ok: false };
  const q = exec ?? clientQuerierFromPool();
  const codeHash = hashCode(rawCode);
  const id = await lookupByHash(codeHash, q);
  if (id === null) return { ok: false };
  const { rows } = await q<{ ok: boolean }>(
    `SELECT (
        revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND uses < max_uses
        AND (email IS NULL OR email = $2::citext)
     ) AS ok
       FROM invite_codes
      WHERE id = $1`,
    [id, email],
  );
  return rows[0]?.ok === true ? { ok: true, id } : { ok: false };
}

/**
 * The AUTHORITATIVE atomic consume. `exec` is REQUIRED — unlike
 * `validateInviteCode` (and unlike `issueInviteCode`/`listInviteCodes`/
 * `revokeInviteCode`, which default to their own transaction), this
 * function has NO own-transaction fallback on purpose: the register route
 * MUST run this on the SAME connection/transaction as the `users` INSERT
 * (pass `clientQuerier(client)` from inside its `withTransaction`), so the
 * `uses` increment commits or rolls back TOGETHER with account creation.
 *
 * THIS IS THE LOAD-BEARING CORRECTNESS PROPERTY OF THIS MODULE: if the
 * users INSERT subsequently fails (most commonly Postgres 23505 on a
 * duplicate email), the surrounding transaction rolls back, and THIS
 * UPDATE's increment rolls back with it — the code is never actually
 * burned by a failed registration attempt. A single-use code therefore
 * remains available for the invite holder's NEXT (successful) attempt.
 * Mirrors passwordReset.ts's `consumePasswordResetToken` contract exactly
 * (see that file's docstring, ~line 196-203): burned-on-COMMITTED-success
 * only, never on a doomed attempt.
 *
 * Implementation: look up by hash (+timingSafeEqual), then an atomic
 * rowCount-gated `UPDATE ... WHERE uses < max_uses AND ...` — every
 * liveness condition (revoked/expired/exhausted/email-bound) is re-checked
 * IN THE UPDATE'S OWN WHERE clause, not from a pre-read snapshot. That
 * closes the TOCTOU window a naive "SELECT to check, then UPDATE
 * unconditionally" would leave open: two concurrent redemptions of a
 * max_uses=1 code both read "uses=0, usable" from a SELECT, but only ONE
 * `UPDATE ... WHERE uses < max_uses` can ever match — the loser's rowCount
 * is 0 and it consumes nothing. The exact same clause additionally bounds a
 * multi-use code: N concurrent redemptions of a max_uses=N code can each
 * win exactly once, and the (N+1)th loses regardless of arrival order.
 *
 * Non-enumerating: returns only `{ ok: true, id }` or `{ ok: false }` — the
 * caller must map failure to ONE generic `invite_invalid` response (see
 * validateInviteCode's docstring for the same posture).
 */
export async function consumeInviteCode(
  rawCode: string,
  email: string,
  exec: Querier,
): Promise<InviteCheckOutcome> {
  if (!rawCode || !RAW_CODE_SHAPE.test(rawCode)) return { ok: false };
  const codeHash = hashCode(rawCode);
  const id = await lookupByHash(codeHash, exec);
  if (id === null) return { ok: false };

  const consumed = await exec(
    `UPDATE invite_codes
        SET uses = uses + 1
      WHERE id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND uses < max_uses
        AND (email IS NULL OR email = $2::citext)`,
    [id, email],
  );
  if (consumed.rowCount === 1) return { ok: true, id };
  return { ok: false };
}

/** `listInviteCodes`/`revokeInviteCode`/`validateInviteCode` default to a
 *  standalone query when no `exec` is supplied — the admin routes and the
 *  register route's cheap pre-check all call these outside any open
 *  transaction. */
function clientQuerierFromPool(): Querier {
  return query;
}
