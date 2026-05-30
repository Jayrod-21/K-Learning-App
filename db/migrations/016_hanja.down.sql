-- =============================================================================
-- Migration 016 — Hanja goes live (DOWN)
--   Reverses 016_hanja.up.sql.
--   Order: drop children before parents so FKs don't block —
--          hanja_progress (FK users), hanja_compounds (FK hanja_characters),
--          then hanja_characters.
--   Idempotent — every DROP is IF EXISTS.
--
-- DO NOT DROP / CANNOT DROP (owned elsewhere or irreversible):
--   - users              (migration 001)
--   - set_updated_at()   (migration 001)
--   - corpus_sources     (migration 002)
--   - the `corpus` enum value 'hanja' — PostgreSQL CANNOT remove an enum value.
--     ALTER TYPE … DROP VALUE does not exist. Leaving the value in place is
--     harmless: nothing references it once the loader-written corpus_sources
--     row is gone, and re-applying the up migration is a no-op (ADD VALUE IF
--     NOT EXISTS). Removing it would require dropping and recreating the whole
--     `corpus` enum and re-pointing every dependent column — far out of scope
--     for a down migration. This matches migration 002's stance (its down drops
--     the table but its ALTER TYPE … ADD VALUE additions to kgiu_entry_type /
--     vocab_entry_type persist in the surviving type). Down leaves the type
--     superset of where it started; the schema is functionally reverted.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps each down body in its own
--   transaction together with the bookkeeping DELETE.
--
-- DESTRUCTIVE: drops tables. `migrate.py` requires `--allow-destructive` to
-- run this down. Per migrations/README.md "Rolling back".
-- =============================================================================

DROP TABLE IF EXISTS hanja_progress;
DROP TABLE IF EXISTS hanja_compounds;
DROP TABLE IF EXISTS hanja_characters;

-- End of 016_hanja.down.sql.
