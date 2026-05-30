-- =============================================================================
-- Migration 008 — TOPIK ↔ grammar/vocab dependency linker (Phase C-4)
-- =============================================================================
-- Owner:        Agent C-4 (TOPIK dependency linker)
-- Target:       PostgreSQL 16+
-- Depends on:   001 (foundation: enums, set_updated_at function),
--               002 (kgiu_entries, vocab_entries — link targets),
--               005 (topik_items — link source).
--
-- Scope:        Adds `topik_dependencies` — the join table mapping each TOPIK
--               item to the specific grammar entries (kgiu_entries) and vocab
--               entries (vocab_entries) it tests. Powers:
--                 * "Filter mock test to only items testing -(으)면 family"
--                   (TOPIK Prep study mode — DESIGN_SPEC).
--                 * "Show me weak areas" (gap-map dashboard).
--                 * SRS interleaving — surface TOPIK items when reviewing a
--                   grammar pattern.
--
-- Migration numbering — C-4 coordinates with parallel Phase C agents:
--   * C-1 owns 006 (canonical_grammar).
--   * C-2 owns 009 (cross_reference relations — natural keys + hybrid target).
--   * C-3 is read-only.
--   * 007 was reserved during planning but never claimed; left as an
--     explicit gap so re-numbering downstream is unnecessary.
--   * 010 is the C-fix-pass addendum (manual-override sentinel on
--     kgiu_entries.canonical_grammar_id; REVIEW_C1 SHOULD-FIX-1).
-- This file takes 008 per the prompt's explicit coordination.
--
-- ADR alignment:
--   * ADR-001 §D2 (BIGINT IDENTITY PK), §D3 (TIMESTAMPTZ), §D4 (TEXT not
--     VARCHAR), §D6 (audit columns + updated_at trigger), §D8 (enum for
--     closed value set), §D9 (explicit ON DELETE), §D10 (naming).
--   * ADR-013: NO top-level BEGIN/COMMIT — the runner owns transactions.
--   * ADR-024: confidence model, source taxonomy, XOR shape (see docs/).
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Enum: topik_dependency_type
--    Closed set; the XOR CHECK below ties dep_type to which FK column is set.
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topik_dependency_type') THEN
        CREATE TYPE topik_dependency_type AS ENUM ('grammar', 'vocab');
    END IF;
END $$;

COMMENT ON TYPE topik_dependency_type IS
    'Discriminator on topik_dependencies: which side of the corpus the FK '
    'points to. ''grammar'' rows reference kgiu_entries; ''vocab'' rows '
    'reference vocab_entries. The XOR CHECK enforces the relationship.';


