-- 038 (up): writing_attempts + writing_prompts rubric tagging (F-014).
--
-- Feature: the Writing screen grades essays via a live Claude call but keeps
-- nothing — grading is stateless, and the screen's prompt list is HARDCODED in
-- the client (Writing.tsx WRITING_TASKS) while the Today tile advertises a
-- writing_prompts DB row the screen can never show. This migration closes both
-- gaps (DESIGN_F014 §"Data model"):
--
--   1. writing_prompts.rubric — tags a prompt as a TOPIK II Q53 (200-300자
--      description) or Q54 (600-700자 argumentative essay) task, the two
--      rubrics the grader accepts. The 8 legacy register-drill seed rows keep
--      rubric = NULL and are retired from the active pool below: they were
--      only ever the Today-tile label source and never matched the screen.
--      With every ACTIVE prompt rubric-tagged, GET /plan/today naturally
--      advertises a real Q53/Q54 prompt that GET /writing/prompts also serves.
--   2. Seed the six real TOPIK-style prompts ported verbatim from the
--      client's WRITING_TASKS list (3 × Q53, 3 × Q54), so the screen can drop
--      its hardcoded copy and fetch from the DB.
--   3. writing_attempts — one row per successful grade (persisted as a
--      side-effect of POST /grade-writing), feeding the F-017 Writing chart
--      (GET /writing/series) and a future history screen.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps the body in a single transaction with the bookkeeping write.

-- -----------------------------------------------------------------------------
-- 1. writing_prompts.rubric — which grader rubric the prompt targets
-- -----------------------------------------------------------------------------
ALTER TABLE writing_prompts
    ADD COLUMN IF NOT EXISTS rubric TEXT;

ALTER TABLE writing_prompts
    ADD CONSTRAINT ck_writing_prompts_rubric
        CHECK (rubric IS NULL OR rubric IN ('topik_ii_53', 'topik_ii_54'));

COMMENT ON COLUMN writing_prompts.rubric IS
    'TOPIK II writing rubric the prompt targets (topik_ii_53 = 200-300자 '
    'description, topik_ii_54 = 600-700자 argumentative essay). NULL only on '
    'the retired pre-F-014 register-drill rows; every ACTIVE prompt is tagged '
    'so GET /writing/prompts and GET /plan/today draw from the same pool.';

-- -----------------------------------------------------------------------------
-- 2. Retire the legacy register-drill rows from the active pool.
--    Reference data is never hard-deleted (013 design note) — the flip is
--    non-destructive and the down migration re-activates them. At this point
--    every existing row has rubric = NULL, so this targets exactly the 8
--    legacy seeds (plus any operator-added untagged rows, intentionally).
-- -----------------------------------------------------------------------------
UPDATE writing_prompts SET is_active = FALSE WHERE rubric IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Seed the real TOPIK II prompts, ported verbatim from the client's
--    Writing.tsx WRITING_TASKS (prompt_kr must stay within the 1..2000 bound
--    the /grade-writing edge enforces — the longest is ~140 chars).
--    Q53 targets TOPIK 3-4 writing, Q54 targets 5-6; both are answered in
--    formal written style (문어체). est_minutes mirror the official exam
--    budget (~15 min for Q53, ~30 for Q54). Idempotent via ON CONFLICT.
-- -----------------------------------------------------------------------------
INSERT INTO writing_prompts
    (source_id, title, prompt_kr, prompt_en, level, register, est_minutes, rubric)
