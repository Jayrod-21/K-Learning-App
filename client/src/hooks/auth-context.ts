/**
 * Auth context object + shared types.
 *
 * Kept in its own module so the React Refresh rule
 * (`react-refresh/only-export-components`) stays happy: the Provider lives
 * in `AuthProvider.tsx` (component file) and the hook in `useAuth.ts` (only
 * exports a hook, no component). Both import the context from here.
 */
import { createContext } from 'react';
import type { RegisterOutcome } from '../types/domain';

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
  /**
   * F-006: whether the account email is verified. `false` drives the
   * "verify your email" banner (a logged-in-but-unverified state is possible
   * when `EMAIL_VERIFICATION_REQUIRED=false`, or right after an email
   * change). Optional because pre-F-006 fixtures omit it — treat only an
   * explicit `false` as unverified.
   */
  email_verified?: boolean;
}

export type AuthStatus = 'loading' | 'authenticated' | 'guest';

/**
 * Interstitial 2FA state held between the password step and the real session
 * (PASS LOGIN — PART C2). It carries the short-lived, single-use challenge
 * token the server issued on a successful password check.
 *
 * SECURITY — held in React state ONLY. The `challengeToken` MUST NEVER be
 * written to `localStorage` / `sessionStorage` / a cookie: it is a bearer of
 * step-1 success and a persisted copy would survive a tab close and outlive
 * its ~5-minute TTL window of usefulness while widening the theft surface.
 * The app-gate `status` stays `guest` throughout the pending window — a
 * pending challenge confers NO session powers (it can only be spent on its one
 * follow-up step). A page reload intentionally drops `pending` and sends the
 * user back to the credentials step (the token is gone; the server would
 * reject a stale one anyway).
 *
 *   - `kind: 'mfa'`    → a confirmed factor exists; submit a TOTP / recovery
 *                        code (`submitTotp`).
 *   - `kind: 'enroll'` → no confirmed factor; `enroll()` then `confirmEnroll()`.
 */
export interface PendingChallenge {
  kind: 'mfa' | 'enroll';
  challengeToken: string;
  /** Server-declared TTL in seconds (from `login`'s `expiresIn`). */
  expiresIn: number;
}

export interface AuthContextValue {
  /** Current status. Use this for routing decisions. */
  status: AuthStatus;
  /** Current user, or `null` when not authenticated or still loading. */
  user: User | null;
  /** Convenience: `status === 'loading'`. */
  loading: boolean;
  /**
   * The in-flight 2FA challenge, or `null` when there is none. Memory-only —
   * never persisted (see {@link PendingChallenge}). The Login screen reads
   * this to decide whether to render the credentials, code, or enroll step.
   */
  pending: PendingChallenge | null;
  /**
   * Submit credentials. On success either authenticates (legacy / no-2FA) or
   * sets `pending` (the common mandatory-2FA path) — it no longer always lands
   * on `authenticated`. Throws `ApiError` on failure.
   */
  login: (email: string, password: string) => Promise<void>;
  /**
   * Spend a `kind:'mfa'` pending challenge with a 6-digit TOTP code or a
   * single-use recovery code. Clears `pending` and authenticates on success.
   * Throws `ApiError` (and leaves `pending` intact) on a bad / expired code so
   * the screen can keep the step open. Throws if there is no `mfa` pending.
   */
  submitTotp: (code: string) => Promise<void>;
  /**
   * Begin enrollment for a `kind:'enroll'` pending challenge: mint a pending
   * TOTP secret. Returns the `otpauthUri` (render to a QR) + manual-entry
   * `secret`. Does NOT clear `pending` (confirm does). Throws if there is no
   * `enroll` pending.
   */
  enroll: () => Promise<{ otpauthUri: string; secret: string }>;
  /**
   * Confirm enrollment with a 6-digit code. On success the server mints the
   * session (cookie set) and returns the one-time `recoveryCodes`. This clears
   * `pending` but DELIBERATELY does NOT flip the app gate to `authenticated`
   * yet: the screen must first show the recovery codes and gate entry behind
   * an explicit acknowledgement (the codes are shown ONCE). The screen calls
   * {@link completeEnrollment} after the user acknowledges. Throws (leaving
   * `pending`) on a bad code. Throws if there is no `enroll` pending.
   */
  confirmEnroll: (code: string) => Promise<{ recoveryCodes: string[] }>;
  /**
   * Flip the app gate to `authenticated` after the user has acknowledged their
   * recovery codes (the post-{@link confirmEnroll} step). The session cookie is
   * already set server-side; this only advances local state and re-probes
   * `/auth/me` to hydrate the user. Idempotent — a no-op if already
   * authenticated.
   */
  completeEnrollment: () => Promise<void>;
  /**
   * Create an account. Resolves `'authenticated'` (gate-off legacy: session
   * minted, state flips) or `'verification_required'` (F-006 prod posture:
   * NO session — the screen must show "check your email" and the app gate
   * stays `guest`). Throws `ApiError` on conflict / validation.
   */
  register: (
    email: string,
    password: string,
    displayName?: string,
  ) => Promise<RegisterOutcome>;
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
