-- =============================================================================
-- Migration 014 — Diagnostic runs + responses (DOWN)
--   Reverses 014_diagnostic_runs.up.sql.
--   Order: drop child (diagnostic_responses) before parent (diagnostic_runs)
--          so the child FK doesn't block.
--   Idempotent — every DROP is IF EXISTS.
--
-- DO NOT DROP (owned elsewhere):
--   - diagnostic_snapshots (migration 001) — runs only FK to it.
--   - users                (migration 001)
--   - set_updated_at()     trigger function (migration 001)
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops tables. `migrate.py` requires `--allow-destructive` to
-- run this down. Per migrations/README.md "Rolling back".
-- =============================================================================

DROP TABLE IF EXISTS diagnostic_responses;
DROP TABLE IF EXISTS diagnostic_runs;

-- End of 014_diagnostic_runs.down.sql.
