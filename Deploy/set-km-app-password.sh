#!/usr/bin/env bash
# =============================================================================
# Korean Master — set-km-app-password.sh  (B-030, migration 047)
# -----------------------------------------------------------------------------
# ONE-TIME (and rotation) step that gives the least-privilege `km_app`
# application role its password. Migration 047 creates the role WITHOUT a
# password — a committed migration must never carry a secret, and migrate.py
# executes migration bodies verbatim (no psql-style variable interpolation), so
# the password cannot be injected there. Until this script runs, km_app cannot
# authenticate at all (pg_hba is scram-sha-256; a NULL verifier always fails),
# which means a deploy that forgets this step fails the IDLE color's health
# check — loudly, before any traffic flip.
#
# SECURITY (mirrors seed-admin.sh, SENIOR_ENGINEER_BAR §3.6): the password is
# read from the gitignored Deploy/.env (KM_APP_PASSWORD — the same value the
# compose files embed in the app's DATABASE_URL, so DB and app can never
# disagree) and is passed to psql over STDIN into a container-local env var —
# it never appears in argv on the host or in the container, in `ps`, in shell
# history, or in any log. psql's \getenv + :'pw' quoting make it safe for any
# password value (use `openssl rand -hex 32`; hex is also URL-safe for the
# DATABASE_URL embedding).
#
# Usage (after Deploy/.env has a real KM_APP_PASSWORD and migration 047 has
# been applied by the deploy runner):
#     bash Deploy/set-km-app-password.sh
# Re-running is safe (ALTER ROLE ... PASSWORD is idempotent) — rotation is
# exactly: edit KM_APP_PASSWORD in Deploy/.env, re-run this, restart the app
# containers so they pick up the new DATABASE_URL.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

main() {
    require_cmd docker
    load_environment

    if [[ -z "${KM_APP_PASSWORD:-}" || "$KM_APP_PASSWORD" == "CHANGE-ME" ]]; then
        log_err "set-km-app-password: KM_APP_PASSWORD is unset or still the placeholder in ${ENV_FILE}."
        log_err "Generate one (openssl rand -hex 32), set it in the .env, and re-run. See .env.example."
        return 1
    fi

    if ! docker inspect -f '{{.State.Running}}' km-db >/dev/null 2>&1; then
        log_err "set-km-app-password: km-db is not running — stand the shared trio up first."
        return 1
    fi

    # The role is created by migration 047 — fail with a pointer, not a raw
    # psql error, if the deploy hasn't applied it yet.
    local role_exists
    role_exists="$(docker exec km-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname = 'km_app'")"
    if [[ "$role_exists" != "1" ]]; then
        log_err "set-km-app-password: role km_app does not exist — apply migration 047 first (deploy, or run_migrate up)."
        return 1
    fi

    log_info "setting km_app password inside km-db (secret travels via stdin only — never argv, never logged)"
    # stdin line 1 = the secret, read into a container-local env var; the rest
    # of stdin = the psql script (psql -f -). \getenv (psql >= 15; km-db is
    # postgres:16) moves the env var into a psql variable, and :'pw' applies
    # proper literal quoting whatever the password contains.
    {
        printf '%s\n' "$KM_APP_PASSWORD"
        printf '%s\n' '\getenv pw KM_APP_PW'
        printf '%s\n' "ALTER ROLE km_app PASSWORD :'pw';"
    } | docker exec -i km-db sh -ec '
        IFS= read -r KM_APP_PW
        export KM_APP_PW
        exec psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -
    '

    # Verify end-to-end: authenticate AS km_app (password auth over the
    # container's host socket — same auth path the app uses) and confirm the
    # session is NOT superuser. Same stdin discipline for the secret.
    log_info "verifying km_app can authenticate and is not a superuser"
    local verify
    verify="$(printf '%s\n' "$KM_APP_PASSWORD" | docker exec -i km-db sh -ec '
        IFS= read -r PGPASSWORD
        export PGPASSWORD
        exec psql -h 127.0.0.1 -U km_app -d "$POSTGRES_DB" -tAc \
            "SELECT current_user || chr(58) || (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)"
    ')"
    if [[ "$verify" != "km_app:f" ]]; then
        log_err "set-km-app-password: verification failed (got '${verify}', expected 'km_app:f')."
        return 1
    fi

    log_info "km_app password set and verified. If app containers are running, restart them to pick up the new DATABASE_URL."
}

main "$@"
