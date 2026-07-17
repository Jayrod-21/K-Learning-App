# REVIEW — F-006 auth-route integration + login gate + mail transport + config

Reviewer: independent security review (adversarial). Scope: `server/src/routes/auth.ts`,
`server/src/services/mail.ts`, `server/src/config/index.ts`, `server/src/scripts/seed-user.ts`,
`server/tests/helpers/app.ts`, `server/tests/routes/auth.verify.test.ts`.
Branch `feat/f006-email-verification` vs `origin/rebuild`. Report only — no code changed, no tests run
(orchestrator gate green: server vitest 1469 passed).

## Summary verdict

**FAIL (1 BLOCKER, 5 SHOULD-FIX).** The F-006 code itself is high quality — gate placement,
token lifecycle, transport fallback, and the anti-enumeration posture on resend/verify are
textbook-correct and genuinely tested. The blocker is a known-and-deferred config landmine this
diff *documents instead of fixing*: `REGISTRATION_ENABLED=false` (the string Deploy actually
passes) coerces to `true`, so the production registration gate is inert — which also re-arms the
register-409 enumeration oracle this feature's threat model claims is closed. One line, using this
diff's own `envBool`, fixes it.

## Bar checklist

| Bar item | Status | Notes |
|---|---|---|
| No enumeration via `/auth/verify/resend` | PASS | Fixed 200 in every case; send detached post-response (auth.ts:1169-1179). Residuals: S2 (TOCTOU), N2 (timing, acknowledged in code) |
| No enumeration via `/auth/verify` | PASS | Error branches reachable only while HOLDING a token; expired-vs-invalid disclosure justified (auth.ts:1087-1094) |
| No enumeration via register | **FAIL (conditional)** | Pre-existing 409 `account already exists` (auth.ts:355-357). Sole prod mitigation = closed registration — inert per B1. See S3 |
| Login gate AFTER password, BEFORE MFA | PASS | auth.ts:431 (verifyPassword) → :449-453 (gate) → :461+ (MFA branches). Wrong password stays generic 401; tested (auth.verify.test.ts:145-152) |
| MFA/recovery machinery untouched for verified users | PASS | Gate is a pure early-return; verified-user path byte-identical to base. No special-casing in totp/recovery/enroll paths |
| `EMAIL_VERIFICATION_REQUIRED` toggles, default true | PASS in code / gap in tests | `envBool(true)` (config/index.ts:164). Kill-switch tested (auth.verify.test.ts:341-372). Default-true itself untested — S4 |
| Resend rate limiting enforced BEFORE issue/send | PARTIAL | Cooldown probed pre-send (auth.ts:1161-1163) but check-then-act, not atomic — S2. And the PATCH /me send path has NO cooldown at all — S1 |
| Mock transport when SMTP unset; `SMTP_FROM` required with `SMTP_HOST` | PASS | mail.ts:124-129 lazy select; superRefine fails startup (config/index.ts:218-229); tests delete SMTP_HOST + reset transport (app.ts:343, 369) |
| No secrets in logs | PASS | SMTP path logs domain/subject/messageId only (mail.ts:101-111); raw token never logged by routes; mock exception documented — N3; GET query-string caveat — N1 |
| Email-change resets verification | PASS | CASE on `IS DISTINCT FROM` reads pre-update row (auth.ts:1344-1348); supersession + fresh send; replay-across-change tested (auth.verify.test.ts:230-265) |
| Session fixation posture unchanged | PASS | `finishLogin` still mints a fresh session (auth.ts:286-291); gate runs before any mint |
| `envBool` correctness (`"false"`→false) | PASS | config/index.ts:27-41; strict sets, fail-fast on garbage. Untested — S4 |
| Tests PROVE no-enum + gate + cooldown | MOSTLY PASS | 15 real testcontainer tests incl. byte-identical resend bodies + "no email sent" negative waits. Gaps: S4, S5 |

## Adversarial probes (as tasked)

