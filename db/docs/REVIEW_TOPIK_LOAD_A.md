# Review: TOPIK load — migration 030 / DB

**Reviewer:** Independent senior DB reviewer (did not author this change).
**Scope:** `db/migrations/030_topik_tests_provenance.up.sql` + `.down.sql` only.
**References read:** SENIOR_ENGINEER_BAR §4, ADR-005, ADR-013, 005 `topik_tests`
block, 029, `db/migrate.py` (tx-control + destructive detectors, `apply_one`/
`rollback_one`).

## Summary verdict

**PASS WITH CONDITIONS.**

The migration is well-built: additive, online-safe, explicitly named constraint,
mirrors the existing `passages` precedent, ADR-013-compliant (no tx control),
and a clean idempotent reverse. Zero blockers. Two SHOULD-FIX items — both are
judgment/reproducibility concerns, not correctness defects: (1) the jsonb-vs-
discrete-columns call sits in genuine tension with ADR-005's "stable scalars
become columns" rule and the migration's own justification mis-labels the shape
as "variable"; (2) the manual, non-versioned live-DB `source_id` rename is an
un-reproducible, un-audited data mutation that should be captured as a guarded
idempotent script. Approve and merge with those two tracked as follow-ups.

## Bar checklist (relevant §4 items)

| Rule | Item | Verdict |
|------|------|---------|
| §4.1 P0 | `CHECK` for domain invariants at the DB | PASS — `jsonb_typeof(provenance)='object'` |
| §4.1 P0 | Non-nullable column is `NOT NULL` (deliberate) | PASS — `NOT NULL DEFAULT '{}'::jsonb` |
| §4.1 P1 | `jsonb` not `json` | PASS |
| §4.1 P1 | Normalize to 3NF; denormalize only for a measured, documented reason | **PARTIAL** — value-object jsonb over discrete columns; see SHOULD-FIX 1 (ADR-005 stable-scalar tension) |
| §4.2 P0 | Name every constraint explicitly (no auto names) | PASS — `ck_topik_tests_provenance_object`, `ck_` prefix, snake_case, 33 chars ≤63 |
| §4.5 P0 | Correct, tested `downgrade()`; test both directions | PASS — down present, idempotent, reverses up exactly |
| §4.5 P0 | No destructive change without backup/rollback plan | PASS — up is additive/non-destructive; down's DROP COLUMN is documented + recoverable via reload |
| §4.5 P1 | Add `NOT NULL` safely | PASS (by exception) — constant `DEFAULT` = metadata-only add, no rewrite, so the add-nullable→backfill→validate dance is unnecessary here |
| §4.5 P0 | `lock_timeout`/`statement_timeout` on migration connection | N/A at file level — runner concern; table is tiny so lock window is negligible |
| §0 P1 | Comments explain *why*, not *what* | PASS (PRAISE) — genuinely excellent header rationale |
| ADR-013 | No top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT | PASS — clean; `migrate.py` detector will load it |
| ADR-005 | jsonb reserved for genuinely variable shape | **PARTIAL** — see SHOULD-FIX 1 |

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. `provenance` jsonb vs. discrete columns — the shape is fixed/enumerated, not
   "variable"; ADR-005's letter says stable scalars become columns.
2. The manual live-DB `source_id` rename (390 rows) is un-reproducible and
   un-audited — capture it as a guarded, idempotent, version-controlled script.

### NIT
1. The "validates instantly because every backfilled value is `'{}'`" comment
   states the wrong mechanism.
2. Two separate `ALTER TABLE` statements take two `ACCESS EXCLUSIVE` locks;
   could be one combined statement.

### PRAISE
1. Constraint is explicitly named with the `ck_` convention — do **not** let a
   fix-pass strip or auto-name it (§4.2 P0).
2. Exact structural parity with the pre-existing `passages` column
   (`JSONB NOT NULL DEFAULT '{}'::jsonb` + `ck_..._object` CHECK) — consistency
   a reader can trust.
3. The header comment is model-grade: names the three source fields, the reason
   they were dropped (`extra="ignore"`), the online-safety argument, and the
   loader that writes it. This is the "comments explain why" bar met.
4. The down migration is idempotent (`IF EXISTS` on both drops) and documents
   the intended data loss + the recovery path (source JSON is system of record).

## Detailed findings

### SHOULD-FIX 1 — jsonb value object vs. discrete columns (ADR-005 tension)
`030_topik_tests_provenance.up.sql:25-30`; rationale at `:16-19`.

The column stores three **known, enumerated** fields (header `:6-14`): `note`
(text), `transcript_available` (bool), `transcript_source` (text). ADR-005's
decision is explicit: *"Stable scalars become columns. Repeated variable-shape
arrays become JSONB."* The ADR reserves jsonb for **repeated, genuinely
variable-shape collections** (`examples[]`, `dialogues[]` whose sub-shape
changes by proficiency level). `provenance` is neither repeated nor
shape-variable — it is a small, sparse, fixed set of scalars.

The migration comment (`:16-18`) calls it a *"low-cardinality, variable-shape
value object … not a repeating group."* "Not a repeating group" is correct and
is exactly why it isn't an ADR-005 jsonb array. But "variable-shape" is
inaccurate: the shape is fixed; only *presence* varies (it's **sparse**, not
variable). Sparse ≠ variable-shape, and the ADR draws its jsonb line on
shape-variance, not sparsity.

