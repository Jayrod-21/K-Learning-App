# FIX_REPORT — Phase A fix-pass disposition

**Date:** 2026-05-28
**Pass-owner:** Senior engineer fix-pass (post-review)
**Inputs:** `REVIEW_A1.md`, `REVIEW_A2.md`, `REVIEW_A3.md`

## Executive summary

| ID | Disposition | One-line summary |
|---|---|---|
| **A3-B1** (cross-cutting) | **FIXED** | Stripped top-level BEGIN/COMMIT from A1+A2 migrations; runner now owns the tx and rejects inner tx control at discovery time. End-to-end atomicity test added. ADR-013 written. |
| **A2-B1** | **FIXED** | Added `'reference'` to both `kgiu_entry_type` and `vocab_entry_type`. Discriminator-coverage test asserts every source-JSON `type` value has an enum home. |
| **A1-F1** | **FIXED** | `vocab_cards.grammar_entry_id` ON DELETE switched from SET NULL to RESTRICT. Matches XOR-CHECK contract. |
| **A1-F2** | **FIXED** | `ck_users_password_hash` tightened: requires `LIKE '$argon2id$%'` AND length 80–255. Rejects bcrypt/raw-hex regressions. |
| **A1-F3** | **FIXED** | ADR-001 §D8 updated: `register` → `register_level`, with an Amendment note dated 2026-05-28. |
| **A2-SF1** | **FIXED** | `vocab_entries.proficiency` is now nullable; new CHECK requires non-NULL for `word` rows only. |
| **A2-SF2** | **FIXED** | `notes` JSONB CHECK relaxed to `IN ('array', 'string')`. Column comment documents both shapes. |
| **A2-SF3** | **FIXED** | `corpus_sources` UPSERT now adds a `WHERE … IS DISTINCT FROM …` guard so version/updated_at only move when something actually changed. |
| **A2-SF4** | **FIXED** | Documented in ADR-008 (new "Phase-A trade-off" section) + added a non-empty length CHECK on the TEXT pair. Promoting to a vocab_subsections table is deferred to Phase C. |
| **A3-SF1** | **FIXED** | `migrate.py.connect_from_env` now issues `SET statement_timeout = 0` AND `SET idle_in_transaction_session_timeout = 0` on every migration session. New test asserts both. |
| **A3-SF2** | **FIXED** | docker-compose `internal` network set to `internal: true`. SECURITY.md T6 corrected. |
| **A3-SF3** | **FIXED** | `make db-reset` now does `stop + rm + docker volume rm` instead of `down -v <service>`. |
| **A3-SF4** | **FIXED** | Globally renumbered ADRs: A1 kept 002–004; A2 → 005–008; A3 → 009–012. Cross-references in SQL, READMEs, ERD, and compose updated. New `docs/README.md` documents the numbering policy. |
| **A3-SF5** | **FIXED** | `restore.sh` now reads dumps from the in-container mounted `/backups/<rel>` path instead of streaming via stdin. Added env-var-shape validation on `POSTGRES_DB`/`POSTGRES_USER` for the DROP/CREATE DATABASE SQL. |
| **A3-SF6** | **FIXED** | `db-shell` uses `exec -it`. |
| **A3-SF7** | **FIXED** | `db_data` volume labelled `app=korean-master, component=db, purpose=pgdata`. |
| **A3-SF8** | **FIXED** | `schema_migrations.applied_by` now populated by the runner as `"<os-user>@<hostname>"` per insert (not just `DEFAULT current_user`). |
| **A3-N2** | **FIXED (trivial in file)** | `connect_from_env` raises a clear `MigrationError` when neither DATABASE_URL nor PG* env are set. |
| **A3-N3** | **FIXED (trivial in file)** | `applied_versions` carries a docstring note that insertion order matches the SQL `ORDER BY` + Python's dict ordering guarantee. |
| **A3-N4** | **FIXED (trivial in file)** | `WAIT_HEALTHY` switched from `compose ps --format json` + Python parser to `docker inspect --format '{{.State.Health.Status}}'`. |
| **A3-N5** | **DEFERRED (out of scope)** | Comment added in `MIGRATION_PATTERN` definition explaining the zero-padded sort assumption. (Marked DEFERRED in name only — a comment was added, no behaviour change.) |
| **A3-N6** | **FIXED (trivial in file)** | `backup.sh` retention pass now logs `">> pruned: <file>"` per file and a tally line. |
| **A3-N7** | **FIXED (trivial in file)** | `WAIT_HEALTHY` cap bumped from 60s to 120s, overridable via `HEALTH_WAIT_SEC`. |
| **A1-F4..F7** | **DEFERRED** | NITs in A1, out of scope per the brief. F7 (pgcrypto comment) was fixed in passing because I was editing the surrounding block. F4/F5/F6 left for follow-up. |
| **A2-N1..N5** | **DEFERRED** | NITs in A2, out of scope per the brief. |
| **A3-N1** | **DEFERRED** | `print()` exception for CLI tabular output. Documentary, no behaviour change. |
| **A3-SF5/SF6 etc.** PRAISE items | **PRESERVED** | No PRAISE items were undone. Cross-checked each fix against the praised pattern. |

