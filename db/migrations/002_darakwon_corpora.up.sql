-- =============================================================================
-- Migration 002 — Darakwon corpora (KGIU grammar + 2000 Words vocab + supplements)
--   UP — apply this to introduce the reference-data schema for the Darakwon books.
--   Reverse: 002_darakwon_corpora.down.sql
--   Depends on: 001_core_schema (provides the shared `set_updated_at()` function
--               and the enums `proficiency_level`, `corpus`, `book_level`,
--               `register_level`; provides the `users` and `grammar_entries`
--               (user-canonical) tables).
--
-- NAMING NOTE (coordination with A1):
--   A1's 001_core_schema defines a `grammar_entries` table — that is the
--   USER-CANONICAL grammar bank (FK to users, dedup by (user_id, pattern_key),
--   feeds the SRS production drills). It is NOT the source-corpus table.
--
--   THIS migration defines `kgiu_entries` — the raw KGIU-book reference rows,
--   one per source JSON entry from `grammar_kgiu_{beginner,intermediate,
--   advanced}.json`. A later phase (Phase C, "canonical-grammar dedup") will
--   build the bridge: it will let a user-canonical `grammar_entries` row point
--   at one or more source `kgiu_entries` rows.
--
-- Scope (per Phase-A schema split):
--   * KGIU Beginner / Intermediate / Advanced — unified `kgiu_entries` table
--     plus `kgiu_entry_relations` for cross-entry hard FK references.
--   * 2000 Essential Korean Words — unified `vocab_entries` table plus
--     `vocab_entry_relations` for word↔word relations (synonyms, antonyms,
--     related, passive/causative/honorific/etc.).
--   * Supplementary types: `hanja_extensions`, `lets_check_exercises`.
--   * `corpus_sources` catalog row per ingested JSON.
--   * `content_domain` enum (DESIGN_SPEC content-tagging model).
--
-- Out of scope:
--   * Core/auth (users, sessions) — A1, migration 001.
--   * User-canonical grammar bank — A1's `grammar_entries`.
--   * vocab_cards / FSRS / TOPIK items / TTMIK / Iyagi — later migrations.
--   * Loader/ingest tooling — A3.
--   * Canonical-grammar dedup bridge — Phase C.
--
-- Senior-engineer-bar checks honored: surrogate BIGINT IDENTITY PKs, audit
-- columns + updated_at triggers, TIMESTAMPTZ, TEXT (no VARCHAR), JSONB
-- (no JSON), explicit ON DELETE/ON UPDATE, COMMENT ON every table/column,
-- justified indexes, idempotent.
--
-- ALL DDL IS IDEMPOTENT.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write. An inner COMMIT here would
--   end the runner's transaction early and break the atomicity guarantee.
--   discover_migrations enforces this rule at discovery time.
--
--   Manual application (NOT recommended in production — use migrate.py) can
--   use: `psql -v ON_ERROR_STOP=1 -1 -f 002_darakwon_corpora.up.sql` — the
--   psql `-1` flag wraps the file in a single transaction without requiring
--   inline BEGIN/COMMIT in the file itself.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. Enums new to this migration.
--    (`proficiency_level`, `corpus`, `book_level`, `register_level` already
--    exist from 001_core_schema and are reused as-is.)
-- -----------------------------------------------------------------------------

-- DOMAIN — DESIGN_SPEC.md content-tagging model. Drives "show me research-
-- domain L4 grammar" filters in Reference and TOPIK Prep.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'content_domain') THEN
        CREATE TYPE content_domain AS ENUM ('general', 'research', 'business');
    END IF;
END $$;

COMMENT ON TYPE content_domain IS
    'Tag space for the "domain" filter (DESIGN_SPEC content-tagging model). '
    'general = everyday/learner-book content; research = academic register; '
    'business = workplace/formal-business register. Default `general`. '
    'Adding a value is an ALTER TYPE … ADD VALUE migration — appropriate for '
    'this slow-changing closed set.';

-- VOCAB_RELATION_TYPE — closed set of word↔word relation kinds from the
-- 2000-Words colored markers (동/반/관/참/피/사/본/높/낮/준).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vocab_relation_type') THEN
        CREATE TYPE vocab_relation_type AS ENUM (
            'synonym',          -- 동
            'antonym',          -- 반
            'related',          -- 관
            'reference',        -- 참
            'passive_form',     -- 피
            'causative_form',   -- 사
            'basic_form',       -- 본
            'honorific_form',   -- 높
            'humble_form',      -- 낮
            'contracted_form'   -- 준
        );
    END IF;
END $$;

COMMENT ON TYPE vocab_relation_type IS
    'Relation kinds between vocabulary entries, mirroring the colored markers '
    'in the 2000-Words books (동/반/관/참/피/사/본/높/낮/준).';

-- KGIU_ENTRY_TYPE — discriminator for kgiu_entries rows. `grammar` is a
-- teachable pattern; `intro` is a chapter divider with context but no
-- pattern; `reference` is a back-matter / appendix / 확인해 볼까요? quiz row
-- that is neither a pattern nor a chapter divider but carries explanation
-- and exercises. Verified against grammar_kgiu_*.json source rows.
-- Note: Postgres cannot REMOVE an enum value; if you ever want to retire
-- one, write a migration that uses ALTER TYPE ... RENAME VALUE + a code
-- sweep, OR drop and recreate the type.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kgiu_entry_type') THEN
        CREATE TYPE kgiu_entry_type AS ENUM ('grammar', 'intro', 'reference');
    ELSE
        -- Idempotently extend an existing enum. PG 12+ supports IF NOT EXISTS.
        ALTER TYPE kgiu_entry_type ADD VALUE IF NOT EXISTS 'reference';
    END IF;
