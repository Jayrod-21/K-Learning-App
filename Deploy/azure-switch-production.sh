#!/usr/bin/env bash
# =============================================================================
# Korean Master — azure-switch-production.sh <DEPLOY_TAG>
# -----------------------------------------------------------------------------
# Promote the freshly-deployed INACTIVE color to production by flipping the nginx
# LB. This is a PURE NGINX FLIP — the shared DB is not touched and no data is
# copied. azure-deploy-inactive.sh must have already deployed + validated the
# inactive color on the TEST port.
#
# Flow:
#   1. load_environment; hard split-brain gate (check-active-env.sh); pick INACTIVE
#      (the deploy target / soon-to-be active).
#   2. re-verify the inactive color on the TEST port (1841) one last time.
#   3. flip nginx: prod (1840) -> inactive color.
#   4. verify prod (1840) is healthy on the NEW color.
#      On failure -> AUTO-ROLLBACK the flip (nginx back to the prior color) and
#      exit non-zero. ACTIVE_ENVIRONMENT was NOT yet advanced, so it still names
#      the prior color — nothing to restore. Safe because migrations were
#      expand/contract, so the prior (old) color still runs against the shared DB.
#   5. ONLY after prod is confirmed healthy on the new color: record it in .env.
#   6. print the new active color.
#
# DEPLOY_TAG is accepted for interface symmetry / audit logging; the tag was
# already persisted by the deploy step. We log it and confirm the inactive
# color's recorded tag matches (a guard against switching to a stale color).
#
# Idempotent: switching to the already-active color re-asserts the same routing.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

readonly PROD_PORT=1840
readonly TEST_PORT=1841

usage() {
    log_err "usage: $(basename "$0") <DEPLOY_TAG>"
    log_err "  DEPLOY_TAG: the tag deployed to the inactive color (must match what was staged)."
}

main() {
    local deploy_tag="${1:-}"
    if [[ -z "$deploy_tag" ]]; then
        usage
        return 2
    fi

    log_info "=== switch-to-production START (tag=${deploy_tag}) ==="
    load_environment

    # Hard split-brain gate (S-SF3): refuse to switch if the recorded
    # ACTIVE_ENVIRONMENT disagrees with what the live LB is actually serving. The
    # target color below is derived from .env, so a stale .env would otherwise flip
    # to the WRONG color silently. check-active-env.sh exits non-zero on mismatch.
    if ! bash "${DEPLOY_DIR}/check-active-env.sh" >/dev/null 2>&1; then
        log_err "split-brain: .env ACTIVE_ENVIRONMENT disagrees with the live LB upstream."
        log_err "resolve with check-active-env.sh / rebuild-environment.sh before switching."
        return 1
    fi

    # The color we are switching FROM (current prod) and TO (the staged inactive).
    local prior="$ACTIVE_ENVIRONMENT"
    local inactive
    inactive="$(get_inactive_environment)"
    log_info "current active=${prior}; switching to=${inactive}"

    # Guard: the staged color's recorded tag must match the tag we were asked to
    # promote. Prevents switching to a color that holds a different/stale build.
    local staged_tag_var="${inactive^^}_IMAGE_TAG"
    local staged_tag="${!staged_tag_var:-}"
    if [[ "$staged_tag" != "$deploy_tag" ]]; then
        log_err "refusing to switch: ${inactive} has image tag '${staged_tag:-<unset>}' but you asked to promote '${deploy_tag}'."
        log_err "run azure-deploy-inactive.sh '${deploy_tag}' first so the staged color matches."
        return 1
    fi

    # --- Step 2: last-chance validation of the inactive color ----------------
    if ! verify_local_app "km-test" "$TEST_PORT"; then
        log_err "inactive color (${inactive}) failed pre-switch validation on ${TEST_PORT}. Not switching."
        return 1
    fi

    # --- Step 3: flip nginx --------------------------------------------------
    nginx_switch "$inactive"

    # --- Step 4: verify prod on the new color, auto-rollback on failure ------
    # NOTE (S-SF1): ACTIVE_ENVIRONMENT is persisted ONLY after the post-switch prod
    # health check passes, so a crash in the verify window never leaves .env claiming
    # a color that prod isn't actually healthy on. On failure we roll the routing
    # back and leave .env pointing at the (still-correct) prior color — no write.
    if ! verify_local_app "km-prod" "$PROD_PORT"; then
        log_err "POST-SWITCH prod health FAILED on ${inactive}. Auto-rolling back the flip to ${prior}."
        # Roll the routing back. Every recovery step is individually guarded so an
        # inner failure under `set -e` can't abort the rollback partway (S-SF2).
        # ACTIVE_ENVIRONMENT was never advanced, so it already names ${prior} — no
        # restore write is needed; the routing is what we repair here.
        if ! nginx_switch "$prior"; then
            log_err "CRITICAL: rollback flip to ${prior} ALSO failed. The LB may be mid-flip — run rebuild-environment.sh." || true
        fi
        # Best-effort confirm prod is healthy again on the prior color.
        if verify_local_app "km-prod" "$PROD_PORT"; then
            log_warn "rolled back to ${prior}; prod is healthy again. The deploy did NOT take effect." || true
        else
            log_err "rolled back to ${prior} but prod is STILL unhealthy on ${PROD_PORT}. Manual intervention required." || true
        fi
        return 1
    fi

    # --- Step 5: prod is healthy on the new color — NOW record it -------------
    save_env_var ACTIVE_ENVIRONMENT "$inactive"

    log_info "=== switch-to-production DONE — new active color is ${inactive} (prod healthy on ${PROD_PORT}). ==="
    # Machine-readable result on stdout: the new active color.
    printf '%s\n' "$inactive"
}

main "$@"
