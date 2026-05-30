-- =============================================================================
-- Migration 005 — Lesson / Podcast / TOPIK corpora (B3 scope)
-- =============================================================================
-- Owner:        Agent B3 (server + loaders)
-- Target:       PostgreSQL 16+
-- Depends on:   001 (enums proficiency_level, corpus, topik_section, book_level;
--                    set_updated_at function), 002 (corpus_sources table).
-- Depends on:   001 (foundation), 002 (corpus_sources), 003 (krdict — for
--               numbering; no FK), 004 (claude cache — for numbering; no FK)
-- Scope:        Reference-data tables for the three corpus families that
--               migration 002 explicitly left to later phases:
--                 * TTMIK lesson series (ttmik)
--                 * TTMIK Iyagi podcast (iyagi)
--                 * TOPIK item pool (topik) — one pool, two assembly modes
--                   (mock-test vs random study) per DESIGN_SPEC.
--
-- Naming alignment with the rest of the schema:
--   - corpus_source_id FK → corpus_sources(id) per A2's contract
--   - corpus enum tag denormalized in each row for partial-index reach
--   - UNIQUE (corpus, source_id) natural key (loader-driven upsert anchor)
--   - audit columns + updated_at trigger per ADR-001 §D6
--
-- Out of scope (other migrations):
--   * 003 KRDICT (B2)
--   * Per-user state (already in 001)
--   * KGIU / Vocab-2000 (002)
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   migrate.py wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Enums new to this migration.
-- -----------------------------------------------------------------------------
-- topik_item_type — discriminator for the polymorphic stem shapes.
-- Lifted from a recurring source-JSON field; closed set.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topik_item_type') THEN
        CREATE TYPE topik_item_type AS ENUM (
            'multiple_choice',
            'short_answer_blanks',
            'chart_description',
            'essay'
        );
    END IF;
END $$;

COMMENT ON TYPE topik_item_type IS
    'TOPIK question shape. multiple_choice covers reading and listening MCQ; '
    'short_answer_blanks = ㉠/㉡ fill-ins (writing #51-52); chart_description '
    '= 200-300-char paragraph from a chart (writing #53); essay = the long '
    'argumentative essay (writing #54).';


-- -----------------------------------------------------------------------------
-- 2. ttmik_lessons — TTMIK lesson series source.
--    One row per (level, lesson) pair. Sentences live in ttmik_sentences.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ttmik_lessons (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    corpus_source_id  BIGINT       NOT NULL,
    corpus            corpus       NOT NULL DEFAULT 'ttmik',
    source_id         TEXT         NOT NULL,  -- e.g. "ttmik-L1-01"

    book_level        book_level,             -- nullable: TTMIK PDFs span levels
    lesson_level      INTEGER      NOT NULL,  -- TTMIK pedagogical level 1..N
    lesson_number     INTEGER      NOT NULL,  -- lesson # within the level
    ordinal           INTEGER      NOT NULL,  -- ordering within the JSON file

    title             TEXT,

    -- Audit (ADR-001 §D6)
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_ttmik_lessons_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT uq_ttmik_lessons_corpus_source_id UNIQUE (corpus, source_id),
    CONSTRAINT uq_ttmik_lessons_level_lesson     UNIQUE (lesson_level, lesson_number),

    CONSTRAINT ck_ttmik_lessons_corpus_pinned    CHECK (corpus = 'ttmik'),
    CONSTRAINT ck_ttmik_lessons_lesson_level_pos CHECK (lesson_level >= 1),
    CONSTRAINT ck_ttmik_lessons_lesson_number_pos CHECK (lesson_number >= 1),
    CONSTRAINT ck_ttmik_lessons_ordinal_pos      CHECK (ordinal >= 1)
);

COMMENT ON TABLE ttmik_lessons IS
    'TTMIK lesson units (one row per lesson). Sentences live in ttmik_sentences. '
    'Reference data sourced from tools/ingest/output/ttmik_*.json.';
COMMENT ON COLUMN ttmik_lessons.source_id     IS 'Stable id from source JSON. UNIQUE per corpus.';
COMMENT ON COLUMN ttmik_lessons.lesson_level  IS 'TTMIK pedagogical level number (their own 1..10 scale).';
COMMENT ON COLUMN ttmik_lessons.lesson_number IS 'Lesson number within the level.';
COMMENT ON COLUMN ttmik_lessons.ordinal       IS 'Ordering as it appears in the source JSON.';

