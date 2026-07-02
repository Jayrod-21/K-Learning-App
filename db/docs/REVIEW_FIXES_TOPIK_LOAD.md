# Review: fix-pass for TOPIK corpus-load fixes

**Re-reviewer:** Independent senior engineer. Did not author the code and did not
write the original three review reports. Fresh, skeptical, verify-don't-trust.
**Branch:** `topik-corpus-load-fixes` (vs base `rebuild`).
**Scope verified:** `tools/ingest/loaders/load_topik.py`, `.../loaders/models.py`,
`db/migrations/030_topik_tests_provenance.{up,down}.sql`,
`db/data_migrations/2026-07-02_topik_source_id_level_qualify.sql`,
`tools/ingest/tests/test_load_topik.py` + all six fixtures, `.gitignore`,
`db/migrate.py` (runner-scope check).
**Verification method:** line-by-line read of the actual current code (not the
self-report), a full test run in the prescribed Testcontainers harness, and a
teeth-check that reverts *only* the B1 raise in a throwaway in-container copy.

## Summary verdict

**PASS.**

Every BLOCKER and SHOULD-FIX across REVIEW_TOPIK_LOAD_A/_B/_C is genuinely fixed
in the current code — I confirmed each against the source, not the fix-report's
claims. The B1 regression test has real teeth: it empirically produces the
`actual=1 vs total=2` mismatch, and when I revert only the B1 raise it fails with
`DID NOT RAISE CountAssertionError`. All praise items are preserved (nothing
relaxed). The suite is green (5 passed). I found no regressions and no new
blockers — one new cosmetic NIT (an over-broad `.gitignore` glob) and two minor
observations that do not block ship.

## Finding-by-finding verification

| Finding ID | Source | Orig severity | Fix status | Notes |
|---|---|---|---|---|
| **B1** | REVIEW_B | BLOCKER | **FIXED** | Mismatch now `log.error` + `raise CountAssertionError`; `mark_complete` unreachable on mismatch (guarded by the raise inside the `try`). Regression test proven to fail on reverted code. See detail. |
| **B-S1** | REVIEW_B | SHOULD-FIX | **FIXED** | `answers_verified_against` added to the provenance dict (`load_topik.py:178`); asserted in the collision test (`test:214`). Round-trips as `"Fixture: official NIIED answer key"`. |
| **B-S2** | REVIEW_B | SHOULD-FIX | **FIXED** | `answer: int \| None`, `model_answer: dict[str, Any] \| str \| None` (`models.py:139-140`). No bare `Any` on these fields; narrowing justified in-comment. All fixtures + suite validate. |
| **B-S3** | REVIEW_B | SHOULD-FIX | **FIXED** | `try` hoisted to span `model_validate_json` + first tx + batches (`:126`). First tx keeps its own atomic `conn.transaction()` (`:135-224`) so `mark_in_progress` rolls back with the tests row. `except` records `failed` in a **fresh** tx via `get_or_create_checkpoint` + `mark_failed` (`:306-322`). |
| **B-S4** | REVIEW_B | SHOULD-FIX | **FIXED** | `skill_tag_raw` removed from the `extra` dict; column-only (`extra` now holds `char_range` only, `:349-355`). Comment states why. |
| **A-S1 / A-N1** | REVIEW_A | SHOULD-FIX / NIT | **FIXED** | 030 comment reworded to "FIXED set of known scalars … SPARSE, not variable-shape" (`030.up:16-17`); false instant-CHECK claim corrected to full-scan-but-tiny + `NOT VALID`/`VALIDATE` note (`:29-34`); explicit `NOTE (ADR-005)` departure para (`:22-26`). jsonb **kept**; `ck_topik_tests_provenance_object` **kept**. |
| **A-S2** | REVIEW_A | SHOULD-FIX | **FIXED** | New `db/data_migrations/2026-07-02_topik_source_id_level_qualify.sql`; old-shape-only `WHERE` → re-run is a no-op; outside `db/migrations/` so the runner never auto-applies it (verified `MIGRATIONS_DIR_DEFAULT`); header documents fresh-env/​FK rationale. |
| **C-S1** | REVIEW_C | SHOULD-FIX | **FIXED** | Tests 1 & 2 scoped to `test_number = 99` (`test:102-116`, `:133-143`) via direct predicate + join. Order-independent against test-97/98 rows. |
| **B-N2** | REVIEW_B | NIT (cleared) | **FIXED** | `assert row is not None` → explicit `if row is None: raise RuntimeError(...)` (`:216-223`); survives `python -O`. |
| **C-N1** | REVIEW_C | NIT (cleared) | **FIXED** | `.gitignore:27` adds file-form `tools/ingest/output.*`. Corpus dir + `output.tar.gz` confirmed ignored. (See new NIT-1 re over-breadth.) |
| **A-N2** | REVIEW_A | NIT | **DEFERRED-WITH-DOC** | Combine two `ALTER`s. Reviewer called it "immaterial on a tiny table; pure preference"; not in the cleared list. Reasonable deferral. |
| **B-N1** | REVIEW_B | NIT | **DEFERRED-WITH-DOC** | Unused `options` param. Documented-reserved (`_resolve_item_type` docstring + `_ = options`). Reasonable deferral. |
| **C-N2** | REVIEW_C | NIT | **REJECTED-WITH-RATIONALE** | Item-grain assertions aren't the load-bearing guards. Left intact per C-PRAISE (must not relax). Correct — nothing was relaxed, provenance assertion **added**. |

