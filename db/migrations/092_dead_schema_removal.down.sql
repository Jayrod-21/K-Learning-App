-- =============================================================================
-- Migration 092 — dead-schema removal (DOWN)
--
--   Faithfully restores every object 092 dropped, reproduced verbatim from
--   the original source migrations (002_darakwon_corpora, 003_krdict,
--   005_lesson_podcast_topik, 008_topik_dependencies, 016_hanja,
--   041_book_pages, 001_core_schema). Since every dropped object held no
--   live data (0 rows / all-NULL), there is nothing to backfill — this is a
--   structural restore only.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps this body in a single transaction. CREATE INDEX (non-CONCURRENTLY)
-- and CREATE TABLE are transactional.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. corpus_sources.version_tag (migration 002)
-- -----------------------------------------------------------------------------
ALTER TABLE corpus_sources ADD COLUMN IF NOT EXISTS version_tag TEXT;
COMMENT ON COLUMN corpus_sources.version_tag IS
    'Loader-managed version string. Supports re-ingest without collision.';

-- -----------------------------------------------------------------------------
-- 2. conversations.last_grading (migration 001)
-- -----------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_grading JSONB;
ALTER TABLE conversations
    DROP CONSTRAINT IF EXISTS ck_conversations_grading_object;
ALTER TABLE conversations
    ADD CONSTRAINT ck_conversations_grading_object CHECK (
        last_grading IS NULL OR jsonb_typeof(last_grading) = 'object'
    );
COMMENT ON COLUMN conversations.last_grading IS
    'Most recent grading pass from the Claude grader over the user''s production. '
    'NULL until first grading is requested.';

-- -----------------------------------------------------------------------------
-- 3. book_pages.width / height (migration 041)
-- -----------------------------------------------------------------------------
ALTER TABLE book_pages ADD COLUMN IF NOT EXISTS width  INTEGER;
ALTER TABLE book_pages ADD COLUMN IF NOT EXISTS height INTEGER;
ALTER TABLE book_pages
    DROP CONSTRAINT IF EXISTS ck_book_pages_width_positive;
ALTER TABLE book_pages
    ADD CONSTRAINT ck_book_pages_width_positive
        CHECK (width IS NULL OR width > 0);
ALTER TABLE book_pages
    DROP CONSTRAINT IF EXISTS ck_book_pages_height_positive;
ALTER TABLE book_pages
    ADD CONSTRAINT ck_book_pages_height_positive
        CHECK (height IS NULL OR height > 0);
COMMENT ON COLUMN book_pages.width IS
    'Page image width in pixels. NULL — not populated by U1a; a future pass '
    'may read it off the stored image.';
COMMENT ON COLUMN book_pages.height IS
    'Page image height in pixels. NULL — not populated by U1a; a future pass '
    'may read it off the stored image.';

-- -----------------------------------------------------------------------------
-- 4. topik_items.skill_tag_raw (migration 005)
-- -----------------------------------------------------------------------------
ALTER TABLE topik_items ADD COLUMN IF NOT EXISTS skill_tag_raw TEXT;

-- -----------------------------------------------------------------------------
-- 5. krdict_senses.sense_domain / sense_register (migration 003)
-- -----------------------------------------------------------------------------
ALTER TABLE krdict_senses ADD COLUMN IF NOT EXISTS sense_domain   TEXT;
ALTER TABLE krdict_senses ADD COLUMN IF NOT EXISTS sense_register TEXT;
COMMENT ON COLUMN krdict_senses.sense_domain   IS 'Domain tag if KRDICT attaches one to this sense (free TEXT, no enum).';
COMMENT ON COLUMN krdict_senses.sense_register IS 'Register tag if KRDICT attaches one to this sense (free TEXT, not register_level — inconsistent values).';

-- -----------------------------------------------------------------------------
-- 6. krdict_entries.register (migration 003)
-- -----------------------------------------------------------------------------
ALTER TABLE krdict_entries ADD COLUMN IF NOT EXISTS register register_level;
COMMENT ON COLUMN krdict_entries.register IS
    'Speech-level register tag (enum register_level). NULL when KRDICT doesn''t tag one.';

