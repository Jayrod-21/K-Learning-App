# F-006 — Email verification for account signup (build note)

**Branch:** `feat/f006-email-verification` · **Migration:** 071 · **Status:** design → build

Email verification is a standing deploy priority. This build adds a hashed, single-use,
expiring verification-token table; a provider-agnostic mail transport (SMTP via
nodemailer, pointed at Proton Mail Bridge in production, with a mock/log transport when
SMTP is unconfigured or under test); a verification flow wired into registration, the
seed-user provision path, and email changes; and a config-toggleable login gate.

## 1. Data model — migration 071 `email_verification_tokens`

Mirrors `025_mfa_login_challenges` exactly (hashed-at-rest, expiring, single-use):

| column | notes |
|---|---|
| `id` | identity PK |
| `user_id` | FK → users, `ON DELETE CASCADE` |
| `email` | citext — the address the link was MAILED TO (the address this token attests); consume requires it to equal the user's CURRENT email (fix-pass SF-1 binding) |
| `token_hash` | SHA-256 hex of the raw 32-byte base64url token — raw token NEVER stored |
| `expires_at` | `now() + EMAIL_VERIFICATION_TOKEN_TTL_HOURS` (default 24 h), CHECK > created_at |
| `consumed_at` | single-use marker, set via atomic rowCount-gated UPDATE |
| `invalidated_at` | set when a resend supersedes this token (audit-preserving invalidation) |
| `created_at` | audit |

Indexes: `user_id` (resend invalidation + cooldown); `expires_at` (purge); the
`UNIQUE(token_hash)` index serves the consume lookup (a partial "active-only" index was
removed by the fix-pass — the consume SELECT deliberately carries no live-ness predicate,
so the planner could never use it). Constraints: `UNIQUE(token_hash)`, hash-shape CHECK,
email-length CHECK, expiry CHECK.

**Grandfathering backfill:** `UPDATE users SET email_verified_at = created_at WHERE
email_verified_at IS NULL`. Pre-F-006 accounts were operator-provisioned (registration is
closed in prod); leaving them NULL would lock the existing account out at the next login
the moment the gate turns on. The backfill is deliberately NOT reversed by the down
migration (un-verifying genuinely verified users would be destructive); the down only
drops the token table. Up is marked `-- migrate: non-destructive` (fills NULLs only),
down `-- migrate: destructive`.

## 2. Mail transport — provider-agnostic by design

`server/src/services/mail.ts`:

- `MailTransport` interface: `sendMail({to, subject, text, html}): Promise<void>`.
- **SMTP implementation** (nodemailer) — configured entirely from env:
  `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM/SMTP_SECURE/SMTP_TLS_REJECT_UNAUTHORIZED`.
  This is the surface Proton Mail Bridge exposes locally (`127.0.0.1:1025`, STARTTLS,
  self-signed local cert — hence the reject-unauthorized knob, localhost-only).
  Bounded connection/socket timeouts so a dead relay can't hang requests.
- **Mock/log transport** — selected automatically when `SMTP_HOST` is unset (and in
  tests): logs the message (including the verify URL — that is the dev/operator escape
  hatch) and sends nothing.
- Selection is lazy + config-driven in one place (`getMailTransport()`); no provider is
  ever hardcoded. `_setMailTransportForTesting` lets the suite capture sends.

## 3. Flow

- **Register** (`POST /auth/register`) and **seed-user CLI**: create user → issue token
  (invalidate priors, store hash + attested address) → send email with
  `${CLIENT_ORIGIN}/verify-email#token=<raw>` — the token rides the URL FRAGMENT, which
  never leaves the browser (no proxy/access-log exposure; fix-pass SF-2). Send failures
  are logged, never fail the registration (resend recovers). When the gate is ON,
  register returns `201 {status:'verification_required', user}` and does NOT mint a
  session; when OFF it keeps the legacy `201 {user}` + session. seed-user honors
  `SEED_USER_MARK_VERIFIED=true` (operator escape hatch — pre-verifies, no email).
  Issuance is per-user serialized (`SELECT … FOR UPDATE`), so concurrent issues leave
  exactly one live token (fix-pass SF-3).