VALUES
    ('wp-topik53-01',
     '스트레스 해소 방법 — TOPIK II 53번',
     '여러분은 스트레스를 받을 때 어떻게 해소합니까? 자신의 스트레스 해소 방법과 그 방법의 좋은 점을 200~300자로 쓰십시오.',
     'How do you relieve stress? Describe your method and its benefits in 200-300 characters.',
     'L3', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-02',
     '인터넷 쇼핑의 장단점 — TOPIK II 53번',
     '인터넷 쇼핑이 우리 생활에 주는 장점과 단점에 대해 200~300자로 쓰십시오.',
     'Write 200-300 characters on the advantages and disadvantages internet shopping brings to our lives.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik53-03',
     '살고 싶은 도시 — TOPIK II 53번',
     '여러분이 살고 싶은 도시는 어떤 곳입니까? 그 도시의 특징과 살고 싶은 이유를 200~300자로 쓰십시오.',
     'What kind of city would you like to live in? Describe its characteristics and your reasons in 200-300 characters.',
     'L4', '문어체', 15, 'topik_ii_53'),
    ('wp-topik54-01',
     '인공지능의 영향 — TOPIK II 54번',
     '현대 사회에서 인공지능의 발달이 우리 생활에 미치는 영향에 대해 자신의 생각을 600~700자로 논술하십시오. 다음 내용을 포함하십시오: 인공지능 발달의 장점은 무엇인가? 어떤 문제점이 있는가? 우리는 어떤 태도를 가져야 하는가?',
     'Write a 600-700-character essay on how the development of AI affects modern life: its advantages, its problems, and the attitude we should take toward it.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-02',
     '실패의 가치 — TOPIK II 54번',
     '''실패는 성공의 어머니''라는 말이 있습니다. 실패의 경험이 우리에게 중요한 이유에 대해 자신의 생각을 600~700자로 논술하십시오.',
     '"Failure is the mother of success." Write a 600-700-character essay on why the experience of failure matters to us.',
     'L5+', '문어체', 30, 'topik_ii_54'),
    ('wp-topik54-03',
     '환경 보호와 경제 발전 — TOPIK II 54번',
     '환경 보호와 경제 발전 중 무엇이 더 중요하다고 생각합니까? 자신의 의견을 근거와 함께 600~700자로 논술하십시오.',
     'Which matters more, environmental protection or economic growth? Argue your position with supporting reasons in 600-700 characters.',
     'L5+', '문어체', 30, 'topik_ii_54')
ON CONFLICT (source_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. writing_attempts — one row per successful grade (append-only history)
--
--    Written as a best-effort side-effect of POST /grade-writing: a persist
--    failure never fails the grade response (the Claude call already cost
--    money), so the route logs and continues. prompt_id is a soft link —
--    ON DELETE SET NULL so history survives prompt removal; prompt_kr
--    snapshots the actual graded prompt text regardless. Length CHECKs
--    mirror the /grade-writing zod bounds (prompt 1..2000, sample 1..5000)
--    so the DB is never stricter than the edge (grammar-Bank lesson: a
--    validation schema looser than the constraint behind it turns bad input
--    into a 500) nor looser than what the route can produce.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS writing_attempts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- Soft link to the bank row the learner picked (NULL when the client sent
    -- no promptId, or after the prompt row is ever hard-removed).
    prompt_id       BIGINT,
    -- Rubric the sample was graded against (mirrors the grader enum).
    rubric          TEXT        NOT NULL,
    -- Snapshot of the graded prompt text (survives bank edits/removal).
    prompt_kr       TEXT        NOT NULL,
    -- The learner's essay, verbatim.
    sample          TEXT        NOT NULL,
    -- Rubric totals: 30 for Q53, 50 for Q54 today — max_total is stored (not
    -- derived) so the series stays correct if the grader's denominators evolve.
    total_score     INTEGER     NOT NULL,
    max_total       INTEGER     NOT NULL,
    -- Grader's estimated TOPIK level (below_L3/L3/L4/L5/L6); free text so a
    -- grader vocabulary change is not a schema change.
    estimated_level TEXT,
    -- Full structured grade (content/organization/languageUse dimensions +
    -- overallComment) for a future history/review screen.
    result          JSONB       NOT NULL,
    -- When the grade happened (the series time axis).
    graded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Audit columns (ADR-001 §D6). updated_at maintained by the trigger below.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_writing_attempts_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_writing_attempts_prompt
        FOREIGN KEY (prompt_id) REFERENCES writing_prompts(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT ck_writing_attempts_rubric
        CHECK (rubric IN ('topik_ii_53', 'topik_ii_54')),
    CONSTRAINT ck_writing_attempts_prompt_kr_length
        CHECK (length(prompt_kr) BETWEEN 1 AND 2000),
    CONSTRAINT ck_writing_attempts_sample_length
        CHECK (length(sample) BETWEEN 1 AND 5000),
    CONSTRAINT ck_writing_attempts_max_total_positive
        CHECK (max_total > 0),
    CONSTRAINT ck_writing_attempts_total_in_range
        CHECK (total_score BETWEEN 0 AND max_total),
    CONSTRAINT ck_writing_attempts_result_object
        CHECK (jsonb_typeof(result) = 'object'),
    CONSTRAINT ck_writing_attempts_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE writing_attempts IS
    'Append-only log of graded writing samples (F-014). One row per successful '
    'POST /grade-writing; feeds GET /writing/series (F-017 Writing chart). '
    'Best-effort persist: a failed insert never fails the grade response.';

-- GET /writing/series scans the caller's recent attempts newest-first; the
-- composite index serves both the user filter and the graded_at range/order.
CREATE INDEX IF NOT EXISTS ix_writing_attempts_user_graded
    ON writing_attempts (user_id, graded_at DESC);

CREATE TRIGGER trg_writing_attempts_updated_at
    BEFORE UPDATE ON writing_attempts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
