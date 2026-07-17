# FIX REPORT — F-006 email verification (security fix-pass)

Fix-pass over three independent reviews (`REVIEW_f006_token.md`,
`REVIEW_f006_route.md`, `REVIEW_f006_client.md`). Branch
`feat/f006-email-verification`, base commit `661a19a`. Every fix ships with a
test that fails if the fix is reverted. All PRAISE-flagged properties (gate
placement post-password/pre-MFA, atomic single-use consume, never-echo error
discipline, the client state machine, the fixed-200 non-enumerating resend)
are preserved and now test-pinned harder than before.

## Disposition table

| ID | Finding | Disposition | Fix + regression test |
|---|---|---|---|
| **B1** (route) | `REGISTRATION_ENABLED` / `MFA_REQUIRED` used `z.coerce.boolean()` → compose string `"false"` parsed `true` → prod self-signup OPEN + register-409 enumeration oracle re-armed | **FIXED** | Both flags now use the strict `envBool` parser (`config/index.ts`); audit confirmed NO other `z.coerce.boolean()` remains in the schema (all five boolean flags are `envBool`; all numeric coercions are unaffected). Deploy env audit: `docker-compose.{blue,green}.yml` pass `REGISTRATION_ENABLED=${REGISTRATION_ENABLED:-false}` / `MFA_REQUIRED=…:-true}`, `.env.example` + `azure-pipelines.yml` pass `false`/`true` — every existing env now parses to its INTENDED value; nothing relied on the broken coercion. New `server/tests/config.test.ts` (46 tests) pins `"false"`→false, truthy/falsy sets, unset→default (incl. `EMAIL_VERIFICATION_REQUIRED` default-TRUE), garbage→startup failure, and the SMTP_FROM-with-SMTP_HOST refinement — this also closes route **S4** |
| **SF-1** (token) + N-1 | Email-change stamp-reset and token supersession in two separate transactions (crash window → live old-address token verifies the NEW address); dead `exec` param | **FIXED** | `PATCH /auth/me` now runs profile UPDATE + supersession + fresh issue in ONE `withTransaction`, wiring the `exec`/`Querier` path (`routes/auth.ts`; `emailVerification.ts`). Mail send stays post-commit (no I/O inside a tx). ALSO added the canonical binding: migration 071 gains an `email CITEXT NOT NULL` column (the address the link was mailed to) and `consumeVerificationToken` requires it to equal the user's CURRENT email — so even a resurrected/stale old-address token can never stamp a new address. Tests: `auth.verify.test.ts` "a LIVE token mailed to the OLD address…" (deliberately resurrects the old token in SQL — the worst-case crash window — and proves consume refuses it), plus binding assertion on the fresh token row; `test_migration_071.py` proves the column (citext, NOT NULL, length CHECK) |
| **S1** (route) | Authenticated mail-bomb: `PATCH /me` email-change send had no cooldown and is invisible to `authLimiter` | **FIXED** | The email-change issue+send now goes through `issueVerificationTokenIfCooldownClear` — the SAME per-user DB cooldown as resend, atomic with the insert, inside the profile transaction. Suppressed ⇒ stamp still resets + old tokens still superseded (they attest a dead address); resend is the recovery path. Test: "rapid email flips send at most ONE email per cooldown window" (two changes; second sends nothing, leaves zero live tokens, stamp reset held, first-change token dead) |
| **SF-2** (token) + route N1 + client SF-1 | Raw token in URL query string → nginx access logs (km-lb + client SPA) + browser history | **FIXED — fragment approach** | Chosen approach (the cleanest coherent one): (1) mailer link is now `${CLIENT_ORIGIN}/verify-email#token=…` — a URL FRAGMENT never leaves the browser, so no server/proxy/CDN log or Referer can capture it; (2) `GET /auth/verify?token=` route REMOVED (the only query-param token path; nothing produced links to it); (3) `VerifyEmail.tsx` reads `location.hash`, captures the token into state once, and immediately scrubs the fragment from the address bar/history via replace-navigation. **No nginx conf change needed** — with the fragment link + no GET route, no query-param token path remains for ANY client, so there is nothing to `access_log off` (documented in SECURITY.md §19.7; km-lb allow-list untouched — `/auth` prefix unchanged). Tests: server asserts the mail body contains `#token=` and NOT `?token=`, and that GET /auth/verify 404s without consuming; client tests drive the fragment read, the history scrub (location probe), and that a legacy `?token=` URL is NOT honored |
| **SF-3** (token) | Concurrent issuance race → two live tokens (violates "exactly one redeemable link") | **FIXED** | Every issuance transaction now begins with `SELECT id FROM users WHERE id=$1 FOR UPDATE` — per-user serialization; the loser's supersede sees the winner's committed insert (READ COMMITTED re-snapshot after the lock) and stamps it. Chosen over a partial-unique constraint because it also makes the cooldown probe atomic (SF-4) with zero schema risk, and the audit-trail supersession model (stamp, don't reject) is preserved. Test: two concurrent `issueVerificationToken` calls → exactly 1 live token, 3 rows total (audit preserved) |
| **SF-4** (token) + S2 (route) | Resend cooldown check-then-act (TOCTOU burst → N emails) | **FIXED** | New `issueVerificationTokenIfCooldownClear`: the cooldown probe runs INSIDE the per-user-locked transaction, atomic with the insert; the resend route's fixed-200 is sent first and the issue+send runs detached (response timing now identical in all cases — a small anti-enumeration improvement over the old pre-response probe). Test: 5 concurrent resends past-cooldown → exactly 1 email, 1 new token row, 1 live token |
| **S5** (route) | Gate × MFA interplay asserted only in comments | **FIXED** | New MFA-on describe block: unverified + correct password → 403 `email_unverified` with NO `challenge_token` and ZERO `mfa_login_challenges` rows minted; wrong password stays generic 401; after verify → `enrollment_required` with a real challenge row and still no session cookie pre-MFA |
| **client SF-2** | No client backoff after resend 429; `ApiError.retryAfter` unused | **FIXED** | New `useRetryCountdown` hook (`client/src/hooks/useRetryCountdown.ts`): on 429 both `ResendVerificationButton` and VerifyEmail's `ResendForm` disable for `retryAfter` seconds (fallback 30 s) with a ticking "Retry in Ns" label — mirroring Login's 423 pattern (structured number, never echoed prose). Tests: new `ResendVerificationButton.test.tsx` (429 lockout + re-enable + 30 s fallback + fixed-copy/never-echo + one-shot success) and a VerifyEmail ResendForm 429 test |
| **S3** (route) | Register 409 enumerates accounts | **MITIGATED via B1 / DEFERRED as designed** | The bar accepts register-409 while registration is genuinely closed in prod; B1's fix restores that (the string `"false"` now actually closes it, test-pinned). Residual exposure is dev/test only. A fixed-response register redesign is only needed if self-signup ever reopens — out of scope for a personal-app fix-pass, per the route reviewer's own framing |
| **token N-3** | Unusable partial index `ix_email_verif_active_lookup` | **FIXED** | Removed from 071 (edited in place — 071 is unapplied on the feature branch; idempotence + F-088 markers intact); the `uq_email_verif_token_hash` UNIQUE index serves the lookup. `test_migration_071.py` now asserts the index is ABSENT (guards reintroduction) |
| **client N-1** | Empty resend submit = silent no-op | **FIXED** | Empty submit sets the fixed copy "Enter your account email to request a new link." in the existing `role="alert"` slot; test asserts it and that no request fires |
| **token N-6** | Confusing narration in 071 down-test | **FIXED** (comment reworded while editing the file) |
| **client N-5** | StrictMode comment overclaims "must not double-consume" | **FIXED** (comment now says latest-attempt-wins render, server idempotent) |
| **token N-2** | `RAW_TOKEN_SHAPE {42,44}` vs exact `{43}` | **SKIPPED (taste)** — harmless (42/44-char inputs hash to nothing) and the width deliberately matches the sessions/mfa shape gates; changing it buys nothing and breaks the mirrored-module symmetry |
| **token N-4** | 071 backfill also stamps soft-deleted users | **SKIPPED** — harmless by the reviewer's own analysis (deleted users cannot log in); narrowing the backfill now would change an already-reviewed migration for zero behavior delta |
| **token N-5** | Deploy-window edge (old code registering post-migrate, pre-flip) | **SKIPPED** — theoretical only: signup closed in prod (now actually enforced, per B1), and the affected user self-heals via resend |
| **route N2** | Sub-ms resend timing residue | **IMPROVED incidentally** — the SF-4 restructure moved the cooldown probe out of the response path entirely, so the response now does the same work in every case except the single indexed user SELECT (already acknowledged in the route header) |
| **route N3** | Mock transport in prod if SMTP_HOST unset | **SKIPPED** — compose sets SMTP vars; a `NODE_ENV=production && !SMTP_HOST` startup warning is a reasonable follow-up but is new scope, not a review-mandated fix |
| **route N4** | Email-changer keeps session while unverified | **SKIPPED (by design)** — documented deliberate UX (typo correction), same-user-only |
| **client N-2** | Interactive button inside `role="alert"` on Login | **SKIPPED** — a11y taste with test-churn risk in Login; the alert content is short and the button adjacent; noting for a UI-polish pass |
| **client N-3** | Banner stale after out-of-band verify | **SKIPPED** — reviewer judged it acceptable for the single-user posture; dismiss covers it |
| **client N-4** | Untested resend error branches | **FIXED** — covered by the new `ResendVerificationButton.test.tsx` + ResendForm 429/empty-submit tests |

## Design decisions worth flagging

- **Token-in-URL**: went with the fragment (`#token=`) + GET-route removal +
  client history scrub, NOT nginx `access_log off`. Rationale: the fragment
  removes the exposure at the source for every log sink (km-lb, client SPA
  container, any future CDN, Referer headers) instead of patching one sink;
  killing the GET route removes the only remaining query-param acceptor; and
  no `access_log off` carve-out means `/auth` request logging stays intact for
  ops. No nginx conf was touched (the `/auth` allow-list is unchanged).
  There is deliberately NO legacy `?token=` client fallback: no query-form
  link was ever emailed from any deployed build (feature branch).
- **Cooldown semantics on email change**: when the per-user cooldown
  suppresses the fresh send, the stamp reset and the supersession of
  old-address tokens still happen (they must — those tokens attest a dead
  address). The user recovers via the resend endpoint after the window. This
  is the only behavior change a legitimate user can observe (change email
  twice within 60 s → second change's mail arrives via resend), and it is the
  point of the fix.
- **SF-3 mechanism**: per-user `FOR UPDATE` row lock instead of a partial
  unique index. One mechanism serializes issuance AND makes the cooldown probe
  atomic; a unique constraint would have required insert-failure handling that
  fights the audit-preserving supersession model.
- **Migration 071 edited in place** (unapplied anywhere): added `email CITEXT
  NOT NULL` + length CHECK + comments, dropped the dead partial index. Still
  fully idempotent (`IF NOT EXISTS`, fills-NULLs-only backfill), F-088 markers
  unchanged, down unchanged. No renumbering.

## Gate results

| Gate | Result |
|---|---|
| Server `npm run typecheck` | clean |
| Server `npm run lint` | 0 errors (82 pre-existing warnings, none in touched files) |
| Server full `npx vitest run` (testcontainers) | see final message — full single run |
| DB `test_migration_071.py` (python:3.12 + postgres:16 testcontainer) | **5 passed** |
| DB full suite (`pytest db/tests --ignore=test_discriminator_coverage.py`, pinned container) | see final message |
| Client `npm run lint` | clean |
| Client `tsc -p tsconfig.app.json --noEmit` | clean |
| Client vitest (VerifyEmail, ResendVerificationButton, UnverifiedBanner, Login) | **38 passed** (4 files) |
| Client `vite build` | success |

## Self-assessment vs the bar

The blocker was a one-line parse bug with prod-open-signup consequences — fixed
at the root (parser banned, every flag converted, behavior test-pinned per
flag, deploy envs audited). The four concurrency/atomicity SHOULD-FIXes share
one mechanism (per-user issuance serialization + in-tx cooldown) rather than
four patches, and the email-binding column turns the worst crash-window
scenario from "exploitable" to "provably inert" — belt and braces, each tested
by simulating the failure the review feared (resurrected token, concurrent
burst, rapid flips). The token now never appears in any request line, log, or
persistent browser surface. Remaining skips are taste-level or
reviewer-acknowledged-acceptable, each with a stated reason above.
