# Canonical-grammar dedup — operator README

> Read this when you need to (re)build the canonical-grammar layer that
> dedups KGIU forms across Beginner / Intermediate / Advanced levels.
>
> Sister docs:
> - ADR for the design — `Repository/db/docs/ADR-021-canonical-grammar-bank.md`
> - Migration that creates the table — `Repository/db/migrations/006_canonical_grammar.up.sql`
> - Pure normalizer + Pydantic models — `Repository/tools/ingest/canonical_grammar.py`
> - The script — `Repository/tools/ingest/cluster_canonical_grammar.py`

## What this layer does

KGIU repeats common forms across levels — `-아/어도` lands in Beginner
Unit 16 *and* Intermediate Ch.11. The app wants ONE pin per form. The
`canonical_grammar` table holds that one row; every per-level row in
`kgiu_entries` points at it via `canonical_grammar_id`.

## When to (re)run

| Situation | Command |
|---|---|
| You just ingested a fresh KGIU JSON. | `python -m tools.ingest.cluster_canonical_grammar apply --regenerate` |
| You want to inspect clusters before writing to the DB. | `python -m tools.ingest.cluster_canonical_grammar build --output Repository/tools/ingest/canonical_grammar_clusters.json` |
| The cluster file already exists and you trust it. | `python -m tools.ingest.cluster_canonical_grammar apply` |

Both modes are **idempotent** — re-running doesn't bump version columns
unless something actually changed.

## How clusters are formed

1. Read items from each `grammar_kgiu_*.json` where `pattern` is non-null.
2. For each row, split multi-form patterns ("N와/과, N(이)랑, N하고") on
   commas. Each component becomes a separate occurrence.
3. Normalize each pattern via
   `tools/ingest/canonical_grammar.normalize_pattern`:
   - NFC unicode normalisation (Korean jamo composition).
   - Strip invisible characters (NBSP `U+00A0`, ZWSP `U+200B`, …).
   - Strip leading `A/V-`, `V-`, `A-`, `N-` placeholder.
   - Strip a bare leading `N` directly attached to a Korean particle
     ("N처럼" → "처럼").
   - Strip a bare leading hyphen (`-아/어도` → `아/어도`).
   - Strip trailing circled-digit ordinal markers (`-(으)니까 ①` → `(으)니까`).
4. Group occurrences by the normalised key — the cluster.
5. For each cluster, choose the canonical display surface (longest raw
   alias, preferring the one with the A/V- placeholder).
6. Vote on a `semantic_family` from each member's KGIU `category` /
   `title_en` (heuristic, see `classify_semantic_family`).

## How to interpret the cluster JSON

`Repository/tools/ingest/canonical_grammar_clusters.json` looks
like (truncated):

```json
{
  "generated_at": "2026-05-28T03:14:00+00:00",
  "source_files": ["Repository/tools/ingest/output/grammar_kgiu_beginner.json", ...],
  "total_rows_in": 362,
  "total_pattern_rows": 362,
  "total_clusters": 312,
  "multi_level_clusters": 18,
  "clusters": [
    {
      "pattern_key": "아/어도",
      "canonical_pattern": "A/V-아/어도",
      "semantic_family": "concession",
      "aliases": ["A/V-아/어도", "-아/어도"],
      "members": [
        {"corpus": "kgiu_beginner",    "source_id": "kgiu-beg-u16-03", ...},
        {"corpus": "kgiu_intermediate","source_id": "kgiu-int-c11-03", ...}
      ],
      "members_per_level": {"beginner": 1, "intermediate": 1},
      "needs_review": false
    },
    ...
  ]
}
```

Sort by `len(members_per_level)` descending to see the most-overlapping
forms first — those are where the dedup wins the most.

### Reviewing `needs_review = true`

Polysemous Darakwon entries (`-(으)니까 ①` vs `②`) collapse to one
cluster but get flagged. Open the cluster file, find the flagged
entries, and decide:

- **Keep as one canonical row** if the senses are user-distinguishable
  from the underlying `kgiu_entries.explanation`. The flag stays in
  `notes.needs_review` for the admin UI to surface.
