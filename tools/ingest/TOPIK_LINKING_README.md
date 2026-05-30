# TOPIK ↔ Grammar/Vocab Dependency Linker

Maps each TOPIK item in the pool to the specific grammar entries
(`kgiu_entries`) and vocab entries (`vocab_entries`) the item tests.

This is what powers:

- **"Filter mock test to only items testing `-(으)면` family"** (TOPIK Prep
  study mode — DESIGN_SPEC §Pages).
- **"Show me weak areas"** (gap-map dashboard) — count of unmastered grammar
  entries that have linked TOPIK items.
- **SRS interleaving** — when reviewing a grammar pattern, surface a TOPIK
  item that exercises it.

The schema this writes to lives in
[`db/migrations/008_topik_dependencies.up.sql`](../../db/migrations/008_topik_dependencies.up.sql)
and is documented in
[`ADR-024 — TOPIK dependency linking`](../../db/docs/ADR-024-topik-dependency-linking.md).

---

## How to run

### Prerequisites

1. **Migrations applied.** The linker writes to `topik_dependencies`
   (migration 008). The schema also assumes 001 / 002 / 005 are applied so
   `kgiu_entries`, `vocab_entries`, and `topik_items` exist.

2. **TOPIK items loaded.** Run `loaders/load_topik.py` against every
   `tools/ingest/output/topik_*.json` first; the linker reads from
   `topik_items`.

3. **Kiwi service reachable.** Strategy B requires `POST /tokens` on the
   Kiwi service (B1). Default URL is `http://kiwi:8000`.

4. **(Optional) Claude proxy reachable.** Strategy C requires `POST
   /grammar/identify` on the B3 Express server. Default URL is
   `http://server:3000`. Skip if you don't pass `--use-claude`.

### Environment

| Var                   | Required | Default               | Purpose                                  |
|-----------------------|----------|-----------------------|------------------------------------------|
| `DATABASE_URL`        | yes      | —                     | Postgres connection string               |
| `KIWI_URL`            | no       | `http://kiwi:8000`    | Kiwi /tokens endpoint                    |
| `CLAUDE_PROXY_URL`    | no       | `http://server:3000`  | B3 proxy base URL                        |
| `CLAUDE_PROXY_TOKEN`  | no       | none                  | Bearer token for `/grammar/identify`     |
| `LOG_LEVEL`           | no       | `info`                | `debug` / `info` / `warning` / `error`   |

### Command

```bash
# Strategies A + B (mechanical, cheap, default):
DATABASE_URL=postgres://… python3 link_topik_dependencies.py

# Restrict to a few test numbers:
python3 link_topik_dependencies.py --test-numbers 47,52

# Dry-run (compute deps but don't write):
python3 link_topik_dependencies.py --dry-run --log-level debug

# Include Strategy C (Claude — see cost note below):
python3 link_topik_dependencies.py --use-claude
```

The linker is **idempotent** — re-running with the same input writes no new
rows (precedence rules pick the higher-confidence row on conflict; see
ADR-024). It is also **resumable** — per-test checkpoints in `load_state`
(corpus `topik_dep_linker`) skip already-processed items on restart.

---

## What the three strategies do

### Strategy A — `skill_tag` → grammar family (`source='skill_tag'`, confidence 0.90)

The normalized `topik_items.skill_tag` already groups items by family
(see `normalize_skill_tags.py`). For tags that mean "this item tests a
grammar form" (`grammar-connective`, `grammar-expression`,
`grammar-paraphrase`), the linker looks up `kgiu_entries` whose `category`
sits in the family's category set:

| skill_tag             | kgiu_entries.category values pulled                      |
|-----------------------|----------------------------------------------------------|
| `grammar-connective`  | `connective`, `condition`, `concession`, `time`, `reason` |
| `grammar-expression`  | `expression`, `auxiliary`, `modal`, `aspect`             |
| `grammar-paraphrase`  | `expression`, `connective`, `auxiliary`, `modal`         |

This over-collects deliberately: a `grammar-connective` item really *does*
test "some connective" — we don't yet know *which* without harder analysis,
but the dep is still pedagogically valid for weak-area filtering. Confidence
0.90 reflects the certainty of the category match, not of any specific
single entry.

### Strategy B — lemma match → vocab (`source='lemma_match'`, confidence 0.75)

For each TOPIK item, we send the `stem` + each option string to the Kiwi
service's `/tokens` endpoint. We keep only content-word POS tags (NNG, NNP,
VV, VA, …) — particles, endings, and punctuation are excluded; they're not
dictionary lookups.

