-- =============================================================================
-- Migration 013 — Writing prompt bank (Pass 4, Today screen "Writing" task)
--   UP — adds `writing_prompts`, a small curated reference bank that the
--        `GET /plan/today` endpoint draws the daily Writing task from, and
--        that the Pass-8 Writing screen will expand into a full drill flow.
--   Reverse: 013_writing_prompts.down.sql
--   Depends on: 001_core_schema (proficiency_level enum, set_updated_at()).
--
-- WHY A TABLE (not inline route literals):
--   CLAUDE_DESIGN_INTEGRATION_PLAN § Pass 4 offers two options for the Writing
--   branch — "introduces `writing_prompts` table OR seeds inline". We take the
--   table: it is testable in isolation, it lets the band-weighted /plan/today
--   selection use the same SQL shape as reading/listening, and it gives the
--   future Writing screen real rows to grow rubric metadata onto instead of a
--   migration that has to lift literals out of route code.
--
-- DATA CLASS — REFERENCE DATA (not user state):
--   Rows are a shared, curated bank (like ttmik_lessons / vocab_entries), NOT
--   per-user. There is therefore no user_id FK and no soft-delete column;
--   retirement is a non-destructive `is_active = FALSE` flip so a prompt that
--   has already been surfaced in someone's history is never hard-deleted out
--   from under an audit/log row a later pass may add.
--
-- DESIGN NOTES
--   * `level` reuses the `proficiency_level` enum so band-matching against a
--     diagnostic snapshot's writing estimate is a direct comparison, no
--     bespoke scale. ('basic' / 'L3' / 'L4' / 'L5+'.)
--   * `register` is a free-text Korean speech-level label ('합쇼체', '해요체',
--     …) rather than an enum — the design's register drills are open-ended and
--     we would rather grow the set in seed data than via ALTER TYPE.
--   * `est_minutes` is authored per prompt (writing time is a property of the
--     task, unlike reading/listening where /plan/today derives minutes from
--     sentence counts). CHECK keeps it a sane 1–120.
--   * `prompt_kr` holds the full Korean prompt the Writing screen will render;
--     `title` is the short card label /plan/today returns as TodayTask.title.
--     Both are NOT NULL so a prompt is never half-authored.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. writing_prompts — curated prompt bank
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS writing_prompts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Stable author-assigned id (e.g. 'wp-l4-register-01'). UNIQUE so re-running
    -- the seed below is a no-op (ON CONFLICT (source_id) DO NOTHING).
    source_id       TEXT        NOT NULL,

    -- Short card label shown on the Today screen task tile.
    title           TEXT        NOT NULL,
    -- Full Korean prompt body the Writing screen will render (forward-compat).
    prompt_kr       TEXT        NOT NULL,
    -- English gloss / instruction for the prompt.
    prompt_en       TEXT        NOT NULL,

    -- TOPIK-aligned difficulty band — same enum the diagnostic snapshot maps to.
    level           proficiency_level NOT NULL DEFAULT 'L4',
    -- Korean speech-level the drill targets ('합쇼체', '해요체', …). NULL = any.
    register        TEXT,
    -- Authored writing time in minutes; drives TodayTask.mins for this branch.
    est_minutes     INTEGER     NOT NULL DEFAULT 8,

    -- Non-destructive retirement flag (reference data is never hard-deleted).
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,

    -- Audit columns (ADR-001 D6)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT uq_writing_prompts_source_id
        UNIQUE (source_id),
    CONSTRAINT ck_writing_prompts_title_length
        CHECK (length(title) BETWEEN 1 AND 200),
    CONSTRAINT ck_writing_prompts_prompt_kr_length
        CHECK (length(prompt_kr) BETWEEN 1 AND 2000),
    CONSTRAINT ck_writing_prompts_prompt_en_length
        CHECK (length(prompt_en) BETWEEN 1 AND 2000),
    CONSTRAINT ck_writing_prompts_register_length
        CHECK (register IS NULL OR length(register) BETWEEN 1 AND 40),
    CONSTRAINT ck_writing_prompts_est_minutes_range
        CHECK (est_minutes BETWEEN 1 AND 120),
    CONSTRAINT ck_writing_prompts_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE writing_prompts IS
    'Curated reference bank of writing prompts. Powers the Today screen Writing '
    'task (GET /plan/today) and the Pass-8 Writing drill flow. Shared (not '
    'per-user); retired via is_active=FALSE, never hard-deleted.';
COMMENT ON COLUMN writing_prompts.source_id IS
    'Stable author-assigned id. UNIQUE so seed re-runs are idempotent.';
COMMENT ON COLUMN writing_prompts.title IS
    'Short card label returned as TodayTask.title (1–200 chars).';
