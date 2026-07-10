# FIX REPORT — Phase-2 Group 1 (DB foundation) fix-pass

**Fixer:** independent senior fix-pass (did not author or review this code)
**Branch:** `feat/phase2-g1-db-foundation` (working tree on top of `fa361df`; NOT committed)
**Inputs:** `REVIEW_phase2g1_dbinfra.md` (045+047), `REVIEW_phase2g1_topik.md` (046), `REVIEW_phase2g1_integration.md` (cross-cutting)
**Date:** 2026-07-10

## Gate results (run by this fixer, real counts)

| Gate | Command | Result |
|---|---|---|
| DB harness | container harness (exact task command), `db/tests` minus `test_discriminator_coverage` | **32 passed in 20.48s** (29 pre-existing + 3 new; re-run after the final 047 comment edit — see the addendum at the bottom) |
| Server topik suite | `cd server && npx vitest run tests/routes/topik.test.ts` | **84 passed (84)** in 76.96s (83 pre-existing + 1 new advisory-lock test) |
| Isolation proof for B-1 | same suite with `server/{src/routes/topik.ts,tests/routes/topik.test.ts}` stashed (047 fix kept) | **83 passed (83)** — the 047 guard ALONE un-bricks the harness |
| Server typecheck / lint | `tsc --noEmit`; `eslint` on the two changed server files | clean (exit 0) |
| Deploy scripts | `bash -n` on the two edited scripts | clean |

`npm ci` note (predicted by the task): it died with `EACCES ... unlink node_modules/pend/README.md`
(root-owned files left by Docker runs) after partially emptying the tree; `npm install`
repaired it in place, and the suite ran against that — same remediation the topik
reviewer used.

