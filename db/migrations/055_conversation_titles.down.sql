-- =============================================================================
-- Migration 055 (down) — remove conversations.title
--   Reverses: 055_conversation_titles.up.sql
--
--   * `conversations.title` is dropped (with its CHECK). This is LOSSY for any
--     titles set since 055 applied — acceptable: a title is a display label,
--     regenerable by re-running the auto-namer (or re-typing a rename); no
--     learning state depends on it. DROP COLUMN does not trip migrate.py's
--     destructive gate (the gate covers DROP TABLE/SCHEMA/DATABASE/TRUNCATE),
--     matching 049/050's down posture for add-only column expands.
--   * The 'name_conversation' claude_route value is intentionally NOT removed:
--     PostgreSQL cannot DROP a value from an enum type without recreating the
--     type and rewriting every dependent column (claude_cache.route,
--     claude_usage.route) — disproportionate and unsafe for a rollback. The
--     value is harmless if unused. Same posture as 021/028/031/032's downs.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the schema_migrations bookkeeping delete.
-- =============================================================================

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS ck_conversations_title_length;
ALTER TABLE conversations DROP COLUMN IF EXISTS title;

-- End of 055_conversation_titles.down.sql — runner owns the transaction (ADR-013).
