-- migrate: destructive
-- 063 (down): drop the claim-key constraint + column.
--
-- LOSSY: if any real delivery rows exist by the time this rolls back, their
-- window_start values (the only record of which firing each claim belongs
-- to) are discarded by the DROP COLUMN. This is exactly the shape F-088 was
-- written to catch and the legacy keyword-sniff does NOT (DROP COLUMN has no
-- DROP TABLE/SCHEMA/DATABASE or TRUNCATE keyword) — declared destructive
-- explicitly here so --allow-destructive is required regardless of whether
-- the sniff would have caught it.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

ALTER TABLE notification_deliveries
    DROP CONSTRAINT IF EXISTS uq_notification_deliveries_schedule_window;

ALTER TABLE notification_deliveries
    DROP COLUMN IF EXISTS window_start;

-- End of 063_notification_deliveries_claim_key.down.sql