## Bar checklist (post-fix state)

| Bar item | Verdict | Evidence |
|---|---|---|
| §0 Fail loud / no silent swallow | **PASS** | Count mismatch is now a hard, recorded `failed`; the one silent-success path is gone (B1). |
| §1.2 [P0] No bare `Any` | **PASS** | `answer`/`model_answer` narrowed; remaining `Any` only inside `dict[str, Any]`, justified. |
| §1.3 [P0] Pydantic validates at boundary | **PASS** | Narrowed types actually reject malformed `answer`; all fixtures validate. |
| §1.8 [P0] No swallowed exceptions; `mark_failed` on error | **PASS** | `try` covers validation + first tx + batches; `except` records `failed` + `last_error`. |
| §4.1 `jsonb` value object + named CHECK | **PASS** | 030 keeps jsonb + `ck_…_object`; ADR-005 departure documented, not silently violated. |
| §4.5 [P0] Migration has tested downgrade; no applied-migration edit | **PASS** | 030 is a **new** file (absent in `rebuild`) — no applied-migration mutation; `.down.sql` reverses exactly (`IF EXISTS`). |
| §4.5 / §6.10 Data-as-code, reproducible | **PASS** | Manual live-DB rename captured as a guarded, idempotent, reviewable script. |
| §4.7 [P0] Parameterized queries only | **PASS** | 100% `%s` binds; corpus pinned as a literal; no interpolation. |
| §5.2 [P0] Bug fix ships a test that fails on old code | **PASS** | B1 test proven to fail on reverted code (teeth-check below). |
| §5.3 [P0] Isolated — any order | **PASS** | All five tests scoped to their own `test_number` (97/98/99). |
| §5.4 [P1] Real infra via Testcontainers | **PASS** | Real Postgres 16; all `db/migrations/*.up.sql` applied from disk. |
| DRY | **PASS** | `skill_tag_raw` no longer double-written. |

## New findings introduced by the fix-pass

### BLOCKER (new)
None.

### SHOULD-FIX (new)
None.

### NIT (new)
1. **`.gitignore:27` `tools/ingest/output.*` is over-broad** — it fixes C-N1
   (file-form backups) but the same pattern would also silently ignore a future
   *source* file named `tools/ingest/output.py` (confirmed:
   `git check-ignore` matches `tools/ingest/output.py`). No such file is tracked
   today, so this is latent, not active. A tighter pattern
   (`tools/ingest/output.*.bak`, `output.tar.gz`, `output.*.json`, or anchoring
   to known backup suffixes) would keep the C-N1 guarantee without the collision
   risk. Cosmetic; does not block.

### PRAISE (new)
1. **B1 fixture is minimal and honest about its own mechanism.** `batch_size=1`
   is documented in-test as necessary so the two duplicate-id rows land in
   separate INSERT commands (a single `executemany` would raise a *different*
   cardinality error before the count check). That comment is exactly the kind of
   subtlety a lazy regression test gets wrong — this one gets it right, and the
   run confirms the intended path (`expected: 2, actual: 1` then
   `CountAssertionError`).
2. **First-transaction atomicity was preserved while hoisting the `try`.** The
   easy wrong fix for B-S3 is to wrap each statement in its own tx or to leave
   `mark_in_progress` orphaned on a tests-row failure. The author kept the single
   `conn.transaction()` boundary and put the failure-recording in a *fresh* tx in
   the `except` — the correct shape.

## Detailed findings

### B1 — teeth-check (the point of this re-review)

Static trace of the current code (`load_topik.py:268-305`): the count query runs
in its own connection; on `actual != total_items` the loader `log.error`s then
`raise CountAssertionError`. That raise is inside the `try` (`:126`), so it routes
to the `except` (`:306`) which runs `mark_failed` and re-raises → non-zero exit.
`mark_complete` (`:296-298`) is only reached on the fall-through when
`actual == total_items`. So on a mismatch `mark_complete` is **unreachable**. ✔

