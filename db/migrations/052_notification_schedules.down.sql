-- =============================================================================
-- 052 (down): drop the F-040 notification tables.
--
-- LOSSY by design: rolling back discards every stored notification schedule
-- (the user's chosen times/channels) and the entire delivery log. Nothing
-- else references these tables, so the drop is otherwise self-contained; the
-- notif booleans in users.preferences (018) are untouched and remain whatever
-- the Settings screen last wrote.
--
-- Destructive gate: unlike 046.down (DELETE/DROP COLUMN, which the runner's
-- DESTRUCTIVE_PATTERNS does not match), this file contains real DROP TABLE
-- statements — `migrate.py down` through 052 REQUIRES --allow-destructive.
--
-- Order: deliveries (FK dependent) before schedules — dependents-first, the
-- 040/044 teardown posture. The trigger + index are table-owned and go with
-- their tables; set_updated_at() is shared (001) and must remain.
--
-- Idempotent: IF EXISTS on both drops — re-applying against a DB where this
-- already succeeded is a no-op.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — the runner owns
-- the transaction.
-- =============================================================================

DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notification_schedules;

-- End of 052_notification_schedules.down.sql — runner owns the transaction (ADR-013).
