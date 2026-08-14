-- migrate: non-destructive
-- =============================================================================
-- Migration 084 — ability_evidence view (F-212 Phase 1, unified ability-
--                 evidence stream)
--   UP — creates `ability_evidence`, a READ-ONLY view that UNION ALLs the six
--        existing append-only graded logs into one normalized per-item
--        response history:
--          1. topik_responses      (joined to topik_items + topik_tests)
--          2. card_reviews         (joined to vocab_cards; hanja cards excluded)
--          3. grammar_drill_attempts (scored rows only)
--          4. writing_attempts     (LEFT JOIN writing_prompts)
--          5. hanja_attempts       (LEFT JOIN vocab_cards)
--          6. diagnostic_responses (joined to diagnostic_runs; answered only)
--        A Phase-2 IRT θ-estimator reads this as its response matrix.
--   Reverse: 084_ability_evidence_view.down.sql (DROP VIEW).
--   Depends on: 001 (card_reviews, vocab_cards, fsrs_rating, proficiency_level),
--               005 (topik_tests, topik_items), 014 (diagnostic_runs,
--               diagnostic_responses), 015 (topik_responses),
--               019 (grammar_drill_attempts), 013/038 (writing_prompts,
--               writing_attempts), 050 (vocab_cards.hanja_character_id),
--               059 (hanja_attempts).
--
-- DESIGN NOTES
--   * A VIEW, not a table (the F-212 architecture decision): zero feature
--     write-paths are touched, so every producing feature is provably
--     unchanged, and the six logs stay the single source of truth. The view
--     emits a NORMALIZED SHAPE plus the RAW per-source signal columns; the
--     outcome ∈ [0,1] and difficulty-b math live in the TS layer
--     (server/src/services/ability/) so those lossy mappings stay revisitable
--     in Phase 2 without a migration.
--   * Every leg emits the SAME 13 columns in the SAME order; absent signals
--     are cast NULLs (NULL::fsrs_rating etc.) so UNION ALL column types line
--     up exactly. Leg 1 pins the column names and types.
--   * Leg 2 (fsrs) EXCLUDES hanja-target cards (vc.hanja_character_id IS NOT
--     NULL): services/cardReview.ts dual-writes a hanja review into BOTH
--     card_reviews and hanja_attempts inside one transaction, and leg 5 owns
--     the hanja_attempts copy — without the exclusion the same review event
--     would count twice.
--   * Leg 2's item_key is leg-prefixed ('grammar:<id>' / 'vocab:<id>' /
--     'sentence:<id>' / 'topik:<id>') because vocab_cards is polymorphic
--     (XOR target, 001/050): the prefix keeps ids from different target
--     tables from colliding in one key space.
--   * Legs 3/6 filter to COMPLETED evidence only: an unscored drill row
--     (scored_at IS NULL — the generate half of 019's two-phase flow) and an
--     unanswered/served-only diagnostic item (answered_at IS NULL) are not
--     responses yet.
--   * Legs 4/5 use LEFT JOIN: writing_attempts.prompt_id and
--     hanja_attempts.card_id are soft SET-NULL links, and evidence history
--     must survive the referenced row's removal (the attempt row itself is
--     the durable fact; only its difficulty tag degrades to NULL).
--   * Per-user isolation follows the existing posture: every consumer (the
--     TS read API) filters WHERE user_id = <session user>, server-bound.
--
-- PERFORMANCE
--   Every leg's base table already carries a (user_id, <time> DESC) or
--   equivalent index from its own migration; the view adds no state of its
--   own. Phase 2 may add a materialization if the estimator needs one — that
--   is deliberately NOT done here.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the schema_migrations bookkeeping write.
-- =============================================================================

CREATE OR REPLACE VIEW ability_evidence AS
-- Leg 1: TOPIK prep answers (015). Pins the 13 column names + types.
SELECT
    tr.user_id                       AS user_id,             -- BIGINT
    ti.section::text                 AS dimension,           -- TEXT
    'topik'::text                    AS source,              -- TEXT
    tr.id                            AS source_id,           -- BIGINT
    ti.id::text                      AS item_key,            -- TEXT
    tr.answered_at                   AS occurred_at,         -- TIMESTAMPTZ
    tr.is_correct                    AS outcome_raw_correct, -- BOOLEAN
    NULL::fsrs_rating                AS outcome_raw_rating,
    NULL::int                        AS outcome_raw_score,
    NULL::int                        AS outcome_raw_max,
    NULL::numeric(3,2)               AS diff_served,
    tt.topik_level                   AS diff_topik_paper,    -- TEXT
    ti.proficiency                   AS diff_proficiency     -- proficiency_level
