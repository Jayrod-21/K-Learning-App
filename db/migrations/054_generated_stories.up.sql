-- =============================================================================
-- Migration 054 — generated_stories (F-068, AI-generated reading stories)
--   UP — adds `generated_stories`: user-owned storage for short Korean stories
--        authored by the Claude generation engine (POST /reading/generate),
--        so the reading page can list and re-open them (GET /reading/generated
--        + /reading/generated/:id).
--   Reverse: 054_generated_stories.down.sql
--   Depends on: 001_core_schema (users, set_updated_at(), proficiency_level),
--               053 (the 'generate_story' claude_route value the proxy stamps
--               on this feature's cache/usage rows — a soft dependency; nothing
--               here references the enum).
--
-- WHY A TABLE (vs. ephemeral like writing prompts): a generated story is
-- CONTENT the learner returns to — the reading page needs a library of past
-- stories to re-read and tap-to-define against. A writing prompt, by
-- contrast, is consumed the moment the learner starts writing (the response
-- persists later via writing_attempts), so F-027/F-073 deliberately persist
-- nothing.
--
-- DESIGN NOTES
--   * level is `proficiency_level` (001/039), NOT free TEXT: the generation
--     route targets a band (L1..L5+) and the reader filters/badges by it. The
--     enum is the same closed set every other level-tagged surface uses; a
--     free-text column would invite drift the enum exists to prevent.
--   * prompt is the optional user-supplied TOPIC the story was generated from
--     (NULL = "surprise me"). Kept for display ("story about: …") and for
--     regenerate-with-same-topic; it is the user's own text, bounded by the
--     same cap the route's Zod schema enforces (DB CHECK is the floor — the
--     API schema must never be LOOSER than it; see the km lesson on trusting
--     API schemas looser than the DB constraint behind them).
--   * Length CHECKs are deliberately WIDER than the route's Zod caps
--     (title 200, body 6000, prompt 500 at the API): the DB bound exists to
--     stop a pathological write path, not to re-implement validation — a
--     future cap raise at the API must not need a migration until it crosses
--     these ceilings.
--   * ON DELETE CASCADE from users: a story is meaningless without its owner;
--     matches every other user-owned table's lifecycle contract.
--   * ix_generated_stories_user_created (user_id, created_at DESC) serves the
--     ONLY list query the API exposes (the user's stories, newest first).
--   * No soft delete: single-user personal app; deleting a story (a future
--     DELETE route) can hard-delete. version + updated_at ride along per the
--     ADR-001 D6 audit convention (a future edit/rename surface will want
--     them; adding them later would be a churn migration).
--
-- SECURITY: ownership is enforced by the routes' user-scoped queries
-- (user_id = session user, IDOR-404). No composite owner-guard FK is needed
-- here — unlike reading_positions (051) the row references nothing besides
-- its owner, so there is no second FK whose pairing could cross users.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write. (No CREATE INDEX
--   CONCURRENTLY — forbidden inside a transaction, and the table starts
--   empty.)
-- =============================================================================

CREATE TABLE IF NOT EXISTS generated_stories (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL,

    -- Story title (Korean), authored by the model alongside the body.
    title       TEXT        NOT NULL,
    -- The story text itself (Korean). The reader renders this as tappable
    -- text, same as reading_passages bodies.
    body_ko     TEXT        NOT NULL,
    -- Target proficiency band the story was generated AT (server-chosen from
    -- the request, never echoed back from model output).
    level       proficiency_level NOT NULL,
    -- Optional user-supplied topic the story was generated from (NULL = none).
    prompt      TEXT,

    -- Audit columns (ADR-001 D6)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    version     INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_generated_stories_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- Bounds are the DB floor under the route's tighter Zod caps (see header).
    CONSTRAINT ck_generated_stories_title_length
        CHECK (length(title) BETWEEN 1 AND 300),
    CONSTRAINT ck_generated_stories_body_length
        CHECK (length(body_ko) BETWEEN 1 AND 20000),
    CONSTRAINT ck_generated_stories_prompt_length
        CHECK (prompt IS NULL OR length(prompt) BETWEEN 1 AND 2000),
    CONSTRAINT ck_generated_stories_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE generated_stories IS
    'AI-generated short Korean reading stories (F-068). Written by POST '
    '/reading/generate (Claude proxy route ''generate_story'', enum value '
    'added by 053); listed/read back by GET /reading/generated[/:id], always '
    'scoped to the owning user. CASCADEs away with the user.';
COMMENT ON COLUMN generated_stories.level IS
    'Target proficiency band the story was generated at — the SERVER-chosen '
    'request value, never model output (a model echo could drift from what '
    'was asked for).';
COMMENT ON COLUMN generated_stories.prompt IS
    'Optional user-supplied topic the story was generated from; NULL when the '
    'user asked for no particular topic. Displayed on the story card and '
    'reusable for a regenerate-with-same-topic action.';

CREATE INDEX IF NOT EXISTS ix_generated_stories_user_created
    ON generated_stories (user_id, created_at DESC);

CREATE OR REPLACE TRIGGER trg_generated_stories_updated_at
    BEFORE UPDATE ON generated_stories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- End of 054_generated_stories.up.sql — runner owns the transaction (ADR-013).
