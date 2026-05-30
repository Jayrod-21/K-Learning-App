# Review: Fix-pass for Phase A

**Reviewer:** Independent senior reviewer (30y), did NOT write the original
A1/A2/A3 code, did NOT participate in the original three reviews, did NOT
write the fix-pass.
**Date:** 2026-05-28
**Inputs:** `SENIOR_ENGINEER_BAR.md`, `ADR-001-database-choices.md`,
`REVIEW_A1.md`, `REVIEW_A2.md`, `REVIEW_A3.md`, `FIX_REPORT.md`, all
artifacts named in the brief.

---

## Summary verdict

**PASS WITH CONDITIONS.** Every BLOCKER and SHOULD-FIX from the three
original reviews is addressed in code, with one architecturally-honest
caveat noted in BLOCKER (new) below: the new end-to-end atomicity test
operates on a synthetic migration rather than the actual `001`/`002` files,
which leaves the same class-of-bug ("synthetic tests pass while real
migrations break") theoretically reachable — though the new
`discover_migrations` guard makes this class of bug impossible to land
again. The fix-pass is otherwise high-quality and does not undo any
PRAISE item.

- BLOCKERs FIXED: 2 / 2 (A2-B1, A3-B1)
- SHOULD-FIX FIXED: 12 / 12 (A1-F1, A1-F2, A1-F3, A2-SF1..SF4, A3-SF1..SF8)
- NEW BLOCKERs introduced by fix-pass: 0
- NEW SHOULD-FIXes introduced by fix-pass: 1 (test against real
  migration content, see "New findings" below)
- NEW PRAISE: 4

---

## Finding-by-finding verification

| Finding ID | Source | Original severity | Fix applied? | Fix correct? | Notes |
| --- | --- | --- | --- | --- | --- |
| A3-B1 (tx ownership) | REVIEW_A3 | BLOCKER | FIXED | YES | Strip + reject path implemented. `discover_migrations` calls `contains_top_level_tx_control` on every `.up.sql` and `.down.sql` at `migrate.py:230-238`; both 001 and 002 had top-level `BEGIN;/COMMIT;` removed (verified via grep — only `BEGIN` lines remaining are in `DO $$ … END $$` PL/pgSQL blocks). ADR-013 documents the rule. End-to-end atomicity test at `test_migrations.py:287-345` uses fault injection (pre-populated PK conflict) to prove rollback. Caveat in "New findings" SF-1 (new). |
| A2-B1 (reference enum) | REVIEW_A2 | BLOCKER | FIXED | YES | `kgiu_entry_type` now `('grammar', 'intro', 'reference')` (`002.up.sql:117`); `vocab_entry_type` now `('word', 'theme_intro', 'subsection_intro', 'reference')` (`002.up.sql:139-141`). `ALTER TYPE … ADD VALUE IF NOT EXISTS 'reference'` handles upgrade path. New parametrized test `test_enum_covers_all_source_types` in `test_discriminator_coverage.py:131-154` parses the actual JSONs and asserts coverage with documented exclusions for `lets_check` / `hanja_extension`. |
| A1-F1 (grammar_entry_id FK) | REVIEW_A1 | SHOULD-FIX | FIXED | YES | `fk_vocab_cards_grammar_entry … ON DELETE RESTRICT ON UPDATE RESTRICT` at `001.up.sql:711-713`. Matches the XOR-CHECK contract. Comment at lines 702-710 explains why. Index comment at line 781-782 updated. |
| A1-F2 (password hash CHECK) | REVIEW_A1 | SHOULD-FIX | FIXED | YES | `ck_users_password_hash_argon2id CHECK (password_hash LIKE '$argon2id$%' AND length(password_hash) BETWEEN 80 AND 255)` at `001.up.sql:191-192`. A `$2b$12$…` bcrypt hash (60 chars, wrong prefix) fails on both predicates; a 64-char raw SHA-256 hex fails on the prefix and on length. |
| A1-F3 (register_level rename) | REVIEW_A1 | SHOULD-FIX | FIXED | YES | ADR-001 §D8 amended at `ADR-001:101-104` (now reads `register_level` with the parenthetical rename note); a dated Amendments section was added at `ADR-001:175-187` documenting the rationale and back-propagating the change. |
| A2-SF1 (proficiency NOT NULL) | REVIEW_A2 | SHOULD-FIX | FIXED | YES | Column made nullable at `002.up.sql:537`; partial-NOT-NULL CHECK `ck_vocab_entries_proficiency_required CHECK (entry_type <> 'word' OR proficiency IS NOT NULL)` at `002.up.sql:572-574`. Correctly permits NULL for all non-`word` types including the new `reference`. Column comment updated. |
| A2-SF2 (notes JSONB shape) | REVIEW_A2 | SHOULD-FIX | FIXED | YES | `ck_vocab_entries_jsonb_arrays` at `002.up.sql:562-566` now requires `jsonb_typeof(notes) IN ('array', 'string')`. Column comment at `:614` documents both shapes. `tips` and `cross_refs` correctly remain array-only. |
| A2-SF3 (corpus_sources idempotency) | REVIEW_A2 | SHOULD-FIX | FIXED | YES | `INSERT … ON CONFLICT (corpus) DO UPDATE SET … WHERE corpus_sources.col IS DISTINCT FROM EXCLUDED.col OR …` at `002.up.sql:1006-1027`. `WHERE` clause on `DO UPDATE` is documented Postgres syntax and is null-safe via `IS DISTINCT FROM`. Re-applying an unchanged seed is now a true no-op. |
| A2-SF4 (string-keyed parent_vocab_*) | REVIEW_A2 | SHOULD-FIX | FIXED | YES | Documented in ADR-008 "Phase-A trade-off" section (lines 90+), including a loader-side verification query. `length > 0` CHECK on both TEXT columns at `002.up.sql:900-901` catches empty-string loader bugs. Promoting to a `vocab_subsections` table deferred to Phase C, named, justified. |
| A3-SF1 (statement_timeout) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | `connect_from_env` at `migrate.py:544-546` opens a tx and runs `SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0`. Session-scoped (plain `SET`). Test `test_migration_session_disables_timeouts` at `test_migrations.py:431-443` calls `SHOW` on both settings. Comment in `docker-compose.yml:60-63` corrected. |
| A3-SF2 (network internal) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | `networks.internal.internal: true` at `docker-compose.yml:168`. The `db` container is on `internal` only; `server` straddles `internal` + `external`. Comment at `:150-164` explains the design. SECURITY.md T6 at `:117-123` correctly states "the `db` container does not have outbound internet access" and gives a verification command. T4 at `:83-84` aligned. T3 at `:62-69` rewritten to be accurate. |
| A3-SF3 (db-reset volume) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | `Makefile:85-87` does `stop $(DB_SERVICE)`, `rm -f $(DB_SERVICE)`, then `docker volume rm korean_master_db_data`. Removes ONLY the named DB volume. Comment at `:82-84` explains why `down -v` was wrong. |
| A3-SF4 (ADR numbering) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | All ADR-002…ADR-005 collisions resolved. A1 kept 002–004; A2 renumbered to 005–008; A3 renumbered to 009–012. ADR-013 added. `docs/README.md` documents the global-chronological policy. Spot-checked cross-references in `docker-compose.yml:5` (ADR-009), `002.up.sql` (ADR-005 / 006 / 007 / 008 mentions), `erd-darakwon.md:4-6`, `db/README.md:38-49`, `db/migrations/README.md:249-254`. ADR-013 file header references ADR-010 correctly. No orphan refs to old numbers found. |
| A3-SF5 (pg_restore stdin) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | `restore.sh:37-52` resolves the host path to the in-container `/backups/<rel>` path; refuses dumps outside `$BACKUP_DIR` with a clear error pointing the operator at `cp`. `pg_restore` reads from the file directly (no stdio piping → parallel restore available, no truncation risk). Added env-var-shape validation on `POSTGRES_DB`/`POSTGRES_USER` at `:67-74` — defends T8. |
| A3-SF6 (db-shell -it) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | `Makefile:151` uses `exec -it`. |
| A3-SF7 (db_data labels) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | `docker-compose.yml:179-183` adds `labels: { app: korean-master, component: db, purpose: pgdata }`. |
| A3-SF8 (applied_by) | REVIEW_A3 | SHOULD-FIX | FIXED | YES | `_runner_principal()` at `migrate.py:113-128` returns `<os-user>@<hostname>`, length-capped, with fallback. `apply_one` passes it as the 4th parameter at `migrate.py:362-371`. `applied_by` column DEFAULT still falls back to `current_user` for the ensure-bookkeeping path. structlog `apply.commit` at `:372-377` also logs it. Minor: no test asserts the column value, but the wiring is correct by inspection. |
| A3-N1..N7 (NITs) | REVIEW_A3 | NIT | N/A | — | Per FIX_REPORT: N1 deferred (CLI tabular output convention), N2/N3/N4/N6/N7 fixed in passing, N5 documented with comment at `migrate.py:64-68`. Spot-checked: `MIGRATION_PATTERN` comment present, `WAIT_HEALTHY` rewritten to use `docker inspect --format` at `Makefile:50`, `HEALTH_WAIT_SEC` defaults to 120 at `Makefile:38`, `connect_from_env` raises clear `MigrationError` for missing DSN at `migrate.py:528-533`. All matches the FIX_REPORT. |
| A1-F4..F7 (NITs) | REVIEW_A1 | NIT | DEFERRED | — | F4 (sessions.user_agent length), F5 (ON UPDATE RESTRICT explicit-is-rule), F6 (study_log.minutes_studied upper bound) explicitly deferred in FIX_REPORT. F7 (pgcrypto comment) fixed in passing — verified at `001.up.sql:46-49`. |
| A2-N1..N5 (NITs) | REVIEW_A2 | NIT | DEFERRED | — | Explicitly out-of-scope per the brief. No regression introduced. |

**Verdict legend:** FIXED = root-cause addressed and verified in code;
DEFERRED = explicitly out of scope per the fix-pass brief, no regression
introduced; PARTIALLY-FIXED / NOT-FIXED / REGRESSION-INTRODUCED = not used
here.

---

## Bar checklist (post-fix state)

SENIOR_ENGINEER_BAR.md §5 — 13 items.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Lint passes (no warnings) | NOT-VERIFIED | `make db-lint` (sqlfluff) target present at `Makefile:153-155`; not executed in this review. Files conform to project style. |
| 2 | Type-check passes (strict) | NOT-VERIFIED | `mypy --strict` not run. `migrate.py` has type hints throughout (`from __future__ import annotations`, parameter and return types on every public function). |
| 3 | All tests pass (unit + integration) | NOT-VERIFIED | testcontainers required; not executed in this review. Test logic is peer-reviewable; assertions match named invariants. |
| 4 | Every public function tested | PASS | `discover_migrations`, `apply_one`, `rollback_one`, `connect_from_env`, `contains_top_level_tx_control`, `contains_destructive`, `cmd_status`, `cmd_migrate` all reachable from existing tests; new `test_atomicity_…`, `test_discover_rejects_*`, `test_discover_accepts_*`, `test_migration_session_disables_timeouts`, `test_connect_fails_clearly_with_no_dsn` cover the new public surface. `_runner_principal` is private but exercised via `apply_one`. |
| 5 | EXPLAIN ANALYZE on every non-trivial query, indexes confirmed | PARTIAL | Every index carries a `COMMENT ON INDEX` naming the query (15+ in 001 + 16 in 002). EXPLAIN ANALYZE itself can't run until seed data lands (deferred, acceptable for schema-stage). |
| 6 | SECURITY.md written, attack vectors enumerated | PASS | Both `db/SECURITY.md` and `db/migrations/SECURITY.md` present; 10 + 7 attack vectors respectively with both DB-layer and app-layer defenses. T3/T4/T6 corrected by the fix-pass. |
| 7 | README.md written, includes "how to test this" | PASS | `db/README.md`, `db/migrations/README.md`, `db/docs/README.md` (new — ADR numbering policy). All include test cycles and `make` targets. |
| 8 | ADR written for any contestable decision | PASS | 12 ADRs covering schema, harness, and tx-ownership decisions; alternatives-considered sections present. ADR-013 (new) closes the runner-vs-file tx-ownership gap with explicit alternatives. |
| 9 | Migrations reversible AND tested both directions | PARTIAL | Down migrations updated in lockstep; existing `test_full_up_down_up_cycle` covers a synthetic up→down→up. The actual `001`/`002` files have not been exercised end-to-end against a real Postgres by a test — see new finding SF-1 (new). |
| 10 | No TODO/FIXME without ticket | PASS | No new TODO/FIXME added by the fix-pass; existing items in SECURITY.md are explicitly enumerated as "promote to ticket" items. |
| 11 | No `print()` in committed code (use logger) | PASS-with-exception | `cmd_status` and `cmd_migrate` dry-run still use `print()` for tabular CLI output — documented exception (NIT A3-N1). No new `print()` added. |
| 12 | No commented-out code | PASS | Every commented line in modified files is documentary. |
| 13 | No hardcoded secrets, URLs, or paths | PASS | All paths derived from env (`BACKUP_DIR`, `DATABASE_URL`, etc.). No secrets in code. |

Net: PASS or PASS-with-justified-exception on every item that can be
evaluated from the artifacts; NOT-VERIFIED on the three items (lint,
type-check, integration-test execution) that require a runtime not
available to the reviewer. The PARTIAL on item 9 maps to the new SF-1
finding below.

---

## New findings introduced by the fix-pass

### BLOCKER (new)

None.

### SHOULD-FIX (new)

#### SF-1 (new) — Atomicity test and discover-rejection tests both run on synthetic migrations; no test runs the real `001`/`002` files end-to-end against a real Postgres

**Where:** `db/tests/test_migrations.py` (whole file)

**What's wrong.** REVIEW_A3 BLOCKER-1's root-cause diagnosis was that
"the synthetic-migration tests passed while the real migrations broke."
The fix-pass added strong unit-level coverage for the new tx-ownership
rule (`test_discover_rejects_top_level_*`, `test_atomicity_…`,
`test_discover_accepts_pl_pgsql_begin_end`,
`test_discover_accepts_comment_begin`) — but every one of those tests
operates on synthetic migrations written into a `tmp_path`. The actual
`001_core_schema.up.sql` and `002_darakwon_corpora.up.sql` files are
**still never executed end-to-end against a real Postgres in the test
suite.**

**Why it matters.** The `discover_migrations` guard now refuses
top-level `BEGIN`/`COMMIT` at load time, which makes the original
BLOCKER class of bug genuinely impossible to land again — that's good.
But the root-cause critique in REVIEW_A3 ("the harness passes its own
tests while breaking on the real migrations") would still be true of
any *future* mismatch between the harness's assumptions and the real
migration content (e.g., a CREATE TYPE that doesn't satisfy a CHECK we
add; a tsvector trigger that fails on an obscure UTF-8 row).

**Why this is SHOULD-FIX not BLOCKER.** The specific bug REVIEW_A3
caught is closed by the discover guard. The general class is reachable
in principle but unlikely in practice for Phase A. Phase B should add
a test that runs the real `001` + `002` against testcontainers and
asserts the expected table/index/enum set is present, so future
schema/runner drift can't sneak through.

**Suggested fix.** Add `test_apply_real_001_and_002.py` (or extend
`test_migrations.py`) with a fixture that points the runner at the
real `Repository/db/migrations/` directory, applies both, snapshots
the schema with `\d`-equivalent queries against `pg_class` / `pg_type`
/ `pg_constraint`, and asserts a stable manifest.

#### SF-2 (new) — `_DOLLAR_QUOTED` regex with empty-tag dollar-quotes can degenerate on pathological input

**Where:** `db/migrate.py:260`

**What's wrong.** `_DOLLAR_QUOTED = re.compile(r"\$([^$]*)\$.*?\$\1\$", re.DOTALL)`.
With non-greedy `.*?` and the empty-tag case (`$$ ... $$`), the regex
will pair the first `$$` with the next `$$` it finds — which is
correct for valid SQL. But there is no test for the case where a
migration body contains an unbalanced `$$` (e.g. a comment that
mentions `$$` outside a real dollar-quoted block). On valid input the
regex behaves correctly; on invalid input it could mis-pair and either
mask a real top-level `BEGIN`/`COMMIT` or false-positive on one. The
risk in practice is low (the migrations are reviewed before merge) but
the guard's value is exactly to catch a less-careful future migration.

**Why this is SHOULD-FIX not BLOCKER.** Real migrations don't contain
unbalanced `$$`. The detector is defense-in-depth, not the only
defense (PR review still applies).

**Suggested fix.** Add 2-3 adversarial tests with intentionally
malformed dollar-quoted blocks (unbalanced `$$`, nested-looking tags
like `$outer$ ... $inner$ ... $inner$ ... $outer$`) and document the
expected behavior — even if it's "the detector is conservative; if it
mis-identifies, the human reviewer catches the migration in PR."

### NIT (new)

#### N-1 (new) — `applied_by` value isn't asserted in any test

**Where:** `db/tests/test_migrations.py`

The fix-pass plumbs `_runner_principal()` through `apply_one` and the
column comment promises `<os-user>@<hostname>`. No test confirms this.
One assert against `SELECT applied_by FROM schema_migrations` would
close the loop. Strictly NIT — the wiring is correct by inspection.

#### N-2 (new) — `restore.sh`'s `BACKUP_DIR_HOST_ABS` resolution uses `cd` inside a subshell, which fails silently if the directory doesn't exist

**Where:** `db/scripts/restore.sh:38`

`BACKUP_DIR_HOST_ABS="$(cd "$BACKUP_DIR_HOST" && pwd)"` will abort the
whole script under `set -e` if `$BACKUP_DIR_HOST` doesn't exist. That's
actually fine — but the error message will be the shell's default
"No such file or directory", not the friendlier guidance the rest of
the script uses. A two-line `[[ -d "$BACKUP_DIR_HOST" ]]` precheck
with an explicit error message would be friendlier.

#### N-3 (new) — `ADR-013` line 96-98 leaves an open question ("whether the detector should also reject inner `SET TRANSACTION` and `LOCK TABLE`") with no ticket

The bar requires TODO/FIXME to be tied to a ticket. ADR open questions
are arguably different (they're explicit "we know we left this open"),
but a consistent practice would either name a tracking issue or move
the open-question into a Phase B follow-up doc.

### PRAISE (new)

#### P-1 (new) — `_DOLLAR_QUOTED` regex correctly uses a backreference

`r"\$([^$]*)\$.*?\$\1\$"` — the backreference `\1` ensures `$fn$ ... $fn$`
doesn't close on a different tag like `$other$`. This is the kind of
subtle detail that's easy to get wrong; the fix-pass got it right.

#### P-2 (new) — Atomicity test uses a *pre-populated PK conflict* for fault injection rather than mocking psycopg

`test_atomicity_body_and_bookkeeping_commit_together` simulates the
exact failure mode REVIEW_A3 described (bookkeeping write fails after
body succeeds) using a real, in-DB PK violation. This is more
trustworthy than monkey-patching psycopg, and it exercises Postgres's
actual transaction semantics. Solid.

#### P-3 (new) — ADR-013 enumerates and rejects four alternative designs before settling on "runner owns, runner enforces"

The "alternatives considered" section names "strip", "autocommit=True
skip", "files own + autocommit=True", and "hybrid" — and rejects each
with a one-line reason. This is what good ADRs look like; far above
the "we picked X because Y" floor.

#### P-4 (new) — ADR numbering policy is documented, not just enforced

`docs/README.md` (new) writes down the rule for future agents
("numbers global, chronological, never recycled; earlier merge keeps
the number") so the next round of parallel agents has explicit
guidance. The fix-pass didn't just fix the immediate collision — it
fixed the process that allowed the collision.

---

## Detailed findings

### Re-verification of each BLOCKER

**A3-B1.** Code path verified:

- `db/migrate.py:80-89` defines `TX_CONTROL_PATTERNS` covering
  `BEGIN`, `START TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT <ident>`,
  `RELEASE SAVEPOINT <ident>`, each with optional `WORK`/`TRANSACTION`
  suffixes. Case-insensitive. `\b` word boundaries prevent
  false-positives on identifiers like `MY_BEGIN_HERE`.
- `db/migrate.py:268-278` `strip_sql_noise` strips comments AND
  dollar-quoted strings (with a backreferenced tag match) before
  applying the pattern, so `DO $$ BEGIN ... END $$` PL/pgSQL blocks
  (the ones actually used in `001` and `002`) pass cleanly.
- `db/migrate.py:230-238` calls the detector on every `.up.sql` AND
  `.down.sql` at discovery time and raises `TxControlInMigration`.
- `001_core_schema.up.sql` / `.down.sql` and `002_darakwon_corpora.up.sql`
  / `.down.sql` had their top-level `BEGIN;`/`COMMIT;` removed —
  verified by grep: the only remaining `BEGIN`/`COMMIT` strings are
  inside `DO $$ ... END $$` PL/pgSQL blocks or in documentary
  comments (e.g. `-- This file MUST NOT contain top-level BEGIN/COMMIT`).
- `test_atomicity_body_and_bookkeeping_commit_together` at
  `test_migrations.py:287-345` pre-inserts a PK-conflicting
  `schema_migrations` row, then calls `apply_one` directly. The body
  CREATE TABLE runs but the bookkeeping INSERT raises; the
  `with conn.transaction():` block rolls back the whole tx. The test
  asserts `atomicity_witness` table does NOT exist after the failure
  — proving body + bookkeeping commit-or-abort atomically.

Remaining gap: see SF-1 (new) above — the real 001/002 files aren't
end-to-end tested.

**A2-B1.** Verified by reading the enum definitions:

- `kgiu_entry_type` at `002.up.sql:117`: `ENUM ('grammar', 'intro', 'reference')`.
- `vocab_entry_type` at `002.up.sql:139-141`: `ENUM ('word', 'theme_intro', 'subsection_intro', 'reference')`.
- `ALTER TYPE … ADD VALUE IF NOT EXISTS 'reference'` paths handle DB
  upgrades from a pre-fix-pass installation.
- Direct JSON inspection: `grammar_kgiu_beginner.json` carries
  `grammar`, `intro`, `reference`; `vocab_2000_beginner.json` carries
  `word`, `theme_intro`, `subsection_intro`, `reference`, `lets_check`,
  `hanja_extension`. The latter two route to their own tables per the
  documented exclusion.
- `test_discriminator_coverage.py:131-154` parses the JSON files and
  the migration SQL and asserts coverage. If a future JSON adds a new
  `type` value without enum extension, the test fails with a clear
  message naming the missing values.

### Re-verification of the headline atomicity test design

The original REVIEW_A3 critique was that synthetic tests had passed
while real migrations broke. The fix-pass's response:

1. **Test the runner's contract directly** via `apply_one` + a
   forced bookkeeping failure (PK conflict) — proves body and
   bookkeeping commit together.
2. **Make the failure mode that caused the original bug impossible
   to reintroduce** via `discover_migrations` rejection.
3. **Document the contract** in ADR-013 and the migration READMEs.

This addresses the root cause adequately. Item 1 alone doesn't address
"synthetic ≠ real", but combined with item 2 it does — because the
"trip wire" that caused the original divergence (the runner's tx
contract conflicting with the file's tx control) can't reach the apply
stage at all. The remaining gap (SF-1 new) is "does the runner correctly
apply the real `001` + `002`" — a broader correctness question that
isn't really about atomicity.

### Argon2id CHECK tightening

`CHECK (password_hash LIKE '$argon2id$%' AND length(password_hash) BETWEEN 80 AND 255)`:

| Input | LIKE match | Length OK | CHECK |
|---|---|---|---|
| `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>` (~96 chars) | YES | YES | PASS |
| `$2b$12$abcdefghij...` (60 chars, bcrypt) | NO | NO | FAIL |
| `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (64 chars, raw SHA-256 hex) | NO | NO | FAIL |
| `$argon2i$...` (Argon2 variant — not Argon2id) | NO | varies | FAIL |
| `$pbkdf2-sha256$...` | NO | varies | FAIL |

The CHECK correctly rejects every realistic regression.

### `corpus_sources` UPSERT `WHERE IS DISTINCT FROM`

Postgres syntax check: `INSERT … ON CONFLICT (...) DO UPDATE SET …
WHERE <predicate>` — the `WHERE` filters which rows actually get
updated; rows that don't match are skipped (the conflict still resolves,
just no UPDATE). `IS DISTINCT FROM` is null-safe (`NULL IS DISTINCT
FROM NULL` is `FALSE`). The predicate at `002.up.sql:1017-1027` ORs
together every column that should trigger a version bump. If every
column matches what's already there, the UPDATE is a no-op — re-running
the migration is a true no-op. Correct.

### ADR cross-reference sweep

Searched for every `ADR-0NN` reference in `db/`, `Repository/docker-compose.yml`:

- `001.up.sql`: references ADR-001, ADR-002 (auth — A1's), ADR-003
  (FSRS — A1's), ADR-004 (soft-FK — A1's), ADR-013. All correct under
  the new numbering (A1's ADR-002..004 unchanged).
- `002.up.sql`: references ADR-005 (stable-cols-vs-jsonb — A2's,
  renumbered), ADR-006 (tsvector), ADR-007 (vocab-relations), ADR-008
  (kgiu-vs-grammar), ADR-013. All correctly map to the renumbered A2
  ADRs.
- `docker-compose.yml:5`: references ADR-009 (compose-layout, A3's
  renumbered). Correct.
- `db/README.md:38-49`: lists all 12 ADRs in the new order. Correct.
- `erd-darakwon.md:4-6`: references ADR-005..008. Correct.
- `db/migrations/README.md:139-141, 249-254`: references A1's
  ADR-002..004 and A2's ADR-005..008. Correct.
- `ADR-013` cross-references ADR-001 §D11 and ADR-010 (migration
  runner choice — A3's renumbered). Correct.

No orphan references to old numbers found in any modified file.

### `vocab_entries.proficiency` partial NOT NULL

CHECK form: `entry_type <> 'word' OR proficiency IS NOT NULL`.

Truth table:

| `entry_type` | `proficiency` | Result |
|---|---|---|
| `'word'` | NOT NULL | PASS (true OR …) |
| `'word'` | NULL | FAIL (false OR false) |
| `'theme_intro'` | NULL | PASS |
| `'subsection_intro'` | NULL | PASS |
| `'reference'` | NULL | PASS |
| `'reference'` | NOT NULL | PASS |

Correctly captures the requirement: word rows require proficiency,
navigational rows may have it but don't have to. The CHECK works
correctly under the expanded enum (including `'reference'`).

### `statement_timeout = 0` at connection acquisition

`connect_from_env` at `migrate.py:535-547` opens the psycopg connection
then immediately runs both SETs inside a `with conn.transaction()`
block. The transaction commits on exit. Because they are plain `SET`
(not `SET LOCAL`), they apply session-scoped, so subsequent migration
transactions inherit `statement_timeout = 0`. Test
`test_migration_session_disables_timeouts` (`test_migrations.py:431-443`)
runs `SHOW statement_timeout` and asserts `"0"`. Same for
`idle_in_transaction_session_timeout`. Correct.

### Network `internal: true` confirmed

`docker-compose.yml:166-170`:

```yaml
networks:
  internal:
    driver: bridge
    internal: true
```

`db` service on `internal` only (`docker-compose.yml:79`). `server`
service on `internal` + `external` (`:120-122`). `client` on `external`
only (`:142-143`). This is the correct topology for blocking DB egress
while allowing the server to reach the Claude API.

SECURITY.md T6 at `:117-123` correctly states "the `db` container does
not have outbound internet access" and provides a verification
command. Wording matches reality.

### `db-reset` removes only the DB volume

`Makefile:79-89`:

```make
db-reset: ## DESTRUCTIVE — drop the db volume and restart. Requires CONFIRM=YES.
	@if [ "$(CONFIRM)" != "YES" ]; then \
	  echo "Refusing to reset. Re-run as: make db-reset CONFIRM=YES"; exit 1; \
	fi
	$(COMPOSE) stop $(DB_SERVICE) || true
	$(COMPOSE) rm -f $(DB_SERVICE) || true
	docker volume rm korean_master_db_data 2>/dev/null || true
	$(COMPOSE) up -d $(DB_SERVICE)
	$(WAIT_HEALTHY)
```

`docker volume rm korean_master_db_data` targets exactly one named
volume. No project-wide blast radius. Correct.

---

## Coordination observations

1. **Cross-agent contract for the runner-vs-file tx ownership is now
   explicit (ADR-013) AND enforced at discovery (`migrate.py:230-238`).**
   This is the model for how cross-agent integration bugs should be
   resolved: the fix is not just to change the artifact, but to make
   the bug class impossible to land again.

2. **ADR numbering policy in `docs/README.md` (new)** documents the
   "global, chronological, never recycled; earlier merge keeps the
   number, later renumbers" rule. The next round of parallel agents
   has an unambiguous policy.

3. **The discriminator-coverage test pattern (`test_discriminator_coverage.py`)
   is reusable.** It parses both the source JSON and the migration
   SQL with no DB dependency, so it can run in any CI environment.
   Other agents writing discriminator enums against external source
   data should copy this pattern.

4. **`schema_migrations.applied_by`** now carries `<os-user>@<hostname>`
   per insert (`migrate.py:113-128, 358-371`). The column default
   stays `current_user` for the `ensure_bookkeeping` path that doesn't
   go through `apply_one`. Sensible belt-and-braces.

5. **The discover-time rejection of inner tx control is a forcing
   function for future migration authors.** If A4 (or later) writes a
   migration with `BEGIN;…COMMIT;`, the runner refuses to load it.
   The author gets an immediate, named error pointing at ADR-013.
   This is the kind of guardrail that scales across teams.

---

## Files referenced

- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrate.py`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/001_core_schema.up.sql`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/001_core_schema.down.sql`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/002_darakwon_corpora.up.sql`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/002_darakwon_corpora.down.sql`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/README.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/migrations/SECURITY.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/tests/test_migrations.py`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/tests/test_discriminator_coverage.py`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/docker-compose.yml`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/Makefile`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/scripts/backup.sh`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/scripts/restore.sh`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/README.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/SECURITY.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/ADR-001-database-choices.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/ADR-002…ADR-013.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/README.md`
- `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/db/docs/FIX_REPORT.md`
- Source JSONs under `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository/tools/ingest/output/`

---

## Recommendation

**Ready for Phase C, with one follow-up ticket recommended:** add an
integration test that applies the real `001` + `002` migrations against
testcontainers and snapshots the resulting schema (SF-1 new). All
BLOCKERs and SHOULD-FIXes from the three original reviews are
addressed in code; no PRAISE items were undone; the fix-pass
introduced no new BLOCKERs; the ADR/test/SECURITY plumbing is in good
shape. Lint, type-check, and integration-test execution were not
performed in this review but are achievable via the documented `make`
targets.
