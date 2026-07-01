-- 029 (down): revert the TOPIK tests natural key to (test_number, section).
--
-- NOTE: this DROP + ADD will FAIL if any rows share (test_number, section) across
-- levels — which is exactly the state 029 (up) enables (e.g. TOPIK-I and TOPIK-II
-- reading for the same sitting). That is expected and correct: once both levels
-- are loaded you cannot cleanly narrow the key. The down path is safe on an
-- empty or single-level DB (e.g. the migration test's throwaway container).

ALTER TABLE topik_tests
    DROP CONSTRAINT uq_topik_tests_number_level_section;

ALTER TABLE topik_tests
    ADD CONSTRAINT uq_topik_tests_number_section
        UNIQUE (test_number, section);
