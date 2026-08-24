-- migrate: destructive
-- =============================================================================
-- Migration 095 — user_role (DOWN)
--   Drops `users.role` then the `user_role` enum type. IF EXISTS on both so a
--   partial/repeated rollback is a no-op. Order matters: the column (which
--   depends on the type) must go first, or DROP TYPE fails with "cannot drop
--   type user_role because other objects depend on it". Reverse of
--   095_user_role.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

ALTER TABLE users DROP COLUMN IF EXISTS role;

DROP TYPE IF EXISTS user_role;

-- End of 095_user_role.down.sql — runner owns the transaction (ADR-013).
