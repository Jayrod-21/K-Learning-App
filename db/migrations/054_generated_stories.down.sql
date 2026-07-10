-- 054 (down): drop generated_stories.
--
-- LOSSY but self-contained: every AI-generated reading story is discarded.
-- Stories are regenerable content (one POST /reading/generate away), not
-- user-authored work — losing them costs a re-generation, never original
-- writing. Nothing else references generated_stories, so the drop reverses
-- 054 completely (table drop also removes its trigger, index, and
-- constraints).
--
-- NOTE: `DROP TABLE` here trips migrate.py's destructive gate — rolling back
-- 054 requires --allow-destructive (deliberate: rollback = accepted loss of
-- the generated-story library).
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DROP TABLE IF EXISTS generated_stories;

-- End of 054_generated_stories.down.sql
