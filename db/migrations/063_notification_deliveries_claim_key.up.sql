-- migrate: non-destructive
-- =============================================================================
-- Migration 063 — notification_deliveries claim key (F-092)
--   UP — adds `window_start` to `notification_deliveries` (052) and a UNIQUE
--        constraint on `(schedule_id, window_start)`: the real idempotency
--        arbiter for the future notification sender. 052's original design
--        note called this "probe-newest-then-insert" — read the newest
--        delivery row for a schedule, and if none looks like "already sent
--        this firing", insert a pending one. That is a read-then-write race:
--        two concurrent sender workers can both probe, both see nothing, and
--        both insert — a double-send. This migration makes the INSERT itself
--        the arbiter: `INSERT ... ON CONFLICT (schedule_id, window_start) DO
--        NOTHING` either wins the claim (a row comes back) or loses it
--        (0 rows) atomically, at the database's own row-lock granularity —
--        no probe read is ever in the critical path.
--   Reverse: 063_notification_deliveries_claim_key.down.sql (DROP COLUMN —
--        declared destructive; see its own header).
--   Depends on: 052_notification_schedules (notification_deliveries).
--
-- WHY NOT NULL WITHOUT A DEFAULT: `notification_deliveries` is written by NO
-- code path today (F-040's phase shipped the tables only; the sender is a
-- later phase — 052's own header says so), so the table is empty in every
-- real environment. Adding a NOT NULL column with no DEFAULT is therefore
-- safe (Postgres only rejects this when existing rows would violate it) and
-- is the correct DESTINATION shape — a nullable `window_start` would let a
-- future sender bug insert an unclaimed row that the UNIQUE constraint can't
-- arbiter. If this migration's dry-run ever fails here, that is a genuine
-- signal that something wrote to this table out of band and needs
-- investigating, not a bug to silently work around with a placeholder default.
--
-- WHY A COLUMN, NOT JUST DERIVING THE WINDOW FROM created_at: `created_at` is
-- "when the claim row was inserted", which is NOT the same value across two
-- would-be-concurrent claims for the *same* firing (their created_at values
-- differ by however many milliseconds apart the workers ran) — it cannot be
-- the arbiter. `window_start` is instead the firing's OWN identity (e.g. the
-- minute-truncated instant the sender computed as "this schedule's due time
-- for this cycle"), which is IDENTICAL across every worker racing the same
-- firing — that identity is exactly what a UNIQUE constraint needs to key on.
--
-- MARKER (F-088): declared non-destructive — ADD COLUMN (even NOT NULL, on an
-- empty table) and ADD CONSTRAINT both create, never destroy. Contrast the
-- down file, which DROPs the column and is declared destructive.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps this body in a single transaction together with the bookkeeping
-- write.
-- =============================================================================

ALTER TABLE notification_deliveries
    ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ NOT NULL;

COMMENT ON COLUMN notification_deliveries.window_start IS
    'The discrete firing window this delivery claims — e.g. the '
    'minute-truncated instant the sender determined this schedule was due. '
    'SERVER-derived, never client-supplied. Paired with schedule_id in '
    'uq_notification_deliveries_schedule_window: THIS constraint (via the '
    'sender''s INSERT ... ON CONFLICT DO NOTHING), not a prior SELECT probe, '
    'is the real idempotency arbiter (F-092) — two concurrent workers racing '
    'the same firing can never both insert a pending row for it.';

ALTER TABLE notification_deliveries
    ADD CONSTRAINT uq_notification_deliveries_schedule_window
        UNIQUE (schedule_id, window_start);

COMMENT ON CONSTRAINT uq_notification_deliveries_schedule_window
    ON notification_deliveries IS
    'F-092 claim key: one delivery row per (schedule, firing window) — ever. '
    'A sender claims a firing via INSERT ... ON CONFLICT (schedule_id, '
    'window_start) DO NOTHING on this exact key; the INSERT succeeding '
    '(a row comes back) IS the claim. See services/notificationDelivery.ts '
    'claimDelivery().';

-- End of 063_notification_deliveries_claim_key.up.sql — runner owns the
-- transaction (ADR-013).
