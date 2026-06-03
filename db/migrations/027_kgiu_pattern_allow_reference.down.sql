-- 027 (down): restore the original (intro-only) pattern constraint.
-- NOTE: this will fail if any `reference` rows with a null pattern exist; remove
-- or backfill them before rolling back (expand/contract caveat).
ALTER TABLE kgiu_entries
    DROP CONSTRAINT IF EXISTS ck_kgiu_entries_pattern_required;
ALTER TABLE kgiu_entries
    ADD CONSTRAINT ck_kgiu_entries_pattern_required CHECK (
        entry_type = 'intro' OR pattern IS NOT NULL
    );
