# ADR-013: The migration runner owns transactions; migration files don't

**Status:** Accepted
**Date:** 2026-05-28 (fix-pass after REVIEW_A3 BLOCKER-1)
**Implemented in:** `db/migrate.py`, `db/migrations/001_*.sql`,
`db/migrations/002_*.sql`
**Relates to:** ADR-001 §D11 (forward + reverse migrations, tested),
ADR-010 (migration runner choice)

## Context

The first round of A1's and A2's migrations each wrapped the body in a
top-level `BEGIN; … COMMIT;`. The runner (`migrate.py`) independently
wrapped each body in `with conn.transaction():` and wrote the
`schema_migrations` bookkeeping row inside the same context. Both halves
of the design were individually defensible; together they broke the
atomicity guarantee the runner's docstring explicitly promised.

The failure mode (REVIEW_A3 BLOCKER-1, verbatim):

1. `BEGIN;` in the file emits `WARNING: there is already a transaction in
   progress`; the outer tx continues.
2. The body DDL runs in the outer tx.
3. `COMMIT;` in the file ends the outer tx immediately.
4. The runner's next `cur.execute(...)` implicitly starts a *new* tx.
5. The bookkeeping `INSERT INTO schema_migrations` lands in that new tx.
6. If anything between steps 3 and 6 fails, the schema change is
   committed without a bookkeeping row — the exact scenario the runner
   was supposed to make impossible.

The synthetic-migration test suite missed this because the synthetic
migrations didn't contain `BEGIN`/`COMMIT`. The harness passed its own
tests while breaking on the real migrations it was supposed to run.

## Decision

**The runner owns the transaction. Migration files MUST NOT contain
top-level `BEGIN`, `COMMIT`, `ROLLBACK`, `START TRANSACTION`, or
unprefixed `SAVEPOINT`.**

- `db/migrate.py.apply_one` and `rollback_one` wrap each body in a single
  `with conn.transaction():` block that also writes (apply) or deletes
  (rollback) the `schema_migrations` row. Body + bookkeeping commit or
  abort together.
- `db/migrate.py.discover_migrations` calls
  `contains_top_level_tx_control(body)` on every `.up.sql` and `.down.sql`
  at discovery time. A file containing top-level tx control raises
  `TxControlInMigration` *before* any migration runs. New migration
  authors can't reintroduce the bug without the runner refusing to load
  the file.
- The detector strips SQL comments and dollar-quoted string literals
  before matching, so `DO $$ BEGIN ... END $$` PL/pgSQL blocks (where
  `BEGIN`/`END` are PL/pgSQL keywords, not SQL transaction-control
  statements) pass cleanly.
- An end-to-end test
  (`db/tests/test_migrations.py::test_atomicity_body_and_bookkeeping_commit_together`)
  injects a bookkeeping-write failure and asserts the schema change is
  rolled back.

## Alternatives considered

1. **The runner strips top-level `BEGIN`/`COMMIT` before executing the
   body.** Rejected — silently rewriting authored SQL is the kind of
   surprise a senior engineer regrets after the first weird production
   diff. Reject loud is the correct posture.
2. **The runner detects `BEGIN`/`COMMIT` and exec the body with
   `autocommit=True`, skipping its own transaction.** Rejected —
   atomicity of schema + bookkeeping is the whole point. Letting the
   migration file own the tx means the bookkeeping write is necessarily
   in a different tx than the body, and there is no clean way to make
   that atomic.
3. **Migration files keep `BEGIN`/`COMMIT`; the runner uses
   `autocommit=True` and doesn't wrap.** Rejected for the same reason as
   (2), plus it would defeat the runner's checksum-mismatch / restart-
   safety story.
4. **Hybrid (file may or may not own its tx; runner detects which).**
   Rejected as worst of all worlds — implicit state machine, two code
   paths, two test matrices.

## Consequences

- Existing migrations (`001_core_schema.up.sql`, `.down.sql`,
  `002_darakwon_corpora.up.sql`, `.down.sql`) had their top-level
  `BEGIN;`/`COMMIT;` removed in the same commit that introduces this
  ADR. The bodies are otherwise unchanged.
- `SET LOCAL …` inside migration bodies still works because the runner's
  outer transaction is open when the body executes.
- Manual application via `psql` should use the `-1` flag
  (`psql -v ON_ERROR_STOP=1 -1 -f NNN.up.sql`). `-1` wraps the file in a
  single transaction without requiring inline `BEGIN`/`COMMIT`.
- Future migration authors get an unambiguous, runner-enforced rule. A
  loader of fresh agents won't independently re-introduce the bug.

## Open questions

- Whether the detector should also reject inner `SET TRANSACTION` and
  `LOCK TABLE` (lock-then-commit semantics). Deferred: not seen yet,
  easy to add when a real migration needs them.

## Test evidence

`db/tests/test_migrations.py::test_atomicity_body_and_bookkeeping_commit_together`
writes a migration that succeeds at the DDL but is forced to fail at the
bookkeeping write (via a pre-populated `schema_migrations` row that
creates a PK conflict). The test then asserts that the DDL change is
rolled back — proving body and bookkeeping commit-or-abort together.

`db/tests/test_migrations.py::test_discover_rejects_top_level_tx_control`
asserts that a migration file containing `BEGIN;` or `COMMIT;` outside
PL/pgSQL is rejected at discovery time.
