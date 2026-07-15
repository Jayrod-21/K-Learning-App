-- =============================================================================
-- Migration 061 — listening_attempts (F-172, listening daily-attempt log)
--   UP — adds `listening_attempts`: one append-only row per completed
--        listening action (finished a TTMIK lesson, or finished an Iyagi
--        episode). Feeds a future "did the user listen today" signal (Today/
--        streak surface); this migration is storage-only — no route change
--        ships in this file.
--   Reverse: 061_listening_attempts.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()),
--               005_lesson_podcast_topik (ttmik_lessons, iyagi_episodes).
--
-- WHY: `docs/redesign/BACKEND_BATCH_SCOPING.md` §2 confirms `server/src/
-- routes/ttmik.ts` (both the TTMIK-lesson and Iyagi-episode routers) is PURE
-- read-only corpus serving today — lesson/episode lists, transcript/highlight
-- detail, Range-capable mp3 streaming — with ZERO user-state writing anywhere
-- in that file. Unlike Reading (which at least has a resume bookmark,
-- `reading_positions`/051), Listening has no player state on the server at
-- all — no progress, no position, no completion. This migration adds the
-- storage half of that gap; the completion write path itself is a route-layer
-- change (F-172, out of this migration's scope).
--
-- DESIGN NOTES — mirrors 060_reading_attempts's shape exactly, swapped onto
-- the listening corpus's two content types:
--   * TWO targets, ONE table, discriminated by `source_kind` ('ttmik_lesson' |
--     'iyagi_episode') — same rationale as reading_attempts: both targets
--     already share one Ttmik.tsx surface (the TTMIK-lesson tile vs. the
--     Iyagi-episode tile) and the identical "finished listening to this"
--     shape, so a third physical table split on THIS axis buys nothing no
--     query needs. `ck_listening_attempts_target_not_both` (see its own
--     comment) is deliberately NOT a strict XOR for the same reason
--     reading_attempts' equivalent isn't — see below.
--   * SOFT FKs, ON DELETE SET NULL — per the scoping doc's explicit guidance
--     (§"Risk callouts" FK correctness): "Do not FK hard against ...
--     ttmik_lessons/iyagi_episodes with ON DELETE RESTRICT or CASCADE unless
--     the team is certain those corpus tables never get pruned/reloaded —
--     RESTRICT would block a legitimate corpus reload, CASCADE would silently
--     erase user history." Both corpus tables are loader-populated
--     (`tools/ingest/loaders/`) and can in principle be re-loaded/pruned, so
--     `lesson_id`/`episode_id` SET NULL rather than RESTRICT/CASCADE —
--     deliberately DIFFERENT posture from `topik_responses.topik_item_id`
--     (015, RESTRICT), which the scoping doc's own carve-out singles out
--     these three tables to depart from.
--   * `title_snapshot` is SERVER-derived (the route resolves the lesson's
--     "Level L Lesson N: Title" or the episode's "Iyagi #N: Title" from the
--     row it just looked up) — never client-supplied free text, same
--     provenance contract as reading_attempts.title_snapshot.
--   * No passage-number analog: audio playback has no "how far" column here —
--     F-172's listening completion signal is binary (the `<audio>` `ended`
--     event, or an explicit "mark listened" action), not a resumable position
--     (unlike reading's passage_number). A future timestamp-based "listened
--     to N seconds of M" column is an additive follow-up, not part of this
--     migration.
--   * `completed_at` distinct from the generic `created_at` audit column,
--     mirroring reading_attempts / topik_responses.answered_at /
--     writing_attempts.graded_at.
--   * Audit columns (`created_at`/`updated_at`/`version`) present per
--     ADR-001 §D6 for schema consistency, even though this is an append-only
--     log the route never UPDATEs post-insert (mirrors topik_responses, 015,
--     and reading_attempts, 060).
--   * user_id -> users(id) ON DELETE CASCADE: an attempt has no standalone
--     value once its owner is gone.
--   * IDOR posture: unlike reading_attempts' chapter_id/story_id (which point
--     at USER-OWNED rows and so need a route-level ownership check before
--     insert), ttmik_lessons/iyagi_episodes are PUBLIC licensed CORPUS content
--     — every authenticated user may complete any lesson/episode, so there is
--     no "owner" to confirm here; the route only needs to verify the named
--     lesson/episode id actually EXISTS (a 404 on a garbage id), never a
--     per-user ownership check.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS listening_attempts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- Which target column is populated. Closed 2-value set — TEXT + CHECK
    -- (README "Conventions": a discriminator this small doesn't warrant its
    -- own coordinated ENUM type).
    source_kind     TEXT        NOT NULL,

    -- Soft target #1: a TTMIK lesson. NULL when source_kind = 'iyagi_episode',
    -- or after the lesson row is pruned/replaced by a corpus reload.
    lesson_id       BIGINT,
    -- Soft target #2: an Iyagi episode. NULL when source_kind = 'ttmik_lesson',
    -- or after the episode row is pruned/replaced by a corpus reload.
    episode_id      BIGINT,

    -- Display label captured AT COMPLETION TIME (server-derived from the
    -- lesson/episode row the route just looked up — never client-supplied
    -- free text). Survives the source row's removal by a corpus reload.
    title_snapshot  TEXT        NOT NULL,

    -- The completion event's own timestamp (mirrors reading_attempts.completed_at
    -- / topik_responses.answered_at) — kept distinct from created_at below
    -- even though a live write sets both at once.
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Audit columns (ADR-001 §D6). Present for schema consistency even though
    -- this is an append-only log the route never UPDATEs post-insert (mirrors
    -- topik_responses, 015, and reading_attempts, 060).
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_listening_attempts_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Soft FKs (SET NULL, not CASCADE/RESTRICT — the scoping doc's explicit
    -- carve-out for ttmik_lessons/iyagi_episodes; see header's FK note).
    CONSTRAINT fk_listening_attempts_lesson
        FOREIGN KEY (lesson_id) REFERENCES ttmik_lessons(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT fk_listening_attempts_episode
        FOREIGN KEY (episode_id) REFERENCES iyagi_episodes(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,

    CONSTRAINT ck_listening_attempts_source_kind
        CHECK (source_kind IN ('ttmik_lesson', 'iyagi_episode')),
    -- AT MOST one target, never "exactly one" — mirrors
    -- reading_attempts.ck_reading_attempts_target_not_both exactly, for the
    -- identical reason: Postgres re-checks every table CHECK on any UPDATE to
    -- a row, and the lesson/episode FKs' ON DELETE SET NULL actions ARE an
    -- UPDATE to this row. An "exactly one" (XOR) CHECK would ABORT a corpus
    -- reload's lesson/episode delete the instant it tried to null the
    -- referencing lesson_id/episode_id. A degraded row (both columns NULL
    -- after its source was pruned) is a legal, if display-only, history
    -- entry — source_kind + title_snapshot still say what it WAS. The route
    -- is the sole enforcer of "exactly one, matching source_kind" at INSERT
    -- time.
    CONSTRAINT ck_listening_attempts_target_not_both
        CHECK (NOT (lesson_id IS NOT NULL AND episode_id IS NOT NULL)),
    CONSTRAINT ck_listening_attempts_title_len
        CHECK (length(title_snapshot) BETWEEN 1 AND 500),
    CONSTRAINT ck_listening_attempts_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE listening_attempts IS
    'Append-only log of completed listening actions (F-172): one row per '
    '"finished this TTMIK lesson" / "finished this Iyagi episode" event, keyed '
    'by source_kind (ttmik_lesson|iyagi_episode) with a soft, SET-NULL FK to '
    'whichever target was completed. title_snapshot (server-derived at '
    'completion time) keeps history readable after a corpus reload prunes the '
    'source row. Feeds a future Today/streak "did the user listen today" '
    'surface. CASCADEs away with the user; never UPDATEd post-insert.';
COMMENT ON COLUMN listening_attempts.source_kind IS
    'Which soft-FK column is populated for this row: ''ttmik_lesson'' '
    '(ttmik_lessons.id) or ''iyagi_episode'' (iyagi_episodes.id). Exactly one '
    'of lesson_id/episode_id is non-null at INSERT time (route-enforced — see '
    'ck_listening_attempts_target_not_both''s comment for why the DB only '
    'rejects BOTH being set, not fewer than one); either may independently go '
    'NULL later if its source row is pruned by a corpus reload — the row '
    'survives on title_snapshot (degraded, but still a valid history entry).';
COMMENT ON COLUMN listening_attempts.title_snapshot IS
    'Display label captured at completion time (the lesson''s "Level L Lesson '
    'N: Title" or the episode''s "Iyagi #N: Title") — SERVER-derived from the '
    'row the route already looked up, never client-supplied text. Survives a '
    'corpus reload that prunes/replaces the source lesson/episode row.';
COMMENT ON CONSTRAINT fk_listening_attempts_lesson ON listening_attempts IS
    'Soft FK, ON DELETE SET NULL (scoping-doc carve-out — NOT topik_responses'' '
    'RESTRICT posture): a corpus reload may prune/replace ttmik_lessons rows, '
    'and this must never RESTRICT that reload nor CASCADE-erase the learner''s '
    'listening history. title_snapshot carries the display label forward once '
    'lesson_id degrades to NULL.';
COMMENT ON CONSTRAINT fk_listening_attempts_episode ON listening_attempts IS
    'Soft FK, ON DELETE SET NULL (same carve-out as the lesson FK): a corpus '
    'reload may prune/replace iyagi_episodes rows without RESTRICTing the '
    'reload or CASCADE-erasing listening history.';

-- GET /ttmik/attempts's (and /iyagi/attempts's) one query: the caller's own
-- history, newest first.
CREATE INDEX IF NOT EXISTS ix_listening_attempts_user_completed
    ON listening_attempts (user_id, completed_at DESC);
COMMENT ON INDEX ix_listening_attempts_user_completed IS
    'Serves GET /ttmik/attempts and GET /iyagi/attempts — one user''s '
    'completion history, newest first (mirrors '
    'ix_reading_attempts_user_completed''s role for reading_attempts).';

CREATE OR REPLACE TRIGGER trg_listening_attempts_updated_at
    BEFORE UPDATE ON listening_attempts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 061_listening_attempts.up.sql — runner owns the transaction (ADR-013).
