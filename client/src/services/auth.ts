/**
 * /auth/me — fetch + patch the current user record, plus the TOTP 2FA login
 * flow (PASS LOGIN — PART C1).
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
  LoginResponse,
  LoginResult,
  LoginTotpResponse,
  MfaConfirmResponse,
  MfaConfirmResult,
  MfaEnrollResponse,
  MfaEnrollResult,
  MfaStatus,
  MfaStatusResponse,
  PatchAuthMeBody,
  RecoveryCodesResult,
  RegenerateRecoveryCodesResponse,
  ResendVerificationResponse,
  VerifyEmailResponse,
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

// ── TOTP 2FA login flow (PASS LOGIN — PART C1) ────────────────────────────
//
// Every wrapper builds the request, unwraps the envelope, and translates the
// server's snake_case wire fields to the camelCase result shapes the
// AuthProvider / screens consume. `ApiError` is RETHROWN UNCHANGED — the
// service never maps a server `message` into UI text; the Login/Settings
// error tables map `status`/`code` to fixed copy at the boundary (so a future
// server that adds a detailed validation message can't leak through as an
// enumeration oracle or XSS vector). See PASS_LOGIN_CONTRACT §C1 + §8.
//
// SECURITY: none of these results are persisted by this layer. The challenge
// token, the pending TOTP secret, and the recovery codes live in React state
// only (AuthProvider `pending`, Login/Settings local state) — never in
// localStorage. The session itself rides the `HttpOnly` cookie the server
// sets on the authenticated responses; this layer never reads it.

/**
 * POST /auth/login → discriminated result.
 *
 * Three shapes, branched on `status`:
 *   - `authenticated`        → session cookie set (legacy / `MFA_REQUIRED=false`).
 *   - `mfa_required`         → a confirmed factor exists; caller must submit a
 *                              TOTP / recovery code via {@link loginTotp}.
 *   - `enrollment_required`  → no confirmed factor; caller must enroll via
 *                              {@link mfaEnroll} → {@link mfaConfirm}.
 *
 * The non-authenticated shapes carry a short-lived, single-use `challengeToken`
 * (the bearer of step-1 password success) and its `expiresIn` (seconds). The
 * password is NOT re-checked on the follow-up step — the token is.
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const res = await api.post<LoginResponse>('/auth/login', { email, password });
  if (res.status === 'authenticated') {
    return { status: 'authenticated', user: res.user };
  }
  // `mfa_required` | `enrollment_required` — both carry the pending token.
  return {
    status: res.status,
    challengeToken: res.challenge_token,
    expiresIn: res.expires_in,
  };
}

/**
 * POST /auth/login/totp — consume the pending `mfa_required` challenge with a
 * 6-digit TOTP code OR a single-use recovery code. On success the server mints
 * the real session (cookie set) and returns the user.
 *
 * The server collapses every failure into a fixed `{error:{code}}` shape
 * (`challenge_invalid` | `invalid_code` | `account_locked`); this wrapper just
 * rethrows the resulting `ApiError`.
 */
export async function loginTotp(
  challengeToken: string,
  code: string,
): Promise<{ user: User }> {
  const res = await api.post<LoginTotpResponse>('/auth/login/totp', {
    challenge_token: challengeToken,
    code,
  });
  return { user: res.user };
}

/**
 * POST /auth/mfa/enroll — mint a fresh PENDING TOTP secret. Auth is EITHER an
 * `enroll` challenge token (the forced-enrollment login leg) OR a full session
 * + password re-auth (the Settings re-enroll leg). The caller passes exactly
 * one; the discriminated arg keeps the two legs from being mixed.
 *
 * Returns the `otpauthUri` (rendered to a QR by the caller) and the base32
 * `secret` (shown for manual entry). No session and no recovery codes here —
 * {@link mfaConfirm} issues those once the user proves possession of the code.
 */
