-- migrate: destructive
-- =============================================================================
-- Migration 109 — generated_story_publish (DOWN)
--   Reverses 109_generated_story_publish.up.sql: drops the browse index and
--   the `source_story_id` / `is_shared` columns from `generated_stories`.
--
--   Marked destructive explicitly: DROP COLUMN is a data drop the legacy
--   keyword-sniff would MISS (F-088's marker — 079/083's downs took the
--   same posture).
--
-- LOSSY BY DESIGN, TRIVIALLY RECOVERABLE FOR is_shared
--   Rolling back discards which stories were published and any clone
--   provenance links. That is exactly 079's precedent: a handful of
--   owner-set booleans (here) with no separate system of record to
--   re-derive them from — publishing state is genuinely lost, not just
--   hidden, on a down+up round trip. No user CONTENT is dropped: the
--   generated_stories rows themselves (title/body_ko/level/prompt/turns)
--   are untouched; only the two new columns disappear. Post-109 route code
--   (the publish/browse/clone/widened-read routes) must not run against a
--   pre-109 schema (035/078's contract).
--
--   THIS SCRIPT REMOVES the fk_generated_stories_source_story constraint
--   itself (line 30, below), not merely the column it's attached to — the
--   FK does NOT stay enforced through rollback; nothing about it "survives"
--   this down migration (schema-review SF-2, F-220 fix-pass). The DROP
--   CONSTRAINT / DROP COLUMN ordering below is required (Postgres refuses to
--   drop a column a live constraint still references) and is exactly what
--   makes the round trip in test_109_down_requires_allow_destructive_then_
--   reverses_cleanly pass.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this down body in its
--   own transaction together with the bookkeeping DELETE.
-- =============================================================================

DROP INDEX IF EXISTS ix_generated_stories_shared;

ALTER TABLE generated_stories
    DROP CONSTRAINT IF EXISTS fk_generated_stories_source_story;

ALTER TABLE generated_stories
    DROP COLUMN IF EXISTS source_story_id;

ALTER TABLE generated_stories
    DROP COLUMN IF EXISTS is_shared;

-- End of 109_generated_story_publish.down.sql — runner owns the transaction (ADR-013).
