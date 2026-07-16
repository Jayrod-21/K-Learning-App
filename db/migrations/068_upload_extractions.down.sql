-- migrate: destructive
-- =============================================================================
-- Migration 068 — upload_extractions (DOWN)
--   Reverses 068_upload_extractions.up.sql:
--     1. drops the `upload_extractions` table (run history is lost — hence
--        the destructive marker above; `migrate.py` requires
--        --allow-destructive);
--     2. drops the `upload_extraction_status` enum (safe once the only table
--        using it is gone);
--     3. restores the two original (pre-F-108) kgiu_entries CHECK
--        definitions verbatim from migrations 002/027-era shape.
--
-- CANNOT FULLY TEAR DOWN A POPULATED EXTRACTED CORPUS
--   If any kgiu_entries rows exist under corpus = 'user_mined' (i.e. an
--   extraction run has persisted grammar candidates), the unconditional
--   CHECK restoration below will FAIL LOUDLY — ADD CONSTRAINT validates
--   existing rows. A clean down then requires the operator to first remove
--   those rows (a deliberate, destructive act), which is the correct posture
--   for content a user paid Vision budget to extract. This mirrors migration
--   022's down verbatim (same situation for vocab_entries).
--
--   vocab_entries rows the pipeline inserted are NOT touched here — they are
--   valid under 022's (still-applied) relaxed CHECKs and live independently
--   of this migration.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this down body in its own
--   transaction together with the bookkeeping DELETE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Drop the run table (and with it the partial-unique claim index + the
--    updated_at trigger, which belong to the table).
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS upload_extractions;

-- -----------------------------------------------------------------------------
-- 2. Drop the enum — nothing else references it once the table is gone.
-- -----------------------------------------------------------------------------
DROP TYPE IF EXISTS upload_extraction_status;

-- -----------------------------------------------------------------------------
-- 3. Restore the two original kgiu_entries CHECK definitions verbatim.
--    Fails loudly if 'user_mined' kgiu rows still exist — see header.
-- -----------------------------------------------------------------------------
ALTER TABLE kgiu_entries
    DROP CONSTRAINT IF EXISTS ck_kgiu_entries_corpus_kgiu_only;

ALTER TABLE kgiu_entries
    ADD CONSTRAINT ck_kgiu_entries_corpus_kgiu_only CHECK (
        corpus IN ('kgiu_beginner', 'kgiu_intermediate', 'kgiu_advanced')
    );

ALTER TABLE kgiu_entries
    DROP CONSTRAINT IF EXISTS ck_kgiu_entries_level_matches_corpus;

ALTER TABLE kgiu_entries
    ADD CONSTRAINT ck_kgiu_entries_level_matches_corpus CHECK (
        (corpus = 'kgiu_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'kgiu_intermediate' AND book_level = 'intermediate') OR
        (corpus = 'kgiu_advanced'     AND book_level = 'advanced')
    );

-- End of 068_upload_extractions.down.sql — runner owns the transaction (ADR-013).