-- -----------------------------------------------------------------------------
-- 7. vocab_entries (10, migration 002) — denormalized inline form variants.
-- -----------------------------------------------------------------------------
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS audio_track     TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS japanese        TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS case_marker     TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS irregular_class TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS passive_form    TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS causative_form  TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS basic_form      TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS honorific_form  TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS humble_form     TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS contracted_form TEXT;
COMMENT ON COLUMN vocab_entries.japanese         IS 'Japanese gloss as printed (Beginner book lacks for some entries — nullable).';
COMMENT ON COLUMN vocab_entries.case_marker      IS 'Verb-case template printed before the headword (e.g. "-에/에게 감동하다").';
COMMENT ON COLUMN vocab_entries.irregular_class  IS 'Irregular-conjugation class if marked (e.g. "ㅂ-irregular").';
COMMENT ON COLUMN vocab_entries.passive_form     IS '피 marker: passive form printed inline. Denormalized convenience; canonical word↔word link is vocab_entry_relations.';
COMMENT ON COLUMN vocab_entries.causative_form   IS '사 marker.';
COMMENT ON COLUMN vocab_entries.basic_form       IS '본 marker (base form for passive/causative entries).';
COMMENT ON COLUMN vocab_entries.honorific_form   IS '높 marker.';
COMMENT ON COLUMN vocab_entries.humble_form      IS '낮 marker.';
COMMENT ON COLUMN vocab_entries.contracted_form  IS '준 marker.';

-- -----------------------------------------------------------------------------
-- 8. ix_topik_dependencies_item (migration 008) — forward-direction index.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_topik_dependencies_item
    ON topik_dependencies (topik_item_id, dep_type);
COMMENT ON INDEX ix_topik_dependencies_item IS
    'Forward query: enumerate the grammar+vocab a TOPIK item depends on. '
    'Used by the per-item study-mode "what is this question testing?" view.';

-- -----------------------------------------------------------------------------
-- 9. ix_hanja_compounds_character (migration 016)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_hanja_compounds_character
    ON hanja_compounds (character_id);
COMMENT ON INDEX ix_hanja_compounds_character IS
    'Supports the compound join/aggregation in GET /hanja and GET /hanja/today '
    '(compounds grouped per character_id).';

-- -----------------------------------------------------------------------------
-- 10. hanja_extensions (migration 002)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hanja_extensions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    corpus_source_id    BIGINT       NOT NULL,
    corpus              corpus       NOT NULL,
    source_id           TEXT         NOT NULL,
    book_level          book_level   NOT NULL,

    theme               TEXT         NOT NULL,
    central_character   TEXT         NOT NULL,
    central_korean      TEXT,
    central_meaning     TEXT,
    central_chinese     TEXT,
    central_japanese    TEXT,
    central_korean_word TEXT,

    derived_words       JSONB        NOT NULL DEFAULT '[]'::jsonb,
    notes               JSONB        NOT NULL DEFAULT '[]'::jsonb,

    source_book         TEXT         NOT NULL,
    source_pages        INTEGER[]    NOT NULL DEFAULT '{}',

    proficiency         proficiency_level NOT NULL,
    domain              content_domain NOT NULL DEFAULT 'general',

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version             INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_hanja_extensions_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT uq_hanja_extensions_corpus_source_id UNIQUE (corpus, source_id),

    CONSTRAINT ck_hanja_extensions_jsonb_arrays CHECK (
        jsonb_typeof(derived_words) = 'array' AND
        jsonb_typeof(notes)         = 'array'
    ),

    CONSTRAINT ck_hanja_extensions_corpus_vocab_only CHECK (
        corpus IN ('vocab_2000_beginner', 'vocab_2000_intermediate')
    )
);

COMMENT ON TABLE hanja_extensions IS
    '"Korean through Chinese Characters" pages from the 2000-Words books. '
    'Each row is one mind-map: a central hanja character + 5-10 derived '
    'Korean words (JSONB array). Separate table because the structure '
    'differs meaningfully from vocab_entries.';
COMMENT ON COLUMN hanja_extensions.central_character   IS 'The central Chinese character, e.g. "親".';
COMMENT ON COLUMN hanja_extensions.central_korean      IS 'Korean reading of the character, e.g. "친".';
COMMENT ON COLUMN hanja_extensions.central_meaning     IS 'English gloss, e.g. "to be close".';
COMMENT ON COLUMN hanja_extensions.central_chinese     IS 'Chinese gloss.';
COMMENT ON COLUMN hanja_extensions.central_japanese    IS 'Japanese gloss.';
COMMENT ON COLUMN hanja_extensions.central_korean_word IS 'Anchor Korean word containing the character.';
COMMENT ON COLUMN hanja_extensions.derived_words       IS 'JSONB array of {korean, english, page} — branching words.';
COMMENT ON COLUMN hanja_extensions.notes               IS 'JSONB array of strings — explanatory bullets.';

DROP TRIGGER IF EXISTS trg_hanja_extensions_updated_at ON hanja_extensions;
CREATE TRIGGER trg_hanja_extensions_updated_at
    BEFORE UPDATE ON hanja_extensions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_hanja_extensions_central_character
    ON hanja_extensions (central_character);