END $$;

COMMENT ON TYPE kgiu_entry_type IS
    'Row kind for kgiu_entries: `grammar` = a teachable pattern; `intro` = '
    'a chapter divider or front-matter row carrying context but no pattern; '
    '`reference` = back-matter / appendix / 확인해 볼까요? quiz row that is '
    'neither (carries explanation and exercises but no teachable pattern).';

-- VOCAB_ENTRY_TYPE — discriminator for vocab_entries.
-- `reference` = appendix "Additional Vocabulary" thematic illustrated pages
-- (animals, fish & shellfish, etc.) — multilingual bulleted lists, no
-- single headword. Verified against vocab_2000_*.json source rows.
-- Note: Postgres cannot REMOVE an enum value; the down migration drops
-- the whole type, which removes any values added by ALTER TYPE.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vocab_entry_type') THEN
        CREATE TYPE vocab_entry_type AS ENUM (
            'word', 'theme_intro', 'subsection_intro', 'reference'
        );
    ELSE
        ALTER TYPE vocab_entry_type ADD VALUE IF NOT EXISTS 'reference';
    END IF;
END $$;

COMMENT ON TYPE vocab_entry_type IS
    'Row kind for vocab_entries. `word` = a single dictionary headword (the '
    'overwhelming majority); `theme_intro` / `subsection_intro` = navigational '
    'rows from theme/subsection divider pages; `reference` = appendix '
    '"Additional Vocabulary" thematic pages (multilingual bulleted lists, '
    'no single headword). lets_check and hanja_extension live in their own '
    'tables, NOT in this enum.';

-- LETS_CHECK_PARENT_KIND — discriminator for lets_check_exercises'
-- polymorphic parent.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lets_check_parent_kind') THEN
        CREATE TYPE lets_check_parent_kind AS ENUM ('kgiu_entry', 'vocab_subsection');
    END IF;
END $$;

COMMENT ON TYPE lets_check_parent_kind IS
    'Discriminator for lets_check_exercises.parent_kind. CHECK on the table '
    'enforces that exactly the matching FK / text columns are populated.';


-- -----------------------------------------------------------------------------
-- 2. corpus_sources — catalog of every ingested source (reference data).
--    One row per JSON file under tools/ingest/output/. Loader inserts/upserts
--    here on every ingest pass; downstream tables FK to it for provenance.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corpus_sources (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    corpus              corpus            NOT NULL,
    title               TEXT              NOT NULL,
    publisher           TEXT,
    authors             TEXT,
    level               book_level,
    default_proficiency proficiency_level,
    extracted_by        TEXT,
    extracted_at        DATE,
    version_tag         TEXT,
    source_path         TEXT              NOT NULL,
    source_sha256       TEXT,
    item_count          INTEGER,
    notes               TEXT,
    created_at          TIMESTAMPTZ       NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ       NOT NULL DEFAULT now(),
    version             INT               NOT NULL DEFAULT 1,

    CONSTRAINT uq_corpus_sources_corpus            UNIQUE (corpus),
    CONSTRAINT uq_corpus_sources_source_path       UNIQUE (source_path),
    CONSTRAINT ck_corpus_sources_item_count_nonneg CHECK (item_count IS NULL OR item_count >= 0),
    CONSTRAINT ck_corpus_sources_sha256_format     CHECK (
        source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'
    )
);

COMMENT ON TABLE corpus_sources IS
    'Catalog of ingested corpora (one row per JSON file). The loader upserts '
    'here on every ingest pass; downstream tables FK to it for provenance. '
    'Audit columns per ADR-001 §D6.';
COMMENT ON COLUMN corpus_sources.corpus              IS 'Enum tag (unique — one canonical row per corpus).';
COMMENT ON COLUMN corpus_sources.title               IS 'Printed book title (verbatim).';
COMMENT ON COLUMN corpus_sources.level               IS 'Source-book level. Nullable for corpora that span levels (e.g. TOPIK item pool).';
COMMENT ON COLUMN corpus_sources.default_proficiency IS 'Default proficiency tag for rows that do not specify one.';
COMMENT ON COLUMN corpus_sources.extracted_by        IS 'Provenance (e.g. "claude-vision via 14 parallel subagents").';
COMMENT ON COLUMN corpus_sources.extracted_at        IS 'DATE — extraction dates are not time-of-day precise.';
COMMENT ON COLUMN corpus_sources.version_tag         IS 'Loader-managed version string. Supports re-ingest without collision.';
COMMENT ON COLUMN corpus_sources.source_path         IS 'Repo-relative path to source JSON. UNIQUE.';
COMMENT ON COLUMN corpus_sources.source_sha256       IS 'Hex SHA-256 of the source JSON at ingest time. CHECK enforces 64 lowercase hex chars.';
COMMENT ON COLUMN corpus_sources.item_count          IS 'Number of items in source JSON. Sanity-check vs row count.';
COMMENT ON COLUMN corpus_sources.notes               IS 'Free-form provenance notes from the JSON ``source.note`` field.';

