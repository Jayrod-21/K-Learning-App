#!/usr/bin/env bash
# =============================================================================
# Korean Master — bg-health.sh
# -----------------------------------------------------------------------------
# Blue/green health summary. Probes every reachable LB/colour endpoint and prints
# a PASS/FAIL line per target:
#   * prod   (1840, /health)  -> active color's server, via the LB
#   * test   (1841, /health)  -> inactive color's server, via the LB
#   * LB     (1840, /healthz) -> the LB's OWN liveness (never proxied)
#   * blue   (1842, /health)  -> blue server direct  (only if bound/running)
#   * green  (1843, /health)  -> green server direct (only if bound/running)
#
# Exit 1 if prod OR test fails (those are the release-critical paths). Direct
# color ports are informational: they are loopback-only debug endpoints and a
# color that isn't running simply isn't probed.
#
# Read-only; no secrets touched.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

readonly PROD_PORT=1840
readonly TEST_PORT=1841
readonly BLUE_PORT=1842
readonly GREEN_PORT=1843

# Probe once (not the full retry loop): a health *summary* wants a current
# snapshot, not a wait. Returns 0 on HTTP 200.
_probe_once() {
    local port="$1" path="$2"
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:${port}${path}" 2>/dev/null || true)"
    [[ "$code" == "200" ]]
}

# Is something listening on this loopback port? Used to decide whether to probe
# the optional direct color ports (1842/1843) without producing noisy failures.
_port_open() {
    local port="$1"
    # Probe /health, not /healthz (N-2): the direct color ports map to the SERVER
    # (km-server-<color>:4000), whose liveness path is /health — the server does
    # not serve the LB's /healthz. We only care "is anything answering" here, so
    # ANY non-000 HTTP response (even a 404) counts as open; the real 200 check is
    # _probe_once below. A 000 with a transport error means nothing is listening.
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:${port}/health" 2>/dev/null || true)"
    [[ -n "$code" && "$code" != "000" ]]
}

main() {
    require_cmd curl

    local rc=0

    # --- LB liveness (its own endpoint) -------------------------------------
    if _probe_once "$PROD_PORT" "/healthz"; then
        log_info "PASS  LB liveness        :${PROD_PORT}/healthz"
    else
        log_warn "FAIL  LB liveness        :${PROD_PORT}/healthz"
        # LB liveness feeds the verdict only via prod below; flag but don't
        # double-count. A down LB will also fail prod/test.
    fi

    # --- Prod (release-critical) --------------------------------------------
    if _probe_once "$PROD_PORT" "/health"; then
        log_info "PASS  prod (active)      :${PROD_PORT}/health"
    else
        log_err  "FAIL  prod (active)      :${PROD_PORT}/health"
        rc=1
    fi

    # --- Test (release-critical) --------------------------------------------
    if _probe_once "$TEST_PORT" "/health"; then
        log_info "PASS  test (inactive)    :${TEST_PORT}/health"
    else
        log_err  "FAIL  test (inactive)    :${TEST_PORT}/health"
        rc=1
    fi

    # --- Direct color ports (informational) ---------------------------------
    local p
    for p in "blue:${BLUE_PORT}" "green:${GREEN_PORT}"; do
        local color="${p%%:*}" port="${p##*:}"
        if _port_open "$port"; then
            if _probe_once "$port" "/health"; then
                log_info "PASS  ${color}-direct      :${port}/health"
            else
                log_warn "FAIL  ${color}-direct      :${port}/health (running but unhealthy)"
            fi
        else
            log_info "SKIP  ${color}-direct      :${port} (not running / not bound)"
        fi
    done

    if [[ "$rc" -eq 0 ]]; then
        log_info "bg-health: prod + test PASS"
    else
        log_err "bg-health: one or more release-critical targets FAILED"
    fi
    return "$rc"
}

main "$@"
