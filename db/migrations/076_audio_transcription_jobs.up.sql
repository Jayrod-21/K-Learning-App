-- migrate: non-destructive
-- =============================================================================
-- Migration 076 — audio_transcription_jobs (Track A, audio → Listen, A-1)
--   UP — adds `audio_transcription_jobs`: one row per Whisper transcription
--        JOB over an audio_tracks row (074) — the claim/settle/reap jobs
--        table for the A1 in-app worker path. Copies 069's
--        upload_extractions shape (partial-unique live claim, status enum,
--        SET-NULL parent link, denormalized user_id) adapted to
--        per-track transcription. See docs/TRACK_A_AUDIO_PLAN.md §0/§2.
--   Reverse: 076_audio_transcription_jobs.down.sql
--   Depends on: 074_audio_tracks (audio_tracks — the job target),
--               001_core_schema (users, set_updated_at()).
--
-- WHY A JOBS TABLE (069's rationale, adapted)
--   Whisper is a metered, LONG-RUNNING external call — minutes of CPU per
--   30-minute file, far past what a synchronous HTTP request can hold (the
--   plan's §0 headline problem). The job row makes each transcription:
--     * OBSERVABLE — status views read real rows, not logs;
--     * CLAIMABLE — the partial UNIQUE below admits at most ONE live job per
--       track, so a double trigger can never double-run Whisper on the same
--       file;
--     * COST-ACCOUNTABLE — a per-user daily transcription cap sums this
--       user's charged_bytes BEFORE any claim, and a failed job still counts
--       (a cap is a COST control; failures spent CPU too — 069's stance).
--
-- WHY charged_bytes IS SNAPSHOT AT ENQUEUE (069's pages_requested, adapted)
--   Whisper cost scales with audio length, so a per-job-COUNT cap would
--   charge a 10-second clip and a 3-hour file identically. 069 solved the
--   same problem by snapshotting pages_requested into the run row; here the
--   cost proxy KNOWN AT ENQUEUE is the track's byte_size (duration_ms may
--   still be NULL — the worker only learns real duration when it probes the
--   file, far too late for the cap). The enqueue route copies byte_size from
--   the ownership-checked audio_tracks row in the claim transaction. The
--   snapshot — not a join back to the track — is what the cap sums, for the
--   same reason the ledger survives track deletion: after SET NULL orphans
--   a row, the cost magnitude would otherwise be UNRECOVERABLE and the cap
--   silently under-charged. Unbackfillable later; cheap now.
--
-- THE REAP CONTRACT (pinned for the A-2 worker build — 069's stale-run
-- posture, server/src/services/uploadExtract.ts STALE_RUN_MINUTES)
--   A Whisper run crashing mid-job (worker killed, OOM, deploy) leaves a
--   'running' row nothing in-process will ever settle — and under the
--   partial UNIQUE below that 409-bricks the track's re-enqueue FOREVER.
--   The WORKER reaps at the top of each claim poll, before claiming: settle
--   'failed' (with an explanatory error) every row WHERE status = 'running'
--   AND started_at < now() - make_interval(mins => AUDIO_STALE_RUN_MINUTES)
--   — the analog of 069's STALE_RUN_MINUTES, sized well past the longest
--   plausible transcription. Keyed on started_at (stamped at claim, so it is
--   never NULL for a 'running' row); no new column is needed.
--   REAP ONLY 'running', NOT 'pending' — this is the one place 076 must NOT
--   copy 069 verbatim. In 069 'pending' was a reserved, never-real state, so
--   its reaper's `status IN ('pending','running')` was harmless. Here
--   'pending' is the REAL, healthy backlog: an unclaimed job with a NULL
--   started_at that is simply waiting for a free worker, NOT a crash. If the
--   worker is down longer than AUDIO_STALE_RUN_MINUTES, reaping 'pending'
--   would fail-fail the entire queued backlog on restart instead of draining
--   it. A pending job is never "stale"; only a claimed-then-orphaned
--   ('running') job is. A reaped row STAYS in the cap ledger (the CPU was
--   spent); a genuinely live run is younger than the threshold and still 409s.
--
-- THE ORPHANED-PENDING CONTRACT (keeps the pending index honestly small)
--   A 'pending' job whose track is deleted before the worker reaches it is
--   SET NULL'd but keeps status = 'pending' — so it remains in the
--   worker-poll partial index. The worker's contract: on claiming a row
--   whose track_id IS NULL, settle it IMMEDIATELY as 'failed' ("track
--   deleted before transcription started") without invoking Whisper. It
--   leaves the pending index at settle and remains in the cap ledger.
--   Without this rule, NULL-track pending rows would strand in the "stays
--   small" pending index forever, falsifying that claim.
--
-- 'pending' IS A REAL STATE HERE — THE ONE DELIBERATE DEPARTURE FROM 069
--   069 reserved 'pending' for a future queued runner and had its
--   synchronous pipeline claim rows directly as 'running'. THIS table is
--   that future: the A1 worker is a separate process that polls
--   `SELECT … WHERE status = 'pending' ORDER BY created_at
--   FOR UPDATE SKIP LOCKED`, flips the row to 'running', shells out to
--   Whisper, and settles it 'done'/'failed'. So rows are INSERTed as
--   'pending' by the enqueue route and CLAIMED asynchronously — the enum
--   value set matches 069's but every value is live. (The A2 offline loader
--   path bypasses this table entirely and writes 075 segments +
--   audio_tracks.transcript_status directly.)
--
-- WHY THE LEDGER SURVIVES TRACK DELETION (fk track_id ON DELETE SET NULL)
--   audio_tracks rows are hard-deleted with their set. If this FK CASCADEd,
--   deleting a set would erase today's charged job rows and RESET the
--   per-user daily transcription cap on demand (enqueue → delete →
--   re-ingest → enqueue again ≈ cap × the intended CPU budget) — the exact
--   refund-by-deletion hole 069 closes for Vision pages. The cap query sums
--   by the denormalized user_id alone, so a SET-NULL'd (orphaned) job keeps
--   charging the user who spent the CPU. track_id is therefore NULLABLE:
--   NULL means "the track this job charged for was deleted after the fact".
--   The partial UNIQUE claim index is unaffected — it only covers live rows,
--   and Postgres never treats two NULLs as equal, so an orphaned job can
--   neither block nor be blocked by a new claim.
--
-- WHY user_id IS DENORMALIZED
--   The daily cap query ("jobs this user enqueued today") runs on every
--   enqueue. Storing the owner directly avoids a join through audio_tracks
--   on that path and keeps the ledger chargeable after track deletion nulls
--   track_id. The route writes it from the ownership-checked audio_tracks
--   row inside the same transaction (069's pattern), so it can never
--   disagree with the track's owner; the user FK still CASCADEs — a deleted
--   USER takes their cost history with them, which is correct.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum type (closed value set — ADR-001 D8). DO block guards creation so
--    the migration is re-runnable; PG 16 has no CREATE TYPE IF NOT EXISTS for
--    enums (mirrors 069/040's pattern). Unlike 069's
--    upload_extraction_status, EVERY value here is live from day one —
--    'pending' is the worker's real claim queue (see header).
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audio_transcription_status') THEN
        CREATE TYPE audio_transcription_status AS ENUM ('pending', 'running', 'done', 'failed');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. audio_transcription_jobs — one row per Whisper job over a track.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audio_transcription_jobs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- NULLABLE by design: SET NULL on track deletion keeps the cost ledger
    -- intact (see header). Every row is INSERTed with a real track_id.
    track_id     BIGINT,
    user_id      BIGINT                      NOT NULL,

    status       audio_transcription_status  NOT NULL DEFAULT 'pending',

    -- Cost snapshot KNOWN AT ENQUEUE (069's pages_requested, adapted): the
    -- track's byte_size, copied from the ownership-checked audio_tracks row
    -- in the claim transaction. The daily cap sums THIS — never a join back
    -- to the track, which SET NULL may have severed (see header).
    charged_bytes BIGINT                     NOT NULL,

    -- Failure detail (bounded — an error is a summary, not a stack dump).
    error        TEXT,

    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,

    -- Audit columns (ADR-001 D6)
    created_at   TIMESTAMPTZ                 NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ                 NOT NULL DEFAULT now(),
    version      INTEGER                     NOT NULL DEFAULT 1,

    -- SET NULL, NOT CASCADE: the job row is the daily cap's cost ledger — it
    -- must outlive its track or deletion refunds spent CPU budget (see
    -- header "WHY THE LEDGER SURVIVES TRACK DELETION").
    CONSTRAINT fk_audio_transcription_jobs_track
        FOREIGN KEY (track_id) REFERENCES audio_tracks(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT fk_audio_transcription_jobs_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- >= 0, not > 0: the ledger floor stays decoupled from audio_tracks'
    -- own byte_size rule (a cost snapshot must accept whatever the source
    -- column ever legally held).
    CONSTRAINT ck_audio_transcription_jobs_charged_bytes_nonnegative
        CHECK (charged_bytes >= 0),
    CONSTRAINT ck_audio_transcription_jobs_error_length
        CHECK (error IS NULL OR length(error) BETWEEN 1 AND 2000),
    CONSTRAINT ck_audio_transcription_jobs_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE audio_transcription_jobs IS
    'One row per Whisper transcription job over an audio_tracks row (Track '
    'A, A1 worker path): the enqueue INSERT is the claim seed (partial '
    'UNIQUE below: one live job per track), the row is the per-user daily '
    'transcription cap''s cost record (the cap sums charged_bytes), and its '
    'status is the job''s surface for the client. Unlike 069, ''pending'' '
    'is a REAL queue state a separate worker claims via FOR UPDATE SKIP '
    'LOCKED; the worker also reaps stale ''running'' rows past '
    'AUDIO_STALE_RUN_MINUTES (never ''pending'' — that is the healthy backlog) '
    'and immediately fails NULL-track pending rows '
    '(see the up header''s reap + orphaned-pending contracts). Survives its '
    'track''s deletion (track_id SET NULL — the cap ledger must not be '
    'resettable by deleting the set); CASCADEs with its user. The A2 '
    'offline loader bypasses this table entirely.';
COMMENT ON COLUMN audio_transcription_jobs.track_id IS
    'The audio track this job transcribes. NULL = that track was '
    'hard-deleted after the fact (ON DELETE SET NULL) — the row survives as '
    'the user''s daily transcription-cap cost record.';
COMMENT ON COLUMN audio_transcription_jobs.user_id IS
    'Denormalized owner (always equals the track''s user_id — written from '
    'the ownership-checked audio_tracks row in the same transaction, 069''s '
    'pattern). Exists so the per-user daily cap query needs no join and the '
    'ledger stays chargeable after track deletion.';
COMMENT ON COLUMN audio_transcription_jobs.status IS
    'pending (enqueued, awaiting the worker — a REAL state here, unlike '
    '069''s reserved one) -> running (claimed, Whisper in flight) -> done | '
    'failed. The worker claims pending rows with FOR UPDATE SKIP LOCKED and '
    'settles via a status-guarded UPDATE. Worker contracts (up header): a '
    'claimed row whose track_id IS NULL is settled ''failed'' immediately '
    '(track deleted before transcription); ''running'' rows older than '
    'AUDIO_STALE_RUN_MINUTES are reaped ''failed'' at the next poll ('
    '''pending'' is the healthy backlog and is never reaped).';
COMMENT ON COLUMN audio_transcription_jobs.charged_bytes IS
    'The track''s byte_size snapshot at enqueue — the daily transcription '
    'cap''s cost unit (mirrors 069''s pages_requested). Copied from the '
    'ownership-checked audio_tracks row in the claim transaction; NEVER '
    'recomputed by joining the track (SET NULL may have severed it). Failed '
    'and reaped jobs still count (cost control, not a usage meter).';
COMMENT ON COLUMN audio_transcription_jobs.error IS
    'Bounded human-readable failure summary for status = failed. NULL '
    'otherwise.';

-- One LIVE job per track: the enqueue INSERT arbitrates concurrency — a
-- second concurrent enqueue hits this index (23505) and maps to 409, so a
-- double click can never double-run Whisper on the same file (mirrors
-- uq_upload_extractions_upload_live, 069). Orphaned rows (track_id NULL)
-- never collide — NULLs are never equal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audio_transcription_jobs_track_live
    ON audio_transcription_jobs (track_id)
    WHERE status IN ('pending', 'running');
COMMENT ON INDEX uq_audio_transcription_jobs_track_live IS
    'At most one pending/running job per track — the enqueue INSERT is the '
    'concurrency arbiter (the route maps 23505 to 409). Mirrors '
    'uq_upload_extractions_upload_live (069).';

-- Query 1: the per-user daily transcription cap ("jobs enqueued today") and
-- Query 2: the status view (a user's jobs, newest first). Mirrors
-- ix_upload_extractions_user_created (069).
CREATE INDEX IF NOT EXISTS ix_audio_transcription_jobs_user_created
    ON audio_transcription_jobs (user_id, created_at DESC);
COMMENT ON INDEX ix_audio_transcription_jobs_user_created IS
    'Supports the per-user daily transcription-cap sum '
    '(SUM(charged_bytes) WHERE user_id = $1 AND created_at >= today) and '
    'the user''s newest-first job listing.';

-- Query 3: the worker's claim poll — SELECT … WHERE status = 'pending'
-- ORDER BY created_at, id FOR UPDATE SKIP LOCKED. Partial on the pending
-- slice (the queue is tiny relative to the settled ledger, so the index
-- stays hot and cheap) keyed (created_at, id) so the ORDER BY is an index
-- walk — oldest first, with id as a deterministic tiebreak for strict FIFO
-- under equal timestamps (a batch enqueue can land several rows in one
-- clock tick).
CREATE INDEX IF NOT EXISTS ix_audio_transcription_jobs_pending
    ON audio_transcription_jobs (created_at, id)
    WHERE status = 'pending';
COMMENT ON INDEX ix_audio_transcription_jobs_pending IS
    'Partial (pending rows only) — the A1 worker''s claim poll: WHERE '
    'status = ''pending'' ORDER BY created_at, id FOR UPDATE SKIP LOCKED '
    'walks this index oldest-first (id tiebreak = strict FIFO under equal '
    'timestamps) without a sort, and the settled ledger never bloats it.';

CREATE OR REPLACE TRIGGER trg_audio_transcription_jobs_updated_at
    BEFORE UPDATE ON audio_transcription_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 076_audio_transcription_jobs.up.sql — runner owns the transaction (ADR-013).
