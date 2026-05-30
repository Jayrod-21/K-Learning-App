-- =============================================================================
-- Migration 018 — user app preferences (DOWN)
--   Drops the `users.preferences` column added by 018_user_preferences.up.sql.
--   IF EXISTS so a partial/repeated rollback is a no-op, not an error.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner wraps
-- the down body in a single transaction.
-- =============================================================================

ALTER TABLE users DROP COLUMN IF EXISTS preferences;

-- End of 018_user_preferences.down.sql — runner owns the transaction (ADR-013).