1. **Enumerate registered emails?** Resend: no (fixed body, detached send; sub-ms residual timing acknowledged at auth.ts:1131-1133). Verify: no (token-holder-only). Login: no (403 only post-password). **Register: yes, 409 vs 201 — live in prod because of B1.**
2. **Gate bypass to an authenticated action?** No fresh path: gate-ON register mints no cookie (tested, auth.verify.test.ts:97); MFA step-2 endpoints require a challenge only mintable post-gate. Designed exception: an email-changer keeps their session unverified (documented, auth.ts:42-45) — N4.
3. **Gate locks out / weakens MFA for verified users?** No — early-return placement leaves the TOTP/recovery/forced-enroll code untouched; recovery-code spend/consume transactions unchanged from base. Interplay untested — S5.
4. **Mail-bomb via resend?** Cooldown + cheapLimiter enforced pre-send, but (a) not atomically — S2, (b) **PATCH /me email-change sends with no cooldown and is invisible to authLimiter (`skipSuccessfulRequests: true`) — S1, the real gap.**
5. **Mock↔real transport surprise?** No: selection is lazy off `cfg.SMTP_HOST`; `buildTestApp` deletes `SMTP_HOST` (app.ts:343) AND resets the cached transport (app.ts:369) before every app; the verify suite layers a capture transport on top. A real send in tests requires deliberately re-setting env post-build.
6. **Secret logged?** No SMTP_PASS/token in any log path; config parse errors print Zod issues, not values. Mock transport token-in-log is the documented dev escape hatch (mail.ts:57-64).
7. **Email-change hijack of verified state?** No: the reset CASE compares against the OLD row so same-email PATCH keeps the stamp and a real change always clears it; old consumed token cannot re-verify the new address (emailVerification.ts:171-175, tested auth.verify.test.ts:230-265).

## Findings

### BLOCKER

