-- 060 (down): drop reading_attempts.
--
-- LOSSY but self-contained: every reading-completion log entry is discarded.
-- Nothing else references reading_attempts (its own FKs point OUT to
-- reading_chapters/generated_stories, nothing points IN), so the drop reverses
-- 060 completely (also removes its trigger, indexes, and constraints).
--
-- NOTE: `DROP TABLE` here trips migrate.py's destructive gate — rolling back
-- 060 requires --allow-destructive (deliberate: rollback = accepted loss of
-- the reading-completion history).
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DROP TABLE IF EXISTS reading_attempts;

-- End of 060_reading_attempts.down.sql
