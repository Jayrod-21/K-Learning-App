-- migrate: non-destructive
-- =============================================================================
-- Migration 096 — metered-spend cost columns (Phase 2.6, global spend ceiling)
--   UP — adds `cost_estimate_usd NUMERIC(12,6)` to `story_audio_jobs` (081)
--        AND `story_image_jobs` (083), mirroring `claude_usage.cost_estimate_usd`
--        (004)'s semantics: a dollar estimate computed at write time from an
--        operator-configured per-unit rate. Claude already has this column
--        (and a ledger `sumCostSince` reader — server/src/services/claude/
--        usage.ts); ElevenLabs TTS and OpenAI images had NO $ tracking at all
--        (only unit counts: char_count / image_count) until now. This
--        migration is the storage half of the global daily spend-ceiling
--        circuit breaker (server/src/services/spendCeiling.ts) — it sums
--        claude_usage + these two columns to decide whether a metered call
--        may proceed.
--   Reverse: 096_metered_spend_cost.down.sql
--   Depends on: 081_story_audio (story_audio_jobs), 083_story_images
--               (story_image_jobs).
--
-- DESIGN NOTE — NULLABLE, NOT NOT-NULL-DEFAULT-0
--   Unlike claude_usage.cost_estimate_usd (append-only, one row per
--   COMPLETED call, so 0 is always a legitimate value), a story_audio_jobs /
--   story_image_jobs row exists for the ENTIRE job lifecycle
--   (pending -> running -> done | failed) and this column is populated ONLY
--   at the done-settle UPDATE (server/src/services/storyAudio.ts,
--   storyImage.ts — char_count/image_count * the configured per-unit rate,
--   written in the SAME UPDATE that sets status='done'). A NOT NULL DEFAULT 0
--   would make every pending/running/failed row read as "$0 spent", which is
--   ambiguous with a job that genuinely spent nothing — NULL instead means
--   "no completed-call cost is recorded for this row", which is exactly true
--   for pending/running (the call hasn't happened) AND for failed (see below).
--
-- DESIGN NOTE — FAILED JOBS STAY NULL (deliberate departure from the
-- existing quota-counts-failed-jobs stance)
--   081/083/069/076 all count a FAILED job toward its per-user DAILY CAP
--   (quota) because a failed run can still have spent an upstream call before
--   it failed. This column is a different thing: an exact COST figure the
--   global ceiling sums verbatim, not a quota slot. Both runners can fail at
--   several distinct points (prompt-authoring before any TTS/image call;
--   mid-synthesis after SOME but not all scenes; after every scene but before
--   the atomic persist tx commits) — there is no single "the API was called N
--   times" number available at the generic failure handler
--   (storyAudio.ts/storyImage.ts's shared `settleFailed`) to convert into a
--   dollar figure, and OVER-estimating actual spend on a global circuit
--   breaker is the wrong failure direction (it would trip the breaker on
--   spend that never happened, blocking every user over a phantom total). A
--   job that never reaches 'done' therefore leaves this column NULL — real
--   provider spend on an aborted run (e.g. 2 of 4 images generated before a
--   failure) is real but UNTRACKED here; the ceiling undercounts that sliver
--   rather than overcounts, which is the safer direction for "don't
--   false-positive block everyone" (see spendCeiling.ts's own fail-open note
--   for the matching reasoning on a transient SUM-query error). Quota
--   (STORY_TTS_DAILY_CAP / STORY_IMAGE_DAILY_CAP) is still the authoritative
--   per-user abuse guard for failed runs; this column is cost-ledger-only.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps the up body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. story_audio_jobs.cost_estimate_usd — ElevenLabs TTS spend, settled at
--    done (char_count / 1000 * ELEVENLABS_USD_PER_1K_CHARS).
-- -----------------------------------------------------------------------------
ALTER TABLE story_audio_jobs
    ADD COLUMN IF NOT EXISTS cost_estimate_usd NUMERIC(12,6);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_story_audio_jobs_cost_estimate_nonneg'
                     AND conrelid = 'story_audio_jobs'::regclass) THEN
        ALTER TABLE story_audio_jobs
            ADD CONSTRAINT ck_story_audio_jobs_cost_estimate_nonneg
            CHECK (cost_estimate_usd IS NULL OR cost_estimate_usd >= 0);
    END IF;
END $$;

COMMENT ON COLUMN story_audio_jobs.cost_estimate_usd IS
    'F-UP (Phase 2.6) global spend-ceiling ledger: ElevenLabs TTS cost '
    'estimate in USD, computed as char_count / 1000 * '
    'ELEVENLABS_USD_PER_1K_CHARS and written in the SAME UPDATE that sets '
    'status = ''done'' (server/src/services/storyAudio.ts). NULL for '
    'pending/running (not yet settled) and for failed (no single call count '
    'is known at the generic failure handler — see the migration header''s '
    'design note; the daily QUOTA cap, unlike this cost column, still '
    'counts failed jobs). Summed by server/src/services/spendCeiling.ts '
    'alongside claude_usage.cost_estimate_usd and '
    'story_image_jobs.cost_estimate_usd for the global daily spend ceiling.';

-- -----------------------------------------------------------------------------
-- 2. story_image_jobs.cost_estimate_usd — OpenAI image spend, settled at
--    done (image_count * OPENAI_IMAGE_USD_PER_IMAGE). Prompt-authoring spend
--    (the Claude call inside this same job) is NOT included here — it is
--    already recorded in claude_usage by the Claude proxy; including it here
--    too would double-count it in the global sum.
-- -----------------------------------------------------------------------------
ALTER TABLE story_image_jobs
    ADD COLUMN IF NOT EXISTS cost_estimate_usd NUMERIC(12,6);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_story_image_jobs_cost_estimate_nonneg'
                     AND conrelid = 'story_image_jobs'::regclass) THEN
        ALTER TABLE story_image_jobs
            ADD CONSTRAINT ck_story_image_jobs_cost_estimate_nonneg
            CHECK (cost_estimate_usd IS NULL OR cost_estimate_usd >= 0);
    END IF;
END $$;

COMMENT ON COLUMN story_image_jobs.cost_estimate_usd IS
    'F-UP (Phase 2.6) global spend-ceiling ledger: OpenAI image cost '
    'estimate in USD, computed as image_count * OPENAI_IMAGE_USD_PER_IMAGE '
    'and written in the SAME UPDATE that sets status = ''done'' '
    '(server/src/services/storyImage.ts). Covers the OpenAI image spend '
    'ONLY — the prompt-authoring Claude call this job also makes is already '
    'recorded in claude_usage.cost_estimate_usd; adding it here too would '
    'double-count it in the global sum. NULL for pending/running (not yet '
    'settled) and for failed (see the migration header''s design note; the '
    'daily QUOTA cap, unlike this cost column, still counts failed jobs). '
    'Summed by server/src/services/spendCeiling.ts alongside '
    'claude_usage.cost_estimate_usd and story_audio_jobs.cost_estimate_usd '
    'for the global daily spend ceiling.';

-- End of 096_metered_spend_cost.up.sql — runner owns the transaction (ADR-013).