DROP TRIGGER IF EXISTS trg_ttmik_lessons_updated_at ON ttmik_lessons;
CREATE TRIGGER trg_ttmik_lessons_updated_at
    BEFORE UPDATE ON ttmik_lessons
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_ttmik_lessons_corpus_source
    ON ttmik_lessons (corpus_source_id);
COMMENT ON INDEX ix_ttmik_lessons_corpus_source IS
    'Supports "list every lesson in source X" (loader resume / admin views).';


-- -----------------------------------------------------------------------------
-- 3. ttmik_sentences — sentence rows for TTMIK lessons.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ttmik_sentences (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    lesson_id         BIGINT       NOT NULL,
    ordinal           INTEGER      NOT NULL,

    korean            TEXT         NOT NULL,
    english           TEXT,
    romanization      TEXT,
    speaker           TEXT,
    is_dialog         BOOLEAN      NOT NULL DEFAULT FALSE,

    -- SHA-256 of the row content; stable natural key for upsert idempotency.
    content_hash      TEXT         NOT NULL,

    search_tsv        TSVECTOR,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_ttmik_sentences_lesson
        FOREIGN KEY (lesson_id) REFERENCES ttmik_lessons(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    -- Natural key for upsert. The content_hash is what makes the loader
    -- idempotent across re-runs of the same source JSON.
    CONSTRAINT uq_ttmik_sentences_lesson_hash UNIQUE (lesson_id, content_hash),

    CONSTRAINT ck_ttmik_sentences_korean_nonempty CHECK (length(korean) >= 1),
    CONSTRAINT ck_ttmik_sentences_content_hash_shape
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ttmik_sentences_ordinal_pos CHECK (ordinal >= 1)
);

COMMENT ON TABLE ttmik_sentences IS
    'Sentence rows from TTMIK lessons. Natural key (lesson_id, content_hash) '
    'is the loader''s upsert anchor.';
COMMENT ON COLUMN ttmik_sentences.content_hash IS
    'SHA-256 hex of the source-JSON sentence body. CHECK enforces 64 lowercase hex.';
COMMENT ON COLUMN ttmik_sentences.search_tsv IS
    'Maintained by trg_ttmik_sentences_tsv. Config simple per ADR-006 — Kiwi '
    'tokenizing is a Phase-B upgrade.';

CREATE OR REPLACE FUNCTION ttmik_sentences_tsv_refresh()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', coalesce(NEW.korean, '')),  'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.english, '')), 'B');
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION ttmik_sentences_tsv_refresh() IS
    'Mechanical tsvector maintenance for ttmik_sentences (ADR-001 §D12 '
    'permits search-index maintenance triggers). Config simple, ADR-006.';

DROP TRIGGER IF EXISTS trg_ttmik_sentences_tsv ON ttmik_sentences;
CREATE TRIGGER trg_ttmik_sentences_tsv
    BEFORE INSERT OR UPDATE OF korean, english
    ON ttmik_sentences
    FOR EACH ROW EXECUTE FUNCTION ttmik_sentences_tsv_refresh();

DROP TRIGGER IF EXISTS trg_ttmik_sentences_updated_at ON ttmik_sentences;
CREATE TRIGGER trg_ttmik_sentences_updated_at
    BEFORE UPDATE ON ttmik_sentences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_ttmik_sentences_search_tsv
    ON ttmik_sentences USING GIN (search_tsv);
COMMENT ON INDEX ix_ttmik_sentences_search_tsv IS
    'GIN over search_tsv. Query: full-text sentence lookup in tap-a-word/'
    '"have I seen this phrase" flows.';

CREATE INDEX IF NOT EXISTS ix_ttmik_sentences_lesson_ordinal
    ON ttmik_sentences (lesson_id, ordinal);
COMMENT ON INDEX ix_ttmik_sentences_lesson_ordinal IS
    'Render a lesson''s sentences in order (Reading view, study queue).';


