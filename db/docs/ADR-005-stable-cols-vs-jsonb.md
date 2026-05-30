# ADR-005: Stable columns vs JSONB for grammar/vocab variable-shape content

**Status:** Accepted
**Date:** 2026-05-28
**Supersedes:** —
**Relates to:** ADR-001 §D5 (JSONB never JSON)
**Implemented in:** migration `002_darakwon_corpora.up.sql`

## Context

The Darakwon JSON entries (`Repository/tools/ingest/output/grammar_kgiu_*.json`,
`vocab_2000_*.json`) carry a mix of stable scalar fields and repeated variable-
shape collections:

- Stable scalars per entry: `pattern`, `title_en`, `category`, `proficiency`,
  `register`, `explanation`, `unit`, `audio_track`, `source_book`,
  `source_pages`.
- Variable-shape arrays per entry: `formation_rules[]` (strings),
  `examples[]` ({korean, english}), `dialogues[]` ({context, lines[],
  alternatives?[]}), `vocabulary[]` ({korean, english}),
  `tips[]` (strings), `compare_with[]` ({with, note}), `exercises[]`
  ({prompt, answer}), `cultural_notes[]` (strings).

The senior-engineer-bar (§Database/Schema) says: normalize stable relational
data; use JSONB where shape is genuinely variable. We had to draw the line.

## Decision

**Stable scalars become columns. Repeated variable-shape arrays become JSONB
on the parent entry row** (`grammar_entries`, `vocab_entries`).

Exception: when there is a hard cross-entry relationship that we want to
traverse with FKs (referential integrity, indexed reverse lookups), we
**also** model it relationally in a sibling table:

- `grammar_entry_relations` — when both ends are captured `grammar_entries`
  rows, the relation is recorded as an FK pair *in addition to* (or instead
  of) the inline `compare_with[]` JSONB.
- `vocab_entry_relations` — every synonym/antonym/passive-form/etc. is a row,
  because these are frequently traversed in the UI (related-words sidebar,
  synonym-cluster rendering) and we want indexed reverse lookups.

We do **not** create separate `grammar_entry_examples`,
`grammar_entry_dialogues`, `grammar_entry_tips`, `grammar_entry_exercises`,
`grammar_entry_formation_rules` tables.

## Why not relational tables for examples/dialogues/tips/exercises?

1. **No cross-entry queries.** We never ask "find every dialogue line that
   contains X across all grammar entries." We always render examples/
   dialogues/etc. in the context of their entry, top-to-bottom.

2. **High shape variance, low row count per entry.** A typical entry has 3-12
   examples and 1-3 dialogues. Splitting them into separate tables would
   ~10× row count without enabling a query we care about. Reading an entry's
   detail page would become a 5-way join.

3. **The shape itself varies.** `dialogues[i].alternatives` only appears when
   the source page has substitution charts (Intermediate); Advanced uses
   `이럴 때는 어떻게 말할까요?` with a different structure. Modeling every
   variant as a column produces a wide sparse table.

4. **JSONB preserves order trivially.** Examples in the book have an order
   (intro dialog first, then sample sentences). A JSONB array preserves it;
   a relational table needs a `sentence_order INTEGER` column and a
   `ORDER BY` on every read.

5. **YAGNI.** We can refactor an example sub-table in later phases if we ever
   want example-level cards. Going relational up-front spends complexity on a
   feature we don't have.

## Why relational tables for grammar/vocab relations?

The opposite forces apply:

1. **We do want cross-entry queries.** "What other entries point at this
   one?" is a real UI need (reverse-link rendering on the entry detail page).
2. **Referential integrity matters.** Deleting a referenced entry should
   error (RESTRICT) or null the back-reference (SET NULL), not silently
   orphan a JSONB string.
3. **Indexed lookups.** GIN on a JSONB array of {with, note} would work for
   containment, but a B-tree on `target_entry_id` is dramatically faster
   for the "who points at X?" query.

## Why CHECK constraints on JSONB shape?

The JSONB columns all carry a `CHECK (jsonb_typeof(col) = 'array')` constraint.
Defends against:

- **JSONB injection / malformed-JSON DoS** (SECURITY.md threat): a query
  doing `jsonb_array_elements(formation_rules)` will blow up if a row stored
  an object instead of an array. The CHECK rejects bad inserts at the source.
- **Loader bugs** (the most likely failure mode): if A4 ever passes
  `{"items": [...]}` by mistake instead of `[...]`, the insert fails loudly.

We do NOT enforce per-element shape (e.g. that every `examples[]` element has
both a `korean` and `english` key). That validation happens in the loader's
Pydantic models — keeping it out of the DB CHECK so we can fix bad data
without a migration.

## Consequences

- The loader's Pydantic models must mirror the JSONB shapes documented in
  the column COMMENTs.
- The Reference UI fetches an entire entry row in one query and renders all
  variable arrays from JSONB — no N+1 joins.
- If we later need to query inside JSONB (e.g. "any tip containing X"), GIN
  on the JSONB column is cheap to add as a follow-up migration.
- Phase-C canonical-grammar dedup will likely add `canonical_id` FK columns
  on `grammar_entries`; this ADR is forward-compatible with that.

## Alternatives considered

- **Fully relational** (one table per array kind): rejected on row-count and
  query-shape grounds above.
- **EAV (entity-attribute-value)**: rejected — produces the worst of both
  worlds, neither relationally normal nor easy to read.
- **`hstore`**: rejected — superseded by JSONB in every dimension.
