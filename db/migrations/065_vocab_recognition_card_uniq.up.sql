-- migrate: destructive
-- =============================================================================
-- Migration 065 — one recognition card per (user, vocab entry) (fix-pass
--   follow-up to F-113's server review, SHOULD-FIX #1)
--   UP — (1) DEFENSIVELY DE-DUPLICATES any pre-existing duplicate
--        (user_id, vocab_entry_id, face='recognition', deleted_at IS NULL)
--        `vocab_cards` rows, keeping the EARLIEST (lowest id) row per group
--        and soft-deleting the rest; then (2) adds a PARTIAL UNIQUE INDEX
--        that makes that a permanent DB-level invariant, mirroring
--        migration 020's grammar-production guard and 050's hanja guard.
--   Reverse: 065_vocab_recognition_card_uniq.down.sql (drops the index only
--        — does NOT restore the soft-deleted duplicates; see its own header).
--   Depends on: 001_core_schema (vocab_cards, card_face enum), 020 (the
--        partial-unique idiom mirrored), 050 (same idiom, extended to hanja).
--
-- WHY THIS EXISTS (server review, F-113 fix-pass):
--   `POST /vocab/lists/:id/cards/seed` (F-113) and the pre-existing
--   `POST /vocab/cards/init` / `POST /vocab/entries/:id/bank` all seed a
--   recognition card for (user, vocab entry) via a NOT-EXISTS-gated INSERT —
--   correct under a single writer, but NOT atomic across two independent
--   transactions under Postgres READ COMMITTED. Two truly concurrent calls
--   (e.g. this route racing `cards/init` for an entry that is also a list
--   member) could each pass their own NOT-EXISTS check and insert two
--   `vocab_cards` rows for the same target, splitting that word's FSRS
--   history across two cards. This migration closes the gap with a real
--   UNIQUE index so a second racing INSERT fails the index (or, once the
--   route is updated to `ON CONFLICT ... DO NOTHING`, silently no-ops)
--   instead of ever landing.
--
-- WHY THE DE-DUPE MUST RUN BEFORE THE INDEX (LIVE-DB SAFETY):
--   The production `vocab_cards` table has real data, and MAY already
--   contain exactly the duplicate rows this migration is trying to prevent
--   going forward — the gap being closed here is PRE-EXISTING (both
--   `cards/init` and `entries/:id/bank` have shipped this way since their
--   original PRs). A bare `CREATE UNIQUE INDEX` over data that already
--   violates the constraint fails outright and ABORTS THE MIGRATION (and
--   thus the deploy, per ADR-013's single-transaction-per-migration
--   contract) — it does not "mostly work" or index-just-the-clean-rows. So
--   step (1) must run first, unconditionally, whether or not any duplicate
--   actually exists on this database (the `full_dir` testcontainer test
--   below proves both the empty-table and the populated-with-duplicates
--   case go through the SAME migration file cleanly).
--
-- DE-DUPE RULE — keep the EARLIEST row per (user_id, vocab_entry_id):
--   `ROW_NUMBER() OVER (PARTITION BY user_id, vocab_entry_id ORDER BY id ASC)`
--   over the live (deleted_at IS NULL, face = 'recognition',
--   vocab_entry_id IS NOT NULL) rows; rn = 1 (lowest id — i.e. the row
--   created FIRST, since `id` is a monotonically increasing identity column)
--   survives, every rn > 1 sibling is soft-deleted (`deleted_at = now()`).
--   "Earliest" is the least-surprising choice for a scheduler-visible
--   invariant: the FIRST card the user ever started reviewing for that word
--   is the one whose FSRS state (due date, stability, difficulty, review
--   count) keeps scheduling that word — not a later accidental duplicate
--   that may have less review history.
--
-- WHY SOFT-DELETE, NOT A HARD DELETE:
--   `card_reviews.card_id` FK's `ON DELETE CASCADE` (001) means a hard
--   DELETE of a duplicate `vocab_cards` row would CASCADE-DELETE that
--   duplicate's own `card_reviews` rows too — destroying real review
--   history for however many times the user actually studied that
--   duplicate card. Soft-deleting (the app's existing removal mechanism —
--   every route in this codebase already filters `deleted_at IS NULL`)
--   removes the duplicate from all live queries and from the new partial
--   index (which itself is scoped `... AND deleted_at IS NULL`) while
--   preserving its `card_reviews` trail intact for audit/analytics. This
--   is the SAME posture 050's header takes for the hanja FK (CASCADE is
--   for a deliberate corpus purge, not routine cleanup) and the same
--   reasoning that keeps every scheduling query soft-delete-aware already.
--
-- MARKER (F-088): declared destructive. Step (1) is a data-mutating UPDATE
--   that soft-deletes existing rows — from the app's point of view
--   (everything filters `deleted_at IS NULL`) this is equivalent to a
--   DELETE and is exactly the "mass DELETE/UPDATE the legacy sniff misses"
--   shape F-088's explicit marker exists to catch (the legacy regex only
--   catches DROP TABLE/SCHEMA/DATABASE/TRUNCATE, not UPDATE). Requires
--   `--allow-destructive` to apply, same as 064's up (which is itself a
--   data-mutating statement, not schema DDL).
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
--   wraps this body in a single transaction together with the bookkeeping
--   write. (No CREATE INDEX CONCURRENTLY — forbidden inside a transaction;
--   `vocab_cards` is small at this app's scale, matching 020/050's own
--   non-concurrent choice.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. De-duplicate FIRST. A no-op (0 rows touched) on a database with no
--    pre-existing duplicates — the WHERE/PARTITION shape only ever matches
--    rows that are ALREADY duplicates, so a clean table is untouched.
-- -----------------------------------------------------------------------------
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, vocab_entry_id
               ORDER BY id ASC
           ) AS rn
      FROM vocab_cards
     WHERE face = 'recognition'
       AND vocab_entry_id IS NOT NULL
       AND deleted_at IS NULL
)
UPDATE vocab_cards
   SET deleted_at = now()
  FROM ranked
 WHERE vocab_cards.id = ranked.id
   AND ranked.rn > 1;

-- -----------------------------------------------------------------------------
-- 2. Now the index can be created unconditionally — the table is guaranteed
--    to satisfy the uniqueness predicate regardless of pre-migration state.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_cards_user_vocab_recognition
    ON vocab_cards (user_id, vocab_entry_id)
    WHERE face = 'recognition' AND vocab_entry_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX uq_vocab_cards_user_vocab_recognition IS
    'One live recognition card per (user, vocab entry). Backs POST /vocab/lists/:id/cards/seed''s '
    'ON CONFLICT DO NOTHING upsert; a concurrent double-seed (or a race with cards/init) cannot '
    'split a word''s FSRS history across two cards. Mirrors uq_vocab_cards_user_grammar_production '
    '(020) / uq_vocab_cards_user_hanja_face (050). Migration 065.';

-- End of 065_vocab_recognition_card_uniq.up.sql — runner owns the transaction (ADR-013).
