# REVIEW — Phase-2 Group 1, DB-infra slice (migrations 045 + 047)

**Reviewer:** independent senior review (DB + security focus) — did not author any of this code
**Branch:** `feat/phase2-g1-db-foundation` (base `origin/rebuild` @ fbd508b)
**Scope of this review:** migration 045 (`hygiene_cleanup`, F-083), migration 047
(`km_app_role`, B-030), `db/tests/test_km_app_role.py`,
`Deploy/set-km-app-password.sh`, `Deploy/docker-compose.{blue,green}.yml`,
`Deploy/.env.example`, `db/SECURITY.md`, `db/migrations/README.md` (045/047 rows).
Migration 046 and the server/topik changes are a sibling reviewer's slice; they are
touched here only where they interact with 045/047.

---

## Summary verdict: **PASS WITH CONDITIONS**

Zero blockers. Both migrations are correct, ADR-013-compliant, idempotently
guarded, honestly documented about their lossy edges, and — for 047 — backed by
genuinely adversarial security tests that I ran and watched pass. The conditions
are three SHOULD-FIX items, all documentation/runbook accuracy: a stale "there is
no 045" comment, an FK comment that overstates when its CASCADE fires (the app
soft-deletes bank entries; the cascade never fires on the app's unbank path), and
a deploy runbook that nowhere mentions the two manual release-day steps this PR
introduces (one-time `--allow-destructive` apply; one-time password provisioning).

**Test evidence (run by this reviewer, project container harness, postgres:16-alpine testcontainer):**

| Suite | Result |
|---|---|
| `db/tests/test_km_app_role.py` (2 tests) + `db/tests/test_migrations_real.py` (4 tests) | **6 passed** in 9.41s |
| `db/tests/test_migration_046.py` (2 tests — the only place 045 is exercised in BOTH directions: full-chain up with `--allow-destructive`, `down --target 044` through 045.down, re-up) | **2 passed** in 7.58s |

The km_app denial matrix passed live: `CREATE TABLE`, `CREATE INDEX`,
`ALTER TABLE`, `DROP TABLE`, `TRUNCATE`, **`COPY ... FROM PROGRAM` (the T9 RCE
vector)**, `CREATE ROLE`, and INSERT/UPDATE/DELETE on `schema_migrations` all
raised `42501 insufficient_privilege` on a real connection authenticated as
`km_app` (`db/tests/test_km_app_role.py:258-274`).

**Secret scan: clean.** The full branch diff contains no real secret. The only
credential-shaped strings are `CHANGE-ME`/`REPLACE-ME` placeholders
(`Deploy/.env.example:37,67,75,78`) and the deliberately non-secret-shaped
testcontainer literal `km-app-testcontainer-only`
(`db/tests/test_km_app_role.py:61`). `Deploy/.env` is double-gitignored
(root `.gitignore:3` and `Deploy/.gitignore:4`, verified via `git check-ignore`).

