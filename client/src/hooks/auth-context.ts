/**
 * Auth context object + shared types.
 *
 * Kept in its own module so the React Refresh rule
 * (`react-refresh/only-export-components`) stays happy: the Provider lives
 * in `AuthProvider.tsx` (component file) and the hook in `useAuth.ts` (only
 * exports a hook, no component). Both import the context from here.
 */
import { createContext } from 'react';

/**
 * Authenticated user shape.
 *
 * `id` + `email` ship in Pass 1. `display_name` + `phone` land with Pass 3A
 * (PATCH /auth/me support); both stay optional so any caller built against
 * the Pass-1 shape keeps compiling. The server returns them only when set.
 *
 * `version` is the optimistic-concurrency snapshot (added Pass 3 fix-pass).
 * Callers that PATCH `/auth/me` MUST read this off the latest in-memory
 * user, send it as `expected_version` in the body, and re-read on the
 * response (or via `refresh()`) so the next PATCH uses the bumped value.
 * Stays optional in the type because mock fixtures and the seed loader
 * existed before the version column shipped; runtime code that depends on
 * it should default to `1` only as a last resort.
 */
export interface User {
  id: number;
  email: string;
  display_name?: string;
  phone?: string;
  version?: number;
}

export type AuthStatus = 'loading' | 'authenticated' | 'guest';

export interface AuthContextValue {
  /** Current status. Use this for routing decisions. */
  status: AuthStatus;
  /** Current user, or `null` when not authenticated or still loading. */
  user: User | null;
  /** Convenience: `status === 'loading'`. */
  loading: boolean;
  /** Submit credentials. Resolves on success; throws `ApiError` on failure. */
  login: (email: string, password: string) => Promise<void>;
  /** Create an account and sign in. Throws `ApiError` on conflict / validation. */
  register: (
    email: string,
    password: string,
    displayName?: string,
  ) => Promise<void>;
  /** Revoke session and clear cookie. Always resolves. */
  logout: () => Promise<void>;
  /**
   * Re-run the `GET /auth/me` probe and refresh the cached `user`. Used by
   * screens that mutate the user record (e.g. Settings → `PATCH /auth/me`)
   * so the in-memory context reflects the new server state without a full
   * page reload. Resolves once the probe settles (success or failure);
   * never throws — failures are folded into `status === 'guest'`.
   */
  refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
