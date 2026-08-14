-- migrate: non-destructive
-- =============================================================================
-- Migration 083 — story illustrations (F-211, AI images for generated stories)
--   UP — wires generated_stories (054) into an image pipeline that mirrors
--        081's story-audio shape exactly (same job/ledger contracts, image
--        provider instead of TTS):
--          §1 claude_route gains 'story_image_prompts' — the Claude proxy
--             route that authors the per-story scene-prompt set (style
--             directive + character sheet + 2-4 scene prompts) the runner
--             feeds the image provider.
--          §2 story_images — the generated illustrations at rest: one row per
--             (story, image_number), blob under IMAGE_STORAGE_DIR, the exact
--             prompt that produced it, and its pixel dimensions. Generate-once
--             is structural (UNIQUE (generated_story_id, image_number)).
--          §3 story_image_jobs — the async illustration job queue/ledger the
--             in-server runner claims (FOR UPDATE SKIP LOCKED), one live job
--             per story, per-user daily cap charged in jobs (image_count is
--             the per-job cost snapshot).
--   Reverse: 083_story_images.down.sql
--   Depends on: 054_generated_stories (generated_stories),
--               081_story_audio (uq_generated_stories_id_user — the UNIQUE
--               (id, user_id) that backs BOTH composite owner FKs below),
--               004_claude_cache_and_usage (claude_route),
--               001_core_schema (users, set_updated_at()).
--
-- WHY story_images IS ITS OWN TABLE (unlike 081, which reused audio_sources)
--   The audio stack already had a full sources/tracks/segments hierarchy with
--   a hardened streaming route; images have no equivalent stack to reuse —
--   image_captures (023) is the OCR-upload feature with its own lifecycle and
--   DTO. A story's illustrations are a flat ordered set of blobs, so a single
--   purpose-built table (rows written atomically with the job settle) is the
--   whole persistence story. Bytes serve through a new sibling of the
--   /images/:id/blob pattern (nosniff, IDOR-404, cookie auth) hung off
--   /reading — an already nginx-allow-listed prefix.
--
-- WHY THE ROWS HAVE NO status COLUMN
--   The runner's persist is all-or-nothing (F-211's locked partial-failure
--   policy): every scene's blob is written first, then ALL rows + the job
--   settle land in ONE transaction. A story_images row therefore only ever
--   exists in its final, servable state — a status discriminator would have
--   exactly one value. In-flight/failed state lives on story_image_jobs.
--
-- WHY THE JOB LEDGER CASCADEs WITH ITS STORY (081's deliberate 076 departure)
--   Same reasoning as story_audio_jobs: no story-DELETE route exists today
--   (the refund hole is unreachable), and an illustration job's history is
--   meaningless without its story. Revisit against 076's refund-by-deletion
--   analysis if a DELETE /reading/generated/:id route ever ships.
--
-- WHY image_count IS SNAPSHOT AT ENQUEUE (081's char_count, adapted)
--   The image provider bills per IMAGE, so the per-job cost snapshot is the
--   scene count the enqueue requested (STORY_IMAGE_SCENE_COUNT at enqueue
--   time), copied once and never recomputed. The per-user daily cap counts
--   JOBS (a story illustrated = one job; jobs/day × 4 bounds image spend);
--   image_count keeps the exact per-job ledger. Failed jobs still count: the
--   cap is a COST control and a failed run spent quota too.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write. The ALTER TYPE
--   ADD VALUE in §1 is legal inside that transaction (PG 12+) because
--   nothing in this file USES the new enum value.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. claude_route: admit the F-211 scene-prompt route. Mirrors 053/057's
--    ADD VALUE posture; server/tests/db/claude_route_enum.test.ts pins the
--    enum ⇄ RouteName equivalence in both directions.
-- -----------------------------------------------------------------------------
ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'story_image_prompts';

-- -----------------------------------------------------------------------------
-- 2. story_images — one generated illustration per (story, image_number).
--    Written ONLY by the runner's atomic persist (blob-before-rows, 041's
--    ordering); read by GET /reading/generated/:id/images (metadata) and
--    GET /reading/generated/:id/image/:n/blob (bytes).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_images (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generated_story_id  BIGINT      NOT NULL,
    -- Denormalized owner (= the story's user_id, structurally pinned by the
    -- composite FK below): the byte-serve route's IDOR gate needs no join.
    user_id             BIGINT      NOT NULL,
    -- 1-based position within the story's illustration set (story order).
    image_number        INTEGER     NOT NULL,
    -- RELATIVE path under IMAGE_STORAGE_DIR ({userId}/{uuid}.{ext}) — the
    -- same server-generated, traversal-guarded shape image_captures uses
    -- (services/imageStore.ts). The DB never deletes files (041/074).
    blob_ref            TEXT        NOT NULL,
    -- The EXACT image prompt sent to the provider for this scene (English;
    -- bakes in the webtoon style directive + character descriptions). Kept
    -- for observability and client display; server-derived (Claude proxy
    -- output, Zod-capped under this CHECK), never client-supplied.
    prompt              TEXT        NOT NULL,
    width               INTEGER     NOT NULL,
    height              INTEGER     NOT NULL,

    -- Audit columns (ADR-001 D6)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER     NOT NULL DEFAULT 1,

    -- OWNER GUARD (044's plain composite form, riding 081's
    -- uq_generated_stories_id_user): the (story, user) pair must be real, so
    -- an image row hanging another user's story into one's own library is
    -- structurally impossible. CASCADE: an illustration is meaningless
    -- without its story and re-derivable by re-generating (the blob FILE is
    -- an operator cleanup, 041/074's posture).
    CONSTRAINT fk_story_images_story
        FOREIGN KEY (generated_story_id, user_id)
        REFERENCES generated_stories(id, user_id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Belt-and-braces direct user FK (051's rationale).
    CONSTRAINT fk_story_images_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Generate-once, made structural: at most one image per (story, slot).
    -- The runner's persist INSERT is the arbiter (23505 = another run
    -- already illustrated it — the whole persist tx rolls back).
    CONSTRAINT uq_story_images_story_number
        UNIQUE (generated_story_id, image_number),
    CONSTRAINT ck_story_images_image_number_positive
        CHECK (image_number >= 1),
    CONSTRAINT ck_story_images_blob_ref_length
        CHECK (length(blob_ref) BETWEEN 1 AND 512),
    -- 4000 sits above the proxy schema's 3800-char scene-prompt cap, so a
    -- schema-valid prompt always fits (models.ts is the writer-side bound).
    CONSTRAINT ck_story_images_prompt_length
        CHECK (length(prompt) BETWEEN 1 AND 4000),
    CONSTRAINT ck_story_images_dimensions_positive
        CHECK (width >= 1 AND height >= 1),
    CONSTRAINT ck_story_images_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE story_images IS
    'F-211 AI illustrations for generated stories: one row per (story, '
    'image_number), written ONLY by the in-server runner''s atomic persist '
    '(all scenes or none — no status column because a row only exists in '
    'its final servable state). blob_ref is a relative path under '
    'IMAGE_STORAGE_DIR; bytes serve via GET /reading/generated/:id/image/'
    ':n/blob (IDOR-404, nosniff). CASCADEs with its story; the composite '
    'owner FK pins user_id to the story''s true owner.';
COMMENT ON COLUMN story_images.prompt IS
    'The exact provider prompt for this scene (English, style directive + '
    'character sheet baked in) — Claude-proxy output (story_image_prompts '
    'route), Zod-capped at 3800 chars; never client-supplied free text.';
COMMENT ON COLUMN story_images.blob_ref IS
    'Relative blob path under IMAGE_STORAGE_DIR ({userId}/{uuid}.{ext}, '
    'server-generated — services/imageStore.ts''s traversal-guarded shape). '
    'The DB never deletes files; orphaned blobs are an operator cleanup.';

CREATE OR REPLACE TRIGGER trg_story_images_updated_at
    BEFORE UPDATE ON story_images
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. story_image_jobs — one row per illustration job over a story (F-211).
--    story_audio_jobs (081 §4) with the provider swapped: INSERT 'pending' at
--    POST /reading/generated/:id/images (or auto-enqueued by POST
--    /reading/generate on a configured deploy) → the in-server runner claims
--    via FOR UPDATE SKIP LOCKED → 'running' → 'done' | 'failed' (bounded
--    error). No output-link column: the story_images rows themselves (persist
--    tx-atomic with the settle) are the 'done' authority, exactly as the
--    voiced audio set is for 081.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_image_jobs (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generated_story_id  BIGINT      NOT NULL,
    -- Denormalized owner (structurally pinned by the composite FK below):
    -- the per-user daily cap query needs no join.
    user_id             BIGINT      NOT NULL,

    -- 'pending' (enqueued, awaiting the runner) -> 'running' (claimed,
    -- generation in flight) -> 'done' | 'failed'. Stale 'running' rows are
    -- reaped past STORY_IMAGE_STALE_RUN_MINUTES ('pending' is the healthy
    -- backlog and is never reaped — 076's reap contract).
    status              TEXT        NOT NULL DEFAULT 'pending',

    -- Cost snapshot KNOWN AT ENQUEUE: the scene count requested
    -- (STORY_IMAGE_SCENE_COUNT at enqueue time) — the provider bills per
    -- image. Never recomputed after the fact (069/076/081's snapshot
    -- stance). The daily cap counts JOBS; this keeps the exact per-job
    -- ledger.
    image_count         INTEGER     NOT NULL,

    -- Bounded human-readable failure summary for status = 'failed' — always
    -- OUR OWN whitelisted copy (services/imageGen.ts maps upstream failures
    -- to generic messages; no provider response text, ever).
    error               TEXT,

    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,

    -- Audit columns (ADR-001 D6)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER     NOT NULL DEFAULT 1,

    -- OWNER GUARD (081's exact form): a job charging one user for another
    -- user's story is structurally impossible. CASCADE: see the up header.
    CONSTRAINT fk_story_image_jobs_story
        FOREIGN KEY (generated_story_id, user_id)
        REFERENCES generated_stories(id, user_id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Belt-and-braces direct user FK (051's rationale).
    CONSTRAINT fk_story_image_jobs_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_story_image_jobs_status
        CHECK (status IN ('pending', 'running', 'done', 'failed')),
    -- >= 0, not >= 2: the ledger floor stays decoupled from the config
    -- clamp (081's char_count stance — a cost snapshot accepts whatever the
    -- config ever legally held).
    CONSTRAINT ck_story_image_jobs_image_count_nonnegative
        CHECK (image_count >= 0),
    CONSTRAINT ck_story_image_jobs_error_length
        CHECK (error IS NULL OR length(error) BETWEEN 1 AND 2000),
    CONSTRAINT ck_story_image_jobs_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE story_image_jobs IS
    'One row per story-illustration job (F-211): enqueued ''pending'' by '
    'POST /reading/generated/:id/images (or auto-enqueued at story creation '
    'when the image provider is configured), claimed by the in-server '
    'runner via FOR UPDATE SKIP LOCKED, settled ''done'' (the story_images '
    'rows land in the same transaction) or ''failed'' (bounded error, no '
    'rows — all-or-nothing). One live job per story (partial UNIQUE below); '
    'the per-user daily cap counts today''s rows by user_id (failed jobs '
    'count). CASCADEs with its story AND its user (081''s deliberate 076 '
    'departure — safe while no story-DELETE route exists).';
COMMENT ON COLUMN story_image_jobs.image_count IS
    'Scene count requested at enqueue (STORY_IMAGE_SCENE_COUNT snapshot) — '
    'the per-job cost ledger (the provider bills per image; mirrors 081''s '
    'char_count). Failed jobs still count toward the daily cap (cost '
    'control, not a usage meter).';
COMMENT ON COLUMN story_image_jobs.status IS
    '''pending'' (real queue state — the runner claims it) -> ''running'' '
    '-> ''done'' | ''failed''. Stale ''running'' rows (crashed runner) are '
    'reaped ''failed'' past STORY_IMAGE_STALE_RUN_MINUTES; ''pending'' is '
    'the healthy backlog and is never reaped (076''s reap contract).';
COMMENT ON COLUMN story_image_jobs.error IS
    'Bounded failure summary for status = ''failed'' — always server-'
    'authored whitelisted copy, never raw image-provider response text. '
    'NULL otherwise.';

-- One LIVE job per story: the enqueue INSERT arbitrates concurrency (23505 →
-- the route returns the existing job). Mirrors uq_story_audio_jobs_story_live.
CREATE UNIQUE INDEX IF NOT EXISTS uq_story_image_jobs_story_live
    ON story_image_jobs (generated_story_id)
    WHERE status IN ('pending', 'running');
COMMENT ON INDEX uq_story_image_jobs_story_live IS
    'At most one pending/running illustration job per story — the enqueue '
    'INSERT is the concurrency arbiter (081/076''s pattern).';

-- The per-user daily cap count + newest-first status lookups.
CREATE INDEX IF NOT EXISTS ix_story_image_jobs_user_created
    ON story_image_jobs (user_id, created_at DESC);
COMMENT ON INDEX ix_story_image_jobs_user_created IS
    'Supports the per-user daily illustration cap (count WHERE user_id = $1 '
    'AND created_at >= today) and newest-first job reads.';

-- The runner's claim poll — partial on the (tiny) pending slice, keyed for
-- an ORDER BY created_at, id index walk (strict FIFO; 081/076's pattern).
CREATE INDEX IF NOT EXISTS ix_story_image_jobs_pending
    ON story_image_jobs (created_at, id)
    WHERE status = 'pending';
COMMENT ON INDEX ix_story_image_jobs_pending IS
    'Partial (pending only) — the in-server runner''s claim poll walks it '
    'oldest-first with FOR UPDATE SKIP LOCKED (081/076''s pattern).';

-- The GET status route resolves a story's latest job; the live partial above
-- only covers pending/running, so settled lookups need this.
CREATE INDEX IF NOT EXISTS ix_story_image_jobs_story
    ON story_image_jobs (generated_story_id, created_at DESC, id DESC);
COMMENT ON INDEX ix_story_image_jobs_story IS
    'GET /reading/generated/:id/images'' latest-job-for-story lookup '
    '(newest first; the live partial UNIQUE covers only unsettled rows).';

CREATE OR REPLACE TRIGGER trg_story_image_jobs_updated_at
    BEFORE UPDATE ON story_image_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 083_story_images.up.sql — runner owns the transaction (ADR-013).