-- -----------------------------------------------------------------------------
-- 4. iyagi_episodes — TTMIK Iyagi podcast episodes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS iyagi_episodes (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    corpus_source_id  BIGINT       NOT NULL,
    corpus            corpus       NOT NULL DEFAULT 'iyagi',
    source_id         TEXT         NOT NULL,  -- e.g. "iyagi-001"

    episode_number    INTEGER      NOT NULL,
    ordinal           INTEGER      NOT NULL,
    title             TEXT,
    hosts             TEXT,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_iyagi_episodes_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT uq_iyagi_episodes_corpus_source_id UNIQUE (corpus, source_id),
    CONSTRAINT uq_iyagi_episodes_number           UNIQUE (episode_number),

    CONSTRAINT ck_iyagi_episodes_corpus_pinned    CHECK (corpus = 'iyagi'),
    CONSTRAINT ck_iyagi_episodes_number_pos       CHECK (episode_number >= 1)
);

COMMENT ON TABLE iyagi_episodes IS
    'TTMIK Iyagi (이야기) podcast episodes. Transcript sentences live in '
    'iyagi_sentences. Reference data only — user state (listened-to, etc.) '
    'lives in study_log per ADR-001 §D7.';

DROP TRIGGER IF EXISTS trg_iyagi_episodes_updated_at ON iyagi_episodes;
CREATE TRIGGER trg_iyagi_episodes_updated_at
    BEFORE UPDATE ON iyagi_episodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. iyagi_sentences — sentence rows from Iyagi podcasts.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS iyagi_sentences (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    episode_id        BIGINT       NOT NULL,
    ordinal           INTEGER      NOT NULL,

    speaker           TEXT,
    korean            TEXT         NOT NULL,
    english           TEXT,
    romanization      TEXT,
    is_dialog         BOOLEAN      NOT NULL DEFAULT TRUE,

    content_hash      TEXT         NOT NULL,

    search_tsv        TSVECTOR,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_iyagi_sentences_episode
        FOREIGN KEY (episode_id) REFERENCES iyagi_episodes(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT uq_iyagi_sentences_episode_hash UNIQUE (episode_id, content_hash),
    CONSTRAINT ck_iyagi_sentences_korean_nonempty CHECK (length(korean) >= 1),
    CONSTRAINT ck_iyagi_sentences_content_hash_shape
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_iyagi_sentences_ordinal_pos CHECK (ordinal >= 1)
);

COMMENT ON TABLE iyagi_sentences IS
    'Transcribed Iyagi podcast sentences. Natural key (episode_id, content_hash) '
    'is the loader''s upsert anchor.';

CREATE OR REPLACE FUNCTION iyagi_sentences_tsv_refresh()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', coalesce(NEW.korean, '')),  'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.english, '')), 'B');
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_iyagi_sentences_tsv ON iyagi_sentences;
CREATE TRIGGER trg_iyagi_sentences_tsv
    BEFORE INSERT OR UPDATE OF korean, english
    ON iyagi_sentences
    FOR EACH ROW EXECUTE FUNCTION iyagi_sentences_tsv_refresh();

DROP TRIGGER IF EXISTS trg_iyagi_sentences_updated_at ON iyagi_sentences;
CREATE TRIGGER trg_iyagi_sentences_updated_at
    BEFORE UPDATE ON iyagi_sentences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_iyagi_sentences_search_tsv
    ON iyagi_sentences USING GIN (search_tsv);
COMMENT ON INDEX ix_iyagi_sentences_search_tsv IS
    'GIN search_tsv — listening transcript lookup.';

CREATE INDEX IF NOT EXISTS ix_iyagi_sentences_episode_ordinal
    ON iyagi_sentences (episode_id, ordinal);
COMMENT ON INDEX ix_iyagi_sentences_episode_ordinal IS
    'Render a podcast episode transcript in order.';


-- -----------------------------------------------------------------------------
-- 6. topik_tests — TOPIK test catalog (one row per test+section).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topik_tests (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    corpus_source_id  BIGINT       NOT NULL,
    corpus            corpus       NOT NULL DEFAULT 'topik',

    test_number       INTEGER      NOT NULL,  -- e.g. 36, 47, 91
    topik_level       TEXT         NOT NULL,  -- 'TOPIK I' or 'TOPIK II'
    section           topik_section NOT NULL,
    form              TEXT,                   -- '홀수형' / '짝수형'
    origin            TEXT,
    total_questions   INTEGER,

    -- Reading-only: shared passages keyed by item-number range
    -- ("19-20": "...", "21-22": "..."). JSONB because the key shape is data,
    -- not schema. Per ADR-005 (stable cols vs JSONB).
    passages          JSONB        NOT NULL DEFAULT '{}'::jsonb,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_topik_tests_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    -- Natural key: a (test_number, section) is unique across all source files.
    CONSTRAINT uq_topik_tests_number_section UNIQUE (test_number, section),

    CONSTRAINT ck_topik_tests_corpus_pinned   CHECK (corpus = 'topik'),
    CONSTRAINT ck_topik_tests_test_number_pos CHECK (test_number >= 1),
    CONSTRAINT ck_topik_tests_topik_level     CHECK (topik_level IN ('TOPIK I', 'TOPIK II')),
    CONSTRAINT ck_topik_tests_total_q_nonneg  CHECK (total_questions IS NULL OR total_questions >= 0),
    CONSTRAINT ck_topik_tests_passages_object CHECK (jsonb_typeof(passages) = 'object')
);

