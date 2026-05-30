-- =============================================================================
-- Migration 010 — DOWN
--   Reverses 010_canonical_grammar_manual_override.up.sql.
--
--   This migration owns:
--     - column kgiu_entries.canonical_grammar_id_is_manual_override
--
--   DO NOT DROP (owned by upstream migrations):
--     - kgiu_entries (002), canonical_grammar (006), the FK column (006).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps each down body.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

ALTER TABLE IF EXISTS kgiu_entries
    DROP COLUMN IF EXISTS canonical_grammar_id_is_manual_override;

-- End of 010_canonical_grammar_manual_override.down.sql.
