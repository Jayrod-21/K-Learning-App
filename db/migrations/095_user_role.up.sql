-- migrate: non-destructive
-- =============================================================================
-- Migration 095 — user_role (Phase 2.2, admin-role foundation)
--   UP — adds a closed `user_role` enum ('user', 'admin') and a NOT NULL
--        `users.role` column defaulting to 'user'. Every existing row is
--        backfilled 'user' by the column DEFAULT (no explicit UPDATE needed).
--   Reverse: 095_user_role.down.sql
--   Depends on: 001_core_schema (users).
--
-- DESIGN NOTES
--   * `user_role` is a closed value set (ADR-001 D8) — same DO-block guard
--     pattern as every other enum in this repo (mirrors 001_core_schema /
--     040's pattern; PG 16 has no CREATE TYPE IF NOT EXISTS for enums).
--   * `role` defaults to 'user' — creating this column grants NO new
--     privilege to any existing account. Promoting an account to 'admin' is
--     a deliberate, separate write (seed-user.ts's SEED_USER_ROLE, or a
--     future admin-management path) — never a side effect of this migration.
--   * NOT NULL with a DEFAULT: adding a NOT NULL column with a constant
--     DEFAULT is a metadata-only change on PG 11+ (no full-table rewrite/lock
--     escalation), so this is safe against the live `users` table.
--   * The middleware/route layer (server/src/middleware/auth.ts requireAdmin,
--     server/src/routes/admin.ts) reads this column ONLY through the
--     server-side session projection (getActiveSession) — never trusts
--     client-supplied role claims. See server SECURITY.md.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps the up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum type (closed value set — ADR-001 D8). DO block guards creation so
--    the migration is re-runnable; PG 16 has no CREATE TYPE IF NOT EXISTS for
--    enums (mirrors 001_core_schema's pattern).
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('user', 'admin');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. users.role — additive, defaulted column. NOT NULL + DEFAULT 'user' means
--    every pre-existing account stays an ordinary user; nothing is silently
--    promoted.
-- -----------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'user';

COMMENT ON COLUMN users.role IS
    'Authorization role (Phase 2.2). ''user'' (default) or ''admin''. Read '
    'ONLY from the server-side session projection (auth/sessions.ts '
    'getActiveSession -> req.user.role) by middleware/auth.ts''s requireAdmin '
    '— NEVER trust a client-supplied role claim (header/body/query). Promote '
    'via server/src/scripts/seed-user.ts SEED_USER_ROLE=admin, not a manual '
    'UPDATE (see km_never_manually_apply_migrations discipline — this column, '
    'once set, is ordinary application data, not a migration concern).';

-- End of 095_user_role.up.sql — runner owns the transaction (ADR-013).
