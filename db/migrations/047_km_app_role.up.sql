-- =============================================================================
-- Migration 047 — km_app least-privilege application role (B-030)
--   UP — creates the NON-superuser `km_app` LOGIN role the Express app connects
--        as: DML only (SELECT / INSERT / UPDATE / DELETE on app tables +
--        USAGE/SELECT on sequences). Grants it on everything that already
--        exists in schema `public`, and installs DEFAULT PRIVILEGES so tables
--        and sequences created by FUTURE migrations auto-grant to it. The
--        migration RUNNER keeps connecting as the superuser (POSTGRES_USER,
--        `korean_master` in prod) — see Deploy/deployment-utils.sh run_migrate.
--   Reverse: 047_km_app_role.down.sql
--   Depends on: nothing structural — the grants are schema-generic.
--               (`schema_migrations` MAY be ABSENT when this runs: migrate.py's
--               ensure_bookkeeping creates it before any migration body, but
--               this file is also applied by RAW-SQL appliers that never create
--               it — the server integration-test harness
--               (server/tests/helpers/pg.ts applyMigrations) and the manual
--               `psql -f` path db/migrations/README.md documents. The
--               schema_migrations REVOKE below is therefore guarded on the
--               table's existence.)
--
-- WHY (db/SECURITY.md §T9, BUGS_AND_FEATURES.md B-030 / F-022 C1): the app has
-- connected as `korean_master`, which the official postgres image grants
-- SUPERUSER. Any SQL-execution flaw in app code could therefore escalate to
-- `DROP TABLE` or `COPY ... FROM PROGRAM` (RCE-class). After this migration the
-- app principal can read/write rows and nothing else: no DDL, no TRUNCATE, no
-- REFERENCES/TRIGGER, no role/DB administration, no server-side program
-- execution. Compose wiring: Deploy/docker-compose.{blue,green}.yml point the
-- app's DATABASE_URL at ${KM_APP_USER}/${KM_APP_PASSWORD} (Deploy/.env).
--
-- PASSWORD HANDLING (deliberate — read before "fixing" this):
--   This file creates the role WITHOUT a password, so the role CANNOT
--   authenticate (pg_hba is scram-sha-256 for host connections; a role with a
--   NULL password verifier always fails password auth). The password is set
--   OUT-OF-BAND, once, by `Deploy/set-km-app-password.sh`, which reads
--   KM_APP_PASSWORD from the gitignored Deploy/.env and pipes it to psql over
--   stdin (never argv, never logged, never committed). Two reasons it cannot
--   live here:
--     1. A committed migration must never carry a secret (CI secret-scan,
--        repo history is forever).
--     2. migrate.py executes migration bodies VERBATIM via psycopg
--        `cur.execute(sql)` — there is no psql-style :'variable' or env
--        interpolation, by design (ADR-010: auditable minimal runner).
--   Rotation reuses the same script (ALTER ROLE ... PASSWORD is idempotent).
--
-- ROLES ARE CLUSTER-WIDE, BOOKKEEPING IS PER-DATABASE: `schema_migrations`
-- lives in one database, but `km_app` lives in the cluster. A rebuilt/restored
-- database can therefore re-run this migration while the role already exists
-- (exactly the situation db/tests exercises by recreating schema `public` per
-- test). The CREATE is guarded; the attribute ALTER and the GRANTs are
-- naturally idempotent, so re-application converges instead of erroring.
--
-- DEFAULT PRIVILEGES — WHY NO `FOR ROLE korean_master`: the ALTER DEFAULT
-- PRIVILEGES statements below deliberately omit FOR ROLE, which attaches the
-- default-privilege entries to CURRENT_USER — i.e. to whatever role runs the
-- migrations. In prod that IS `korean_master` (run_migrate connects as
-- POSTGRES_USER), so the effect is identical to naming it; but hardcoding the
-- name would break any environment whose migration role is named differently
-- (the db/tests testcontainer superuser is `test`, and `ALTER DEFAULT
-- PRIVILEGES FOR ROLE <missing>` errors). Since every future table/sequence is
-- created by the same role that runs this file, CURRENT_USER is exactly the
-- right anchor. CONSEQUENCE: if the migration-runner role is ever renamed,
-- re-issue these two statements as that role (or write a follow-up migration).
--
-- WHAT IS DELIBERATELY NOT GRANTED (the point of the ticket):
--   * TRUNCATE, REFERENCES, TRIGGER on tables (DML-adjacent but DDL-scented;
--     the app uses none of them).
--   * UPDATE on sequences (setval — loaders/migrations only).
--   * CREATE on schema public (PG15+ already revoked it from PUBLIC; the app
--     must never mint tables).
--   * Any role attribute: SUPERUSER / CREATEDB / CREATEROLE / REPLICATION /
--     BYPASSRLS are all explicitly off, and NOINHERIT keeps any future role
--     membership from leaking privileges implicitly.
--   * Write access to `schema_migrations` (revoked below after the blanket
--     grant): the app must not be able to rewrite migration history. SELECT
--     is kept — harmless and useful for a future "schema version" health field.
--
-- ROLLOUT ORDER (normative copy: Deploy/README.md §"Shipping Phase-2 Group 1";
-- enforcement is the idle-color health gate): 1) add KM_APP_USER/
-- KM_APP_PASSWORD to Deploy/.env, 2) this migration is applied — for the
-- Group-1 release that is the operator's one-time
-- `run_migrate --allow-destructive up` (the scripted deploy cannot apply this
-- chain: 045 trips the destructive gate), 3) run Deploy/set-km-app-password.sh,
-- 4) the new color comes up with the km_app DATABASE_URL and must pass health
-- checks BEFORE the LB flips (feedback_korean_master_bluegreen_protocol) — a
-- missed step fails loudly on the not-yet-live color, never on live traffic.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps this body in a single transaction with the bookkeeping write.
-- (CREATE/ALTER ROLE and GRANT are transactional in Postgres, so the whole
-- migration still commits-or-aborts atomically.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The role. CREATE is guarded (roles are cluster-wide — see header); the
--    ALTER then enforces the least-privilege attribute set even when the role
--    pre-existed with drifted attributes. ALTER ROLE without PASSWORD never
--    touches an existing password, so re-applying this migration is safe after
--    set-km-app-password.sh has run.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'km_app') THEN
        CREATE ROLE km_app;
    END IF;
