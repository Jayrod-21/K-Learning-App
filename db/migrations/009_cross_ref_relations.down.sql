-- =============================================================================
-- Migration 009 — DOWN. Revert cross-reference resolution support.
--
-- Strategy: drop everything 009 added. The relations tables fall back to A2's
-- 002_darakwon_corpora.up.sql shape (target_entry_id NOT NULL on kgiu side,
-- no hybrid columns, original UNIQUE constraint).
--
-- IMPORTANT: this down migration will FAIL if kgiu_entry_relations contains
-- rows with target_entry_id IS NULL (because we restore the NOT NULL). That
-- failure is the correct behavior — silently dropping resolver output would
-- destroy data. To roll back after the resolver has run, DELETE the text-only
-- rows first (or use `--allow-destructive`-style explicit cleanup).
--
-- ADR-013: NO top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- 1. resolver_state — pure addition, safe to drop.
DROP TABLE IF EXISTS resolver_state;

-- 2. vocab_entry_relations — drop additions.
DROP INDEX IF EXISTS ix_vocab_entry_relations_broken;
DROP INDEX IF EXISTS uq_vocab_entry_relations_text;
DROP INDEX IF EXISTS uq_vocab_entry_relations_fk;

ALTER TABLE vocab_entry_relations
    DROP CONSTRAINT IF EXISTS ck_vocab_entry_relations_resolution_status;
ALTER TABLE vocab_entry_relations
    DROP COLUMN IF EXISTS resolution_status,
    DROP COLUMN IF EXISTS source_corpus,
    DROP COLUMN IF EXISTS target_source_id;

-- 3. kgiu_entry_relations — restore A2's original shape.
DROP INDEX IF EXISTS ix_kgiu_entry_relations_broken;
DROP INDEX IF EXISTS uq_kgiu_entry_relations_text;
DROP INDEX IF EXISTS uq_kgiu_entry_relations_fk;

-- Restore the original UNIQUE constraint over the FK triple. Will fail if
-- there are duplicate (source, target, kind) triples — those are resolver
-- output that must be cleaned up first.
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT uq_kgiu_entry_relations_triple
        UNIQUE (source_entry_id, target_entry_id, relation_kind);

-- Restore the original CHECK ck_kgiu_entry_relations_no_self (strict).
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_target_present;
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_no_self;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT ck_kgiu_entry_relations_no_self CHECK (
        source_entry_id <> target_entry_id
    );

-- Restore the original relation_kind CHECK (no text-source kinds).
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_kind;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT ck_kgiu_entry_relations_kind CHECK (
        relation_kind IN ('compare_with', 'parallel_lower_level', 'parallel_higher_level',
                          'extends', 'contrasts_with', 'used_together_with')
    );

ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_resolution_status;
-- Drop the page-nonneg CHECK before dropping the column it guards.
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS ck_kgiu_entry_relations_page_nonneg;
ALTER TABLE kgiu_entry_relations
    DROP COLUMN IF EXISTS resolution_status,
    DROP COLUMN IF EXISTS source_corpus,
    DROP COLUMN IF EXISTS target_source_id,
    DROP COLUMN IF EXISTS target_page,
    DROP COLUMN IF EXISTS target_english,
    DROP COLUMN IF EXISTS target_korean;

-- Restore NOT NULL on target_entry_id. Fails if any rows have it NULL.
ALTER TABLE kgiu_entry_relations
    ALTER COLUMN target_entry_id SET NOT NULL;

-- Restore the A2 FK behaviors (source RESTRICT, target RESTRICT).
ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS fk_kgiu_entry_relations_source;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT fk_kgiu_entry_relations_source
        FOREIGN KEY (source_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE kgiu_entry_relations
    DROP CONSTRAINT IF EXISTS fk_kgiu_entry_relations_target;
ALTER TABLE kgiu_entry_relations
    ADD CONSTRAINT fk_kgiu_entry_relations_target
        FOREIGN KEY (target_entry_id) REFERENCES kgiu_entries(id)
        ON UPDATE CASCADE ON DELETE RESTRICT;

-- End of 009_cross_ref_relations.down.sql.
