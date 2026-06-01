#!/usr/bin/env bash
# =============================================================================
# Korean Master — rebuild-environment.sh
# -----------------------------------------------------------------------------
# EMERGENCY recovery. Tears the whole stack down and brings it back to a known
# good state: the SHARED trio + the currently-recorded ACTIVE color + the matching
# nginx routing, then runs a health check.
#
#   *** THIS CAUSES A 1-2 MINUTE PRODUCTION INTERRUPTION ***
#   Both colors go down and come back. Unlike a normal deploy/switch (which is
#   zero-downtime), this is a full bounce. Use it only when the stack is wedged
#   (e.g. a half-flipped LB, a stuck container) and a graceful path won't recover.
#
# The SHARED DB volume (km_db_data) and image/backup volumes are PRESERVED — we
# never pass `-v` on `down`, so user data and uploaded images survive the bounce.
#
# Flow:
#   1. load_environment (need the recorded ACTIVE color).
#   2. compose down: both colors, then the shared trio (volumes preserved).
#   3. ensure shared volumes exist (defensive — they should already).
#   4. compose up: shared trio, then the active color trio.
#   5. wait for the active color to be healthy.
#   6. re-apply the active color's nginx routing and reload.
#   7. run bg-health.sh and propagate its verdict.
#
# Idempotent: safe to re-run; converges on the recorded-active steady state.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

main() {
    log_warn "=== EMERGENCY REBUILD — expect a 1-2 minute production interruption ==="
    load_environment

    local active="$ACTIVE_ENVIRONMENT"
    log_info "recorded active color = ${active}; will rebuild to this steady state"

    # --- Step 2: tear everything down (preserve volumes) --------------------
    # Bring both colors down regardless of which is active so a stuck inactive
    # color can't keep holding ports/networks. `|| true`: a color that is already
    # down must not abort the recovery.
    log_info "stopping both color trios"
    compose_color blue down || log_warn "blue down reported an issue (may already be down)"
    compose_color green down || log_warn "green down reported an issue (may already be down)"

    log_info "stopping the shared trio"
    compose_shared down || log_warn "shared down reported an issue (may already be down)"

    # --- Step 3: ensure volumes (defensive) ---------------------------------
    bash "${DEPLOY_DIR}/ensure-shared-volume.sh"

    # --- Step 4: bring shared + active back up ------------------------------
    log_info "starting the shared trio"
    compose_shared up
    wait_healthy km-db

    log_info "starting the active color trio: km-${active}"
    compose_color "$active" up

    # --- Step 5: wait for the active color ----------------------------------
    wait_healthy "km-kiwi-${active}"
    wait_healthy "km-server-${active}"
    wait_healthy "km-client-${active}"

    # --- Step 6: re-assert routing ------------------------------------------
    log_info "applying nginx routing for the active color (${active})"
    update_nginx_config "$active"

    # --- Step 7: health verdict ---------------------------------------------
    log_info "running post-rebuild health check"
    if bash "${DEPLOY_DIR}/bg-health.sh"; then
        log_info "=== REBUILD COMPLETE — stack healthy on active color ${active} ==="
        return 0
    fi
    log_err "=== REBUILD FINISHED but health check FAILED — investigate immediately ==="
    return 1
}

main "$@"
