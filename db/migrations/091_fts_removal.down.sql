-- =============================================================================
-- Migration 091 — remove the full-text-search subsystem (DOWN)
--
--   Faithfully restores every object 091 dropped, for the six tables:
--     1. re-add the `search_tsv` tsvector column
--     2. recreate the <t>_tsv_refresh() trigger function (identical setweight
--        weights + `simple` config as migrations 002/003/005)
--     3. recreate the BEFORE INSERT/UPDATE trigger trg_<t>_tsv
--     4. BACKFILL search_tsv for existing rows with the same expression (the
--        trigger only fires on future writes, so a plain re-create would leave
--        pre-existing rows NULL — the backfill makes the rollback byte-faithful
--        to what the original trigger-on-load produced)
--     5. recreate the GIN index ix_<t>_search_tsv and its comment
--
--   The backfill sets search_tsv directly (not a trigger-watched column), so it
--   does not re-fire the tsv trigger; it will bump updated_at via each table's
--   set_updated_at trigger, which is acceptable for an exceptional rollback.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner
-- wraps this body in a single transaction. CREATE INDEX (non-CONCURRENTLY) is
-- transactional.
-- =============================================================================

-- krdict_entries (003) ---------------------------------------------------------
ALTER TABLE krdict_entries ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;
COMMENT ON COLUMN krdict_entries.search_tsv         IS 'Maintained by trg_krdict_entries_tsv. Weights: headword=A, pronunciation=B, definition_korean=C, definition_english=D. Config simple — ADR-006.';

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

UPDATE krdict_entries SET search_tsv =
        setweight(to_tsvector('simple', coalesce(headword, '')),           'A') ||
        setweight(to_tsvector('simple', coalesce(pronunciation, '')),      'B') ||
        setweight(to_tsvector('simple', coalesce(definition_korean, '')),  'C') ||
        setweight(to_tsvector('simple', coalesce(definition_english, '')), 'D');

CREATE INDEX IF NOT EXISTS ix_krdict_entries_search_tsv
    ON krdict_entries USING GIN (search_tsv);
COMMENT ON INDEX ix_krdict_entries_search_tsv IS
    'GIN over search_tsv. Query: tap-a-word FTS — "find KRDICT entries matching '
    'ts query X" — used by the Reference search and the tap-a-word fallback when '
    'Kiwi-derived exact lemma misses.';

-- kgiu_entries (002) -----------------------------------------------------------
ALTER TABLE kgiu_entries ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;
COMMENT ON COLUMN kgiu_entries.search_tsv       IS 'Maintained by trg_kgiu_entries_tsv. Sources: pattern + title_en + explanation + notes. Config: simple (Korean tokenizing deferred to Kiwi — ADR-006).';

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

UPDATE kgiu_entries SET search_tsv =
        setweight(to_tsvector('simple', coalesce(pattern, '')),     'A') ||
        setweight(to_tsvector('simple', coalesce(title_en, '')),    'B') ||
        setweight(to_tsvector('simple', coalesce(explanation, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(notes, '')),       'D');

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_search_tsv
    ON kgiu_entries USING GIN (search_tsv);
COMMENT ON INDEX ix_kgiu_entries_search_tsv IS
    'GIN over search_tsv. Query: tap-a-grammar lookup ("find KGIU entries '
    'matching ts query X"). Used by Grammar bank search and TOPIK Prep weak-'
    'area lookups.';

-- vocab_entries (002) ----------------------------------------------------------
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;
COMMENT ON COLUMN vocab_entries.search_tsv       IS 'Maintained by trg_vocab_entries_tsv. Sources: korean + english + example_korean + example_english. Config `simple` — ADR-006.';

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

UPDATE vocab_entries SET search_tsv =
        setweight(to_tsvector('simple', coalesce(korean, '')),          'A') ||
        setweight(to_tsvector('simple', coalesce(english, '')),         'B') ||
        setweight(to_tsvector('simple', coalesce(example_korean, '')),  'C') ||
        setweight(to_tsvector('simple', coalesce(example_english, '')), 'D');

CREATE INDEX IF NOT EXISTS ix_vocab_entries_search_tsv
    ON vocab_entries USING GIN (search_tsv);
COMMENT ON INDEX ix_vocab_entries_search_tsv IS
    'GIN over search_tsv. Query: vocab full-text search (Reference page; '
    '"have I seen this word?" lookups in tap-a-word flow before Kiwi+KRDICT).';

-- ttmik_sentences (005) --------------------------------------------------------
ALTER TABLE ttmik_sentences ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;
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

UPDATE ttmik_sentences SET search_tsv =
        setweight(to_tsvector('simple', coalesce(korean, '')),  'A') ||
        setweight(to_tsvector('simple', coalesce(english, '')), 'B');

CREATE INDEX IF NOT EXISTS ix_ttmik_sentences_search_tsv
    ON ttmik_sentences USING GIN (search_tsv);
COMMENT ON INDEX ix_ttmik_sentences_search_tsv IS
    'GIN over search_tsv. Query: full-text sentence lookup in tap-a-word/'
    '"have I seen this phrase" flows.';

-- iyagi_sentences (005) --------------------------------------------------------
ALTER TABLE iyagi_sentences ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;

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

UPDATE iyagi_sentences SET search_tsv =
        setweight(to_tsvector('simple', coalesce(korean, '')),  'A') ||
        setweight(to_tsvector('simple', coalesce(english, '')), 'B');

CREATE INDEX IF NOT EXISTS ix_iyagi_sentences_search_tsv
    ON iyagi_sentences USING GIN (search_tsv);
COMMENT ON INDEX ix_iyagi_sentences_search_tsv IS
    'GIN search_tsv — listening transcript lookup.';

-- topik_items (005) ------------------------------------------------------------
ALTER TABLE topik_items ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;

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

UPDATE topik_items SET search_tsv =
        setweight(to_tsvector('simple', coalesce(stem, '')),       'A') ||
        setweight(to_tsvector('simple', coalesce(prompt, '')),     'B') ||
        setweight(to_tsvector('simple', coalesce(instruction, '')),'C');

CREATE INDEX IF NOT EXISTS ix_topik_items_search_tsv
    ON topik_items USING GIN (search_tsv);
COMMENT ON INDEX ix_topik_items_search_tsv IS
    'Search items by stem/prompt text (TOPIK Prep weak-area search).';

-- End of 091_fts_removal.down.sql — runner owns the transaction (ADR-013).
