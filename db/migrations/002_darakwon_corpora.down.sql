-- =============================================================================
-- Migration 002 — DOWN
--   Reverses 002_darakwon_corpora.up.sql cleanly.
--   Order: drop dependent tables first, then the parent table, then this
--          migration's trigger functions, then enums it OWNS.
--   Idempotent (every DROP IF EXISTS). Safe to run twice.
--
--   DO NOT DROP (owned by 001_core_schema):
--     - function   set_updated_at()
--     - enum types proficiency_level, corpus, book_level, register_level
--   Dropping these would break A1's 001 schema.
--
--   This migration owns:
--     - tables:   corpus_sources, kgiu_entries, kgiu_entry_relations,
--                 vocab_entries, vocab_entry_relations, hanja_extensions,
--                 lets_check_exercises
--     - functions kgiu_entries_tsv_refresh(), vocab_entries_tsv_refresh()
--     - enums     content_domain, vocab_relation_type, kgiu_entry_type,
--                 vocab_entry_type, lets_check_parent_kind
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in a single
--   transaction together with the bookkeeping DELETE. discover_migrations
--   enforces this rule at discovery time.
--
-- NOTE on enum drops:
--   Postgres CANNOT remove a value from an enum. The up migration added
--   `reference` to vocab_entry_type and kgiu_entry_type via ALTER TYPE … ADD
--   VALUE; we drop the entire enum below, which removes the value along with
--   the type itself. If a future migration extends these enums, this down
--   script will need updating in lockstep.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- --- A1-coordination FK on vocab_cards.vocab_entry_id ----------------------
-- Drop this BEFORE dropping vocab_entries, so the reverse migration is clean.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'fk_vocab_cards_vocab_entry') THEN
        ALTER TABLE vocab_cards DROP CONSTRAINT fk_vocab_cards_vocab_entry;
    END IF;
END $$;

-- --- Tables (drop child tables before parents to satisfy FKs) ---------------

DROP TABLE IF EXISTS lets_check_exercises    CASCADE;
DROP TABLE IF EXISTS hanja_extensions        CASCADE;
DROP TABLE IF EXISTS vocab_entry_relations   CASCADE;
DROP TABLE IF EXISTS vocab_entries           CASCADE;
DROP TABLE IF EXISTS kgiu_entry_relations    CASCADE;
DROP TABLE IF EXISTS kgiu_entries            CASCADE;
DROP TABLE IF EXISTS corpus_sources          CASCADE;

-- --- Trigger functions owned by 002 -----------------------------------------
DROP FUNCTION IF EXISTS kgiu_entries_tsv_refresh();
DROP FUNCTION IF EXISTS vocab_entries_tsv_refresh();

-- --- Enums owned by 002 -----------------------------------------------------
DROP TYPE IF EXISTS lets_check_parent_kind;
DROP TYPE IF EXISTS vocab_entry_type;
DROP TYPE IF EXISTS kgiu_entry_type;
DROP TYPE IF EXISTS vocab_relation_type;
DROP TYPE IF EXISTS content_domain;

-- End of 002_darakwon_corpora.down.sql — runner owns the transaction (ADR-013).
