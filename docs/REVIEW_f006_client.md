# Independent Review — F-006 Client Email-Verification UX

Reviewer: independent senior review (did not author). Branch `feat/f006-email-verification`, commit `661a19a`.
Scope: client verify-landing page, resend affordances, unverified banner, Login register/unverified states, auth plumbing.

## Summary verdict

**PASS — 0 BLOCKERS, 2 SHOULD-FIX, 5 NIT.** The state machine on the verify page is honest and complete (no path can strand the user on a spinner), the never-echo fixed-error-string discipline is applied consistently and is asserted by tests, the fetch boundary is fully typed against the server's actual wire contract (verified against `server/src/routes/auth.ts`), and the tests exercise real behavior. The two SHOULD-FIXes are defense-in-depth items: the raw token's residence in the URL (reverse-proxy access logs + address bar, never scrubbed post-consumption) and the absence of any client-side backoff on a 429 from the resend endpoints.

## Client gate (run by reviewer, in this worktree)

| Gate | Result |
|---|---|
| `npm ci` | OK, 0 vulnerabilities |
| `npm run lint` (eslint .) | **0 errors, 0 warnings** |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** (exit 0) |
| `npx vitest run VerifyEmail.test.tsx UnverifiedBanner.test.tsx Login.test.tsx` | **3 files / 30 tests, 30 passed, 0 failed** (1.86s) |

## Bar checklist

| Bar item | Status | Evidence |
|---|---|---|
| Verify page consumes token, handles ALL states (success / expired / invalid / already-verified / resend) | PASS | `VerifyEmail.tsx:34` 5-state machine; `already_verified` deliberately folded into success (`services/auth.ts:221-226`); no-token → immediate `invalid` (`VerifyEmail.tsx:39-41`) |
| No infinite spinner / no crash | PASS | Every promise path terminates in a `setState`; network failure → dedicated `network` state with a working retry (`VerifyEmail.tsx:114-135`); unknown errors fall through to `invalid` (`VerifyEmail.tsx:70`) |
| No token in logs/analytics/history in a risky way | PARTIAL | No `console.*`/analytics anywhere in the touched files (only pre-existing dev-only `api.ts:215` warn, token-free). BUT the token rides the query string → proxy access logs + address bar, never scrubbed. See SF-1 |
| Banner + login gate messaging clear, actionable, never dead-end | PASS | Every terminal state offers a next action: success→sign-in link, expired/invalid→resend form + back-link, unverified login→notice + resend (`Login.tsx:303-312`), banner→resend + dismiss |
| WCAG AA / ARIA on new components + states | PASS (minor nits) | `role="status" aria-live="polite"` on verifying lede + send-state (`VerifyEmail.tsx:95, 218, 258`); `role="alert"` on errors; labeled inputs via `useId`; `aria-busy` on forms; dismiss button has `aria-label` (`UnverifiedBanner.tsx:39`). Nits: N-1, N-2 |
| Strict TS at fetch boundary, no `any` | PASS | `VerifyEmailResponse` / `ResendVerificationResponse` / discriminated `RegisterResponse` (`types/domain.ts:2003-2020`); typed narrow returns in `services/auth.ts:221-238`; tsc strict clean |
| No swallowed errors | PASS | Every catch either maps to a rendered state or a fixed error string; nothing silently discarded |
| Resend respects cooldown, not spammable | PARTIAL | Happy path is one-shot per mount (button is replaced by the sent-message — cannot re-fire); double-submit guarded (`ResendVerificationButton.tsx:33`, `VerifyEmail.tsx:197`). BUT the error path re-enables instantly with no 429 backoff. See SF-2 |
| Tests exercise REAL behavior | PASS | See "Tests" below — mutations that break the component would fail these assertions |
| Consistent with auth-screen conventions | PASS | Same `km-login` layout scaffold, same fixed-error-table pattern, same `role="status"`-in-button busy convention as the existing 2FA steps |
| Co-located CSS | PASS | `km-unverified-banner` / `km-resend` blocks live in `styles/index.css:1843-1894` alongside the existing `km-login` blocks (repo convention: single stylesheet) |
| No scope creep / dead code | PASS | Client diff is exactly the F-006 surface; no orphaned exports; every new component has ≥1 consumer |

## Findings by category

### BLOCKER — none

### SHOULD-FIX

**SF-1 — Raw token lives in the URL and is never scrubbed post-consumption (access-log + address-bar exposure).**
The emailed link is `${CLIENT_ORIGIN}/verify-email?token=${raw}` (`server/src/auth/emailVerification.ts:222`), so the raw (pre-hash) token traverses the reverse proxy as a query string — km-lb/nginx access logs will retain a live token for its unconsumed window. Client-side, `VerifyEmail.tsx:37-38` reads it from `useSearchParams` and the page never calls `history.replaceState` to strip it after the POST settles, so it persists in the address bar, browser history, and any history-sync service for the session. The file's threat-model header (`VerifyEmail.tsx:14-18`) documents the browser-history residue and correctly leans on single-use + 24h expiry + SHA-256-at-rest as mitigation — that reasoning is sound and this is NOT a blocker — but the access-log leg is undocumented and cheaply avoidable. Recommend: (a) minimum, client-only: `window.history.replaceState` to drop the query string once the verify request has been sent; (b) better, coordinated: move the token to the URL fragment (`/verify-email#token=…`), which never leaves the browser (requires the mailer link change at `emailVerification.ts:222` + a `location.hash` read here).

