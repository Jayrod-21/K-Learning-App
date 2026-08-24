/**
 * Opaque server-side sessions (ADR-002).
 *
 * Token: 32 random bytes (256-bit), base64url-encoded for the cookie.
 * DB stores the SHA-256 hex digest, never the raw token. Cookie attrs:
 * HttpOnly + Secure + SameSite=Strict + Path=/, name `km_sid` (configurable).
 *
 * Rotation = new row + revoke old. We NEVER mutate expires_at in place.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { query, withTransaction, clientQuerier, type Querier } from '../db/pool.js';
import { loadConfig } from '../config/index.js';

export interface SessionRecord {
  id: number;
  user_id: number;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

export interface NewSession {
  raw: string;
  record: SessionRecord;
}

const TOKEN_BYTES = 32;

export function mintRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Issue a new session. Inserts a fresh row and returns both the raw cookie
 * value and the stored record.
 */
export async function issueSession(
  userId: number,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<NewSession> {
  const cfg = loadConfig();
  const raw = mintRawToken();
  const tokenHash = hashToken(raw);
  const lifetimeDays = cfg.SESSION_LIFETIME_DAYS;

  const { rows } = await query<{
    id: number;
    user_id: number;
    expires_at: Date;
    last_seen_at: Date;
    revoked_at: Date | null;
  }>(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4::inet, now() + make_interval(days => $5::int))
     RETURNING id, user_id, expires_at, last_seen_at, revoked_at`,
    [
      userId,
      tokenHash,
      meta.userAgent ?? null,
      meta.ipAddress ?? null,
      lifetimeDays,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('session insert returned no rows');
  return { raw, record: row };
}

/**
 * Look up a session by raw cookie token. Returns null if missing, expired,
 * revoked, or idle past the configured timeout. Bumps last_seen_at on hit.
 */
export async function getActiveSession(rawToken: string): Promise<{
  session: SessionRecord;
  user: { id: number; email: string; role: 'user' | 'admin' };
} | null> {
  if (!rawToken) return null;
  // Reject obviously malformed token shapes BEFORE we hit the DB. base64url
  // alphabet only; length cap derived from 32 bytes → ceil(32*4/3) = 43 chars
  // (no padding). Anything else is noise.
  if (!/^[A-Za-z0-9_-]{42,44}$/.test(rawToken)) return null;
  const tokenHash = hashToken(rawToken);
  const cfg = loadConfig();

  const { rows } = await query<{
    id: number;
    user_id: number;
    expires_at: Date;
    last_seen_at: Date;
    revoked_at: Date | null;
    email: string;
    role: 'user' | 'admin';
    deleted_at: Date | null;
  }>(
    `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at, s.revoked_at,
            u.email::text AS email, u.role::text AS role, u.deleted_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.deleted_at) return null;
  // Idle-timeout check: app-layer per ADR-002.
  const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
  if (idleMs > cfg.SESSION_IDLE_TIMEOUT_DAYS * 86_400_000) {
    await revokeSessionById(row.id, 'idle_timeout');
    return null;
  }
  // Bump last_seen_at — best-effort, fire-and-forget would lose ordering, so
  // we await but log on failure rather than fail the request.
  try {
    await query(
      `UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [row.id],
    );
  } catch {
    /* swallow — observability happens at the pool layer */
  }

  // sessions.id / sessions.user_id arrive as safe-integer numbers via the
  // int8 parser (db/pool.ts). This function is the single source of truth for
  // the authenticated principal — every route reads req.user.id /
  // getUserId(req) and the return type contract is `number` — so the Number()
  // normalization is kept at this one boundary (an identity op for in-range
  // IDENTITY ids) rather than trusting every downstream consumer.
  const id = Number(row.id);
  const userId = Number(row.user_id);
  return {
    session: {
      id,
      user_id: userId,
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
      revoked_at: row.revoked_at,
    },
    user: { id: userId, email: row.email, role: row.role },
  };
}

export async function revokeSessionById(
  id: number,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [id, reason],
  );
}

/**
 * Revoke every live session for a user. Pass `exec` (a `Querier` — e.g.
 * `clientQuerier(client)`) to run inside a caller's existing transaction, so
 * the revoke is atomic with the caller's other writes; omit it to run in the
 * helper's own transaction. (B-045: `scripts/mfa-reset.ts` needs the revoke in
 * the SAME transaction as its TOTP/recovery-code deletes — before this
 * parameter existed it kept a duplicate inline copy to get that atomicity.)
 */
export async function revokeAllUserSessions(
  userId: number,
  reason: string,
  exec?: Querier,
): Promise<void> {
  const run = (q: Querier): Promise<unknown> =>
    q(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
  if (exec) {
    await run(exec);
    return;
  }
  await withTransaction((client) => run(clientQuerier(client)));
}

/**
 * Secure cookies only in production (ADR-002 D3). Production runs behind
 * Cloudflare/origin TLS, so the cookie is HTTPS-only there. In `development` and
 * `test` the app is reached over plain HTTP (the dev server; supertest in the
 * route suite), and a `Secure` cookie would never be sent back over HTTP — which
 * silently breaks every authenticated request (the session simply never arrives).
 */
function cookieSecure(cfg: ReturnType<typeof loadConfig>): boolean {
  return cfg.NODE_ENV === 'production';
}

/** Set the session cookie on the response with locked attributes (ADR-002 D3). */
export function setSessionCookie(res: Response, rawToken: string, expiresAt: Date): void {
  const cfg = loadConfig();
  res.cookie(cfg.SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: cookieSecure(cfg),
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  const cfg = loadConfig();
  res.clearCookie(cfg.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure(cfg),
    sameSite: 'strict',
    path: '/',
  });
}
