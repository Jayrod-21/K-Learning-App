-- migrate: non-destructive
-- =============================================================================
-- Migration 103 — generated_items audio columns (F-220 slice 3: generated
--   LISTENING items — dialogue script + ElevenLabs multi-voice audio)
--   UP — extends `generated_items` (101) so a row can carry a TRANSIENT
--        dialogue script and, once synthesized, point at a real playable
--        audio blob:
--          §1 `turns JSONB` — the multi-turn dialogue script the $0 script
--             generator writes (`generateDiagnosticListeningItem`) and the
--             METERED `synthesize-listening-audio` CLI later consumes and
--             turns into audio. NULL for vocab/grammar/reading rows and for
--             a listening row not yet authored.
--          §2 `audio_cost_estimate_usd NUMERIC(12,6)` /
--             `audio_synthesized_at TIMESTAMPTZ` — the per-item ElevenLabs
--             spend ledger + settle timestamp, written ONCE by the synth CLI
--             in the same UPDATE that sets `audio_source_id` (mirrors 096's
--             `story_audio_jobs.cost_estimate_usd` settle-only contract).
--          §3 `fk_generated_items_audio_source` — 101 already carries the
--             (until now unconstrained) `audio_source_id` column; this
--             migration makes it a REAL FK into `audio_sources(id)`, ON
--             DELETE SET NULL (an operator deleting/re-cutting the shared
--             audio set must not be blocked, and a listening item losing its
--             audio just becomes un-servable — `pickGeneratedItem` already
--             requires `audio_source_id IS NOT NULL` — not corrupt).
--          §4 widens `ck_audio_sources_kind` (081's 4-value set) to admit
--             `'generated_listening'` — the kind the synth CLI stamps on the
--             ONE shared `audio_sources`/`audio_tracks` pair it creates per
--             synthesized item, under the SYSTEM/seed-admin owner account
--             with `is_shared = true` (079's flag — mirrors
--             `share-corpus.ts`'s owner-by-email mechanism; NOT a re-own, a
--             widen-the-shared-flag-to-a-fresh-row posture).
--   Reverse: 103_generated_items_audio.down.sql
--   Depends on: 101_generated_items (generated_items, audio_source_id),
--               081_story_audio (audio_sources.kind's 4-value CHECK — this
--               migration widens it, the same drop+re-add maneuver 081 used
--               on 073's original 3-value set).
--
-- WHY turns IS JSONB, NOT A CHILD TABLE (mirrors 081 §1's generated_stories.
--   turns and 101's own choices column) — a small, fixed-shape ordered array
--   ({speaker, gender, text}[], 2-6 elements), written once by the $0
--   generator, read once by the synth CLI, never queried per-turn. Element
--   shape is the generation schema's job
--   (DiagnosticListeningItemResultSchema, services/claude/models.ts) — only
--   array-ness is pinned here as defense-in-depth (081's exact stance).
--
-- WHY audio_cost_estimate_usd IS NULLABLE, SETTLED ONCE (mirrors 096 exactly)
--   A listening row exists in TWO phases: authored-but-silent (turns set,
--   audio_source_id/audio_cost_estimate_usd/audio_synthesized_at all NULL)
--   and synthesized (all three set together, in the SAME UPDATE, by the
--   synth CLI — never a separate write, so cost and audio_source_id can
--   never disagree). NULL therefore means "no audio spend has been recorded
--   for this row" — exactly true before synthesis — never "spent $0".
--
-- WHY THE FK IS PLAIN (not composite/owner-pinned like 073/074/081's
--   audio_sources FKs) — generated_items carries no user_id (101's own
--   design note: shared reference content, same posture as topik_items).
--   There is no per-row owner to pin against; the FK's only job is
--   referential integrity (a generated_items row can never point at a
--   nonexistent audio_sources row), which a plain FK on the PK gives in full.
--
-- WHY ON DELETE SET NULL (not RESTRICT/CASCADE) — mirrors 073's
--   source_upload_id rationale: "audio can be regenerated" (this migration's
--   own build-brief wording). An operator re-cutting or removing a shared
--   audio set must not be blocked by every listening item that references
--   it, and a generated_items row losing its audio_source_id simply reverts
--   to "authored but not yet synthesized" — `pickGeneratedItem`'s
--   `audio_source_id IS NOT NULL` gate already excludes it from the draw,
--   exactly the same degrade-to-unservable-not-corrupt posture 073 documents
--   for a paired-reader set outliving its book.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   This file MUST NOT contain top-level BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
--   `migrate.py` wraps each migration body in a single transaction together
--   with the schema_migrations bookkeeping write.
--
-- Manual application: psql -v ON_ERROR_STOP=1 -1 -f 103_generated_items_audio.up.sql
-- (NOT recommended in production — use migrate.py; manual psql application
-- desyncs schema_migrations and breaks the next deploy.)
-- =============================================================================

SET LOCAL client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- 1. turns — the transient multi-voice dialogue script (F-220 slice 3).
-- -----------------------------------------------------------------------------
ALTER TABLE generated_items ADD COLUMN IF NOT EXISTS turns JSONB;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_generated_items_turns_array'
                     AND conrelid = 'generated_items'::regclass) THEN
        ALTER TABLE generated_items
            ADD CONSTRAINT ck_generated_items_turns_array
            CHECK (turns IS NULL OR jsonb_typeof(turns) = 'array');
    END IF;
END $$;

COMMENT ON COLUMN generated_items.turns IS
    'F-220 slice 3: the TRANSIENT multi-voice dialogue script '
    '[{speaker, gender, text}, …] the $0 generateDiagnosticListeningItem '
    'writer emits for section=''listening'' rows — consumed by the METERED '
    '`synthesize-listening-audio` CLI, which turns it into the ONE audio '
    'blob audio_source_id points at. NULL for vocab/grammar/reading rows '
    'and for a listening row not yet authored. Never read by the diagnostic '
    'draw path directly (`pickGeneratedItem`) — the learner only ever gets '
    'the resulting audio URL, never this text (see routes/diagnostic.ts''s '
    'listening mapping — no ServerItem.passage from turns).';

-- -----------------------------------------------------------------------------
-- 2. audio_cost_estimate_usd / audio_synthesized_at — the per-item ElevenLabs
--    spend ledger, settled ONCE by the synth CLI alongside audio_source_id.
-- -----------------------------------------------------------------------------
ALTER TABLE generated_items ADD COLUMN IF NOT EXISTS audio_cost_estimate_usd NUMERIC(12,6);
ALTER TABLE generated_items ADD COLUMN IF NOT EXISTS audio_synthesized_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_generated_items_audio_cost_nonneg'
                     AND conrelid = 'generated_items'::regclass) THEN
        ALTER TABLE generated_items
            ADD CONSTRAINT ck_generated_items_audio_cost_nonneg
            CHECK (audio_cost_estimate_usd IS NULL OR audio_cost_estimate_usd >= 0);
    END IF;
END $$;

COMMENT ON COLUMN generated_items.audio_cost_estimate_usd IS
    'F-220 slice 3 spend ledger: ElevenLabs synthesis cost estimate in USD '
    '(char_count / 1000 * ELEVENLABS_USD_PER_1K_CHARS), written in the SAME '
    'UPDATE that sets audio_source_id (server/src/scripts/'
    'synthesize-listening-audio.ts). NULL before synthesis — never $0. '
    'Summed by server/src/services/spendCeiling.ts as a 4th global-'
    'spend-ceiling source (WHERE audio_synthesized_at >= today, mirrors '
    '096''s story_audio_jobs/story_image_jobs settle-only contract).';
COMMENT ON COLUMN generated_items.audio_synthesized_at IS
    'F-220 slice 3: when this item''s audio was synthesized (settled in the '
    'same UPDATE as audio_source_id/audio_cost_estimate_usd). NULL until '
    'synthesized. Backs spendCeiling.ts''s per-UTC-day WHERE clause.';

-- -----------------------------------------------------------------------------
-- 3. audio_source_id -> audio_sources(id) — 101 left this column
--    unconstrained (forward-compat); this slice is the first writer, so it
--    becomes a real FK now. ON DELETE SET NULL — see the up header.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'fk_generated_items_audio_source'
                     AND conrelid = 'generated_items'::regclass) THEN
        ALTER TABLE generated_items
            ADD CONSTRAINT fk_generated_items_audio_source
            FOREIGN KEY (audio_source_id) REFERENCES audio_sources(id)
            ON DELETE SET NULL ON UPDATE RESTRICT;
    END IF;
END $$;

COMMENT ON COLUMN generated_items.audio_source_id IS
    'F-220 slice 3: the audio_sources row holding this item''s ONE '
    'synthesized dialogue blob (kind = ''generated_listening'', owned by '
    'the SYSTEM/seed-admin account with is_shared = true — see '
    'server/src/scripts/synthesize-listening-audio.ts and '
    'share-corpus.ts''s owner-by-email mechanism it mirrors). NULL until '
    'synthesized; ON DELETE SET NULL — audio can be regenerated, so a '
    'deleted/re-cut audio set degrades this item to un-servable '
    '(pickGeneratedItem requires NOT NULL), never corrupt. Paired with '
    'audio_start_ms = 0 / audio_end_ms = the track''s full duration (one '
    'blob per item — no sub-window).';

-- -----------------------------------------------------------------------------
-- 4. Widen audio_sources.kind to admit 'generated_listening' — the kind the
--    synth CLI stamps on the shared blob it creates per item. Drop + re-add
--    (081's exact maneuver on 073's original set): idempotent, and validates
--    existing rows against a SUPERSET, so it can never fail on live data.
-- -----------------------------------------------------------------------------
ALTER TABLE audio_sources DROP CONSTRAINT IF EXISTS ck_audio_sources_kind;
ALTER TABLE audio_sources ADD CONSTRAINT ck_audio_sources_kind
    CHECK (kind IN ('paired_reader', 'standalone_listening', 'topik', 'generated_story', 'generated_listening'));

-- End of 103_generated_items_audio.up.sql — runner owns the transaction (ADR-013).