**SF-2 — No client-side backoff after a 429 on resend; `ApiError.retryAfter` is available but unused here.**
`ResendVerificationButton.tsx:39-47` and the `ResendForm` catch (`VerifyEmail.tsx:205-213`) map a 429 to the fixed "Too many attempts…" string and then return the button to a fully enabled state — the user can immediately click again, firing another request per click. The server bounds real damage (per-IP `cheapLimiter` + per-user DB cooldown that always answers a fixed 200, `server/src/routes/auth.ts:1139-1177`), and the happy path is properly one-shot (the button is replaced by the sent-message, unresettable without remount), so this is UI polish rather than a security hole. But the api layer already surfaces the structured `retryAfter` seconds (`services/api.ts:65`) and Login already uses it for the 423 lockout copy (`Login.tsx:842-847`) — the resend affordances should do the same: disable the button for `retryAfter` (or a fixed ~30s fallback) after a 429, ideally with the remaining-seconds count in the label.

### NIT

**N-1 — ResendForm empty submit is a silent no-op.** `VerifyEmail.tsx:199` returns early when the trimmed email is empty; combined with `noValidate` (`VerifyEmail.tsx:231`) and `required` (which does nothing under noValidate), a click on "Send a new link" with an empty field produces zero feedback — visually and to screen readers. Set the fixed "enter your email" error (the `role="alert"` div already exists at `VerifyEmail.tsx:252-256`) instead of returning silently.

**N-2 — Interactive resend button inside a `role="alert"` container.** The Login unverified notice (`Login.tsx:304`) wraps both the explanation and the `ResendVerificationButton` in one `role="alert"` div. Alerts are for short text; announcing a region containing an interactive control is awkward in some AT. Prefer `role="status"` on the notice (it is not an urgent error — the account works, it just needs a click) with the button outside/inside as plain content.

**N-3 — Banner can go stale after out-of-band verification.** `UnverifiedBanner.tsx:25` renders off the context `user.email_verified`, which only updates on the next `/auth/me` probe — verify in another tab and the banner persists until reload/refresh. Dismiss covers the UX, and the resend in that state is harmlessly suppressed server-side, so this is acceptable for the single-user posture; a cheap improvement is calling `refresh()` after a resend click or on window focus.

**N-4 — Test gaps on the resend error path.** No test drives the 429 → fixed-copy branch of `ResendVerificationButton` / `ResendForm` (`ResendVerificationButton.tsx:41-45`), none asserts the button disables while `sending`, and `VerifyEmail`'s `timeout` (status 0) → `network` mapping is only covered transitively via the `network` code. The suites that exist are genuinely behavioral; these are the missing edges.

**N-5 — StrictMode comment slightly overclaims.** `VerifyEmail.tsx:42-45` says "One shot per mount … must not double-consume": the dev double-mount DOES issue two POSTs (nothing gates the second effect run); `attemptRef` only guarantees the latest attempt's result renders. The outcome is still correct — both `verified` and `already_verified` map to the same success UI and the server is idempotent — but the comment should say "last writer wins the render", not imply a single request.

### PRAISE

- **The verify page cannot strand the user.** All five states are reachable, terminal, and actionable; the network state has a real retry that re-drives the effect via `retryNonce` (`VerifyEmail.tsx:128-131`) — and the test proves the second call actually fires (`VerifyEmail.test.tsx:122-138`).
- **Never-echo discipline is enforced by tests, not just comments.** `VerifyEmail.test.tsx:85` and `Login.test.tsx:120,221,293` assert the raw server message text does NOT appear in the DOM — the strongest form of the fixed-error-table contract.
- **Anti-enumeration copy exactly matches the server's design.** The server answers a fixed 200 in every resend case (`server/src/routes/auth.ts:1126-1170`); the client's "If an account exists for …" phrasing (`ResendVerificationButton.tsx:52-56`) never overclaims delivery.
- **Explicit-false guard on the banner** (`UnverifiedBanner.tsx:25`) keeps legacy/pre-F-006 fixtures from nagging, with all three negative cases tested (`UnverifiedBanner.test.tsx:68-86`).
- **Typed boundary verified against the real server.** `email_unverified` (403), `token_expired`/`token_invalid` (400), `verified`/`already_verified`, `verification_required`, and `/auth/me`'s `email_verified` all exist server-side exactly as the client types them (`server/src/routes/auth.ts:382,451,1074-1093,245`).

## Detailed findings index

| ID | Severity | File:line |
|---|---|---|
| SF-1 | SHOULD-FIX | `client/src/pages/VerifyEmail.tsx:14-18,37-38`; `server/src/auth/emailVerification.ts:222` |
| SF-2 | SHOULD-FIX | `client/src/components/ResendVerificationButton.tsx:39-47`; `client/src/pages/VerifyEmail.tsx:205-213`; cf. `client/src/services/api.ts:65`, `client/src/pages/Login.tsx:842-847` |
| N-1 | NIT | `client/src/pages/VerifyEmail.tsx:199,231` |
| N-2 | NIT | `client/src/pages/Login.tsx:304` |
| N-3 | NIT | `client/src/components/UnverifiedBanner.tsx:25` |
| N-4 | NIT | `client/src/components/ResendVerificationButton.tsx:41-45` (untested branch) |
| N-5 | NIT | `client/src/pages/VerifyEmail.tsx:42-45` (comment accuracy) |
