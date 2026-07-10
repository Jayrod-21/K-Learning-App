# RE-REVIEW — Phase-2 Group 1 fix-pass verification

**Re-reviewer:** independent (did not author the code, the original reviews, or the fix-pass)
**Branch:** `feat/phase2-g1-db-foundation` (fix-pass working tree on top of `fa361df`, uncommitted)
**Inputs verified against code:** `REVIEW_phase2g1_{dbinfra,topik,integration}.md`, `FIX_REPORT_phase2g1.md`
**Date:** 2026-07-10

---

## Summary verdict: **PASS**

All 3 BLOCKERs and all SHOULD-FIXes are genuinely fixed, verified against the
actual code and by re-running both gates myself. The two deferrals are sound and
documented at the point of risk; the three rejections match the original
reviewers' own analyses. No regressions, no undone PRAISE mechanisms, no scope
creep — every changed file maps to a specific finding. `migrate.py`'s
destructive gate is NOT weakened: `DESTRUCTIVE_PATTERNS` and the `apply_one`
check are byte-identical to `rebuild`; the only runner change evaluates the
same gate strictly *earlier* (at dry-run), and the only new flag surface
(`local-standup.sh --allow-destructive`) is an explicit off-by-default opt-in
that rejects unknown arguments.

**Gate results (run by this re-reviewer, real counts):**

| Gate | Result |
|---|---|
| DB container harness (exact task command, `db/tests` minus `test_discriminator_coverage`) | **32 passed in 22.33s** (29 pre-existing + 3 new) |
| Server topik suite (`npx vitest run tests/routes/topik.test.ts`, existing node_modules) | **84 passed (84) in 80.08s** (83 pre-existing + 1 new) |
| `tsc --noEmit` (server) | clean |
| `eslint` on the two changed server files | 0 errors; 2 warnings (`no-non-null-assertion`, `topik.ts:264,1265`) — **both pre-existing** in the branch commits, untouched by the fix-pass |
| **B-1 before/after empirical repro** (raw psql apply of 001+047 on a DB with NO `schema_migrations`, exactly the `pg.ts` path) | pre-fix 047 (committed at `fa361df`): `ERROR: relation "schema_migrations" does not exist` at `:131`. Fixed 047 (working tree): applies cleanly through both `ALTER DEFAULT PRIVILEGES` statements. |

