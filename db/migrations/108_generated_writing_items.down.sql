-- migrate: destructive
-- =============================================================================
-- Migration 108 — generated_writing_items (DOWN)
--   Drops `generated_writing_items`. IF EXISTS so a partial/repeated rollback
--   is a no-op. Destructive: the table holds generated writing item rows
--   (draft/approved/rejected) with no other durable copy — an operator who
--   has approved a writing bank loses it on rollback. Reverse of
--   108_generated_writing_items.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS generated_writing_items;

-- End of 108_generated_writing_items.down.sql — runner owns the transaction
-- (ADR-013).
