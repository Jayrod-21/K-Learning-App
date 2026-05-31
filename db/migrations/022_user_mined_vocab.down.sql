-- =============================================================================
-- Migration 022 — user_mined vocab_entries support (DOWN)
--   Reverses 022_user_mined_vocab.up.sql:
--     1. restores the two original (pre-FU-NF-33) CHECK definitions verbatim
--        from migration 002;
--     2. deletes the seeded 'user_mined' corpus_sources row.
--   Idempotent — DROP CONSTRAINT IF EXISTS + a guarded DELETE.
--
-- CANNOT FULLY TEAR DOWN A POPULATED MINED CORPUS
--   corpus_sources is the FK parent of vocab_entries with ON DELETE RESTRICT
--   (migration 002). If any vocab_entries row references the 'user_mined'
--   source (i.e. a user has banked at least one tapped word), the DELETE below
--   would be blocked by the FK. We therefore guard it: the row is deleted only
--   when no vocab_entries reference it. A data-bearing mined corpus survives
--   this down — exactly like every other data-bearing down in this project
--   (e.g. corpus_sources rows whose children exist). The restored CHECKs below
--   would then REJECT those surviving user_mined rows, so a clean down requires
--   the operator to first remove the mined entries (a deliberate, destructive
--   act) — which is the correct posture for user data.
--
--   The CHECK restoration runs UNCONDITIONALLY (it is the schema reversion); if
--   user_mined rows still exist, ADD CONSTRAINT will fail loudly, signalling
--   that the corpus must be emptied before 022 can be rolled back. This matches
--   the project's "destructive downs are deliberate" stance.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: deletes a corpus_sources row. `migrate.py` requires
-- `--allow-destructive` to run this down. Per migrations/README.md.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. Delete the seeded 'user_mined' corpus_sources row — only if nothing
--    references it (the FK is ON DELETE RESTRICT; this guard avoids a confusing
--    FK error and documents that a populated mined corpus is not torn down).
-- -----------------------------------------------------------------------------
DELETE FROM corpus_sources cs
 WHERE cs.corpus = 'user_mined'
   AND NOT EXISTS (
       SELECT 1 FROM vocab_entries ve WHERE ve.corpus_source_id = cs.id
   );

-- -----------------------------------------------------------------------------
-- 2. Restore the two original CHECK definitions verbatim from migration 002.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_corpus_vocab_only;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_corpus_vocab_only CHECK (
        corpus IN ('vocab_2000_beginner', 'vocab_2000_intermediate')
    );

ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_level_matches_corpus;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_level_matches_corpus CHECK (
        (corpus = 'vocab_2000_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'vocab_2000_intermediate' AND book_level = 'intermediate')
    );

-- End of 022_user_mined_vocab.down.sql — runner owns the transaction (ADR-013).
