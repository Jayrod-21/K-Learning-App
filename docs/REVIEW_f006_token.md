# REVIEW — F-006 token module + migration 071 + crypto (security reviewer)

Scope: `server/src/auth/emailVerification.ts`, `db/migrations/071_email_verification_tokens.{up,down}.sql`, `db/tests/test_migration_071.py`, SECURITY.md §19 claims. Reference pattern: `db/migrations/025_mfa_login_challenges.up.sql`. Also read (to verify claims / trace callers): `services/mail.ts`, `routes/auth.ts` (verify/resend/register/PATCH-me call sites), `db/pool.ts` (withTransaction), `logging.ts`, `Deploy/nginx-{blue,green}-active.conf`, `Deploy/client-nginx.conf`.

## Summary verdict

**PASS with SHOULD-FIXes. 0 BLOCKERs, 4 SHOULD-FIX, 6 NIT, 5 PRAISE.**

Core crypto + atomicity + migration = sound: 256-bit CSPRNG, hash-only at rest (DB CHECK makes raw-persist a hard error), rowCount-gated atomic single-use consume correct under READ COMMITTED, server-side expiry, one-way backfill proven by real-container tests. Migration test suite ran here: **5 passed in 12.87s** (postgres:16-alpine testcontainer, full real chain).

Top gaps (both peripheral to the module, real in the deployment): (1) a token is bound to `user_id` but NOT to the email address it attests — combined with the non-atomic supersession on email change, a live old-address token can stamp a NEW address in a failure/race window; (2) the raw token traverses as a URL query param and lands in nginx access logs (LB + client SPA fallback both log by default), partially undermining the hashed-at-rest defense against a same-host log reader.

## Bar checklist

| Bar item | Verdict | Evidence |
|---|---|---|
| CSPRNG 256-bit token | PASS | `randomBytes(32)` → base64url, emailVerification.ts:40,48-50. No Math.random anywhere. |
| Stored ONLY as SHA-256 hash | PASS | hash at :52-54; INSERT carries `tokenHash` only :81-85; DB CHECK `^[0-9a-f]{64}$` (071 up:65) rejects a raw base64url token at the DB layer — proven by test_071_token_constraints. |
| Constant-time compare | PASS | `timingSafeEqual` over hash buffers, :159-161. Honest caveat: lookup is by-hash via index (non-constant-time DB compare), but timing on the HASH leaks nothing usable (preimage required) — standard accepted pattern; code comment says exactly this. |
| Consume atomic + single-use | PASS | `UPDATE … SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL` rowCount gate :182-188, inside ONE `withTransaction`. pool.ts:146 = plain `BEGIN` → READ COMMITTED → the racing loser blocks on the row lock, re-evaluates the predicate after winner's commit, sees rowCount 0 → 'already_verified'. Two concurrent verifies CANNOT both return 'verified'. |
| Expiry server-side | PASS | `(expires_at <= now())` computed in SQL :146-147, checked :176; `ck_email_verif_expiry` blocks born-expired rows (071 up:66; test-proven). No client-supplied time anywhere. |
| Resend supersedes prior tokens | PASS (serial) / gap under concurrency | Supersede-then-insert in one tx :75-85. See SF-3 for the concurrent-issuance race. |
| No secret in logs | PASS in-module; FAIL at infra | Module logs nothing. SMTP transport logs {to-domain, subject, messageId} only (mail.ts:101-111). Mock transport logs the full body — documented dev escape hatch, selected ONLY when SMTP_HOST unset (mail.ts:57-64,127). pino redacts `token`/`*.token` (logging.ts:22-38); no pino-http URL auto-logging. BUT: nginx access logs capture the raw token — SF-2. |
| Migration: additive, up+down, idempotent | PASS | CREATE IF NOT EXISTS throughout; re-drive of the up body proven no-op (test_071_up_applies_and_reapply_is_idempotent). |
| F-088 markers | PASS | up `-- migrate: non-destructive` (071 up:1), down `-- migrate: destructive` (down:1); classification test asserts both + `contains_destructive`. |
| FK ON DELETE CASCADE | PASS | `fk_email_verif_user … ON DELETE CASCADE` (071 up:62-63); CASCADE test-proven. |
| Hashed-token column + unique/index | PASS | `uq_email_verif_token_hash` UNIQUE + shape CHECK (071 up:64-65). See NIT-3 on the partial index. |
| Audit cols | PASS | created_at / consumed_at / invalidated_at; supersession is stamp-not-delete (audit trail preserved). |
| Backfill one-way + correct | PASS | `UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL` (071 up:109-111) — fills NULLs only; test proves a pre-stamped row is untouched and the down leaves stamps alone. Rationale for non-reversal is well-argued in both headers. |
| Down destructive-marked + gate refusal | PASS | test_071_down…: `down` without `--allow-destructive` returns rc != 0; with it, table dropped, users untouched, re-up clean. |
| Tests exercise REAL behavior | PASS | Real chain via `migrate.main()` on postgres:16 testcontainer; each constraint proven by the write it rejects; ran locally: **5 passed in 12.87s**. |

