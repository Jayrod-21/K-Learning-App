-- =============================================================================
-- Migration 015 — TOPIK Prep answer log (DOWN)
--   Reverses 015_topik_responses.up.sql by dropping `topik_responses`.
--   Idempotent — the DROP is IF EXISTS.
--
-- DO NOT DROP (owned elsewhere):
--   - topik_items   (migration 005)
--   - users         (migration 001)
--   - set_updated_at() trigger function (migration 001)
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops a table. `migrate.py` requires `--allow-destructive` to run
-- this down. Per migrations/README.md "Rolling back".
-- =============================================================================

DROP TABLE IF EXISTS topik_responses;

-- End of 015_topik_responses.down.sql.