-- -----------------------------------------------------------------------------
-- 2. topik_dependencies
--    One row per (topik_item, dep_target). A single TOPIK item typically
--    tests multiple grammar entries + multiple vocab entries → many rows.
--    Natural key (item, dep_type, grammar_entry_id, vocab_entry_id) makes
--    the linker's writes idempotent without double-bookkeeping.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topik_dependencies (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    topik_item_id     BIGINT       NOT NULL,
    dep_type          topik_dependency_type NOT NULL,

    -- Exactly one of these two is non-NULL (CHECK below). Nullable so the
    -- "other side" doesn't have to be filled with sentinels; ADR-001 §D9
    -- says nullable is an explicit choice, justified — and it is, here:
    -- the XOR makes the row meaningful regardless of which side is NULL.
    grammar_entry_id  BIGINT,
    vocab_entry_id    BIGINT,

    -- Linker self-assessment. NUMERIC(3,2) so 0.00..1.00 is exact (no
    -- floating-point drift); we filter rows by confidence at query time.
    confidence        NUMERIC(3,2) NOT NULL,

    -- Which strategy identified this dep. Drives precedence (highest-
    -- confidence wins on conflict). TEXT (not enum) so adding a strategy
    -- doesn't require a migration — see ADR-024.
    source            TEXT         NOT NULL,

    -- Free-form provenance: the original skill_tag, the matched pattern,
    -- the Claude reasoning excerpt, etc. JSONB per ADR-001 §D5; CHECK
    -- enforces object shape to defend against the linker writing a scalar.
    evidence          JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- Audit columns (ADR-001 §D6)
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version           INT          NOT NULL DEFAULT 1,

    -- Foreign keys ----------------------------------------------------------
    -- ON DELETE CASCADE on topik_items: if a TOPIK item is removed (e.g. on
    -- re-import after an OCR fix), its dependency rows are stale and should
    -- not outlive the item.
    CONSTRAINT fk_topik_dependencies_item
        FOREIGN KEY (topik_item_id) REFERENCES topik_items(id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    -- ON DELETE RESTRICT on the target sides: the corpus reference rows
    -- (kgiu_entries, vocab_entries) are not deleted in normal operation;
    -- if someone tries, force them to deal with the dependencies first
    -- rather than silently orphaning them.
    CONSTRAINT fk_topik_dependencies_grammar
        FOREIGN KEY (grammar_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_topik_dependencies_vocab
        FOREIGN KEY (vocab_entry_id) REFERENCES vocab_entries(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    -- XOR: dep_type 'grammar' ↔ grammar_entry_id non-NULL; same for vocab.
    -- The pair (dep_type, FK columns) is a discriminated union; this CHECK
    -- is the discriminator.
    CONSTRAINT ck_topik_dependencies_xor CHECK (
        (dep_type = 'grammar' AND grammar_entry_id IS NOT NULL AND vocab_entry_id IS NULL)
        OR
        (dep_type = 'vocab'   AND vocab_entry_id   IS NOT NULL AND grammar_entry_id IS NULL)
    ),

    CONSTRAINT ck_topik_dependencies_confidence_range CHECK (
        confidence >= 0.00 AND confidence <= 1.00
    ),

    -- Source taxonomy is open (TEXT) but constrained to known values; new
    -- strategies require updating this CHECK (one-liner migration).
    CONSTRAINT ck_topik_dependencies_source_known CHECK (
        source IN ('skill_tag', 'lemma_match', 'claude_analysis', 'manual')
    ),

    CONSTRAINT ck_topik_dependencies_evidence_object CHECK (
        jsonb_typeof(evidence) = 'object'
    ),

    -- Natural key for idempotent upsert. COALESCE on the nullable FKs so
    -- the UNIQUE works (NULLs are distinct in Postgres UNIQUE by default;
    -- the XOR guarantees exactly one is non-NULL per row, so coalescing
    -- the other to 0 yields a stable, unique tuple).
    -- (We materialize this as a UNIQUE INDEX below — partial constraints on
    -- COALESCE expressions aren't supported as table CONSTRAINTs.)
    CONSTRAINT ck_topik_dependencies_target_one_side CHECK (
        (grammar_entry_id IS NOT NULL)::int + (vocab_entry_id IS NOT NULL)::int = 1
    )
);

COMMENT ON TABLE topik_dependencies IS
    'Maps each TOPIK item to the specific grammar (kgiu_entries) and vocab '
    '(vocab_entries) entries it tests. Powers weak-area filtering, SRS '
    'interleaving, and the gap-map dashboard (DESIGN_SPEC). Populated by '
    'tools/ingest/link_topik_dependencies.py — see TOPIK_LINKING_README.md.';

COMMENT ON COLUMN topik_dependencies.topik_item_id    IS 'FK → topik_items.id. CASCADE so re-imports clean up stale links.';
COMMENT ON COLUMN topik_dependencies.dep_type         IS 'Discriminator: which target table the row points at. XOR CHECK enforced.';
COMMENT ON COLUMN topik_dependencies.grammar_entry_id IS 'FK → kgiu_entries.id when dep_type = ''grammar''; NULL otherwise.';
COMMENT ON COLUMN topik_dependencies.vocab_entry_id   IS 'FK → vocab_entries.id when dep_type = ''vocab''; NULL otherwise.';
COMMENT ON COLUMN topik_dependencies.confidence       IS
    'Linker self-assessment in [0.00, 1.00]. By convention: skill_tag=0.90, '
    'lemma_match=0.75, claude_analysis=per Claude. On natural-key conflict '
    'the higher-confidence row wins (see ADR-024).';
COMMENT ON COLUMN topik_dependencies.source           IS
    'Strategy that identified this dep: skill_tag | lemma_match | '
    'claude_analysis | manual. CHECK enforces the closed set.';
COMMENT ON COLUMN topik_dependencies.evidence         IS
    'JSONB provenance — original skill_tag, matched pattern family, lemma '
    'surface form, Claude reasoning excerpt. Stable scalars are columns.';


-- -----------------------------------------------------------------------------
-- 3. Natural-key unique index (idempotency anchor).
--    COALESCE-coalesced because Postgres treats NULLs as distinct in UNIQUE
--    constraints by default. The XOR check guarantees exactly one FK is
--    non-NULL, so coalescing the other to 0 yields a stable key.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_topik_dependencies_natural_key
    ON topik_dependencies (
        topik_item_id,
        dep_type,
        COALESCE(grammar_entry_id, 0),
        COALESCE(vocab_entry_id,   0)
    );
COMMENT ON INDEX uq_topik_dependencies_natural_key IS
    'Natural key for ON CONFLICT idempotent upserts. Re-running the linker '
    'with the same input produces no new rows; only the higher-confidence '
    'row persists per (item, dep_type, target).';


-- -----------------------------------------------------------------------------
-- 4. Forward-direction index: "what does this TOPIK item test?"
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_topik_dependencies_item
    ON topik_dependencies (topik_item_id, dep_type);
COMMENT ON INDEX ix_topik_dependencies_item IS
    'Forward query: enumerate the grammar+vocab a TOPIK item depends on. '
    'Used by the per-item study-mode "what is this question testing?" view.';


-- -----------------------------------------------------------------------------
-- 5. Reverse-direction indexes: "which TOPIK items test this grammar/vocab?"
--    Two partial indexes — one per dep_type — to keep each tight and the
--    query planner happy. WHERE clause matches the natural query shape.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_topik_dependencies_grammar_target
    ON topik_dependencies (grammar_entry_id, topik_item_id)
    WHERE dep_type = 'grammar';
COMMENT ON INDEX ix_topik_dependencies_grammar_target IS
    'Reverse query: "which TOPIK items test grammar entry X?". Partial '
    '(dep_type=''grammar'') — vocab rows would never qualify.';

CREATE INDEX IF NOT EXISTS ix_topik_dependencies_vocab_target
    ON topik_dependencies (vocab_entry_id, topik_item_id)
    WHERE dep_type = 'vocab';
COMMENT ON INDEX ix_topik_dependencies_vocab_target IS
    'Reverse query: "which TOPIK items test vocab entry X?". Partial '
    '(dep_type=''vocab'') — grammar rows would never qualify.';


-- -----------------------------------------------------------------------------
-- 6. Confidence filter index — most queries want "high-confidence" rows.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_topik_dependencies_confidence
    ON topik_dependencies (confidence DESC, topik_item_id)
    WHERE confidence >= 0.75;
COMMENT ON INDEX ix_topik_dependencies_confidence IS
    'Confidence ≥ 0.75 partial index. Most product queries discard low-'
    'confidence rows; this avoids scanning the full table for them.';


-- -----------------------------------------------------------------------------
-- 7. updated_at trigger (ADR-001 §D6, ADR-001 §D12 — permitted maintenance).
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_topik_dependencies_updated_at ON topik_dependencies;
CREATE TRIGGER trg_topik_dependencies_updated_at
    BEFORE UPDATE ON topik_dependencies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 008_topik_dependencies.up.sql.
