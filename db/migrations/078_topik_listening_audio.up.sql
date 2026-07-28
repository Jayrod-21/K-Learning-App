-- migrate: non-destructive
-- =============================================================================
-- Migration 078 — TOPIK listening audio (F-119, whole-file + offsets)
--   UP — gives the official TOPIK mock tests real listening audio without
--        cutting ~960 clip files: the paper's whole-section MP3 maps onto
--        `topik_tests.audio_path` (the 035 relative-key contract, verbatim)
--        and each question carries an (audio_start_ms, audio_end_ms) window
--        into that file on `topik_items`, guarded by a both-or-neither span
--        CHECK. A boundary fix is a two-integer UPDATE, never a re-cut.
--        See docs/TOPIK_MOCK_AUDIO_PLAN.md §3–§4.
--   Reverse: 078_topik_listening_audio.down.sql
--   Depends on: 005_lesson_podcast_topik (topik_tests + topik_items — the
--               two tables being widened), 035_ttmik_audio (the audio_path
--               relative-key-under-CORPUS_AUDIO_DIR contract this column
--               mirrors, comment included).
--
-- DESIGN NOTES
--   * audio_path is the SAME contract as 035's ttmik_lessons/iyagi_episodes
--     columns: a RELATIVE key under the corpus audio root (CORPUS_AUDIO_DIR),
--     NEVER host-absolute — the row serves any mount point and a leaked row
--     never reveals filesystem layout; the serving route re-anchors it under
--     the configured root and enforces the traversal/symlink boundary (the
--     DB stores data, the boundary enforces it). Meaningful only on
--     section = 'listening' rows; reading/writing rows and unmapped
--     listening papers stay NULL ("no audio mapped yet" — every existing
--     row's state until tools/ingest/loaders/load_topik_audio.py runs).
--     Nullable + expand-only, no backfill, exactly 035's posture. NOT
--     CHECK-pinned to the listening section: the loader's keyed UPDATE
--     (… AND section = 'listening') owns that scoping, same as 035 left
--     filename matching to its loader.
--   * The span CHECK is BOTH-OR-NEITHER: a half-written window (one bound
--     set, the other NULL) is impossible at rest — an item either has a
--     complete, playable window or none. The valid-span arm spells out
--     `IS NOT NULL` on both bounds because the plan's shorthand
--     `(start >= 0 AND end > start)` alone would NOT reject a half-span:
--     with one bound NULL the comparison yields NULL, the OR yields NULL,
--     and a CHECK ACCEPTS NULL — the exact NULL-propagation trap the
--     constraint exists to close. end > start (strict) also outlaws
--     zero-length and inverted windows.
--   * PAIRED questions (one dialogue covering e.g. Q29–30) carry IDENTICAL
--     spans on both rows — deliberate denormalization: the alternative (a
--     segments table + item FK) buys nothing for a read-only two-integer
--     window and costs a join on the mock hot path. The segment JSONs the
--     loader consumes keep `item_numbers` as an array; fan-out to N rows
--     happens at load time (plan §5–§6).
--   * Segmentation PROVENANCE (confidence, aligner version, matched "N번"
--     marker, source-MP3 sha256) lives in the existing topik_items.extra
--     JSONB under an 'audio_seg' key — exactly what 005 built extra for
--     ("anything the loader saw without a stable column"); no provenance
--     columns.
--   * The CHECK add is guarded through pg_constraint inside DO $$ … $$ —
--     Postgres has no ADD CONSTRAINT IF NOT EXISTS (044 §0's pattern,
--     074/077 precedent), so a manual re-apply of this file against a DB
--     where it already succeeded must not error; conrelid-scoped so a
--     same-named constraint on another table can't mask a missing one here.
--     ADD COLUMN IF NOT EXISTS makes the rest of the body re-runnable too.
--   * No new index: all three columns are only ever SELECTed through the
--     existing keys (uq_topik_tests_number_level_section from 029,
--     uq_topik_items_test_number from 005), never filtered on — 035's
--     exact stance.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. topik_tests.audio_path — the paper's whole-section MP3 (035's contract).
-- -----------------------------------------------------------------------------
ALTER TABLE topik_tests
    ADD COLUMN IF NOT EXISTS audio_path TEXT;

COMMENT ON COLUMN topik_tests.audio_path IS
    'Relative key of this paper''s whole-section listening MP3 under the '
    'corpus audio root (CORPUS_AUDIO_DIR), e.g. ''TOPIK TEST/60 - 60th '
    'TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Audio.mp3''. Meaningful only on '
    'section = ''listening'' rows; NULL = no audio mapped. Written by '
    'tools/ingest/loaders/load_topik_audio.py; served by '
    'GET /topik/audio/:testNumber/:level. Never a host-absolute path — '
    'same contract as ttmik_lessons.audio_path (035).';

-- -----------------------------------------------------------------------------
-- 2. topik_items span columns + the both-or-neither window CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE topik_items
    ADD COLUMN IF NOT EXISTS audio_start_ms INTEGER,
    ADD COLUMN IF NOT EXISTS audio_end_ms   INTEGER;

-- Both-or-neither, with the NOT NULL conjuncts spelled out — without them a
-- half-span makes the valid-span arm NULL and the CHECK would ACCEPT it
-- (see header). Guarded through pg_constraint: no ADD CONSTRAINT IF NOT
-- EXISTS in Postgres (044 §0 / 077's pattern).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_topik_items_audio_span'
                     AND conrelid = 'topik_items'::regclass) THEN
        ALTER TABLE topik_items
            ADD CONSTRAINT ck_topik_items_audio_span CHECK (
                (audio_start_ms IS NULL AND audio_end_ms IS NULL)
                OR (audio_start_ms IS NOT NULL AND audio_end_ms IS NOT NULL
                    AND audio_start_ms >= 0 AND audio_end_ms > audio_start_ms)
            );
    END IF;
END $$;

COMMENT ON COLUMN topik_items.audio_start_ms IS
    'Start of this question''s window (ms) into the paper''s whole-section '
    'MP3 (topik_tests.audio_path). NULL = no span mapped (transcript-only '
    'rendering). Paired questions (one dialogue, e.g. Q29-30) carry '
    'identical spans — deliberate denormalization, see 078. Written by '
    'tools/ingest/loaders/load_topik_audio.py from the segmentation JSONs; '
    'provenance rides extra->''audio_seg''.';
COMMENT ON COLUMN topik_items.audio_end_ms IS
    'End of this question''s window (ms), exclusive bound the player pauses '
    'at; > audio_start_ms whenever set (ck_topik_items_audio_span). NULL = '
    'no span mapped. Both bounds are set together or not at all — a '
    'half-written window is impossible at rest.';
COMMENT ON CONSTRAINT ck_topik_items_audio_span ON topik_items IS
    'Both-or-neither span window: either no audio mapping (both NULL) or a '
    'complete valid window (start >= 0, end strictly greater). The IS NOT '
    'NULL conjuncts are load-bearing — without them a half-span evaluates '
    'the CHECK to NULL, which Postgres accepts (NULL-propagation).';

-- End of 078_topik_listening_audio.up.sql — runner owns the transaction (ADR-013).
