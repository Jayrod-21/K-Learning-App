-- migrate: destructive
-- =============================================================================
-- Migration 096 — metered-spend cost columns (DOWN)
--   Drops `cost_estimate_usd` from `story_audio_jobs` and `story_image_jobs`
--   (the CHECK constraints go with their columns automatically). IF EXISTS on
--   both so a partial/repeated rollback is a no-op. Reverse of
--   096_metered_spend_cost.up.sql.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps the down body in a single transaction.
-- =============================================================================

ALTER TABLE story_audio_jobs DROP COLUMN IF EXISTS cost_estimate_usd;
ALTER TABLE story_image_jobs DROP COLUMN IF EXISTS cost_estimate_usd;

-- End of 096_metered_spend_cost.down.sql — runner owns the transaction (ADR-013).
