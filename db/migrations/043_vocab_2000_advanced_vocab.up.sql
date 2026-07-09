-- =============================================================================
-- Migration 043 — vocab_2000_advanced vocab_entries support (U2 book uploads)
--   UP — makes the 'vocab_2000_advanced' corpus (added by migration 042) usable
--        in vocab_entries:
--          1. relaxes ck_vocab_entries_corpus_vocab_only to admit it;
--          2. relaxes ck_vocab_entries_level_matches_corpus to pair it with
--             book_level = 'advanced' (that book_level value already exists).
--
--        The single corpus_sources row is NOT seeded here — the file loader
--        (tools/ingest/loaders/load_vocab_2000.py) creates it via
--        upsert_corpus_source at load time, exactly as it does for the beginner
--        and intermediate corpora. (Contrast migration 022, which seeded
--        'user_mined' because that corpus is populated by a route, not a loader,
--        and so had no loader to create its corpus_sources row.)
--   Reverse: 043_vocab_2000_advanced_vocab.down.sql
--   Depends on:
--     - 042_vocab_2000_advanced_corpus (adds the enum value, in its own tx).
--     - 002_darakwon_corpora (defines vocab_entries + its two CHECKs).
--     - 022_user_mined_vocab (the current CHECK definitions this relaxes).
--
-- WHY SAFE: both CHECKs are made strictly MORE PERMISSIVE — every value that
--   satisfied the prior definition still satisfies the relaxed one, so no
--   existing vocab_entries row can be invalidated. Constraint names are
--   unchanged so downstream error messages and the down migration stay stable.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level transaction control — migrate.py owns the transaction.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- 1. Admit 'vocab_2000_advanced' to the vocab-only corpus CHECK.
ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_corpus_vocab_only;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_corpus_vocab_only CHECK (
        corpus IN (
            'vocab_2000_beginner',
            'vocab_2000_intermediate',
            'vocab_2000_advanced',
            'user_mined'
        )
    );

-- 2. Pair 'vocab_2000_advanced' with book_level 'advanced'. The prior branches
--    are preserved verbatim; the advanced branch is added.
ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_level_matches_corpus;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_level_matches_corpus CHECK (
        (corpus = 'vocab_2000_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'vocab_2000_intermediate' AND book_level = 'intermediate') OR
        (corpus = 'vocab_2000_advanced'     AND book_level = 'advanced')     OR
        (corpus = 'user_mined')
    );

-- End of 043_vocab_2000_advanced_vocab.up.sql — runner owns the transaction.
