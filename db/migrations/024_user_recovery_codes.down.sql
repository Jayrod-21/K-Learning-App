-- =============================================================================
-- Migration 024 — user_recovery_codes (DOWN)
--   Drops `user_recovery_codes` (its index drops implicitly with the table).
--   IF EXISTS so a partial/repeated rollback is a no-op. Reverse of
--   024_user_recovery_codes.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner wraps
-- the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS user_recovery_codes;

-- End of 024_user_recovery_codes.down.sql — runner owns the transaction (ADR-013).
