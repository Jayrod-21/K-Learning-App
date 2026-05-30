-- =============================================================================
-- Migration 009 — Cross-reference resolution support
--   UP — convert kgiu_entry_relations to the hybrid-target pattern,
--        add natural-key UNIQUE constraints on both relations tables so
--        the cross-reference resolver can perform idempotent INSERT … ON
--        CONFLICT DO UPDATE, and add a `resolution_status` column for
--        broken-ref reporting.
--   Reverse: 009_cross_ref_relations.down.sql
--   Depends on: 002_darakwon_corpora (defines kgiu_entry_relations and
--               vocab_entry_relations).
--
-- COORDINATION (parallel Phase-C agents):
--   * C1 (canonical_grammar)          — migration 006
--   * C4 (TOPIK linking)              — migration 008 (taken)
--   * C2 (cross-reference resolver)   — migration 009  ← THIS FILE
--   (007 was reserved for a third concern that wasn't taken; 009 leaves
--    explicit headroom and avoids any chance of stepping on C4.)
--
-- WHY this migration exists:
--   A2's original 002 declared kgiu_entry_relations with
--   `target_entry_id BIGINT NOT NULL`, no hybrid text fallback. That model
--   forces the resolver to either drop unresolvable refs (lose signal) or
--   invent stub kgiu rows (corrupt the dictionary). ADR-007 settled the
--   pattern for vocab and we now apply it to KGIU for the same reasons.
--
--   The unique constraints below give the resolver a natural key for
--   ON CONFLICT — without them, a re-run would duplicate every row.
--
-- ADR reference: ADR-022-cross-reference-resolution.md.
-- ADR-013: NO top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;


-- -----------------------------------------------------------------------------
-- 1. kgiu_entry_relations: relax target_entry_id to NULL and add hybrid columns.
--    Use ALTER TABLE … IF EXISTS so a fresh DB built on migrations 001..008
--    in order ends up structurally identical to one built on 001..002 + 008.
-- -----------------------------------------------------------------------------

ALTER TABLE kgiu_entry_relations
    ALTER COLUMN target_entry_id DROP NOT NULL;

-- Hybrid target columns (mirrors vocab_entry_relations / ADR-007).
ALTER TABLE kgiu_entry_relations
    ADD COLUMN IF NOT EXISTS target_korean       TEXT,
    ADD COLUMN IF NOT EXISTS target_english      TEXT,
    ADD COLUMN IF NOT EXISTS target_page         INTEGER,
    ADD COLUMN IF NOT EXISTS target_source_id    TEXT,
    ADD COLUMN IF NOT EXISTS source_corpus       corpus,
    ADD COLUMN IF NOT EXISTS resolution_status   TEXT NOT NULL DEFAULT 'resolved';

COMMENT ON COLUMN kgiu_entry_relations.target_korean IS
    'Free-text Korean form of the target (e.g. the `with` field from compare_with). '
    'Always populated by the resolver; FK upgraded when the text resolves.';
COMMENT ON COLUMN kgiu_entry_relations.target_english IS
    'Optional English gloss of the target as printed.';
COMMENT ON COLUMN kgiu_entry_relations.target_page IS
    'Book page where the target is defined, if printed alongside the reference.';
COMMENT ON COLUMN kgiu_entry_relations.target_source_id IS
    'When the source text contains a parseable entry id (e.g. "kgiu-beg-u03-01"), '
    'the resolver stores it here even when the target row is not loaded yet. Enables '
    'lazy re-resolve.';
COMMENT ON COLUMN kgiu_entry_relations.source_corpus IS
    'Denormalized corpus of the SOURCE entry. Lets the resolver index '
    '(source_corpus, source_entry_id) without a join and lets reports group by corpus.';
COMMENT ON COLUMN kgiu_entry_relations.resolution_status IS
    'resolved | text_only | broken — written by the resolver. text_only = the '
    'reference is a real label but no kgiu row matches yet; broken = could not '
    'parse the reference at all (kept for forensics, not for UI rendering).';

