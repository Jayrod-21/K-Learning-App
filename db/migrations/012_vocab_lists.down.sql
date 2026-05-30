-- =============================================================================
-- Migration 012 — User-defined vocab lists (DOWN)
--   Reverses 012_vocab_lists.up.sql.
--   Order: drop child table (vocab_list_entries) before parent (vocab_lists)
--          so the parent FK doesn't block.
--   Idempotent — every DROP is IF EXISTS.
--
-- DO NOT DROP (owned elsewhere):
--   - vocab_entries (migration 002)
--   - users         (migration 001)
--   - set_updated_at() trigger function (migration 001)
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops tables. `migrate.py` requires `--allow-destructive` to
-- run this down. Per migrations/README.md "Rolling back".
-- =============================================================================

DROP TABLE IF EXISTS vocab_list_entries;
DROP TABLE IF EXISTS vocab_lists;

-- End of 012_vocab_lists.down.sql.
