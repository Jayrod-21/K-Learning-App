-- migrate: destructive
-- =============================================================================
-- Migration 101 — generated_items (DOWN)
--   Drops `generated_items`. IF EXISTS so a partial/repeated rollback is a
--   no-op. Destructive: the table holds generated item rows (draft/approved/
--   retired) with no other durable copy — an operator who has approved a
--   bank and flipped DIAGNOSTIC_USE_GENERATED_BANK loses that bank on
--   rollback. Reverse of 101_generated_items.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

DROP TABLE IF EXISTS generated_items;

-- End of 101_generated_items.down.sql — runner owns the transaction (ADR-013).
