-- =============================================================================
-- Migration: 001_core_schema (down)
-- =============================================================================
-- Reverses 001_core_schema.up.sql exactly.
--
-- Drop order = reverse of create order. FK-dependent tables drop first, then
-- their parents. Enum types drop after every table that references them. The
-- shared trigger function set_updated_at() drops last; extensions are NOT
-- dropped (they may be in use by other databases on the cluster — leave them).
--
-- This script assumes migration 002 has ALREADY been rolled back. If 002 added
-- FKs to vocab_cards (vocab_entry_id, source_sentence_id, topik_item_id), they
-- must be dropped first by 002's down.sql. Running this script while those FKs
-- still exist is a no-op for those tables and will fail at vocab_cards DROP —
-- which is the correct, loud failure.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE. discover_migrations
--   enforces this rule at discovery time.
-- =============================================================================

-- 11. card_reviews → 10. vocab_cards
DROP TABLE IF EXISTS card_reviews;
DROP TABLE IF EXISTS vocab_cards;

-- 9. grammar_entries
DROP TABLE IF EXISTS grammar_entries;

-- 8. conversations
DROP TABLE IF EXISTS conversations;

-- 7. diagnostic_snapshots
DROP TABLE IF EXISTS diagnostic_snapshots;

-- 6. user_progress
DROP TABLE IF EXISTS user_progress;

-- 5. study_log
DROP TABLE IF EXISTS study_log;

-- 4b. sessions → 4. users
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

-- 3. Enum types. Triggers attached above were dropped with their tables.
-- Each DROP TYPE will fail if any other table (in a future migration) still
-- references the type — that's the correct behavior. We use IF EXISTS so a
-- re-run after partial failure is safe.
DROP TYPE IF EXISTS conversation_mode;
DROP TYPE IF EXISTS fsrs_state;
DROP TYPE IF EXISTS fsrs_rating;
DROP TYPE IF EXISTS card_face;
DROP TYPE IF EXISTS book_level;
DROP TYPE IF EXISTS corpus;
DROP TYPE IF EXISTS topik_section;
DROP TYPE IF EXISTS register_level;
DROP TYPE IF EXISTS proficiency_level;

-- 2. Shared trigger function — drop last (after all tables that used it).
DROP FUNCTION IF EXISTS set_updated_at();

-- 1. Extensions: intentionally NOT dropped. citext and pgcrypto are global to
-- the database and may be in use elsewhere. Re-running the up migration after
-- this down migration is safe because the up uses CREATE EXTENSION IF NOT EXISTS.

-- End of 001_core_schema.down.sql — runner owns the transaction (ADR-013).
