-- =============================================================================
-- Migration 003 — DOWN
--   Reverses 003_krdict.up.sql cleanly.
--   Order: drop child tables before parents, then trigger functions owned by
--          this migration. No enums owned by 003 (POS is TEXT+CHECK per
--          ADR-017; register tag reuses 001's register_level enum).
--   Idempotent — every DROP IF EXISTS. Safe to run twice.
--
--   DO NOT DROP (owned by 001_core_schema):
--     - function   set_updated_at()
--     - enum types register_level (and all the others)
--
--   This migration owns:
--     - tables:    krdict_import_state, krdict_inflections, krdict_examples,
--                  krdict_senses, krdict_entries, krdict_source
--     - functions: krdict_entries_tsv_refresh()
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in a single
--   transaction together with the bookkeeping DELETE. discover_migrations
--   enforces this rule at discovery time.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- --- Tables (children before parents to satisfy FKs) ------------------------

DROP TABLE IF EXISTS krdict_import_state CASCADE;
DROP TABLE IF EXISTS krdict_inflections  CASCADE;
DROP TABLE IF EXISTS krdict_examples     CASCADE;
DROP TABLE IF EXISTS krdict_senses       CASCADE;
DROP TABLE IF EXISTS krdict_entries      CASCADE;
DROP TABLE IF EXISTS krdict_source       CASCADE;

-- --- Trigger functions owned by 003 -----------------------------------------
DROP FUNCTION IF EXISTS krdict_entries_tsv_refresh();

-- End of 003_krdict.down.sql — runner owns the transaction (ADR-013).
