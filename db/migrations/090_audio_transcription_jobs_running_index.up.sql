-- migrate: non-destructive
-- =============================================================================
-- Migration 090 — audio_transcription_jobs reaper index (audit Phase 0.1)
--   UP — adds a PARTIAL INDEX on audio_transcription_jobs (started_at)
--        WHERE status = 'running', matching the exact predicate the A1
--        worker's stale-job reaper runs on every claim poll
--        (tools/audio_stt/worker.py reap_stale):
--          UPDATE audio_transcription_jobs
--             SET status = 'failed', ...
--           WHERE status = 'running'
--             AND started_at < now() - make_interval(mins => %s)
--        Without a matching index the planner has nothing to use but a Seq
--        Scan — measured live at 441,744,717 lifetime tuples read to find
--        zero stale rows (the table is small; the reap query runs on every
--        poll, every worker cycle, forever). The sibling story-job reapers
--        (story_audio_jobs, story_image_jobs) already get a bitmap index
--        scan on an equivalent partial index; this brings
--        audio_transcription_jobs in line.
--   Reverse: 090_audio_transcription_jobs_running_index.down.sql
--   Depends on: 076_audio_transcription_jobs (the table + status enum).
--
-- DESIGN NOTES
--   * PARTIAL on status = 'running': the reap query's WHERE clause exactly.
--     'pending' and settled ('done'/'failed') rows are never scanned by the
--     reaper (076's up header: 'pending' is the healthy backlog, never
--     reaped) so they stay out of this index — it tracks only the live
--     'running' slice, which is tiny relative to the settled ledger.
--   * Single-column (started_at), not (status, started_at): the predicate
--     on status is the partial-index WHERE clause itself, so a second
--     status column in the index key would be redundant — matches the
--     existing pending-queue index's shape (ix_audio_transcription_jobs_pending,
--     076) which also keys only on the columns beyond its WHERE clause.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write. No
--   CONCURRENTLY here — it is forbidden inside a transaction, and the
--   table is small (~982 rows measured live), so a plain CREATE INDEX's
--   brief write lock is acceptable and simpler than a non-transactional
--   migration would be.
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_audio_transcription_jobs_running
    ON audio_transcription_jobs (started_at)
    WHERE status = 'running';

COMMENT ON INDEX ix_audio_transcription_jobs_running IS
    'Backs the A1 worker''s stale-job reaper (tools/audio_stt/worker.py '
    'reap_stale: WHERE status = ''running'' AND started_at < now() - '
    'make_interval(mins => …)), run on every claim poll. Without this the '
    'reaper is a Seq Scan (measured: 441M lifetime tuples read). Partial on '
    'the ''running'' slice only — audit Phase 0.1.';

-- End of 090_audio_transcription_jobs_running_index.up.sql — runner owns the transaction (ADR-013).