**B1 — Production registration gate is inert (`z.coerce.boolean` + string `"false"`), re-arming the register enumeration oracle and open signup on a private app.**
- `config/index.ts:134` — `REGISTRATION_ENABLED: z.coerce.boolean().default(true)`. `Boolean("false") === true`.
- `Deploy/docker-compose.blue.yml:119` / `Deploy/docker-compose.green.yml:119` — `REGISTRATION_ENABLED=${REGISTRATION_ENABLED:-false}` and `Deploy/.env.example:80` — `REGISTRATION_ENABLED=false`: the container env is the *string* `"false"` → parsed `true` → **self-signup is OPEN in the blue/green prod stack**.
- This diff *knows*: `docs/BUILD_f006_email_verification.md:100-104` discloses it and files a follow-up "to keep this diff scoped". `envBool`'s own header (config/index.ts:22-25) calls the coerce behavior "unacceptable for flags whose whole purpose is to be an operator kill-switch" — the same reasoning applies verbatim to REGISTRATION_ENABLED, arguably more so.
- Security impact compounds with F-006: (a) register 409 vs 201 becomes a live user-enumeration oracle (S3's only mitigation was "registration closed"); (b) outsiders can create accounts on a deliberately-private app (they'd be unverified + MFA-forced, but account rows, verification emails from the operator's Proton identity, and DB writes are all attacker-triggerable); (c) `MFA_REQUIRED` carries the identical landmine.
- Pre-existing, yes — but the fix is one line in a file this diff already edits (`REGISTRATION_ENABLED: envBool(true)`, same for `MFA_REQUIRED`), plus a check that no legit env relies on the broken parse. Shipping a security feature whose doc admits an adjacent auth gate is broken in prod does not meet the bar. If the team insists on scope purity, the follow-up must merge BEFORE the next deploy — flagging as blocker so it cannot silently age.

### SHOULD-FIX

**S1 — PATCH /me email-change is an unbounded, cooldown-free mail send to arbitrary addresses (authenticated mail-bomb vector).**
- `server/src/routes/auth.ts:1407` — `issueAndSendVerificationEmail(userId, newEmail)` on every actual email change, with no `secondsSinceLastToken` cooldown check (the resend endpoint's "real mail-bomb gate" is bypassed on this path).
- `server/src/middleware/rateLimits.ts:113` — `authLimiter` has `skipSuccessfulRequests: true`; a successful PATCH (200) never counts, so the route's own comment ("same brute-force bucket as login", auth.ts:1278-1281) buys nothing here: an attacker holding a session can flip `email` between their own address and `victim@example.com` in a tight loop — every flip to the victim sends mail, bounded only by server throughput. Consequences: victim inbox flood + the operator's SMTP identity (Proton) spam-listed/suspended.
- Exploitability here is tempered — single-user private app, requires an authenticated session — which is why this is SHOULD-FIX and not BLOCKER; in any multi-user deployment it would be a blocker. Fix: enforce the per-user cooldown inside `issueAndSendVerificationEmail` (one gate, all callers) or check `secondsSinceLastToken` in the PATCH path; and/or count PATCH /me under a limiter that counts successes (cheapLimiter posture).

**S2 — Resend cooldown is check-then-act, not atomic (TOCTOU burst).**
- `server/src/routes/auth.ts:1161-1163` reads `secondsSinceLastToken`, decides `shouldSend`, responds, then detaches the send. N concurrent resends arriving before the first token INSERT commits all read "cooldown passed" and all send — N emails in one window. Per-IP cheapLimiter (default 120/min) caps a single IP; a distributed burst multiplies.
- Fix: make issuance itself the gate — e.g. `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM email_verification_tokens WHERE user_id=$1 AND created_at > now() - $cooldown)` with rowCount deciding the send, or a per-user advisory lock around issue+send. Keep the fixed 200 either way.

**S3 — Register response enumerates accounts (pre-existing; mitigation currently inert).**
- `server/src/routes/auth.ts:355-357` — duplicate email → 409 `account already exists`; new email → 201. Classic enumeration channel; the bar for this feature says register must be fixed-response. Pre-existing behavior, unchanged by this diff, and acceptable *only* while registration is genuinely closed in prod — which B1 currently breaks. After B1 is fixed the residual exposure is dev/test. If self-signup ever reopens: return the same 201 `verification_required` shape for existing accounts and send an "you already have an account" email instead.

**S4 — No config-level tests: `envBool`, default-true, and the SMTP_FROM refinement are unproven.**
- No config test file exists under `server/tests/` (only `helpers/app.ts` and the verify suite reference `EMAIL_VERIFICATION_REQUIRED`). The verify suite always sets the flag explicitly, and the test helper defaults it to FALSE (`app.ts:347`), so the bar's "default true holds" is enforced by nothing but the schema literal — a regression flipping `envBool(true)` → `envBool(false)` would pass the entire suite. Same for `"false"`→false, `"garbage"`→startup failure, and the SMTP_HOST-without-SMTP_FROM startup rejection (config/index.ts:218-229). These are cheap pure-unit tests; add them.

**S5 — Gate × MFA interplay is asserted in comments, not tests.**
- `server/tests/routes/auth.verify.test.ts:63-72` runs the whole suite with MFA off. No test proves: (a) unverified + `MFA_REQUIRED=true` → 403 `email_unverified` *without* an `enrollment_required` challenge being minted; (b) verified + MFA on → `mfa_required` flow unchanged. Since "gate BEFORE MFA, MFA unweakened" is the security-load-bearing claim (auth.ts:437-448), one small MFA-on describe block would convert the claim from comment to proof.

### NIT

**N1 — GET /auth/verify?token= puts a live secret in query strings → proxy/access logs.**
- `server/src/routes/auth.ts:1114-1120`. km-lb nginx logs request lines including query strings; a failed GET (e.g. 429) leaves a still-live token in access logs. The emailed link targets the SPA route (POST relay), so the GET variant is convenience only — consider removing it, or note the log exposure where the endpoint is documented. Mitigated by single-use + 24h TTL + hashed-at-rest.

**N2 — Residual timing signal on resend (exists+unverified path does one extra indexed SELECT before the response).** `server/src/routes/auth.ts:1158-1169`. Already acknowledged in the route header (auth.ts:1131-1133); sub-millisecond, behind network jitter. Recording for completeness only.

**N3 — Mock transport logs full recipient + token at info.** `server/src/services/mail.ts:57-64`. Deliberate, documented dev escape hatch; only selected when SMTP_HOST unset; tests run LOG_LEVEL=silent. Ensure the prod compose always sets SMTP_HOST — config cannot enforce "SMTP required in production" today; an `NODE_ENV=production && !SMTP_HOST` startup warning would close the accidental-mock-in-prod gap.

**N4 — Email-change keeps the current session while unverified (by design).** `server/src/routes/auth.ts:42-45, 1402-1413`. A user who changes email continues acting authenticated though unverified; only the *next* login is gated. Documented deliberately (typo-fix UX) and same-user-only — acceptable. The related step-2 TOCTOU (MFA challenge minted pre-change, completed post-change) is likewise same-user and harmless.

**N5 — seed-user hygiene is good.** Never prints password or raw token; `SEED_USER_MARK_VERIFIED` requires the exact string `'true'` (seed-user.ts:46-47); idempotent no-op on conflict; mail failure degrades with actionable operator guidance (seed-user.ts:84-94).

### PRAISE

- **Gate placement is exactly right and the reasoning is written where it matters** (auth.ts:437-453): post-password so verification status is disclosed only to credential holders, pre-MFA so the TOTP/recovery/forced-enroll machinery is untouched. The wrong-password-on-unverified-account test (auth.verify.test.ts:145-152) directly kills the status-probe oracle.
- **`envBool` is the correct fix for the `z.coerce.boolean` landmine** — strict truthy/falsy sets, default only on unset/empty, fail-fast on garbage (config/index.ts:27-41) — and F-006's own flags all use it.
- **Token module is production-grade**: 256-bit CSPRNG, SHA-256 at rest, pre-DB shape gate, single-transaction rowCount-gated consume + COALESCE stamp, supersession on reissue, and the consumed-token-cannot-verify-a-later-address rule (emailVerification.ts:171-175) closes the email-change replay hole most implementations miss.
- **Resend anti-enumeration is done properly**: fixed body decided before any send, fire-and-forget after `res.json`, per-user DB cooldown, and the deliberate `cheapLimiter`-not-`authLimiter` choice (skipSuccessfulRequests would never count an always-200 route — auth.ts:1134-1138) shows the limiter semantics were actually understood.
- **Transport isolation in tests is belt-and-braces**: SMTP_HOST deleted + transport cache reset in `buildTestApp` (app.ts:343, 369), capture transport layered per-suite, and the negative tests wait-then-assert-zero-sends (auth.verify.test.ts:299-301) rather than just asserting the happy capture.
- **The 15-test suite is real**: testcontainer Postgres, DB-level assertions (hash shape at rest, `email_verified_at` NULL), byte-identical resend bodies, expiry backdated DB-side, kill-switch app built and torn down correctly.

## Coordination observations

- B1's fix (switch `REGISTRATION_ENABLED`/`MFA_REQUIRED` to `envBool`) changes parse behavior for any env currently *relying* on the broken coercion — audit `Deploy/*.yml`, `Deploy/.env.example`, CI variable groups, and local `.env`s before flipping; add the S4 config tests in the same change.
- S1's cleanest fix (cooldown inside `issueAndSendVerificationEmail`) also covers the register and seed-user callers uniformly; note register is already implicitly bounded by email uniqueness, so a per-user cooldown there is behavior-neutral.
- The client files (`VerifyEmail.tsx`, `Login.tsx`, resend button) and migration 071 were not in this reviewer's scope; the migration's `uq_email_verif_token_hash` + partial active-lookup index were spot-checked and match the route's lookup pattern.
- Nginx: BUILD doc §6 correctly notes no allow-list change needed (`/auth` prefix already allowed) — consistent with the km-lb allow-list rule from F-012.
