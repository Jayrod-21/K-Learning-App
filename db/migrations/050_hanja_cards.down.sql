-- =============================================================================
-- Migration 050 — Hanja rides the FSRS scheduler (DOWN)
--   Reverses 050_hanja_cards.up.sql exactly: deletes the hanja-target cards
--   (they cannot be represented in the four-leg pre-050 shape — dropping the
--   column would leave them with ZERO non-null target legs and the restored
--   XOR would reject the whole table), drops the two indexes, restores the
--   001 four-leg XOR CHECK, and drops the FK + column.
--
--   ⚠ DELIBERATE DATA LOSS: every hanja card AND its card_reviews rows (via
--   fk_card_reviews_card ON DELETE CASCADE) are deleted. Same posture as
--   046.down (attempt history): a rollback of the feature is a deliberate
--   loss of the feature's per-user state; cards are re-seedable from the
--   corpus after a re-up, but their FSRS scheduling history is not. Note the
--   migrate.py destructive gate does NOT match DELETE/DROP COLUMN (it matches
--   DROP TABLE/SCHEMA/DATABASE/TRUNCATE only), so this down runs without
--   --allow-destructive — the warning lives here instead.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction, so the DELETE and the schema
-- restore commit or abort together.
-- =============================================================================

-- 1. Remove the rows the pre-050 shape cannot hold (card_reviews CASCADE).
DELETE FROM vocab_cards WHERE hanja_character_id IS NOT NULL;

-- 2. Drop the 050 indexes. IF EXISTS keeps a repeated rollback idempotent.
DROP INDEX IF EXISTS uq_vocab_cards_user_hanja_face;
DROP INDEX IF EXISTS ix_vocab_cards_hanja_character;

-- 3. Restore the 001 four-leg XOR (same constraint name; safe now that no row
--    carries a hanja target).
ALTER TABLE vocab_cards
    DROP CONSTRAINT IF EXISTS ck_vocab_cards_target_xor;
ALTER TABLE vocab_cards
    ADD CONSTRAINT ck_vocab_cards_target_xor CHECK (
        (CASE WHEN vocab_entry_id     IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN grammar_entry_id   IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN source_sentence_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN topik_item_id      IS NOT NULL THEN 1 ELSE 0 END) = 1
    );

-- 4. Drop the FK, then the column.
ALTER TABLE vocab_cards
    DROP CONSTRAINT IF EXISTS fk_vocab_cards_hanja_character;
ALTER TABLE vocab_cards
    DROP COLUMN IF EXISTS hanja_character_id;

-- End of 050_hanja_cards.down.sql — runner owns the transaction (ADR-013).