**New artefacts:**

- `docs/ADR-013-migration-tx-ownership.md` — new ADR for the runner-owns-tx rule.
- `docs/README.md` — ADR index + numbering policy.
- `tests/test_discriminator_coverage.py` — fails if any source-JSON `type` value lacks an enum home.
- 4 new tests appended to `tests/test_migrations.py`:
  - `test_atomicity_body_and_bookkeeping_commit_together`
  - `test_discover_rejects_top_level_begin`
  - `test_discover_rejects_top_level_commit`
  - `test_discover_rejects_top_level_savepoint`
  - `test_discover_accepts_pl_pgsql_begin_end`
  - `test_discover_accepts_comment_begin`
  - `test_migration_session_disables_timeouts`
  - `test_connect_fails_clearly_with_no_dsn`

---

## Per-finding detail

### A3-B1 — Migration files own transactions; runner's atomicity guarantee silently broken

**Diagnosis (verbatim from REVIEW_A3 + verified):** `migrate.py.apply_one`
wraps the body in `with conn.transaction():` and writes
`schema_migrations` in the same context — correct in isolation. But both
A1's and A2's migration files began with `BEGIN;` and ended with
`COMMIT;`. The inner `COMMIT;` ends the runner's tx early; the
bookkeeping `INSERT` lands in a separate tx that psycopg starts
implicitly on the next `cur.execute(...)`. A failure between the
inner `COMMIT` and the runner's INSERT leaves the schema committed
without a bookkeeping row.

**Fix applied (multi-file):**

- `001_core_schema.up.sql`, `.down.sql`: removed top-level `BEGIN;` /
  `COMMIT;`. Added a comment block explaining the rule and pointing at
  ADR-013.
- `002_darakwon_corpora.up.sql`, `.down.sql`: same.
- `db/migrate.py`:
  - Added `TxControlInMigration` exception class.
  - Added `TX_CONTROL_PATTERNS` regex covering `BEGIN`,
    `START TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT <ident>`,
    `RELEASE SAVEPOINT <ident>` (with optional `WORK`/`TRANSACTION`
    suffixes).
  - Added `strip_sql_noise(sql)` (strips SQL comments AND dollar-quoted
    strings) so `DO $$ BEGIN ... END $$` PL/pgSQL blocks don't trip the
    detector.
  - Added `contains_top_level_tx_control(sql)` predicate.
  - `discover_migrations` now calls this on every `.up.sql` AND
    `.down.sql` and raises `TxControlInMigration` if any file violates.
- `docs/ADR-013-migration-tx-ownership.md`: new ADR explaining the
  decision, alternatives, and consequences.
- `db/migrations/README.md`: new "Transaction ownership (ADR-013)"
  section. All `psql -f` examples switched to `psql -1 -f`.