-- updated_at trigger only — `version` is a manual optimistic-concurrency bump
-- by the app per ADR-001 §D6 (matches A1's pattern in 001).
DROP TRIGGER IF EXISTS trg_corpus_sources_updated_at ON corpus_sources;
CREATE TRIGGER trg_corpus_sources_updated_at
    BEFORE UPDATE ON corpus_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. kgiu_entries — unified KGIU source-entry table (all 3 levels).
--    This is the RAW SOURCE corpus. A1's `grammar_entries` is the user-
--    canonical layer. Phase C will build the dedup bridge between them.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kgiu_entries (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Provenance & identity
    corpus_source_id  BIGINT       NOT NULL,
    corpus            corpus       NOT NULL,
    source_id         TEXT         NOT NULL,
    book_level        book_level   NOT NULL,
    entry_type        kgiu_entry_type NOT NULL DEFAULT 'grammar',

    -- Navigational / curricular context
    unit              TEXT,
    audio_track       TEXT,
    source_book       TEXT         NOT NULL,
    source_pages      INTEGER[]    NOT NULL DEFAULT '{}',

    -- Pedagogical content
    pattern           TEXT,
    title_en          TEXT,
    category          TEXT,
    explanation       TEXT,

    -- Tagging (DESIGN_SPEC content-tagging model)
    proficiency       proficiency_level NOT NULL,
    register          TEXT,
    domain            content_domain NOT NULL DEFAULT 'general',

    -- Variable-shape repeated content (ADR-005)
    formation_rules   JSONB        NOT NULL DEFAULT '[]'::jsonb,
    examples          JSONB        NOT NULL DEFAULT '[]'::jsonb,
    dialogues         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    vocabulary        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    tips              JSONB        NOT NULL DEFAULT '[]'::jsonb,
    compare_with      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    exercises         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    cultural_notes    JSONB        NOT NULL DEFAULT '[]'::jsonb,
    notes             TEXT,

    -- Full-text search vector (maintained by trigger; see ADR-006).
    search_tsv        TSVECTOR,

    -- Audit (ADR-001 §D6)
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_kgiu_entries_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT uq_kgiu_entries_corpus_source_id UNIQUE (corpus, source_id),

    -- Intros may have null pattern; grammar rows must have one.
    CONSTRAINT ck_kgiu_entries_pattern_required CHECK (
        entry_type = 'intro' OR pattern IS NOT NULL
    ),

    -- All JSONB shape columns must be arrays — defends against the loader
    -- writing a scalar/object (malformed-JSONB DoS vector).
    CONSTRAINT ck_kgiu_entries_jsonb_arrays CHECK (
        jsonb_typeof(formation_rules) = 'array' AND
        jsonb_typeof(examples)        = 'array' AND
        jsonb_typeof(dialogues)       = 'array' AND
        jsonb_typeof(vocabulary)      = 'array' AND
        jsonb_typeof(tips)            = 'array' AND
        jsonb_typeof(compare_with)    = 'array' AND
        jsonb_typeof(exercises)       = 'array' AND
        jsonb_typeof(cultural_notes)  = 'array'
    ),

    -- corpus must be one of the KGIU values.
    CONSTRAINT ck_kgiu_entries_corpus_kgiu_only CHECK (
        corpus IN ('kgiu_beginner', 'kgiu_intermediate', 'kgiu_advanced')
    ),

    -- book_level must agree with corpus.
    CONSTRAINT ck_kgiu_entries_level_matches_corpus CHECK (
        (corpus = 'kgiu_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'kgiu_intermediate' AND book_level = 'intermediate') OR
        (corpus = 'kgiu_advanced'     AND book_level = 'advanced')
    )
);

COMMENT ON TABLE kgiu_entries IS
    'Raw source rows from Korean Grammar in Use (Beginner / Intermediate / '
    'Advanced). One row per source JSON entry. Stable scalars are columns; '
    'variable-shape repeated content is JSONB (ADR-005). NOT to be confused '
    'with A1''s `grammar_entries` table, which is the user-canonical layer. '
    'Phase C will add a bridge from grammar_entries → kgiu_entries.';

COMMENT ON COLUMN kgiu_entries.corpus_source_id IS 'FK → corpus_sources for provenance.';
COMMENT ON COLUMN kgiu_entries.corpus           IS 'Denormalized for index/query convenience. CHECK enforces kgiu_* only.';
COMMENT ON COLUMN kgiu_entries.source_id        IS 'Stable id from source JSON (e.g. "kgiu-adv-c01-01"). UNIQUE per corpus.';
COMMENT ON COLUMN kgiu_entries.book_level       IS 'beginner/intermediate/advanced. Constrained to agree with `corpus`.';
COMMENT ON COLUMN kgiu_entries.entry_type       IS 'grammar (a pattern) or intro (chapter divider). Default `grammar`.';
COMMENT ON COLUMN kgiu_entries.unit             IS 'Chapter/unit label (e.g. "Ch.1. Expressing Conjecture …"). Nullable for stand-alone intros.';
COMMENT ON COLUMN kgiu_entries.audio_track      IS 'Audio track reference printed on the page, if any.';
COMMENT ON COLUMN kgiu_entries.source_book      IS 'Short book label ("KGIU Beginner" / "KGIU Intermediate" / "KGIU Advanced").';
COMMENT ON COLUMN kgiu_entries.source_pages     IS 'Book-page numbers covering this entry. INTEGER[] (small, ordered, queryable with && / @>).';
COMMENT ON COLUMN kgiu_entries.pattern          IS 'The grammar pattern itself (e.g. "-아/어 보이다"). NULL only for intro rows.';
COMMENT ON COLUMN kgiu_entries.title_en         IS 'Short English gloss of the pattern.';
COMMENT ON COLUMN kgiu_entries.category         IS 'Short categorical tag. TEXT (extensible per ADR-001 §D8).';
COMMENT ON COLUMN kgiu_entries.explanation      IS '문법을 알아볼까요? prose paragraph.';
COMMENT ON COLUMN kgiu_entries.proficiency      IS 'TOPIK proficiency tag (enum proficiency_level).';
COMMENT ON COLUMN kgiu_entries.register         IS 'Politeness/register tag. TEXT (not enum register_level) because source data contains composite/compound values like "해요체/합쇼체" and "문어체/구어체"; Phase-C canonicalization will normalize.';
COMMENT ON COLUMN kgiu_entries.domain           IS 'general/research/business (DESIGN_SPEC content-tagging). Default `general`.';
COMMENT ON COLUMN kgiu_entries.formation_rules  IS 'JSONB array of strings — conjugation/formation bullets. ADR-005.';
COMMENT ON COLUMN kgiu_entries.examples         IS 'JSONB array of {korean, english} pairs (intro dialog + sample sentences).';
COMMENT ON COLUMN kgiu_entries.dialogues        IS 'JSONB array of {context, lines:[{speaker, korean, english}], alternatives?:[…]}.';
COMMENT ON COLUMN kgiu_entries.vocabulary       IS 'JSONB array of {korean, english} — Tip-box glosses.';
COMMENT ON COLUMN kgiu_entries.tips             IS 'JSONB array of strings — 더 알아볼까요? content, one per numbered item.';
COMMENT ON COLUMN kgiu_entries.compare_with     IS 'JSONB array of {with, note} — free-form text references. Hard FK links go in kgiu_entry_relations.';
COMMENT ON COLUMN kgiu_entries.exercises        IS 'JSONB array of {prompt, answer} — 연습해 볼까요? items.';
COMMENT ON COLUMN kgiu_entries.cultural_notes   IS 'JSONB array of strings — cultural/usage notes.';
COMMENT ON COLUMN kgiu_entries.notes            IS 'Free-form prose notes (loader-flagged anomalies, intro contents list, etc.).';
COMMENT ON COLUMN kgiu_entries.search_tsv       IS 'Maintained by trg_kgiu_entries_tsv. Sources: pattern + title_en + explanation + notes. Config: simple (Korean tokenizing deferred to Kiwi — ADR-006).';

-- Composite uniqueness so child tables could FK on (corpus, source_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_kgiu_entries_id_corpus_source
    ON kgiu_entries (id, corpus, source_id);

DROP TRIGGER IF EXISTS trg_kgiu_entries_updated_at ON kgiu_entries;
CREATE TRIGGER trg_kgiu_entries_updated_at
    BEFORE UPDATE ON kgiu_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- tsvector maintenance — pure mechanical trigger per ADR-001 §D12.
CREATE OR REPLACE FUNCTION kgiu_entries_tsv_refresh()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', coalesce(NEW.pattern, '')),     'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.title_en, '')),    'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.explanation, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(NEW.notes, '')),       'D');
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION kgiu_entries_tsv_refresh() IS
    'Mechanical tsvector maintenance for kgiu_entries (ADR-001 §D12 permits '
    'triggers for search-index maintenance). Weights: pattern=A, title_en=B, '
    'explanation=C, notes=D. Config `simple` — see ADR-006.';

DROP TRIGGER IF EXISTS trg_kgiu_entries_tsv ON kgiu_entries;
CREATE TRIGGER trg_kgiu_entries_tsv
    BEFORE INSERT OR UPDATE OF pattern, title_en, explanation, notes
    ON kgiu_entries
    FOR EACH ROW EXECUTE FUNCTION kgiu_entries_tsv_refresh();

-- Indexes (each one named by the query that justifies it; ADR-001 §"Indexing").

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_search_tsv
    ON kgiu_entries USING GIN (search_tsv);
COMMENT ON INDEX ix_kgiu_entries_search_tsv IS
    'GIN over search_tsv. Query: tap-a-grammar lookup ("find KGIU entries '
    'matching ts query X"). Used by Grammar bank search and TOPIK Prep weak-'
    'area lookups.';

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_corpus_level
    ON kgiu_entries (corpus, book_level, proficiency);
COMMENT ON INDEX ix_kgiu_entries_corpus_level IS
    'Query: "give me all L4 KGIU-Intermediate entries" (Reference / filter UI). '
    'Selectivity order: corpus narrows first, then level, then proficiency.';

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_category
    ON kgiu_entries (category)
    WHERE category IS NOT NULL;
COMMENT ON INDEX ix_kgiu_entries_category IS
    'Partial index — category is nullable on intro rows. Query: "all `conjecture` '
    'entries across levels" (Grammar bank category facet).';

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_domain_proficiency
    ON kgiu_entries (domain, proficiency)
    WHERE entry_type = 'grammar';
COMMENT ON INDEX ix_kgiu_entries_domain_proficiency IS
    'Partial index excluding intros. Query: filter by domain+proficiency in '
    'TOPIK Prep / Today queue assembly.';

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_pattern_prefix
    ON kgiu_entries (pattern text_pattern_ops)
    WHERE pattern IS NOT NULL;
COMMENT ON INDEX ix_kgiu_entries_pattern_prefix IS
    'B-tree with text_pattern_ops. Query: prefix lookup on pattern (e.g. "find '
    'patterns starting with -(으)ㄹ"). Matches the common UX (typing the start '
    'of a form).';


-- -----------------------------------------------------------------------------
-- 4. kgiu_entry_relations — hard FK cross-references between captured kgiu rows.
--    Use when BOTH endpoints are captured. Free-form references stay inline
--    as `kgiu_entries.compare_with` JSONB.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kgiu_entry_relations (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_entry_id    BIGINT NOT NULL,
    target_entry_id    BIGINT NOT NULL,
    relation_kind      TEXT   NOT NULL DEFAULT 'compare_with',
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INT    NOT NULL DEFAULT 1,

    CONSTRAINT fk_kgiu_entry_relations_source
        FOREIGN KEY (source_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_kgiu_entry_relations_target
        FOREIGN KEY (target_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT uq_kgiu_entry_relations_triple
        UNIQUE (source_entry_id, target_entry_id, relation_kind),

    CONSTRAINT ck_kgiu_entry_relations_no_self CHECK (
        source_entry_id <> target_entry_id
    ),
    CONSTRAINT ck_kgiu_entry_relations_kind CHECK (
        relation_kind IN ('compare_with', 'parallel_lower_level', 'parallel_higher_level',
                          'extends', 'contrasts_with', 'used_together_with')
    )
);

COMMENT ON TABLE kgiu_entry_relations IS
    'Directed hard-FK cross-references between kgiu_entries rows. Use when '
    'BOTH endpoints are captured rows. Use the inline `compare_with` JSONB on '
    'kgiu_entries when the referent is just a textual label. '
    'ON DELETE RESTRICT both sides: deleting a referenced entry must be '
    'deliberate (ADR-001 §D9).';
COMMENT ON COLUMN kgiu_entry_relations.relation_kind IS
    'Directed relation kind. TEXT+CHECK rather than enum so adding a kind '
    'doesn''t need a migration. Allowed: compare_with, parallel_lower_level, '
    'parallel_higher_level, extends, contrasts_with, used_together_with.';

DROP TRIGGER IF EXISTS trg_kgiu_entry_relations_updated_at ON kgiu_entry_relations;
CREATE TRIGGER trg_kgiu_entry_relations_updated_at
    BEFORE UPDATE ON kgiu_entry_relations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_kgiu_entry_relations_source
    ON kgiu_entry_relations (source_entry_id, relation_kind);
COMMENT ON INDEX ix_kgiu_entry_relations_source IS
    'Query: "what does entry X relate to?" (rendering related-grammar links on '
    'the grammar-bank detail page).';

CREATE INDEX IF NOT EXISTS ix_kgiu_entry_relations_target
    ON kgiu_entry_relations (target_entry_id, relation_kind);
COMMENT ON INDEX ix_kgiu_entry_relations_target IS
    'Query: "what relates back to entry X?" (reverse-link rendering and orphan '
    'detection when deleting an entry).';


-- -----------------------------------------------------------------------------
-- 5. vocab_entries — unified 2000-Words table (beginner + intermediate).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vocab_entries (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    corpus_source_id  BIGINT       NOT NULL,
    corpus            corpus       NOT NULL,
    source_id         TEXT         NOT NULL,
    book_level        book_level   NOT NULL,
    entry_type        vocab_entry_type NOT NULL DEFAULT 'word',

    -- Navigation / curricular context
    theme             TEXT,
    subsection        TEXT,
    audio_track       TEXT,
    source_book       TEXT         NOT NULL,
    source_pages      INTEGER[]    NOT NULL DEFAULT '{}',

    -- Lexical content
    korean            TEXT,
    english           TEXT,
    pronunciation     TEXT,
    hanja             TEXT,
    japanese          TEXT,
    part_of_speech    TEXT,
    case_marker       TEXT,
    irregular_class   TEXT,

    -- Single example sentence per entry per book convention.
    example_korean    TEXT,
    example_english   TEXT,

    -- Inline form variants (denormalized convenience for one-shot reads;
    -- canonical relational model lives in vocab_entry_relations).
    passive_form      TEXT,
    causative_form    TEXT,
    basic_form        TEXT,
    honorific_form    TEXT,
    humble_form       TEXT,
    contracted_form   TEXT,

    -- Variable-shape repeated content (ADR-005)
    tips              JSONB        NOT NULL DEFAULT '[]'::jsonb,
    cross_refs        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    notes             JSONB        NOT NULL DEFAULT '[]'::jsonb,

    -- Tagging.
    -- SF-1 (A2 review): proficiency is nullable because navigational rows
    -- (theme_intro, subsection_intro, reference) don't carry one in the
    -- source JSON, and forcing the loader to invent a value from
    -- corpus_sources.default_proficiency loses information ("this row has
    -- no proficiency, it's a divider"). For `word` rows, the CHECK below
    -- requires a non-NULL value — the loader must supply one.
    proficiency       proficiency_level,
    domain            content_domain NOT NULL DEFAULT 'general',

    -- FTS
    search_tsv        TSVECTOR,

    -- Audit
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    CONSTRAINT fk_vocab_entries_corpus_source
        FOREIGN KEY (corpus_source_id) REFERENCES corpus_sources(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT uq_vocab_entries_corpus_source_id UNIQUE (corpus, source_id),

    CONSTRAINT ck_vocab_entries_korean_required CHECK (
        entry_type <> 'word' OR korean IS NOT NULL
    ),

    -- SF-2 (A2 review): source JSON occasionally carries `notes` as a bare
    -- string (subsection-opener marker text). Allow scalar strings as well
    -- as arrays — content-shape validation is the loader's job. `tips` and
    -- `cross_refs` are still arrays-only by source contract.
    CONSTRAINT ck_vocab_entries_jsonb_arrays CHECK (
        jsonb_typeof(tips)       = 'array' AND
        jsonb_typeof(cross_refs) = 'array' AND
        jsonb_typeof(notes)      IN ('array', 'string')
    ),

    -- SF-1 (A2 review): proficiency is required for `word` rows, optional
    -- for navigational rows (theme_intro / subsection_intro / reference).
    -- Word rows are the SRS queue source; missing proficiency on a word
    -- would silently drop the row out of every level-filtered queue.
    CONSTRAINT ck_vocab_entries_proficiency_required CHECK (
        entry_type <> 'word' OR proficiency IS NOT NULL
    ),

    CONSTRAINT ck_vocab_entries_corpus_vocab_only CHECK (
        corpus IN ('vocab_2000_beginner', 'vocab_2000_intermediate')
    ),

    CONSTRAINT ck_vocab_entries_level_matches_corpus CHECK (
        (corpus = 'vocab_2000_beginner'     AND book_level = 'beginner')     OR
        (corpus = 'vocab_2000_intermediate' AND book_level = 'intermediate')
    )
);

COMMENT ON TABLE vocab_entries IS
    'Unified 2000-Words vocabulary source table (Beginner + Intermediate). '
    'Each row is a single dictionary entry plus its inline metadata (POS, '
    'hanja, pronunciation, form variants, one example sentence). Word↔word '
    'relations are modeled in vocab_entry_relations.';

COMMENT ON COLUMN vocab_entries.corpus_source_id IS 'FK → corpus_sources for provenance.';
COMMENT ON COLUMN vocab_entries.corpus           IS 'Denormalized; CHECK enforces vocab_2000_* only.';
COMMENT ON COLUMN vocab_entries.source_id        IS 'Stable id from JSON (e.g. "vocab-int-0001"). UNIQUE per corpus.';
COMMENT ON COLUMN vocab_entries.entry_type       IS 'word (vast majority), theme_intro, subsection_intro.';
COMMENT ON COLUMN vocab_entries.theme            IS 'Top-level theme label (e.g. "01 인간 / People").';
COMMENT ON COLUMN vocab_entries.subsection       IS 'Subsection label (e.g. "1 감정 / Emotions"). NULL for theme_intro rows.';
COMMENT ON COLUMN vocab_entries.korean           IS 'Korean headword. Required for `word` rows (CHECK).';
COMMENT ON COLUMN vocab_entries.english          IS 'Printed English gloss.';
COMMENT ON COLUMN vocab_entries.pronunciation    IS 'Pronunciation in brackets, e.g. "[가족]".';
COMMENT ON COLUMN vocab_entries.hanja            IS 'Chinese-character gloss as printed. Free TEXT — NOT a join key.';
COMMENT ON COLUMN vocab_entries.japanese         IS 'Japanese gloss as printed (Beginner book lacks for some entries — nullable).';
COMMENT ON COLUMN vocab_entries.part_of_speech   IS 'POS string. TEXT (not enum) because real entries carry composite values like "noun, adverb" / "adverb/noun" — loader can normalize later.';
COMMENT ON COLUMN vocab_entries.case_marker      IS 'Verb-case template printed before the headword (e.g. "-에/에게 감동하다").';
COMMENT ON COLUMN vocab_entries.irregular_class  IS 'Irregular-conjugation class if marked (e.g. "ㅂ-irregular").';
COMMENT ON COLUMN vocab_entries.passive_form     IS '피 marker: passive form printed inline. Denormalized convenience; canonical word↔word link is vocab_entry_relations.';
COMMENT ON COLUMN vocab_entries.causative_form   IS '사 marker.';
COMMENT ON COLUMN vocab_entries.basic_form       IS '본 marker (base form for passive/causative entries).';
COMMENT ON COLUMN vocab_entries.honorific_form   IS '높 marker.';
COMMENT ON COLUMN vocab_entries.humble_form      IS '낮 marker.';
COMMENT ON COLUMN vocab_entries.contracted_form  IS '준 marker.';
COMMENT ON COLUMN vocab_entries.tips             IS 'JSONB array of strings — light-bulb (💡) usage notes.';
COMMENT ON COLUMN vocab_entries.cross_refs       IS 'JSONB array of {label, page} pointing to Appendix or other pages.';
COMMENT ON COLUMN vocab_entries.notes            IS 'JSONB array of strings OR a bare string — source JSON carries both shapes (array for theme/subsection-intro contents lists, bare string for subsection-opener markers like "Subsection 6 opener — 인생 Life"). Loader preserves source shape.';
COMMENT ON COLUMN vocab_entries.proficiency      IS 'TOPIK proficiency tag. Required for `word` rows (enforced by ck_vocab_entries_proficiency_required); nullable for navigational rows (theme_intro / subsection_intro / reference) which carry no proficiency in source JSON.';
COMMENT ON COLUMN vocab_entries.search_tsv       IS 'Maintained by trg_vocab_entries_tsv. Sources: korean + english + example_korean + example_english. Config `simple` — ADR-006.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_entries_id_corpus_source
    ON vocab_entries (id, corpus, source_id);

DROP TRIGGER IF EXISTS trg_vocab_entries_updated_at ON vocab_entries;
CREATE TRIGGER trg_vocab_entries_updated_at
    BEFORE UPDATE ON vocab_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION vocab_entries_tsv_refresh()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', coalesce(NEW.korean, '')),          'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.english, '')),         'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.example_korean, '')),  'C') ||
        setweight(to_tsvector('simple', coalesce(NEW.example_english, '')), 'D');
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION vocab_entries_tsv_refresh() IS
    'tsvector maintenance for vocab_entries. Weights: korean=A, english=B, '
    'example_korean=C, example_english=D. Config `simple` — Phase-B Kiwi will '
    'replace with morphologically segmented Korean input (ADR-006).';

DROP TRIGGER IF EXISTS trg_vocab_entries_tsv ON vocab_entries;
CREATE TRIGGER trg_vocab_entries_tsv
    BEFORE INSERT OR UPDATE OF korean, english, example_korean, example_english
    ON vocab_entries
    FOR EACH ROW EXECUTE FUNCTION vocab_entries_tsv_refresh();

CREATE INDEX IF NOT EXISTS ix_vocab_entries_search_tsv
    ON vocab_entries USING GIN (search_tsv);
COMMENT ON INDEX ix_vocab_entries_search_tsv IS
    'GIN over search_tsv. Query: vocab full-text search (Reference page; '
    '"have I seen this word?" lookups in tap-a-word flow before Kiwi+KRDICT).';

CREATE INDEX IF NOT EXISTS ix_vocab_entries_korean
    ON vocab_entries (korean)
    WHERE entry_type = 'word' AND korean IS NOT NULL;
COMMENT ON INDEX ix_vocab_entries_korean IS
    'Partial B-tree on korean for `word` rows. Query: exact-headword lookup '
    '(e.g. "does 가족 exist in the corpus?"), faster than the tsvector path.';

CREATE INDEX IF NOT EXISTS ix_vocab_entries_corpus_level_prof
    ON vocab_entries (corpus, book_level, proficiency);
COMMENT ON INDEX ix_vocab_entries_corpus_level_prof IS
    'Query: filter Vocab Reference by corpus+level+proficiency.';

CREATE INDEX IF NOT EXISTS ix_vocab_entries_theme_subsection
    ON vocab_entries (theme, subsection)
    WHERE theme IS NOT NULL;
COMMENT ON INDEX ix_vocab_entries_theme_subsection IS
    'Query: render a theme/subsection page in order. Theme/subsection are '
    'nullable only on root rows.';

CREATE INDEX IF NOT EXISTS ix_vocab_entries_domain_proficiency
    ON vocab_entries (domain, proficiency)
    WHERE entry_type = 'word';
COMMENT ON INDEX ix_vocab_entries_domain_proficiency IS
    'Partial index on word rows. Query: SRS queue assembly filtered by domain '
    '+ proficiency (DESIGN_SPEC content-tagging model).';


-- -----------------------------------------------------------------------------
-- 6. vocab_entry_relations — hybrid-target word↔word relations. See ADR-007.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vocab_entry_relations (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_entry_id    BIGINT NOT NULL,
    relation_type      vocab_relation_type NOT NULL,

    -- Hybrid target: at least one of (target_entry_id, target_korean) must be set.
    target_entry_id    BIGINT,
    target_korean      TEXT,
    target_english     TEXT,
    target_page        INTEGER,

    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INT    NOT NULL DEFAULT 1,

    CONSTRAINT fk_vocab_entry_relations_source
        FOREIGN KEY (source_entry_id) REFERENCES vocab_entries(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_vocab_entry_relations_target
        FOREIGN KEY (target_entry_id) REFERENCES vocab_entries(id)
        ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT ck_vocab_entry_relations_target_present CHECK (
        target_entry_id IS NOT NULL OR target_korean IS NOT NULL
    ),
    CONSTRAINT ck_vocab_entry_relations_no_self CHECK (
        target_entry_id IS NULL OR target_entry_id <> source_entry_id
    ),
    CONSTRAINT ck_vocab_entry_relations_page_nonneg CHECK (
        target_page IS NULL OR target_page >= 0
    )
);

COMMENT ON TABLE vocab_entry_relations IS
    'Directed word↔word relations (synonym, antonym, related, reference, '
    'passive_form, causative_form, basic_form, honorific_form, humble_form, '
    'contracted_form). Hybrid target (FK OR text) per ADR-007. '
    'ON DELETE CASCADE for source (relation has no meaning without source). '
    'ON DELETE SET NULL for target (preserves the text label).';
COMMENT ON COLUMN vocab_entry_relations.source_entry_id IS 'FK → vocab_entries.id, the entry whose card displays this relation.';
COMMENT ON COLUMN vocab_entry_relations.relation_type   IS 'Kind of relation (enum vocab_relation_type).';
COMMENT ON COLUMN vocab_entry_relations.target_entry_id IS 'FK → vocab_entries.id when target is also captured. NULL means text-only target.';
COMMENT ON COLUMN vocab_entry_relations.target_korean   IS 'Free-text Korean form of the target. Always populated by the loader; FK upgraded by a later resolve pass.';
COMMENT ON COLUMN vocab_entry_relations.target_english  IS 'Free-text English gloss of the target.';
COMMENT ON COLUMN vocab_entry_relations.target_page     IS 'Book page where the target is defined, if printed.';
COMMENT ON COLUMN vocab_entry_relations.note            IS 'Optional usage note distinguishing this relation from siblings.';

DROP TRIGGER IF EXISTS trg_vocab_entry_relations_updated_at ON vocab_entry_relations;
CREATE TRIGGER trg_vocab_entry_relations_updated_at
    BEFORE UPDATE ON vocab_entry_relations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_vocab_entry_relations_source
    ON vocab_entry_relations (source_entry_id, relation_type);
COMMENT ON INDEX ix_vocab_entry_relations_source IS
    'Query: render all relations for entry X grouped by type (vocab detail page).';

CREATE INDEX IF NOT EXISTS ix_vocab_entry_relations_target
    ON vocab_entry_relations (target_entry_id, relation_type)
    WHERE target_entry_id IS NOT NULL;
COMMENT ON INDEX ix_vocab_entry_relations_target IS
    'Partial — most rows have a captured FK target. Query: reverse lookup '
    '"who points at this entry?" (synonym-cluster rendering, orphan checks).';

CREATE INDEX IF NOT EXISTS ix_vocab_entry_relations_target_korean_lower
    ON vocab_entry_relations ((lower(target_korean)))
    WHERE target_korean IS NOT NULL AND target_entry_id IS NULL;
COMMENT ON INDEX ix_vocab_entry_relations_target_korean_lower IS
    'Partial expression index on text-only targets — for the loader''s '
    '"can I now resolve this label to a captured entry?" pass after each ingest.';


-- -----------------------------------------------------------------------------
-- 7. hanja_extensions — "Korean through Chinese Characters" mind-maps.
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
-- 8. lets_check_exercises — review-exercise pages with polymorphic parent
--    (kgiu_entry xor vocab_subsection). Discriminator + CHECK keep it sound.
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

    -- Polymorphic-parent integrity: discriminator agrees with which side is
    -- set. SF-4 (A2 review): the vocab side is identified by a (theme,
    -- subsection) TEXT pair — there is no vocab_subsections table to FK
    -- to in Phase A. The trade-off is documented in
    -- ADR-008-kgiu-vs-grammar-entries.md "Phase C bridge" section: a
    -- subsection rename would orphan-by-string until a backfill UPDATE
    -- ran. The CHECK below additionally requires non-empty strings so a
    -- loader bug producing `''` is caught at insert time.
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


-- -----------------------------------------------------------------------------
-- 9. Coordination with A1: add the FK A1 reserved on vocab_cards.vocab_entry_id.
--    A1 declared the column NOT NULL/NULL appropriately but deferred the FK
--    creation until the referenced table (vocab_entries, this migration) exists.
--    Constraint name `fk_vocab_cards_vocab_entry` was reserved in A1 002-coord
--    notes (see README.md and ADR-004-soft-fk-to-corpus in A1's docs).
--
--    ON DELETE RESTRICT — a vocab card carries SRS state and "seen in" context;
--    silently dropping the card when its source entry is removed would lose
--    user data. RESTRICT forces deliberate handling.
--
--    Guarded so 002 can run on a DB where A1 hasn't run yet (dev/test) — in
--    production 001 always runs first.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_name = 'vocab_cards' AND table_schema = current_schema())
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'fk_vocab_cards_vocab_entry') THEN
        ALTER TABLE vocab_cards
            ADD CONSTRAINT fk_vocab_cards_vocab_entry
            FOREIGN KEY (vocab_entry_id) REFERENCES vocab_entries(id)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 10. Seed the 5 corpus_sources rows owned by this migration. Idempotent.
-- -----------------------------------------------------------------------------
INSERT INTO corpus_sources (
    corpus, title, publisher, authors, level, default_proficiency,
    source_path, notes
) VALUES
    ('kgiu_beginner',
     'Korean Grammar in Use: Beginning to Early Intermediate',
     'Darakwon',
     'Ahn Jean-myung, Lee Kyung-ah, Han Hoo-young',
     'beginner', 'basic',
     'tools/ingest/output/grammar_kgiu_beginner.json',
     'Seeded by 002_darakwon_corpora.up.sql. Volatile fields populated by the loader.'),
    ('kgiu_intermediate',
     'Korean Grammar in Use: Intermediate',
     'Darakwon',
     'Ahn Jean-myung, Min Jin-young',
     'intermediate', 'L3',
     'tools/ingest/output/grammar_kgiu_intermediate.json',
     'Seeded by 002_darakwon_corpora.up.sql.'),
    ('kgiu_advanced',
     'Korean Grammar in Use: Advanced',
     'Darakwon',
     'Ahn Jean-myung, Son Eun-hee',
     'advanced', 'L4',
     'tools/ingest/output/grammar_kgiu_advanced.json',
     'Seeded by 002_darakwon_corpora.up.sql.'),
    ('vocab_2000_beginner',
     '2000 Essential Korean Words for Beginners',
     'Darakwon',
     'Ahn Seol-hee, Min Jin-young, Kim Min-sung',
     'beginner', 'basic',
     'tools/ingest/output/vocab_2000_beginner.json',
     'Seeded by 002_darakwon_corpora.up.sql.'),
    ('vocab_2000_intermediate',
     '2000 Essential Korean Words: Intermediate',
     'Darakwon',
     'Shin Hyeon-mi, Lee Hee-jung, Lee Sang-min',
     'intermediate', 'L3',
     'tools/ingest/output/vocab_2000_intermediate.json',
     'Seeded by 002_darakwon_corpora.up.sql.')
ON CONFLICT (corpus) DO UPDATE SET
    title               = EXCLUDED.title,
    publisher           = EXCLUDED.publisher,
    authors             = EXCLUDED.authors,
    level               = EXCLUDED.level,
    default_proficiency = EXCLUDED.default_proficiency,
    source_path         = EXCLUDED.source_path,
    notes               = EXCLUDED.notes,
    updated_at          = now(),
    version             = corpus_sources.version + 1
WHERE
    -- SF-3 (A2 review): only bump version/updated_at when something actually
    -- changed. Without this WHERE, re-applying the migration on an unchanged
    -- DB bumps every row's version unconditionally, breaking idempotency.
    -- `IS DISTINCT FROM` is NULL-safe; the comparison handles each column.
    corpus_sources.title               IS DISTINCT FROM EXCLUDED.title
    OR corpus_sources.publisher        IS DISTINCT FROM EXCLUDED.publisher
    OR corpus_sources.authors          IS DISTINCT FROM EXCLUDED.authors
    OR corpus_sources.level            IS DISTINCT FROM EXCLUDED.level
    OR corpus_sources.default_proficiency IS DISTINCT FROM EXCLUDED.default_proficiency
    OR corpus_sources.source_path      IS DISTINCT FROM EXCLUDED.source_path
    OR corpus_sources.notes            IS DISTINCT FROM EXCLUDED.notes;

-- End of 002_darakwon_corpora.up.sql — runner owns the transaction (ADR-013).
