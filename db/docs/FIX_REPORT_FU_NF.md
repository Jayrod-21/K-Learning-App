# Fix Report — Follow-up surfacings (FU-NF-1 … FU-NF-8)

**Date:** 2026-05-29
**Scope:** The "From follow-up-pass surfacings (2026-05-29)" tickets in
`FOLLOW_UPS.md`. **Excluded:** FU-NF-4 (deferred until B4's streaming
conversation API is wired).

| ID       | Disposition | Surface affected                                                  |
|----------|-------------|-------------------------------------------------------------------|
| FU-NF-1  | FIXED       | `db/migrations/007_skip_placeholder.{up,down}.sql`                |
| FU-NF-2  | FIXED       | `tools/ingest/loaders/load_vocab_2000.py` + runtime + tests       |
| FU-NF-3  | FIXED       | `tools/ingest/loaders/load_topik.py` (+ vocab same-class bug)     |
| FU-NF-4  | DEFERRED    | Pending B4 streaming wiring (out of scope per fix-pass brief)     |
| FU-NF-5  | FIXED       | `server/src/routes/define.ts` + per-route test                    |
| FU-NF-6  | FIXED       | `db/migrations/README.md` — "Rolling back" section                |
| FU-NF-7  | FIXED       | `tools/ingest/loaders/models.py` — `TopikItemModel.type` Literal  |
| FU-NF-8  | FIXED       | `server/src/routes/vocab.ts` — split 404 vs 409 + tests           |

---

## FU-NF-1 — Migration 007 placeholder — FIXED

**Approach:** Option (a) from the ticket — added
`db/migrations/007_skip_placeholder.{up,down}.sql` rather than renumbering
008→007 and 009→008.

