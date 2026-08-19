-- migrate: non-destructive
-- =============================================================================
-- Migration 086 — reading comprehension checks (F-205 Phase 1)
--   UP — two pieces:
--          §1 claude_route gains 'reading_comprehension' — the Claude proxy
--             route that authors multiple-choice comprehension questions
--             from a chapter's prose (053/057/083's ADD VALUE posture;
--             server/tests/db/claude_route_enum.test.ts pins the enum ⇄
--             RouteName equivalence in both directions).
--          §2 reading_questions — the generated questions at rest: one row
--             per (chapter, question_number), a Korean question with exactly
--             4 {text, correct} options (JSONB) and a bilingual explanation.
--             Generate-once cache: rows are written by
--             POST /reading/chapters/:chapterId/questions/generate and read
--             back forever after at $0 (the F-209 claude_cache stance,
--             surfaced as first-class rows because the client renders them
--             as a quiz, not a blob).
--   Reverse: 086_reading_questions.down.sql
--   Depends on: 044_reading_chapters (reading_chapters — the parent),
--               004_claude_cache_and_usage (claude_route, claude_model),
--               001_core_schema (set_updated_at()).
--
-- WHY NO user_id (unlike reading_chapters, like reading_passages)
--   reading_passages (044) carries no denormalized owner: a passage is only
--   ever reached THROUGH an access-checked chapter, so its read stays scoped
--   by chapter_id and the CASCADE ties its lifetime to the chapter's.
--   Questions have the exact same access shape — the routes resolve
--   ownership/readability on the CHAPTER (join to reading_chapters +
--   book_uploads, uniform 404 on a miss) and only then touch this table by
--   chapter_id. Mirroring the passages pattern keeps one IDOR story for the
--   whole chapter subtree instead of a second denormalized owner to keep
--   consistent.
--
-- WHY options IS JSONB, NOT A CHILD TABLE
--   The option set is a fixed-arity value (exactly 4, exactly one correct),
--   never queried per-option and never updated in place — the generate route
--   writes whole questions atomically and the client consumes the whole
--   array (the TopikChoice {text, correct} shape its MC renderer already
--   understands). A child table would add a join and an ordering column for
--   zero query value. The writer (the proxy's Zod refine — the only code
--   path that ever produces rows) is still the PRIMARY authority for the
--   exactly-one-correct invariant, matching how 054 trusts StoryResultSchema
--   for turns, but unlike 054 this table ALSO pins array-ness, arity, each
--   element's {text, correct} shape, AND exactly-one-correct at the CHECK
--   layer (ck_reading_questions_options_shape,
--   ck_reading_questions_options_element_shape,
--   ck_reading_questions_options_exactly_one_correct below) — cheap,
--   self-contained (no cross-table reference), and real defense-in-depth
--   against a future SECOND writer (an admin backfill, a data-fix
--   migration) that bypasses the Zod layer entirely.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write. The ALTER TYPE
--   ADD VALUE in §1 is legal inside that transaction (PG 12+) because
--   nothing in this file USES the new enum value.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. claude_route: admit the F-205 comprehension-question route.
-- -----------------------------------------------------------------------------
ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'reading_comprehension';