Fixture trace (`topik_mini_dup_ids.json`): two items share the id
`topik97-I-read-001`. With `batch_size=1` each lands in a separate INSERT; the
second hits `ON CONFLICT (corpus, source_id) DO UPDATE` and collapses onto the
first → **1** row for the sitting while `total_items = 2`. Empirically confirmed
by the captured log during the run: `{"expected": 2, "actual": 1,
"event": "count_assertion_mismatch"}`. So the fixture genuinely produces
`actual < total` — it does not pass for the wrong reason. ✔

Teeth-check: I copied the repo to a throwaway `/work` **inside the container**
(host tree untouched) and neutralized only the `raise CountAssertionError(...)`
(replaced with `pass`, restoring the pre-fix warn-then-fall-through-to-
`mark_complete`). The B1 test then **failed**:

```
>   with pytest.raises(load_topik.CountAssertionError):
E   Failed: DID NOT RAISE CountAssertionError
```

So the test would fail on the pre-fix behavior (and would additionally
`AttributeError` on `load_topik.CountAssertionError` against truly pristine
pre-fix code, since the class did not exist) — three independent reasons it
cannot pass on old code. The host `load_topik.py` still has the real
`raise CountAssertionError` at line 290; nothing was left modified. ✔

The test also asserts `load_state.status == 'failed'` and `last_error IS NOT NULL`
(`test:302-310`), so it locks both the "not complete" and the "recorded for
triage" halves of the fix, not just the raise. ✔

### Observations (non-blocking, no action required)

- **B-S2 lax coercion.** `answer: int | None` uses Pydantic's default (lax) mode,
  so a JSON string `"1"` would coerce to `1` rather than fail. The reviewer's
  stated goal ("a stray string where an option index is expected fails loud") is
  met for genuinely non-numeric junk (`"abc"` raises) but not for numeric
  strings. Given the source is Claude-vision JSON where an option index is always
  emitted as a bare int, this is acceptable; a `Strict`/`strict=True` annotation
  would be belt-and-suspenders. Not required by the bar for this field.
- **A-S2 TOPIK-I assumption.** The remediation script injects `-I-`
  unconditionally, correct only because "every pre-fix `source_id` in the wild is
  TOPIK-I data." That assumption is explicitly documented in the script header
  and the script is manual-run + guarded + idempotent, so it is a reviewable,
  bounded risk rather than a hidden one. If a pre-fix env ever held old-scheme
  TOPIK-II ids, the script would mislabel them — but that env is documented not to
  exist. Acceptable.

## Coordination observations

- **The unit still moves coherently.** Loader `ON CONFLICT
  (test_number, topik_level, section)` (`load_topik.py:193`) ↔ migration 029
  unique key ↔ 030 `provenance` jsonb + CHECK ↔ model `Literal` ↔ `_TYPE_TO_DB_ENUM`
  ↔ playbook id scheme are mutually consistent. Confirmed the loader upsert `SET`
  list includes `provenance` (`:198`), so a re-load refreshes provenance on
  already-present rows (the concern REVIEW_A raised).
- **Runner scope verified.** `db/migrate.py` discovers only
  `db/migrations/NNN_*.up.sql` (`MIGRATIONS_DIR_DEFAULT = __file__.parent /
  "migrations"`), and the test harness globs the same dir — so
  `db/data_migrations/` is never auto-applied by either. The A-S2 script and 030
  are both **not** gitignored (they must be committed) — confirmed via
  `git check-ignore`.
- **030 is new, not an edit-in-place.** `db/migrations/030_*.{up,down}.sql` are
  untracked and absent from `rebuild`, so the "reworded comment" is authored
  content on a brand-new migration, not a mutation of an applied file — no §4.5
  concern.
- **Praise preservation confirmed against source.** B-P1 cast alignment
  (10 cols/10 casts, `load_topik.py:184-214`) untouched; B-P2 `short_answer` on
  both sides (`models.py:178` + `load_topik.py:71`) untouched; C collision test
  `topik_tests == 2` (`test:169`), `provenance->>'transcript_available'`
  (`:204`), distinct-`source_id == 2` (`:194`) all intact — only the
  `answers_verified_against` assertion was **added**.

## Test run

Prescribed harness (Testcontainers Postgres 16, all `db/migrations/*.up.sql`
applied from disk), pinned deps:

```
5 passed, 1 warning in 5.03s
```

The 1 warning is the pre-existing `KgiuItemModel.register` parent-attribute-shadow
(`models.py:242`), unrelated to this change set. Teeth-check run (B1 raise
reverted, in-container copy): `1 failed` as required, proving the regression
test's value.

## Recommendation

**Ready to ship.** All BLOCKER + SHOULD-FIX + cleared-NIT items are FIXED and
verified against the actual code; the B1 regression test is proven to have teeth;
no regressions were introduced. The single new NIT (over-broad `.gitignore`
`output.*` glob) is cosmetic and latent — fold it into a follow-up alongside the
two documented observations if desired, but it does not gate the merge. No new
BLOCKERs; no further fix-pass needed.
