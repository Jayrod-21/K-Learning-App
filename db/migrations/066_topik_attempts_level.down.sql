-- migrate: destructive
-- 066 (down): drop the `topik_level` column + its CHECK constraint from
-- `topik_attempts`.
--
-- LOSSY: any real `topik_level` values recorded since 066 (the exact paper
-- an attempt was served from / graded against) are discarded by the DROP
-- COLUMN — F-122's whole point, undone. This is exactly the shape F-088 was
-- written to catch and the legacy keyword-sniff does NOT (DROP COLUMN has no
-- DROP TABLE/SCHEMA/DATABASE or TRUNCATE keyword) — declared destructive
-- explicitly here so --allow-destructive is required regardless of whether
-- the sniff would have caught it.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

ALTER TABLE topik_attempts
    DROP CONSTRAINT IF EXISTS ck_topik_attempts_topik_level;

ALTER TABLE topik_attempts
    DROP COLUMN IF EXISTS topik_level;

-- End of 066_topik_attempts_level.down.sql
