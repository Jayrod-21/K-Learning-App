-- migrate: non-destructive
-- =============================================================================
-- Migration 109 — generated_story_publish (#45: public reuse library for
--   user-generated stories, stories-first slice)
--   UP — adds the two columns the opt-in publish/clone feature needs on
--        `generated_stories` (054):
--          §1 `is_shared BOOLEAN NOT NULL DEFAULT false` — the browse/read
--             widening flag, exactly 079's shape EXCEPT for who may write
--             it: 079's audio_sources/book_uploads flags are
--             OPERATOR-set-only (no route ever accepts them from a client);
--             this one is the first USER-settable shared flag in the app,
--             written ONLY by the new owner-gated
--             POST /reading/generated/:id/publish|unpublish routes
--             (`UPDATE ... WHERE id = $1 AND user_id = $2` — a caller can
--             only ever share/unshare their OWN row). Read paths widen to
--             (user_id = $me OR is_shared = true) for the story row AND its
--             images ONLY (routes/reading.ts); every mutation — including
--             re-voice/re-illustrate/publish/unpublish itself — stays
--             user_id = $me. Audio deliberately does NOT widen by this flag
--             (see routes/reading.ts's clone-route doc comment for the
--             listen-via-clone boundary) — this column only ever appears in
--             a `generated_stories` predicate, never on audio_sources.
--          §2 `source_story_id BIGINT NULL REFERENCES generated_stories(id)
--             ON DELETE SET NULL` — clone provenance: which published story
--             a row was cloned FROM (NULL for an original generation). PLAIN
--             FK, not composite/owner-pinned (unlike every other
--             generated_stories-adjacent FK in this schema, e.g. 081's
--             audio_sources.generated_story_id) — deliberately, because a
--             clone's source is BY DEFINITION another user's row; an
--             owner-pinned (id, user_id) composite FK would make a
--             cross-user clone structurally impossible to record. Self-FK on
--             the PK (not on 081's uq_generated_stories_id_user pair) — a
--             clone only ever needs to remember WHICH story, not re-verify
--             whose it is (the clone route itself already establishes
--             readability before insert; this column is provenance, not an
--             access-control primitive).
--          §3 a partial browse index (is_shared, created_at DESC)
--             WHERE is_shared — backs
--             GET /reading/generated/shared's newest-first listing.
--   Reverse: 109_generated_story_publish.down.sql
--   Depends on: 054_generated_stories (generated_stories).
--
-- WHY ON DELETE SET NULL ON source_story_id (not RESTRICT/CASCADE)
--   There is no story-DELETE route today (grepped — none exists), so this
--   FK's referencing action is currently unreachable in production. It is
--   still SET NULL, not RESTRICT, so that IF a delete route ever ships, an
--   owner deleting their own published original never blocks (or worse,
--   silently orphans) every OTHER user's clone of it — a clone's content is
--   already a full independent copy (title/body_ko/level/prompt duplicated
--   at clone time, never re-read from the source afterward), so losing the
--   provenance pointer degrades a clone to "an original with unknown
--   ancestry," never corrupts it. Mirrors 073/103's SET NULL rationale for
--   "the linked row can vanish; the referencing row just degrades."
--
-- WHY THE BLOB TABLES (audio_sources/audio_tracks/story_images) GET NO NEW
--   COLUMN HERE — a clone's audio/image rows are ordinary NEW rows owned by
--   the cloner (fresh audio_sources/audio_tracks/audio_transcript_segments/
--   story_images rows, inserted by POST /reading/generated/:id/clone) that
--   happen to carry the SAME blob_ref relative-path STRING as the source's
--   rows — no byte copy, no new schema needed to express that reuse. This is
--   safe because both audioStore.ts and imageStore.ts are ID-addressed
--   (`{userId}/{uuid}.{ext}`) blob stores whose ACCESS CONTROL lives
--   entirely in the owning DB row (user_id / the composite owner FKs), never
--   in the filesystem path itself — resolveUnderRoot only validates
--   traversal, not ownership — and every blob is write-once (no route ever
--   rewrites a blob_ref's bytes) with no DELETE route touching either table
--   today. Two DB rows, owned by two different users, safely pointing at one
--   file is therefore a stable state for the life of this slice; see
--   routes/reading.ts's clone route doc comment for the full rationale and
--   BUILD_REPORT_public_library.md for the write-up. Blob GC (refcounting an
--   orphaned file once a story-DELETE route exists) is an explicit deferred
--   follow-up, NOT built here.
--
-- WHY audio_sources/book_uploads' is_shared IS NOT REUSED FOR STORY MEDIA
--   079's audio_sources.is_shared means "curated Listen corpus" (F-207); a
--   published story's voiced narration is neither curated nor meant to
--   surface on GET /audio/shared. Media reads widen by the PARENT story's
--   is_shared instead (routes/reading.ts's loadReadableStory helper) — no
--   is_shared column is added to audio_sources, audio_tracks, or
--   story_images by this migration.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. is_shared — the user-settable publish flag.
-- -----------------------------------------------------------------------------
ALTER TABLE generated_stories
    ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN generated_stories.is_shared IS
    'Owner-set publish flag (#45): opens READ access to this story + its '
    'images to every account (WHERE user_id = $me OR is_shared = true), '
    'while every mutation stays user_id = $me. UNLIKE 079''s '
    'audio_sources/book_uploads.is_shared (operator-set-only, no route ever '
    'writes it), THIS flag is written by the caller''s OWN owner-gated '
    'POST /reading/generated/:id/publish|unpublish (UPDATE ... WHERE '
    'id = $1 AND user_id = $2) — the first user-settable shared flag in the '
    'app. Defaults false: a story is private until its owner explicitly '
    'publishes it. Never widens audio playback — GET /reading/generated/:id/'
    'audio and /audio/tracks/:id/stream stay owner-only in this slice '
    '(listen-via-clone boundary, routes/reading.ts).';

-- -----------------------------------------------------------------------------
-- 2. source_story_id — clone provenance. Plain (non-composite) self-FK —
--    see the up header for why this one deliberately does NOT ride 081's
--    owner-pinned (id, user_id) pattern.
-- -----------------------------------------------------------------------------
ALTER TABLE generated_stories
    ADD COLUMN IF NOT EXISTS source_story_id BIGINT;

-- NOTE on ON UPDATE RESTRICT below: `generated_stories.id` (054) is
-- `GENERATED ALWAYS AS IDENTITY`, so it can never be the target of an
-- UPDATE — this ON UPDATE action can never actually fire. It is written
-- anyway, verbatim, to match the house convention on every other
-- generated_stories-adjacent FK (081, 103), which is deliberate
-- boilerplate-for-consistency rather than a functional guard against a
-- reachable case (schema-review SF-1, F-220 fix-pass). Not a defect; do
-- not spend time trying to construct the scenario where it matters.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'fk_generated_stories_source_story'
                     AND conrelid = 'generated_stories'::regclass) THEN
        ALTER TABLE generated_stories
            ADD CONSTRAINT fk_generated_stories_source_story
            FOREIGN KEY (source_story_id) REFERENCES generated_stories(id)
            ON DELETE SET NULL ON UPDATE RESTRICT;
    END IF;
END $$;

COMMENT ON COLUMN generated_stories.source_story_id IS
    'Clone provenance (#45): the generated_stories row this one was cloned '
    'FROM via POST /reading/generated/:id/clone, or NULL for an original '
    'generation. PLAIN FK (not owner-pinned) — a clone''s source is, by '
    'construction, another account''s row. ON DELETE SET NULL: no story- '
    'DELETE route exists today (the action is currently unreachable), but '
    'if one ships, a deleted original must not block or corrupt an existing '
    'clone — the clone already holds a full independent content copy, so '
    'losing this pointer only loses the "cloned from" attribution.';

-- -----------------------------------------------------------------------------
-- 3. Browse index — GET /reading/generated/shared's newest-first listing.
--    Partial: only published rows are ever selected by that query, so the
--    (large majority) private rows stay out of the index entirely.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_generated_stories_shared
    ON generated_stories (is_shared, created_at DESC)
    WHERE is_shared;

COMMENT ON INDEX ix_generated_stories_shared IS
    'Partial (published rows only) — backs GET /reading/generated/shared''s '
    'newest-first browse listing (#45). Mirrors the shape of every other '
    'is_shared-gated partial index in this schema.';

-- End of 109_generated_story_publish.up.sql — runner owns the transaction (ADR-013).
