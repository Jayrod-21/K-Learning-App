-- =============================================================================
-- Migration 016 — Hanja goes live (Pass 7)
--   UP — adds the Hanja reference corpus + per-user progress so the Hanja
--        screen runs on real data instead of mocks:
--          * `hanja_characters`  — shared reference data (one row per character)
--          * `hanja_compounds`   — words that contain a character (child)
--          * `hanja_progress`    — per-user new/practicing/banked state
--        and extends the `corpus` enum with `'hanja'` so the corpus loader's
--        `corpus_sources` upsert + `load_state` checkpoint can tag this corpus
--        (see "ENUM EXTENSION" below).
--   Reverse: 016_hanja.down.sql
--   Depends on: 001_core_schema (users, set_updated_at(), the `corpus` enum),
--               002_darakwon_corpora (defines corpus_sources keyed on `corpus`;
--               the loader writes a hanja corpus_sources row — hence the enum
--               value must exist).
--
-- DESIGN NOTES
--   * `hanja_characters` / `hanja_compounds` are SHARED reference data — no
--     `user_id`, no `deleted_at`. A corpus reload retires-by-overwrite: the
--     loader upserts each character `ON CONFLICT (char)` and replaces a
--     character's compounds wholesale, so stale rows never accumulate without a
--     soft-delete column (Bar §1 "Soft delete for data with historical value";
--     reference data has none — it is regenerated from `hanja.json`).
--   * `hanja_progress` is PER-USER state (FK to `users`, CASCADE). `UNIQUE
--     (user_id, char)` makes the screen's bank/practice toggle an idempotent
--     UPSERT target (`ON CONFLICT (user_id, char) DO UPDATE`), never a duplicate
--     insert. It is NOT reference data and carries no `deleted_at` — clearing
--     progress is a delete, not a soft-delete.
--   * `hanja_progress.char` is TEXT, NOT a FK to `hanja_characters(char)`. This
--     is deliberate: progress must SURVIVE a corpus reload. The build is
--     reproducible (`build_hanja.py` re-derives the set from the vocab corpora);
--     a future rebuild could drop a character that a user had already banked. A
--     FK with `ON DELETE CASCADE` would silently erase that user's progress on
--     reload; `ON DELETE RESTRICT` would block the reload entirely. Decoupling
--     the two — progress keyed on the character TEXT, validated by the route to
--     a single hanja codepoint — keeps user state durable across corpus
--     regenerations. The cost (a progress row can reference a char no longer in
--     the corpus) is acceptable: the list endpoint LEFT JOINs from
--     `hanja_characters`, so an orphan progress row simply never surfaces until
--     its character returns.
--   * `level` is TEXT + CHECK (`L2`/`L3`/`L4`/`L5`) rather than the
--     `proficiency_level` enum (`basic`/`L3`/`L4`/`L5+`): the hanja corpus bands
--     characters on a DIFFERENT axis (vocab-frequency tier, where `L2` exists
--     and `L5+` does not) and the client `LevelLabel` renders these strings
--     verbatim. A bespoke CHECK matches the corpus exactly without overloading
--     the speech-level enum. Today's `hanja.json` carries only L2/L3/L4; L5 is
--     allowed for forward compatibility with a deeper future build.
--
-- ENUM EXTENSION — `corpus` gains `'hanja'`
--   The loader (`tools/ingest/loaders/load_hanja.py`) reuses the shared
--   `upsert_corpus_source` / `get_or_create_checkpoint` helpers, both of which
--   bind the corpus name and cast it `::corpus`. `'hanja'` is NOT one of the
--   001 enum values, so this migration must add it. On PostgreSQL 16 (our
--   target — see docker-compose.yml `postgres:16-alpine`), `ALTER TYPE … ADD
--   VALUE` runs fine inside a transaction block (the pre-12 "cannot run in a
--   transaction" restriction was lifted in PG 12), so the runner-owned
--   transaction (ADR-013) is not a problem. The ONE residual PG caveat — a newly
--   added enum value cannot be USED in the SAME transaction that added it — does
--   not apply here: this migration never inserts a `'hanja'` corpus row; the
--   loader does that later, in a separate process and transaction, long after
--   016 has committed. We mirror migration 002's idempotent guard
--   (`ALTER TYPE … ADD VALUE IF NOT EXISTS`) so re-applying is a no-op.
--   NOTE: the down migration does NOT remove the enum value — PostgreSQL cannot
--   drop an enum value. See the down file for the rationale.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extend the `corpus` enum with 'hanja' (see "ENUM EXTENSION" above).
-- -----------------------------------------------------------------------------
ALTER TYPE corpus ADD VALUE IF NOT EXISTS 'hanja';

-- -----------------------------------------------------------------------------
-- 1. hanja_characters — one row per Korean hanja (shared reference data).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hanja_characters (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- The character itself. Natural key, enforced UNIQUE (Bar §1: natural keys
    -- as UNIQUE, never as the PK). Exactly one codepoint.
    char            TEXT        NOT NULL,

    -- Korean reading (음). Always present in the source.
    sound           TEXT        NOT NULL,

    -- 훈 (Korean meaning gloss). NULLABLE — the v1 build has no primary source
    -- for 훈 and emits "" (the loader stores "" as-is; future builds may fill).
    gloss_kr        TEXT,

    -- English gloss (from Unihan kDefinition). Always present in the source.
    gloss_en        TEXT        NOT NULL,

    -- Stroke count. 1..64 covers every CJK Unified Ideograph (the densest known
    -- character is 64 strokes); a value outside that range signals a bad source.
    strokes         INTEGER     NOT NULL,

    -- How many distinct corpus words this character appears in (popularity). Used
    -- to order the list (most-useful first) and to pick the daily fallback.
    frequency       INTEGER     NOT NULL DEFAULT 0,

    -- Frequency tier the build assigned. CHECK (not the proficiency_level enum)
    -- — see the module DESIGN NOTES. Client LevelLabel renders this verbatim.
    level           TEXT        NOT NULL,

    -- Etymology blurb. NULLABLE — no primary source in v1 (emits ""), same as
    -- gloss_kr.
    etymology       TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT uq_hanja_characters_char
        UNIQUE (char),
    CONSTRAINT ck_hanja_characters_char_single
        CHECK (char_length(char) = 1),
    CONSTRAINT ck_hanja_characters_strokes_range
        CHECK (strokes BETWEEN 1 AND 64),
    CONSTRAINT ck_hanja_characters_frequency_nonneg
        CHECK (frequency >= 0),
    CONSTRAINT ck_hanja_characters_level
        CHECK (level IN ('L2', 'L3', 'L4', 'L5')),
    CONSTRAINT ck_hanja_characters_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE hanja_characters IS
    'Korean hanja reference corpus (built by tools/ingest/build_hanja.py from '
    'the vocab corpora + Unihan). Shared (no user_id), retire-by-overwrite on '
    'reload (loader upserts ON CONFLICT (char)). Powers the Hanja screen.';
COMMENT ON COLUMN hanja_characters.char IS
    'The hanja character. Natural key (UNIQUE). Exactly one codepoint. The DTO '
    'uses it as the stable client `id`.';
COMMENT ON COLUMN hanja_characters.sound IS 'Korean reading (음).';
COMMENT ON COLUMN hanja_characters.gloss_kr IS
    '훈 (Korean meaning). Nullable — v1 build has no primary source and emits "".';
COMMENT ON COLUMN hanja_characters.gloss_en IS 'English gloss (Unihan kDefinition).';
COMMENT ON COLUMN hanja_characters.strokes IS 'Stroke count (1..64).';
COMMENT ON COLUMN hanja_characters.frequency IS
    'Distinct corpus words containing this character. Orders the list (popular '
    'first) and picks the /today fallback.';
COMMENT ON COLUMN hanja_characters.level IS
    'Frequency tier (L2/L3/L4/L5). TEXT + CHECK, NOT the proficiency_level enum '
    '(different axis — L2 exists, L5+ does not). Client LevelLabel renders it.';
COMMENT ON COLUMN hanja_characters.etymology IS
    'Etymology blurb. Nullable — v1 build has no primary source and emits "".';

-- Query: GET /hanja list ORDER BY frequency DESC (most-useful first).
CREATE INDEX IF NOT EXISTS ix_hanja_characters_frequency
    ON hanja_characters (frequency DESC);
COMMENT ON INDEX ix_hanja_characters_frequency IS
    'Supports GET /hanja (ORDER BY frequency DESC) and the /today highest-'
    'frequency fallback pick.';

-- Query: GET /hanja/progress targetL4 count + any future level-filtered browse.
CREATE INDEX IF NOT EXISTS ix_hanja_characters_level
    ON hanja_characters (level);
COMMENT ON INDEX ix_hanja_characters_level IS
    'Supports GET /hanja/progress (count of level=L4 "target band") and a '
    'future level-filtered browse.';

CREATE OR REPLACE TRIGGER trg_hanja_characters_updated_at
    BEFORE UPDATE ON hanja_characters
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. hanja_compounds — words containing a character (child of hanja_characters).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hanja_compounds (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    character_id    BIGINT      NOT NULL,

    -- The Korean word (한글), e.g. "학교".
    word_kr         TEXT        NOT NULL,
    -- The word written in hanja, e.g. "學校".
    word_hanja      TEXT        NOT NULL,
    -- English gloss of the word. NULLABLE — some Unihan-derived words lack one.
    gloss_en        TEXT,
    -- The OTHER character(s) in the word (everything except this row's parent),
    -- e.g. for 學 in 學校 this is "校". Drives the "appears with" cross-links.
    with_chars      TEXT        NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_hanja_compounds_character
        FOREIGN KEY (character_id) REFERENCES hanja_characters(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- A character lists each containing word once. UNIQUE makes a re-load's
    -- duplicate an UPSERT target, not a silent dup (Bar §"Idempotency").
    CONSTRAINT uq_hanja_compounds_character_word
        UNIQUE (character_id, word_kr)
);

COMMENT ON TABLE hanja_compounds IS
    'Words that contain a hanja_characters row. Child (CASCADE on parent delete). '
    'Reloaded wholesale per character by the loader. UNIQUE (character_id, '
    'word_kr) = the upsert target.';
COMMENT ON COLUMN hanja_compounds.word_kr IS 'Korean word (한글), e.g. "학교".';
COMMENT ON COLUMN hanja_compounds.word_hanja IS 'Word in hanja, e.g. "學校".';
COMMENT ON COLUMN hanja_compounds.gloss_en IS
    'English gloss of the word. Nullable — some words lack one.';
COMMENT ON COLUMN hanja_compounds.with_chars IS
    'The other character(s) in the word (all except this row''s parent). Drives '
    'the "appears with" cross-links on the character card.';

-- Query: attach a character's compounds (GET /hanja, GET /hanja/today).
CREATE INDEX IF NOT EXISTS ix_hanja_compounds_character
    ON hanja_compounds (character_id);
COMMENT ON INDEX ix_hanja_compounds_character IS
    'Supports the compound join/aggregation in GET /hanja and GET /hanja/today '
    '(compounds grouped per character_id).';

-- -----------------------------------------------------------------------------
-- 3. hanja_progress — per-user new/practicing/banked state.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hanja_progress (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- The hanja this progress is for. TEXT, NOT a FK to hanja_characters — see
    -- the module DESIGN NOTES ("progress must survive a corpus reload").
    char            TEXT        NOT NULL,

    -- Learning state. Default 'new'; the screen's controls move it forward.
    state           TEXT        NOT NULL DEFAULT 'new',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_hanja_progress_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- One progress row per (user, character) — the UPSERT target for POST
    -- /hanja/:char/state. A user cannot hold two states for one character.
    CONSTRAINT uq_hanja_progress_user_char
        UNIQUE (user_id, char),
    CONSTRAINT ck_hanja_progress_char_single
        CHECK (char_length(char) = 1),
    CONSTRAINT ck_hanja_progress_state
        CHECK (state IN ('new', 'practicing', 'banked')),
    CONSTRAINT ck_hanja_progress_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE hanja_progress IS
    'Per-user hanja learning state. user-scoped (FK CASCADE). UNIQUE (user_id, '
    'char) is the UPSERT target for POST /hanja/:char/state. `char` is TEXT not '
    'a FK so progress survives a corpus reload (see migration module notes).';
COMMENT ON COLUMN hanja_progress.char IS
    'The hanja. Deliberately NOT a FK to hanja_characters — decoupled so a '
    'corpus rebuild that drops/re-adds a character never erases user progress. '
    'Validated to one hanja codepoint at the route layer.';
COMMENT ON COLUMN hanja_progress.state IS
    'Learning state: new (default) / practicing / banked. CHECK-constrained.';

-- Query: GET /hanja list LEFT JOIN this user's progress; GET /hanja/progress
-- counts per state. (user_id, state) matches both the join key and the count.
CREATE INDEX IF NOT EXISTS ix_hanja_progress_user_state
    ON hanja_progress (user_id, state);
COMMENT ON INDEX ix_hanja_progress_user_state IS
    'Supports the per-user progress join (GET /hanja) and the per-state counts '
    '(GET /hanja/progress) — both scope by user_id, the counts group by state.';

CREATE OR REPLACE TRIGGER trg_hanja_progress_updated_at
    BEFORE UPDATE ON hanja_progress
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 016_hanja.up.sql — runner owns the transaction (ADR-013).