---

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — Stale comment claims migration 045 does not exist.**
`db/tests/test_migration_046.py:61-62`:
```
# schema the data-transform assertions seed against. (There is no 045; the
# runner orders by version string and does not require contiguity.)
```
045 exists on this very branch and the same file acknowledges it three times
(`test_migration_046.py:201-205, 276-280, 332-336` — "migration 045
(hygiene_cleanup, DROP TABLE) sits in [the chain]"). The comment predates commit
16a5e10 and was not updated by fa361df, which fixed the code but not the prose.
A future reader deciding whether the chain needs `--allow-destructive` gets two
contradictory answers in one file. Fix: delete or rewrite the parenthetical.
*(File is nominally the 046 reviewer's slice — flagged here because it
misdocuments 045; see Coordination.)*

**SF-2 — 045's FK comment overstates when the CASCADE fires (app uses soft delete).**
`db/migrations/045_hygiene_cleanup.up.sql:53-58` and the persisted
`COMMENT ON CONSTRAINT` at `:136-143` say "ON DELETE CASCADE purges a pattern's
attempts when it leaves the bank". In the running app, a pattern "leaves the
bank" by **soft delete** — `grammar_entries.deleted_at` is set and every bank
route filters `deleted_at IS NULL` (`server/src/routes/grammar.ts:239,260,279,373`).
There is **no hard `DELETE FROM grammar_entries` anywhere in `server/src/`**
(verified by grep), so the CASCADE in practice fires only on user deletion
(via 019's `users` CASCADE chain) or a manual psql hard delete. Two consequences
worth documenting honestly:
  1. Unbanking via the app does NOT purge attempts — they persist, still
     FK-valid, attached to a soft-deleted entry. (Harmless today; the drill
     routes reach attempts only through banked patterns.)
  2. The FK's real value is narrower than advertised: it blocks attempts for
     rows that were *never* banked (or hard-deleted), and keeps the ~5-orphan
     class from recurring. That is still worth having.
This is a data-integrity-*documentation* issue, not a data-integrity issue — no
behavior is wrong, and the FK is safe (the composite target
`uq_grammar_entries_user_pattern` verified at
`db/migrations/001_core_schema.up.sql:585`; the referencing side is
prefix-covered by `idx_gda_user_pattern_created`,
`019_grammar_drill_attempts.up.sql:85-86`, so the cascade scan is indexed as
claimed). Fix: reword the header + `COMMENT ON CONSTRAINT` to say the cascade
covers hard deletion (user-CASCADE / manual), and that app-level unbanking is a
soft delete that intentionally retains attempts.

**SF-3 — The two manual release-day steps live only in migration headers; the deploy runbook is silent.**
The release that ships this branch requires, in order:
  1. Add `KM_APP_USER`/`KM_APP_PASSWORD` to the server's `Deploy/.env`
     **before any compose command** — the `${KM_APP_PASSWORD:?…}` guard
     (`Deploy/docker-compose.blue.yml:104`, `green.yml:104`) makes *every*
     compose invocation fail (including against the ACTIVE color's file) until
     the var exists.
  2. A **one-time `run_migrate --allow-destructive up`** — 045's up contains
     `DROP TABLE`; `Deploy/local-standup.sh:114` and
     `Deploy/azure-deploy-inactive.sh:131` call `run_migrate up` bare and will
     abort (and `Deploy/SECURITY.md:140` codifies that the deploy "never
     passes" the flag). Note the preceding `--dry-run` (`local-standup.sh:109`)
     will NOT surface this — the destructive gate fires in `apply_one`
     (`db/migrate.py:358`), which dry-run never reaches (`db/migrate.py:474-477`),
     so the failure lands mid-deploy.
  3. A **one-time `bash Deploy/set-km-app-password.sh`** after 047 applies,
     before the idle color can pass health checks.
All three are documented — but only inside `045_hygiene_cleanup.up.sql:26-35`,
`047_km_app_role.up.sql:71-76`, and `Deploy/.env.example:47-67`.
`Deploy/README.md` mentions none of them (grep for `045|km_app|set-km-app`:
zero hits). Everything fails safe (idle color, pre-flip — the blue/green gate
does its job), but the operator discovers the procedure from error messages, on
release day. Fix: add a short "shipping 045+047" section (or a generic
"destructive migration release" section) to `Deploy/README.md`.

### NIT

**N-1 — `db/migrate.py:288` docstring inaccuracy (pre-existing, adjacent to 047).**
`strip_sql_noise`'s docstring says it is "Used by `contains_top_level_tx_control`
(and `contains_destructive`)" — but `contains_destructive`
(`db/migrate.py:301-302`) uses `strip_sql_comments` only (string literals NOT
stripped). The 047 author noticed the true behavior and correctly worked around
it (`047_km_app_role.up.sql:107-110` — spelling "table truncation" in the
`COMMENT ON ROLE` literal so a plain `run_migrate up` isn't forced through the
destructive gate). The docstring should be corrected so the next author doesn't
trust it and ship a literal `'…TRUNCATE…'` that flags every deploy.

**N-2 — km_app retains PUBLIC's `TEMP` privilege on the database.**
047 revokes nothing at the database level, so a compromised app session can
still `CREATE TEMP TABLE` (disk-consumption annoyance, zero escalation — temp
schemas can't host persistent objects or code execution). Optional hardening
follow-up: `REVOKE TEMPORARY ON DATABASE … FROM PUBLIC`. Not required by B-030.

**N-3 — 045's constraint guard checks `conname` without `conrelid`**
(`045_hygiene_cleanup.up.sql:119-120`). A theoretical same-named constraint on a
different table would make the guard a false-positive no-op. This exactly matches
the established house pattern (`044_reading_chapters.up.sql:78-79`,
`002_darakwon_corpora.up.sql:954-955`), so consistency wins; if the pattern is
ever tightened, tighten it everywhere.

**N-4 — password URL-safety is by convention, not construction.**
The compose files embed `KM_APP_PASSWORD` raw in the DSN
(`docker-compose.blue.yml:104`); a password containing `@ / : #` would break the
URL. Mitigated by explicit instruction to use `openssl rand -hex 32`
(`Deploy/.env.example:55-57`) and by `set-km-app-password.sh` handling any value
safely on the DB side (`:'pw'` quoting). Acceptable; noting for the record.

**N-5 — test-only f-string SQL** at `db/tests/test_km_app_role.py:173`
(`f"ALTER ROLE km_app PASSWORD '{KM_APP_TEST_PASSWORD}'"`). Constant, quote-free,
testcontainer-only — fine as-is; parameterization isn't possible for DDL anyway.

### PRAISE

**P-1 — The 6 dropped indexes are all genuinely redundant. Independently verified.**
Each duplicates the backing index of a same-table UNIQUE constraint, identical
column list and order:

| Dropped (045:83-88) | UNIQUE (verified at) |
|---|---|
| `ix_diagnostic_responses_run_ordinal` (run_id, ordinal) | `uq_diagnostic_responses_run_ordinal` — `014:199-200` (index at `014:242-243`) |
| `ix_topik_items_test_number` (topik_test_id, item_number) | `uq_topik_items_test_number` — `005:421` (index at `005:472-473`) |
| `ix_image_words_capture` (capture_id, ordinal) | `uq_image_words_capture_ordinal` — `017:165-166` (index at `017:194-195`) |
| `ix_krdict_examples_sense` (krdict_sense_id, example_index) | `uq_krdict_examples_sense_index` — `003:329-330` (index at `003:354-355`) |
| `ix_krdict_senses_entry` (krdict_entry_id, sense_index) | `uq_krdict_senses_entry_sense` — `003:272-273` (index at `003:299-300`) |
| `ix_krdict_inflections_entry` (krdict_entry_id, order_index) | `uq_krdict_inflections_entry_order` — `003:380-381` (index at `003:410-411`) |

The down (`045_hygiene_cleanup.down.sql:62-98`) recreates all six with
definitions AND `COMMENT ON INDEX` text verbatim — checked word-for-word against
the originating migrations. The bak-table shells carry honest "EMPTY shell …
NOT restorable" comments, and both cited provenance docs
(`db/docs/FIX_sweep_data.md`, `db/docs/FIX_followups_explanations.md`) exist.
No code anywhere references the bak tables (grep over `server/src/` + `Deploy/`:
zero hits) — safe to drop.

**P-2 — 047's test file is a model security test.** It proves the boundary from
*inside* a live km_app connection rather than trusting the catalog alone; it
exercises the `ALTER DEFAULT PRIVILEGES` future-table path with a table created
after 047 (`test_km_app_role.py:189-194, 243-247` — the exact Phase-2 scenario);
and `test_047_round_trip_and_reapply_over_lingering_role` covers the genuinely
subtle cluster-wide-role vs per-database-bookkeeping mismatch, including
convergence over a *maliciously escalated* lingering role
(`test_km_app_role.py:314-323`). Rollback cleanliness is asserted down to
`pg_default_acl` entry counts (`:290, :300-302, :326`).

**P-3 — Secret handling in `Deploy/set-km-app-password.sh` is done right.**
Secret travels stdin → container-local env var → `\getenv` → `:'pw'` literal
quoting (`set-km-app-password.sh:65-73`): never argv, never `ps`-visible, never
logged (the shared ERR trap prints `BASH_COMMAND` *unexpanded* —
`Deploy/deployment-utils.sh:87` — so even a failure can't echo the value; no
`set -x` anywhere in either script). The script refuses placeholder values
(`:39-43`), refuses to run before 047 (`:52-58`), and verifies end-to-end over
the same scram host-auth path the app uses, asserting non-superuser (`:80-89`).
The password-less-role design is sound: between 047 apply and the script run,
km_app has a NULL verifier and cannot pass scram host auth, so a forgotten step
fails the idle color's health gate, never live traffic.

**P-4 — ADR-013 compliance is exact in all four files.** No top-level tx
control; PL/pgSQL `DO $$ … $$` blocks used exactly where guards are needed
(discovery-time enforcement in `db/migrate.py:239-247` would have rejected the
files otherwise — and the passing test runs prove discovery accepted them).
The `FOR ROLE` omission on `ALTER DEFAULT PRIVILEGES` is the *correct* call, and
the header (`047:46-56`) explains why with the precise failure mode of the
alternative (testcontainer superuser is `test`; naming `korean_master` would
error there). The down's ordering rationale (`047.down:19-30`) — including why
`DROP OWNED` also sweeps other grantors' default-ACL entries and why a
multi-database cluster would fail loudly instead of half-cleaning — is the kind
of comment that saves a future 2 a.m.

**P-5 — Grant surface matches the app's actual needs.** `server/src/` contains
no runtime DDL, no `TRUNCATE`, no `setval`/`nextval` (verified by grep), so
DML + sequence USAGE/SELECT is exactly sufficient — nothing over-granted,
nothing that will 500 later.

---

## Coordination

- **SF-1** belongs to the 046 slice (`db/tests/test_migration_046.py`) — hand to
  that reviewer/fixer; one-line comment fix, no code change.
- **N-1** is a pre-existing `db/migrate.py` docstring defect, out of this
  branch's diff — fold into any fix-pass touching the runner, or fix here since
  047's header now references the true behavior.
- **SF-3**'s runbook addition (`Deploy/README.md`) should be written once for
  the whole Group-1 release (045's flag + 047's password step + the `.env`
  precondition are one rollout sequence), not per-migration.
- Reminder for the deployer (documented at `047:71-76`, repeated here because it
  is the only ordering that is safe): `.env` vars → migrate (with the one-time
  flag) → `set-km-app-password.sh` → idle color up → health gate → flip. Per
  the blue/green protocol, never recreate the active color in place.

## Gate results (verbatim)

```
$ python -m pytest db/tests/test_km_app_role.py db/tests/test_migrations_real.py -p no:cacheprovider -q
......                                                                   [100%]
6 passed in 9.41s

$ python -m pytest db/tests/test_migration_046.py -p no:cacheprovider -q
..                                                                       [100%]
2 passed in 7.58s
```
