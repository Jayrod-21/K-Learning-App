# ADR-008: `kgiu_entries` (source) vs `grammar_entries` (user-canonical)

**Status:** Accepted
**Date:** 2026-05-28
**Implemented in:** migration `002_darakwon_corpora.up.sql`
**Relates to:** 001_core_schema (A1), Phase C canonical-dedup work

## Context

Two parallel agents (A1 = core schema, A2 = corpus schema) independently
defaulted to the name `grammar_entries` for tables that turned out to mean
different things:

- A1 (in 001_core_schema): user-canonical grammar bank. Each row is a
  pattern the user has banked via highlight / mining / production drill.
  FK to `users`, unique on `(user_id, pattern_key)`. Feeds SRS production
  drills. Soft-deletable.
- A2 (this migration, originally drafted as `grammar_entries`): raw KGIU
  source rows. One per JSON entry from `grammar_kgiu_*.json`. Reference
  data, never user-owned. Indexed for Reference search and Grammar bank
  browsing.

Both interpretations are defensible. The bar's naming guideline (§D10:
"tables plural snake_case") doesn't disambiguate.

## Decision

A1's table keeps the name `grammar_entries`. A2's table is renamed to
`kgiu_entries`.

Reasoning:

1. **Future-proofing.** A1's `grammar_entries` will eventually source
   patterns from multiple corpora (KGIU, TTMIK, Iyagi, user-typed). It is
   genuinely the "canonical grammar entry" — corpus-agnostic. Naming it
   after the source would have been wrong.
2. **Honesty.** A2's table IS a KGIU-specific source table. It will sit
   alongside future `ttmik_entries`, `iyagi_entries`, etc. The book-named
   prefix matches what the rows actually are.
3. **Phase-C bridge.** In Phase C, `grammar_entries` will gain a
   `canonical_source` FK (or a junction table) pointing at one or more
   `kgiu_entries` / `ttmik_entries` / etc. rows. The naming makes that
   relationship obvious.

## Bridge table sketch (Phase C — NOT in this migration)

```sql
-- Future Phase-C migration, illustrative only:
CREATE TABLE grammar_entry_sources (
    grammar_entry_id   BIGINT NOT NULL,  -- FK → grammar_entries.id (user canonical)
    source_kind        TEXT   NOT NULL CHECK (source_kind IN ('kgiu','ttmik','iyagi','manual')),
    kgiu_entry_id      BIGINT,           -- FK → kgiu_entries.id when source_kind='kgiu'
    -- ttmik_entry_id, iyagi_entry_id when those land
    ...
);
```

This migration deliberately does NOT build that bridge — that's Phase C's
job, after the canonical-grammar dedup heuristics are designed. We're not
painting ourselves into a corner: `kgiu_entries.id` is a stable BIGINT IDENTITY
that the bridge can FK to.

## Consequences

- The `kgiu_entries` name is mildly book-specific. We accept this: adding
  `ttmik_entries` / `iyagi_entries` as parallel tables is cleaner than one
  giant heterogeneous table because the per-corpus schemas differ
  meaningfully (TTMIK lesson transcripts, Iyagi paragraphs, vs KGIU's
  pattern/explanation/dialog layout).
- A2's `lets_check_exercises.parent_kgiu_entry_id` references `kgiu_entries`,
  not A1's `grammar_entries`. Phase C may add a sibling
  `parent_grammar_entry_id` if we want exercises to attach to user-canonical
  entries too (unlikely; exercises ARE source-specific).
- The Reference UI fetches from `kgiu_entries`; the Grammar bank UI fetches
  from `grammar_entries` joined to `kgiu_entries` via the Phase-C bridge.

## Alternatives considered

- **Merge into one table** with a discriminator: rejected — A1's table has
  per-user concerns (FK to users, soft delete) that don't apply to source
  rows, and the source rows have per-book concerns (audio track, source
  pages, register-as-printed) that don't apply to user-canonical rows.
- **Rename A1's table to `user_grammar_entries`**: rejected — A1 already
  shipped; doesn't make sense to rename A1's stable name to make room for
  a source table.
- **Put source rows in a separate schema (`corpus.grammar_entries`)**:
  rejected — adds operational complexity (search_path, dump/restore) for
  a naming convenience.

## Phase-A trade-off: `lets_check_exercises.parent_vocab_subsection` is string-keyed (no FK)

SF-4 in REVIEW_A2 flagged that `lets_check_exercises` rows with
`parent_kind = 'vocab_subsection'` identify their parent by a `(theme,
subsection)` TEXT pair, with no FK or uniqueness constraint to
`vocab_entries`. A theme or subsection rename in source data would
orphan-by-string — referential integrity is at the loader's mercy until a
canonical `vocab_subsections` table exists.

We accept this for Phase A because:

1. The vocab subsection isn't a first-class row in source JSON — it's a
   page-divider concept printed in the book. Promoting it to a table
   adds a write target without a query that demands it.
2. There is no UI that surfaces a subsection-as-entity (no detail page,
   no list).
3. The CHECK constraint at insert time (`length > 0`) catches the most
   likely loader bug.
4. Phase C is the natural place to introduce a vocab_subsections table
   if a real subsection-aware UI surfaces (e.g., per-subsection mini
   curricula). At that point lets_check_exercises grows a proper
   `parent_vocab_subsection_id BIGINT FK` and the TEXT pair is backfilled
   into the new table.

Until then, the loader is responsible for the integrity invariant: for
every `lets_check_exercises` row with `parent_kind = 'vocab_subsection'`,
the (theme, subsection) pair must match at least one row in
`vocab_entries`. The loader implementation should run a verification
query after every ingest:

```sql
SELECT le.id, le.parent_vocab_theme, le.parent_vocab_subsection
  FROM lets_check_exercises le
 WHERE le.parent_kind = 'vocab_subsection'
   AND NOT EXISTS (
     SELECT 1 FROM vocab_entries v
      WHERE v.theme      = le.parent_vocab_theme
        AND v.subsection = le.parent_vocab_subsection
   );
```

Rows returned are loader bugs; fail the ingest if non-empty.

