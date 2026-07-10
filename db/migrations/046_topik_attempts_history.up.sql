-- =============================================================================
-- Migration 046 — topik_attempts history model (ticket A1; unblocks F-078/F-082
--                 TOPIK attempt history)
--   UP — converts topik_attempts from a single-slot resume cache into a proper
--        attempts model:
--          1. `status` TEXT CHECK ('active'|'completed'|'abandoned'), default
--             'active' — an explicit lifecycle column replacing the F-UP-014
--             '__closed__' tombstone key smuggled inside the `picks` JSONB.
--          2. The one-row-EVER unique (uq_topik_attempts_user) becomes a
--             PARTIAL unique: one ACTIVE attempt per user; completed/abandoned
--             rows are retained as attempt history.
--          3. topik_responses gains a nullable `attempt_id` FK so a mock's
--             graded answers group into the attempt that produced them.
--          4. Existing rows are migrated: a tombstoned row (picks contains
--             '__closed__') becomes status='completed' with the tombstone key
--             STRIPPED from picks; a live row stays status='active'.
--   Reverse: 046_topik_attempts_history.down.sql (best-effort — see its header)
--   Depends on: 037_topik_attempts (the table + uq_topik_attempts_user),
--               015_topik_responses (topik_responses).
--
-- WHY: 037 deliberately shipped a single-slot cache ("a row's mere existence
-- means in-progress"), and F-UP-014 then encoded "submitted" as a '__closed__'
-- key inside the picks payload because there was no status column — a state
-- machine living in user data. Consequences: no attempt ever survives as
-- history (each new mock overwrites the slot), topik_responses rows cannot be
-- grouped into the sitting that produced them, and the tombstone key is a
-- magic value the route layer must remember to filter everywhere. F-078/F-082
-- (attempt history surfaces) need real retained attempts, so the lifecycle
-- moves into the schema where it belongs.
--
-- DESIGN NOTES
--   * `status` is TEXT + CHECK, not an enum — the same call 015 made for
--     topik_responses.mode and .picked: a tiny, stable, table-local set stays
--     co-located with its table, and widening is a CHECK swap instead of an
--     enum-add migration (which per ADR-013 house rules must ship alone).
--   * The partial unique (user_id) WHERE status = 'active' keeps 037's
--     invariant where it still matters — the resume banner shows at most ONE
--     in-progress test — while letting closed rows accumulate per user. The
--     route's upsert arbiters on it via ON CONFLICT (user_id) WHERE
--     status = 'active', which is race-safe under concurrent saves.
--   * topik_responses.attempt_id is NULLABLE: every response logged before 046
--     (and every study-mode response — drills belong to no sitting) has no
--     attempt. ON DELETE SET NULL, not CASCADE: a response is an append-only
--     fact in the user's answer log (015's charter); deleting an attempt must
--     not silently destroy graded history — the response merely loses its
--     grouping. The index is partial (WHERE attempt_id IS NOT NULL) because
--     the only query shape is "the responses of attempt X"; NULL rows would
--     bloat it for nothing.
--   * The data migration UPDATE runs with the updated_at trigger disabled so a
--     migrated tombstone keeps its ORIGINAL updated_at (= the submit time).
--     That timestamp is meaningful history (when the attempt completed) and
--     also feeds the route's post-submit grace window — re-stamping it to
--     migration time would make every historic attempt look freshly submitted.
--     Disabling a trigger takes the same ACCESS EXCLUSIVE lock the ALTER TABLEs
--     here already take, and the runner holds it all inside one transaction.
--   * Idempotent / safe on 0..N rows: ADD COLUMN IF NOT EXISTS, guarded ADD
--     CONSTRAINT (pg_constraint check inside DO $$ — the 044 pattern; Postgres
--     has no ADD CONSTRAINT IF NOT EXISTS), and the tombstone UPDATE matches
--     nothing once the key is stripped. Prod carries ~1 row; correctness here
--     does not depend on that.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Lifecycle column. Default 'active' backfills every pre-046 row (a 037 row
--    exists ⇔ it was in progress — tombstones are reclassified in step 2).
-- -----------------------------------------------------------------------------
ALTER TABLE topik_attempts
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'ck_topik_attempts_status') THEN
        ALTER TABLE topik_attempts
            ADD CONSTRAINT ck_topik_attempts_status
                CHECK (status IN ('active', 'completed', 'abandoned'));
    END IF;
