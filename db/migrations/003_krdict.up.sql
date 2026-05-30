-- =============================================================================
-- Migration 003 — KRDICT (National Institute of Korean Language dictionary)
--   UP — apply this to introduce the KRDICT reference schema.
--   Reverse: 003_krdict.down.sql
--   Depends on: 001_core_schema (provides set_updated_at() and the
--               `register_level` enum). Does NOT depend on 002 — KRDICT is
--               independent of the Darakwon corpora.
--
-- Scope:
--   * krdict_entries        — one row per headword
--   * krdict_senses         — multi-sense rows per headword
--   * krdict_examples       — example sentences per sense
--   * krdict_inflections    — conjugation/declension forms per verb/adjective
--   * krdict_source         — provenance row (single row per ingested archive)
--   * krdict_import_state   — loader resume checkpoint
--   * TSVECTOR maintenance triggers per ADR-006 (config 'simple')
--
-- Out of scope (other migrations / agents):
--   * Kiwi-aware FTS — Phase B, sibling column add when Kiwi exists.
--   * The bridge from vocab_cards → krdict_entries — Phase B/C.
--   * Claude enrichment cache — separate migration.
--
-- Senior-engineer-bar checks: BIGINT IDENTITY PKs, TIMESTAMPTZ, TEXT, JSONB,
-- explicit ON DELETE/ON UPDATE, COMMENT on every table/column, indexes named
-- + justified, idempotent DDL.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write. discover_migrations enforces
--   this rule at discovery time.
--
--   Manual application (not recommended in production):
--     psql -v ON_ERROR_STOP=1 -1 -f 003_krdict.up.sql
--   `-1` wraps the file in a transaction without inline BEGIN/COMMIT.
--
-- ADRs:
--   * ADR-015 — schema design rationale
--   * ADR-016 — parser format choice (XML + defusedxml)
--   * ADR-017 — POS taxonomy (TEXT + CHECK, not enum)
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. krdict_source — provenance (one row per ingested archive).
--    Sibling of `corpus_sources` (002). KRDICT is reference data, not a
--    DESIGN_SPEC "corpus" — see ADR-015 §D12.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS krdict_source (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_label    TEXT        NOT NULL,
    source_path     TEXT        NOT NULL,
    source_sha256   TEXT,
    license         TEXT        NOT NULL DEFAULT 'KOGL Type 1 (attribution)',
    license_url     TEXT,
    publisher       TEXT        NOT NULL DEFAULT '국립국어원 (National Institute of Korean Language)',
    publisher_url   TEXT        NOT NULL DEFAULT 'https://krdict.korean.go.kr/',
    item_count      INTEGER,
    extracted_at    DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INT         NOT NULL DEFAULT 1,

    CONSTRAINT uq_krdict_source_label       UNIQUE (source_label),
    -- Note: source_path is intentionally NOT unique. The loader supports
    -- pointing multiple distinct source_labels at the same on-disk archive
    -- (e.g. tagging a re-ingestion with a new vintage label) and the previous
    -- ``UNIQUE (source_path)`` constraint caused the upsert to crash with a
    -- raw Postgres UniqueViolation in that case. See REVIEW_B2.md SF4.
    CONSTRAINT ck_krdict_source_item_count_nonneg
        CHECK (item_count IS NULL OR item_count >= 0),
    CONSTRAINT ck_krdict_source_sha256_format
        CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE krdict_source IS
    'Provenance / catalog row for an ingested KRDICT archive. KRDICT is '
    'reference data (not a learner corpus per DESIGN_SPEC), so it does NOT '
    'live in corpus_sources — see ADR-015 §D12.';
COMMENT ON COLUMN krdict_source.source_label   IS 'Human-readable label, e.g. "KRDICT-2026-Q1". UNIQUE.';
COMMENT ON COLUMN krdict_source.source_path    IS 'Repo-relative path to the source archive directory or file. NOT unique — multiple source_labels can point at the same path (e.g. re-ingest with new vintage label).';
COMMENT ON COLUMN krdict_source.source_sha256  IS 'SHA-256 of the source archive (lowercase hex). CHECK enforces format.';
COMMENT ON COLUMN krdict_source.license        IS 'Source license. KRDICT distributes under KOGL Type 1 (attribution allowed for any use).';
COMMENT ON COLUMN krdict_source.license_url    IS 'Canonical URL of the license terms.';
COMMENT ON COLUMN krdict_source.publisher      IS 'Publishing body — National Institute of Korean Language.';
COMMENT ON COLUMN krdict_source.publisher_url  IS 'Publisher landing page.';
COMMENT ON COLUMN krdict_source.item_count     IS 'Reported entry count for sanity-checking the loader.';
COMMENT ON COLUMN krdict_source.extracted_at   IS 'Date the archive was published/downloaded.';

DROP TRIGGER IF EXISTS trg_krdict_source_updated_at ON krdict_source;
CREATE TRIGGER trg_krdict_source_updated_at
    BEFORE UPDATE ON krdict_source
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. krdict_entries — one row per headword.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS krdict_entries (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Provenance
    krdict_source_id    BIGINT      NOT NULL,
    source_id           TEXT        NOT NULL,
    homograph_index     INT         NOT NULL DEFAULT 0,

    -- Lexical core
    headword            TEXT        NOT NULL,
    pronunciation       TEXT,
    part_of_speech      TEXT,
    hanja               TEXT,
    register            register_level,

    -- Denormalized first-sense definitions (ADR-015 §D5).
    -- These mirror the krdict_senses row at sense_index = 1.
    definition_korean   TEXT,
    definition_english  TEXT,

    -- FTS
    search_tsv          TSVECTOR,

    -- Audit (ADR-001 §D6)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INT         NOT NULL DEFAULT 1,

    CONSTRAINT fk_krdict_entries_source
        FOREIGN KEY (krdict_source_id) REFERENCES krdict_source(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    -- Natural key per ADR-015 §D2: source ID + homograph index. UNIQUE so
    -- the loader's ON CONFLICT clause has something to land on.
    CONSTRAINT uq_krdict_entries_source_id_homograph
        UNIQUE (source_id, homograph_index),

    -- Length sanity bounds (CHECK rather than VARCHAR(n) per ADR-001 §D4).
    -- Headwords are short; pronunciation/hanja modestly so. These bounds
    -- defend against malformed input (DoS via 100MB headword).
    CONSTRAINT ck_krdict_entries_headword_len
        CHECK (length(headword) BETWEEN 1 AND 200),
    CONSTRAINT ck_krdict_entries_pronunciation_len
        CHECK (pronunciation IS NULL OR length(pronunciation) <= 200),
    CONSTRAINT ck_krdict_entries_hanja_len
        CHECK (hanja IS NULL OR length(hanja) <= 200),
    CONSTRAINT ck_krdict_entries_homograph_nonneg
        CHECK (homograph_index >= 0),

    -- POS — open-set TEXT (see ADR-017). Update this CHECK in a small
    -- migration if KRDICT introduces a new value.
    CONSTRAINT ck_krdict_entries_pos CHECK (
        part_of_speech IS NULL OR part_of_speech IN (
            '명사', '대명사', '수사', '동사', '형용사', '관형사',
            '부사', '감탄사', '조사', '어미', '접사',
            '의존 명사', '보조 동사', '보조 형용사', '품사 없음'
        )
    )
);

COMMENT ON TABLE krdict_entries IS
    'KRDICT headword rows — the dictionary spine. Reference data. One row per '
    '(source_id, homograph_index). Stable scalars + denormalized first-sense '
    'definitions for the tap-a-word hot path (ADR-015 §D5).';
COMMENT ON COLUMN krdict_entries.krdict_source_id   IS 'FK → krdict_source provenance row.';
COMMENT ON COLUMN krdict_entries.source_id          IS 'KRDICT-assigned stable entry id. TEXT to defend against upstream type changes.';
COMMENT ON COLUMN krdict_entries.homograph_index    IS 'Disambiguator for headwords sharing a source ID (0 if unambiguous).';
COMMENT ON COLUMN krdict_entries.headword           IS 'The Korean headword as printed in KRDICT.';
COMMENT ON COLUMN krdict_entries.pronunciation      IS 'Pronunciation (Hangul or IPA, as KRDICT publishes). Nullable.';
COMMENT ON COLUMN krdict_entries.part_of_speech     IS 'KRDICT POS label — open set; see ADR-017. CHECK constraint listed in ck_krdict_entries_pos.';
COMMENT ON COLUMN krdict_entries.hanja              IS 'Hanja gloss as printed. Free TEXT — not a join key.';
COMMENT ON COLUMN krdict_entries.register           IS 'Speech-level register tag (enum register_level). NULL when KRDICT doesn''t tag one.';
COMMENT ON COLUMN krdict_entries.definition_korean  IS 'First-sense Korean definition (denormalized convenience copy of krdict_senses[sense_index=1].definition_korean — see ADR-015 §D5).';
COMMENT ON COLUMN krdict_entries.definition_english IS 'First-sense English definition (denormalized convenience).';
COMMENT ON COLUMN krdict_entries.search_tsv         IS 'Maintained by trg_krdict_entries_tsv. Weights: headword=A, pronunciation=B, definition_korean=C, definition_english=D. Config simple — ADR-006.';

DROP TRIGGER IF EXISTS trg_krdict_entries_updated_at ON krdict_entries;
CREATE TRIGGER trg_krdict_entries_updated_at
    BEFORE UPDATE ON krdict_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- tsvector maintenance — pure mechanical (ADR-001 §D12, ADR-006).
CREATE OR REPLACE FUNCTION krdict_entries_tsv_refresh()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('simple', coalesce(NEW.headword, '')),           'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.pronunciation, '')),      'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.definition_korean, '')),  'C') ||
        setweight(to_tsvector('simple', coalesce(NEW.definition_english, '')), 'D');
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION krdict_entries_tsv_refresh() IS
    'tsvector maintenance for krdict_entries. Weights: headword=A, '
    'pronunciation=B, definition_korean=C, definition_english=D. Config '
    'simple — Phase-B Kiwi will replace via sibling column (ADR-006).';

