-- 061 (down): drop listening_attempts.
--
-- LOSSY but self-contained: every listening-completion log entry is
-- discarded. Nothing else references listening_attempts (its own FKs point
-- OUT to ttmik_lessons/iyagi_episodes, nothing points IN), so the drop
-- reverses 061 completely (also removes its trigger, indexes, and
-- constraints).
--
-- NOTE: `DROP TABLE` here trips migrate.py's destructive gate — rolling back
-- 061 requires --allow-destructive (deliberate: rollback = accepted loss of
-- the listening-completion history).
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DROP TABLE IF EXISTS listening_attempts;

-- End of 061_listening_attempts.down.sql
