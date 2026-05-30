# Cross-Reference Resolver

A post-load pass that walks every loaded Darakwon entry's text-form
cross-references and writes resolved FK links to `kgiu_entry_relations` and
`vocab_entry_relations`.

**Source files:**

| File | Purpose |
| --- | --- |
| `resolve_cross_references.py` | CLI entry point |
| `resolver/normalize.py` | NFC + whitespace + homograph index parser |
| `resolver/extractor.py` | Pull refs out of KGIU/vocab JSON entries |
| `resolver/lookup.py` | In-memory same-corpus-prefer FK resolver |
| `resolver/writer.py` | Idempotent upsert + checkpoint helpers |
| `resolver/pipeline.py` | Orchestration: extract → normalize → resolve → write |
| `resolver/models.py` | Pydantic/dataclass types shared across the package |

**Schema dependencies:** migrations `002_darakwon_corpora.up.sql` (creates
`kgiu_entries`, `vocab_entries`, and the relations tables) and
`009_cross_ref_relations.up.sql` (relaxes `kgiu_entry_relations.target_entry_id`
to NULL, adds hybrid-target columns, natural-key UNIQUE indexes, and the
`resolver_state` checkpoint table).

**ADR:** `db/docs/ADR-022-cross-reference-resolution.md` records the
normalization choices, same-corpus preference policy, and ambiguous-match
handling.

---

## Prerequisites

The resolver runs against ALREADY-LOADED data. Before running it:

1. Apply all migrations: `cd db && python migrate.py up`
2. Load the source JSONs:
   ```bash
   DATABASE_URL=postgresql://... python tools/ingest/load_to_postgres.py
   ```
3. THEN run the resolver.

If the prereq isn't met the CLI exits with code `2` and a message naming
the missing corpora.

## Running

```bash
# Resolve every loaded corpus, write the unresolved-ref report:
DATABASE_URL=postgresql://localhost/km \
    python -m tools.ingest.resolve_cross_references \
        --corpus all \
        --report-broken-refs

# Resolve one corpus only:
DATABASE_URL=... \
    python -m tools.ingest.resolve_cross_references \
        --corpus kgiu_advanced

# Dry run — count what WOULD be written without touching the DB:
DATABASE_URL=... \
    python -m tools.ingest.resolve_cross_references --dry-run

# Resume after an interrupted run:
DATABASE_URL=... \
    python -m tools.ingest.resolve_cross_references --resume
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | All requested corpora resolved cleanly. |
| 1 | Unhandled runtime error (check logs). |
| 2 | Prerequisites not met (corpora not loaded) or DATABASE_URL missing. |
| 3 | Invalid CLI args. |
| 130 | Interrupted (Ctrl-C). |

---

## What gets resolved

| Source field | Relation written | Notes |
| --- | --- | --- |
| `compare_with[].with` (KGIU) | `compare_with` | also parses `note` for `kgiu-…-…` IDs |
| `compare_with[].note` extra IDs | `cross_ref` | one extra row per additional id in the note |
| `related[]` (vocab) | `related` | dict with korean/english/page |
| `synonyms[]` (vocab) | `synonym` | dict with korean/english |
| `antonyms[]` (vocab) | `antonym` | dict with korean/english/page |
| `passive_form` (vocab) | `passive_form` | scalar string |
| `causative_form` (vocab) | `causative_form` | scalar string |
| `basic_form` (vocab) | `basic_form` | scalar string (peer of passive/causative) |
| `honorific_form` (vocab) | `honorific_form` | scalar string |
| `humble_form` (vocab) | `humble_form` | scalar string |
| `contracted_form` (vocab) | `contracted_form` | scalar string |
| `cross_refs[].label` (vocab) | `related` | only when label contains Korean — page-only labels (Appendix, Index) skipped |

Each row in the relations tables carries one of three `resolution_status`
values:

- `resolved` — the text mapped to a captured entry; `target_entry_id` set.
- `text_only` — the target is a real label but no captured entry matches yet.
  `target_korean` set; `target_entry_id` NULL. The next resolver run will
  upgrade it if the target is loaded by then.
- `broken` — the target text was unparseable. Logged + reported, NOT written
  to the relations table (would violate `ck_*_target_present`).

## Same-corpus preference

When a text target matches captured entries in multiple corpora, the lookup
prefers the row whose corpus matches the source row's. If no same-corpus
match exists, the lookup falls back to a deterministic priority order
(beginner > intermediate > advanced) so re-runs are stable.

Cross-corpus links happen naturally because the same lookup runs against
the full kgiu+vocab index — a vocab synonym that's also a KGIU pattern
will resolve as long as the headword forms match.

## Unresolved-ref report

When `--report-broken-refs` is passed, the CLI writes a CSV at
`tools/ingest/unresolved_cross_references.csv` (override with
`--unresolved-ref-out PATH`; the legacy `--broken-ref-out PATH` is
still honoured for back-compat). The CSV covers BOTH:

  * **broken** refs — dropped entirely (no DB row): unsupported
    relation_kind, self-reference, normalize failure;
  * **text_only** refs — written to the DB without an FK target (the
    text label is preserved; the resolver can re-attempt them later
    when the target row appears).

The first column, `report_type`, distinguishes the two so QA can
filter without re-running the resolver. Counter accounting (per
ADR-022 D2) treats the two as DISJOINT: `refs_broken` counts only
broken refs, `refs_text_only` counts only text-only successes, and
`refs_extracted = refs_resolved + refs_text_only + refs_broken`.

Columns:

| Column | Description |
| --- | --- |
| `report_type` | `broken` or `text_only` — see above |
| `source_corpus` | The corpus whose entry made the reference |
| `source_entry_id` | DB id of the source entry |
| `source_pattern` | Pattern/headword/source_id of the source entry |
| `relation_type` | The relation kind we tried to write |
| `target_text` | The text target after normalization (or before if unparseable) |
| `reason` | Why we couldn't resolve it |

The report is overwritten on each run, so commit it alongside a tagged
release if you want a snapshot.

> **Note on the rename (REVIEW_C2 F2):** the file was previously called
> `broken_cross_references.csv` and conflated broken refs with
> text-only successes under a single "broken" name. The new name and
> the `report_type` column make the distinction explicit.

## Idempotency + Resume

- **Idempotent:** the upsert pattern uses two partial UNIQUE indexes (FK
  branch + text branch) added in migration 009. A re-run with the same
  input produces zero new rows and zero version bumps (the DO UPDATE has a
  `WHERE EXCLUDED IS DISTINCT FROM` guard).
- **Resumable:** `--resume` reads `resolver_state.last_source_id` and skips
  every source entry whose `source_id <= last_source_id`. Without `--resume`
  the counters reset and the cursor restarts at the beginning of each
  corpus.

## Testing

```bash
# Unit tests (no DB — pure functions):
pytest tools/ingest/tests/test_resolve_normalize.py
pytest tools/ingest/tests/test_resolve_lookup.py

# Integration tests (real Postgres via testcontainers):
pytest tools/ingest/tests/test_resolve_cross_references_integration.py
```

The integration suite covers FK + text-only resolution, idempotency,
resume, dry-run, and the prerequisite-error path.
