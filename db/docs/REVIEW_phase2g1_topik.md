# REVIEW — Phase 2 G1, slice: migration 046 (topik_attempts history, A1) + topik.ts rework

**Reviewer:** independent senior review (did not author this code)
**Branch:** `feat/phase2-g1-db-foundation` @ `fa361df`
**Scope:** `db/migrations/046_topik_attempts_history.{up,down}.sql`,
`db/tests/test_migration_046.py`, `server/src/routes/topik.ts` (diff vs
`rebuild`), `server/tests/routes/topik.test.ts`
**Date:** 2026-07-10

---

## Summary verdict

**PASS with conditions.** The 046 migration pair is careful, reversible-with-
documented-loss, idempotent, ADR-013-clean, and genuinely tested both ways
against real data on a real Postgres. The backend rework removes every trace of
the `__closed__` tombstone and keeps user-scoping, caps, and INT4 guards
intact. Two things stand between this and a clean pass:

1. **BLOCKER (coordination — caused by 047, not this slice):** the server test
   gate is red at branch HEAD. 047 breaks the vitest Postgres harness, so all
   83 topik tests skip. Verified 046's own work is green by running the suite
   with 047 removed: **83/83 pass**.
2. **SHOULD-FIX (high):** the reworked F-UP-014 resurrect guard in
   `PUT /topik/attempt` has a narrow race window vs `/mock/submit` that the
   pre-046 tombstone design did not have (details in S-1).

**Gate results (real counts):**

- DB harness (exact command from the task):
  `python -m pytest db/tests/test_migration_046.py` → **2 passed in 7.50s**.
- Server suite at branch HEAD:
  `npx vitest run tests/routes/topik.test.ts` → **1 suite failed, 83 tests
  skipped** — startup error `relation "schema_migrations" does not exist`
  (see BLOCKER-1). In a scratch worktree at the same commit with
  `047_km_app_role.{up,down}.sql` removed: **83 passed in 76.87s**.
- `npm ci` note: it aborted with `EACCES: permission denied, unlink
  '.../node_modules/pend/LICENSE'` (root-owned files left by Docker runs —
  `node_modules/pend`, `node_modules/yauzl`), and it had already partially
  emptied `node_modules` before dying. `npm install` repaired the tree in
  place; the suite was run against that.

---

## BLOCKER

### B-1 — Server test gate is broken at HEAD by 047 (coordination; not a 046 defect)

- `db/migrations/047_km_app_role.up.sql:131` —
  `REVOKE INSERT, UPDATE, DELETE ON TABLE schema_migrations FROM km_app;`
- `server/tests/helpers/pg.ts:41-63` (`applyMigrations`) applies every
  `*.up.sql` raw, file-by-file, WITHOUT the migration runner — so
  `schema_migrations` never exists, 047 aborts, `startPostgres()` throws, and
  every server integration suite that boots Postgres dies in `beforeAll`
  (topik: 83/83 skipped; teardown then secondary-faults at
  `server/tests/helpers/app.ts:318` on the undefined handle).

047's own header (`047_km_app_role.up.sql:12`) asserts "`schema_migrations`
exists whenever this runs: the runner's ..." — an assumption the server-side
harness violates. This belongs to the 047/B-030 slice, but it makes THIS
slice's gate unrunnable at HEAD, so it must be fixed (guard the REVOKE on
`to_regclass('schema_migrations')`, or teach the harness to create the
bookkeeping table / use the runner) before the branch can claim green.

Evidence that 046 itself is not the cause: with the two 047 files deleted in a
throwaway worktree at the same commit, the full topik suite passes 83/83.

---

## SHOULD-FIX

### S-1 (high) — PUT /topik/attempt: the rebuilt F-UP-014 guard has a race window during the submit transaction

`server/src/routes/topik.ts:832-861`. The guard moved from the pre-046
`ON CONFLICT ... DO UPDATE ... WHERE NOT (<fresh tombstone>)` to a gating
`INSERT ... SELECT ... WHERE NOT EXISTS (<fresh completed same-paper row>)`
in front of `ON CONFLICT (user_id) WHERE status = 'active' DO UPDATE`.

Under READ COMMITTED, a racing save that the server processes **while the
submit transaction is still open** can slip through:

1. `/mock/submit` (`topik.ts:1197-1225`) opens its tx, `UPDATE ... SET
   status='completed'` on the active row (row lock held), then inserts up to
   ~50 response rows — the tx is open for the whole grading write.
2. A delayed `PUT /topik/attempt` for the same paper starts now. Its statement
   snapshot predates the submit commit, so `NOT EXISTS (... status='completed'
   ... updated_at > now() - grace)` sees no completed row → the SELECT emits a
   row.
3. The INSERT's speculative insertion finds the active row's entry in the
   partial unique `uq_topik_attempts_user_active` and blocks on the submit
   tx's row lock.