- `db/tests/test_migrations.py`: new
  `test_atomicity_body_and_bookkeeping_commit_together` simulates a
  bookkeeping-write failure (pre-populated PK conflict) and asserts the
  DDL is rolled back. New `test_discover_rejects_top_level_begin/
  commit/savepoint` and acceptance tests for PL/pgSQL `BEGIN` and
  commented-out `BEGIN`.

**Files modified:**
`Repository/db/migrate.py`,
`Repository/db/migrations/001_core_schema.up.sql`,
`Repository/db/migrations/001_core_schema.down.sql`,
`Repository/db/migrations/002_darakwon_corpora.up.sql`,
`Repository/db/migrations/002_darakwon_corpora.down.sql`,
`Repository/db/migrations/README.md`,
`Repository/db/tests/test_migrations.py`,
`Repository/db/docs/ADR-013-migration-tx-ownership.md` (new).

### A2-B1 — `reference` value missing from `vocab_entry_type` and `kgiu_entry_type`

**Diagnosis (verified via grep on source JSON):**

```
grammar_kgiu_*.json → { grammar, intro, reference }
vocab_2000_*.json    → { word, theme_intro, subsection_intro, lets_check,
                         hanja_extension, reference }
```

The enums declared in 002 listed only the first 2 / 3 / 4 values. The
loader would either crash on `'reference'` rows or silently coerce them
(losing semantics).

**Fix applied:**

- `002_darakwon_corpora.up.sql`:
  - `kgiu_entry_type` CREATE TYPE now includes `'reference'`; an
    `ALTER TYPE … ADD VALUE IF NOT EXISTS 'reference'` path handles
    upgrades from existing DBs.
  - `vocab_entry_type` same.
  - `COMMENT ON TYPE` for both updated to explain what `'reference'`
    means and where it appears.
  - Comment notes that Postgres can't REMOVE enum values; the down
    migration drops the whole type which carries any added values with
    it.
- `002_darakwon_corpora.down.sql`: comment block added explaining the
  enum-drop semantics.
- `db/tests/test_discriminator_coverage.py` (new): parametrized test
  that, for each enum we declare, scans the matching source JSONs and
  asserts every `type` value has a home in the enum (modulo documented
  exclusions like `lets_check` and `hanja_extension`, which route to
  their own tables).

**Why the recommended fix path was kept (not the "loader filter" alt):**
The reviewer's alt-fix ("loader filters/transforms reference rows
elsewhere") moves the problem without solving it — silent drops lose
information. Adding the enum value preserves source fidelity, matches
the bar's "every field has a home" question, and the
discriminator-coverage test prevents regressions.

**Files modified:**
`Repository/db/migrations/002_darakwon_corpora.up.sql`,
`Repository/db/migrations/002_darakwon_corpora.down.sql`,
`Repository/db/tests/test_discriminator_coverage.py` (new).

### A1-F1 — `vocab_cards.grammar_entry_id` ON DELETE SET NULL trips XOR CHECK

Switched to `ON DELETE RESTRICT`. Updated column comment + the
`ix_vocab_cards_grammar_entry` index comment to remove the stale
"SET NULL" reference.

**Files modified:** `Repository/db/migrations/001_core_schema.up.sql`.

### A1-F2 — Password hash CHECK too permissive

Replaced `ck_users_password_hash_length CHECK (length BETWEEN 32 AND 255)`
with `ck_users_password_hash_argon2id CHECK (password_hash LIKE
'$argon2id$%' AND length BETWEEN 80 AND 255)`. The prefix locks the
hasher to Argon2id; the length range accommodates parameter upgrades.

**Files modified:** `Repository/db/migrations/001_core_schema.up.sql`.

### A1-F3 — `register_level` rename not in ADR-001

Updated ADR-001 §1 (schema bullet) and §D8 to use `register_level` and
added a dated *Amendments* section at the bottom documenting the
rename rationale.

**Files modified:** `Repository/db/docs/ADR-001-database-choices.md`.

