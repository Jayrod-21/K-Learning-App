-- =============================================================================
-- Migration 045 — schema hygiene cleanup (F-083)
--   UP — two independent hygiene fixes surfaced by the F-083 schema audit:
--        1. Drops 6 redundant non-unique indexes, each an exact duplicate of a
--           UNIQUE constraint's backing index on the same table (same columns,
--           same order). The UNIQUE index already serves every query the
--           duplicate served; the duplicate only added write amplification.
--        2. Drops 2 orphan ad-hoc backup tables created OUTSIDE the migration
--           runner during the 2026-07 explanation sweeps (see
--           db/docs/FIX_sweep_data.md and db/docs/FIX_followups_explanations.md):
--           `topik_items_explanation_bak_20260706` and
--           `topik_items_explanation_bak_followup`. Both sweeps are complete
--           and verified; the snapshots are superseded.
--   Reverse: 045_hygiene_cleanup.down.sql
--   Depends on: 003 (krdict_* tables), 005 (topik_items), 014
--               (diagnostic_responses), 017 (image_words).
--
--   SCOPE NOTE — the F-083 audit also proposed an FK from
--   `grammar_drill_attempts (user_id, pattern_key)` to
--   `grammar_entries (user_id, pattern_key)`. That item was DROPPED from this
--   migration: the audit finding was wrong. POST /grammar-drill inserts the
--   attempt row at GENERATION time, while the grammar_entries row is only
--   created at SUBMIT time (the auto-bank in the submit transaction — see
--   server/src/routes/grammarDrill.ts). An attempt for a not-yet-banked
--   pattern is therefore a LEGITIMATE state by design (migration 019/020),
--   not corruption — the FK would make the live drill route 500 on every
--   first drill of an unbanked pattern. The "~5 orphan rows" the audit found
--   were exactly this state.
--
-- DESTRUCTIVE — REQUIRES --allow-destructive ON UP:
--   This up body contains `DROP TABLE`, so migrate.py's destructive gate
--   (DESTRUCTIVE_PATTERNS) blocks a plain `up`. Apply with
--   `python -m db.migrate --allow-destructive up` — or, via the deploy
--   tooling, `run_migrate --allow-destructive up` (the scripted
--   local-standup.sh / azure-deploy-inactive.sh call `run_migrate up`
--   WITHOUT the flag and will abort on this migration; the release that
--   ships 045 needs a one-time flagged apply). This is the gate working as
--   designed, not an oversight: dropping the bak tables discards their
--   snapshot rows permanently.
--
-- REVERSIBILITY (documented losses — accepted by F-083):
--   * The two bak tables' DATA is NOT restorable. The down migration
--     recreates them as EMPTY shells (with a COMMENT saying so) purely so a
--     down/up round-trip is structurally clean. The snapshots they held were
--     working copies from completed, verified sweeps; the corrected values
--     live in `topik_items.extra` and the source JSONs.
--   * The 6 dropped indexes ARE fully restorable — the down recreates them
--     with their original definitions and COMMENTs verbatim.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Drop the 6 redundant indexes. Each duplicates the backing index of a
--    UNIQUE constraint on the same table with an identical column list, so
--    every query it supported is served (same plan shape) by the UNIQUE:
--
--      index dropped                        duplicate of UNIQUE constraint
--      ---------------------------------    ----------------------------------------
--      ix_diagnostic_responses_run_ordinal  uq_diagnostic_responses_run_ordinal (014)
--      ix_topik_items_test_number           uq_topik_items_test_number          (005)
--      ix_image_words_capture               uq_image_words_capture_ordinal      (017)
--      ix_krdict_examples_sense             uq_krdict_examples_sense_index      (003)
--      ix_krdict_senses_entry               uq_krdict_senses_entry_sense        (003)
--      ix_krdict_inflections_entry          uq_krdict_inflections_entry_order   (003)
--
--    (014 even said so in-file: "The UNIQUE constraint already provides the
--    (run_id, ordinal) B-tree" — the redundant CREATE INDEX slipped in anyway.)
--    DROP INDEX IF EXISTS keeps a manual re-apply a no-op.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS ix_diagnostic_responses_run_ordinal;
DROP INDEX IF EXISTS ix_topik_items_test_number;
DROP INDEX IF EXISTS ix_image_words_capture;
DROP INDEX IF EXISTS ix_krdict_examples_sense;
DROP INDEX IF EXISTS ix_krdict_senses_entry;
DROP INDEX IF EXISTS ix_krdict_inflections_entry;

-- -----------------------------------------------------------------------------
-- 2. Drop the 2 orphan backup tables (created ad-hoc via psql during the
--    explanation sweeps — no PK, no audit columns, never owned by the runner).
--    LOSSY: their snapshot rows are discarded (accepted — sweeps complete and
--    verified, corrected values live in topik_items.extra + source JSONs).
--    IF EXISTS is load-bearing here: these tables exist only on databases
--    where the sweeps ran, so a fresh-DB migration chain (CI testcontainers,
--    dev resets) must not error on their absence.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS topik_items_explanation_bak_20260706;
DROP TABLE IF EXISTS topik_items_explanation_bak_followup;

-- End of 045_hygiene_cleanup.up.sql — runner owns the transaction (ADR-013).
