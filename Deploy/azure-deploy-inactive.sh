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
    # run_migrate selects the km-migrate:<tag> image by DEPLOY_TAG. Export the
    # release tag so the migration dry-run/apply use the image built for THIS
    # release (loaded by the pipeline's "Load images from tar" step).
    export DEPLOY_TAG="$deploy_tag"

    # --- Step 1: environment + shared infra ---------------------------------
    log_info "=== deploy-to-inactive START (tag=${deploy_tag}) ==="
    load_environment

    log_info "ensuring shared named volumes exist"
    bash "${DEPLOY_DIR}/ensure-shared-volume.sh"

    # Backups use a HOST bind mount (not a named volume) so the host backup/restore
    # scripts and the containers address the same files. Create the host dir before
    # compose mounts it; ${BACKUP_DIR} comes from the loaded .env (a stable host
    # path on the server, e.g. <KoreanMaster>/backups — NOT the in-container
    # /backups). A missing bind source would otherwise be auto-created as root.
    if [[ -n "${BACKUP_DIR:-}" ]]; then
        log_info "ensuring host backup dir exists: ${BACKUP_DIR}"
        mkdir -p "$BACKUP_DIR"
        chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
    fi

    # Seed the live nginx.conf BEFORE km-lb starts. km-lb bind-mounts this file
    # (docker-compose.shared.yml) from the STABLE host path LIVE_NGINX_CONF
    # (KM_LIVE_NGINX_CONF, set by the deploy to a persistent dir next to the .env).
    # The live config is per-host mutable state that update_nginx_config swaps on
    # each switch; on a cold box it doesn't exist yet, so seed it from the CURRENT
    # active color's routing template. A missing bind-mount source makes Docker
    # create the path as a DIRECTORY, so if a prior failed run left a directory
    # there, remove it first. If a real file already exists, leave it (the switch
    # owns it from here on).
    if [[ -d "$LIVE_NGINX_CONF" ]]; then
        log_warn "live nginx.conf path is a directory (stale from a prior failed mount); removing it"
        rmdir "$LIVE_NGINX_CONF" 2>/dev/null || rm -rf -- "$LIVE_NGINX_CONF"
    fi
    if [[ ! -f "$LIVE_NGINX_CONF" ]]; then
        log_info "seeding live nginx.conf at ${LIVE_NGINX_CONF} from nginx-${ACTIVE_ENVIRONMENT}-active.conf"
        mkdir -p "$(dirname "$LIVE_NGINX_CONF")"
        cp -- "${DEPLOY_DIR}/nginx-${ACTIVE_ENVIRONMENT}-active.conf" "$LIVE_NGINX_CONF"
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
    # migrate.py runs in the pre-built km-migrate container on km-internal
    # (run_migrate, deployment-utils.sh) — deps baked in, no host Python deps and
    # no runtime pip (km-internal is egress-blocked). --dry-run is a GLOBAL flag
    # and MUST precede the `up` subcommand. The dry-run IS the safety gate:
    # since the ADR-010 amendment (2026-07-10) migrate.py's --dry-run evaluates
    # the destructive gate itself, so a pending destructive/non-additive
    # migration fails HERE (DestructiveBlocked, nothing applied), because the
    # still-live ACTIVE color's code expects the old schema on this shared DB.
    # This script NEVER passes --allow-destructive: a deliberately-destructive
    # release is an out-of-band, operator-run procedure — see Deploy/README.md
    # §"Shipping Phase-2 Group 1" and Deploy/SECURITY.md §7.
    log_info "migration dry-run (expand/contract gate)"
    if ! run_migrate --dry-run up; then
        log_err "migration DRY-RUN failed. Aborting BEFORE any change (nothing was applied; no restore needed)."
        log_err "If this is a non-additive (destructive) migration it MUST NOT run via this script on the"
        log_err "shared blue/green DB: the still-live ACTIVE color's code expects the old schema. Rework the"
        log_err "migration to be expand/contract, or — for a deliberate destructive release — follow the"
        log_err "brief-downtime procedure in Deploy/README.md. Production is untouched."
        return 1
    fi

    log_info "applying migrations to the shared DB"
    if ! run_migrate up; then
        log_err "migration APPLY failed. Production (active=${ACTIVE_ENVIRONMENT}) is untouched."
        log_err "Each migration is atomic (body + bookkeeping in one tx), so the failed one left no partial"
        log_err "state; earlier migrations in this run stay applied. Investigate the logged SQL error;"
        log_err "restore from the pre-deploy backup only if the schema is actually in a bad state."
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

    # Upload body-cap smoke check: the LB once capped bodies at nginx's 1 MB
    # default and silently 413'd book uploads before they reached the server.
    # A >1 MB POST must traverse km-lb to the app (401 unauth = reached the
    # auth layer); a 413 means the client_max_body_size fix regressed.
    if ! verify_upload_body_limit "km-test" "$TEST_PORT"; then
        log_err "inactive color failed the upload body-size smoke check on the TEST port (${TEST_PORT})."
        log_err "production is untouched; do NOT switch."
        return 1
    fi

    # --- Step 8: re-confirm active is still unchanged -----------------------
    bash "${DEPLOY_DIR}/check-active-env.sh"

    log_info "=== deploy-to-inactive DONE — ${inactive} is staged and healthy on ${TEST_PORT}. READY TO SWITCH. ==="
}

main "$@"