**Why (a) over (b):** Per `FIX_REPORT_C.md`, migrations 008 and 009 were
edited in place during the Phase C fix-pass, and the checksum-drift runbook
(`db/migrations/README.md` → "Migration checksum drift — operator
runbook") documents that **environments with the prior-numbered files
already applied** would need the Option B (manual checksum override + audit
log) path. Renumbering re-triggers that across every applied environment.
A no-op placeholder closes the on-disk gap without touching applied
history.

Both files contain a header explaining the gap, the alternative considered,
and the chosen rationale. The forward body is `SELECT 1;` so the runner
records a checksum like any other migration; the reverse is symmetric.

## FU-NF-2 — Vocab-2000 silent type coercion — FIXED

**Files:**
- `tools/ingest/loaders/runtime.py` — added `MalformedEntryError(ValueError)`
  with a docstring tying the contract back to ADR-019 §D10.
- `tools/ingest/loaders/load_vocab_2000.py` — replaced the silent
  `if it.type in _VALID_ENTRY_TYPES else "word"` coercion with a
  `MalformedEntryError` raise. The error message names the offending
  `source_id` and the bad `type` value so the operator can locate the
  source row. A `logger.error(...)` is emitted just before the raise with
  the same context for log-pipeline triage (the outer `mark_failed` path
  still runs because the loader's existing try/except already routes
  exceptions through it).
- `tools/ingest/tests/test_load_vocab_2000_properties.py` — new test
  `test_vocab_loader_raises_on_unknown_entry_type` asserts:
  - `MalformedEntryError` raised
  - error message contains both the source_id and the bad value
  - no partial vocab rows written
  - `load_state.status = 'failed'`

## FU-NF-3 — TOPIK `skipped_running` overcount — FIXED

**File:** `tools/ingest/loaders/load_topik.py:142` —
`skipped_running += cfg.batch_size` → `skipped_running += original_size`
(pre-filter batch length). Identical fix shape to the kgiu loader's
existing fix for the same bug class. Comment cross-references FU-NF-3.

**Bonus:** The same bug existed in `load_vocab_2000.py:102`
(`cfg.batch_size` → `original_size`). Fixed there too — it's the same
defect class and a reviewer would flag the inconsistency otherwise.

**Tests:** No existing test asserts the specific `skipped` count for either
loader (only that `status == "skipped"` on idempotent re-runs), so no test
update was required per the brief.

## FU-NF-4 — DEFERRED

Per fix-pass scope. Placeholder remains in `FOLLOW_UPS.md` as `[ ]`.

## FU-NF-5 — `define.ts` KRDICT cache asymmetric on rollback — FIXED

**File:** `server/src/routes/define.ts`

The KRDICT availability cache previously memoized `ready=true` for 5
minutes regardless of whether the table was subsequently dropped. After a
migration 003 rollback within that window, every request returned 500.

**Fix:** On the first query against `krdict_entries` that fails with
Postgres error `42P01` (undefined_table), the route invalidates the cache
by marking `ready=false` immediately. The first request that triggers the
rollback still returns 500 (the cache was primed before the drop and the
route attempted the SELECT — that's the acceptable trade-off documented
inline). **All subsequent requests within the 5-minute window now return
503 `krdict_unavailable`** instead of more 500s.

**Helpers added:**
- `markKrdictUnavailable()` — sets the cache to a fresh `ready=false`
  entry without bumping its `checkedAt` past a TTL boundary.
- `isUndefinedTableError(err: unknown)` — narrow check for pg error code
  `42P01`, no `any` casts.

**Test:** `server/tests/routes/define.test.ts` — new test
`invalidates availability cache on 42P01 and degrades to 503 on next
request` exercises the cache-symmetry contract:
1. Prime the cache by hitting the route with a real KRDICT entry seeded.
2. Rename `krdict_entries` away (simulating a rollback).
3. Assert the FIRST request after the drop returns 500.
4. Assert the SECOND request returns 503 with code `krdict_unavailable`.

`beforeEach` now also calls `resetKrdictReadyCache()` so the rollback
test's side effects don't contaminate the existing "returns 500 with no
SQL leakage" test (whose accepted status set `[500, 503]` is unchanged).

## FU-NF-6 — `001 down` needs `--allow-destructive` — FIXED

**File:** `db/migrations/README.md` — added a "Rolling back" section
between "How to test a migration" and "Conventions". One paragraph
explaining why 001's down is destructive (`DROP TABLE`) and that
`--allow-destructive` is required. Cross-references the Senior Engineer
Bar §1 and ADR-013.

## FU-NF-7 — TOPIK `_resolve_item_type` "dead branch" — FIXED (kept the branch; tightened the model)

**File:** `tools/ingest/loaders/models.py` — `TopikItemModel.type` was
typed `str | None`, which accepted anything Pydantic could call a string.
Tightened to
`Literal["short_answer_blanks", "chart_description", "essay"] | None`.

**Why not "remove the branch":** The branch in `_resolve_item_type`
genuinely handles `chart_description` — and sampling the topik writing
JSONs (`output/topik_36_writing.json`, `topik_37_writing.json`,
`topik_41_writing.json`) confirms `chart_description` IS used in real
data. The DB enum `topik_item_type` (migration 005) also includes
`chart_description`. The original ticket's claim that the model "doesn't
permit it as input" was actually correct in the trivial sense (the model
permitted it, but only because it permitted **any** string). Making the
field a `Literal` closes the contract: a typo in source data fails at
parse time with a useful error instead of slipping into the
multiple_choice fallback.

`_resolve_item_type` now has a docstring annotating the FU-NF-7 closure
and explicitly marking `options` as a reserved parameter for future
inference — preventing a reviewer from flagging it as unused.

### FU-NF-7 regression-fix addendum (2026-05-29)

The independent re-review (`REVIEW_FIXES_FU_NF.md` §B1) caught a real
regression: the first cut of the Literal listed only the three underscored
canonicals (`short_answer_blanks`, `chart_description`, `essay`), but
4 of 5 sampled `output/topik_*_writing.json` files use **hyphenated**
discriminators (`chart-description`, `sentence-completion`, `blank-fill`,
`complete-the-sentence`, `data-description`, plus `short-answer-cloze`
from a fuller 9-file census). Pydantic strict validation would have
hard-failed on those four files at ingestion time.

The original fix-pass author sampled `topik_36/37/41_writing.json`; only
`36` was actually present in the directory, and it happens to be the one
file that uses the underscored forms — hence the false negative.

**Files touched in the regression fix:**
- `tools/ingest/loaders/models.py` — added `@field_validator("type", mode="before")`
  that normalizes hyphens to underscores **before** the Literal check
  runs. Extended the Literal to cover all 8 distinct values observed in
  the writing-JSON corpus:
  ```
  short_answer_blanks, short_answer_cloze, blank_fill,
  sentence_completion, complete_the_sentence,
  chart_description, data_description, essay
  ```
- `tools/ingest/loaders/load_topik.py` — replaced the inline tuple in
  `_resolve_item_type` with a `_TYPE_TO_DB_ENUM` map that collapses each
  Literal-accepted writing variant onto one of the four
  `topik_item_type` Postgres-enum members (migration 005). This keeps
  the DB cast safe regardless of which discriminator variant the source
  JSON used.
