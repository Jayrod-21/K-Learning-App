-- =============================================================================
-- Migration 008 — TOPIK ↔ grammar/vocab dependency linker (DOWN)
-- =============================================================================
-- Reverses 008_topik_dependencies.up.sql cleanly. Drops the table (and the
-- trigger goes with it via CASCADE), then drops the enum type that no other
-- migration references.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — runner owns it.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_topik_dependencies_updated_at ON topik_dependencies;

-- CASCADE drops the indexes (uq + ix_*) and the FK objects.
DROP TABLE IF EXISTS topik_dependencies CASCADE;

-- Enum introduced by this migration. Safe to drop because the table that
-- used it is gone; if any future migration adds a usage of this type, it
-- would re-create it via the same DO $$ … $$ idempotent block we used in
-- the up migration.
DROP TYPE IF EXISTS topik_dependency_type;
