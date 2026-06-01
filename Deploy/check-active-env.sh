#!/usr/bin/env bash
# =============================================================================
# Korean Master — check-active-env.sh
# -----------------------------------------------------------------------------
# Verifies that the recorded active color (.env ACTIVE_ENVIRONMENT) agrees with
# what the live km-lb is actually routing prod (1840) to. A divergence means the
# state machine and reality have drifted — refuse to proceed (exit 1) so a deploy
# never builds on a false premise.
#
#   check-active-env.sh              -> validate, log, exit 0 (match) / 1 (drift)
#   check-active-env.sh --get-active -> print just the active color to stdout
#
# Safe to run repeatedly. Reads no secrets; logs none.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

main() {
    local get_active=0
    case "${1:-}" in
        --get-active) get_active=1 ;;
        "") : ;;
        *)
            log_err "usage: $(basename "$0") [--get-active]"
            return 2
            ;;
    esac

    load_environment

    local declared="$ACTIVE_ENVIRONMENT"

    if [[ "$get_active" -eq 1 ]]; then
        # Machine-readable: only the color on stdout (logs go to stderr).
        printf '%s\n' "$declared"
        return 0
    fi

    # Determine what the LB is actually serving. Empty = LB not reachable/parsable.
    local live
    live="$(_nginx_active_color_from_lb)"

    if [[ -z "$live" ]]; then
        # We can't confirm from the LB. Treat as a hard problem during a deploy:
        # the caller needs to know the LB state is unknown rather than assume.
        log_err "could not determine the live active color from km-lb (container down or config unparsable)."
        log_err "declared active (.env) = ${declared}; live = <unknown>"
        return 1
    fi

    if [[ "$live" != "$declared" ]]; then
        log_err "ACTIVE ENV MISMATCH: .env says '${declared}' but km-lb routes prod (1840) to '${live}'."
        log_err "resolve before deploying: re-run the switch, or correct ACTIVE_ENVIRONMENT, then re-check."
        return 1
    fi

    log_info "active env confirmed: ${declared} (.env and live km-lb agree)"
    return 0
}

main "$@"
