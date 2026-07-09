# ADR-019: Corpus loader orchestration

**Status:** Accepted
**Date:** 2026-05-28
**Owner:** Agent B3 (server + loaders)
**Depends on:** ADR-001 (foundation), ADR-005 (stable cols vs JSONB)

## Context

We need to load 8 corpus JSON files into Postgres:
- TTMIK lesson series (3 files: levels 1-3, 4-6, 7-9)
- TTMIK Iyagi podcast (3 files: 1-50, 51-100, 101-146)
- TOPIK item pool (3 sections × multiple test numbers; ~30 files)
- KGIU grammar (3 levels)
- 2000 Words vocab (2 levels)

The existing loader, `load_to_supabase.py`, is being retired alongside
Supabase. We need a new orchestrator that:

- Reads JSON from `tools/ingest/output/`
- Writes to Postgres (psycopg async pool, ADR-001 §D13)
- Is **idempotent** (re-run safe) — bar §"Idempotency"
- Is **resumable** (Ctrl-C, network blip — pick up where we left off)
- Is **transactional per batch**
- Has **tests** against a real Postgres in Docker — bar §"Testing"

## Decisions

### D1. One orchestrator, one loader module per corpus FAMILY

- `tools/ingest/load_to_postgres.py` — CLI orchestrator. Accepts
  `--corpus all | ttmik | iyagi | topik | kgiu_beginner | kgiu_intermediate
  | kgiu_advanced | vocab_2000_beginner | vocab_2000_intermediate`.
- One module per corpus family:
  - `loaders/load_ttmik.py`
  - `loaders/load_iyagi.py`
  - `loaders/load_topik.py`
  - `loaders/load_kgiu.py`  (level via the corpus enum tag)
  - `loaders/load_vocab_2000.py`
- Shared infrastructure:
  - `loaders/models.py` — Pydantic v2 models matching the JSON shape.
  - `loaders/runtime.py` — pool, transaction helper, checkpoint helpers.

Why "by family, not per-file": KGIU has 3 levels but ONE schema; ditto
2000-Words. Splitting per-file would duplicate code without buying
anything. TOPIK is its own family because of the items-decoupled-from-tests
shape.

### D2. psycopg 3 + AsyncConnectionPool

- ADR-001 §D13. Async because the loader can pipeline reads (JSON parse,
  hash, build rows) while a batch INSERT is in flight.
- One pool per process; `application_name = 'korean-master-loader'`.
- Statement timeout = 0 (loaders do bulk work).

### D3. Idempotency via natural-key upserts

Every loaded table has a natural key chosen so re-runs converge:
- `corpus_sources`: `corpus` (one row per corpus)
- `ttmik_lessons`: `(corpus, source_id)`
- `ttmik_sentences`: `(lesson_id, content_hash)`
- `iyagi_episodes`: `(corpus, source_id)`
- `iyagi_sentences`: `(episode_id, content_hash)`
- `topik_tests`: `(test_number, section)`
- `topik_items`: `(corpus, source_id)`
- `kgiu_entries`: `(corpus, source_id)`
- `vocab_entries`: `(corpus, source_id)`

Loaders use `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` so re-running
the same JSON yields the same DB state, with `updated_at` bumped.

### D4. Resumability via `load_state` checkpoint table

`load_state` (migration 005) carries one row per `(corpus, source_path)`:

- `status`: `pending | in_progress | complete | failed`
- `source_sha256`: SHA-256 of the source JSON at last run — change detection
- `items_in_source`: parser-reported count
- `items_loaded`: rows written so far this session
- `last_item_id`: lexicographically-last `source_id` committed in the in-progress batch
- `started_at` / `completed_at`

On resume:
- If `status == complete` AND `source_sha256` matches: skip the corpus.
- If `status == complete` AND sha differs: re-load (idempotent upserts
  converge).
- If `status == in_progress`: continue from items whose `source_id > last_item_id`.
- If `status == failed`: operator inspects `last_error`; re-run starts from
  the next batch after the failure.

### D5. Transactional per batch, NOT per item

- Bar §"Transactions": "as short as possible."
- Loader configures `--batch-size` (default 200 rows per family). Each batch
  is one transaction that:
  1. INSERTs the batch
  2. Updates `load_state.last_item_id`, `items_loaded`
  3. COMMITs

If the process dies mid-batch, the transaction rolls back and `last_item_id`
unchanged → on resume the loader retries the same batch (idempotent).

### D6. Pydantic v2 models at the JSON boundary