4. Submit commits. The conflicting row's new version has `status='completed'`
   and no longer satisfies the arbiter's predicate — so this is **not** a
   conflict anymore; Postgres retries the insertion and it **succeeds**. (The
   `WHERE NOT EXISTS` is not re-evaluated on this retry.)
5. Result: a fresh `status='active'` row for a just-graded paper — exactly the
   resurrected resume banner F-UP-014 exists to prevent. The same window
   exists on the no-active-row submit path (`topik.ts:1210-1219`), where step
   3's wait doesn't even occur.

The pre-046 design was watertight here: the FULL unique on `user_id`
guaranteed the racing PUT always took the DO UPDATE path, and the
`DO UPDATE ... WHERE` clause is re-evaluated against the *committed* tombstone
version (EvalPlanQual), so the refusal held under any interleaving. The new
design only closes the window for PUTs processed strictly after the submit
commit.

Why not a BLOCKER: the window is the duration of the submit tx (tens of ms);
the racing PUT that slips through commits immediately after the submit, and
the client's post-submit `clearAttempt()` mop-up (now "abandon active",
`topik.ts:891-899`) lands a network round-trip later and sweeps the
resurrected row into `abandoned`. The user-visible failure needs the mop-up to
also be lost (tab killed at exactly the wrong moment). Still, the guard was
built for precisely this race, and it now only covers two-thirds of it.