DROP TRIGGER IF EXISTS trg_krdict_entries_tsv ON krdict_entries;
CREATE TRIGGER trg_krdict_entries_tsv
    BEFORE INSERT OR UPDATE OF headword, pronunciation, definition_korean, definition_english
    ON krdict_entries
    FOR EACH ROW EXECUTE FUNCTION krdict_entries_tsv_refresh();

-- Indexes — each named by the query that justifies it (ADR-001 §"Indexing").

CREATE INDEX IF NOT EXISTS ix_krdict_entries_search_tsv
    ON krdict_entries USING GIN (search_tsv);
COMMENT ON INDEX ix_krdict_entries_search_tsv IS
    'GIN over search_tsv. Query: tap-a-word FTS — "find KRDICT entries matching '
    'ts query X" — used by the Reference search and the tap-a-word fallback when '
    'Kiwi-derived exact lemma misses.';

CREATE INDEX IF NOT EXISTS ix_krdict_entries_headword
    ON krdict_entries (headword);
COMMENT ON INDEX ix_krdict_entries_headword IS
    'B-tree on headword. Query: exact-headword lookup (THE tap-a-word hot path '
    '— Kiwi lemmatizes 먹었어요 → 먹다, then this index returns the entry).';

CREATE INDEX IF NOT EXISTS ix_krdict_entries_headword_prefix
    ON krdict_entries (headword text_pattern_ops);