- Bar §"Type safety": "Pydantic models at every I/O boundary."
- `loaders/models.py` defines one model per source-JSON shape. The
  orchestrator parses bytes → Pydantic → typed objects, then translates
  to DB-row dicts. No untyped `dict` passes between layers.
- Validation errors halt the loader immediately with a clear message —
  the source JSON is wrong and we want to know.

### D7. Structlog for logging

- Bar §"Logging". One log line per:
  - Loader start (corpus, source_path, sha256, items_in_source)
  - Batch commit (corpus, batch_size, items_loaded_running_total, elapsed_ms)
  - Loader complete (counts assertion result)
- Errors include the source line/row context where possible.

### D8. Counts assertion on completion

Bar: "Counts assertion at the end: assert post-load row counts match
JSON entry counts." Each loader, on `complete`, runs:

```sql
SELECT COUNT(*) FROM <table> WHERE corpus_source_id = $1
```

…and asserts it equals `items_in_source - skipped_count`. Loader exits
non-zero if the assertion fails so CI catches drift.

### D9. CLI design

- `--corpus all|<name>` — what to load.
- `--dry-run` — parse + validate + checkpoint only, no writes.
- `--resume` — honor `load_state` even if `--force` would skip it.
- `--force` — re-run regardless of sha256 match.
- `--batch-size N` — override default 200.
- `--input-dir <path>` — default `tools/ingest/output/`.

### D10. Testing strategy

- One Python test file per loader family.
- Each test uses a real Postgres container (via the same `db/migrate.py`
  runner — applies all migrations) and a fixture JSON (~10 items).
- Properties tested:
  1. **Correct row counts** after loading a fixture.
  2. **FK integrity** — all `corpus_source_id` references resolve.
  3. **Resume** — kill the loader after N items, restart, assert the
     final row count matches the fixture (no duplicates, no gaps).
  4. **Idempotency** — load twice in a row, assert row count stable.
  5. **Sha256 change detection** — modify the fixture, re-run without
     `--force`, assert the loader re-loads.

### D11. Out of scope

- KRDICT loader (B2 owns it).
- Re-tokenizing sentences with Kiwi for FTS (Phase B per ADR-006).
- User-data backfills (those are app concerns, not loader concerns).

## Consequences

- The orchestrator is the single source of truth for "what's been loaded".
- Operators can interrupt loaders without fear.
- Adding a new corpus = a new loader module + a new corpus enum value.
- The `load_state` table is forever — keeps an operational audit trail
  of every ingest run.

## Open questions

- **Parallelism across corpora**: not now. We can add a `--parallel N`
  flag later (one async task per corpus). Today the orchestrator runs
  sequentially because it's simpler and our data fits comfortably in
  serial-load time.
- **Retry of transient errors**: today's loader re-raises on commit failure
  and lets the operator restart. If we see retryable Postgres errors in
  practice, we'll add `tenacity` with exponential backoff at the batch
  boundary.

## Addendum (2026-07-09): the literature loader is deliberately OUTSIDE the orchestrator

`tools/ingest/loaders/load_literature.py` (U3b, digitized chapter reader —
writes `reading_chapters` + `reading_passages`, migration 044) is **not**
wired into `load_to_postgres.py`'s `--corpus` dispatch, and that is a
decision, not an omission:

- **No `corpus` enum slot.** D1's dispatch — and D3/D4's upsert + checkpoint
  machinery — key on the `corpus` Postgres enum. A literature book is not one
  of a fixed set of curated corpus files: it is the digitized text of a single
  user-owned `book_uploads` row, addressed by `source_upload_id`. There is no
  `corpus_sources` catalog row either — the `reading_chapters` rows themselves
  are the catalog.
- **No `load_state` checkpoint.** D4's resume table is keyed
  `(corpus, source_path)`, which literature cannot populate. The loader's
  idempotency is STRUCTURAL instead: one transaction per invocation that
  deletes the upload's existing chapters (CASCADE to passages) and re-inserts
  from the curated JSON, so re-runs converge and a crash rolls back to the
  prior complete state. Batching (D5) is likewise unnecessary at
  one-book-per-invocation scale.
- **Invocation.** It is run directly, one book at a time —
  `python -m tools.ingest.loaders.load_literature <curated.json> [--dry-run]`
  (or inside the km-loader container via `run_loader`, Deploy) — never via
  `load_to_postgres.py --corpus …`. See the loader's module docstring and
  `tools/ingest/docs/_literature_extraction_guide.md` for the JSON contract.

Adding a new CURATED corpus still follows this ADR ("a new loader module + a
new corpus enum value"); per-upload user content like literature does not.
