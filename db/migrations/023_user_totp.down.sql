-- =============================================================================
-- Migration 023 — user_totp (DOWN)
--   Drops `user_totp` (its trigger drops implicitly with the table). IF EXISTS
--   so a partial/repeated rollback is a no-op. Reverse of 023_user_totp.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner wraps
-- the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS user_totp;

-- End of 023_user_totp.down.sql — runner owns the transaction (ADR-013).
