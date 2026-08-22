-- 089 (up): diagnostic_runs.dimension_estimates — per-section adaptive θ cache
-- (diagnostic-upgrade Phase C: PER-CATEGORY ladders).
--
-- Through v1.4.0 the diagnostic ran ONE global θ ladder (`ability_estimate`):
-- every dimension's items were served at the SAME shared difficulty, and a
-- jagged learner (strong reading, weak listening) got their weak dimension
-- mis-targeted because 4-6 items in a shared ramp can't correct for it. This
-- migration adds the storage the fix needs: a per-run, per-dimension θ CACHE
-- that survives the stateless /answer -> /next request boundary, so each
-- leveled dimension (reading/listening/vocab/grammar/writing) climbs its OWN
-- staircase, warm-started from the run's global θ on that dimension's first
-- item (server/src/routes/diagnostic.ts serveNextItem / POST /:runId/answer).
--
-- `dimension_estimates` is a SERVING CACHE, not a new source of truth:
--   * Keyed dimension -> theta (2dp numbers), e.g.
--     {"reading": 2.40, "listening": 1.85, "vocab": 3.10, "grammar": 2.90,
--      "writing": 2.10}. `hanja` is NEVER a key — it stays coverage-only,
--     served/scored off the GLOBAL theta exactly as before this migration
--     (see routes/diagnostic.ts's `section <> 'hanja'` guard, unchanged).
--   * The run's existing `ability_estimate` column is UNCHANGED in meaning: it
--     remains the OVERALL theta, still stepped on every non-hanja answer, still
--     the warm-start source for a dimension's first-ever item, and still the
--     sole input F-212's `ability_evidence` view / estimator read. This
--     migration adds a column ALONGSIDE it; nothing about `ability_estimate`'s
--     existing semantics changes.
--   * At /finish, a leveled dimension's final `dimension_estimates[dim]` value
--     becomes that dimension's snapshot estimate (the real adaptive readout),
--     replacing the old mean-difficulty+p heuristic for reading/listening/
--     vocab/grammar/writing; hanja keeps its existing coverage estimate.
--     (Pairs with RUBRIC_VERSION v1.4.0 -> v1.5.0,
--     server/src/services/diagnostic/scoring.ts.)
--
-- Why JSONB, not five more NUMERIC columns: the key set already varies (hanja
-- never appears; writing only appears once a run reaches its writing slot),
-- and a sparse per-dimension map that fills in as the run progresses is
-- exactly the "small, run-scoped, shape can evolve" case migrations/README.md
-- already documents JSONB for elsewhere in this table's sibling `evidence`
-- column (diagnostic_snapshots, migration 001). A `jsonb_typeof(...) = 'object'`
-- CHECK pins its shape at the DB layer the same way 038/064 pin their JSONB
-- payload columns to an object.
--
-- Additive/safe: `ADD COLUMN ... DEFAULT '{}'::jsonb` backfills every existing
-- row with the empty object (the "no per-section evidence yet" state a
-- brand-new run also starts in) — no existing row's `ability_estimate` or any
-- other column is touched.
--
-- migrate: non-destructive
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping write.

-- -----------------------------------------------------------------------------
-- diagnostic_runs.dimension_estimates — per-section theta serving cache
-- -----------------------------------------------------------------------------
ALTER TABLE diagnostic_runs
    ADD COLUMN IF NOT EXISTS dimension_estimates JSONB NOT NULL DEFAULT '{}'::jsonb;

-- DROP + ADD (not IF NOT EXISTS — Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS) makes a manual re-apply of this file idempotent, mirroring 087/088's
-- CHECK-widen convention.
ALTER TABLE diagnostic_runs
    DROP CONSTRAINT IF EXISTS ck_diagnostic_runs_dimension_estimates_object;
ALTER TABLE diagnostic_runs
    ADD CONSTRAINT ck_diagnostic_runs_dimension_estimates_object
        CHECK (jsonb_typeof(dimension_estimates) = 'object');

COMMENT ON COLUMN diagnostic_runs.dimension_estimates IS
    'Per-run, per-dimension adaptive theta SERVING CACHE (089, diagnostic-'
    'upgrade Phase C). Keyed dimension -> theta (0-6 scale, 2dp), e.g. '
    '{"reading": 2.40, "listening": 1.85}. Warm-started from ability_estimate '
    'on a dimension''s first item, then stepped independently thereafter '
    '(server/src/routes/diagnostic.ts). NEVER carries a ''hanja'' key -- hanja '
    'stays coverage-only, served/scored off the global ability_estimate. '
    'ability_estimate itself is UNCHANGED by this column: it remains the '
    'OVERALL theta, the warm-start source, and the sole F-212 evidence input.';
