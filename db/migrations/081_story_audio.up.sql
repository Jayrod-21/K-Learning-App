-- migrate: non-destructive
-- =============================================================================
-- Migration 081 — story audio (F-210, multi-voice TTS groundwork + v1 jobs)
--   UP — wires generated_stories (054) into the Track-A audio stack
--        (073/074/075) so an already-generated story can be VOICED once and
--        listened to with read-along highlighting:
--          §1 generated_stories.turns JSONB — latent multi-voice structure
--             ([{speaker, text}]) newly generated stories may carry; v1's
--             narrator voice reads the flat body_ko and ignores it.
--          §2 UNIQUE (id, user_id) on generated_stories — backs the composite
--             owner FKs below (044 §0's maneuver).
--          §3 audio_sources.kind gains 'generated_story' + a nullable
--             generated_story_id owner-pinned link (one audio set per story).
--          §4 story_audio_jobs — the async TTS job queue/ledger the in-server
--             runner claims (FOR UPDATE SKIP LOCKED), one live job per story,
--             per-user daily cap charged in characters.
--   Reverse: 081_story_audio.down.sql
--   Depends on: 054_generated_stories (generated_stories),
--               073_audio_sources (audio_sources + its kind/link CHECKs),
--               001_core_schema (users, set_updated_at()).
--
-- WHY THE VOICED OUTPUT IS A REAL audio_tracks ROW (no new playback tables)
--   The synthesized narration is stored exactly like every other audio blob:
--   an audio_sources set (kind 'generated_story') holding one audio_tracks
--   row (the mp3 under AUDIO_UPLOAD_STORAGE_DIR) whose
--   audio_transcript_segments carry the [start_ms, end_ms] windows the
--   read-along highlight needs — so GET /audio/tracks/:id/stream (Range,
--   IDOR-404, nosniff) serves story audio with ZERO new streaming surface.
--   This migration only adds the story→set link and the TTS job queue.
--
-- WHY generated_story_id CASCADEs (unlike 073's source_upload_id SET NULL)
--   A paired-reader audio set outlives its book (073: the Whisper transcripts
--   were expensive and stand alone). A story's narration is meaningless
--   WITHOUT its story — the segments ARE the story text — and is re-derivable
--   by re-voicing, so deleting a story deletes its audio set (rows; the blob
--   FILE is an operator cleanup, 041/074's non-transactional file posture).
--   Because the row disappears rather than degrading to NULL, the kind↔link
--   CHECK can be BIDIRECTIONAL here (a 'generated_story' set always carries
--   its link) where 073's paired CHECK had to tolerate the SET-NULL orphan.
--
-- WHY THE JOB LEDGER DOES NOT SURVIVE STORY DELETION (deliberate 076 departure)
--   076/069 kept SET-NULL'd job rows so deleting content could never refund
--   the daily cost cap. Here fk_story_audio_jobs_story CASCADEs: the F-210
--   charter pins CASCADE, no story-DELETE route exists today (the refund
--   hole is unreachable), and a story's job history is meaningless without
--   the story. If a DELETE /reading/generated/:id route ever ships, revisit
--   this FK against 076's refund-by-deletion analysis first.
--
-- WHY char_count IS SNAPSHOT AT ENQUEUE (069's pages_requested, adapted)
--   ElevenLabs bills per CHARACTER, so the per-user daily cap's cost proxy is
--   the story body's length, copied from the ownership-checked
--   generated_stories row at enqueue — never recomputed by joining the story
--   (an edit/regenerate surface could drift it after the fact). Failed jobs
--   still count: the cap is a COST control and a failed run spent quota too.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. generated_stories.turns — latent multi-voice structure. NULLABLE: every
--    pre-081 story (and any story whose generation omitted turns) is NULL and
--    keeps working everywhere — body_ko stays the reader's source of truth.
--    Only the array-ness is constrained; element shape ({speaker, text}) is
--    the generation schema's job (StoryResultSchema — the only writer), same
--    stance as 018's preferences JSONB.
-- -----------------------------------------------------------------------------
ALTER TABLE generated_stories ADD COLUMN IF NOT EXISTS turns JSONB;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_generated_stories_turns_array'
                     AND conrelid = 'generated_stories'::regclass) THEN
        ALTER TABLE generated_stories
            ADD CONSTRAINT ck_generated_stories_turns_array
            CHECK (turns IS NULL OR jsonb_typeof(turns) = 'array');
    END IF;
END $$;

COMMENT ON COLUMN generated_stories.turns IS
    'F-210 multi-voice groundwork: ordered spoken units '
    '[{speaker, text}, …] the generation engine may emit alongside body_ko '
    '(speaker = ''narrator'' or a character label). LATENT in v1 — the '
    'reader and the narrator TTS both consume body_ko; a future multi-voice '
    'pass consumes this. NULL for pre-081 stories and turn-less generations.';

-- -----------------------------------------------------------------------------
-- 2. Back the composite owner FKs below: UNIQUE (id, user_id) on
--    generated_stories. `id` is already the PK — this never rejects a real
--    row; it only makes the pair referenceable (044 §0 / 074 §0's exact
--    maneuver, DO-guarded for manual re-apply).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'uq_generated_stories_id_user'
                     AND conrelid = 'generated_stories'::regclass) THEN
        ALTER TABLE generated_stories
            ADD CONSTRAINT uq_generated_stories_id_user UNIQUE (id, user_id);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. audio_sources: admit kind 'generated_story' + the owner-pinned story
--    link. The kind CHECK is REPLACED with the widened value set (drop +
--    re-add is idempotent and validates existing rows against a superset, so
--    it can never fail on live data).
-- -----------------------------------------------------------------------------
ALTER TABLE audio_sources DROP CONSTRAINT IF EXISTS ck_audio_sources_kind;
ALTER TABLE audio_sources ADD CONSTRAINT ck_audio_sources_kind
    CHECK (kind IN ('paired_reader', 'standalone_listening', 'topik', 'generated_story'));

ALTER TABLE audio_sources ADD COLUMN IF NOT EXISTS generated_story_id BIGINT;

DO $$
BEGIN
    -- OWNER GUARD (073's source_upload_id maneuver, CASCADE action): a
    -- non-NULL (generated_story_id, user_id) must be a real
    -- generated_stories(id, user_id) pair riding §2's unique — voicing
    -- another user's story into one's own set is structurally impossible.
    -- MATCH SIMPLE skips the check for NULL links (every non-story set).
    -- CASCADE, not column-list SET NULL — see the up header.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'fk_audio_sources_generated_story'
                     AND conrelid = 'audio_sources'::regclass) THEN
        ALTER TABLE audio_sources
            ADD CONSTRAINT fk_audio_sources_generated_story
            FOREIGN KEY (generated_story_id, user_id)
            REFERENCES generated_stories(id, user_id)
            ON DELETE CASCADE ON UPDATE RESTRICT;
    END IF;

    -- BIDIRECTIONAL kind↔link CHECK (unlike 073's one-directional paired
    -- CHECK): a 'generated_story' set always carries its story link and no
    -- other kind ever does. Safe to be strict both ways because the FK
    -- CASCADEs — the link can never degrade to NULL at rest.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_audio_sources_story_kind_link'
                     AND conrelid = 'audio_sources'::regclass) THEN
        ALTER TABLE audio_sources
            ADD CONSTRAINT ck_audio_sources_story_kind_link
            CHECK ((kind = 'generated_story') = (generated_story_id IS NOT NULL));
    END IF;
END $$;

-- Voice-once, made structural: at most ONE audio set per story. The runner's
-- persist INSERT is the arbiter (23505 = another run already voiced it);
-- partial so the ~all-NULL non-story rows stay out of the index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audio_sources_generated_story
    ON audio_sources (generated_story_id)
    WHERE generated_story_id IS NOT NULL;
COMMENT ON INDEX uq_audio_sources_generated_story IS
    'One voiced audio set per generated story (F-210 voice-once cache). '
    'Partial — only story-linked sets are indexed.';

COMMENT ON COLUMN audio_sources.generated_story_id IS
    'The generated_stories row this set is the TTS narration of (kind = '
    '''generated_story'' — F-210), else NULL. Owner-pinned by the composite '
    'fk_audio_sources_generated_story to generated_stories(id, user_id); '
    'CASCADEs with its story (narration is meaningless without the text — '
    'contrast source_upload_id''s SET NULL). UNIQUE among non-NULLs: a story '
    'is voiced once.';

-- -----------------------------------------------------------------------------
-- 4. story_audio_jobs — one row per TTS synthesis job over a story (F-210).
--    Claimed by the IN-SERVER runner (the km-worker mounts the audio volume
--    read-only, so synthesis must run where the blob store is writable):
--    INSERT 'pending' at POST /reading/generated/:id/audio → the runner's
--    poll claims via FOR UPDATE SKIP LOCKED → 'running' → 'done' (with
--    audio_source_id) | 'failed' (with a bounded error). TEXT + CHECK for
--    status per the README discriminator convention (074's
--    transcript_status precedent; deliberately not 076's enum — nothing
--    shares the value set).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_audio_jobs (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generated_story_id  BIGINT      NOT NULL,
    -- Denormalized owner (= the story's user_id, structurally pinned by the
    -- composite FK below): the per-user daily cap query needs no join.
    user_id             BIGINT      NOT NULL,

    -- 'pending' (enqueued, awaiting the runner) -> 'running' (claimed, TTS in
    -- flight) -> 'done' | 'failed'. The runner reaps stale 'running' rows
    -- past STORY_TTS_STALE_RUN_MINUTES ('pending' is the healthy backlog and
    -- is never reaped — 076's reap contract).
    status              TEXT        NOT NULL DEFAULT 'pending',

    -- Cost snapshot KNOWN AT ENQUEUE: length(body_ko) at enqueue time — the
    -- per-user daily cap's ledger unit (TTS bills per character). Never
    -- recomputed from the story after the fact (069/076's snapshot stance).
    char_count          INTEGER     NOT NULL,

    -- The voiced audio_sources set, set when the job settles 'done'. SET
    -- NULL (not CASCADE) so an out-of-band set deletion can never erase the
    -- job row it would take the status/ledger record with.
    audio_source_id     BIGINT,

    -- Bounded human-readable failure summary for status = 'failed' — always
    -- OUR OWN whitelisted copy (services/tts.ts maps upstream failures to
    -- generic messages; no provider response text, ever).
    error               TEXT,

    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,

    -- Audit columns (ADR-001 D6)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER     NOT NULL DEFAULT 1,

    -- OWNER GUARD (044's plain composite form — generated_story_id is NOT
    -- NULL, so no column-list action is needed): the (story, user) pair must
    -- be real, so a job charging one user for another user's story is
    -- structurally impossible. CASCADE: see the up header's deliberate-076-
    -- departure note.
    CONSTRAINT fk_story_audio_jobs_story
        FOREIGN KEY (generated_story_id, user_id)
        REFERENCES generated_stories(id, user_id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Belt-and-braces direct user FK (051's rationale): a user deletion
    -- takes their job/ledger rows even if a story row somehow outlived them.
    CONSTRAINT fk_story_audio_jobs_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_story_audio_jobs_audio_source
        FOREIGN KEY (audio_source_id) REFERENCES audio_sources(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT ck_story_audio_jobs_status
        CHECK (status IN ('pending', 'running', 'done', 'failed')),
    -- >= 0, not > 0: the ledger floor stays decoupled from generated_stories'
    -- own body CHECK (076's charged_bytes stance — a cost snapshot accepts
    -- whatever the source column ever legally held).
    CONSTRAINT ck_story_audio_jobs_char_count_nonnegative
        CHECK (char_count >= 0),
    CONSTRAINT ck_story_audio_jobs_error_length
        CHECK (error IS NULL OR length(error) BETWEEN 1 AND 2000),
    CONSTRAINT ck_story_audio_jobs_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE story_audio_jobs IS
    'One row per story-TTS synthesis job (F-210): enqueued ''pending'' by '
    'POST /reading/generated/:id/audio, claimed by the in-server runner via '
    'FOR UPDATE SKIP LOCKED (the km-worker cannot write the audio volume), '
    'settled ''done'' (audio_source_id = the voiced set) or ''failed'' '
    '(bounded error). One live job per story (partial UNIQUE below); the '
    'per-user daily cap sums today''s rows by user_id (char_count ledger, '
    'failed jobs count). CASCADEs with its story AND its user — a deliberate '
    'departure from 076''s surviving ledger, safe while no story-DELETE '
    'route exists (see the up header).';
COMMENT ON COLUMN story_audio_jobs.char_count IS
    'length(body_ko) snapshot at enqueue — the daily TTS cap''s cost unit '
    '(TTS bills per character; mirrors 069''s pages_requested / 076''s '
    'charged_bytes). Failed jobs still count (cost control, not a usage '
    'meter).';
COMMENT ON COLUMN story_audio_jobs.status IS
    '''pending'' (real queue state — the runner claims it) -> ''running'' -> '
    '''done'' | ''failed''. Stale ''running'' rows (crashed runner) are '
    'reaped ''failed'' past STORY_TTS_STALE_RUN_MINUTES; ''pending'' is the '
    'healthy backlog and is never reaped (076''s reap contract).';
COMMENT ON COLUMN story_audio_jobs.error IS
    'Bounded failure summary for status = ''failed'' — always server-authored '
    'whitelisted copy, never raw TTS-provider response text. NULL otherwise.';

-- One LIVE job per story: the enqueue INSERT arbitrates concurrency (23505 →
-- the route returns the existing job). Mirrors
-- uq_audio_transcription_jobs_track_live (076) / 069.
CREATE UNIQUE INDEX IF NOT EXISTS uq_story_audio_jobs_story_live
    ON story_audio_jobs (generated_story_id)
    WHERE status IN ('pending', 'running');
COMMENT ON INDEX uq_story_audio_jobs_story_live IS
    'At most one pending/running TTS job per story — the enqueue INSERT is '
    'the concurrency arbiter (076''s pattern).';

-- The per-user daily cap sum + the newest-first status lookup (076's
-- ix_audio_transcription_jobs_user_created).
CREATE INDEX IF NOT EXISTS ix_story_audio_jobs_user_created
    ON story_audio_jobs (user_id, created_at DESC);
COMMENT ON INDEX ix_story_audio_jobs_user_created IS
    'Supports the per-user daily TTS cap (count/sum WHERE user_id = $1 AND '
    'created_at >= today) and newest-first job reads.';

-- The runner's claim poll — partial on the (tiny) pending slice, keyed for
-- an ORDER BY created_at, id index walk (strict FIFO; 076's pending index).
CREATE INDEX IF NOT EXISTS ix_story_audio_jobs_pending
    ON story_audio_jobs (created_at, id)
    WHERE status = 'pending';
COMMENT ON INDEX ix_story_audio_jobs_pending IS
    'Partial (pending only) — the in-server runner''s claim poll walks it '
    'oldest-first with FOR UPDATE SKIP LOCKED (076''s pattern).';

-- The GET status route resolves a story's latest job; the live-claim partial
-- above only covers pending/running, so settled lookups need this.
CREATE INDEX IF NOT EXISTS ix_story_audio_jobs_story
    ON story_audio_jobs (generated_story_id, created_at DESC, id DESC);
COMMENT ON INDEX ix_story_audio_jobs_story IS
    'GET /reading/generated/:id/audio''s latest-job-for-story lookup '
    '(newest first; the live partial UNIQUE covers only unsettled rows).';

CREATE OR REPLACE TRIGGER trg_story_audio_jobs_updated_at
    BEFORE UPDATE ON story_audio_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 081_story_audio.up.sql — runner owns the transaction (ADR-013).
