-- 047 (down): remove the km_app application role and every privilege it holds.
--
-- NOT lossy for app data — km_app owns no objects (it never had CREATE
-- anywhere, so nothing it could own exists) and this file touches no table
-- contents. What is removed: the role itself, its grants, and the
-- default-privilege entries that auto-granted it on future tables/sequences.
--
-- OPERATIONAL WARNING: after this rollback the app can no longer authenticate
-- as km_app. Rolling back 047 therefore also requires repointing the app's
-- DATABASE_URL back at the POSTGRES_USER superuser credentials
-- (Deploy/docker-compose.{blue,green}.yml as of this migration read
-- KM_APP_USER/KM_APP_PASSWORD) BEFORE bringing a color up — i.e. roll back the
-- compose change together with the schema change. The blue/green idle-color
-- health gate catches a mismatch before any traffic flip.
--
-- Idempotent: everything is guarded on the role's existence, so re-running
-- this file (or running it when 047's up never ran) is a clean no-op.
--
-- Order inside the guard matters:
--   1. ALTER DEFAULT PRIVILEGES ... REVOKE removes the future-objects entries
--      this migration's up added for CURRENT_USER (the migration-runner role —
--      same rationale as the up file for omitting FOR ROLE).
--   2. DROP OWNED BY km_app then sweeps EVERY remaining privilege granted to
--      km_app in THIS database — including default-privilege entries made by
--      any OTHER grantor — which is exactly what lets DROP ROLE succeed.
--      (km_app owns no objects, so "OWNED" drops nothing; it only revokes.
--      Roles are cluster-wide and DROP OWNED is per-database: km-db is a
--      single-database cluster, and if km_app ever did hold grants in another
--      database, DROP ROLE below would fail loudly rather than half-clean.)
--   3. DROP ROLE removes the cluster-wide role (and its password verifier).
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'km_app') THEN
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
            REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM km_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
            REVOKE USAGE, SELECT ON SEQUENCES FROM km_app;
        DROP OWNED BY km_app;
        DROP ROLE km_app;
    END IF;
END $$;

-- End of 047_km_app_role.down.sql