Pre-existing, NOT introduced by this pass: a pg `DeprecationWarning` ("client.query()
when the client is already executing") appears once in a full-suite run. Verified by
stashing both server-file changes and re-running: the warning appears with the
pre-change code too, and does not appear when the new advisory-lock test runs alone.

---

## BLOCKERs

| # | Finding | Disposition | Where |
|---|---|---|---|
| B-1 (integration; topik B-1 is the same defect) | 047's unguarded `REVOKE ... ON TABLE schema_migrations` crashes raw-SQL appliers (server harness `pg.ts`, manual psql) — server CI guaranteed red | **FIXED** | `db/migrations/047_km_app_role.up.sql:141-155` — REVOKE wrapped in `DO $$ ... IF to_regclass('public.schema_migrations') IS NOT NULL` with a comment explaining both appliers; the false header claim ("exists whenever this runs") corrected at `:12-19`. Security intent preserved: every runner-managed DB still takes the revoke; the existing denial-matrix test (`test_km_app_role.py::test_047_km_app_dml_allowed_ddl_denied`, schema_migrations INSERT/UPDATE/DELETE → 42501) still passes. **Regression test added:** `db/tests/test_km_app_role.py::test_047_raw_sql_apply_without_schema_migrations` — applies 001+047 verbatim (no runner, no bookkeeping table) and asserts no error, then creates the table, re-applies 047, and asserts the revoke fires. Server suite verified green (84/84; 83/83 with only the 047 fix). |
| B-2 (integration) | Scripted deploy can't ship this release: no `--allow-destructive` anywhere, no seam for `set-km-app-password.sh`, runbook silent, `Deploy/SECURITY.md` §7 contradicts the release | **FIXED** | (a) `Deploy/README.md` — new section **"Shipping Phase-2 Group 1 (migrations 045–047) — ONE-TIME brief-downtime release"** with the exact ordered procedure (env → build/tag → backup → stop active color → `run_migrate --allow-destructive up` → `set-km-app-password.sh` → `azure-deploy-inactive.sh` (migrations no-op; the seam) → switch), the WHY for both 045 and 046, and the rollback procedure. (b) `Deploy/SECURITY.md` §7 — sanctioned-exception paragraph added: the flag is typed by a human against a stopped stack; the scripted path still never passes it (migrate.py's gate NOT weakened — the deploy scripts remain unflagged). (c) Permanent cold-standup fix: `Deploy/local-standup.sh` accepts an explicit opt-in `--allow-destructive` (passed through to dry-run + apply; safe on an empty DB where 045's drops are `IF EXISTS` no-ops), with usage docs in its header and a remediation hint in its failure message. First-time-setup step 5 in `Deploy/README.md` corrected (flag + password step). |
| B-3 (integration; coordinates with 046 slice) | 046 is an expand/contract violation — the live old color's `ON CONFLICT (user_id)` loses its arbiter (42P10) in the migrate→flip window, and post-flip auto-rollback lands old code on the new schema | **FIXED per the user's decision (brief-downtime release; 046 schema unchanged)** | Documented as the Group-1 release deploy in `Deploy/README.md` (same new section): why zero-downtime overlap is unsafe for this release (the history model is incompatible with the old one-row-per-user unique), the stop-active-first ordering that guarantees no old-code-on-new-schema overlap, the explicit warning that rollback-by-flip is OFF for this window, and the brief-downtime rollback (stop new color → `run_migrate --allow-destructive --target 044 down` → restart old color, with the 047-down `DATABASE_URL` caveat). "After this release" note states normal zero-downtime blue/green resumes. Migration 046's schema untouched (comment-only edits, see SF rows). The 045-FK sibling note (old-color drill inserts) is covered by the same section's premise: the old color is stopped before anything applies. |

## SHOULD-FIXes

| # | Finding | Disposition | Where |
|---|---|---|---|
| topik S-1 (high) | READ-COMMITTED race: a PUT overlapping the open submit tx slips past the fresh-completed guard (arbiter insert-retry is not re-guarded) and resurrects an active row | **FIXED** | `server/src/routes/topik.ts` — new `ATTEMPT_LOCK_SQL` (`pg_advisory_xact_lock(hashtextextended('topik_attempt:' \|\| $1::text, 0))` — xact-scoped so it can't leak, namespaced, BIGINT-safe). PUT `/topik/attempt` now runs its upsert inside `withTransaction` with the lock as the first statement; `/mock/submit`'s existing transaction takes the same lock first. The lifecycle comment block documents the closed window. **Test added:** `topik.test.ts` "a PUT overlapping an OPEN submit transaction waits on the per-user advisory lock and is then refused" — holds a manual tx with the lock + status flip, asserts the racing PUT has NOT settled after 250 ms, commits, asserts 204 + no active row + exactly one completed row. |
| topik S-2 | 046.down mass-DELETEs history + DROP COLUMNs without tripping the destructive gate; the test's flag quietly masks it | **FIXED (documentation + procedure) / gate-widening DEFERRED with rationale** | Prominent `!! DATA-LOSS WARNING` block in `046_topik_attempts_history.down.sql`'s header (gate does not match DELETE/DROP COLUMN; treat every 046 rollback as deliberate loss; flag required by procedure); the runbook's rollback section flags the data loss and mandates the flag; the masking test call now carries an honest comment (`test_migration_046.py`, above the down call). **Widening `DESTRUCTIVE_PATTERNS` rejected:** `DELETE FROM` appears in legitimate guarded forward migrations (045's orphan purge) and `DROP COLUMN` in non-lossy ups (041 drops `book_uploads.blob_ref`) — widening would force `--allow-destructive` onto routine applies of the existing chain, eroding the gate's signal and breaking fresh-DB applies at 041. Not low-effort-safe → documented in the down header, the `db/README.md` gate section ("Known limitation"), and here. Ticket-worthy follow-up: a per-file `-- migrate:destructive` marker. |
| dbinfra SF-1 / topik S-3 / integration S-3 | Stale "(There is no 045)" comment; `PRE_046 = "044"` is really pre-045 | **FIXED** | `db/tests/test_migration_046.py:60-67` — comment rewritten: 045 exists; 044 is a deliberate seed target (045 would force the flag onto the seed-stage up and touches neither table 046 transforms, so 044 IS the pre-046 shape for the assertions). Constant name kept (call sites unchanged), choice documented. |
| dbinfra SF-2 | 045 FK comment overstates the CASCADE (app soft-deletes; cascade never fires on the unbank path) | **FIXED** | `045_hygiene_cleanup.up.sql` — header "WHY THE FK" rewritten and the persisted `COMMENT ON CONSTRAINT` reworded: CASCADE fires only on hard deletion (user-account CASCADE via 019 / manual psql); app unbanking is a soft delete that intentionally retains attempts; the FK's enforced value is the never-banked/hard-deleted class + orphan-class prevention. |
| dbinfra SF-3 | The manual release-day steps live only in SQL headers; `Deploy/README.md` silent | **FIXED** (subsumed by B-2) | The new runbook section covers all three steps (env precondition incl. the `${KM_APP_PASSWORD:?}` teardown gotcha, the one-time flagged apply, the password step) in one rollout sequence, as the dbinfra reviewer's Coordination note asked. |
| integration S-1 | The "dry-run gate" doesn't gate — dry-run never evaluates `contains_destructive`, so the abort lands at apply with misleading restore advice | **FIXED (took the runner-change option)** | `db/migrate.py` — `cmd_migrate` and `cmd_rollback` dry-run branches now evaluate the destructive gate on the planned bodies (marker printed per destructive migration; `DestructiveBlocked` raised → exit 1), module docstring updated; ADR-010 amendment note added (`db/docs/ADR-010-migration-runner-choice.md`). `azure-deploy-inactive.sh` step-4 comments + error messages corrected (dry-run failure = nothing applied, no restore needed; apply failure text now explains atomicity instead of reflex backup-restore advice). **Tests added:** `test_migrations.py::test_dry_run_evaluates_destructive_gate` and `::test_dry_run_down_evaluates_destructive_gate` (blocked without flag, plans-without-executing with it). |
| integration S-2 | Restore-reconcile docs wrong for 045/046 | **FIXED** | `Deploy/README.md` restore drill + `VERIFICATION.md` §8.5 — both now carry the 045 destructive-gate caveat and the "046 is not old-code-safe" caveat with a runbook pointer. |
| integration S-4 | Dev quickstarts break on fresh DBs | **FIXED** | `README.md` (root, local-dev block) and `db/README.md` (runner usage block) — one fresh-DB note each: pass `--allow-destructive` once, safe on an empty DB. The existing `DestructiveBlocked` troubleshooting row already pointed the right way. |
| integration S-5 / dbinfra N-1 | `strip_sql_noise` docstring falsely claims `contains_destructive` uses it | **FIXED (docstring, not the function)** | `db/migrate.py` — docstring now states `contains_top_level_tx_control` ONLY, spells out that `contains_destructive` scans string literals (and why erring toward false-positive is correct for a data-loss gate), citing 047's workaround. Behavior unchanged — changing the function would silently loosen the gate. Also corrected `db/README.md`'s gate description, which additionally mis-listed `DROP TYPE`/`DROP INDEX` as gated (they are deliberately not). |

## NITs

| Finding | Disposition |
|---|---|
| integration NIT: unneeded `--allow-destructive` on the test's down call, uncommented | **FIXED (comment)** — flag kept deliberately (matches the documented rollback procedure; the loss is real even though the gate can't see it), now says so (`test_migration_046.py`). |
| integration NIT: migrations README 045 row doesn't say the scripted deploy aborts | **FIXED** — row now notes the scripted abort + runbook pointer; 046's row also gained a "NOT expand/contract" note (`db/migrations/README.md`). |
| integration NIT: 047.down's DATABASE_URL-repoint belongs in the runbook | **FIXED** — rollback section carries the caveat. |
| topik N-1: 046.up's DISABLE TRIGGER lock-level claim (says ACCESS EXCLUSIVE; is SHARE ROW EXCLUSIVE since 9.5) | **FIXED** — comment corrected in `046...up.sql`; conclusion unchanged. (The down file makes no lock claim — nothing to fix there.) |
| topik N-2: new-mock-overwrites-active leaves no history row (F-078/F-082 data gap) | **FIXED (design note)** — "KNOWN DATA GAP" block added to the PUT route doc in `topik.ts` with the abandon-then-insert alternative, so F-078 planners see it at the data's write site. Behavior deliberately unchanged (037 parity). |
| topik N-3: 046.down re-encodes abandoned rows as completed tombstones | **FIXED (documented)** — header bullet added: deliberate, self-expiring (15 s), and why the exact alternative destroys more rows. |
| dbinfra N-2: km_app keeps PUBLIC's TEMP privilege | **DEFERRED** — optional hardening the reviewer marked "Not required by B-030"; touching 047's grants again in a fix-pass buys nothing now. Follow-up: `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC` in a future hardening migration. |
| dbinfra N-3 (conname guard without conrelid), N-4 (password URL-safety by convention), N-5 (test-only f-string DDL) | **REJECTED (leave as-is)** — reviewer's own analysis: house pattern consistency wins (N-3); mitigated + acceptable (N-4); parameterization impossible for DDL, constant test-only literal (N-5). |

