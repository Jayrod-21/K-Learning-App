-- 056 (up): widen the writing ATTEMPTS rubric taxonomy to include a
-- free-write grade (F-117).
--
-- 038 tagged writing_prompts.rubric and writing_attempts.rubric with a closed
-- two-value CHECK (topik_ii_53 / topik_ii_54) because the grader only ever
-- authored those two TOPIK II rubrics. F-073/F-101 later let a learner grade
-- a Claude-generated FREE-WRITE topic (mode='general', no TOPIK rubric), but
-- with no rubric of its own the client fell back to grading every free-write
-- against the Q54 essay rubric — an honest but ill-fitting stand-in (a free
-- write carries no 600-700자 length target and is not an argumentative
-- essay). This migration widens the writing_attempts CHECK to accept a third
-- value, 'free_write', so a graded free-write PERSISTS against its own real
-- rubric (server/src/services/claude/models.ts TopikRubricSchema + the
-- grade_writing prompt's own rubric text) instead of being written with a
-- borrowed Q54 tag.
--
-- writing_prompts.rubric is DELIBERATELY LEFT NARROW (topik_ii_53 /
-- topik_ii_54 only, fix-pass SF-1 / REVIEW_writing.md): a free-write topic is
-- Claude-GENERATED on demand (POST /writing/generate, mode='general'), never
-- a curated bank row — nothing inserts a free_write-tagged writing_prompts
-- row, and GET /writing/prompts / GET /writing/prompts/random both validate
-- `rubric` against the narrower two-value WritingRubricSchema (writing.ts),
-- which would reject a free_write filter at the boundary before a query
-- could ever reach one. Widening writing_prompts too would accept a schema
-- value no code path can ever produce or query — dead schema surface. If a
-- curated free-write bank ever ships, widen writing_prompts THEN, in its own
-- migration, alongside the route/query change that actually serves it.
--
-- Additive/safe: widening a CHECK can never reject an existing row (mirrors
-- 027's kgiu_entries.pattern precedent, "Additive/safe: widening a CHECK can
-- never reject an existing row"). No data touched, no rename, no drop.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping write.

-- -----------------------------------------------------------------------------
-- writing_attempts.rubric — a persisted attempt may now record a
-- free_write grade (POST /grade-writing accepts the value as of F-117).
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
