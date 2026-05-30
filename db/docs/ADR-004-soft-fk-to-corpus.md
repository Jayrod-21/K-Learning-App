# ADR-004: Deferred FKs from core schema to corpus schema

**Status:** Accepted
**Date:** 2026-05-28
**Owners:** Core schema (A1), Corpora (A2)
**Depends on:** ADR-001 (foundation), ADR-003 (SRS storage)

## Context

`vocab_cards` (core, A1) needs to reference vocab entries, source sentences,
and TOPIK items — all owned by migration 002 (A2). The migrations run in
order: 001 → 002. A1 cannot declare an FK to a table that doesn't exist yet.

Three options were considered:

1. **Combine 001 and 002 into one migration.** Rejected — couples two
   independent units of work; agents can't iterate in parallel; rollback granularity
   gets worse.
2. **Declare the columns in A1, add the FKs in A2 via `ALTER TABLE`.** Accepted.
3. **Make the columns `BIGINT`-typed soft pointers with no FK ever.** Rejected —
   gives up integrity for no real benefit; A2 ships in the same release.

## Decision

A1 declares the columns on `vocab_cards`:
- `vocab_entry_id     BIGINT` (nullable; CHECK XOR enforces target shape)
- `source_sentence_id BIGINT` (nullable; same)
- `topik_item_id      BIGINT` (nullable; same)

A2 adds the FK constraints via:

```sql
ALTER TABLE vocab_cards
    ADD CONSTRAINT fk_vocab_cards_vocab_entry
    FOREIGN KEY (vocab_entry_id) REFERENCES vocab_entries(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE vocab_cards
    ADD CONSTRAINT fk_vocab_cards_source_sentence
    FOREIGN KEY (source_sentence_id) REFERENCES sentences(id)
    ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE vocab_cards
    ADD CONSTRAINT fk_vocab_cards_topik_item
    FOREIGN KEY (topik_item_id) REFERENCES topik_items(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
```

A2's `002_*.down.sql` MUST drop these constraints before this migration's
down runs.

## Constraint name reservation

A1 reserves these names so A2 doesn't have to coordinate at runtime:

| Constraint | ON DELETE | Rationale |
|---|---|---|
| `fk_vocab_cards_vocab_entry`     | RESTRICT  | Vocab entries are reference data (ADR-001 D9). |
| `fk_vocab_cards_source_sentence` | SET NULL  | Card outlives source sentence (ADR-001 D9). |
| `fk_vocab_cards_topik_item`      | RESTRICT  | TOPIK items are reference data. |

## Consequences

- During the window between 001 applied and 002 applied, `vocab_cards` rows
  with non-NULL corpus IDs would not be FK-checked. In practice, no card rows
  are inserted in that window — loaders run after migration 002.
- Rollback order: 002 down (drops the FKs and corpus tables), then 001 down.
  Running 001 down while the FKs exist will fail loudly at `DROP TABLE
  vocab_cards` — correct behavior.

## Open questions

None.
