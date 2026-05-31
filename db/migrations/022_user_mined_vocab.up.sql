-- =============================================================================
-- Migration 022 — user_mined vocab_entries support (FU-NF-33)
--   UP — makes the `user_mined` corpus (added by migration 021) usable in
--        vocab_entries:
--          1. relaxes ck_vocab_entries_corpus_vocab_only to admit 'user_mined';
--          2. relaxes ck_vocab_entries_level_matches_corpus to allow ANY
--             book_level for 'user_mined' (we store 'beginner' as an inert
--             sentinel — see below);
--          3. seeds the single corpus_sources row for 'user_mined'.
--   Reverse: 022_user_mined_vocab.down.sql
--   Depends on:
--     - 021_user_mined_corpus (adds the 'user_mined' value to the `corpus`
--       enum — committed in its OWN transaction; this migration is the first to
--       USE the value, which is only legal because it runs in a SEPARATE
--       transaction. See the ENUM GOTCHA note in 021's up file.)
--     - 002_darakwon_corpora (defines vocab_entries + its two CHECKs, and
--       corpus_sources).
--
-- WHY THESE RELAXATIONS ARE SAFE
--   Both CHECKs are made strictly MORE PERMISSIVE — every value that satisfied
--   the original definition still satisfies the relaxed one. No existing
--   vocab_entries row can be invalidated by this migration. The recreated
--   constraints carry the SAME names so downstream error messages and the down
--   migration stay stable.
--
-- WHY book_level IS A SENTINEL FOR user_mined
--   A user-mined word has no source book and therefore no real book level. The
--   /vocab/mine route stores 'beginner' purely to satisfy the NOT NULL column;
--   it carries no meaning for this corpus. The relaxed level CHECK accepts ANY
--   book_level when corpus = 'user_mined' so we are never forced to invent a
--   level-to-corpus mapping that does not exist.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the schema_migrations bookkeeping write.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. Relax ck_vocab_entries_corpus_vocab_only to admit 'user_mined'.
--    Original (migration 002): corpus IN ('vocab_2000_beginner',
--    'vocab_2000_intermediate'). We add 'user_mined'.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_corpus_vocab_only;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_corpus_vocab_only CHECK (
        corpus IN ('vocab_2000_beginner', 'vocab_2000_intermediate', 'user_mined')
    );

-- -----------------------------------------------------------------------------
-- 2. Relax ck_vocab_entries_level_matches_corpus to allow any book_level for
--    'user_mined' (sentinel — see header). Original two branches preserved
--    verbatim; we add the user_mined branch.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_entries
    DROP CONSTRAINT IF EXISTS ck_vocab_entries_level_matches_corpus;

ALTER TABLE vocab_entries
    ADD CONSTRAINT ck_vocab_entries_level_matches_corpus CHECK (
        (corpus = 'vocab_2000_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'vocab_2000_intermediate' AND book_level = 'intermediate') OR
        (corpus = 'user_mined')
    );

-- -----------------------------------------------------------------------------
-- 3. Seed the single corpus_sources row for 'user_mined'. Idempotent on the
--    UNIQUE(corpus) — re-applying does nothing. source_path is the UNIQUE
--    '(user-mined)' sentinel (no real file). level / default_proficiency are
--    NULL: a user-mined corpus spans no single book level and carries no
--    default proficiency.
-- -----------------------------------------------------------------------------
INSERT INTO corpus_sources (corpus, title, source_path, notes)
VALUES (
    'user_mined',
    'User-mined vocabulary',
    '(user-mined)',
    'Seeded by 022_user_mined_vocab.up.sql (FU-NF-33). Holds words the learner '
    'tapped/OCR''d and banked via POST /vocab/mine. The vocab_entries rows under '
    'this corpus are SHARED public dictionary lemmas (lemma + gloss, no user '
    'data); the per-user state is the vocab_cards row, not the entry.'
)
ON CONFLICT (corpus) DO NOTHING;

-- End of 022_user_mined_vocab.up.sql — runner owns the transaction (ADR-013).