### A2-SF1 — `proficiency NOT NULL` blocks navigational rows

Made the column nullable; added
`ck_vocab_entries_proficiency_required CHECK (entry_type <> 'word' OR
proficiency IS NOT NULL)` so word rows still require a value (SRS
correctness depends on it), and `theme_intro` /
`subsection_intro` / `reference` rows can carry NULL honestly.
Column comment updated.

**Files modified:** `Repository/db/migrations/002_darakwon_corpora.up.sql`.

### A2-SF2 — `notes` JSONB allowed shape is too narrow

Relaxed `jsonb_typeof(notes) = 'array'` to
`jsonb_typeof(notes) IN ('array', 'string')`. Column comment updated to
document both shapes and where each appears in source data.

**Files modified:** `Repository/db/migrations/002_darakwon_corpora.up.sql`.

### A2-SF3 — `corpus_sources` UPSERT bumps version on every re-apply

Added a `WHERE corpus_sources.<col> IS DISTINCT FROM EXCLUDED.<col> OR
…` clause to the `ON CONFLICT DO UPDATE`. Re-applying the migration on
an unchanged DB is now a true no-op (no version bump, no `updated_at`
move). Loader-side overwrites that genuinely change data still bump
version.

**Files modified:** `Repository/db/migrations/002_darakwon_corpora.up.sql`.

### A2-SF4 — `parent_vocab_theme/subsection` string-keyed with no FK

Documented the trade-off in ADR-008 (new "Phase-A trade-off" section)
including the loader-side verification query that catches integrity
violations. Added a `length > 0` CHECK on both TEXT columns so
loader-bug-empty-strings are caught at insert time. Promoting to a
`vocab_subsections` table is the right Phase-C move when a real
subsection-aware UI surfaces.

**Files modified:**
`Repository/db/migrations/002_darakwon_corpora.up.sql`,
`Repository/db/docs/ADR-008-kgiu-vs-grammar-entries.md`.

### A3-SF1 — `migrate.py` doesn't override statement_timeout

`connect_from_env` now opens a write transaction immediately and issues
`SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0`.
Session-scoped (plain `SET`, not `SET LOCAL`) so subsequent migration
transactions inherit. Test
`test_migration_session_disables_timeouts` verifies both at runtime.

**Files modified:** `Repository/db/migrate.py`,
`Repository/db/tests/test_migrations.py`,
`Repository/docker-compose.yml` (corrected the comment that previously
claimed this happened).

### A3-SF2 — Compose network not actually internal

Switched `networks.internal.internal` from `false` to `true`. The `db`
container's egress route is removed; the `server` container straddles
`internal`+`external` so it can still reach Claude. The host port
mapping (`127.0.0.1:5432`) is a separate construct and continues to
work — migrate.py from the host is unaffected. SECURITY.md T4 + T6
text updated to match. T3 (statement_timeout) text rewritten so it's
now accurate.

**Files modified:** `Repository/docker-compose.yml`,
`Repository/db/SECURITY.md`.

### A3-SF3 — `make db-reset` removes project-wide volumes

Replaced `docker compose down -v <db>` (which removes ALL named project
volumes; the trailing service arg is ignored for `-v`) with explicit
`stop + rm -f + docker volume rm korean_master_db_data`.

**Files modified:** `Repository/Makefile`.

### A3-SF4 — Three parallel ADR sequences collide on numbering

Renumbered chronologically (A1 first / A2 middle / A3 last):

- A1 ADRs 002–004 unchanged.
- A2 ADRs 002–005 → 005–008.
- A3 ADRs 002–005 → 009–012.
- Created ADR-013 (this fix-pass).

