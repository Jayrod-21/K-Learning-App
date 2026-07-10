-- =============================================================================
-- 046 (down): restore the single-slot tombstone model (037 + F-UP-014 shape).
--
-- BEST-EFFORT / LOSSY by design — the up direction is strictly more expressive
-- than what it replaced, so the reverse cannot be perfect:
--   * Attempt HISTORY is discarded: the pre-046 model holds at most ONE row per
--     user, so all but one attempt per user are DELETEd (the active one wins if
--     present, else the most recently updated). This is the unavoidable loss;
--     graded answers are untouched (topik_responses is append-only and keeps
--     every row — it only loses the attempt_id grouping column).
--   * The surviving closed row (status <> 'active') IS trivially re-encodable
--     and is re-encoded exactly as /mock/submit wrote tombstones pre-046:
--     picks = {"__closed__": true}, current_idx = 0, remaining_ms = 0. Its
--     updated_at (the submit time) is preserved by disabling the trigger
--     around the UPDATE, so the pre-046 route's tombstone grace-window logic
--     sees the correct age. A surviving ACTIVE row round-trips losslessly.
--
-- Idempotent / re-runnable: the status-dependent steps run inside a DO $$
-- block guarded on the column's existence, and every DROP/CREATE uses
-- IF EXISTS / IF NOT EXISTS — re-applying this file against a DB where it
-- already succeeded is a no-op (the 044 posture for manual re-applies).
--
-- Order matters: collapse to one row per user BEFORE recreating the full
-- unique index, and drop the responses FK/column before its referenced index
-- changes are irrelevant to it (the FK targets the PK, but keeping teardown
-- first mirrors 044's dependents-first ordering).
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner owns
-- the transaction.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. topik_responses loses its attempt grouping (index → FK → column). The
--    response rows themselves — the user's graded answer history — all remain.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS ix_topik_responses_attempt;
ALTER TABLE topik_responses
    DROP CONSTRAINT IF EXISTS fk_topik_responses_attempt;
ALTER TABLE topik_responses
    DROP COLUMN IF EXISTS attempt_id;

-- -----------------------------------------------------------------------------
-- 2. Collapse attempt history to the pre-046 single slot and re-encode the
--    survivor. Guarded on the status column so a manual re-apply (column
--    already gone) skips cleanly instead of erroring.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'topik_attempts'
                 AND column_name = 'status') THEN

        -- 2a. One row per user survives: an in-progress attempt outranks any
        --     closed one (the pre-046 slot held whatever the user did LAST —
        --     an unfinished exam is resumable, history is not), then most
        --     recently updated, id as the deterministic tie-break.
        DELETE FROM topik_attempts t
         USING (SELECT id,
                       row_number() OVER (
                           PARTITION BY user_id
                           ORDER BY (status = 'active') DESC,
                                    updated_at DESC,
                                    id DESC
                       ) AS rn
                  FROM topik_attempts) ranked
         WHERE t.id = ranked.id
           AND ranked.rn > 1;

        -- 2b. Re-encode a surviving closed row as the F-UP-014 tombstone —
        --     byte-for-byte what pre-046 /mock/submit wrote. Trigger disabled
        --     to keep updated_at = the real close time (the tombstone grace
        --     window in the pre-046 route reads it).
        ALTER TABLE topik_attempts DISABLE TRIGGER trg_topik_attempts_updated_at;

        UPDATE topik_attempts
           SET picks        = jsonb_build_object('__closed__', true),
               current_idx  = 0,
               remaining_ms = 0
         WHERE status <> 'active';

        ALTER TABLE topik_attempts ENABLE TRIGGER trg_topik_attempts_updated_at;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Remove the lifecycle machinery. Dropping the column would cascade-drop
--    the partial index anyway; the explicit DROPs keep the teardown readable.
--    The CHECK constraint is owned by the column and goes with it.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_topik_attempts_user_active;
ALTER TABLE topik_attempts
    DROP CONSTRAINT IF EXISTS ck_topik_attempts_status;
ALTER TABLE topik_attempts
    DROP COLUMN IF EXISTS status;

-- -----------------------------------------------------------------------------
-- 4. Restore 037's one-row-EVER unique. Satisfiable by construction: step 2a
--    left at most one row per user.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_topik_attempts_user
    ON topik_attempts (user_id);

-- End of 046_topik_attempts_history.down.sql — runner owns the transaction (ADR-013).