export async function mfaEnroll(
  arg: { challengeToken: string } | { password: string },
): Promise<MfaEnrollResult> {
  const body =
    'challengeToken' in arg
      ? { challenge_token: arg.challengeToken }
      : { password: arg.password };
  const res = await api.post<MfaEnrollResponse>('/auth/mfa/enroll', body);
  return { otpauthUri: res.otpauth_uri, secret: res.secret };
}

/**
 * POST /auth/mfa/confirm — verify a 6-digit code against the pending secret,
 * confirm the factor, and mint recovery codes (shown ONCE). Same two auth legs
 * as {@link mfaEnroll}, plus the `code`:
 *   - challenge leg (`challengeToken`) → server also mints the session + cookie
 *     and returns the `user`.
 *   - session re-enroll leg (`password`) → keeps the current session; `user`
 *     is omitted.
 * `recoveryCodes` is always returned.
 */
export async function mfaConfirm(arg: {
  challengeToken?: string;
  password?: string;
  code: string;
}): Promise<MfaConfirmResult> {
  // Build the body from exactly the auth field that's present, plus the code.
  // A caller that supplies neither (a bug) sends only `{ code }` and the
  // server rejects it — we don't paper over it client-side. The discriminated
  // shape keeps a future field from silently stringifying into the wire body.
  type MfaConfirmBody =
    | { code: string; challenge_token: string }
    | { code: string; password: string }
    | { code: string };
  const body: MfaConfirmBody =
    arg.challengeToken !== undefined
      ? { code: arg.code, challenge_token: arg.challengeToken }
      : arg.password !== undefined
        ? { code: arg.code, password: arg.password }
        : { code: arg.code };
  const res = await api.post<MfaConfirmResponse>('/auth/mfa/confirm', body);
  return {
    ...(res.user !== undefined ? { user: res.user } : {}),
    recoveryCodes: res.recovery_codes,
  };
}

/**
 * POST /auth/mfa/recovery-codes/regenerate — `requireAuth` + password re-auth.
 * Invalidates any unused codes and issues a fresh set (shown ONCE).
 */
export async function regenerateRecoveryCodes(
  password: string,
): Promise<RecoveryCodesResult> {
  const res = await api.post<RegenerateRecoveryCodesResponse>(
    '/auth/mfa/recovery-codes/regenerate',
    { password },
  );
  return { recoveryCodes: res.recovery_codes };
}

// ── Email verification (F-006) ────────────────────────────────

/**
 * POST /auth/verify — consume the emailed verification token.
 *
 * Returns the success status (`'verified'` | `'already_verified'` — the
 * latter is the idempotent double-click shape and is ALSO a success). Throws
 * `ApiError` with `code: 'token_expired' | 'token_invalid'` otherwise; the
 * VerifyEmail screen maps those codes to fixed copy (never server text).
 *
 * SECURITY: the raw token comes straight from the link's URL and goes
 * straight to the wire — this layer never stores or logs it.
 */
export async function verifyEmail(
  token: string,
): Promise<'verified' | 'already_verified'> {
  const res = await api.post<VerifyEmailResponse>('/auth/verify', { token });
  return res.status;
}

/**
 * POST /auth/verify/resend — request a fresh verification email.
 *
 * The server's response is a fixed generic `{status:'ok'}` in EVERY case
 * (unknown email, already verified, cooldown-suppressed, sent) — deliberate
 * anti-enumeration, so the UI must phrase success accordingly ("if an
 * account exists…"), never "email sent to your account".
 */
export async function resendVerification(email: string): Promise<void> {
  await api.post<ResendVerificationResponse>('/auth/verify/resend', { email });
}

/**
 * GET /auth/mfa/status — `requireAuth`. Drives the Settings 2FA section badge.
 * `enabled` is true once a factor is confirmed.
 */
export async function fetchMfaStatus(signal?: AbortSignal): Promise<MfaStatus> {
  const res = await api.get<MfaStatusResponse>(
    '/auth/mfa/status',
    signal !== undefined ? { signal } : undefined,
  );
  return {
    enabled: res.enabled,
    recoveryCodesRemaining: res.recovery_codes_remaining,
  };
}