## Adversarial probes (the 8 from the brief)

1. **Raw token ever stored/logged?** Not stored (DB CHECK hard-blocks it). Not logged by app code. IS logged by nginx access logs via the URL → SF-2. Mock mail transport logs it by design, dev-only, documented.
2. **Timing oracle?** No exploitable one. `timingSafeEqual` on the compare; the by-hash index lookup's timing only varies on hash bytes, which require a SHA-256 preimage to exploit. Shape gate :141 short-circuits before any DB work — that timing difference reveals only "malformed input", not token validity.
3. **Replay / TOCTOU?** No. The SELECT is triage only; the authoritative gate is the conditional UPDATE at :182-188. Consumed and superseded tokens for an unverified user return 'invalid' (:175) — a consumed token can never re-verify.
4. **Two concurrent verifies both succeed?** No. Row-lock serialization under READ COMMITTED: exactly one rowCount=1. Loser's 'already_verified' is truthful because the winner's user-stamp commits before the loser's UPDATE unblocks.
5. **Expiry server-side?** Yes, pure SQL `now()`.
6. **Entropy?** 32 bytes `node:crypto.randomBytes` = 256-bit CSPRNG. Matches the session-token discipline.
7. **Resend leaves old tokens valid?** Serially no (supersede-first in the same tx). Concurrently: yes, briefly possible — SF-3; and on email change the supersede is a separate transaction from the stamp reset — SF-1.
8. **Down reverses cleanly / backfill mis-grandfathering?** Down clean (test-proven). Backfill stamps every NULL row incl. soft-deleted users (harmless — deleted users can't log in) and is correct for this deployment (operator-provisioned accounts, signup closed). One theoretical hole: NIT-5.

## Findings

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — Token not bound to the email address it attests; email-change supersession is not atomic with the stamp reset.**
`email_verification_tokens` stores `user_id` only — no record of WHICH address the link was mailed to (071 up:54-67). The consume path checks consumed/invalidated/expired + current user verified-state (emailVerification.ts:163-176) but cannot check "does this token attest the user's CURRENT email". The docstring's defense (:25-27) covers only CONSUMED tokens. The live-token hole: `PATCH /auth/me` resets `email_verified_at` in one committed UPDATE (routes/auth.ts:1340-1360), then supersedes old tokens in a SEPARATE transaction inside `issueAndSendVerificationEmail` (routes/auth.ts:1407 → issueVerificationToken's own tx, and that call is inside a try/catch that swallows failures :1406-1413). If that second step throws (DB blip) or the process dies between the two, an unconsumed, unexpired token mailed to the OLD address stays live and passes every consume check — it verifies the NEW address it never attested. SECURITY.md §19.6's "supersedes outstanding tokens" claim holds only when nothing fails between two transactions.
Fix (either, ideally both): (a) run the supersede inside the SAME transaction as the email-change UPDATE — the module's `exec: Querier` parameter (emailVerification.ts:67) exists for exactly this and is currently never used by any caller; (b) add an `email` (attested-address) column to the token row and require it to equal `users.email` at consume — the canonical binding for email verification.

**SF-2 — Raw token in URL query string → nginx access logs (two sinks) + browser history.**
The emailed link is `${CLIENT_ORIGIN}/verify-email?token=<raw>` (emailVerification.ts:222) and a `GET /auth/verify?token=` API route exists (routes/auth.ts:1114-1120). The km-lb API location block (`Deploy/nginx-blue-active.conf:79` and the green twin — `location ~ ^/(auth|…)`) and the client SPA fallback (`Deploy/client-nginx.conf`) both log with nginx defaults (`access_log off` appears only on /healthz and /assets/), so the full request line — raw token included — is written to container access logs and can sit there for the token's whole 24 h validity if the user never completes verification. This partially undoes the hashed-at-rest defense: the attacker who reads the DB (§19.1's threat) can typically also read host logs. App-level logging is clean (pino redact list, no URL auto-logging), and query-param verification links are industry-common with single-use + TTL mitigations — hence SHOULD-FIX, not BLOCKER, but SECURITY.md §19.7 should stop claiming the log story is closed without addressing this vector.
Fix options: `access_log off` (or a query-stripping `log_format`) on the verify locations in all three nginx confs; and/or put the token in the URL fragment (`/verify-email#token=…`) so it never reaches any server, with the SPA POSTing it — then drop the GET API route.

**SF-3 — Concurrent issuance race → two live tokens (violates the module's own "exactly one link is ever redeemable" contract, emailVerification.ts:10-11).**
Supersede-then-insert (:75-85) under READ COMMITTED: two concurrent `issueVerificationToken` calls for the same user each run their supersede UPDATE before the other's INSERT is visible, so NEITHER invalidates the other — both tokens end live. Reachable via resend racing resend at the cooldown boundary, or resend racing an email change (the enabling half of SF-1's window). Both links go to addresses of the same user, so direct impact is low — but the invariant the comments and §19.3 promise does not hold under concurrency.
Fix: serialize per-user issuance — `SELECT id FROM users WHERE id = $1 FOR UPDATE` at the top of the tx, or `pg_advisory_xact_lock(user_id)`.

