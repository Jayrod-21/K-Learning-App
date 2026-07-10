-- =============================================================================
-- Migration 048 — beta ticketing / feedback (DOWN)
--   Reverses 048_tickets.up.sql.
--   Order: drop child table (ticket_comments) before parent (tickets) so the
--          parent FK doesn't block.
--   Idempotent — every DROP is IF EXISTS.
--
-- DO NOT DROP (owned elsewhere):
--   - users            (migration 001)
--   - set_updated_at() trigger function (migration 001)
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops tables (all filed beta feedback and its discussion).
-- `migrate.py` requires `--allow-destructive` to run this down. Per
-- migrations/README.md "Rolling back".
-- =============================================================================

DROP TABLE IF EXISTS ticket_comments;
DROP TABLE IF EXISTS tickets;

-- End of 048_tickets.down.sql.
