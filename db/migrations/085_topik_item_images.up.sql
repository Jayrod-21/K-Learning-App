-- migrate: non-destructive
-- =============================================================================
-- Migration 085 — TOPIK question images (F-120 Phase 1, plumbing only)
--   UP — gives each TOPIK item an optional image mapping: `image_ref` on
--        `topik_items` holds the corpus-RELATIVE key of the question's
--        cropped exam figure (the 035/078 relative-key contract, verbatim),
--        NULL = no image mapped. Ships EMPTY: no backfill, every existing
--        row stays NULL and the app behaves exactly as before (text-only
--        image descriptions) until tools/ingest/loaders/load_topik_image.py
--        runs against extraction manifests.
--   Reverse: 085_topik_item_images.down.sql
--   Depends on: 005_lesson_podcast_topik (topik_items — the table being
--               widened), 078_topik_listening_audio (the audio_path
--               relative-key-under-a-corpus-root contract this column
--               mirrors, per-item this time).
--
-- DESIGN NOTES
--   * image_ref is the SAME contract as 078's topik_tests.audio_path (which
--     itself mirrors 035): a RELATIVE key under the corpus image root
--     (CORPUS_IMAGE_DIR), NEVER host-absolute — the row serves any mount
--     point and a leaked row never reveals filesystem layout; the serving
--     route (GET /topik/image/:testNumber/:level/:itemNumber) re-anchors it
--     under the configured root and enforces the traversal/symlink boundary
--     (the DB stores data, the boundary enforces it).
--   * PER-ITEM, unlike 078's per-paper audio_path: the exam figures are one
--     crop per question, so the item row is the natural home — there is no
--     whole-paper image to window into.
--   * No index: image_ref is only ever SELECTed through the existing item
--     keys (uq_topik_items_test_number from 005 + the topik_tests join),
--     never filtered on — 035/078's exact stance.
--   * No CHECK: a single nullable TEXT column; relative-key validation is
--     the loader's parse-time contract plus the serving route's containment
--     guard (defense in depth) — a CHECK regex here would duplicate that
--     without adding a boundary.
--   * No user_id: shared official-corpus content (like the listening MP3s),
--     not a per-user blob.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

ALTER TABLE topik_items
    ADD COLUMN IF NOT EXISTS image_ref TEXT;

COMMENT ON COLUMN topik_items.image_ref IS
    'Relative key of this question''s cropped exam figure under the corpus '
    'image root (CORPUS_IMAGE_DIR), e.g. ''TOPIK IMAGES/60 - 60th TOPIK/'
    'TOPIK-II/listening/q01.png''. Mirrors topik_tests.audio_path (078) — '
    'never a host-absolute path. NULL = no image mapped (every row''s state '
    'until the backfill runs). Written by '
    'tools/ingest/loaders/load_topik_image.py; served by '
    'GET /topik/image/:testNumber/:level/:itemNumber.';

-- End of 085_topik_item_images.up.sql — runner owns the transaction (ADR-013).
