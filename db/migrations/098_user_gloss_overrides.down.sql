-- migrate: destructive
-- =============================================================================
-- Migration 098 — user_gloss_overrides (DOWN)
--   Drops `user_gloss_overrides`. IF EXISTS so a partial/repeated rollback is
--   a no-op. Reverse of 098_user_gloss_overrides.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS user_gloss_overrides;

-- End of 098_user_gloss_overrides.down.sql — runner owns the transaction (ADR-013).
