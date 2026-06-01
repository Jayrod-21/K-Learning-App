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
import { query, withTransaction } from '../db/pool.js';
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
  user: { id: number; email: string };
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
    deleted_at: Date | null;
  }>(
    `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at, s.revoked_at,
            u.email::text AS email, u.deleted_at
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

  return {
    session: {
      id: row.id,
      user_id: row.user_id,
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
      revoked_at: row.revoked_at,
    },
    user: { id: row.user_id, email: row.email },
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

export async function revokeAllUserSessions(
  userId: number,
  reason: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
  });
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