Suggested fix: serialize PUT vs submit per user — take
`pg_advisory_xact_lock(hashtext('topik_attempt'), user_id)` (or
`SELECT ... FOR UPDATE` on the user's attempt rows) at the top of both the
submit tx and a transaction-wrapped PUT, so the PUT's guard check cannot
overlap an open submit. Cheap, single-user-serialized, no schema change.
At minimum, document the accepted window where the old comment block
(`topik.ts:720-737`) currently implies full parity with the tombstone guard.

### S-2 — 046.down performs irrecoverable row deletion but does NOT trip the destructive gate

`db/migrate.py:79-82` — `DESTRUCTIVE_PATTERNS` matches only
`DROP TABLE|DROP SCHEMA|DROP DATABASE|TRUNCATE`.
`046_topik_attempts_history.down.sql:58-68` mass-`DELETE`s all-but-one attempt
row per user, and `:40` / `:95` `DROP COLUMN` data-bearing columns
(`attempt_id`, `status`). None of that matches the pattern, so a plain
`python -m db.migrate down` (one step, no `--allow-destructive`) silently
destroys the attempt history the whole ticket exists to retain. Compare
`037_topik_attempts.down.sql:8` (`DROP TABLE`), which IS gated. The gate's own
charter (`db/migrate.py:70-71`: "IRRECOVERABLE DATA LOSS") says this rollback
should require the flag.

Note the test *passes* `--allow-destructive` on its down call
(`test_migration_046.py:294-297`) even though it is not currently required —
which quietly masks the gap.

Fix options (coordination — `db/migrate.py` is shared): extend
`DESTRUCTIVE_PATTERNS` with `DELETE\s+FROM` and `DROP\s+COLUMN` (down
migrations routinely contain these, so scope it carefully or gate downs
harder), or add a per-file override marker; at minimum, state loudly in the
046.down header that the runner's gate does NOT protect this rollback.

### S-3 — test_migration_046.py: false comment about 045; the "pre-046" seed target is actually pre-045

`db/tests/test_migration_046.py:61-63` — "(There is no 045; the runner orders
by version string and does not require contiguity.)" is factually wrong: 045
exists on this branch (`045_hygiene_cleanup`), and this very file cites it in
three `--allow-destructive` comments (`:201`, `:276`, `:332`). `PRE_046 =
"044"` is described as "the last migration before 046" — it is the last before
**045**. Functionally harmless today (045 touches neither `topik_attempts` nor
`topik_responses`, and targeting 044 conveniently avoids needing the
destructive flag on the seed-stage `up`), but the comment will actively
mislead the next maintainer, and the seeded "pre-046 shape" is really the
pre-045 schema. Fix the comment (and rename the constant or note the
deliberate choice of 044 to dodge 045's gate).

---

## NIT

### N-1 — 046.up:54 lock-level claim is wrong

"Disabling a trigger takes the same ACCESS EXCLUSIVE lock the ALTER TABLEs
here already take" — since PostgreSQL 9.5, `ALTER TABLE ... DISABLE TRIGGER`
takes `SHARE ROW EXCLUSIVE`, not `ACCESS EXCLUSIVE`. The conclusion (safe
inside the runner's single tx) is unaffected; the justification is off.
Same claim repeated implicitly at `046_...down.sql:73-74`.

### N-2 — Starting a new mock overwrites the active attempt in place; the abandoned sitting is not retained as history

`topik.ts:842-851` — `DO UPDATE` repurposes the existing active row for a
different paper, so an unfinished sitting replaced by a new mock leaves NO
history row (unlike an explicit abandon), and the reused row's `created_at`
now predates the new sitting. This is deliberate 037 parity, but it is a data
gap for the F-078/F-082 history surfaces this ticket unblocks. Consider having
the client abandon-then-start, or the server abandon-and-insert. Worth a
design note before F-078 builds on the data.

### N-3 — 046.down re-encodes a surviving *abandoned* row as a completed tombstone

`046_...down.sql:76-80` re-encodes any surviving `status <> 'active'` row —
including `abandoned` — as `{"__closed__": true}`. Pre-046, an abandoned
attempt was NO row; after rollback, a freshly-abandoned row becomes a
tombstone that blocks same-paper saves for the 15s grace window under the old
route. Marginal and self-expiring; a `WHERE status = 'completed'` +
`DELETE ... WHERE status = 'abandoned'` split would be exact, but the current
choice is defensible. Documenting it in the header would suffice.

---

## PRAISE

- **The transform is surgical and proves it.** `picks - '__closed__'` strips
  only the tombstone key; the test seeds `{"__closed__": true, "123": "a"}`
  and asserts `{"123": "a"}` survives (`test_migration_046.py:192,221`), and
  asserts `updated_at` equality across the migration (`:224-227`) — the
  trigger-disable trick (`046.up:101-108`) is done in both directions.
- **FK semantics asserted from the catalog, not prose** —
  `confdeltype = 'n'` / `confupdtype = 'r'` from `pg_constraint`
  (`test_migration_046.py:249-258`).
- **The A1 invariant is proven behaviorally, both layers**: the DB-level
  23505 test for a second active row (`topik.test.ts:2021-2040`), route-level
  accumulation of completed rows with exactly one active
  (`topik.test.ts:1905-1943`), and `attempt_id` stamping inside the submit tx
  (`:1945-1966`).
- **The submit-before-first-save path** (`topik.ts:1210-1219`) creates a
  completed row so responses are never orphaned — and is tested
  (`topik.test.ts:1968-1996`).
- **Unheralded correctness win**: pre-046, the submit's tombstone upsert
  (`ON CONFLICT (user_id)`) CLOBBERED an active attempt for a *different*
  paper; the new submit closes only the same `(source_test, section)` attempt
  and leaves other papers resumable (`topik.ts:1188-1204`).
- **ADR-013 discipline**: no top-level tx control in either file; guarded
  `ADD CONSTRAINT` via `pg_constraint` checks inside `DO $$` (the 044
  pattern); the DB test applies via `migrate.main()`, so the discovery-time
  detector actually ran against these files.
- `--allow-destructive` on the full-chain applies (`fa361df`) is correct and
  correctly scoped: `up --target 044` needs no flag; every traversal of 045
  passes it, each with a comment saying why.

## Adversarial checks performed (no findings)

- Up idempotency on already-migrated data: every step is `IF [NOT] EXISTS` /
  catalog-guarded; the tombstone UPDATE can never re-match (the key is
  stripped, and `AttemptBodySchema`'s `^\d+$` picks-key regex plus the server
  never writing the key means no post-046 row can contain it). 0/1/N rows
  safe; the 0-row case is exercised by the down test's initial full `up`.
- Down → re-up round-trip: tested end-to-end including re-derivation of
  `status` from the re-encoded tombstone (`test_migration_046.py:331-348`).
- Tombstone eradication: `grep -rn "__closed__" server/src client/src` →
  only a historical-context comment at `topik.ts:719`. No live logic remains.
- IDOR: every attempt query filters `user_id = getUserId(req)` (session id),
  including the guard subquery (`topik.ts:840`); cross-user test at
  `topik.test.ts:652`. `/mock/submit`'s close/insert both bind the session id.
- Guards intact: picks cap ≤ 60 (`topik.ts:754-757`), INT4 `.max` on
  `sourceTest`/`currentIdx`/`remainingMs` (`:745-751`), all still tested
  (`topik.test.ts:668-693`).
- GET needs no `ORDER BY`/`LIMIT`: the partial unique guarantees ≤ 1 row for
  `status='active'`.
- PUT-vs-PUT concurrency: the `ON CONFLICT (user_id) WHERE status='active'`
  arbiter is race-safe for concurrent saves (both new rows satisfy the
  predicate, loser takes DO UPDATE). Only the PUT-vs-submit interleaving
  (S-1) escapes.
- 047 grants cover the new column/queries (`GRANT ... ON ALL TABLES` +
  default privileges, `047.up:126,142`); the route no longer needs DELETE on
  `topik_attempts` at all.

## Coordination

- **B-1 → 047/A2 owner**: fix the `schema_migrations` REVOKE vs the server
  vitest harness; this slice's gate cannot go green at HEAD until then.
- **S-2 → db/migrate.py owner**: destructive-gate pattern extension is a
  shared-file change; 046.down should not land as the first ungated
  row-deleting rollback without a deliberate decision.
- **N-2 → F-078/F-082 planners**: overwritten-in-place active attempts leave
  no history row; decide before building the history UI on this data.