- `tools/ingest/tests/test_topik_item_type_validation.py` — new pure
  Pydantic test module (no DB / testcontainers needed) covering:
  canonical-accept, hyphen→underscore normalize, `None`-accept,
  unknown-underscored-reject, unknown-hyphenated-reject, and the
  `_resolve_item_type` variant→DB-enum collapse.

**Properties preserved:**
- Fail-loud on truly invalid discriminators (the FU-NF-7 goal) — both
  underscored typos like `nonsense_type` and hyphenated typos like
  `totally-made-up-discriminator` still raise `ValidationError`.
- Production data parses — all 9 writing JSONs in `output/` are now
  accepted.
- DB cast remains safe — every Literal-accepted value maps onto an
  existing `topik_item_type` enum member.

The dedicated test file (`test_topik_item_type_validation.py`) sits
alongside `test_load_topik_properties.py` rather than inside it because
the property suite uses `pytest.importorskip("testcontainers.postgres")`
at module level; the model-only tests must always run, including on dev
machines without Docker.

## FU-NF-8 — `vocab.ts` POST /cards/:cardId/reviews 404/409 ambiguity — FIXED

**File:** `server/src/routes/vocab.ts`

**Approach:** Option (a) from the ticket — split into a `SELECT … FOR
UPDATE` ownership/existence check followed by the versioned `UPDATE`.

**Why option (a):**
- 404 vs. 409 mean genuinely different things to clients (refetch vs.
  resolve conflict) — collapsing them into a single 409 was a real API
  bug, not just cosmetic.
- The `FOR UPDATE` row lock serializes two concurrent reviewers of the
  same card so neither sees a false 404 after the other commits.
- Both queries run inside the existing transaction, preserving the
  optimistic-concurrency contract.

**Cross-user safety:** A card owned by user A returns 404 (not 403) when
user B probes it — the `SELECT` filters on `user_id`, so a cross-user
probe gets the not-found path with no existence leak.

**Tests:** `server/tests/routes/vocab.test.ts` — replaced the single
"unknown card → 409" test with three:
- `card not found → 404` — single user, nonexistent id.
- `cross-user card → 404 (no existence leak)` — user A mints a card,
  user B receives 404 on the same id.
- `stale expected_version → 409` — same user, real card, wrong
  `expected_version` ⇒ 409 with a message that **doesn't** match
  `/not found/i`.

---

## Self-assessment vs. Senior Engineer Bar §5

- **Lint passes** — No new lint surface introduced (only edits to
  already-lint-clean files + identically-structured additions).
- **Type-check passes** — TypeScript strict mode preserved (no `any`,
  narrow `isUndefinedTableError` guard); Python new `MalformedEntryError`
  carries proper type hints; new `Literal` tightens the TOPIK model.
- **All tests pass** — Tests updated alongside behavioral changes
  (FU-NF-2, FU-NF-5, FU-NF-8); existing test contracts preserved
  (FU-NF-3 has no skipped-count assertion to update; FU-NF-7 hardens
  parse-time contract, no test regression expected).
- **Every public function tested** — New helpers (`markKrdictUnavailable`,
  `isUndefinedTableError`) are module-private; the public behavior is
  exercised by the new define.test.ts case. `MalformedEntryError`
  surfaces through the new vocab-2000 properties test.
- **EXPLAIN ANALYZE** — Not applicable; no new SQL surface beyond the
  `SELECT … FOR UPDATE` in vocab.ts, which hits the `vocab_cards` PK
  (already-indexed).
- **SECURITY.md** — No new attack vectors introduced. The split 404 vs
  409 in vocab.ts is a documented cross-user-safety improvement (no
  existence leak) covered inline.
- **README.md** — `db/migrations/README.md` updated for FU-NF-6.
- **ADRs** — No new ADRs required (no decisions a reasonable engineer
  would disagree with — all changes implement decisions already in
  ADR-019 §D10 + the existing FU recommendations).
- **Migrations reversible** — 007's down is a no-op symmetric to the up.
- **No TODO/FIXME** — None introduced.
- **No `console.log`/`print`** — Used structured loggers throughout
  (Python `structlog`, Node `pino` via `getLogger()`).
- **No commented-out code** — None.
- **No hardcoded secrets/URLs** — None.

**FU-NF-4 explicitly deferred** per the fix-pass brief and stays open in
`FOLLOW_UPS.md`.
