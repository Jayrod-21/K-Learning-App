-- 030 (down): drop topik_tests.provenance and its CHECK.
--
-- Reverses 030 (up). Dropping the column discards any recorded provenance
-- (note / transcript_* audit text); that is the intended, documented loss of
-- a downgrade — the source JSONs remain the system of record and a re-load
-- repopulates it. Safe on any state: DROP COLUMN takes the column and its
-- dependent CHECK with it.

ALTER TABLE topik_tests
    DROP CONSTRAINT IF EXISTS ck_topik_tests_provenance_object;

ALTER TABLE topik_tests
    DROP COLUMN IF EXISTS provenance;