The pg `DeprecationWarning` ("client.query() when the client is already
executing") appeared once in my 84-pass run too — consistent with the fix
report's stash-verified claim that it pre-exists the server changes.

---

## Finding-by-finding verification

| Finding | Source | Orig severity | Fix status | Notes (what I verified) |
|---|---|---|---|---|
| 047 unguarded REVOKE on `schema_migrations` bricks raw-SQL appliers | integration B-1 / topik B-1 | BLOCKER | **FIXED** | `047_km_app_role.up.sql:148-153`: REVOKE wrapped in `DO $$ ... IF to_regclass('public.schema_migrations') IS NOT NULL`; false header claim corrected at `:12-19`. Security intent intact: denial-matrix test still asserts INSERT/UPDATE/DELETE on `schema_migrations` → 42501 as km_app (`test_km_app_role.py:207-209,266-269`), and the new regression test (`test_047_raw_sql_apply_without_schema_migrations`, `:282-335`) genuinely exercises BOTH paths — raw verbatim apply with no runner and no bookkeeping table (asserts the table was never created, role exists, grants live), then creates the table via `migrate.SCHEMA_MIGRATIONS_DDL`, re-applies 047, and asserts the REVOKE fired (SELECT kept, writes revoked). I additionally reproduced the pre-fix failure and post-fix success empirically (table above). Server suite 84/84; `pg.ts` untouched (0-line diff). |
| Deploy can't ship the release; runbook silent; SECURITY.md contradicts it | integration B-2 (+ dbinfra SF-3) | BLOCKER | **FIXED** | `Deploy/README.md` §"Shipping Phase-2 Group 1 (migrations 045–047)": ordered env → build/tag → backup → **stop active color** → `run_migrate --allow-destructive up` → `set-km-app-password.sh` → `azure-deploy-inactive.sh` (migrations no-op) → flip. I traced every command: `compose_color`/`check-active-env.sh --get-active`/`run_migrate` all exist with the documented semantics; `DEPLOY_DIR` resolves from `BASH_SOURCE` so sourcing from repo root works; `--allow-destructive` is a parser-level flag so the flag-before-subcommand form is valid; step 0's `.env` precondition covers the `${KM_APP_PASSWORD:?}` teardown gotcha; after step 4 the pending set is empty so step 6's unflagged dry-run passes. A deployer following it succeeds without aborting. `Deploy/SECURITY.md` §7 sanctioned-exception paragraph added — human-typed flag against a stopped stack, scripted path still never passes it (`azure-deploy-inactive.sh` mentions the flag only in the comment saying it never passes it). `local-standup.sh` opt-in flag: bash-array passthrough safe under `set -u`, unknown args rejected (exit 2), `--allow-destructive` reaches both dry-run and apply, failure message names the remediation. First-time-setup step 5 corrected (flag + password step). One doc-ordering NIT found (NEW-1 below). |
| 046 expand/contract violation (old color 42P10; rollback-by-flip broken) | integration B-3 | BLOCKER | **FIXED** (per the accepted brief-downtime decision) | 046 up.sql schema is byte-unchanged except a 6-line lock-level comment correction — end state intact, verified via `git diff HEAD`. The runbook documents the WHY precisely (old `ON CONFLICT (user_id)` cannot infer the partial arbiter → 42P10 on every save), the stop-active-first ordering that eliminates old-code-on-new-schema overlap, the explicit rollback-by-flip-is-OFF warning with "do NOT restart the old color against the migrated schema", and the brief-downtime rollback incl. the 047-down `DATABASE_URL` caveat and the 046.down data-loss warning. No zero-downtime claim anywhere for this release; "After this release" resumes normal blue/green. 045's FK sibling note is covered by the stopped-active premise. |
| PUT/submit READ-COMMITTED resurrect race | topik S-1 (high) | SHOULD-FIX | **FIXED** | `topik.ts:765-766`: `pg_advisory_xact_lock(hashtextextended('topik_attempt:' \|\| $1::text, 0))` — BIGINT-safe, namespaced, per-user. PUT now runs inside `withTransaction` with the lock as statement #1 (`:871-872`); `/mock/submit`'s existing tx takes the same lock first (`:1228`). Race closed: a PUT arriving during an open submit blocks on the lock; post-commit its guard subquery gets a fresh READ-COMMITTED statement snapshot and sees the completed row → refuses. No deadlock: both writers take the single advisory key before any row lock (consistent order); `DELETE /attempt` takes no lock but is a single UPDATE that can only wait on a row lock — no cycle. No leak: xact-scoped, and `withTransaction` ROLLBACKs on error (destroying the connection if ROLLBACK itself fails — session death releases advisory locks). The upsert SQL body is otherwise byte-identical to the pre-fix version. New test (`topik.test.ts:1778-1842`) holds a manual tx with the same lock + status flip, asserts the PUT is unsettled at 250 ms, then 204 + no active row + exactly one completed row. Note: the 250 ms assertion alone would also have passed pre-fix (the speculative insert blocks on the row lock either way) — but the final-state assertions (`attempt` null, `{completed: 1}`) are exactly what the pre-fix retry-without-reguard violated, so the test genuinely discriminates. Flake risk one-sided as claimed. |
| 046.down mass-DELETE/DROP COLUMN evades the destructive gate | topik S-2 | SHOULD-FIX | **FIXED (docs+procedure) / gate widening DEFERRED-WITH-DOC** | `!! DATA-LOSS WARNING` block in `046...down.sql:23-36` names the exact gap and mandates the flag by procedure; runbook rollback flags it; the test's flag now carries an honest comment (`test_migration_046.py:298-304`). Deferral verified sound against the code: `DELETE FROM` appears in 045's legitimate guarded forward purge (`045...up.sql:129`) and `DROP COLUMN` in 041's non-lossy up (`041:121`, `book_uploads.blob_ref`) — widening would force the flag onto routine applies of the existing chain and break fresh-DB applies at 041. Documented in 3 places + `db/README.md` "Known limitation". Follow-up (per-file `-- migrate:destructive` marker) is the right shape. |
| Stale "(There is no 045)" comment; `PRE_046` misdescribed | dbinfra SF-1 / topik S-3 / integration S-3 | SHOULD-FIX | **FIXED** | `test_migration_046.py:60-66` rewritten: acknowledges 045, explains 044 as a deliberate seed target (gate avoidance + 045 touches neither transformed table). Accurate — I checked 045 touches only indexes/bak-tables/`grammar_drill_attempts`. |
| 045 FK comment overstates CASCADE | dbinfra SF-2 | SHOULD-FIX | **FIXED** | Header `:49-63` + `COMMENT ON CONSTRAINT` `:143-151` reworded: CASCADE fires only on hard deletion; app unbanking is a soft delete that retains attempts; FK's enforced value = never-banked class + orphan prevention. Matches the reviewer's requested wording. Comment-only change. |
| Release-day steps only in SQL headers | dbinfra SF-3 | SHOULD-FIX | **FIXED** (subsumed by B-2) | Single rollout sequence in the runbook, incl. the `${KM_APP_PASSWORD:?}` precondition, exactly as the Coordination note asked. 047's ROLLOUT ORDER header now points at the runbook as normative. |
| Dry-run doesn't evaluate the destructive gate | integration S-1 | SHOULD-FIX | **FIXED** | `migrate.py` `cmd_migrate`/`cmd_rollback` dry-run branches evaluate `contains_destructive` on the planned up/down bodies, print a per-migration DESTRUCTIVE marker, raise `DestructiveBlocked` (subclass of `MigrationError` → `main()` exits 1 — traced). Module docstring + ADR-010 amendment note added. `azure-deploy-inactive.sh` step-4 comments/error text corrected (dry-run failure = nothing applied; apply-failure text explains per-migration atomicity instead of reflex restore advice). Two new tests verify blocked-without-flag and plans-without-executing-with-flag, both directions. Gate strictly earlier, never looser. |
| Restore-reconcile docs wrong for 045/046 | integration S-2 | SHOULD-FIX | **FIXED** | `Deploy/README.md:286-294` + `VERIFICATION.md:269-273`: 045 `DestructiveBlocked` caveat + "046 not old-code-safe" caveat with runbook pointer, both present. |
| Dev quickstarts break on fresh DBs | integration S-4 | SHOULD-FIX | **FIXED** | Root `README.md:28-31` and `db/README.md:99-103`: fresh-DB flag note, `IF EXISTS` no-op rationale (verified: all of 045's drops use `IF EXISTS`). |
| `strip_sql_noise` docstring false claim | integration S-5 / dbinfra N-1 | SHOULD-FIX/NIT | **FIXED (docstring)** | Docstring now states `contains_top_level_tx_control` ONLY + the string-literal consequence with the 047 workaround cited; behavior unchanged (correct call — changing the function would loosen the gate). `db/README.md` gate description also corrected — it had mis-listed `DROP TYPE`/`DROP INDEX` as gated; the new text matches `DESTRUCTIVE_PATTERNS` exactly and explains why recreatable-object drops are ungated. |
| Unneeded flag on test's down call, uncommented | integration NIT | NIT | **FIXED (comment)** | Honest comment added; flag deliberately kept to match the documented rollback procedure. Defensible. |
| Migrations README 045 row silent on scripted abort | integration NIT | NIT | **FIXED** | 045 row notes the scripted abort + runbook pointer; 046 row gained the "NOT expand/contract" + ungated-down note. |
| 047.down `DATABASE_URL` repoint belongs in runbook | integration NIT | NIT | **FIXED** | Rollback section carries it verbatim ("pre-047 compose file/checkout"). |
| 046.up lock-level claim (ACCESS EXCLUSIVE vs SHARE ROW EXCLUSIVE) | topik N-1 | NIT | **FIXED** | Comment corrected (PG ≥ 9.5, SHARE ROW EXCLUSIVE, weaker than the ADD COLUMN/CONSTRAINT locks); conclusion unchanged. Only change to 046.up. |
| New-mock-overwrites-active leaves no history row | topik N-2 | NIT | **FIXED (design note)** | "KNOWN DATA GAP" block at the PUT route doc (`topik.ts:855-861`) with the abandon-then-insert alternative — at the data's write site, where F-078 planners will see it. Behavior unchanged (deliberate 037 parity). |
| 046.down re-encodes abandoned rows as completed tombstones | topik N-3 | NIT | **FIXED (documented)** | Header bullet (`046...down.sql:17-23`): deliberate, self-expiring 15 s, alternative destroys more rows. |
| km_app keeps PUBLIC's TEMP privilege | dbinfra N-2 | NIT | **DEFERRED-WITH-DOC** | Reasonable — original reviewer marked it "Not required by B-030"; right home is a future hardening migration, not a fix-pass edit to 047's grants. |
| conname guard w/o conrelid; password URL-safety; test f-string DDL | dbinfra N-3/N-4/N-5 | NIT | **REJECTED (leave as-is)** | All three match the original reviewer's own analysis (house-pattern consistency; mitigated-by-instruction + hex requirement now also in the runbook; DDL can't be parameterized). Sound. |

## Regressions / PRAISE / scope check

- **`git diff rebuild --stat` / `git diff HEAD --stat`:** 19 working-tree files
  changed, every one attributable to a specific finding above. No file outside
  the finding set was touched; `server/tests/helpers/pg.ts` untouched (the fix
  correctly landed in 047, not the harness).
- **PRAISEd mechanisms intact, verified directly:** 046's transform/tests
  untouched (up diff = 6 comment lines); `fa361df`'s test flags kept;
  `set-km-app-password.sh`, compose wiring, and the runner-stays-superuser
  path all 0-line diffs vs the branch commits; ADR-013 holds in all edited SQL
  (047's new guard is a `DO $$` block — no top-level tx control; the 32-test
  run proves discovery still accepts every file).
- **Checksums:** 045/046/047 up-file hashes changed — fine, branch
  unmerged/never runner-applied anywhere real; `db/tests` copy files fresh per
  test. (Noted per the task; matches the fix report's addendum.)

## New findings (this re-review)

1. **NEW-1 (NIT, doc-only):** `Deploy/README.md` rollback block orders
   `compose_color <new-color> down` *before* the
   `source Deploy/deployment-utils.sh && load_environment` line. In a fresh
   shell the first command fails with "command not found" — fails safe
   (nothing executed), and the forward procedure two paragraphs up sources
   first, so the operator will spot it — but the two lines should be swapped.
2. **NEW-2 (observation, not a defect):** the advisory-lock test's 250 ms
   "still blocked" assertion would also have passed pre-fix (the speculative
   insert blocks on the submit's row lock either way); the test's real teeth
   are the final-state assertions, which do discriminate. No action needed —
   recording so a future refactor doesn't treat the timing assertion as the
   proof.
3. **NEW-3 (observation):** two pre-existing eslint `no-non-null-assertion`
   warnings in `topik.ts` (`:264`, `:1265`) — present in the branch commits,
   not introduced or worsened by the fix-pass. The fix report's "clean
   (exit 0)" is accurate (warnings don't fail eslint).
4. **NEW-4 (housekeeping):** untracked `.claude/` and
   `REDESIGN_SEOUL_NEON_BRIEF.md` sit in the working tree — unrelated to this
   work; keep them out of the eventual commit.

## Recommendation

**Ready to ship.** Commit the working tree (fixing NEW-1's two-line swap in the
same commit), push, and let CI run the server testcontainer job — the one gate
no local run can substitute (per the branch-never-pushed history on B-1).
Follow-ups to ticket, none blocking:

- Per-file `-- migrate:destructive` marker for the gate (the S-2 deferral's
  proper fix).
- `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC` hardening migration
  (dbinfra N-2).
- The F-078/F-082 design decision on the overwrite-in-place data gap
  (topik N-2's note is now where they'll find it).

No further fix-pass required.
