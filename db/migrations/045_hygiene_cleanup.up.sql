-- =============================================================================
-- Migration 045 — schema hygiene cleanup (F-083)
--   UP — three independent hygiene fixes surfaced by the F-083 schema audit:
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
--        3. Adds the missing FK from `grammar_drill_attempts (user_id,
--           pattern_key)` to `grammar_entries (user_id, pattern_key)` (target
--           UNIQUE: `uq_grammar_entries_user_pattern`, migration 001), after
--           first deleting the orphan attempt rows that would violate it
--           (audit found ~5 — drills generated for patterns later removed
--           from the user's bank).
--   Reverse: 045_hygiene_cleanup.down.sql
--   Depends on: 001 (grammar_entries + uq_grammar_entries_user_pattern),
--               003 (krdict_* tables), 005 (topik_items), 014
--               (diagnostic_responses), 017 (image_words), 019
--               (grammar_drill_attempts).
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
--   * The ~5 deleted orphan `grammar_drill_attempts` rows are NOT restorable.
--     They were unreachable practice attempts for patterns absent from the
--     user's grammar bank (transient practice data per migration 019's design
--     — no audit row ever references an attempt).
--   * The 6 dropped indexes ARE fully restorable — the down recreates them
--     with their original definitions and COMMENTs verbatim.
--
-- WHY THE FK (item 3): `grammar_drill_attempts.pattern_key` is carried
--   verbatim from the client's pattern-list item (019 design note). Nothing
--   at the DB level tied it to the user's actual grammar bank, so unbanking
--   a pattern stranded its attempts forever. The composite FK closes that:
--   ON DELETE CASCADE purges a pattern's attempts when it leaves the bank
--   (attempts are transient practice, same posture as the user CASCADE in
--   019), ON UPDATE RESTRICT matches the house FK convention. The existing
--   `idx_gda_user_pattern_created (user_id, pattern_key, created_at DESC)`
--   prefix-covers the referencing columns, so the CASCADE scan is indexed.
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

-- -----------------------------------------------------------------------------
-- 3. Tie grammar_drill_attempts to the grammar bank.
--    Guarded the same way 044/002 guard cross-table ADD CONSTRAINT (Postgres
--    has no `ADD CONSTRAINT IF NOT EXISTS`): a pg_constraint existence check
--    inside DO $$ ... $$. The orphan-row DELETE lives INSIDE the guard — if
--    the constraint already exists there can be no orphans, and a manual
--    re-apply skips both steps.
--
--    The DELETE must precede ADD CONSTRAINT: the audit found ~5 attempt rows
--    whose (user_id, pattern_key) no longer exists in grammar_entries, and
--    ADD CONSTRAINT validates existing rows. Deleting them is safe: with no
--    bank row, they are unreachable through the drill routes (the rotation
--    lookup and the Grammar screen both start from banked patterns) and 019
--    classifies attempts as transient practice with no audit value.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'fk_grammar_drill_attempts_entry') THEN
        -- Purge orphans that would fail the FK validation.
        DELETE FROM grammar_drill_attempts gda
         WHERE NOT EXISTS (SELECT 1
                             FROM grammar_entries ge
                            WHERE ge.user_id     = gda.user_id
                              AND ge.pattern_key = gda.pattern_key);

        ALTER TABLE grammar_drill_attempts
            ADD CONSTRAINT fk_grammar_drill_attempts_entry
            FOREIGN KEY (user_id, pattern_key)
            REFERENCES grammar_entries(user_id, pattern_key)
            ON DELETE CASCADE ON UPDATE RESTRICT;
    END IF;
END $$;

COMMENT ON CONSTRAINT fk_grammar_drill_attempts_entry ON grammar_drill_attempts IS
    'An attempt always belongs to a currently-banked pattern: (user_id, '
    'pattern_key) must exist in grammar_entries (target UNIQUE: '
    'uq_grammar_entries_user_pattern). CASCADE purges a pattern''s attempts '
    'when it leaves the bank — attempts are transient practice (see 019), '
    'never referenced by audit rows. Referencing-side scans are covered by '
    'the idx_gda_user_pattern_created prefix. Added by 045 (F-083) after '
    'deleting the pre-FK orphan rows.';

-- End of 045_hygiene_cleanup.up.sql — runner owns the transaction (ADR-013).
