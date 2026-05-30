-- =============================================================================
-- Migration 010 — canonical_grammar manual-override guard (Phase C fix-pass)
--   UP — adds `kgiu_entries.canonical_grammar_id_is_manual_override`, a
--        sentinel that lets reviewers manually re-point a kgiu row at a
--        polysemy-split canonical row without having the next `apply` run
--        of cluster_canonical_grammar.py clobber it.
--   Reverse: 010_canonical_grammar_manual_override.down.sql
--   Depends on: 006 (introduced canonical_grammar + the kgiu FK column).
--
-- WHY THIS EXISTS (REVIEW_C1 SHOULD-FIX-1):
--   ADR-021 documents the manual polysemy-split workflow:
--
--       INSERT INTO canonical_grammar (pattern_key, …)
--           VALUES ('(으)니까#discovery', …);
--       UPDATE kgiu_entries
--          SET canonical_grammar_id = (SELECT id FROM canonical_grammar
--                                       WHERE pattern_key = '(으)니까#discovery')
--        WHERE source_id = 'kgiu-beg-u20-02';
--
--   The reviewer is splitting one polysemous form into two canonical rows
--   and pointing the affected source row at the new one. But the kgiu
--   row still has `pattern_normalized = '(으)니까'`, so the next
--   `cluster_canonical_grammar.py apply` rebuilds the `(으)니까` cluster
--   with that row as a member, computes its AUTO canonical id (the
--   primary `(으)니까` row's id), sees that the row's current
--   `canonical_grammar_id` IS DISTINCT FROM the auto id, and overwrites.
--   The reviewer's split is silently undone and the row's `version` is
--   bumped on every re-apply.
--
--   The fix is a sentinel: when a reviewer manually re-points a row, they
--   also set `canonical_grammar_id_is_manual_override = TRUE`, and
--   `_backfill_kgiu_entries` skips rows with the sentinel set. Subsequent
--   re-apply runs are no-ops on those rows. To re-enable auto-backfill
--   (e.g., after deciding the split was wrong), clear the sentinel.
--
-- ADR alignment:
--   * ADR-001 §D6 (audit cols + version) — unchanged.
--   * ADR-001 §D8 — BOOLEAN with explicit DEFAULT FALSE / NOT NULL.
--   * ADR-013 — NO top-level BEGIN/COMMIT; runner owns the transaction.
--
-- COORDINATION:
--   * 006 owns the canonical_grammar table + the FK column.
--   * 010 (this file) only ADDS one column on kgiu_entries — no edits to
--     anything 006 created. Idempotent: `ADD COLUMN IF NOT EXISTS`.
--   * The down migration drops the column only.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. Add the override sentinel on kgiu_entries.
--    Defaults to FALSE; only a reviewer's manual UPDATE flips it to TRUE.
-- -----------------------------------------------------------------------------
ALTER TABLE kgiu_entries
    ADD COLUMN IF NOT EXISTS canonical_grammar_id_is_manual_override
        BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN kgiu_entries.canonical_grammar_id_is_manual_override IS
    'TRUE when a reviewer has manually re-pointed this row''s '
    'canonical_grammar_id to override the automatic cluster assignment '
    '(e.g., a polysemy split). Set to TRUE by the reviewer in the same '
    'transaction as the manual UPDATE to canonical_grammar_id. The '
    'cluster_canonical_grammar.py `apply` backfill skips rows where this '
    'is TRUE, preserving the override across re-runs. See REVIEW_C1 '
    'SHOULD-FIX-1 / ADR-021.';

-- A partial index isn't worth the storage — manual overrides are rare AND
-- the backfill UPDATE filters on this column unconditionally. A regular
-- secondary index would be more harm than help (most rows are FALSE).

-- End of 010_canonical_grammar_manual_override.up.sql — runner owns the tx (ADR-013).
