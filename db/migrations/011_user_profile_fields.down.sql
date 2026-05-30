-- =============================================================================
-- Migration 011 — User profile fields (DOWN)
--   Reverses 011_user_profile_fields.up.sql.
--   Order: drop CHECK first (so a future re-apply doesn't trip "already
--          exists"), then drop the column.
--   Idempotent — every DROP is IF EXISTS.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops a column. `migrate.py` requires `--allow-destructive`
-- to run this down. Per migrations/README.md "Rolling back".
-- =============================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_phone_shape;
ALTER TABLE users DROP COLUMN IF EXISTS phone;

-- End of 011_user_profile_fields.down.sql.
