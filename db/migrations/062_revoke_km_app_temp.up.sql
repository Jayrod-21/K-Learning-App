-- migrate: non-destructive
-- =============================================================================
-- Migration 062 — revoke default TEMP privilege from km_app (F-089)
--   UP — true least-privilege completion of B-030/047: Postgres grants every
--        role the TEMPORARY privilege on every database by default (via the
--        implicit PUBLIC pseudo-role), so `km_app` (migration 047) has always
--        been able to CREATE TEMP TABLE / TEMP VIEW / TEMP SEQUENCE even
--        though it uses none — a repo-wide grep for `CREATE TEMP`,
--        `CREATE TEMPORARY`, and `pg_temp` across `server/src` and
--        `db/migrations` turns up zero hits (F-089 verified this before
--        writing the REVOKE below; it is a pure surface-reduction, not a
--        functional change). This migration closes that unused surface:
--          1. REVOKE km_app's own TEMPORARY privilege (defensive — km_app was
--             never explicitly GRANTed TEMPORARY; it only ever had it via the
--             PUBLIC default, so this REVOKE is a no-op today but keeps the
--             role's OWN privilege row clean if a future GRANT is ever added
--             by mistake).
--          2. REVOKE PUBLIC's TEMPORARY default on this database, so no
--             FUTURE role (migration-added or manually created) silently
--             inherits temp-table creation either — the real fix.
--   Reverse: 062_revoke_km_app_temp.down.sql (re-GRANTs both — restores the
--            cluster's out-of-the-box default).
--   Depends on: 047_km_app_role (km_app must exist for step 1 to have
--               anything to act on; guarded below so this migration is safe
--               to apply even in an isolated test chain that skips 047).
--
-- WHY DYNAMIC SQL (`EXECUTE format(...)`): `REVOKE ... ON DATABASE <name>`
-- requires a literal database name in Postgres's grammar — `current_database()`
-- cannot appear as the object name itself. The actual name differs prod
-- (`korean_master`) vs. the db/tests testcontainer (assigns its own), so
-- hardcoding a name would break the very test harness this file's own
-- db/tests exercise. `format('...', current_database())` substitutes the
-- CURRENT session's database name at apply time — the same CURRENT_USER
-- anchor 047 uses for its FOR-ROLE-less ALTER DEFAULT PRIVILEGES, applied to
-- database name instead of role name, for the identical reason.
--
-- MARKER (F-088): declared non-destructive above. A privilege REVOKE is not
-- data loss (no row, table, or schema is removed) — the legacy pattern-sniff
-- would agree (no DROP TABLE/SCHEMA/DATABASE or TRUNCATE keyword appears
-- here), but this migration is also F-088's own first real-world user: the
-- declaration makes the classification explicit rather than inferred.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps this body in a single transaction together with the bookkeeping
-- write. GRANT/REVOKE are transactional in Postgres, so the whole migration
-- still commits-or-aborts atomically.
-- =============================================================================

-- 1. km_app's own privilege (defensive — see header; a no-op today).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'km_app') THEN
        EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM km_app', current_database());
    END IF;
END $$;

-- 2. PUBLIC's default — the real fix, and what protects every future role.
DO $$
BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- End of 062_revoke_km_app_temp.up.sql — runner owns the transaction (ADR-013).
