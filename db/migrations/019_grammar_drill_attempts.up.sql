-- =============================================================================
-- Migration 019 — grammar production-drill attempts (Pass 9, Grammar drills)
--   UP — adds `grammar_drill_attempts`: one row per generated production drill,
--        updated in place when the learner submits an answer and Claude scores
--        it. Powers the Grammar screen's DrillPanel (transformation / cloze /
--        conversation) and drives the drill-type rotation (history lookup).
--   Reverse: 019_grammar_drill_attempts.down.sql
--   Depends on: 001_core_schema (users).
--
-- DESIGN NOTES (locked decision, 2026-05-30)
--   * ONE table, two-phase lifecycle: INSERT at generation time (item + type),
--     UPDATE at submit time (user_answer, score, verdict, feedback, scored_at).
--     The answer/score columns are NULLABLE precisely because they are absent
--     until the learner submits — `scored_at IS NULL` is the canonical
--     "unscored" predicate the route gates the single-shot scoring UPDATE on
--     (concurrent-double-submit defense, mirrors diagnostic_responses.answered_at
--     and vocab_cards optimistic UPDATE in migrations 014/001).
--   * `item` JSONB stores the FULL generated DrillItem INCLUDING the reference
--     model answer (referenceModelKr/En). This column is SERVER-ONLY: the
--     generation response strips the reference (answer-stripping, like
--     diagnostic_responses.item_payload's correct_answer/explain) and only
--     reveals it in the submit response after the learner has committed an
--     answer. Storing it lets the scorer pass the reference to Claude and lets
--     the submit response reveal it without a second generation.
--   * FSRS-production scheduling is DEFERRED (FU-NF-42): we persist attempts but
--     do NOT yet feed score → FSRS rating → production-face vocab_cards. No
--     coupling to vocab_cards/card_reviews this pass; that keeps this table a
--     standalone attempt log with no cross-table write on submit.
--   * CHECKs mirror the server Zod enums (DrillTypeSchema / DrillVerdictSchema /
--     0..100 score) so the DB is a backstop for the route's validation — a bug
--     that tried to persist an out-of-domain verdict or a 7000 score fails at the
--     write, not silently.
--   * Hard delete via the user FK CASCADE: an attempt is transient practice, not
--     durable history a future audit row references (unlike image_captures), so
--     no soft-delete column — deleting the user purges their attempts outright.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS grammar_drill_attempts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Canonical pattern key + display form the drill was generated for. Both are
    -- carried verbatim from the client's pattern list item (the drill source).
    pattern_key     TEXT        NOT NULL,
    pattern_display TEXT        NOT NULL,

    -- Which drill variant was generated. Chosen by the route's history-based
    -- rotation; CHECK-constrained to the three locked types.
    drill_type      TEXT        NOT NULL,

    -- The FULL generated DrillItem (incl. the reference model answer). SERVER-
    -- ONLY: stripped from the generation response, revealed only on submit.
    item            JSONB       NOT NULL,

    -- The learner's submitted answer. NULL until they submit.
    user_answer     TEXT,

    -- Claude's score for the submission: 0..100, NULL until scored.
    score           INT,

    -- Verdict bucket (excellent/good/needs_work/incorrect). NULL until scored.
    verdict         TEXT,

    -- Structured feedback {summary, usesPattern, corrections[]}. NULL until scored.
    feedback        JSONB,

    -- Audit columns. `created_at` = generation time; `scored_at` = submit time
    -- (NULL = not yet scored, the single-shot gating predicate).
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    scored_at       TIMESTAMPTZ,

    CONSTRAINT chk_gda_drill_type CHECK (drill_type IN ('transformation','cloze','conversation')),
    CONSTRAINT chk_gda_verdict    CHECK (verdict IS NULL OR verdict IN ('excellent','good','needs_work','incorrect')),
    CONSTRAINT chk_gda_score      CHECK (score IS NULL OR (score >= 0 AND score <= 100))
);

-- Query 1: "the last few attempts for (user, pattern), newest first" — the
-- drill-type rotation lookup (route reads <=3 most-recent to pick the
-- least-recently-used type). (user_id, pattern_key, created_at DESC) matches the
-- WHERE + ORDER BY exactly so the rotation read is an index-only-ish scan.
CREATE INDEX IF NOT EXISTS idx_gda_user_pattern_created
    ON grammar_drill_attempts (user_id, pattern_key, created_at DESC);

COMMENT ON TABLE grammar_drill_attempts IS 'Grammar production-drill attempts. One row per generated drill; updated on submit with the Claude score. History drives drill-type rotation. FSRS-production scheduling deferred (FU-NF-42).';
COMMENT ON COLUMN grammar_drill_attempts.item IS
    'Full generated DrillItem INCLUDING the reference model answer (referenceModelKr/En). Server-only: stripped from the generation response (answer-stripping), revealed only in the submit response after the learner commits an answer.';
COMMENT ON COLUMN grammar_drill_attempts.scored_at IS
    'Submit time. NULL = unscored — the single-shot gating predicate the submit route UPDATEs on (scored_at IS NULL) to reject a concurrent double-submit with rowCount 0 → 409.';
COMMENT ON INDEX idx_gda_user_pattern_created IS
    'Supports the drill-type rotation lookup — the <=3 most-recent attempts for (user_id, pattern_key), newest first.';

-- End of 019_grammar_drill_attempts.up.sql — runner owns the transaction (ADR-013).
