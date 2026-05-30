-- =============================================================================
-- Migration 013 — Writing prompt bank (DOWN)
--   Reverses 013_writing_prompts.up.sql.
--   Idempotent — the DROP is IF EXISTS. Dropping the table also drops its
--   index and the BEFORE UPDATE trigger attached to it, so no separate
--   DROP TRIGGER / DROP INDEX is needed.
--
-- DO NOT DROP (owned elsewhere):
--   - proficiency_level enum          (migration 001)
--   - set_updated_at() trigger function (migration 001)
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops a table (and its seeded reference rows). `migrate.py`
-- requires `--allow-destructive` to run this down. Per migrations/README.md
-- "Rolling back".
-- =============================================================================

DROP TABLE IF EXISTS writing_prompts;

-- End of 013_writing_prompts.down.sql.
