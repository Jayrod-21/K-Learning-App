/**
 * /auth/me — fetch + patch the current user record.
 *
 * Threat model (file-scope, in addition to `services/api.ts`):
 *   - CSRF: relies on the cookie's `SameSite=Strict` posture (see api.ts
 *     header). PATCH is state-changing; if SameSite is ever relaxed, add a
 *     CSRF token at the api layer, not here.
 *   - Email enumeration: `PATCH /auth/me` may 409 on duplicate email. The
 *     server returns a generic 409 code; we surface `ApiError` unchanged so
 *     UI text doesn't leak whether the target email already exists.
 *   - Rate limiting: lives on the server (`/auth/*` cheap bucket). This
 *     module trusts the server bucket and does not retry.
 *   - Body validation: the server validates with Zod. We trust TS types at
 *     the call site (Pass 3 contract — no client-side `z.parse`).
 *
 * Pass 3A: `patchMe` ships ahead of the server route — the server PATCH
 * lands in the same pass. Calling it before then returns 404 wrapped as
 * `ApiError` with `status: 404`.
 */
import { api } from './api';
import type {
  AuthMeResponse,
  PatchAuthMeBody,
} from '../types/domain';
import type { User } from '../hooks/auth-context';

/** GET /auth/me → User. Throws `ApiError` on 401 / network. */
export async function fetchMe(signal?: AbortSignal): Promise<User> {
  const res = await api.get<AuthMeResponse>(
    '/auth/me',
    signal !== undefined ? { signal } : undefined,
  );
  return res.user;
}

/**
 * PATCH /auth/me → updated User. Body is a partial patch; only the fields
 * the caller wants to change are sent.
 *
 * `expected_version` (carried inside `patch`) is required by the server's
 * optimistic-concurrency gate. A stale value 409s; the caller must
 * re-fetch via `refresh()` / `fetchMe()` and retry the PATCH against the
 * new version snapshot.
 */
export async function patchMe(
  patch: PatchAuthMeBody,
  signal?: AbortSignal,
): Promise<User> {
  const res = await api.patch<AuthMeResponse>(
    '/auth/me',
    patch,
    signal !== undefined ? { signal } : undefined,
  );
  return res.user;
}
