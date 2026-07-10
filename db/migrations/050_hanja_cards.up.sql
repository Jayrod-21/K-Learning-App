-- =============================================================================
-- Migration 050 — Hanja rides the FSRS scheduler (F-075)
--   UP — makes `hanja_characters` a fifth leg of the `vocab_cards` polymorphic
--        target (ADR-003 D3: discriminator via mutually-exclusive FK columns +
--        exactly-one-non-null CHECK), so hanja recognition cards are scheduled
--        by the SAME shared FSRS engine (server/src/services/fsrs.ts) and
--        logged to the SAME append-only `card_reviews` trail as vocab /
--        grammar / sentence / topik cards. No parallel scheduler, no parallel
--        review log — that is the whole point of the ticket.
--          * `vocab_cards.hanja_character_id` — new nullable BIGINT FK column
--            to `hanja_characters(id)` (its PK; `char` is the natural UNIQUE
--            key, not the PK — Bar §1).
--          * `ck_vocab_cards_target_xor` — recreated with FIVE legs (the four
--            001 legs + hanja). Existing rows all have hanja_character_id NULL
--            and exactly one legacy leg set, so revalidation passes untouched:
--            full back-compat.
--          * `uq_vocab_cards_user_hanja_face` — partial UNIQUE on
--            (user_id, hanja_character_id, face), mirroring migration 020's
--            grammar-production guard: the card-seed upsert resolves a STABLE
--            card per (user, character, face) and a concurrent double-seed
--            cannot split one character's FSRS history across two cards.
--   Reverse: 050_hanja_cards.down.sql
--   Depends on: 001_core_schema (vocab_cards, card_face), 016_hanja
--               (hanja_characters), 020 (the partial-unique idiom mirrored).
--   NOTE: numbering jumps 047 → 050. Slots 048/049 are reserved by parallel
--   in-flight tickets on other branches; the runner does not require
--   contiguous numbering (see migration 007's header) and minting placeholder
--   files here would collide with those branches at merge time.
--
-- DESIGN NOTES
--   * FK is `ON DELETE CASCADE` — deliberately DIFFERENT from the grammar
--     leg's RESTRICT (001). Grammar entries are user-owned and soft-deleted;
--     nulling the FK on a hard delete would trip the XOR, hence RESTRICT
--     there. `hanja_characters` is shared reference data with NO soft delete:
--     the corpus loader (tools/ingest/loaders/load_hanja.py) only ever
--     UPSERTS characters (`ON CONFLICT (char)`) and never deletes them (only
--     a character's compounds are replaced wholesale), so this CASCADE cannot
--     fire on a routine reload. It exists for the deliberate manual-purge
--     case, where RESTRICT would block corpus maintenance behind per-card
--     cleanup and SET NULL would trip the XOR. A purged character's cards
--     (and their card_reviews, via fk_card_reviews_card CASCADE) go with it —
--     consistent with "the card's target no longer exists".
--   * This is a widening of migration 016's "no FK from user state to the
--     hanja corpus" stance, not a reversal: that note protects
--     hanja_progress' bank/practice state across a REBUILD THAT DROPS
--     CHARACTERS. Cards are re-seedable from the corpus via the seed
--     endpoint; and because the loader is upsert-only, character ids are
--     stable across reloads in practice. FK integrity (ADR-003 D3's entire
--     rationale for the XOR design) wins here.
--   * The unique index keys on (user_id, hanja_character_id, face) rather
--     than pinning `face = 'recognition'` in the predicate (as 020 pins
--     'production'): F-075 seeds recognition cards today, but a future
--     production face (write the character) must not be able to collide
--     either — one card per face per character is the invariant.
--   * `ix_vocab_cards_hanja_character` mirrors ix_vocab_cards_grammar_entry
--     (001): the unique index leads on user_id, so it cannot serve the FK's
--     referential-action scans (DELETE on hanja_characters) or a "cards for
--     character X" lookup; this one can.
--   * DROP + re-ADD of the named XOR CHECK follows the 020 idiom for
--     re-runnable constraint swaps (`DROP CONSTRAINT IF EXISTS` first). The
--     re-ADD revalidates the table; vocab_cards is small (single-user app)
--     and every pre-050 row satisfies the five-leg form by construction.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the bookkeeping write. (No CREATE INDEX
--   CONCURRENTLY — forbidden inside a transaction, and the table is small.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The new target column. Nullable by construction (XOR: exactly one leg is
--    ever set); existing rows are untouched (NULL).
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_cards
    ADD COLUMN IF NOT EXISTS hanja_character_id BIGINT;

COMMENT ON COLUMN vocab_cards.hanja_character_id IS
    'Fifth XOR target leg (F-075): FK to hanja_characters(id). Set on hanja '
    'recognition cards; NULL on every other card family. ON DELETE CASCADE — '
    'see migration 050 header (the loader never deletes characters; only a '
    'deliberate manual purge cascades).';

-- -----------------------------------------------------------------------------
-- 2. The FK. Guarded via pg_constraint (ADD CONSTRAINT has no IF NOT EXISTS)
--    so a re-run is a no-op — the same idiom migration 002 §9 uses.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'fk_vocab_cards_hanja_character') THEN
        ALTER TABLE vocab_cards
            ADD CONSTRAINT fk_vocab_cards_hanja_character
            FOREIGN KEY (hanja_character_id) REFERENCES hanja_characters(id)
            ON DELETE CASCADE ON UPDATE RESTRICT;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. Extend the exactly-one-non-null target CHECK to five legs. Same name as
--    001 so future edits and the down migration stay stable.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_cards
    DROP CONSTRAINT IF EXISTS ck_vocab_cards_target_xor;
ALTER TABLE vocab_cards
    ADD CONSTRAINT ck_vocab_cards_target_xor CHECK (
        (CASE WHEN vocab_entry_id     IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN grammar_entry_id   IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN source_sentence_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN topik_item_id      IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN hanja_character_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    );

-- -----------------------------------------------------------------------------
-- 4. One live card per (user, character, face) — the seed-upsert target and
--    the concurrent-double-seed guard (mirrors 020). Partial:
--      - hanja_character_id IS NOT NULL — keeps the index off every
--        non-hanja card (the XOR leaves the column NULL there);
--      - deleted_at IS NULL — a soft-deleted card must not block seeding a
--        fresh one for the same character.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_cards_user_hanja_face
    ON vocab_cards (user_id, hanja_character_id, face)
    WHERE hanja_character_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX uq_vocab_cards_user_hanja_face IS
    'One live card per (user, hanja character, face). The hanja card-seed '
    'upsert resolves a stable card to advance; a concurrent double-seed cannot '
    'split a character''s FSRS history. F-075; mirrors '
    'uq_vocab_cards_user_grammar_production (020).';

-- -----------------------------------------------------------------------------
-- 5. FK-side index: serves hanja_characters referential-action scans and
--    "cards for character X" (mirrors ix_vocab_cards_grammar_entry, 001).
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_vocab_cards_hanja_character
    ON vocab_cards (hanja_character_id)
    WHERE hanja_character_id IS NOT NULL;

COMMENT ON INDEX ix_vocab_cards_hanja_character IS
    'Supports "list cards for hanja character X" and the FK''s CASCADE scan '
    'on a character purge. Partial — non-hanja cards never enter the index.';

-- End of 050_hanja_cards.up.sql — runner owns the transaction (ADR-013).