COMMENT ON TABLE topik_tests IS
    'TOPIK test+section catalog. Items live in topik_items (decoupled per '
    'DESIGN_SPEC: one item pool, two assembly strategies — mock test mode '
    'reassembles by test_id; study mode shuffles across the whole pool).';
COMMENT ON COLUMN topik_tests.passages IS
    'JSONB object keyed by item-number range ("19-20", "21-22", …). Reading '
    'tests use this; listening/writing rows leave it as the default {}. '
    'CHECK enforces object shape; the loader is responsible for the keys.';

DROP TRIGGER IF EXISTS trg_topik_tests_updated_at ON topik_tests;
CREATE TRIGGER trg_topik_tests_updated_at
    BEFORE UPDATE ON topik_tests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_topik_tests_level_section
    ON topik_tests (topik_level, section);
COMMENT ON INDEX ix_topik_tests_level_section IS
    '"List every TOPIK II reading test" — mock-test selection UI.';


-- -----------------------------------------------------------------------------
-- 7. topik_items — TOPIK item pool. One row per question.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topik_items (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    topik_test_id       BIGINT       NOT NULL,
    corpus_source_id    BIGINT       NOT NULL,
    corpus              corpus       NOT NULL DEFAULT 'topik',

    source_id           TEXT         NOT NULL,  -- "topik36-read-001"
    item_number         INTEGER      NOT NULL,
    section             topik_section NOT NULL,  -- denormalized from test
    item_type           topik_item_type NOT NULL,

    -- Pedagogical grouping (instruction shared across N items)
    instruction_group   TEXT,
    instruction         TEXT,

    -- Skill / level tagging
    skill_tag           TEXT,
    skill_tag_raw       TEXT,
    proficiency         proficiency_level,
    points              INTEGER,

    -- Question payload
    stem                TEXT,
    underline           TEXT,
    prompt              TEXT,
    options             JSONB        NOT NULL DEFAULT '[]'::jsonb,
    answer              JSONB,       -- multiple_choice = int; writing = object
    model_answer        JSONB,

    -- Multimodal hints (the original PDFs have inline images)
    has_image           BOOLEAN      NOT NULL DEFAULT FALSE,
    image_text          TEXT,

    -- Free-form additional payload — anything the loader saw that doesn't
    -- have a stable column. Keeps the table honest about source diversity.
    extra               JSONB        NOT NULL DEFAULT '{}'::jsonb,

    search_tsv          TSVECTOR,

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version             INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_topik_items_test
        FOREIGN KEY (topik_test_id) REFERENCES topik_tests(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_topik_items_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT uq_topik_items_source_id        UNIQUE (corpus, source_id),
    CONSTRAINT uq_topik_items_test_number      UNIQUE (topik_test_id, item_number),

    CONSTRAINT ck_topik_items_corpus_pinned    CHECK (corpus = 'topik'),
    CONSTRAINT ck_topik_items_item_number_pos  CHECK (item_number >= 1),
    CONSTRAINT ck_topik_items_points_nonneg    CHECK (points IS NULL OR points >= 0),
    CONSTRAINT ck_topik_items_options_array    CHECK (jsonb_typeof(options) = 'array'),
    CONSTRAINT ck_topik_items_extra_object     CHECK (jsonb_typeof(extra) = 'object')
);

COMMENT ON TABLE topik_items IS
    'TOPIK item pool — one row per question. Decoupled from test for mixed '
    'study-mode shuffles. topik_test_id preserves the original assembly so '
    'mock-test mode can still reproduce a real test.';
COMMENT ON COLUMN topik_items.source_id    IS 'Stable id from source JSON. UNIQUE per corpus.';
COMMENT ON COLUMN topik_items.options      IS 'JSONB array of option strings. Empty for listening picture/graph items.';
COMMENT ON COLUMN topik_items.answer       IS 'Multiple-choice: integer (1-4). Writing blanks: object keyed by blank label.';
COMMENT ON COLUMN topik_items.model_answer IS 'Writing model answers (object for #51-52, string for #53-54).';
COMMENT ON COLUMN topik_items.extra        IS 'Anything the loader saw without a stable column. Lets the schema stay tight without losing data on shape drift.';

CREATE OR REPLACE FUNCTION topik_items_tsv_refresh()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', coalesce(NEW.stem, '')),       'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.prompt, '')),     'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.instruction, '')),'C');
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_topik_items_tsv ON topik_items;
CREATE TRIGGER trg_topik_items_tsv
    BEFORE INSERT OR UPDATE OF stem, prompt, instruction
    ON topik_items
    FOR EACH ROW EXECUTE FUNCTION topik_items_tsv_refresh();