FROM topik_responses tr
JOIN topik_items ti ON ti.id = tr.topik_item_id
JOIN topik_tests tt ON tt.id = ti.topik_test_id

UNION ALL

-- Leg 2: FSRS card reviews (001), hanja cards excluded (owned by leg 5 —
-- cardReview.ts dual-writes hanja reviews to both logs).
SELECT
    cr.user_id,
    -- Sentence-/topik-target cards also land in ELSE → 'vocab' (only grammar is named); the leg-prefixed item_key below preserves the finer distinction.
    CASE WHEN vc.grammar_entry_id IS NOT NULL THEN 'grammar' ELSE 'vocab' END::text,
    'fsrs'::text,
    cr.id,
    CASE
        WHEN vc.grammar_entry_id   IS NOT NULL THEN 'grammar:'  || vc.grammar_entry_id
        WHEN vc.vocab_entry_id     IS NOT NULL THEN 'vocab:'    || vc.vocab_entry_id
        WHEN vc.source_sentence_id IS NOT NULL THEN 'sentence:' || vc.source_sentence_id
        WHEN vc.topik_item_id      IS NOT NULL THEN 'topik:'    || vc.topik_item_id
    END,
    cr.reviewed_at,
    NULL::boolean,
    cr.rating,
    NULL::int,
    NULL::int,
    NULL::numeric(3,2),
    NULL::text,
    vc.proficiency
FROM card_reviews cr
JOIN vocab_cards vc ON vc.id = cr.card_id
WHERE vc.hanja_character_id IS NULL

UNION ALL

-- Leg 3: scored grammar drills (019). Two-phase flow — only the scored half
-- is evidence. score is 0..100 (CHECK), so max is the constant 100.
SELECT
    gda.user_id,
    'grammar'::text,
    'grammar_drill'::text,
    gda.id,
    gda.pattern_key,
    gda.scored_at,
    NULL::boolean,
    NULL::fsrs_rating,
    gda.score,
    100::int,
    NULL::numeric(3,2),
    NULL::text,
    NULL::proficiency_level
FROM grammar_drill_attempts gda
WHERE gda.scored_at IS NOT NULL AND gda.score IS NOT NULL

UNION ALL

-- Leg 4: graded writing attempts (038). LEFT JOIN — prompt_id is a soft
-- SET-NULL link; the attempt (with its stored total/max) outlives the prompt.
SELECT
    wa.user_id,
    'writing'::text,
    'writing'::text,
    wa.id,
    wa.rubric,
    wa.graded_at,
    NULL::boolean,
    NULL::fsrs_rating,
    wa.total_score,
    wa.max_total,
    NULL::numeric(3,2),
    NULL::text,
    wp.level
FROM writing_attempts wa
LEFT JOIN writing_prompts wp ON wp.id = wa.prompt_id

UNION ALL

-- Leg 5: hanja reviews (059) — the OWNER of dual-written hanja evidence
-- (see leg 2's exclusion). LEFT JOIN — card_id is a soft SET-NULL link.
SELECT
    ha.user_id,
    'vocab'::text,
    'hanja'::text,
    ha.id,
    ha.char,
    ha.created_at,
    ha.correct,
    ha.rating,
    NULL::int,
    NULL::int,
    NULL::numeric(3,2),
    NULL::text,
    vc.proficiency
FROM hanja_attempts ha
LEFT JOIN vocab_cards vc ON vc.id = ha.card_id

UNION ALL

-- Leg 6: answered diagnostic items (014). Served-only rows are not evidence;
-- a skip HAS answered_at set (is_correct = FALSE) and correctly counts.
-- difficulty is the served-at difficulty on the 0–6 θ scale — the only leg
-- with a direct diff_served signal.
SELECT
    dr.user_id,
    dresp.section,
    'diagnostic'::text,
    dresp.id,
    dresp.source_ref,
    dresp.answered_at,
    dresp.is_correct,
    NULL::fsrs_rating,
    NULL::int,
    NULL::int,
    dresp.difficulty,
    NULL::text,
    NULL::proficiency_level
FROM diagnostic_responses dresp
JOIN diagnostic_runs dr ON dr.id = dresp.run_id
WHERE dresp.answered_at IS NOT NULL;

COMMENT ON VIEW ability_evidence IS
    'F-212 P1 — normalizing read-only view over the graded logs; foundation for the IRT theta estimator.';

-- End of 084_ability_evidence_view.up.sql — runner owns the transaction (ADR-013).
