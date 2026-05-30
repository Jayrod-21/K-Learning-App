-- =============================================================================
-- Migration 006 — canonical_grammar (Phase C, agent C1)
--   UP — introduces the corpus-agnostic dedup layer for grammar patterns.
--   Reverse: 006_canonical_grammar.down.sql
--   Depends on: 001_core_schema (set_updated_at function), 002_darakwon_corpora
--               (kgiu_entries — adds a nullable FK column on it).
--
-- WHAT IT CREATES:
--   1. Table `canonical_grammar` — one row per dedup key (pattern_key).
--   2. Column `kgiu_entries.canonical_grammar_id` — nullable FK back to (1).
--      NULL is meaningful: "not yet clustered" — the dedup script
--      (cluster_canonical_grammar.py apply) backfills the column.
--   3. Index on the FK column for the join-by-canonical query.
--   4. Index on canonical_grammar(semantic_family) for the Reference UI's
--      browse-by-family facet.
--
-- WHY: KGIU repeats forms across levels (-(으)면 / -아/어도 / -처럼 etc.). The
-- app's tap-a-grammar UX needs ONE pin per form so the dedup highlight in
-- Reference works. ADR-021-canonical-grammar-bank.md captures the A/B/C
-- decision (we chose C: lightweight canonical row, level entries stay in
-- kgiu_entries, FK joins them).
--
-- COORDINATION:
--   * A2's `grammar_entries` (USER-canonical bank) is unchanged. The bridge
--     between user-canonical and source-canonical is Phase D — for now, the
--     app reads canonical_grammar for the dedup key and kgiu_entries for the
--     level-calibrated explanation.
--   * The `notes JSONB` column carries the cluster metadata (aliases,
--     members_per_level, needs_review flag) so the Reference UI can render
--     "appears in: Beginner Unit 16 + Intermediate Ch.11" without re-running
--     the clusterer.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each body in a single transaction together with the
--   schema_migrations bookkeeping write. discover_migrations enforces this
--   rule at discovery time.
--
-- Manual application: psql -v ON_ERROR_STOP=1 -1 -f 006_canonical_grammar.up.sql
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. canonical_grammar — one row per dedup key.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_grammar (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Dedup identity.
    pattern_key       TEXT  NOT NULL,
    canonical_pattern TEXT  NOT NULL,
    semantic_family   TEXT  NOT NULL DEFAULT 'uncategorized',

    -- Cluster metadata (aliases, members_per_level, review flag).
    -- JSONB per ADR-001 §D5. Shape documented in
    -- Repository/tools/ingest/canonical_grammar.py (CanonicalCluster).
    notes             JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Audit columns per ADR-001 §D6.
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INT         NOT NULL DEFAULT 1,

    CONSTRAINT uq_canonical_grammar_pattern_key UNIQUE (pattern_key),

    CONSTRAINT ck_canonical_grammar_pattern_key_nonempty CHECK (
        length(pattern_key) > 0
    ),
    CONSTRAINT ck_canonical_grammar_canonical_pattern_nonempty CHECK (
        length(canonical_pattern) > 0
    ),
    -- Notes must be a JSONB object so downstream queries can safely use ->.
    CONSTRAINT ck_canonical_grammar_notes_object CHECK (
        jsonb_typeof(notes) = 'object'
    )
);

COMMENT ON TABLE canonical_grammar IS
    'Corpus-agnostic canonical grammar entries — one row per normalized '
    'pattern_key. Bridges the multi-level kgiu_entries (Beginner / '
    'Intermediate / Advanced) so the app dedups tap-a-grammar pins. '
    'Populated by tools/ingest/cluster_canonical_grammar.py — re-running '
    'is idempotent. See ADR-021-canonical-grammar-bank.md.';

COMMENT ON COLUMN canonical_grammar.pattern_key IS
    'Normalized dedup key produced by canonical_grammar.normalize_pattern(). '
    'Strips leading A/V/N placeholder + hyphen, NBSP, and trailing circled-'
    'digit ordinals. UNIQUE.';