COMMENT ON INDEX ix_krdict_entries_headword_prefix IS
    'B-tree with text_pattern_ops. Query: prefix lookup ("words starting with '
    '먹…") for the search-as-you-type UI. text_pattern_ops is required for '
    'LIKE ''prefix%'' to use the index.';

CREATE INDEX IF NOT EXISTS ix_krdict_entries_pronunciation
    ON krdict_entries (pronunciation)
    WHERE pronunciation IS NOT NULL;
COMMENT ON INDEX ix_krdict_entries_pronunciation IS
    'Partial B-tree. Query: pronunciation lookup ("find entries pronounced [먹따]"). '
    'Partial because a large minority of entries lack a pronunciation field.';

CREATE INDEX IF NOT EXISTS ix_krdict_entries_pos
    ON krdict_entries (part_of_speech)
    WHERE part_of_speech IS NOT NULL;
COMMENT ON INDEX ix_krdict_entries_pos IS
    'Partial B-tree. Query: Reference page POS facet ("show me all 형용사"). '
    'Partial because POS is nullable on older entries.';


-- -----------------------------------------------------------------------------
-- 3. krdict_senses — multi-sense rows per headword.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS krdict_senses (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    krdict_entry_id     BIGINT      NOT NULL,
    sense_index         INT         NOT NULL,

    definition_korean   TEXT        NOT NULL,
    definition_english  TEXT,

    -- Sense-level metadata (KRDICT tags some senses with domain or register
    -- distinct from the entry-level). Free TEXT — KRDICT's sense-level tags
    -- are inconsistent enough not to merit an enum.
    sense_domain        TEXT,
    sense_register      TEXT,

    -- Audit
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INT         NOT NULL DEFAULT 1,

    CONSTRAINT fk_krdict_senses_entry
        FOREIGN KEY (krdict_entry_id) REFERENCES krdict_entries(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT uq_krdict_senses_entry_sense
        UNIQUE (krdict_entry_id, sense_index),

    CONSTRAINT ck_krdict_senses_sense_index_positive
        CHECK (sense_index >= 1),
    CONSTRAINT ck_krdict_senses_definition_korean_len
        CHECK (length(definition_korean) BETWEEN 1 AND 8000),
    CONSTRAINT ck_krdict_senses_definition_english_len
        CHECK (definition_english IS NULL OR length(definition_english) <= 8000)
);

COMMENT ON TABLE krdict_senses IS
    'Per-sense rows for a KRDICT entry. A monosemous entry still has one row '
    'here for shape consistency. Sense 1''s definitions are mirrored on '
    'krdict_entries for the hot-path fetch (ADR-015 §D5).';
COMMENT ON COLUMN krdict_senses.krdict_entry_id    IS 'FK → krdict_entries.id. CASCADE delete (sense has no meaning without entry).';
COMMENT ON COLUMN krdict_senses.sense_index        IS 'KRDICT sense ordinal, 1-based. UNIQUE per entry.';
COMMENT ON COLUMN krdict_senses.definition_korean  IS 'Korean definition for this sense. NOT NULL — every sense has one.';
COMMENT ON COLUMN krdict_senses.definition_english IS 'English definition for this sense. NULLABLE — older / less-frequent senses lack one.';
COMMENT ON COLUMN krdict_senses.sense_domain       IS 'Domain tag if KRDICT attaches one to this sense (free TEXT, no enum).';
COMMENT ON COLUMN krdict_senses.sense_register     IS 'Register tag if KRDICT attaches one to this sense (free TEXT, not register_level — inconsistent values).';

DROP TRIGGER IF EXISTS trg_krdict_senses_updated_at ON krdict_senses;
CREATE TRIGGER trg_krdict_senses_updated_at
    BEFORE UPDATE ON krdict_senses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_krdict_senses_entry
    ON krdict_senses (krdict_entry_id, sense_index);
COMMENT ON INDEX ix_krdict_senses_entry IS
    'Composite B-tree. Query: fetch all senses for an entry in display order '
    '(the "i" drawer). Also serves the natural-key lookup.';


-- -----------------------------------------------------------------------------
-- 4. krdict_examples — example sentences per sense.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS krdict_examples (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    krdict_sense_id   BIGINT      NOT NULL,
    example_index     INT         NOT NULL,

    korean            TEXT        NOT NULL,
    english           TEXT,

    -- KRDICT tags some examples by sentence type (sentence, dialogue, etc.)
    example_type      TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INT         NOT NULL DEFAULT 1,

    CONSTRAINT fk_krdict_examples_sense
        FOREIGN KEY (krdict_sense_id) REFERENCES krdict_senses(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT uq_krdict_examples_sense_index
        UNIQUE (krdict_sense_id, example_index),

    CONSTRAINT ck_krdict_examples_example_index_positive
        CHECK (example_index >= 1),
    CONSTRAINT ck_krdict_examples_korean_len
        CHECK (length(korean) BETWEEN 1 AND 4000),
    CONSTRAINT ck_krdict_examples_english_len
        CHECK (english IS NULL OR length(english) <= 4000)
);

COMMENT ON TABLE krdict_examples IS
    'Example sentences for a KRDICT sense. korean is required; english is '
    'often missing on lower-frequency senses. Rendered in the "i" drawer.';
COMMENT ON COLUMN krdict_examples.krdict_sense_id IS 'FK → krdict_senses.id. CASCADE delete.';
COMMENT ON COLUMN krdict_examples.example_index   IS 'Ordinal within the sense, 1-based.';
COMMENT ON COLUMN krdict_examples.korean          IS 'Korean example sentence. NOT NULL.';
COMMENT ON COLUMN krdict_examples.english         IS 'English translation. Nullable — KRDICT often omits.';
COMMENT ON COLUMN krdict_examples.example_type    IS 'Optional KRDICT category (e.g. "문장", "대화"). Free TEXT.';

DROP TRIGGER IF EXISTS trg_krdict_examples_updated_at ON krdict_examples;
CREATE TRIGGER trg_krdict_examples_updated_at
    BEFORE UPDATE ON krdict_examples
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_krdict_examples_sense
    ON krdict_examples (krdict_sense_id, example_index);
COMMENT ON INDEX ix_krdict_examples_sense IS
    'Composite B-tree. Query: fetch all examples for a sense in order.';


-- -----------------------------------------------------------------------------
-- 5. krdict_inflections — verb/adjective conjugation forms per entry.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS krdict_inflections (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    krdict_entry_id   BIGINT      NOT NULL,
    order_index       INT         NOT NULL,

    surface_form      TEXT        NOT NULL,
    inflection_label  TEXT        NOT NULL,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INT         NOT NULL DEFAULT 1,

    CONSTRAINT fk_krdict_inflections_entry
        FOREIGN KEY (krdict_entry_id) REFERENCES krdict_entries(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT uq_krdict_inflections_entry_order
        UNIQUE (krdict_entry_id, order_index),

    -- A single (entry, surface, label) triple must be unique — defends
    -- against the parser emitting duplicates from a malformed source.
    CONSTRAINT uq_krdict_inflections_entry_surface_label
        UNIQUE (krdict_entry_id, surface_form, inflection_label),

    CONSTRAINT ck_krdict_inflections_order_nonneg
        CHECK (order_index >= 0),
    CONSTRAINT ck_krdict_inflections_surface_len
        CHECK (length(surface_form) BETWEEN 1 AND 200),
    CONSTRAINT ck_krdict_inflections_label_len
        CHECK (length(inflection_label) BETWEEN 1 AND 200)
);

COMMENT ON TABLE krdict_inflections IS
    'Conjugation / declension table rows from KRDICT, primarily for verbs and '
    'adjectives. Used by the conjugation viewer and as a Kiwi-fallback reverse '
    'lookup (surface form → base entry).';
COMMENT ON COLUMN krdict_inflections.krdict_entry_id  IS 'FK → krdict_entries.id. CASCADE delete.';
COMMENT ON COLUMN krdict_inflections.order_index      IS 'Display order from the source (0-based).';
COMMENT ON COLUMN krdict_inflections.surface_form     IS 'Inflected surface form, e.g. "먹었어요".';
COMMENT ON COLUMN krdict_inflections.inflection_label IS 'KRDICT label, e.g. "과거형 (해요체)" / "past polite informal".';

DROP TRIGGER IF EXISTS trg_krdict_inflections_updated_at ON krdict_inflections;
CREATE TRIGGER trg_krdict_inflections_updated_at
    BEFORE UPDATE ON krdict_inflections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_krdict_inflections_entry
    ON krdict_inflections (krdict_entry_id, order_index);
COMMENT ON INDEX ix_krdict_inflections_entry IS
    'Composite B-tree. Query: render conjugation table for an entry in order.';

CREATE INDEX IF NOT EXISTS ix_krdict_inflections_surface
    ON krdict_inflections (surface_form);
COMMENT ON INDEX ix_krdict_inflections_surface IS
    'B-tree on surface form. Query: reverse lookup (surface → base entry) as '
    'a Kiwi-fallback ("Kiwi missed this form; is it in KRDICT''s table?").';


-- -----------------------------------------------------------------------------
-- 6. krdict_import_state — loader resume checkpoint.
--    One row per (source_label, source_sha256) pair. The loader updates this
--    in the same transaction as the batch it just committed, so a crash
--    leaves last_processed_source_id at the last durably-stored entry.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS krdict_import_state (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_label              TEXT        NOT NULL,
    source_sha256             TEXT        NOT NULL,
    last_processed_source_id  TEXT,
    entries_processed         BIGINT      NOT NULL DEFAULT 0,
    entries_skipped           BIGINT      NOT NULL DEFAULT 0,
    started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checkpoint_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at              TIMESTAMPTZ,
    notes                     TEXT,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    version                   INT         NOT NULL DEFAULT 1,

    CONSTRAINT uq_krdict_import_state_label_sha
        UNIQUE (source_label, source_sha256),
    CONSTRAINT ck_krdict_import_state_counts_nonneg
        CHECK (entries_processed >= 0 AND entries_skipped >= 0),
    CONSTRAINT ck_krdict_import_state_sha_format
        CHECK (source_sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE krdict_import_state IS
    'Resume checkpoint for the KRDICT loader. One row per (source_label, sha256) '
    'pair. The loader writes here in-tx with each committed batch.';
COMMENT ON COLUMN krdict_import_state.source_label             IS 'Matches krdict_source.source_label.';
COMMENT ON COLUMN krdict_import_state.source_sha256            IS 'SHA-256 of the source archive — rebooting on a different archive yields a different row.';
COMMENT ON COLUMN krdict_import_state.last_processed_source_id IS 'Highest-processed KRDICT source_id (TEXT). NULL means "nothing yet".';
COMMENT ON COLUMN krdict_import_state.entries_processed        IS 'Total entries upserted in this run.';
COMMENT ON COLUMN krdict_import_state.entries_skipped          IS 'Total entries skipped due to malformed input (loader logs each one).';
COMMENT ON COLUMN krdict_import_state.completed_at             IS 'Set when the loader reaches end-of-input cleanly. NULL means still running or crashed.';

DROP TRIGGER IF EXISTS trg_krdict_import_state_updated_at ON krdict_import_state;
CREATE TRIGGER trg_krdict_import_state_updated_at
    BEFORE UPDATE ON krdict_import_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS ix_krdict_import_state_label
    ON krdict_import_state (source_label, last_checkpoint_at DESC);
COMMENT ON INDEX ix_krdict_import_state_label IS
    'Query: "what was the most recent checkpoint for source_label X?" — the '
    'loader''s resume path.';

-- End of 003_krdict.up.sql — runner owns the transaction (ADR-013).
