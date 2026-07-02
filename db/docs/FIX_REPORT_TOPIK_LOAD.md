# Fix-pass report: TOPIK corpus load

**Branch:** `topik-corpus-load-fixes`
**Author:** Independent fix-pass engineer (did not write or review the original change).
**Scope:** every BLOCKER + SHOULD-FIX across REVIEW_TOPIK_LOAD_A / _B / _C, plus the cheap NITs explicitly cleared for fixing (A-N1, B-N2, C-N1).
**Verification:** `tools/ingest/tests/test_load_topik.py` (Testcontainers Postgres 16, all `db/migrations/*.up.sql` applied from disk) + local km-db migration 030 re-sync.

Praise items preserved verbatim: B-P1 (`topik_tests` upsert cast alignment — untouched), B-P2 (`short_answer` on both sides of the enum bridge — untouched), C-PRAISE (`topik_tests == 2` + provenance + distinct-source_id assertions in the collision test — all left intact; the answers-verified assertion was **added**, none relaxed).

---

## Disposition table

| ID | Finding | Disposition |
|----|---------|-------------|
| **B1** (BLOCKER) | Count mismatch warns then `mark_complete` → silent partial-load recorded as success | **FIXED** |
| **B-S1** | `answers_verified_against` modeled but dropped from provenance | **FIXED** |
| **B-S2** | Bare `Any` on `answer` / `model_answer` | **FIXED** |
| **B-S3** | `mark_failed` does not cover validation + first (topik_tests) tx | **FIXED** |
| **B-S4** | `skill_tag_raw` double-stored (own column + `extra`) | **FIXED** |
| **A-S1** | Migration 030 mis-labels shape "variable"; ADR-005 tension undocumented | **FIXED** (kept jsonb, reworded, added ADR-005 departure note) |
| **A-S2** | Manual live-DB `source_id` rename is un-reproducible / un-audited | **FIXED** (guarded idempotent data script) |
| **C-S1** | Pre-existing tests 1 & 2 assert GLOBAL `COUNT(*)` → order-coupling | **FIXED** |
| **A-N1** | 030 "validates instantly because every value is '{}'" states wrong mechanism | **FIXED** |
| **B-N2** | `assert row is not None` (stripped under `python -O`) | **FIXED** |
| **C-N1** | `.gitignore output.*/` misses file-form backups (`output.tar.gz`) | **FIXED** |
| A-N2 | Two `ALTER TABLE` statements take two `ACCESS EXCLUSIVE` locks | **DEFERRED** — reviewer verdict "immaterial on a tiny table; pure preference." Not in the cleared-NIT list; combining would rewrite the migration body for zero practical gain. |
| B-N1 | `_resolve_item_type` `options` param unused (reserved) | **DEFERRED** — reviewer verdict "Acceptable … mild YAGNI." Documented-reserved; not in the cleared-NIT list. |
| C-N2 | Collision test item-grain assertions aren't the load-bearing guards | **NO ACTION** — reviewer verdict "Fine as-is"; C-PRAISE forbids relaxing them. Left intact. |

All recommended fixes were applied as recommended; none was rejected.

---

## Detail

### B1 — count mismatch now fails loud (ADR-019 D8)
`tools/ingest/loaders/load_topik.py`

- Added a domain exception `CountAssertionError(RuntimeError)` with a docstring citing ADR-019 D8.
- On `actual != total_items` the loader now `log.error`s then **raises** `CountAssertionError` instead of `log.warning` + `mark_complete`. The raise routes through the `except`, which records the source `failed` (+ `last_error`) and re-raises so the process exits non-zero. `mark_complete` is no longer reachable on a mismatch, so the sha-based skip guard can never make a partial load permanently invisible.
- **Regression test:** `test_topik_count_mismatch_marks_failed_not_complete` with a new fixture `topik_mini_dup_ids.json` (two items sharing one `source_id`, `test 97`). Loaded with `batch_size=1` so the duplicate rows land in separate INSERT commands (a single `executemany` would raise a *different*, cardinality error before the count check). Under the fix: 1 row lands, `total_items=2`, `CountAssertionError` raised, `load_state.status='failed'`, `last_error` non-null. This test cannot pass on the old code — the old code neither raises nor defines the exception.

### B-S1 — `answers_verified_against` persisted
`load_topik.py` provenance dict now includes `"answers_verified_against": doc.source.answers_verified_against` (survives the `is not None` filter and migration-030 object CHECK). Fixture `topik_mini_II_listening.json` gained the field; the collision test now asserts `provenance->>'answers_verified_against'` round-trips.

### B-S2 — narrowed boundary types
`models.py`: `answer: int | None`, `model_answer: dict[str, Any] | str | None` (matches observed shapes: `answer ∈ {int,null}`, `model_answer ∈ {dict,str,null}`). Comment justifies the narrowing per bar §1.2. `Any` import retained (still used in `dict[str, Any]` here and elsewhere). All fixtures still validate (suite green).

### B-S3 — failure recording covers the whole load
`load_topik.py`: the `try` was hoisted to span `model_validate_json` + the first (catalog + `topik_tests`) transaction as well as the item batches. The first transaction keeps its own atomic boundary (`mark_in_progress` + catalog + tests row commit/rollback together — preserved as the reviewer required). The `except` now calls `get_or_create_checkpoint` before `mark_failed`, so a failure that rolls back the first tx (or a validation error before any row exists) still leaves a `failed` row with `last_error` for triage (ADR-019 D4). This path is exercised by the B1 test.

