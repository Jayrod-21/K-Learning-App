-- 033 (down): remove grammar_entries.graduated_at.
--
-- Lossy by design: rolling back discards which patterns the user had marked
-- as known — they simply return to active learning (the pre-033 behavior).
-- No dependent objects (no index, no constraint) were created in the up, so
-- a plain DROP COLUMN is complete.

ALTER TABLE grammar_entries
    DROP COLUMN IF EXISTS graduated_at;
