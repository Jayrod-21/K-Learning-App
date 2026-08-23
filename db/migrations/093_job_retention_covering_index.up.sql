-- migrate: non-destructive
-- =============================================================================
-- Migration 093 — job-retention covering indexes (audit follow-up B-043)
--
--   Adds a PARTIAL INDEX to each of the three ephemeral job-ledger tables,
--   matching the exact predicate the retention sweep runs
--   (server/src/services/jobRetention.ts, added Phase 1b audit §1.4):
--
--       DELETE FROM <t>
--        WHERE user_id = $1
--          AND status IN ('done', 'failed')
--          AND finished_at < now() - make_interval(days => $2)
--
--   Before this, the sweep rode the existing (user_id, created_at DESC) index
--   to bound to the caller's rows, then filtered status/finished_at with no
--   index support — a per-user seq-scan on the sweep. Fine at today's row
--   counts, but the sweep exists precisely because these tables grow, so give
--   it a matching index before that growth makes the DELETE slow.
--
--   Shape: PARTIAL on `WHERE status IN ('done','failed')` (only terminal rows —
--   the exact set the sweep touches, keeping the index small), keyed
--   `(user_id, finished_at)` so the planner gets the user-scope equality plus
--   the finished_at range in one index. In-flight ('pending'/'running') rows
--   are excluded, so ordinary writes don't bloat it.
--
--   Non-destructive: purely additive (three CREATE INDEX). Plain CREATE INDEX
--   (not CONCURRENTLY) — the runner wraps each migration in one transaction
--   (ADR-013); these tables are small (per-user job counts), so the brief
--   build lock is a non-issue.
--
--   Reverse: 093_job_retention_covering_index.down.sql
--   Depends on: 076 (audio_transcription_jobs), 081 (story_audio_jobs),
--               083 (story_image_jobs).
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_audio_transcription_jobs_retention
    ON audio_transcription_jobs (user_id, finished_at)
    WHERE status IN ('done', 'failed');
COMMENT ON INDEX ix_audio_transcription_jobs_retention IS
    'Partial index backing the job-retention sweep (jobRetention.ts): '
    'user_id + finished_at over terminal rows only.';

CREATE INDEX IF NOT EXISTS ix_story_audio_jobs_retention
    ON story_audio_jobs (user_id, finished_at)
    WHERE status IN ('done', 'failed');
COMMENT ON INDEX ix_story_audio_jobs_retention IS
    'Partial index backing the job-retention sweep (jobRetention.ts): '
    'user_id + finished_at over terminal rows only.';

CREATE INDEX IF NOT EXISTS ix_story_image_jobs_retention
    ON story_image_jobs (user_id, finished_at)
    WHERE status IN ('done', 'failed');
COMMENT ON INDEX ix_story_image_jobs_retention IS
    'Partial index backing the job-retention sweep (jobRetention.ts): '
    'user_id + finished_at over terminal rows only.';

-- End of 093_job_retention_covering_index.up.sql — runner owns the transaction (ADR-013).
