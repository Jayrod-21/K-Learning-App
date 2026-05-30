# Corpus loaders

Loads the 8 corpus JSON files in `tools/ingest/output/` into the project's
self-hosted Postgres. Replaces the deprecated `load_to_supabase.py` ingest
path; see ADR-019 for the orchestrator design.

## Layout

```
tools/ingest/
  load_to_postgres.py        Orchestrator (CLI entry point)
  loaders/
    __init__.py
    models.py                Pydantic source-JSON models
    runtime.py               Pool + checkpoint helpers, shared
    load_ttmik.py            ttmik_*.json
    load_iyagi.py            iyagi_*.json
    load_topik.py            topik_*.json (all sections, all tests)
    load_kgiu.py             grammar_kgiu_{beginner,intermediate,advanced}.json
    load_vocab_2000.py       vocab_2000_{beginner,intermediate}.json
  tests/
    fixtures/
      ttmik_mini.json
      iyagi_mini.json
      topik_mini_reading.json
      kgiu_mini_beginner.json
      vocab_mini_beginner.json
    test_load_ttmik.py
    test_load_iyagi.py
    test_load_topik.py
    test_load_kgiu.py
    test_load_vocab_2000.py
  _deprecated/
    load_to_supabase.py       Old PostgREST-based loader (retired)
```

## Quickstart

```
export DATABASE_URL=postgres://user:pass@host:5432/db

# Load every corpus:
python -m tools.ingest.load_to_postgres --corpus all

# Load one corpus:
python -m tools.ingest.load_to_postgres --corpus ttmik

# Dry-run (validate JSON, exercise checkpoint, no writes):
python -m tools.ingest.load_to_postgres --corpus all --dry-run

# Force re-load (ignore sha256 match):
python -m tools.ingest.load_to_postgres --corpus topik --force

# Tune the batch size:
python -m tools.ingest.load_to_postgres --corpus all --batch-size 100
```

## Dependencies

- `psycopg[binary]>=3.2`
- `psycopg-pool>=3.2`
- `pydantic>=2.0`
- `structlog>=24.0`
- (test only) `testcontainers>=4.0`, `pytest`, `pytest-asyncio`

Pin these in `Repository/tools/ingest/pyproject.toml` when the ingest tree
gets its own packaging — for now they're imported assuming a project-wide
venv with the same versions used by other Python tooling in the repo.

## Idempotency

Every loaded row uses an `INSERT ... ON CONFLICT ... DO UPDATE` against a
natural key documented in ADR-019. Running the same loader twice in a row
yields the same DB state (modulo `updated_at` and `version` bumps).

The natural keys:

| Table | Natural key |
|---|---|
| `corpus_sources` | `corpus` |
| `ttmik_lessons` | `(corpus, source_id)` |
| `ttmik_sentences` | `(lesson_id, content_hash)` |
| `iyagi_episodes` | `(corpus, source_id)` |
| `iyagi_sentences` | `(episode_id, content_hash)` |
| `topik_tests` | `(test_number, section)` |
| `topik_items` | `(corpus, source_id)` |
| `kgiu_entries` | `(corpus, source_id)` |
| `vocab_entries` | `(corpus, source_id)` |

## Resumability

`load_state` (migration 005) keeps one row per `(corpus, source_path)`:

- `status`: `pending | in_progress | complete | failed`
- `source_sha256`: SHA-256 of the source JSON at the most recent run
- `items_in_source`: parser-reported count
- `items_loaded`: rows written this run
- `last_item_id`: lexicographically-last `source_id` committed

The orchestrator:

1. Hashes the source file.
2. Looks up the `load_state` row.
3. **Skip** if `status=complete` AND `source_sha256` matches AND `--force` not passed.
4. **Resume** otherwise — skip items whose `source_id <= last_item_id`, then
   continue.
5. On every batch, write the new `last_item_id` + `items_loaded` IN THE SAME
   transaction as the data. A crash leaves the world consistent.

## Counts assertion

Each loader does a post-load `SELECT COUNT(*) FROM <table> WHERE corpus_source_id = $id`
and warns (via structlog) if it doesn't match the JSON entry count. Warnings
in CI fail the build.

## Testing

The loader test suite uses `testcontainers` to spin up Postgres 16-alpine,
applies every migration in `Repository/db/migrations/`, and then walks each
loader against a small fixture.

```
cd Repository/tools/ingest
pytest tests/test_load_*.py
```

First-run cost: ~30s for image pull + container boot. Each test file reuses
its module-scoped container.

Requires Docker (or a Docker-compatible runtime).

## Operational notes

- `application_name = 'korean-master-loader'` lets `pg_stat_activity`
  distinguish loader sessions from the API.
- Statement timeout is 0 for loaders (bulk operations); ADR-001 §D13.
- Loaders are sequential by default. If a single corpus becomes the
  bottleneck, we can add a `--parallel` flag (ADR-019 §"Open questions").

## What's NOT in this loader

- KRDICT — owned by B2 (migration 003 + KRDICT loader).
- Re-tokenization for FTS — Phase B per ADR-006.
- User-data backfills — app concern.
