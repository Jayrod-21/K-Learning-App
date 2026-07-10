-- 051 (down): drop reading_positions + the reading_chapters
-- UNIQUE(id, source_upload_id) added to back its chapter-consistency FK.
--
-- LOSSY but low-stakes: every saved resume position is discarded. A position
-- is pure convenience state ("reopen where I left off") — losing it costs a
-- user one manual scroll, never content. Nothing else references
-- reading_positions, so the drop is self-contained.
--
-- NOTE: `DROP TABLE` here trips migrate.py's destructive gate — rolling back
-- 051 requires --allow-destructive (deliberate: rollback = accepted loss of
-- all resume positions).
--
-- Order matters: drop reading_positions first (its composite chapter FK
-- references the UNIQUE), then the now-unreferenced UNIQUE on reading_chapters
-- (restoring reading_chapters exactly to its 044 shape — `id` remains the PK).
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- 1. The positions table (table drop also removes its trigger + constraints).
DROP TABLE IF EXISTS reading_positions;

-- 2. The UNIQUE that only existed to back reading_positions' composite
--    chapter FK.
ALTER TABLE reading_chapters DROP CONSTRAINT IF EXISTS uq_reading_chapters_id_upload;

-- End of 051_reading_positions.down.sql
