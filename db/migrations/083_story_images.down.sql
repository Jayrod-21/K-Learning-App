-- migrate: destructive
-- =============================================================================
-- Migration 083 — story illustrations (DOWN)
--   Reverses 083_story_images.up.sql: drops story_image_jobs and
--   story_images.
--
-- LOSSY BY DESIGN (hence the destructive marker; migrate.py requires
-- --allow-destructive):
--   * story_image_jobs — the illustration job history INCLUDING the per-user
--     daily cap's image_count ledger — is discarded.
--   * story_images — every generated illustration's row (blob_ref, prompt,
--     dimensions) — is discarded. Re-derivable data: re-upping and
--     re-illustrating rebuilds it (a paid image call per scene). Blob FILES
--     under IMAGE_STORAGE_DIR are NOT removed — the DB never deletes files
--     (041/074's posture); orphaned illustration blobs are an operator
--     cleanup.
--   * The 'story_image_prompts' claude_route enum value is deliberately LEFT
--     IN PLACE: Postgres cannot drop enum values, and a superfluous value is
--     harmless (nothing writes it once the route code is gone) — the same
--     reason 031/032/053/057 ship no down at all. The claude_route drift
--     guard runs against the fully-migrated chain, so it never sees this
--     intermediate state.
--
-- generated_stories and 081's uq_generated_stories_id_user are untouched —
-- 081 owns them (074's down posture: drop only what you created).
--
-- Post-083 route code (the /reading/generated/:id/images trio + the runner)
-- must not run against a pre-083 schema (035/078's contract).
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — the runner owns the transaction.
-- =============================================================================

-- The jobs table first, then the images (both FK generated_stories; order is
-- immaterial between them but jobs-first mirrors 081's down).
DROP TABLE IF EXISTS story_image_jobs;
DROP TABLE IF EXISTS story_images;

-- End of 083_story_images.down.sql — runner owns the transaction (ADR-013).