Each resulting lemma is looked up against `vocab_entries.korean` (exact
match, since `korean` is already in dictionary form). Matches become
dependencies with `dep_type='vocab'`. Confidence 0.75 reflects that the
word appears in the item; whether the *item tests it* (vs. just uses it in
context) is the source of the lower-than-A confidence.

### Strategy C — Claude analysis (`source='claude_analysis'`, off by default)

Disabled unless `--use-claude` is set. For each item that A+B did NOT cover,
we send the item's stem (`fullSentence`) + each option / underline span
(`highlightSpan`) to the existing `POST /grammar/identify` route on B3's
Express server. That route forwards to the B4 Claude proxy, which returns a
canonical pattern recognition. We use the returned pattern as a substring
filter against `kgiu_entries.pattern` to pick the matched entry, then
insert deps with `source='claude_analysis'` and `confidence` per Claude's
reply (clamped to [0.00, 1.00]).

**We do not import the Anthropic SDK or call the Anthropic API directly.**
The proxy is the integration point (per `ADR-020`).

#### Cost estimate for Strategy C

| Quantity              | Value                                                |
|-----------------------|------------------------------------------------------|
| TOPIK items in corpus | ~1,200 (15 tests × ~80 items)                        |
| Items uncovered by A+B | ~20% (rough — depends on `kgiu_entries` coverage)   |
| Calls per uncovered item | ~4 (one per MCQ option, capped at 4)              |
| Tokens per call       | ~600 input + 200 output                              |
| Anthropic rate (Sonnet) | ~$3/MTok input + $15/MTok output                   |
| **Per item**          | ~$0.012                                              |
| **Full corpus, uncovered only** | **≈ $3**                                  |
| Full corpus, every item | ≈ $15                                              |

These are envelope estimates — the Claude proxy prompt cache (ADR-020 §3)
brings repeat calls down considerably. Treat them as upper bounds.

---

## Precedence: highest-confidence wins

If multiple strategies identify the same (item, dep_type, target) triple,
the row with the higher `confidence` survives. Equal-confidence ties leave
the existing row in place. This is enforced in SQL via an `ON CONFLICT DO
UPDATE … WHERE EXCLUDED.confidence > topik_dependencies.confidence` clause,
so the precedence is honored regardless of the order strategies run.

A typical pattern:

1. A runs first, writes `(item, kgiu_entries.id=42, confidence=0.90,
   source='skill_tag')`.
2. C runs later, returns the same target with `confidence=0.65`.
3. C's row hits the natural-key conflict; the WHERE rejects the update
   because 0.65 < 0.90. The row from A persists.

---

## How to test

```bash
# From Repository/tools/ingest:
pytest tests/test_link_topik_dependencies.py -v
```

The integration tests use `testcontainers.postgres` — they spin up a real
Postgres 16 in Docker, apply every migration, then exercise:

- Strategy A end-to-end (skill tag → grammar deps).
- Strategy B end-to-end (lemma → vocab deps, fake Kiwi).
- Strategy C with a fake proxy (no Anthropic call).
- Idempotency (re-running writes nothing new).
- Precedence (higher-confidence row wins; equal-confidence is a no-op).
- DB-level XOR enforcement (a row with both FK columns set is rejected).

The unit tests (no Postgres) cover the strategy-A mapping table, the
content-word POS filter, and the in-Python XOR validation in `write_deps`.

---

## Operational notes

- The linker writes a `load_state` row per `(corpus='topik_dep_linker',
  source_path='topik_dep_linker:test=<N>')`. Inspect with:
  ```sql
  SELECT corpus, source_path, status, items_loaded, last_item_id,
         updated_at, last_error
    FROM load_state
   WHERE corpus = 'topik_dep_linker';
  ```
- Per-strategy counts are emitted in the final structured log line under
  the `per_strategy` key.
- The linker uses `psycopg_pool.AsyncConnectionPool` with
  `application_name='korean-master-linker'` — visible in
  `pg_stat_activity` when something is hung.
- Strategy C should never run inside a DB transaction (SENIOR_ENGINEER_BAR
  §1 — no external I/O inside an open transaction). The code is structured
  so HTTP calls always happen with no transaction open; only the batch
  write opens one.

---

## Out of scope

- **Canonical grammar dedup** — owned by Phase C-1 (migration 006).
- **Cross-reference resolver** — owned by Phase C-2 (migration 007).
- **Quality audit of the deps** — owned by Phase C-3 (read-only).
- **The user-facing weak-area filter UI** — Phase B client, post-UI.
