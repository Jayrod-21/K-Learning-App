/**
 * requireAuth middleware.
 *
 * Reads the session cookie, validates it, attaches `req.user` and `req.session`,
 * and either calls next or returns 401. Per ADR-002 — opaque server-side tokens,
 * not JWTs.
 */
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from '../config/index.js';
import { getActiveSession } from '../auth/sessions.js';
import { UnauthorizedError } from './errors.js';

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cfg = loadConfig();
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const raw = cookies[cfg.SESSION_COOKIE_NAME];
    if (!raw) {
      next(new UnauthorizedError('missing session'));
      return;
    }
    const active = await getActiveSession(raw);
    if (!active) {
      next(new UnauthorizedError('invalid or expired session'));
      return;
    }
    req.user = active.user;
    req.session = { id: active.session.id, user_id: active.session.user_id };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Type-safe accessor for the authenticated user's id.
 *
 * Replaces the ``req.user!.id`` non-null-assertion pattern that was spread
 * across the route files (REVIEW_B3 SF4). If a route handler somehow runs
 * without ``requireAuth`` having populated ``req.user`` first, this raises
 * an ``UnauthorizedError`` with a clear message instead of crashing on a
 * ``Cannot read property 'id' of undefined`` deep inside a SQL builder.
 *
 * Compile-time benefit: the return type is ``number``, not ``number | undefined``,
 * so call-sites don't need ``!`` and a future route mounted without
 * ``requireAuth`` fails at the boundary rather than at the call site.
 */
export function getUserId(req: Request): number {
  const id = req.user?.id;
  if (id === undefined || id === null) {
    throw new UnauthorizedError('authenticated user required');
  }
  return id;
}
