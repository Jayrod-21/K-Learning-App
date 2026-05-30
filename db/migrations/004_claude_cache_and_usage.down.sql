-- =============================================================================
-- Migration: 004_claude_cache_and_usage (down)
-- =============================================================================
-- Reverse of 004_claude_cache_and_usage.up.sql.
--
-- Drop order (children before parents, view before tables):
--   1. claude_usage_daily (view, depends on claude_usage)
--   2. claude_usage      (depends on users via FK)
--   3. claude_cache
--   4. claude_route, claude_model enums
--
-- Triggers and indexes drop implicitly with their tables.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT here.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

DROP VIEW  IF EXISTS claude_usage_daily;
DROP TABLE IF EXISTS claude_usage;
DROP TABLE IF EXISTS claude_cache;

-- Enums dropped last. IF EXISTS guarded so the down is idempotent.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'claude_route') THEN
        DROP TYPE claude_route;
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'claude_model') THEN
        DROP TYPE claude_model;
    END IF;
END $$;