-- Existing CHECK ck_kgiu_entry_relations_no_self requires NON-NULL on both sides
-- (it's `source <> target`). Switch it to NULL-tolerant.
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_no_self;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT ck_kgiu_entry_relations_no_self CHECK (
        target_entry_id IS NULL OR target_entry_id <> source_entry_id
    );

-- Either FK or text must identify the target (ADR-007 §"Decision").
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_target_present;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT ck_kgiu_entry_relations_target_present CHECK (
        target_entry_id IS NOT NULL OR target_korean IS NOT NULL
            OR target_source_id IS NOT NULL
    );

-- Extend allowed relation_kind values to cover the source-JSON shapes.
-- The text-source cross-references are: related / synonym / antonym /
-- compare_with / cross_ref / reference / passive_form / causative_form /
-- basic_form / honorific_form / humble_form / contracted_form. We keep
-- the prior kinds (parallel_lower_level etc.) for backwards compat.
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_kind;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT ck_kgiu_entry_relations_kind CHECK (
        relation_kind IN (
            'compare_with', 'parallel_lower_level', 'parallel_higher_level',
            'extends', 'contrasts_with', 'used_together_with',
            'related', 'synonym', 'antonym', 'reference', 'cross_ref',
            'passive_form', 'causative_form', 'basic_form',
            'honorific_form', 'humble_form', 'contracted_form'
        )
    );

-- Resolution status is closed-set.
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_resolution_status;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT ck_kgiu_entry_relations_resolution_status CHECK (
        resolution_status IN ('resolved', 'text_only', 'broken')
    );

-- target_page nonneg check — mirror vocab_entry_relations'
-- ck_vocab_entry_relations_page_nonneg (REVIEW_C2 F3 — sibling-table parity).
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_page_nonneg;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT ck_kgiu_entry_relations_page_nonneg CHECK (
        target_page IS NULL OR target_page >= 0
    );

-- Existing UNIQUE (source_entry_id, target_entry_id, relation_kind) doesn't
-- protect text-only rows (target_entry_id NULL → NULL is never equal to NULL).
-- Replace with a natural-key UNIQUE that uses normalized target text so the
-- resolver can ON CONFLICT both flavors.
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS uq_kgiu_entry_relations_triple;

-- Two partial UNIQUE indexes (UNIQUE constraints can't be partial; indexes can):
--   1. (source, relation_kind, target_entry_id) when FK target is set.
--   2. (source, relation_kind, normalized_target_korean) when FK target is NULL.
-- This lets us upsert idempotently against either form without conflict.
DROP INDEX IF EXISTS uq_kgiu_entry_relations_fk;
CREATE UNIQUE INDEX uq_kgiu_entry_relations_fk
    ON kgiu_entry_relations (source_entry_id, relation_kind, target_entry_id)
    WHERE target_entry_id IS NOT NULL;
COMMENT ON INDEX uq_kgiu_entry_relations_fk IS
    'Natural-key UNIQUE for resolver INSERT … ON CONFLICT when target FK is set.';

DROP INDEX IF EXISTS uq_kgiu_entry_relations_text;
CREATE UNIQUE INDEX uq_kgiu_entry_relations_text
    ON kgiu_entry_relations (source_entry_id, relation_kind, lower(target_korean))
    WHERE target_entry_id IS NULL AND target_korean IS NOT NULL;
COMMENT ON INDEX uq_kgiu_entry_relations_text IS
    'Natural-key UNIQUE for resolver INSERT … ON CONFLICT when only text target '
    'is set. Case-folded so "식구" / "  식구  " collapse after normalization.';

-- Drop the old FK on source side that was ON DELETE RESTRICT; the relation
-- has no meaning without its source — switch to CASCADE so source delete
-- removes its relations (vocab side already does this).
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS fk_kgiu_entry_relations_source;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT fk_kgiu_entry_relations_source
        FOREIGN KEY (source_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE CASCADE;

-- Target FK switches to ON DELETE SET NULL (preserve text label per ADR-007).
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS fk_kgiu_entry_relations_target;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT fk_kgiu_entry_relations_target
        FOREIGN KEY (target_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE SET NULL;

-- Index supporting "what's broken in corpus X?" reports.
CREATE INDEX IF NOT EXISTS ix_kgiu_entry_relations_broken
    ON kgiu_entry_relations (source_corpus, resolution_status)
    WHERE resolution_status <> 'resolved';
COMMENT ON INDEX ix_kgiu_entry_relations_broken IS
    'Partial — most rows are resolved. Query: "show broken/text-only refs in corpus X" '
    '(QA + resolver --report-broken-refs).';


-- -----------------------------------------------------------------------------
-- 2. vocab_entry_relations: add unique indexes for the same upsert pattern.
-- -----------------------------------------------------------------------------

ALTER TABLE vocab_entry_relations
    ADD COLUMN IF NOT EXISTS target_source_id  TEXT,
    ADD COLUMN IF NOT EXISTS source_corpus     corpus,
    ADD COLUMN IF NOT EXISTS resolution_status TEXT NOT NULL DEFAULT 'resolved';

COMMENT ON COLUMN vocab_entry_relations.target_source_id IS
    'Parsed source_id of the target when the source text matched the entry-id '
    'pattern (rare for vocab, but reserved for symmetry with kgiu_entry_relations).';
COMMENT ON COLUMN vocab_entry_relations.source_corpus IS
    'Denormalized corpus of the SOURCE entry. Lets the resolver index without a join.';
COMMENT ON COLUMN vocab_entry_relations.resolution_status IS
    'resolved | text_only | broken — same semantics as kgiu_entry_relations.';

ALTER TABLE vocab_entry_relations
    DROP CONSTRAINT IF EXISTS ck_vocab_entry_relations_resolution_status;
ALTER TABLE vocab_entry_relations
    ADD CONSTRAINT ck_vocab_entry_relations_resolution_status CHECK (
        resolution_status IN ('resolved', 'text_only', 'broken')
    );

DROP INDEX IF EXISTS uq_vocab_entry_relations_fk;
CREATE UNIQUE INDEX uq_vocab_entry_relations_fk
    ON vocab_entry_relations (source_entry_id, relation_type, target_entry_id)
    WHERE target_entry_id IS NOT NULL;
COMMENT ON INDEX uq_vocab_entry_relations_fk IS
    'Natural-key UNIQUE for resolver INSERT … ON CONFLICT when target FK is set.';

DROP INDEX IF EXISTS uq_vocab_entry_relations_text;
CREATE UNIQUE INDEX uq_vocab_entry_relations_text
    ON vocab_entry_relations (source_entry_id, relation_type, lower(target_korean))
    WHERE target_entry_id IS NULL AND target_korean IS NOT NULL;
COMMENT ON INDEX uq_vocab_entry_relations_text IS
    'Natural-key UNIQUE for resolver INSERT … ON CONFLICT when only text target '
    'is set. Mirrors uq_kgiu_entry_relations_text.';

CREATE INDEX IF NOT EXISTS ix_vocab_entry_relations_broken
    ON vocab_entry_relations (source_corpus, resolution_status)
    WHERE resolution_status <> 'resolved';
COMMENT ON INDEX ix_vocab_entry_relations_broken IS
    'Partial — most rows are resolved. Query: "show broken/text-only refs in corpus X".';


-- -----------------------------------------------------------------------------
-- 3. resolver_state — checkpoint table for the cross-ref resolver.
--    Independent from `load_state` because the resolver runs over already-loaded
--    corpora; tying it to the loader's checkpoint would conflate two stages.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resolver_state (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    corpus          corpus       NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'pending',
    last_source_id  TEXT,
    entries_seen    INTEGER      NOT NULL DEFAULT 0,
    refs_extracted  INTEGER      NOT NULL DEFAULT 0,
    refs_resolved   INTEGER      NOT NULL DEFAULT 0,
    refs_text_only  INTEGER      NOT NULL DEFAULT 0,
    refs_broken     INTEGER      NOT NULL DEFAULT 0,
    last_error      TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version         INT          NOT NULL DEFAULT 1,

    CONSTRAINT uq_resolver_state_corpus UNIQUE (corpus),
    CONSTRAINT ck_resolver_state_status CHECK (
        status IN ('pending', 'in_progress', 'complete', 'failed')
    ),
    CONSTRAINT ck_resolver_state_counts_nonneg CHECK (
        entries_seen >= 0 AND refs_extracted >= 0 AND refs_resolved >= 0
        AND refs_text_only >= 0 AND refs_broken >= 0
    )
);

COMMENT ON TABLE resolver_state IS
    'Per-corpus checkpoint + counters for tools/ingest/resolve_cross_references.py. '
    'One row per corpus. --resume reads last_source_id to skip already-processed '
    'source entries within the same in_progress run.';

DROP TRIGGER IF EXISTS trg_resolver_state_updated_at ON resolver_state;
CREATE TRIGGER trg_resolver_state_updated_at
    BEFORE UPDATE ON resolver_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. Backfill: set source_corpus on existing relation rows (no-op on a fresh DB,
--    important if migration 002 has already loaded data).
-- -----------------------------------------------------------------------------

UPDATE kgiu_entry_relations r
   SET source_corpus = e.corpus
  FROM kgiu_entries e
 WHERE r.source_entry_id = e.id
   AND r.source_corpus IS NULL;

UPDATE vocab_entry_relations r
   SET source_corpus = e.corpus
  FROM vocab_entries e
 WHERE r.source_entry_id = e.id
   AND r.source_corpus IS NULL;

-- End of 009_cross_ref_relations.up.sql — runner owns the transaction (ADR-013).
