-- 027 (up): KGIU pattern is required only for grammar rows.
--
-- 002 created ck_kgiu_entries_pattern_required as `entry_type = 'intro' OR
-- pattern IS NOT NULL` — i.e. only intro rows could omit a grammar pattern. But
-- the corpus also contains `reference` rows (appendices / answer keys, e.g.
-- kgiu-beg-app-answer-key) that legitimately have no pattern, and the loader
-- aborts the whole corpus load on the first one. Relax the CHECK to allow null
-- pattern for both 'intro' and 'reference'; 'grammar' rows still require one.
--
-- Additive/safe: widening a CHECK can never reject an existing row.

ALTER TABLE kgiu_entries
    DROP CONSTRAINT IF EXISTS ck_kgiu_entries_pattern_required;
ALTER TABLE kgiu_entries
    ADD CONSTRAINT ck_kgiu_entries_pattern_required CHECK (
        entry_type IN ('intro', 'reference') OR pattern IS NOT NULL
    );
