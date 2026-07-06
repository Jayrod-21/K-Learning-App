-- 038 (down): drop writing_attempts; untag + restore the writing_prompts bank.
--
-- LOSSY by design: rolling back discards ALL persisted writing attempts (the
-- F-017 Writing chart's entire history). The prompt bank itself is restored to
-- its pre-038 shape: the six Q53/Q54 seed rows this migration added are
-- DELETEd (see below), and the legacy register-drill rows are re-activated.
--
-- WHY DELETE (not just deactivate) the 038 seed rows: they are 038-owned seed
-- data, and a later re-up must be able to rebuild the exact post-038 state.
-- If they survived the down, the re-up's ALTER would leave them rubric = NULL,
-- its "retire rubric-NULL rows" UPDATE would deactivate them, and the reseed's
-- ON CONFLICT (source_id) DO NOTHING would silently keep them dead — an empty
-- active pool. Deleting here keeps down→up a true round trip. No FK breakage:
-- writing_attempts (the only prompt_id referrer) is dropped first.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

-- 1. Attempts history (trigger + index are table-owned and go with it;
--    set_updated_at() is shared (001) and must remain).
DROP TABLE IF EXISTS writing_attempts;

-- 2. Remove the 038-seeded TOPIK II prompts (see header for why DELETE).
DELETE FROM writing_prompts
 WHERE source_id IN (
    'wp-topik53-01', 'wp-topik53-02', 'wp-topik53-03',
    'wp-topik54-01', 'wp-topik54-02', 'wp-topik54-03'
 );

-- 3. Re-activate the legacy register-drill rows retired by the up (must run
--    BEFORE the column drop, while the rubric discriminator still exists).
UPDATE writing_prompts SET is_active = TRUE WHERE rubric IS NULL;

-- 4. Drop the rubric tagging.
ALTER TABLE writing_prompts DROP CONSTRAINT IF EXISTS ck_writing_prompts_rubric;
ALTER TABLE writing_prompts DROP COLUMN IF EXISTS rubric;
