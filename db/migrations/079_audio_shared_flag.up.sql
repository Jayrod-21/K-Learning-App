-- migrate: non-destructive
-- =============================================================================
-- Migration 079 — shared-corpus flag (F-207, phase 1)
--   UP — adds `is_shared BOOLEAN NOT NULL DEFAULT false` to `audio_sources`
--        and `book_uploads`: the operator-set curated-corpus flag that opens
--        READ access to a set/book across ALL accounts while every mutation
--        path stays owner-only. See docs/LISTEN_SHARED_CORPUS_PLAN.md §4–§5.
--   Reverse: 079_audio_shared_flag.down.sql
--   Depends on: 073_audio_sources (audio_sources), 040_book_uploads
--               (book_uploads).
--
-- DESIGN NOTES
--   * A FLAG, NOT A RE-OWN. `user_id` is woven into the composite owner FKs
--     (audio_tracks.(source_id, user_id) → audio_sources(id, user_id), 074;
--     audio_sources.(source_upload_id, user_id) → book_uploads(id, user_id),
--     073 riding 044's uq_book_uploads_id_user). Re-owning shared rows to a
--     corpus account — or NULLing user_id — would break that graph and with
--     it the structural IDOR guard the no-join streaming probe depends on.
--     So sharing is purely additive read-access: the owner never changes,
--     every composite-FK invariant and every owner-only WHERE on a mutation
--     path is untouched.
--   * OPERATOR-SET ONLY. No route writes this column — a one-time cutover
--     script (phase 2) flips it on the curated corpus; new uploads default
--     false (private), so no user can share their own arbitrary content or
--     un-share/steal someone else's (the plan's share-flag-hijack threat).
--   * EXPAND-ONLY, SAFE ON THE LIVE DB. ADD COLUMN ... NOT NULL DEFAULT on
--     PG 11+ is a catalog-only change (no table rewrite — the default is
--     stored and materialized lazily), and every existing row reads back
--     false: nothing becomes shared by applying this migration.
--   * BOTH TABLES NOW, AUDIO ROUTES FIRST. Phase 1 wires only the AUDIO read
--     paths (routes/audio.ts); the book read-route relaxation ships with the
--     Read UI (phase 3). Adding book_uploads.is_shared here anyway avoids a
--     second migration for a column with identical shape and rationale.
--   * NO INDEX. The shared-list query (`WHERE is_shared = true`) scans a
--     table whose curated-shared population is ~21 sets / 3 books and whose
--     total row count is single-user-app small; a partial index would be
--     pure ceremony. Revisit only if the corpus ever grows enough to matter.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. audio_sources.is_shared — the Listen surface's curated-corpus flag.
-- -----------------------------------------------------------------------------
ALTER TABLE audio_sources
    ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN audio_sources.is_shared IS
    'Operator-set curated-corpus flag; opens READ access to all accounts, '
    'mutation stays owner-only (F-207). Never written by any route — only '
    'the one-time cutover script flips it; new uploads stay false (private). '
    'Read paths widen to (user_id = $me OR is_shared = true); every write '
    'path keeps user_id = $me.';

-- -----------------------------------------------------------------------------
-- 2. book_uploads.is_shared — same flag for the Read surface (wired phase 3).
-- -----------------------------------------------------------------------------
ALTER TABLE book_uploads
    ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN book_uploads.is_shared IS
    'Operator-set curated-corpus flag; opens READ access to all accounts, '
    'mutation stays owner-only (F-207). Never written by any route — only '
    'the one-time cutover script flips it; new uploads stay false (private). '
    'Column added with 079 (audio phase) to avoid a second migration; the '
    'book READ routes widen in F-207 phase 3.';

-- End of 079_audio_shared_flag.up.sql — runner owns the transaction (ADR-013).
