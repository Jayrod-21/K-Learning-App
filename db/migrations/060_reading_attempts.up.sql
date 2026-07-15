-- =============================================================================
-- Migration 060 — reading_attempts (F-172, reading daily-attempt log)
--   UP — adds `reading_attempts`: one append-only row per completed reading
--        action (finished a chapter of an uploaded book, or finished an
--        AI-generated story). Feeds a future "did the user read today" signal
--        (Today/streak surface); this migration is storage-only — no route
--        change ships in this file.
--   Reverse: 060_reading_attempts.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()), 044_reading_chapters
--               (reading_chapters), 054_generated_stories (generated_stories).
--
-- WHY: `docs/redesign/BACKEND_BATCH_SCOPING.md` §2 confirms no per-attempt/
-- per-day log exists for reading today — `reading_positions` (051) is a single
-- overwritten resume BOOKMARK per (user, book), not a log of completed reads,
-- and `generated_stories` (054) is the story LIBRARY, not a completion event.
-- Mirrors `writing_attempts` (038): single completed action, one-phase,
-- append-only — NOT grammar-drill's two-phase generate→score shape (there is
-- no generated, answer-bearing payload to protect here) and NOT topik_attempts'
-- resumable-session shape (a reading completion is a single event, not a
-- multi-item timed run).
--
-- DESIGN NOTES
--   * TWO targets, ONE table, discriminated by `source_kind`: a reading
--     completion is either a chapter of an uploaded literature book
--     (`reading_chapters`) or an AI-generated story (`generated_stories`) — the
--     scoping doc's own recommendation (§2 "Recommendation: separate tables
--     per skill") argues against a table unifying reading+listening+hanja, but
--     within the READING skill itself these two targets already share one
--     Reading.tsx surface (Books tab vs. AI-stories tab) and the identical
--     "finished this, whatever it was" shape — a THIRD table split on this axis
--     would fight that surface for no query benefit (nothing needs "chapter
--     attempts only" as a separate physical relation the way grammar/writing/
--     TOPIK need separate tables from EACH OTHER). `source_kind` is a closed,
--     CHECK-constrained TEXT discriminator (README "Conventions": closed sets
--     use ENUM or TEXT+CHECK; a 2-value set here doesn't warrant its own
--     migration-coordinated ENUM type). `ck_reading_attempts_target_not_both`
--     makes it structurally impossible to insert a row with BOTH targets set
--     (a real corruption case); "exactly one, matching source_kind" is enforced
--     by the route at INSERT time, not a table CHECK — see that constraint's
--     own comment for why a stricter DB-level XOR would break a book reload.
--   * SOFT FKs, ON DELETE SET NULL, per the scoping doc's explicit guidance
--     (§"Risk callouts" FK correctness): `chapter_id`/`story_id` do NOT
--     CASCADE or RESTRICT — a book re-load replaces `reading_chapters` wholesale
--     (044's own loader contract) and a user may delete a generated story from
--     their library; neither should be blocked by (RESTRICT) or silently erase
--     (CASCADE) a learner's completion history. `title_snapshot` is the
--     `writing_attempts.prompt_kr` precedent: the display label captured AT
--     COMPLETION TIME, so history reads sensibly even after the source chapter/
--     story is gone (a SET-NULLed row still shows "Chapter 3" or "바닷가 마을",
--     just with no live link).
--   * `title_snapshot` is SERVER-derived (the route resolves the chapter's
--     title / chapter number fallback, or the story's title, from the row it
--     just verified the caller owns) — NEVER client-supplied free text. This
--     keeps the column's provenance identical to every other corpus/AI-authored
--     display string on this schema (never a place for a client to inject
--     arbitrary "history" copy).
--   * `passage_number` is the reading analog of `reading_positions.passage_number`
--     ("how far" within a chapter) — advisory, NOT FK'd (passages are replaced
--     wholesale on a chapter re-load, same posture as 051), NULL for a
--     whole-chapter or a story completion (a generated story is one body blob
--     with no passage concept).
--   * `completed_at` is the event timestamp (mirrors `topik_responses.answered_at`
--     / `writing_attempts.graded_at`) — distinct from the generic `created_at`
--     audit column even though the route sets both at the same instant today;
--     keeping them separate leaves room for a future backdated import without a
--     schema change and matches this codebase's established log-table shape.
--   * Audit columns (`created_at`/`updated_at`/`version`) are present per
--     ADR-001 §D6 for schema consistency even though the route never UPDATEs a
--     row post-insert — the exact posture `topik_responses` (015) documents for
--     its own append-only log.
--   * user_id -> users(id) ON DELETE CASCADE: an attempt has no standalone
--     value once its owner is gone (mirrors grammar_drill_attempts/
--     writing_attempts/topik_responses).
--   * IDOR defense is enforced at the ROUTE (a scoped SELECT confirms the
--     caller owns the named chapter/story before this INSERT ever runs, mirror
--     of reading.ts's existing `assertOwnedUpload` gate) — NOT by a composite
--     owner-guard FK the way 044/051 pin `reading_chapters`/`reading_positions`
--     to their upload's owner. Adding that composite guard here would require
--     a NEW `UNIQUE (id, user_id)` on the existing `reading_chapters` table,
--     which is out of this migration's additive, single-new-table scope (and
--     unnecessary: a route-level ownership check ahead of a SET-NULL soft FK
--     gives the same practical guarantee grammar-drill's `WHERE id = $1 AND
--     user_id = $2` IDOR gate gives, without touching a table this migration
--     doesn't own).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reading_attempts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- Which target column is populated. Closed 2-value set — TEXT + CHECK
    -- (README "Conventions": a discriminator this small doesn't warrant its
    -- own coordinated ENUM type).
    source_kind     TEXT        NOT NULL,

    -- Soft target #1: a chapter of an uploaded literature book. NULL when
    -- source_kind = 'story', or after the chapter was removed by a book
    -- re-load (title_snapshot survives that).
    chapter_id      BIGINT,
    -- Soft target #2: an AI-generated story. NULL when source_kind = 'chapter',
    -- or after the user deletes the story from their library.
    story_id        BIGINT,

    -- Display label captured AT COMPLETION TIME (server-derived — the route's
    -- own chapter/story title, never client-supplied free text). Survives both
    -- targets' removal, mirroring writing_attempts.prompt_kr.
    title_snapshot  TEXT        NOT NULL,

    -- 1-based passage reached within the chapter (advisory, NOT FK'd — mirrors
    -- reading_positions.passage_number); NULL for a whole-chapter completion or
    -- any story completion (stories have no passage concept).
    passage_number  INTEGER,

    -- The completion event's own timestamp (mirrors topik_responses.answered_at
    -- / writing_attempts.graded_at) — kept distinct from created_at below even
    -- though a live write sets both at once.
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Audit columns (ADR-001 §D6). Present for schema consistency even though
    -- this is an append-only log the route never UPDATEs post-insert (mirrors
    -- topik_responses, 015).
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_reading_attempts_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Soft FKs (SET NULL, not CASCADE/RESTRICT — see header's FK note).
    CONSTRAINT fk_reading_attempts_chapter
        FOREIGN KEY (chapter_id) REFERENCES reading_chapters(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,
    CONSTRAINT fk_reading_attempts_story
        FOREIGN KEY (story_id) REFERENCES generated_stories(id)
        ON DELETE SET NULL ON UPDATE RESTRICT,

    CONSTRAINT ck_reading_attempts_source_kind
        CHECK (source_kind IN ('chapter', 'story')),
    -- AT MOST one target, never "exactly one": Postgres re-checks every table
    -- CHECK on any UPDATE to the row, and the chapter/story FKs' ON DELETE SET
    -- NULL actions ARE an UPDATE to this row — an "exactly one" (XOR) CHECK
    -- would therefore ABORT a book re-load's chapter delete (or a story
    -- delete) the instant it tried to null the referencing chapter_id/story_id,
    -- exactly the failure mode reading_positions (051) documents avoiding for
    -- its own chapter FK. A degraded row (both columns NULL after its source
    -- was removed) is a legal, if display-only, history entry — source_kind +
    -- title_snapshot still say what it WAS. The route is the sole enforcer of
    -- "exactly one, matching source_kind" at INSERT time (mirrors
    -- reading_positions' "must point somewhere" invariant living at the API
    -- boundary, not the DB, for the identical reason).
    CONSTRAINT ck_reading_attempts_target_not_both
        CHECK (NOT (chapter_id IS NOT NULL AND story_id IS NOT NULL)),
    CONSTRAINT ck_reading_attempts_title_len
        CHECK (length(title_snapshot) BETWEEN 1 AND 500),
    CONSTRAINT ck_reading_attempts_passage_positive
        CHECK (passage_number IS NULL OR passage_number > 0),
    CONSTRAINT ck_reading_attempts_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE reading_attempts IS
    'Append-only log of completed reading actions (F-172): one row per '
    '"finished this chapter" / "finished this AI story" event, keyed by '
    'source_kind (chapter|story) with a soft, SET-NULL FK to whichever target '
    'was completed. title_snapshot (server-derived at completion time) keeps '
    'history readable after the source chapter/story is removed. Feeds a '
    'future Today/streak "did the user read today" surface. CASCADEs away '
    'with the user; never UPDATEd post-insert.';
COMMENT ON COLUMN reading_attempts.source_kind IS
    'Which soft-FK column is populated for this row: ''chapter'' '
    '(reading_chapters.id) or ''story'' (generated_stories.id). Exactly one of '
    'chapter_id/story_id is non-null at INSERT time (route-enforced — see '
    'ck_reading_attempts_target_not_both''s comment for why the DB only rejects '
    'BOTH being set, not fewer than one); either may independently go NULL '
    'later if its source row is deleted — the row survives on title_snapshot '
    '(degraded, but still a valid history entry).';
COMMENT ON COLUMN reading_attempts.title_snapshot IS
    'Display label captured at completion time (the chapter''s title / '
    '"Chapter N" fallback, or the story''s title) — SERVER-derived from the '
    'row the route already verified the caller owns, never client-supplied '
    'text. Survives both a book re-load (044) and a story deletion.';
COMMENT ON COLUMN reading_attempts.passage_number IS
    '1-based passage reached within the chapter, or NULL (whole-chapter '
    'completion, or any story completion — stories have no passage concept). '
    'Advisory only, NOT FK''d to reading_passages — mirrors '
    'reading_positions.passage_number (051).';
COMMENT ON CONSTRAINT fk_reading_attempts_chapter ON reading_attempts IS
    'Soft FK, ON DELETE SET NULL: a book re-load (044) replaces reading_chapters '
    'wholesale — this must never RESTRICT that reload nor CASCADE-erase the '
    'learner''s completion history. title_snapshot carries the display label '
    'forward once chapter_id degrades to NULL.';
COMMENT ON CONSTRAINT fk_reading_attempts_story ON reading_attempts IS
    'Soft FK, ON DELETE SET NULL: deleting a generated story from the user''s '
    'library must never RESTRICT that deletion nor CASCADE-erase the '
    'completion history it left behind.';

-- GET /reading/attempts's one query: the caller's own history, newest first.
CREATE INDEX IF NOT EXISTS ix_reading_attempts_user_completed
    ON reading_attempts (user_id, completed_at DESC);
COMMENT ON INDEX ix_reading_attempts_user_completed IS
    'Serves GET /reading/attempts — one user''s completion history, newest '
    'first (mirrors idx_gda_user_pattern_created''s role for grammar-drill).';

CREATE OR REPLACE TRIGGER trg_reading_attempts_updated_at
    BEFORE UPDATE ON reading_attempts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 060_reading_attempts.up.sql — runner owns the transaction (ADR-013).