**SF-4 — Resend cooldown is check-then-act (TOCTOU).**
`secondsSinceLastToken` probe → decision → separate insert (routes/auth.ts:1161-1173, emailVerification.ts:100-109). N concurrent resend requests all observe the stale `max(created_at)` and all send → N emails, so the "at most one email per account per cooldown window, no matter how many IPs" claim (§19.3, route header :1137-1138) is not strictly true. Per-IP cheapLimiter bounds a single-source burst; a distributed burst multiplies. Minor for a personal single-user app; the SF-3 lock fixes this for free (probe inside the locked tx).

### NIT

**N-1** — `exec` parameter of `issueVerificationToken` (emailVerification.ts:67) is dead code: every caller (`issueAndSendVerificationEmail`, and its three route/script call sites) uses the standalone-transaction path. Wire it up per SF-1(a) or remove it.

**N-2** — `RAW_TOKEN_SHAPE = /^[A-Za-z0-9_-]{42,44}$/` (:44): 32 bytes base64url is always exactly 43 chars; 42- and 44-char inputs can never be minted. Harmless (they hash to nothing), and the width matches the sessions/mfa gates for consistency, but `{43}` is the tight bound for a new regex.

**N-3** — `ix_email_verif_active_lookup` (071 up:86-88) is unusable by the code it claims to serve: the partial predicate is `consumed_at IS NULL AND invalidated_at IS NULL`, but `consumeVerificationToken`'s SELECT (:145-151) has no such predicate (deliberately — it needs consumed/superseded rows to distinguish outcomes), so the planner cannot choose the partial index; the `uq_email_verif_token_hash` unique index serves the lookup instead. In 025 the same-shaped index works because that consumer predicates on `consumed_at IS NULL` — the mirror copied the index without the query shape. Dead weight + misleading "Hot path" comment; drop it (the unique index already covers the hash lookup).

**N-4** — 071's backfill also stamps soft-deleted users (`deleted_at IS NOT NULL` rows with NULL stamps). Harmless — deleted users can't pass login — but a `WHERE deleted_at IS NULL AND email_verified_at IS NULL` would have been more precise about what "grandfathered" means.

**N-5** — Deploy-window edge: 071's backfill runs at migrate time; a registration served by still-running OLD code after the migration but before the color flip would create a NULL-stamp user the backfill already missed → gated at next login until resend. Signup is closed in production, so theoretical; noting for the record.

**N-6** — test_migration_071.py:322 comment ("stamped by… nothing: post-071 insert") then immediately stamps the row explicitly — slightly confusing narration in an otherwise excellent test file.

### PRAISE

**P-1** — The consumed-token-vs-unverified-user re-check (emailVerification.ts:163-175, outcome table :126-138) precisely closes the replay-after-email-change class for CONSUMED tokens — a subtle case most implementations miss entirely.

**P-2** — DB CHECK `^[0-9a-f]{64}$` on token_hash turns "raw token accidentally persisted" from a code-review hope into a hard database error — and the test proves it by attempting exactly that insert (test_071_token_constraints, the base64url-shaped reject).

**P-3** — The rowCount-gate + `COALESCE(email_verified_at, now())` pairing (:182-197) is textbook-correct under READ COMMITTED, and the code comments reason about the race explicitly and accurately (including why the loser's 'already_verified' is truthful).

**P-4** — The migration tests are genuinely behavioral: full real chain via `migrate.main()`, destructive-gate refusal asserted by exit code, backfill proven to preserve pre-existing stamps, down proven to leave user state alone. No mocks anywhere near the security-load-bearing paths.

**P-5** — Supersession as `invalidated_at` stamp instead of DELETE preserves the issuance audit trail; the up/down headers argue the one-way backfill decision with unusual clarity (why un-stamping would be data loss).

## Coordination observations

- **Migration test result:** ran `db/tests/test_migration_071.py` per the TESTS.md row-3 recipe (python:3.12 container, Docker socket, `--network host`) — **5 passed in 12.87s**.
- SF-1/SF-3 share a root cause (no per-user issuance serialization + no token→email binding) and one fix touches routes/auth.ts (PATCH /auth/me) + the module + possibly a follow-up migration (email column). If a fix-pass adds a column, that's a NEW migration (072), not an edit to 071.
- SF-2's fix is Deploy/nginx config + possibly dropping the GET /auth/verify route — coordinate with whoever owns the route/client review; km_nginx_api_route_allowlist memory applies if routes change.
- SECURITY.md §19.3/§19.6/§19.7 should be re-worded to match whatever lands (the "at most one email per window" and "supersedes outstanding tokens" claims are currently stronger than the code under concurrency/failure).