DROP TRIGGER IF EXISTS trg_topik_items_updated_at ON topik_items;
CREATE TRIGGER trg_topik_items_updated_at
    BEFORE UPDATE ON topik_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_topik_items_search_tsv
    ON topik_items USING GIN (search_tsv);
COMMENT ON INDEX ix_topik_items_search_tsv IS
    'Search items by stem/prompt text (TOPIK Prep weak-area search).';

CREATE INDEX IF NOT EXISTS ix_topik_items_section_proficiency
    ON topik_items (section, proficiency);
COMMENT ON INDEX ix_topik_items_section_proficiency IS
    '"Random-draw across the whole pool" study mode — filters by section + level.';

CREATE INDEX IF NOT EXISTS ix_topik_items_test_number
    ON topik_items (topik_test_id, item_number);
COMMENT ON INDEX ix_topik_items_test_number IS
    'Mock-test reassembly: render items in original order per test.';

CREATE INDEX IF NOT EXISTS ix_topik_items_skill_tag
    ON topik_items (skill_tag)
    WHERE skill_tag IS NOT NULL;
COMMENT ON INDEX ix_topik_items_skill_tag IS
    'Filter by skill tag (e.g. "all grammar-connective items").';


-- -----------------------------------------------------------------------------
-- 8. load_state — loader checkpoint table (B3-owned).
--    One row per (corpus, source_path). Lets loaders resume after Ctrl-C or
--    network blips without re-doing committed work.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS load_state (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    corpus            corpus       NOT NULL,
    source_path       TEXT         NOT NULL,

    -- Provenance / change detection
    source_sha256     TEXT,
    items_in_source   INTEGER,
    items_loaded      INTEGER      NOT NULL DEFAULT 0,
    last_item_id      TEXT,        -- last source_id committed; resume picks up after

    -- Status flag for orchestrator
    status            TEXT         NOT NULL DEFAULT 'pending',
    last_error        TEXT,

    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT uq_load_state_corpus_path UNIQUE (corpus, source_path),
    CONSTRAINT ck_load_state_status      CHECK (status IN ('pending', 'in_progress', 'complete', 'failed')),
    CONSTRAINT ck_load_state_sha256      CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_load_state_counts      CHECK (items_loaded >= 0)
);

COMMENT ON TABLE load_state IS
    'Loader checkpoint table. One row per (corpus, source_path). Drives '
    'resumable, idempotent loads — orchestrator reads this before each batch.';
COMMENT ON COLUMN load_state.last_item_id IS
    'source_id of the last successfully committed item (lexicographically last '
    'within the in-progress batch). On resume the loader skips items whose '
    'source_id <= last_item_id when status=in_progress, then continues.';
COMMENT ON COLUMN load_state.status IS
    'pending: not started. in_progress: loader holds the row. complete: '
    'all items committed. failed: terminal — operator inspects last_error.';

DROP TRIGGER IF EXISTS trg_load_state_updated_at ON load_state;
CREATE TRIGGER trg_load_state_updated_at
    BEFORE UPDATE ON load_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_load_state_status
    ON load_state (status, updated_at DESC);
COMMENT ON INDEX ix_load_state_status IS
    'Operator view: "what loads are in_progress / failed?".';

-- End of 005_lesson_podcast_topik.up.sql.
