-- 029 (up): TOPIK tests natural key must include the level.
--
-- 005 created `uq_topik_tests_number_section UNIQUE (test_number, section)`. That
-- key cannot distinguish TOPIK I from TOPIK II for the SAME sitting: e.g. the
-- 102nd administration has both a TOPIK-I reading paper and a TOPIK-II reading
-- paper — same test_number (102), same section ('reading'). Under the old key the
-- second file to load silently overwrote the first (ON CONFLICT DO UPDATE).
--
-- The true natural key is (test_number, topik_level, section). `topik_level` is
-- already a NOT NULL column on the table (005), so no data changes are needed —
-- we only widen the unique constraint. load_topik.py's ON CONFLICT target is
-- updated in lockstep.
--
-- Expand/contract: no live-serving code INSERTs into topik_tests — only the
-- manual km-loader does (updated in the same change), so swapping this constraint
-- does not break either blue/green color while the migration applies.

ALTER TABLE topik_tests
    DROP CONSTRAINT uq_topik_tests_number_section;

ALTER TABLE topik_tests
    ADD CONSTRAINT uq_topik_tests_number_level_section
        UNIQUE (test_number, topik_level, section);