Discrete columns would buy: a real `BOOLEAN` for `transcript_available` (jsonb
lets the loader write `"true"`, `1`, or `true` — only the loader's Pydantic
guards that, and the DB CHECK here validates only that the top level is an
*object*, not any field's type); direct queryability
(`WHERE transcript_available`) for "which sittings have reconstructed
listening scripts" — a plausible admin/QA question; and a self-documenting
contract in the schema rather than in a comment.

The counter-case (and why this is SHOULD-FIX, not BLOCKER): the data is sparse
audit metadata (`'{}'` for fully-sourced sittings), never joined or filtered by
serving code, and jsonb keeps the column set narrow instead of three
near-always-NULL columns. That is a legitimate engineering trade — but it is a
**departure from the cited ADR**, so the bar is: either (a) model the three as
columns per ADR-005, or (b) keep jsonb and add one sentence to the comment /
an ADR-005 addendum stating provenance departs from the stable-scalar rule
*because it is sparse audit metadata, not because the shape varies* — so the
next author doesn't cite this as precedent for putting fixed scalars in jsonb.
The current text invites exactly that mis-citation.

If jsonb is kept, consider tightening the CHECK to also constrain the known
keys' types (e.g. `provenance->'transcript_available'` is null-or-boolean) so
the DB — not only the loader — enforces the contract. Optional.

### SHOULD-FIX 2 — manual `source_id` remediation is un-reproducible
Not in the migration files; flagged because it is coupled to this change set and
falls in DB scope.

Per the change context, the operator ran a one-off manual `UPDATE` on live
`km-db` to rename 390 pre-existing `source_id`s to the level-qualified scheme so
the reload's upsert matched in place (preserving 4 `topik_responses` FK rows).
A **fresh** environment never needs this — it loads level-qualified ids from the
start, so 030 + the loader fully reproduce the target state. That makes the
manual step acceptable *for fresh envs* and correctly kept out of migration 030
(030's DDL must stay env-independent).

The concern is any **existing** environment carrying old-scheme ids — staging, a
teammate's DB, a restored production backup, DR rehearsal. For those, the only
record of the transformation is the PR description and operator memory. That
violates the reproducibility posture in §4.5 / §6.10 (config-and-data-as-code,
one deterministic path forward). A raw manual `UPDATE` is also not idempotent
and has no guard against double/partial application.

Recommendation (follow-up, does not block 030): commit the remediation as a
guarded, idempotent data-migration script under `db/` (or a numbered data
migration) — `UPDATE … WHERE source_id = <old> AND NOT EXISTS(<new>)`, wrapped so
re-running is a no-op — with a header noting fresh envs don't need it and it
exists solely to carry pre-030 data forward. That turns operator memory into a
reviewable, replayable artifact and protects the 4 FK rows on every environment,
not just the one the operator touched.

## Coordination observations

- **Loader (`load_topik.py`).** 030 makes `provenance` `NOT NULL DEFAULT '{}'`,
  so the loader may omit it safely (rows default to `'{}'`) *or* write it — both
  are valid. If the loader's INSERT enumerates columns for an `ON CONFLICT DO
  UPDATE`, confirm `provenance` is included in the `SET` list so a re-load
  actually refreshes provenance on already-present rows (029 widened the
  conflict target to `(test_number, topik_level, section)`; an upsert that
  doesn't set `provenance` would leave stale/empty provenance on updated rows).
  Out of my file scope — flagging for the loader reviewer.

- **Grain match.** `provenance` lives on `topik_tests`, whose row grain is
  `(test_number, topik_level, section)` after 029. The three provenance facts
  (withheld papers / reconstructed transcript) are naturally per-(test,level,
  section), so the column is at the right grain. No interaction with
  `uq_topik_tests_number_level_section` (029) or `ix_topik_tests_level_section`
  (005) — 030 touches neither. Clean.

- **Rollback tripwire gap (low severity, runner-level).** `migrate.py`'s
  `DESTRUCTIVE_PATTERNS` matches only `DROP TABLE|SCHEMA|DATABASE|TRUNCATE`
  (`migrate.py:79-80`), so the down migration's `DROP COLUMN provenance` does
  **not** require `--allow-destructive` (`rollback_one`,
  `migrate.py:398`). Rolling back 030 therefore silently discards recorded
  provenance audit text without tripping the destructive gate. The down comment
  documents the loss as intended and recoverable, so this is acceptable, but the
  operator should know the tripwire won't fire. Not a 030 defect — a runner
  coverage note.

- **Online-safety claim verified.** `ADD COLUMN … NOT NULL DEFAULT '{}'::jsonb`
  is a metadata-only add in modern Postgres (11+) because the default is a
  constant (non-volatile) expression — no full-table rewrite; existing rows
  read the default. Claim at `up:21-23` is **correct**. Both `ALTER`s still take
  a brief `ACCESS EXCLUSIVE` lock, and the subsequent `ADD CONSTRAINT … CHECK`
  does scan the table to validate — but `topik_tests` is tiny (bounded by TOPIK
  sittings × sections), so the lock/scan window is negligible. The comment's
  *conclusion* (fast/online) is right; its stated *mechanism* is not (see NIT 1).

### NIT detail
- **NIT 1** (`up:22-23`): "The CHECK validates instantly because every
  backfilled value is `'{}'`." Postgres runs a full validating table scan for a
  plain `ADD CONSTRAINT … CHECK` regardless of the values — it does not skip the
  scan on the knowledge that all rows satisfy it. The add is fast here because
  the **table is tiny**, not because the rows are `'{}'`. Reword to avoid
  teaching the next author a false optimization (the correct large-table pattern
  would be `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT`).
- **NIT 2** (`up:25-30`): the `ADD COLUMN` and `ADD CONSTRAINT` are separate
  `ALTER TABLE` statements → two lock acquisitions. Combining into one
  `ALTER TABLE topik_tests ADD COLUMN … , ADD CONSTRAINT … ;` takes the lock
  once. Immaterial on a tiny table; pure preference.