COMMENT ON INDEX ix_hanja_extensions_central_character IS
    'Query: look up a hanja by character (when a user taps a character in a '
    'vocab entry''s hanja column).';

CREATE INDEX IF NOT EXISTS ix_hanja_extensions_theme
    ON hanja_extensions (theme, book_level);
COMMENT ON INDEX ix_hanja_extensions_theme IS
    'Query: render hanja sections grouped under each theme (Reference page).';

-- -----------------------------------------------------------------------------
-- 11. lets_check_exercises (migration 002)
--     (lets_check_parent_kind enum was never dropped by 092.up — reused here.)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lets_check_exercises (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    corpus_source_id         BIGINT       NOT NULL,
    corpus                   corpus       NOT NULL,
    source_id                TEXT         NOT NULL,
    book_level               book_level   NOT NULL,

    parent_kind              lets_check_parent_kind NOT NULL,
    parent_kgiu_entry_id     BIGINT,
    parent_vocab_theme       TEXT,
    parent_vocab_subsection  TEXT,

    section_label            TEXT,
    items                    JSONB        NOT NULL DEFAULT '[]'::jsonb,
    notes                    TEXT,

    source_book              TEXT         NOT NULL,
    source_pages             INTEGER[]    NOT NULL DEFAULT '{}',

    proficiency              proficiency_level NOT NULL,

    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version                  INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_lets_check_exercises_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_lets_check_exercises_kgiu_entry
        FOREIGN KEY (parent_kgiu_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT uq_lets_check_exercises_corpus_source_id UNIQUE (corpus, source_id),

    CONSTRAINT ck_lets_check_exercises_items_array CHECK (
        jsonb_typeof(items) = 'array'
    ),

    CONSTRAINT ck_lets_check_exercises_parent_xor CHECK (
        (parent_kind = 'kgiu_entry'
            AND parent_kgiu_entry_id   IS NOT NULL
            AND parent_vocab_theme     IS NULL
            AND parent_vocab_subsection IS NULL)
        OR
        (parent_kind = 'vocab_subsection'
            AND parent_kgiu_entry_id   IS NULL
            AND parent_vocab_theme     IS NOT NULL
            AND parent_vocab_subsection IS NOT NULL
            AND length(parent_vocab_theme) > 0
            AND length(parent_vocab_subsection) > 0)
    )
);

COMMENT ON TABLE lets_check_exercises IS
    'Let''s Check! review exercises. Polymorphic parent: a kgiu_entry (via FK) '
    'or a vocab subsection (theme+subsection text — these aren''t first-class '
    'rows in vocab_entries). One row per page.';
COMMENT ON COLUMN lets_check_exercises.parent_kind             IS 'Discriminator enum. CHECK enforces matching populated columns.';
COMMENT ON COLUMN lets_check_exercises.parent_kgiu_entry_id    IS 'FK → kgiu_entries.id when parent_kind = ''kgiu_entry''. Otherwise NULL.';
COMMENT ON COLUMN lets_check_exercises.parent_vocab_theme      IS 'Theme label when parent_kind = ''vocab_subsection''.';
COMMENT ON COLUMN lets_check_exercises.parent_vocab_subsection IS 'Subsection label when parent_kind = ''vocab_subsection''.';
COMMENT ON COLUMN lets_check_exercises.section_label           IS 'Section/page label printed on the source page.';
COMMENT ON COLUMN lets_check_exercises.items                   IS 'JSONB array of {prompt, options?, answer, …}. Shape varies; rendered by Reference UI.';

DROP TRIGGER IF EXISTS trg_lets_check_exercises_updated_at ON lets_check_exercises;
CREATE TRIGGER trg_lets_check_exercises_updated_at
    BEFORE UPDATE ON lets_check_exercises
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_lets_check_exercises_kgiu_parent
    ON lets_check_exercises (parent_kgiu_entry_id)
    WHERE parent_kgiu_entry_id IS NOT NULL;
COMMENT ON INDEX ix_lets_check_exercises_kgiu_parent IS
    'Partial index. Query: "what exercises does this KGIU entry have?" '
    '(grammar detail → Practice tab).';

CREATE INDEX IF NOT EXISTS ix_lets_check_exercises_vocab_parent
    ON lets_check_exercises (parent_vocab_theme, parent_vocab_subsection)
    WHERE parent_vocab_theme IS NOT NULL;
COMMENT ON INDEX ix_lets_check_exercises_vocab_parent IS
    'Partial index. Query: "what review exercises exist for this vocab '
    'subsection?" (Vocab Reference page).';

-- End of 092_dead_schema_removal.down.sql — runner owns the transaction (ADR-013).