- **Verify** (`POST /auth/verify` ONLY — the GET `?token=` variant was removed by the
  fix-pass: a live secret in a query string lands in access logs): shape-gate → hash →
  lookup → `timingSafeEqual` on the hash → single transaction: rowCount-gated consume +
  `users.email_verified_at = COALESCE(email_verified_at, now())`, PLUS the token↔address
  binding check (the row's `email` must equal the user's current email). Idempotent: a
  consumed token whose user is verified, or any token for an already-verified user,
  returns friendly success (`already_verified`). Distinguishes `token_expired` (enables
  a targeted resend UX) from `token_invalid` — both only reachable by someone already
  holding the token, so no oracle.
- **Resend** (`POST /auth/verify/resend {email}`): ALWAYS `200 {status:'ok'}` — no
  user-enumeration (same response whether the email exists, is verified, or not).
  Per-IP `cheapLimiter` + a DB-side per-user cooldown
  (`EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC`, default 60 s) as the real mail-bomb gate
  (the auth limiter's `skipSuccessfulRequests` would never count an always-200 route).
  The cooldown check is ATOMIC with the token insert (probe inside the same
  per-user-locked transaction — fix-pass S2/SF-4), so a concurrent burst mints exactly
  once. Token issue + send run detached after the response so response timing doesn't
  oracle account existence.
- **Login gate**: in `POST /auth/login`, AFTER password verification and BEFORE any MFA
  challenge or session issue: unverified + `EMAIL_VERIFICATION_REQUIRED=true` → `403
  {error:{code:'email_unverified'}}`. Placement rationale: (a) password-first means the
  gate can't be used to probe verification status of other accounts; (b) gating before
  the challenge means the TOTP/recovery/forced-enroll paths are simply never entered
  unverified — no interaction with, or weakening of, the MFA machinery, and verified
  users' logins are byte-identical to before.
- **Email change** (`PATCH /auth/me`): changing `email` resets `email_verified_at` to
  NULL (the stamp attests the OLD address — keeping it would be a lie), invalidates
  outstanding tokens, and issues a fresh token for the new address — all in ONE
  transaction (fix-pass SF-1: no crash window can strand a live old-address token), with
  the send cooldown-gated like resend (fix-pass S1: an authenticated session cannot
  mail-bomb by flipping the email in a loop; if suppressed, the stamp still resets and
  old tokens still die — resend is the recovery path). The mail send happens after
  commit, best-effort. The current session is untouched (the user can still fix a
  typo'd address); only the next login is gated.
- `GET /auth/me` + login user payloads gain `email_verified: boolean` (strict superset)
  so the client can render the unverified banner.

## 4. Config flags (all env, `config/index.ts`)

| flag | default | purpose |
|---|---|---|
| `EMAIL_VERIFICATION_REQUIRED` | `true` | the login gate; operator kill-switch if mail delivery breaks |
| `EMAIL_VERIFICATION_TOKEN_TTL_HOURS` | `24` | token lifetime |
| `EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC` | `60` | per-user resend cooldown |
| `SMTP_HOST` … | unset | unset ⇒ mock/log transport |

`EMAIL_VERIFICATION_REQUIRED` and `SMTP_SECURE`/`SMTP_TLS_REJECT_UNAUTHORIZED` use a
strict string-boolean parser (`'false'/'0'/'no'/'off'` ⇒ false). NOTE: the pre-existing
`z.coerce.boolean()` flags (`REGISTRATION_ENABLED`, `MFA_REQUIRED`) coerce the string
`"false"` to `true` (JS `Boolean('false')`), and Deploy passes `REGISTRATION_ENABLED=false`
as a string — filed as a follow-up; not changed here to keep this diff scoped.

## 5. Threat model (defenses are also documented at each code site)

| attack | defense |
|---|---|
| Token guessing | 32-byte CSPRNG (`randomBytes`), 256-bit entropy; shape-gate before DB |
| DB theft → usable tokens | SHA-256 hash at rest; raw token exists only in the email |
| Token replay | single-use: atomic `UPDATE … WHERE consumed_at IS NULL` rowCount gate |
| Stale link | 24 h expiry checked server-side at consume |
| Old-address token verifying a NEW address | token↔address binding (`email` column checked at consume) + atomic email-change transaction |
| Token in proxy/access logs or Referer | URL-fragment link (`#token=`), no GET query route, SPA scrubs the fragment from history |
| Timing oracle on hash | `timingSafeEqual` over the hex hashes |
| User enumeration via resend | fixed generic 200 regardless of account/verify state; async send |
| User enumeration via verify errors | error branches only reachable while HOLDING a token |
| Mail-bombing via resend | per-IP limiter + per-user DB cooldown, atomic with issuance (burst-safe) |
| Mail-bombing via authenticated email flips | `PATCH /auth/me` send honors the same per-user cooldown |
| Concurrent issuance → two live links | per-user `FOR UPDATE` serialization: exactly one live token |
| Verification-status probing via login | status disclosed only after correct password |
| Locking out existing users | migration backfill + `EMAIL_VERIFICATION_REQUIRED=false` kill switch + `SEED_USER_MARK_VERIFIED` |
| Session fixation | untouched — gate runs before session mint; login still issues a fresh session row |
| Secrets in logs | raw token never logged by real transports; only the mock (SMTP unset ⇒ dev) prints the URL, documented |
| HTML injection into the email | template contains no user-supplied content (link is server-built from CLIENT_ORIGIN + token) |
| Double-click on the link | idempotent verify (`already_verified` friendly success) |

## 6. Operator deploy steps (Proton Bridge + DNS)

1. Run Proton Mail Bridge on the host; note its local SMTP credentials.
2. Set env on the server container: `SMTP_HOST=127.0.0.1` (or the compose-network alias),
   `SMTP_PORT=1025`, `SMTP_USER`/`SMTP_PASS` from Bridge, `SMTP_FROM="Korean Master
   <address@your-domain>"`, `SMTP_SECURE=false` (Bridge is STARTTLS),
   `SMTP_TLS_REJECT_UNAUTHORIZED=false` (Bridge presents a self-signed localhost cert —
   acceptable ONLY for a loopback relay).
3. DNS for the sending domain (else Proton/receivers spam-folder or reject):
   **SPF** TXT authorizing Proton (`include:_spf.protonmail.ch`), **DKIM** — the three
   `protonmail._domainkey` CNAMEs from Proton's dashboard, **DMARC** TXT
   (`v=DMARC1; p=quarantine`). The From address MUST be an address on that domain.
4. No nginx change needed: all new endpoints live under the already-allow-listed `/auth`
   prefix; `/verify-email` is an SPA route (served by the client bundle by design).
5. Existing account is grandfathered by the 071 backfill. If mail breaks, set
   `EMAIL_VERIFICATION_REQUIRED=false` and redeploy — nothing else changes.

## 7. Tests / gates

- `server/tests/routes/auth.verify.test.ts` (testcontainer): full happy path
  (register → captured mock email → verify → login), expiry, replay, resend
  invalidation + cooldown, no-enumeration, gate on/off, `email_verified` in /auth/me,
  email-change reset + atomic supersession + cooldown, token↔address binding (a
  resurrected old-address token still refused), concurrent-issuance and resend-burst
  serialization, gate × MFA interplay (no challenge minted while unverified), GET
  route removal, fragment-form link, idempotent double-verify.
- `server/tests/config.test.ts`: strict boolean env parsing for every flag
  (`"false"` → false, defaults, garbage fails startup — fix-pass B1/S4) + the
  SMTP_FROM-with-SMTP_HOST refinement.
- `db/tests/test_migration_071.py`: real-chain up, idempotent re-apply, constraint
  proofs (incl. the attested-address column), backfill proof, destructive-down
  refusal + clean down/re-up.
- Client: `VerifyEmail.test.tsx` (success/expired/invalid/resend, fragment token,
  history scrub, empty-submit prompt, 429 backoff),
  `ResendVerificationButton.test.tsx` (send-once, fixed copy, 429 backoff + fallback),
  Login register→check-email + unverified-login states, banner test.
- Gate policy: full server vitest + full db suite + client lint/tsc/tests/build — this
  is schema + auth cross-cutting work, so the FULL suites are the gate.
