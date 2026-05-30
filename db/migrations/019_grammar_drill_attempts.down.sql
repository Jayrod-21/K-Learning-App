-- =============================================================================
-- Migration 019 — grammar production-drill attempts (DOWN)
--   Drops `grammar_drill_attempts` (and its index, dropped implicitly with the
--   table). IF EXISTS so a partial/repeated rollback is a no-op.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner wraps
-- the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS grammar_drill_attempts;

-- End of 019_grammar_drill_attempts.down.sql — runner owns the transaction (ADR-013).