- **Split** by manually inserting a second `canonical_grammar` row with
  a disambiguator suffix AND flagging the moved `kgiu_entries` row(s)
  with `canonical_grammar_id_is_manual_override = TRUE` so the next
  `apply` doesn't clobber the override:
  ```sql
  INSERT INTO canonical_grammar (pattern_key, canonical_pattern, semantic_family)
    VALUES ('(으)니까#discovery', 'V-(으)니까 ②', 'discovery');
  UPDATE kgiu_entries
     SET canonical_grammar_id = (SELECT id FROM canonical_grammar
                                  WHERE pattern_key = '(으)니까#discovery'),
         canonical_grammar_id_is_manual_override = TRUE
   WHERE source_id = 'kgiu-beg-u20-02';
  ```
  Re-running `apply` leaves the manual split in place: the upsert is
  keyed on `pattern_key` (UNIQUE) and the `WHERE` clause in
  `_upsert_clusters` only touches display columns; the kgiu-side
  `_backfill_kgiu_entries` skips any row whose
  `canonical_grammar_id_is_manual_override` is `TRUE`.

  **Convention** for the disambiguator suffix: `pattern_key + '#' +
  semantic_family` (lowercase). The `#` is reserved for splits — no
  auto-normalised key contains it, so a quick `WHERE pattern_key LIKE
  '%#%'` finds every split. See ADR-021 §"Polysemy" and
  `migrations/010_canonical_grammar_manual_override.up.sql`
  (REVIEW_C1 SHOULD-FIX-1).

  **To re-enable auto-backfill** on a previously-overridden row (e.g.,
  after deciding the split was wrong), clear the sentinel:
  ```sql
  UPDATE kgiu_entries
     SET canonical_grammar_id_is_manual_override = FALSE
   WHERE source_id = 'kgiu-beg-u20-02';
  ```
  The next `apply` will then re-point the FK at the auto canonical row.

## Files

| Path | What it is |
|---|---|
| `canonical_grammar.py` | Pure normalizer + Pydantic models. No I/O. |
| `cluster_canonical_grammar.py` | CLI entry point. `build` writes JSON; `apply` populates Postgres. |
| `canonical_grammar_clusters.json` | The reviewable cluster artefact. Regenerated by `build`. |
| `tests/test_canonical_grammar_normalizer.py` | Pure unit tests (no DB). |
| `tests/test_canonical_grammar_db.py` | Integration tests against testcontainers Postgres. |

## Running the tests

```bash
# Unit (fast, no DB needed):
pytest Repository/tools/ingest/tests/test_canonical_grammar_normalizer.py -v

# Integration (testcontainers + Docker required):
pytest Repository/tools/ingest/tests/test_canonical_grammar_db.py -v
```

## Operational notes

- **Schema dependency.** The script bails loudly if migration 006
  hasn't been applied (table `canonical_grammar` missing). Run
  `python -m db.migrate up` first.
- **Connection.** `DATABASE_URL` env var. Application name is
  `korean-master-canonical-grammar` — visible in `pg_stat_activity`.
- **Cost.** ~362 source rows, ~300 clusters, single-digit-ms inserts.
  Don't put this in a hot path; treat it like an ingest step.
- **Logging.** Structured JSON via `structlog` to stderr. Add
  `--log-level debug` for trace.

## Common gotchas

- **The normalizer is regex-based, not morphological.** Two forms that
  share a Korean morphological core but differ on the surface (e.g.
  `-처럼` vs `-듯이` — both "like / as") will NOT cluster together. That's
  intentional for now — Phase B's Kiwi service can layer a morphological
  alias on top later (see ADR-014). For Phase C, surface-form clustering
  catches the high-value overlaps.
- **Compound rows show up multiple times in clusters.** A single source
  row with pattern `"N와/과, N(이)랑, N하고"` generates THREE occurrences
  — one for `와/과`, one for `(이)랑`, one for `하고`. That's by design:
  each component is a real form a learner can tap, and each should map
  to its own canonical pin.
- **`semantic_family` will look wrong sometimes.** Heuristic. Override
  manually with `UPDATE canonical_grammar SET semantic_family = '…'
  WHERE pattern_key = '…'` — `apply` will not overwrite a manually-set
  value because the upsert's `ON CONFLICT` only updates display columns.
