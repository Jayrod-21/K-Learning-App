# ADR-007: Hybrid target column on `vocab_entry_relations`

**Status:** Accepted
**Date:** 2026-05-28
**Implemented in:** migration `002_darakwon_corpora.up.sql`
**Relates to:** ADR-001 §D9 (FK ON DELETE policies)

## Context

The 2000 Essential Korean Words books mark relations between words with
colored character markers (동 synonym, 반 antonym, 관 related, 참 reference,
피 passive, 사 causative, 본 basic, 높 honorific, 낮 humble, 준 contracted).

When we sampled the JSON (`vocab_2000_*.json`):

- Most relation targets are also captured as their own headword rows — i.e.
  the target IS a row in `vocab_entries`.
- A non-trivial minority of targets are NOT captured. They appear only as
  text inside another entry's sidebar (e.g. an entry lists `식구 family
  members p.19` as related, but 식구 itself might not have its own
  numbered entry in this corpus).
- The book also prints a page number for the target. That page number is
  useful UI even when no FK is resolvable.

A pure-FK model would be cleanest, but it would force us to either:

- (a) **Drop information** — discard text-only relations that don't have a
  capturable target, OR
- (b) **Auto-create stub rows** — insert phantom `vocab_entries` rows for
  every uncaptured referent, polluting the dictionary with non-headwords.

Neither is acceptable. (a) loses signal; (b) violates the natural-key
contract on `vocab_entries(source_id)` (we'd have to invent synthetic ids).

## Decision

`vocab_entry_relations` carries a **hybrid target**:

- `target_entry_id BIGINT NULL` — FK to `vocab_entries(id)` when the target
  is a captured row.
- `target_korean TEXT NULL` — the printed Korean form of the target.
- `target_english TEXT NULL` — English gloss if printed.
- `target_page INTEGER NULL` — book page where the target lives.

Constraints:

- `CHECK (target_entry_id IS NOT NULL OR target_korean IS NOT NULL)` —
  at least one of the two must identify the target.
- `target_entry_id` FK uses `ON DELETE SET NULL` — if a referenced entry is
  ever deleted, the relation persists as a text-only reference rather than
  vanishing.

The loader can fill `target_korean` always (it's free) and additionally
`target_entry_id` when it can resolve the text to a captured entry. A
later "resolve text targets" pass (a SQL UPDATE keyed on Korean form) can
upgrade text-only relations to FK relations after each ingest, indexed by
`ix_vocab_entry_relations_target_korean_lower`.

## Why ON DELETE SET NULL (not CASCADE) on the target side?

The relation belongs to its *source* entry, not its target. If the target
goes away, the source still wants to say "I have a synonym called X" — just
without the link. CASCADE-deleting the relation would drop user-visible
information.

The source side IS `ON DELETE CASCADE` because a relation has no meaning
without its source.

## Why a hybrid column instead of two separate tables?

The "captured FK" and "text-only" cases are queried identically by the UI
("show me all related words for this entry"). Splitting them into
`vocab_entry_relations_fk` and `vocab_entry_relations_text` would require a
UNION ALL on every read. The hybrid column with a CHECK is simpler and the
relation-rendering query stays a single SELECT.

## Consequences

- Slightly more nullable columns than a pure-FK model would have. Each one
  is documented in a COMMENT explaining when it's NULL.
- The text→FK upgrade pass is idempotent (UPDATE … WHERE target_entry_id
  IS NULL AND lower(target_korean) = lower(?)).
- Reverse-lookup index is partial on `target_entry_id IS NOT NULL` because
  the FK is sparse.
- Future Phase-C dedup can merge text-only relations into FK relations
  without schema change.

## Alternatives considered

- **Pure FK + stub rows**: rejected — pollutes the dictionary table.
- **Pure FK + drop text-only**: rejected — loses signal printed in the book.
- **Separate tables**: rejected — duplicates schema, complicates queries.
- **JSONB blob on each `vocab_entries` row**: rejected — defeats indexed
  reverse lookups and FK integrity for the common (captured) case.
