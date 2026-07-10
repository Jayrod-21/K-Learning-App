-- =============================================================================
-- Migration 055 — conversation titles + name_conversation route (F-036)
--   UP — two additive changes powering "auto-name chats (Claude-web style)":
--     1. `conversations.title` TEXT NULL — the conversation's display name.
--        NULL = never named (the pre-055 state of every row; the client falls
--        back to its existing mode+date label). Set EITHER by the user
--        (PATCH /conversation/:id, a rename) OR by the F-036 auto-namer
--        (POST /conversation/:id/name, a Claude call that titles the chat
--        from its first exchange). The server only auto-names when title IS
--        NULL, so a user-chosen name is never clobbered.
--     2. claude_route gains 'name_conversation' — the proxy route the F-036
--        naming call is cached/tracked under. Without it, every naming call
--        would fail its claude_cache + claude_usage write with `invalid input
--        value for enum claude_route` (the exact 031/032 defect class); the
--        drift guard server/tests/db/claude_route_enum.test.ts pins the enum
--        to the code's RouteName union, which now includes this value.
--   Reverse: 055_conversation_titles.down.sql (drops the column; the enum
--            value stays — Postgres cannot remove enum values; same posture
--            as 021/031/032's downs).
--   Depends on: 001_core_schema (conversations), 004_claude_cache_and_usage
--               (claude_route).
--
-- SAFETY OF ADD VALUE + ADD COLUMN IN ONE MIGRATION
--   `ALTER TYPE ... ADD VALUE` is legal inside the runner's per-migration
--   transaction on PG12+ PROVIDED the new value is not USED in the same
--   transaction (the 021/016 gotcha). Nothing in this body uses
--   'name_conversation' — the server writes it from separate runtime
--   transactions after deploy — and the `title` column change is unrelated
--   DDL, so both ride one migration. Mirrors 031/032 (value-only) with 049's
--   add-only column posture.
--
-- DEPLOYMENT
--   Expand/contract-compliant: ADD COLUMN (nullable, no default → no table
--   rewrite) + ADD VALUE only. Pre-055 server code never references `title`
--   and keeps working while this applies; ships via the standard
--   zero-downtime blue/green flow; rollback-by-flip stays valid.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the schema_migrations bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. claude_route: the F-036 naming call's cache/usage tracking value.
--    IF NOT EXISTS mirrors 031/032 so re-applying is a no-op.
-- -----------------------------------------------------------------------------
ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'name_conversation';

-- -----------------------------------------------------------------------------
-- 2. conversations.title — user-set or auto-generated conversation name.
--    TEXT NULL (no default): every existing row stays valid and unnamed.
--    The CHECK bounds a stored title to 1..200 chars — the app layer caps
--    tighter (Zod), but the DB constraint is the authority (see the
--    "test with real corpus data" lesson: never trust an API schema looser
--    than the DB constraint behind it — make them agree, DB strictest-last).
-- -----------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_conversations_title_length'
                      AND conrelid = 'conversations'::regclass) THEN
        ALTER TABLE conversations
            ADD CONSTRAINT ck_conversations_title_length CHECK (
                title IS NULL
                OR (char_length(title) BETWEEN 1 AND 200)
            );
    END IF;
END $$;

COMMENT ON COLUMN conversations.title IS
    'Display name of the conversation (F-036). NULL = never named (client falls '
    'back to mode+date). Set by the user (rename) or auto-generated from content '
    'by the name_conversation Claude route; the server only auto-names when NULL '
    'so a user-chosen name is never overwritten.';

-- End of 055_conversation_titles.up.sql — runner owns the transaction (ADR-013).