END $$;

COMMENT ON COLUMN topik_attempts.status IS
    'Attempt lifecycle: active (in progress — at most one per user, enforced '
    'by uq_topik_attempts_user_active), completed (submitted + graded), or '
    'abandoned (discarded via DELETE /topik/attempt). Completed/abandoned '
    'rows are RETAINED as attempt history (A1, F-078/F-082). Replaces the '
    'pre-046 ''__closed__'' tombstone key inside picks (F-UP-014).';

-- -----------------------------------------------------------------------------
-- 2. Migrate existing rows. A row whose picks carries the F-UP-014 tombstone
--    key was a submitted attempt → status='completed', tombstone key stripped
--    (picks returns to pure pick data — a tombstoned row's picks was exactly
--    {"__closed__": true}, so it typically strips to '{}'). Rows without the
--    key keep the 'active' default from step 1. Re-running matches nothing
--    (the key is gone), so this is idempotent. The updated_at trigger is
--    disabled around the UPDATE to preserve the original submit-time stamp —
--    see the module note.
-- -----------------------------------------------------------------------------
ALTER TABLE topik_attempts DISABLE TRIGGER trg_topik_attempts_updated_at;

UPDATE topik_attempts
   SET status = 'completed',
       picks  = picks - '__closed__'
 WHERE picks ? '__closed__';

ALTER TABLE topik_attempts ENABLE TRIGGER trg_topik_attempts_updated_at;

-- -----------------------------------------------------------------------------
-- 3. One ACTIVE attempt per user (partial unique) replaces one row EVER per
--    user. Order matters within this file only for readability — at this point
--    every user still has at most one row (the 037 invariant), so both indexes
--    are satisfiable; the old one is dropped first so no state ever violates
--    the model being installed.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_topik_attempts_user;

CREATE UNIQUE INDEX IF NOT EXISTS uq_topik_attempts_user_active
    ON topik_attempts (user_id)
 WHERE status = 'active';

COMMENT ON INDEX uq_topik_attempts_user_active IS
    'At most ONE in-progress (status=''active'') attempt per user — the resume '
    'banner shows a single test, and PUT /topik/attempt upserts via ON CONFLICT '
    '(user_id) WHERE status = ''active'' against this index. Completed and '
    'abandoned rows are unconstrained: they accumulate as attempt history '
    '(046 / A1).';

-- -----------------------------------------------------------------------------
-- 4. Group responses into the attempt that produced them. Nullable (legacy +
--    study-mode responses have no attempt); SET NULL keeps the append-only
--    answer log intact if an attempt row is ever deleted.
-- -----------------------------------------------------------------------------
ALTER TABLE topik_responses
    ADD COLUMN IF NOT EXISTS attempt_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'fk_topik_responses_attempt') THEN
        ALTER TABLE topik_responses
            ADD CONSTRAINT fk_topik_responses_attempt
                FOREIGN KEY (attempt_id) REFERENCES topik_attempts(id)
                ON DELETE SET NULL ON UPDATE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_topik_responses_attempt
    ON topik_responses (attempt_id)
 WHERE attempt_id IS NOT NULL;

COMMENT ON COLUMN topik_responses.attempt_id IS
    'The topik_attempts sitting this response was graded under (046 / A1), or '
    'NULL — every pre-046 response, and every study-mode drill answer, belongs '
    'to no attempt. Stamped by POST /topik/mock/submit in the same transaction '
    'that marks the attempt completed. ON DELETE SET NULL: the response is an '
    'append-only fact (015) and survives its attempt; it only loses grouping.';
COMMENT ON INDEX ix_topik_responses_attempt IS
    'Supports "the graded answers of attempt X" (F-078/F-082 history detail). '
    'Partial — NULL attempt_id rows (legacy + study mode) are never looked up '
    'by attempt and would only bloat the index.';

-- End of 046_topik_attempts_history.up.sql — runner owns the transaction (ADR-013).
