-- 045 (down): reverse the F-083 hygiene cleanup — recreate the two bak-table
-- SHELLS, recreate the 6 dropped indexes.
--
-- BEST-EFFORT REVERSIBILITY (see the up header's "REVERSIBILITY" section):
--   * The 6 indexes are recreated exactly as originally defined (definitions
--     + COMMENTs copied verbatim from migrations 003/005/014/017) — this part
--     is a true inverse.
--   * The 2 bak tables come back as EMPTY shells. Their snapshot rows (the
--     pre-sweep explanation values) were discarded by the up and are NOT
--     restorable — each shell carries a COMMENT saying so. The shells exist
--     only so a down/up round-trip is structurally clean; column shape
--     reconstructed from db/docs/FIX_sweep_data.md /
--     FIX_followups_explanations.md ("id, original jsonb value, timestamp").
--     Deliberately NO PK / audit columns — mirroring the ad-hoc originals,
--     which never met the migration conventions (they were psql one-offs).
--
-- Order mirrors the up in reverse: bak shells first, then indexes.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- -----------------------------------------------------------------------------
-- 2'. Recreate the bak tables as empty shells (data NOT restorable).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topik_items_explanation_bak_20260706 (
    id           BIGINT,
    explanation  JSONB,
    backed_up_at TIMESTAMPTZ
);
COMMENT ON TABLE topik_items_explanation_bak_20260706 IS
    'EMPTY shell recreated by 045_hygiene_cleanup.down.sql. The original '
    'ad-hoc snapshot (45 pre-fix topik_items explanation values from the '
    '2026-07-06 sweep, db/docs/FIX_sweep_data.md) was dropped by 045 up and '
    'is NOT restorable. Shell exists only for structural down/up symmetry.';

CREATE TABLE IF NOT EXISTS topik_items_explanation_bak_followup (
    id           BIGINT,
    explanation  JSONB,
    backed_up_at TIMESTAMPTZ
);
COMMENT ON TABLE topik_items_explanation_bak_followup IS
    'EMPTY shell recreated by 045_hygiene_cleanup.down.sql. The original '
    'ad-hoc snapshot (8 pre-fix topik_items explanation values from the '
    'follow-up pass, db/docs/FIX_followups_explanations.md) was dropped by '
    '045 up and is NOT restorable. Shell exists only for structural down/up '
    'symmetry.';

-- -----------------------------------------------------------------------------
-- 1'. Recreate the 6 redundant indexes — definitions + COMMENTs verbatim from
--     the migrations that created them (014, 005, 017, 003).
-- -----------------------------------------------------------------------------

-- From 014_diagnostic_runs.up.sql
CREATE INDEX IF NOT EXISTS ix_diagnostic_responses_run_ordinal
    ON diagnostic_responses (run_id, ordinal);
COMMENT ON INDEX ix_diagnostic_responses_run_ordinal IS
    'Supports walking a run''s served items in order (answer-grading, '
    'finish-scoring, current-item lookup). (run_id, ordinal) matches the ORDER BY.';

-- From 005_lesson_podcast_topik.up.sql
CREATE INDEX IF NOT EXISTS ix_topik_items_test_number
    ON topik_items (topik_test_id, item_number);
COMMENT ON INDEX ix_topik_items_test_number IS
    'Mock-test reassembly: render items in original order per test.';

-- From 017_image_captures.up.sql
CREATE INDEX IF NOT EXISTS ix_image_words_capture
    ON image_words (capture_id, ordinal);
COMMENT ON INDEX ix_image_words_capture IS
    'Supports GET /images/:id — a capture''s words in detection order. '
    '(capture_id, ordinal) matches the ORDER BY.';

-- From 003_krdict.up.sql
CREATE INDEX IF NOT EXISTS ix_krdict_examples_sense
    ON krdict_examples (krdict_sense_id, example_index);
COMMENT ON INDEX ix_krdict_examples_sense IS
    'Composite B-tree. Query: fetch all examples for a sense in order.';

-- From 003_krdict.up.sql
CREATE INDEX IF NOT EXISTS ix_krdict_senses_entry
    ON krdict_senses (krdict_entry_id, sense_index);
COMMENT ON INDEX ix_krdict_senses_entry IS
    'Composite B-tree. Query: fetch all senses for an entry in display order '
    '(the "i" drawer). Also serves the natural-key lookup.';

-- From 003_krdict.up.sql
CREATE INDEX IF NOT EXISTS ix_krdict_inflections_entry
    ON krdict_inflections (krdict_entry_id, order_index);
COMMENT ON INDEX ix_krdict_inflections_entry IS
    'Composite B-tree. Query: render conjugation table for an entry in order.';

-- End of 045_hygiene_cleanup.down.sql