### B-S4 — `skill_tag_raw` de-duplicated
`_insert_item_batch`: dropped `skill_tag_raw` from the `extra` dict (it keeps its dedicated column); `char_range` remains (no column). Comment updated to state why `skill_tag_raw` is deliberately excluded. Guards against silent divergence between `skill_tag_raw` and `extra->>'skill_tag_raw'`.

### A-S1 / A-N1 — migration 030 comment corrected
`030_topik_tests_provenance.up.sql`: **jsonb kept** (legitimate sparse-audit-metadata trade). Reworded "variable-shape" → "FIXED set of known scalars … SPARSE, not variable-shape." Added an explicit `NOTE (ADR-005)` sentence: this departs from the stable-scalar rule *because the data is sparse audit metadata, not because the shape varies* — do not cite as precedent for queryable fixed scalars. Fixed the false-optimization claim: `ADD CONSTRAINT … CHECK` does a full validating scan regardless of values; it is fast here only because the table is tiny; the large-table pattern is `NOT VALID` then `VALIDATE CONSTRAINT`.

### A-S2 — reproducible source_id remediation
No prior data-migration convention existed (`db/scripts` holds only backup/restore shell). Created `db/data_migrations/2026-07-02_topik_source_id_level_qualify.sql` — deliberately outside `db/migrations/` so the numbered runner never auto-applies it. It is a guarded, idempotent `UPDATE topik_items SET source_id = regexp_replace(source_id, '^(topik[0-9]+)-(listen|read|write)-', '\1-I-\2-') WHERE corpus='topik' AND source_id ~ '^topik[0-9]+-(listen|read|write)-'`. Injects `-I-` (all pre-fix ids are TOPIK-I). The WHERE clause matches only the old shape, so re-running is a no-op and a fresh DB is untouched. Header explains: fresh envs don't need it; it carries pre-030 data forward; rename-in-place lets the loader upsert match existing rows; and because `topik_responses.topik_item_id → topik_items(id)` (surrogate, not `source_id`), keeping the rows preserves those FK rows.

### C-S1 — test isolation
`test_load_topik.py`: tests 1 & 2 now scope their counts to `test_number = 99` (`topik_tests` directly; `topik_items` via join). Order-independent against the test-97/98 rows the other tests insert into the module-scoped container. The two new tests already scoped to 98; unchanged.

### B-N2 — explicit raise
`load_topik.py`: `assert row is not None` on the `topik_tests` `RETURNING id` replaced with an explicit `if row is None: raise RuntimeError(...)` (survives `python -O`).

### C-N1 — gitignore file-form backups
`.gitignore`: added `tools/ingest/output.*` (no trailing slash) alongside `output.*/`. Verified with `git check-ignore`: `output/`, `output.pre-idfix.bak/`, `output.rootbak/`, `output.tar.gz`, `output.bak.json` **all ignored**; `db/data_migrations/2026-07-02_topik_source_id_level_qualify.sql` **not** ignored; 81 legitimately-tracked files under `tools/ingest` unaffected.

---

## Self-assessment against the bar

- **§0 Fail loud / no silent swallow** — B1 converts the one silent-success path to a hard, recorded failure. ✔
- **§1.2 No bare `Any`** — `answer` / `model_answer` narrowed. ✔
- **§1.8 No swallowed exceptions; record failure** — `mark_failed` now covers validation + every tx. ✔
- **§5.2 [P0] every bug fix ships a regression test that fails on old code** — B1 gets `test_topik_count_mismatch_marks_failed_not_complete`; B-S1 adds a provenance round-trip assertion; B-S4 / C-S1 covered by the existing (now order-safe) suite. ✔
- **§5.3 [P0] isolated, any order** — global-count coupling removed. ✔
- **§4.5 [P0] never edit an applied migration destructively** — 030's edit is comment-only; re-synced by roll-down/roll-up on local km-db (see below). ✔
- **§4.5 / §6.10 data-as-code** — the manual live-DB mutation is now a guarded, idempotent, reviewable script. ✔
- **DRY** — `skill_tag_raw` no longer double-written. ✔

### Test command output
```
$ docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$PWD":/repo -w /repo -e PYTHONPATH=/repo/tools/ingest python:3.12 \
    sh -ec 'pip install --quiet ... && python -m pytest tools/ingest/tests/test_load_topik.py -q'
.....
5 passed, 1 warning in 4.95s
```
5 passed = the 4 original tests (tests 1 & 2 now scoped; collision + writing tests untouched except the added provenance assertion) + the new B1 regression test. The 1 warning is pre-existing (`KgiuItemModel.register` shadows a parent attribute) and unrelated to this change.

### Migration 030 re-sync (local km-db)
`run_migrate status` showed 030 `MISMATCH` after the comment edit. Rolled back to 029 then re-applied:
```
rollback.commit 030 → migrate.plan [030] → apply.commit 030
status: 030  topik_tests_provenance  applied  yes
```
Post-resync verification: `topik_tests.provenance` exists (`NO` null, default `'{}'::jsonb`) and constraint `ck_topik_tests_provenance_object` exists. Clean.
