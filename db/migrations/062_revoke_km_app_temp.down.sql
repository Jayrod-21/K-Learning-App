-- migrate: non-destructive
-- 062 (down): restore the cluster's out-of-the-box TEMP defaults.
--
-- NON-LOSSY: no data is destroyed — this only re-grants a database-level
-- privilege that was never exercised (F-089 verified zero temp-table usage
-- anywhere in this codebase before the up-migration shipped). Marked
-- non-destructive for the same reason the up file is (F-088 marker).
--
-- Order is the mirror of the up file: restore PUBLIC's default first, then
-- km_app's own (defensive) grant, so a partial failure mid-rollback still
-- leaves the more-permissive (pre-062) state consistent rather than a
-- half-restored mix.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DO $$
BEGIN
    EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'km_app') THEN
        EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO km_app', current_database());
    END IF;
END $$;

-- End of 062_revoke_km_app_temp.down.sql