-- -----------------------------------------------------------------------------
-- 2. reading_questions — one generated MC comprehension question per
--    (chapter, question_number). Written ONLY by the generate route (whole
--    sets, inside one transaction); read by
--    GET /reading/chapters/:chapterId/questions.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reading_questions (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chapter_id        BIGINT      NOT NULL,
    -- Display order within the chapter's check, 1-based.
    question_number   INTEGER     NOT NULL,
    -- The Korean question stem (누가/무엇을/어떻게/왜 — plot/detail
    -- comprehension over the chapter's prose).
    question_text     TEXT        NOT NULL,
    -- Exactly 4 answer options, each { "text": string, "correct": boolean } —
    -- the TopikChoice shape the client MC renderer consumes. Exactly ONE
    -- correct:true per question is the writer's contract (the proxy's Zod
    -- refine), pinned again below by CHECK (array-ness, arity, each
    -- element's shape, exactly-one-correct — defense-in-depth).
    options           JSONB       NOT NULL,
    -- Why the correct answer is correct (bilingual KO/EN), revealed on answer.
    explanation       TEXT        NOT NULL,
    -- Question kind. Closed to 'comprehension' today; the CHECK is the
    -- forward-compat seam for later kinds (discussion/short-answer phases).
    kind              TEXT        NOT NULL DEFAULT 'comprehension',
    -- Which Claude model generated this row (provenance; NULL for rows loaded
    -- by a pre-seed batch that didn't record it). claude_model (004) — the
    -- SAME closed-set enum claude_cache/claude_usage type their model
    -- columns as — because the only writer (reading.ts's generate route)
    -- passes the proxy's own resolveModel() result straight through, which
    -- is itself typed to that exact enum's value domain (services/claude/
    -- config.ts's ModelEnum); a free-form TEXT would admit a typo'd model
    -- id that every other Claude-serving table already fails loudly on.
    model             claude_model,

    -- Audit columns (migrations README "Conventions")
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INTEGER     NOT NULL DEFAULT 1,

    -- A question is meaningless without its chapter and re-derivable by
    -- re-generating (a paid Claude call) — CASCADE, exactly like passages.
    CONSTRAINT fk_reading_questions_chapter
        FOREIGN KEY (chapter_id) REFERENCES reading_chapters(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Generate-once, made structural: one question per (chapter, slot). The
    -- generate route's whole-set INSERT is the concurrency arbiter.
    CONSTRAINT uq_reading_questions_chapter_number
        UNIQUE (chapter_id, question_number),
    CONSTRAINT ck_reading_questions_number_positive
        CHECK (question_number > 0),
    CONSTRAINT ck_reading_questions_text_len
        CHECK (char_length(question_text) BETWEEN 1 AND 2000),
    -- Array-ness + arity: exactly 4 options, always. (jsonb_array_length
    -- raises on a non-array, so the typeof guard must come first. Postgres
    -- checks CHECK constraints in declaration order and stops at the first
    -- violation, so a non-array/wrong-arity `options` never reaches the two
    -- element-shape CHECKs below — same reasoning applies to them.)
    CONSTRAINT ck_reading_questions_options_shape
        CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4),
    -- Each option object carries the writer's exact {text, correct} shape:
    -- text a non-empty JSON string, correct a genuine JSON boolean. Written
    -- POSITIONALLY (options->0..3) rather than over jsonb_array_elements
    -- because a CHECK constraint may NOT contain a subquery (Postgres) — and
    -- the arity-4 guard above (checked first, in declaration order) makes the
    -- four fixed indices safe to reference. Every sub-check is COALESCEd to
    -- false on a missing/wrong-typed key so a NULL never sails through as
    -- "no opinion" (a CHECK passes on a NULL result); jsonb_typeof()/
    -- char_length() never raise on a wrong type, so a malformed element can
    -- only ever surface as a clean CHECK violation.
    CONSTRAINT ck_reading_questions_options_element_shape
        CHECK (
          COALESCE(jsonb_typeof(options->0->'text') = 'string', false)
          AND COALESCE(char_length(options->0->>'text') > 0, false)
          AND COALESCE(jsonb_typeof(options->0->'correct') = 'boolean', false)
          AND COALESCE(jsonb_typeof(options->1->'text') = 'string', false)
          AND COALESCE(char_length(options->1->>'text') > 0, false)
          AND COALESCE(jsonb_typeof(options->1->'correct') = 'boolean', false)
          AND COALESCE(jsonb_typeof(options->2->'text') = 'string', false)
          AND COALESCE(char_length(options->2->>'text') > 0, false)
          AND COALESCE(jsonb_typeof(options->2->'correct') = 'boolean', false)
          AND COALESCE(jsonb_typeof(options->3->'text') = 'string', false)
          AND COALESCE(char_length(options->3->>'text') > 0, false)
          AND COALESCE(jsonb_typeof(options->3->'correct') = 'boolean', false)
        ),
    -- Exactly one option is correct — the writer's contract (the proxy's Zod
    -- .refine); pinned here too as defense-in-depth (see "WHY options IS
    -- JSONB" above). POSITIONAL sum (options->0..3, arity-4-safe as above)
    -- because a CHECK may not contain a subquery; each term COALESCEd to 0 so
    -- a missing/non-boolean 'correct' counts as not-set rather than NULLing
    -- the whole sum (a NULL sum would PASS the CHECK). Exactly one true → 1.
    CONSTRAINT ck_reading_questions_options_exactly_one_correct
        CHECK (
          COALESCE((options->0->'correct' = 'true'::jsonb)::int, 0)
          + COALESCE((options->1->'correct' = 'true'::jsonb)::int, 0)
          + COALESCE((options->2->'correct' = 'true'::jsonb)::int, 0)
          + COALESCE((options->3->'correct' = 'true'::jsonb)::int, 0)
          = 1
        ),
    CONSTRAINT ck_reading_questions_explanation_len
        CHECK (char_length(explanation) BETWEEN 1 AND 4000),
    CONSTRAINT ck_reading_questions_kind
        CHECK (kind IN ('comprehension')),
    CONSTRAINT ck_reading_questions_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE reading_questions IS
    'F-205 AI-generated multiple-choice comprehension checks for reading '
    'chapters: one row per (chapter, question_number), written as a whole '
    'set by POST /reading/chapters/:chapterId/questions/generate (Claude '
    'proxy route ''reading_comprehension'', Zod-validated) and read back by '
    'the GET sibling. No user_id — access is resolved through the parent '
    'chapter (reading_passages'' exact posture); CASCADEs with it. '
    'Generate-once is structural (UNIQUE (chapter_id, question_number)); '
    'regenerate replaces the set inside one transaction.';
COMMENT ON COLUMN reading_questions.options IS
    'Exactly 4 answer options as a JSONB array of { "text": string, '
    '"correct": boolean } — the TopikChoice shape the client MC renderer '
    'consumes. Exactly one correct:true per question is the writer''s '
    'contract (the proxy''s Zod refine — the only code path that produces '
    'rows); the table CHECKs pin array-ness, arity, each element''s shape, '
    'AND exactly-one-correct as defense-in-depth behind the Zod refine.';
COMMENT ON COLUMN reading_questions.kind IS
    'Question kind — ''comprehension'' only today. The CHECK is the '
    'forward-compat seam for later F-205 phases (discussion/short-answer).';
COMMENT ON COLUMN reading_questions.model IS
    'Claude model id that generated this row (provenance/observability) — '
    'the same closed-set claude_model enum (004) claude_cache/claude_usage '
    'type their model columns as. NULL when a loader didn''t record it.';

CREATE OR REPLACE TRIGGER trg_reading_questions_updated_at
    BEFORE UPDATE ON reading_questions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 086_reading_questions.up.sql — runner owns the transaction (ADR-013).
