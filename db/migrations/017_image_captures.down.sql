-- =============================================================================
-- Migration 017 — Image captures + OCR-mined words (DOWN)
--   Reverses 017_image_captures.up.sql.
--   Order: drop child table (image_words) before parent (image_captures) so the
--          parent FK doesn't block.
--   Idempotent — every DROP is IF EXISTS.
--
-- DO NOT DROP (owned elsewhere):
--   - users (migration 001)
--   - set_updated_at() trigger function (migration 001)
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops tables. `migrate.py` requires `--allow-destructive` to
-- run this down. Per migrations/README.md "Rolling back". Note: blob files on
-- disk under IMAGE_STORAGE_DIR are NOT removed by this migration — the DB rows
-- referencing them are dropped, but the filesystem cleanup is an operational
-- task (the store is not transactional with Postgres; see SECURITY.md §16).
-- =============================================================================

DROP TABLE IF EXISTS image_words;
DROP TABLE IF EXISTS image_captures;

-- End of 017_image_captures.down.sql.
