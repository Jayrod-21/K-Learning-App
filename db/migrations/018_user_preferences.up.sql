-- =============================================================================
-- Migration 018 — user app preferences (Pass 9, Settings server-sync)
--   UP — adds a single JSONB `preferences` column to `users` so the Settings
--        screen's notification + palette choices persist server-side (and sync
--        across a user's devices) instead of living only in the browser's
--        localStorage["km.settings"].
--   Reverse: 018_user_preferences.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()).
--
-- DESIGN NOTES (locked decision, 2026-05-30)
--   * Storage is a JSONB COLUMN on users, NOT a new table. The blob is small,
--     read/written whole (GET + PUT the full object, last-writer-wins), and has
--     no sub-row query needs — a column is the right shape and avoids a join on
--     every Settings load. The server Zod-validates the shape on write
--     (PrefsSchema, .strict()), so the DB stays a dumb store and a corrupt/legacy
--     blob falls back to DEFAULT_PREFS at the route rather than 500-ing.
--   * Profile fields (name/email/phone) live in their OWN columns (migration 011)
--     and are edited via PATCH /auth/me — they are deliberately NOT mirrored into
--     this blob, so there is no dual-write / drift between the two.
--   * DEFAULT '{}'::jsonb (NOT a populated default): every existing row gets an
--     empty object with no per-row backfill, and the route treats empty/missing
--     keys as "use DEFAULT_PREFS". NOT NULL so reads never see a surprising null.
--   * No new updated_at trigger: users already has trg_users_updated_at
--     (migration 001), so any UPDATE that writes `preferences` bumps updated_at
--     for free.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.preferences IS
    'Per-user app preferences (notif + palette). Mirrors client localStorage["km.settings"] notif/palette. Profile name/email/phone live in their own columns, not here. Last-writer-wins.';

-- End of 018_user_preferences.up.sql — runner owns the transaction (ADR-013).
