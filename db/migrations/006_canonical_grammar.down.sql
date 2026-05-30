-- =============================================================================
-- Migration 006 — DOWN
--   Reverses 006_canonical_grammar.up.sql.
--   Order: drop the FK + column on kgiu_entries first, then the
--          canonical_grammar table itself. Idempotent (every DROP IF EXISTS).
--
--   This migration owns:
--     - table  canonical_grammar (incl. its trigger)
--     - constraint fk_kgiu_entries_canonical_grammar
--     - column kgiu_entries.canonical_grammar_id
--     - index  ix_canonical_grammar_semantic_family
--     - index  ix_kgiu_entries_canonical_grammar_id
--
--   DO NOT DROP (owned by upstream migrations):
--     - kgiu_entries (002), set_updated_at (001).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps each down body.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- Drop the FK + soft-reference column on kgiu_entries first so we can drop
-- the canonical_grammar table without CASCADE-ing through.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'fk_kgiu_entries_canonical_grammar') THEN
        ALTER TABLE kgiu_entries DROP CONSTRAINT fk_kgiu_entries_canonical_grammar;
    END IF;
END $$;

DROP INDEX IF EXISTS ix_kgiu_entries_canonical_grammar_id;

ALTER TABLE IF EXISTS kgiu_entries DROP COLUMN IF EXISTS canonical_grammar_id;

-- Drop the canonical_grammar table. CASCADE picks up the updated_at trigger
-- AND any dependent indexes (including ix_canonical_grammar_semantic_family),
-- so an explicit DROP INDEX line is unnecessary (REVIEW_C1 NIT-4).
DROP TABLE IF EXISTS canonical_grammar CASCADE;

-- End of 006_canonical_grammar.down.sql — runner owns the transaction (ADR-013).