COMMENT ON COLUMN canonical_grammar.canonical_pattern IS
    'The pattern string presented in the canonical row (longest observed '
    'raw surface — preserves A/V- placeholder + leading hyphen).';
COMMENT ON COLUMN canonical_grammar.semantic_family IS
    'Coarse family tag (e.g. condition / concession / reason / time / voice). '
    'TEXT not enum — values are extensible without a migration (ADR-001 §D8).';
COMMENT ON COLUMN canonical_grammar.notes IS
    'JSONB metadata: { aliases: [str], members_per_level: {beginner: n, ...}, '
    'needs_review: bool, review_reason: str|null, member_count: n }. Shape '
    'mirrors tools/ingest/canonical_grammar.py:CanonicalCluster.notes.';

-- Justify the dedup-lookup access path that the UNIQUE constraint creates
-- (REVIEW_C1 NIT-3). The Reference UI looks every grammar pin up by
-- pattern_key — this is the hottest read path on this table.
COMMENT ON CONSTRAINT uq_canonical_grammar_pattern_key ON canonical_grammar IS
    'Natural-key UNIQUE. Backs the dedup-render lookup '
    '(SELECT id FROM canonical_grammar WHERE pattern_key = ?) used by the '
    'Reference UI for every grammar pin tap, and by '
    'cluster_canonical_grammar.py apply for the upsert ON CONFLICT target.';

-- updated_at trigger (mechanical, per ADR-001 §D12).
DROP TRIGGER IF EXISTS trg_canonical_grammar_updated_at ON canonical_grammar;
CREATE TRIGGER trg_canonical_grammar_updated_at
    BEFORE UPDATE ON canonical_grammar
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Index on semantic_family — Reference UI's "browse by family" facet.
CREATE INDEX IF NOT EXISTS ix_canonical_grammar_semantic_family
    ON canonical_grammar (semantic_family);
COMMENT ON INDEX ix_canonical_grammar_semantic_family IS
    'Query: list canonical entries filtered by semantic_family (Reference '
    'page "browse by family" facet).';


-- -----------------------------------------------------------------------------
-- 2. kgiu_entries.canonical_grammar_id — nullable FK back to canonical_grammar.
--    Nullable because (a) the column is back-filled by a separate script and
--    (b) some rows (intro chapter dividers) genuinely have no canonical form.
--    ADR-001 §D9: SET NULL is the right ON DELETE for a soft reference —
--    deleting a canonical row should not cascade-delete the source kgiu rows,
--    which carry their own per-level pedagogical content.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'kgiu_entries'
          AND column_name = 'canonical_grammar_id'
    ) THEN
        ALTER TABLE kgiu_entries
            ADD COLUMN canonical_grammar_id BIGINT NULL;
    END IF;
END $$;

-- Add the FK constraint idempotently.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_kgiu_entries_canonical_grammar'
    ) THEN
        ALTER TABLE kgiu_entries
            ADD CONSTRAINT fk_kgiu_entries_canonical_grammar
            FOREIGN KEY (canonical_grammar_id) REFERENCES canonical_grammar(id)
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END $$;

COMMENT ON COLUMN kgiu_entries.canonical_grammar_id IS
    'Soft reference to canonical_grammar(id). NULL = "not yet clustered" '
    '(populated by tools/ingest/cluster_canonical_grammar.py apply) OR "no '
    'canonical form" (intros, reference rows). ON DELETE SET NULL: deleting '
    'a canonical row preserves the source kgiu rows untouched.';

CREATE INDEX IF NOT EXISTS ix_kgiu_entries_canonical_grammar_id
    ON kgiu_entries (canonical_grammar_id)
    WHERE canonical_grammar_id IS NOT NULL;
COMMENT ON INDEX ix_kgiu_entries_canonical_grammar_id IS
    'Partial index — most rows have a non-NULL FK after backfill. Query: '
    '"give me every level entry attached to canonical X" (the dedup-render '
    'path in the Reference UI).';


-- End of 006_canonical_grammar.up.sql — runner owns the transaction (ADR-013).
