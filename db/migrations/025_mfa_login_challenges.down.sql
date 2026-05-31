-- =============================================================================
-- Migration 025 — mfa_login_challenges (DOWN)
--   Drops `mfa_login_challenges` (its indexes drop implicitly with the table).
--   IF EXISTS so a partial/repeated rollback is a no-op. Reverse of
--   025_mfa_login_challenges.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner wraps
-- the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS mfa_login_challenges;

-- End of 025_mfa_login_challenges.down.sql — runner owns the transaction (ADR-013).
