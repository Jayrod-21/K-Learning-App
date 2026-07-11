-- 056 (up): widen the writing rubric taxonomy to include a free-write grade
-- (F-117).
--
-- 038 tagged writing_prompts.rubric and writing_attempts.rubric with a closed
-- two-value CHECK (topik_ii_53 / topik_ii_54) because the grader only ever
-- authored those two TOPIK II rubrics. F-073/F-101 later let a learner grade
-- a Claude-generated FREE-WRITE topic (mode='general', no TOPIK rubric), but
-- with no rubric of its own the client fell back to grading every free-write
-- against the Q54 essay rubric — an honest but ill-fitting stand-in (a free
-- write carries no 600-700자 length target and is not an argumentative
-- essay). This migration widens both CHECKs to accept a third value,
-- 'free_write', so the grader (server/src/services/claude/models.ts
-- TopikRubricSchema + the grade_writing prompt's own rubric text) can score
-- free-writes on their own real rubric instead of borrowing Q54's.
--
-- Additive/safe: widening a CHECK can never reject an existing row (mirrors
-- 027's kgiu_entries.pattern precedent, "Additive/safe: widening a CHECK can
-- never reject an existing row"). No data touched, no rename, no drop.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping write.

-- -----------------------------------------------------------------------------
-- 1. writing_prompts.rubric — allow the bank to (eventually) carry a
--    free_write-tagged curated prompt, same as the two TOPIK rubrics today.
-- -----------------------------------------------------------------------------
ALTER TABLE writing_prompts
    DROP CONSTRAINT IF EXISTS ck_writing_prompts_rubric;
ALTER TABLE writing_prompts
    ADD CONSTRAINT ck_writing_prompts_rubric
        CHECK (rubric IS NULL OR rubric IN ('topik_ii_53', 'topik_ii_54', 'free_write'));

COMMENT ON COLUMN writing_prompts.rubric IS
    'Writing rubric the prompt targets: topik_ii_53 (200-300자 description), '
    'topik_ii_54 (600-700자 argumentative essay), or free_write (open-topic, '
    'flexible length — added 056/F-117). NULL only on the retired pre-F-014 '
    'register-drill rows; every ACTIVE prompt is tagged so GET '
    '/writing/prompts and GET /plan/today draw from the same pool.';

-- -----------------------------------------------------------------------------
-- 2. writing_attempts.rubric — a persisted attempt may now record a
--    free_write grade (POST /grade-writing accepts the value as of F-117).
-- -----------------------------------------------------------------------------
ALTER TABLE writing_attempts
    DROP CONSTRAINT IF EXISTS ck_writing_attempts_rubric;
ALTER TABLE writing_attempts
    ADD CONSTRAINT ck_writing_attempts_rubric
        CHECK (rubric IN ('topik_ii_53', 'topik_ii_54', 'free_write'));

COMMENT ON COLUMN writing_attempts.rubric IS
    'Rubric the sample was graded against: topik_ii_53, topik_ii_54, or '
    'free_write (056/F-117 — a Claude-generated free-write graded on its own '
    'rubric instead of borrowing Q54''s).';

-- End of 056_writing_rubric_widen.up.sql — runner owns the transaction (ADR-013).