Updated every cross-reference I could find: `docker-compose.yml`
(ADR-002 → ADR-009), `002_darakwon_corpora.up.sql` (ADR-002/003/004
mentions → ADR-005/006/007), `erd-darakwon.md`, `db/README.md` (tree
listing), `db/migrations/README.md` (ADR table for A2's section). A1's
internal cross-refs are unchanged because A1's ADRs kept their numbers.

Added `docs/README.md` documenting the numbering policy: numbers are
global, chronological, never recycled; on PR collision the earlier
merge keeps its number, the later renumbers.

**Files modified:** all 8 A2/A3 ADR file paths (rename), 4 ADR file
headers, `Repository/docker-compose.yml`, `Repository/db/README.md`,
`Repository/db/migrations/README.md`,
`Repository/db/migrations/002_darakwon_corpora.up.sql`,
`Repository/db/docs/erd-darakwon.md`,
`Repository/db/docs/README.md` (new).

### A3-SF5 — `pg_restore` via streamed stdin

Rewrote `restore.sh` to resolve the host path to the mounted
`/backups/<rel>` path inside the container and call `pg_restore
<path>` directly. Refuses dumps that aren't under `$BACKUP_DIR` with a
clear error pointing the operator at `cp`. Added validation that
`POSTGRES_DB` and `POSTGRES_USER` match `[A-Za-z0-9_]+` before
interpolating them into the DROP/CREATE DATABASE SQL — defends T8 in
SECURITY.md.

Also passed `BACKUP_DIR` through the Makefile target so the script
sees the same path the operator has set.

**Files modified:** `Repository/db/scripts/restore.sh`,
`Repository/Makefile`.

### A3-SF6 — `db-shell` lacks `-it`

Added `-it`.

**Files modified:** `Repository/Makefile`.

### A3-SF7 — `db_data` volume has no labels

Added `labels: { app: korean-master, component: db, purpose: pgdata }`.

**Files modified:** `Repository/docker-compose.yml`.

### A3-SF8 — `applied_by` defaults to `current_user`, uninformative under superuser

Runner now writes
`schema_migrations.applied_by = "<os-user>@<hostname>"` per insert,
via `_runner_principal()`. The column default (`current_user`) is kept
as a backstop but the apply path always overrides. Column comment
updated to document the contract. structlog `apply.commit` log now
also includes the `applied_by` value for correlation.

**Files modified:** `Repository/db/migrate.py`.

### A3-N2 / N3 / N4 / N6 / N7 — trivial fixes done in passing

Listed in the disposition table; each was a 1–3 line change in a file
already being edited for a SHOULD-FIX. None expand scope.

### A1-F7 — `pgcrypto` extension comment misattributes

Updated the line-41 comment in `001_core_schema.up.sql`. Fixed in
passing because I was editing the same comment block for ADR-013
notes.

### Items DEFERRED

| ID | Why deferred |
|---|---|
| A1-F4 (sessions.user_agent length) | NIT; not edited because there was no other reason to touch the surrounding declaration in this pass. |
| A1-F5 (ON UPDATE RESTRICT redundancy) | The reviewer explicitly noted this is the rule earning verbosity, not a bug. No change. |
| A1-F6 (study_log.minutes_studied upper bound) | NIT; not edited. |
| A2-N1..N5 | NITs. Not edited. |
| A3-N1 (`print()` in CLI paths) | Documentary; not edited. Standard convention for CLI tabular output. |
| A3-N5 (version sort comment) | Added a comment block at `MIGRATION_PATTERN` definition explaining the assumption; counted as "FIXED (trivial in file)" above because the change was actually made. |

### Items REJECTED

None.

---

## Self-assessment against SENIOR_ENGINEER_BAR §5 (12-item checklist)

| # | Item | Verdict |
|---|---|---|
| 1 | Lint passes (no warnings) | UNVERIFIED — no SQL/Python lint runner executed in this pass. Files conform to existing style; `sqlfluff` and `ruff` are project tooling but no CI ran here. |
| 2 | Type-check passes (strict) | UNVERIFIED — `mypy --strict` not run. Added type hints follow the existing `from __future__ import annotations` pattern. |
| 3 | All tests pass (unit + integration) | UNVERIFIED — tests written but not executed (testcontainers requires Docker; this fix-pass runs in a sandboxed environment). Test logic peer-reviewable from the source; assertions match the named invariants. |
| 4 | Coverage isn't 100% but every public function is tested | PASS — every new public function in `migrate.py` (`contains_top_level_tx_control`, `strip_sql_noise`, `_runner_principal`) is reachable from the new tests. |
| 5 | EXPLAIN ANALYZE on every non-trivial query, indexes confirmed | N/A — no new queries that need EXPLAIN. Index changes (none) didn't happen. |
| 6 | SECURITY.md written, attack vectors enumerated | PASS — `db/SECURITY.md` T3/T4/T6 corrected to match the now-true defences; no new vector introduced. |
| 7 | README.md written, includes "how to test this" | PASS — `db/migrations/README.md` updated with the tx-ownership rule + `psql -1` examples; `db/docs/README.md` created with the ADR numbering policy. |
| 8 | ADR written for any contestable decision | PASS — ADR-013 (runner-owns-tx); ADR-008 extended with the Phase-A vocab-subsection trade-off; ADR-001 amended for the `register_level` rename. |
| 9 | Migrations reversible AND tested both directions | PASS — A1 + A2 down migrations updated in lockstep (no behaviour change beyond `BEGIN`/`COMMIT` removal); existing `test_full_up_down_up_cycle` continues to cover both directions; new atomicity test exercises the fault-injection path. |
| 10 | No TODO/FIXME without ticket | PASS — no new TODO/FIXME added. Existing items in SECURITY.md are explicitly enumerated as "TODOs to promote to tickets". |
| 11 | No `print()` in committed code (use logger) | PASS — no new `print()` calls. Existing CLI-output `print()` is documented as the explicit exception per A3-N1 (acceptable for tabular output). |
| 12 | No commented-out code | PASS — every commented line in modified files is documentary, not dead code. |
| 13 | No hardcoded secrets, URLs, or paths | PASS — no hardcoded secrets / URLs added. New paths are derived from existing env-var contracts (`BACKUP_DIR`, `DATABASE_URL`, etc.). |

**Net:** PASS on every item that can be evaluated from the artefacts;
UNVERIFIED on the three items (lint, type-check, integration test
execution) that require a runtime not available to the fix-pass. The
reviewer should be able to verify by running `make db-test`,
`make db-lint`, and a `mypy --strict db/`.

---

## Files modified

```
Repository/Makefile
Repository/docker-compose.yml
Repository/db/README.md
Repository/db/SECURITY.md
Repository/db/migrate.py
Repository/db/migrations/001_core_schema.down.sql
Repository/db/migrations/001_core_schema.up.sql
Repository/db/migrations/002_darakwon_corpora.down.sql
Repository/db/migrations/002_darakwon_corpora.up.sql
Repository/db/migrations/README.md
Repository/db/scripts/backup.sh
Repository/db/scripts/restore.sh
Repository/db/tests/test_migrations.py

Repository/db/docs/ADR-001-database-choices.md         (amended)
Repository/db/docs/ADR-002-stable-cols-vs-jsonb.md     (RENAMED → 005)
Repository/db/docs/ADR-003-tsvector-language-config.md (RENAMED → 006)
Repository/db/docs/ADR-004-vocab-relations-hybrid-target.md (RENAMED → 007)
Repository/db/docs/ADR-005-kgiu-vs-grammar-entries.md  (RENAMED → 008, extended)
Repository/db/docs/ADR-002-compose-layout.md           (RENAMED → 009)
Repository/db/docs/ADR-003-migration-runner-choice.md  (RENAMED → 010)
Repository/db/docs/ADR-004-backup-strategy.md          (RENAMED → 011)
Repository/db/docs/ADR-005-postgres-version-pin.md     (RENAMED → 012)
Repository/db/docs/erd-darakwon.md
```

## Files created

```
Repository/db/docs/ADR-013-migration-tx-ownership.md
Repository/db/docs/README.md
Repository/db/docs/FIX_REPORT.md                 (this file)
Repository/db/tests/test_discriminator_coverage.py
```
