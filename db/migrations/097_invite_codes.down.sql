-- migrate: destructive
-- =============================================================================
-- Migration 097 — invite_codes + invite_redemptions (DOWN)
--   Drops `invite_redemptions` (child — the redemption audit) then
--   `invite_codes` (parent). IF EXISTS on both so a partial/repeated rollback
--   is a no-op. Reverse of 097_invite_codes.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS invite_redemptions;
DROP TABLE IF EXISTS invite_codes;

-- End of 097_invite_codes.down.sql — runner owns the transaction (ADR-013).
