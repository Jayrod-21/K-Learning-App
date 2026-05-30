# ADR-003: SRS storage — FSRS, not SM-2; append-only review log

**Status:** Accepted
**Date:** 2026-05-28
**Owners:** Core schema (A1)
**Supersedes:** Supabase `vocab_reviews` table (SM-2-shaped)
**Depends on:** ADR-001 (foundation)

## Context

DESIGN_SPEC.md locks the SRS engine as **FSRS** (Free Spaced Repetition Scheduler).
The pre-migration Supabase schema stored SM-2 fields (`easiness`, `interval`,
`repetitions`) on the review row. FSRS uses a different state vector:
`stability`, `difficulty`, `state` (new/learning/review/relearning),
`elapsed_days`, `scheduled_days`, `reps`, `lapses`. The two are not interchangeable.

## Decisions

### D1. Card state lives on `vocab_cards`; review events live on `card_reviews`

- `vocab_cards` holds the **current** FSRS state per card. One row per card.
  Updated in place on each review (with `version` bumped).
- `card_reviews` is **append-only**. One row per Again/Hard/Good/Easy press.
  Stores BEFORE and AFTER snapshots of the FSRS variables.

### D2. Why store BEFORE and AFTER on the review row

FSRS parameters are tunable per user (the algorithm has 19 weights). To re-tune
from history, the optimizer needs each review's input state, the rating given,
and the resulting state. If we only stored "after", we'd have to reconstruct
"before" by walking the entire history forward — slow and fragile if any single
row is wrong.

Storing both makes:
- **Re-tuning** = single pass over `card_reviews` rows.
- **Card-detail history view** = direct read, no reconstruction.
- **Debugging** = "why did this card schedule for 8 days?" answerable from one row.

Cost: ~24 extra bytes per review row (two `NUMERIC(10,4)` + two `NUMERIC(4,2)` +
two enums). Negligible.

### D3. Polymorphic card target via discriminator + mutually-exclusive FKs

A card can target a vocab entry, a grammar entry, a sentence (cloze), or a
TOPIK item. Three options were considered:

1. **One big "target" table union (CTI / single table inheritance).** Rejected —
   gives up FK integrity to the actual referenced tables.
2. **Polymorphic FK via `(target_type, target_id)`.** Rejected — no DB-level
   FK is possible, integrity becomes app-layer-only.
3. **Discriminator + mutually-exclusive FK columns + XOR CHECK constraint.**
   **Accepted.** Each target type gets its own typed FK column. A
   CHECK constraint enforces "exactly one is non-NULL". FK integrity preserved
   for every target type. The cost is column sprawl on `vocab_cards`, which
   is acceptable for four types.

The grammar FK is declared inline (the table exists in this migration). The
vocab / sentence / TOPIK FKs are added by migration 002 (A2 owns those tables)
via `ALTER TABLE … ADD CONSTRAINT`. A1 reserves the constraint names:
- `fk_vocab_cards_vocab_entry`
- `fk_vocab_cards_source_sentence`  (ON DELETE SET NULL per ADR-001 D9)
- `fk_vocab_cards_topik_item`

### D4. `card_reviews` has no `updated_at`, `version`, or `deleted_at`

It's an audit trail. Mutating an entry would defeat the point.
- `created_at` is enough (== `reviewed_at` in practice, but kept distinct for
  the rare case the app needs to record a back-dated review with a separate
  insert timestamp).
- No soft delete — if a card is hard-deleted, its reviews CASCADE-delete.

### D5. Suspension instead of "burying"

Anki has "buried" and "suspended" as two separate concepts. We keep only
suspension (`suspended_at`) because the user's review queue scope is small;
"buried until tomorrow" can be emulated by setting `due_at = tomorrow`.

## Consequences

- Loader (Phase A4) must build the four target_id columns correctly based on
  the source of the card (vocab table → vocab_entry_id, etc.).
- Re-tuning FSRS weights is a single offline pass over `card_reviews`.
- The hot review-queue query (`WHERE due_at <= now() AND suspended_at IS NULL
  AND deleted_at IS NULL`) is supported by `ix_vocab_cards_due_queue`, a
  partial composite index on `(user_id, due_at)`.

## Open questions

- Whether to materialize per-day review counts for the heatmap, or compute
  them on the fly from `card_reviews`. Defer until we see how slow the live
  query gets.
