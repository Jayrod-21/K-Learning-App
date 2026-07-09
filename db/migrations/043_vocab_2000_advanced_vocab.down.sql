-- =============================================================================
-- Migration 043 — vocab_2000_advanced vocab_entries support (DOWN)
--   Reverses 043_vocab_2000_advanced_vocab.up.sql: restores the two CHECK
--   definitions to their pre-043 (post-022) state — i.e. WITHOUT
--   'vocab_2000_advanced'. Idempotent (DROP CONSTRAINT IF EXISTS + ADD).
--
--   No corpus_sources row is deleted (043 up seeded none — the loader owns that
--   row), so this down is non-destructive per migrate.py.
--
-- CANNOT FULLY TEAR DOWN A POPULATED ADVANCED CORPUS
--   If any vocab_2000_advanced vocab_entries rows exist when this runs, the
--   restored (narrower) CHECK will REJECT them and ADD CONSTRAINT fails loudly —
--   signalling that the advanced corpus must be emptied before 043 can roll
--   back. That is the project's "destructive downs are deliberate" stance and
--   mirrors 022's down exactly.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level transaction control — migrate.py owns the transaction.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_corpus_vocab_only;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_corpus_vocab_only CHECK (
        corpus IN ('vocab_2000_beginner', 'vocab_2000_intermediate', 'user_mined')
    );

ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_level_matches_corpus;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_level_matches_corpus CHECK (
        (corpus = 'vocab_2000_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'vocab_2000_intermediate' AND book_level = 'intermediate') OR
        (corpus = 'user_mined')
    );

-- End of 043_vocab_2000_advanced_vocab.down.sql — runner owns the transaction.