END $$;

ALTER ROLE km_app
    LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOINHERIT
    NOREPLICATION
    NOBYPASSRLS;

-- NB: this literal must not contain the destructive-scanner keywords
-- (migrate.py's contains_destructive strips comments but NOT string literals,
-- so a documentary "TRUNCATE" here would force --allow-destructive on every
-- plain `run_migrate up`). Hence "table truncation" spelled out.
COMMENT ON ROLE km_app IS
    'Least-privilege application role (B-030, migration 047). The Express '
    'server''s DATABASE_URL principal: DML + sequence USAGE on schema public '
    'only — no DDL, no table truncation, no superuser. Password is set '
    'out-of-band by Deploy/set-km-app-password.sh (never in a committed file). '
    'Migrations keep running as the POSTGRES_USER superuser.';

-- -----------------------------------------------------------------------------
-- 2. Grants on EVERYTHING THAT EXISTS TODAY in schema public.
--    USAGE on the schema is explicit (PUBLIC still has it by default on
--    `public` in PG16, but this survives a future hardening REVOKE ... FROM
--    PUBLIC without stranding the app).
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO km_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO km_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO km_app;

-- Carve-out: migration history is read-only to the app (see header). GUARDED:
-- under migrate.py the bookkeeping table always exists (ensure_bookkeeping runs
-- first), but raw-SQL appliers — server/tests/helpers/pg.ts and the manual
-- `psql -f` path — apply this file on databases that have no schema_migrations
-- at all, and an unguarded REVOKE errors on a missing table (42P01). Skipping
-- when absent loses nothing: the blanket GRANT above is the only source of a
-- km_app write privilege on it, so a database without the table has nothing to
-- revoke, and every runner-managed database (all real deployments) takes the
-- REVOKE. db/tests/test_km_app_role.py asserts both paths.
DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE ON TABLE schema_migrations FROM km_app;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Default privileges for the FUTURE (critical — Phase 2 adds many tables):
--    every table/sequence subsequently created in schema public BY THE
--    MIGRATION-RUNNER ROLE (CURRENT_USER here — see header for why FOR ROLE is
--    omitted) auto-grants the same DML surface to km_app, so no future
--    migration has to remember per-table grants and the app can never 500 on a
--    freshly-migrated table for lack of a GRANT.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO km_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO km_app;

-- End of 047_km_app_role.up.sql — runner owns the transaction (ADR-013).