COMMENT ON COLUMN writing_prompts.level IS
    'TOPIK-aligned band (proficiency_level enum). /plan/today prefers a prompt '
    'whose band matches the user''s weakest skill before falling back.';
COMMENT ON COLUMN writing_prompts.register IS
    'Korean speech-level the drill targets (합쇼체 / 해요체 / …). NULL = any.';
COMMENT ON COLUMN writing_prompts.est_minutes IS
    'Authored writing time in minutes; drives TodayTask.mins for this branch.';
COMMENT ON COLUMN writing_prompts.is_active IS
    'Non-destructive retirement flag. Selection queries filter is_active = TRUE.';

-- Selection query: "an active prompt, optionally band-matched, deterministic
-- per (user, day)". The band filter reads `level`; `is_active` gates every
-- read. Partial index on the live set keeps the hot path tight as the bank
-- grows.
CREATE INDEX IF NOT EXISTS ix_writing_prompts_active_level
    ON writing_prompts (level)
    WHERE is_active;
COMMENT ON INDEX ix_writing_prompts_active_level IS
    'Supports GET /plan/today Writing selection: filter to active prompts, '
    'prefer a level band. Partial on is_active because retired prompts are '
    'never selected.';

CREATE OR REPLACE TRIGGER trg_writing_prompts_updated_at
    BEFORE UPDATE ON writing_prompts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Seed — a small starter bank spanning L3/L4/L5+ and registers.
--    Idempotent: ON CONFLICT (source_id) DO NOTHING so re-applying (or applying
--    after a partial failure) never duplicates or errors.
-- -----------------------------------------------------------------------------
INSERT INTO writing_prompts (source_id, title, prompt_kr, prompt_en, level, register, est_minutes)
VALUES
    ('wp-l3-daily-01',
     '하루 일과 소개 — 해요체',
     '여러분의 하루 일과를 해요체로 소개하는 글을 한 문단으로 써 보세요. 아침부터 저녁까지 순서대로 쓰세요.',
     'Describe your daily routine in one paragraph using 해요체, from morning to evening in order.',
     'L3', '해요체', 6),
    ('wp-l3-opinion-01',
     '주말 계획 설명 — 해요체',
     '이번 주말에 무엇을 할 계획인지, 왜 그것을 하고 싶은지 해요체로 설명해 보세요.',
     'Explain your plans for this weekend and why you want to do them, in 해요체.',
     'L3', '해요체', 6),
    ('wp-l4-register-01',
     '재택근무 옹호 — 합쇼체',
     '재택근무의 장점을 근거를 들어 합쇼체로 한 문단 작성하세요. 격식체 어미를 일관되게 사용하세요.',
     'Defend remote work in one paragraph in 합쇼체, citing reasons. Keep the formal register consistent.',
     'L4', '합쇼체', 8),
    ('wp-l4-contrast-01',
     '도시와 시골 비교 — 합쇼체',
     '도시 생활과 시골 생활을 비교하여 각각의 장단점을 합쇼체로 서술하세요.',
     'Compare city and rural life, describing the pros and cons of each, in 합쇼체.',
     'L4', '합쇼체', 9),
    ('wp-l4-argue-01',
     '환경 정책 주장 — 합쇼체',
     '일회용품 사용 제한 정책에 대한 자신의 입장을 한 문단으로 합쇼체로 주장하세요.',
     'Argue your position on single-use-item restriction policy in one paragraph, in 합쇼체.',
     'L4', '합쇼체', 9),
    ('wp-l5-analysis-01',
     '기술 발전의 영향 분석 — 문어체',
     '기술 발전이 사회에 미친 긍정적·부정적 영향을 분석하는 글을 문어체로 작성하세요.',
     'Write an analytical essay in literary/written register on the positive and negative social impacts of technological progress.',
     'L5+', '문어체', 12),
    ('wp-l5-proposal-01',
     '정책 제안 — 문어체',
     '청년 실업 문제를 해결하기 위한 정책을 제안하고 그 근거를 문어체로 논리적으로 서술하세요.',
     'Propose a policy to address youth unemployment and justify it logically in written register.',
     'L5+', '문어체', 12),
    ('wp-l3-letter-01',
     '친구에게 편지 — 해요체',
     '오랜만에 친구에게 안부를 묻는 짧은 편지를 써 보세요. 자연스러운 종결어미를 사용하세요.',
     'Write a short letter checking in on a friend you have not seen in a while, using natural sentence endings.',
     'L3', '해요체', 7)
ON CONFLICT (source_id) DO NOTHING;

-- End of 013_writing_prompts.up.sql — runner owns the transaction (ADR-013).
