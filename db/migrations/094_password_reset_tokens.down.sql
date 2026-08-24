-- migrate: destructive
-- =============================================================================
-- Migration 094 — password_reset_tokens (DOWN)
--   Drops `password_reset_tokens` (its indexes drop implicitly with the
--   table). IF EXISTS so a partial/repeated rollback is a no-op. Reverse of
--   094_password_reset_tokens.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS password_reset_tokens;

-- End of 094_password_reset_tokens.down.sql — runner owns the transaction (ADR-013).