## PRAISE items — untouched

No PRAISEd behavior was altered: `fa361df`'s test flags stay (one gained a comment), ADR-013 compliance holds in all edited SQL (comment-only changes to 045/046 bodies; 047's new `DO $$` block is the house guard pattern — no top-level tx control; the 32-test run proves discovery still accepts all files), the password architecture, runner-stays-superuser wiring, and the 046 transform/tests are untouched.

## Notes for the re-reviewer

* **Checksums:** 045.up, 046.up, and 047.up were edited (comments; 047 also gained the guard), so their SHA-256 changed. The branch is unmerged/undeployed and `db/tests` copy the files fresh per test, so nothing recorded can mismatch. Any local dev DB that applied the pre-fix branch chain will hit `ChecksumMismatch` and should be rebuilt (`make db-reset`) — deliberate, per the runner's contract. 046.**down** edits are checksum-irrelevant (downs are not checksummed).
* **`migrate.py` dry-run change is a strictly earlier evaluation of the existing gate** — no new flag, no weakening; `--dry-run up` on a fresh chain now requires the same flag the apply would. `local-standup.sh --allow-destructive` covers the only scripted caller that legitimately hits it.
* The advisory-lock test contains one timing assertion (250 ms un-settled check). It is asserting *blocked*, not *fast*, so it fails only if the lock is NOT taken — flake risk is one-sided and low.

## Addendum — final gate re-run

After the last edit (047 ROLLOUT-ORDER comment), the container db-suite was re-run:
**32 passed in 20.23s**. The server suite was not re-run after that comment-only
edit (pg.ts executes the file verbatim; the guard block itself was already in the
84-pass run).
