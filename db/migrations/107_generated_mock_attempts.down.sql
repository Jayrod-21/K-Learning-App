-- migrate: destructive
-- =============================================================================
-- Migration 107 — generated_mock_attempts (DOWN)
--   Reverses 107_generated_mock_attempts.up.sql: drops the table (its trigger
--   and both indexes go with it; set_updated_at() is shared (001) and stays).
--
-- LOSSY BY DESIGN (hence the destructive marker; migrate.py requires
-- --allow-destructive):
--   Every in-progress AND completed generated-mock sitting is discarded —
--   both the resumable state and the graded-score history. No copyrighted-
--   corpus data is touched (topik_attempts/topik_responses are a completely
--   separate table family — see the up migration's header) and no
--   generated_items rows are affected (item_set only ever snapshots their
--   VALUES, never references them by FK).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

DROP TABLE IF EXISTS generated_mock_attempts;

-- End of 107_generated_mock_attempts.down.sql — runner owns the transaction
-- (ADR-013).
