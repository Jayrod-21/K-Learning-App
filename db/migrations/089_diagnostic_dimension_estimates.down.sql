-- 089 (down): drop diagnostic_runs.dimension_estimates.
--
-- HONEST DESTRUCTIVE-DOWN NOTE: dropping this column DISCARDS the live
-- per-section theta cache of every IN-PROGRESS run (a finished run's real,
-- durable per-dimension estimates already live in diagnostic_snapshots'
-- fixed columns + evidence.dimensionStats, written at /finish -- those are
-- NOT touched by this migration and are NOT lost). An in-progress run that
-- loses its cache does not corrupt or 500: the serving/stepping code's
-- contract (`dimension_estimates[section] ?? ability_estimate ?? SEED_THETA`)
-- treats a missing/empty cache as "no per-section evidence yet" and simply
-- re-warm-starts every dimension from the run's still-intact global
-- `ability_estimate` on its next item -- functionally equivalent to a run
-- that is still on each dimension's first item. The only real loss is
-- mid-run per-section DIVERGENCE that had already accumulated (e.g. a
-- weak-listening ladder that had drifted below the global theta) -- rolling
-- this back re-collapses every dimension back onto the shared global ladder,
-- i.e. reverts exactly to the pre-089 per-category behavior, which is the
-- intended effect of rolling back this feature.
--
-- migrate: destructive
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT -- migrate.py
-- wraps the body in a single transaction with the bookkeeping DELETE.

ALTER TABLE diagnostic_runs
    DROP CONSTRAINT IF EXISTS ck_diagnostic_runs_dimension_estimates_object;

ALTER TABLE diagnostic_runs
    DROP COLUMN IF EXISTS dimension_estimates;

-- End of 089_diagnostic_dimension_estimates.down.sql -- runner owns the transaction (ADR-013).
