#!/usr/bin/env bash
# =============================================================================
# Korean Master — azure-deploy-inactive.sh <DEPLOY_TAG>
# -----------------------------------------------------------------------------
# Deploy a new build to the INACTIVE color and validate it on the TEST port —
# WITHOUT touching production. This is the first half of the blue/green release;
# azure-switch-production.sh does the flip.
#
# CRITICAL ARCHITECTURE NOTE — ONE SHARED DB.
# Both colors point at the same Postgres (km-db). There is NO per-color database
# and NO data copy/restore on deploy (unlike the .NET reference this adapts).
# Therefore migrations run ONCE, on the shared DB, and MUST be expand/contract
# (backward compatible): the still-live ACTIVE old code keeps reading/writing the
# shared DB while the migration applies and while the new (inactive) color comes
# up. A non-additive migration is a release-engineering error — we ABORT before
# applying it (the dry-run is the gate) rather than break production.
#
# Flow (each step logged, fail-fast; the active env is untouched on any failure):
#   1. load_environment; ensure shared volumes; bring the shared trio up.
#   2. confirm the recorded active color matches the live LB; pick INACTIVE.
#   3. back up the shared DB (pre-migration safety net).
#   4. migrate the shared DB: dry-run THEN apply (abort on either failure).
#   5. record the inactive color's image tag; bring the inactive trio up.
#   6. wait for the inactive color's three containers to be healthy.
#   7. verify the inactive color over the TEST port (1841).
#   8. re-confirm active is still unchanged; announce "ready to switch".
#
# Idempotent: re-running with the same tag re-applies already-applied migrations
# (no-ops), recreates the inactive trio, and re-validates.
#
# SECRETS: the Azure pipeline passes POSTGRES_PASSWORD / ANTHROPIC_API_KEY /
# TOTP_SECRET_ENC_KEY as masked secret vars and writes them into the server .env
# via save_env_var (which never logs values) before this script runs. This script
# never echoes a secret.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

readonly TEST_PORT=1841

usage() {
    log_err "usage: $(basename "$0") <DEPLOY_TAG>"
    log_err "  DEPLOY_TAG: the image tag to deploy to the inactive color (e.g. the CI build id)."
}

main() {
    local deploy_tag="${1:-}"
    if [[ -z "$deploy_tag" ]]; then
        usage
        return 2
    fi

    # --- Step 1: environment + shared infra ---------------------------------
    log_info "=== deploy-to-inactive START (tag=${deploy_tag}) ==="
    load_environment

    log_info "ensuring shared named volumes exist"
    bash "${DEPLOY_DIR}/ensure-shared-volume.sh"

    # Seed the live nginx.conf BEFORE km-lb starts. km-lb bind-mounts this file
    # (docker-compose.shared.yml) — if it's absent, Docker creates the path as a
    # DIRECTORY and the file mount fails ("mount a directory onto a file"). The
    # live config is per-host mutable state (gitignored) that update_nginx_config
    # swaps on each switch; on a cold box / fresh checkout it doesn't exist yet, so
    # seed it from the CURRENT active color's routing template. If it already
    # exists (mid-life host), leave it — the switch owns it from here on.
    if [[ ! -f "${DEPLOY_DIR}/nginx.conf" ]]; then
        log_info "seeding live nginx.conf from nginx-${ACTIVE_ENVIRONMENT}-active.conf"
        cp -- "${DEPLOY_DIR}/nginx-${ACTIVE_ENVIRONMENT}-active.conf" "${DEPLOY_DIR}/nginx.conf"
    fi

    log_info "bringing the shared trio up (km-lb / km-db / km-backup)"
    compose_shared up

    # The LB and DB must be reachable before we touch migrations. Wait for db.
    wait_healthy km-db

    # --- Step 2: confirm active, select inactive ----------------------------
    bash "${DEPLOY_DIR}/check-active-env.sh"
    local inactive
    inactive="$(get_inactive_environment)"
    log_info "deploy target (inactive color) = ${inactive}"

    # --- Step 3: pre-deploy backup of the SHARED DB -------------------------
    # Builder C owns db-backup.sh; we call it by path. A failed backup aborts
    # the deploy — we never migrate without a recovery point.
    log_info "backing up the shared DB before migrating"
    bash "${DEPLOY_DIR}/db-backup.sh"

    # --- Step 4: expand/contract migrations on the SHARED DB -----------------
    # Run from the repo root so db/migrate.py resolves and reads DATABASE_URL
    # from the (already-exported) environment. Dry-run is the safety gate: if it
    # reports a destructive/non-additive change, we ABORT — the active old code
    # is still live against this shared DB.
    local py
    if command -v python3 >/dev/null 2>&1; then
        py="$(command -v python3)"
    elif command -v python >/dev/null 2>&1; then
        py="$(command -v python)"
    else
        log_err "neither python3 nor python is on PATH; cannot run db/migrate.py"
        return 1
    fi

    log_info "migration dry-run (expand/contract gate)"
    if ! ( cd "$REPO_ROOT" && "$py" db/migrate.py up --dry-run ); then
        log_err "migration DRY-RUN failed. Aborting BEFORE any change."
        log_err "If this is a non-additive (destructive) migration it MUST NOT run on the shared blue/green DB:"
        log_err "the still-live ACTIVE color's code expects the old schema. Rework the migration to be"
        log_err "expand/contract (backward compatible). Production is untouched."
        return 1
    fi

    log_info "applying migrations to the shared DB"
    if ! ( cd "$REPO_ROOT" && "$py" db/migrate.py up ); then
        log_err "migration APPLY failed. Production (active=${ACTIVE_ENVIRONMENT}) is untouched."
        log_err "Investigate; restore from the pre-deploy backup if the schema is in a bad state."
        return 1
    fi
    log_info "migrations applied to the shared DB"

    # --- Step 5: record tag + bring the inactive trio up --------------------
    # Persist the per-color image tag so compose_color resolves the right image
    # and so the .env reflects what each color is running. ${inactive^^} -> BLUE/GREEN.
    save_env_var "${inactive^^}_IMAGE_TAG" "$deploy_tag"
    # S-SF4: export JUST the tag we just wrote into this shell — rather than
    # re-sourcing the whole secrets-bearing .env again (smaller secret-exposure
    # surface, no duplicate "environment loaded" log line, clearer intent).
    # compose_color also passes --env-file, so compose reads the value regardless;
    # this export covers any in-shell expansion.
    export "${inactive^^}_IMAGE_TAG"="$deploy_tag"

    log_info "bringing the inactive color trio up: km-${inactive}"
    compose_color "$inactive" up

    # --- Step 6: wait for the inactive color to be healthy ------------------
    wait_healthy "km-kiwi-${inactive}"
    wait_healthy "km-server-${inactive}"
    wait_healthy "km-client-${inactive}"

    # --- Step 7: validate the inactive color on the TEST port ---------------
    # The LB routes 1841 -> inactive color's server; /health proves the new build
    # is serving against the shared DB.
    if ! verify_local_app "km-test" "$TEST_PORT"; then
        log_err "inactive color failed health validation on the TEST port (${TEST_PORT})."
        log_err "production is untouched; do NOT switch. Inspect km-${inactive} logs."
        return 1
    fi

    # --- Step 8: re-confirm active is still unchanged -----------------------
    bash "${DEPLOY_DIR}/check-active-env.sh"

    log_info "=== deploy-to-inactive DONE — ${inactive} is staged and healthy on ${TEST_PORT}. READY TO SWITCH. ==="
}

main "$@"
