#!/usr/bin/env bash
# =============================================================================
# Korean Master — cloudflared-setup.sh
# -----------------------------------------------------------------------------
# Configure the NAMED, persistent Cloudflare Tunnel that fronts this box's LB
# (SENIOR_ENGINEER_BAR §6.9: named tunnel, not a Quick Tunnel; TLS terminates at
# the Cloudflare edge; only outbound cloudflared→Cloudflare is needed).
#
# Public hostname korean.jaredstudio.com → http://localhost:1840 (the km-lb prod
# port). The LB nginx sets X-Forwarded-Proto https so the app emits correct
# absolute URLs and keeps Secure cookies even though the tunnel→LB hop is plain
# HTTP on loopback.
#
# PREREQ: `cloudflared tunnel login` has been run (creates ~/.cloudflared/cert.pem
# authorizing the jaredstudio.com zone). This script needs NO sudo. Boot
# persistence via systemd is a separate, optional sudo step (printed at the end).
#
# Idempotent: re-running reuses an existing `korean-master` tunnel + rewrites the
# config + re-asserts the DNS route.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

readonly TUNNEL_NAME="korean-master"
readonly HOSTNAME_FQDN="korean.jaredstudio.com"
readonly LOCAL_SERVICE="http://localhost:1840"

main() {
    require_cmd cloudflared
    local cf_dir="${HOME}/.cloudflared"
    local config="${cf_dir}/config.yml"

    if [[ ! -f "${cf_dir}/cert.pem" ]]; then
        log_err "cloudflared is not logged in (no ${cf_dir}/cert.pem)."
        log_err "Run:  cloudflared tunnel login   (authorize the jaredstudio.com zone), then re-run this."
        return 1
    fi

    # Create the named tunnel if it does not already exist.
    if cloudflared tunnel list -o json | grep -q "\"name\":\"${TUNNEL_NAME}\""; then
        log_info "tunnel '${TUNNEL_NAME}' already exists — reusing"
    else
        log_info "creating named tunnel '${TUNNEL_NAME}'"
        cloudflared tunnel create "${TUNNEL_NAME}"
    fi

    # Resolve its UUID + credentials file (cloudflared writes ~/.cloudflared/<UUID>.json).
    local uuid
    uuid="$(cloudflared tunnel list -o json \
        | python3 -c 'import sys,json;print(next(t["id"] for t in json.load(sys.stdin) if t["name"]==sys.argv[1]))' "${TUNNEL_NAME}")"
    if [[ -z "$uuid" ]]; then
        log_err "could not resolve UUID for tunnel '${TUNNEL_NAME}'"
        return 1
    fi
    local creds="${cf_dir}/${uuid}.json"
    if [[ ! -f "$creds" ]]; then
        log_err "credentials file not found: ${creds}"
        return 1
    fi
    log_info "tunnel id ${uuid}"

    # Write the ingress config (0600 — it names the creds file path).
    log_info "writing ${config}"
    cat > "$config" <<EOF
tunnel: ${uuid}
credentials-file: ${creds}

# Route the one public hostname to the LB prod port; everything else 404s.
ingress:
  - hostname: ${HOSTNAME_FQDN}
    service: ${LOCAL_SERVICE}
  - service: http_status:404
EOF
    chmod 600 "$config"

    log_info "validating ingress config"
    cloudflared tunnel ingress validate

    # Create/point the DNS record (CNAME korean.jaredstudio.com -> <uuid>.cfargotunnel.com).
    log_info "routing DNS ${HOSTNAME_FQDN} -> ${TUNNEL_NAME}"
    if ! cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME_FQDN}"; then
        log_warn "route dns reported an issue (the record may already point here — verify in the Cloudflare dashboard)"
    fi

    log_info "=== cloudflared setup DONE ==="
    log_info "Start the tunnel now:        cloudflared tunnel run ${TUNNEL_NAME}"
    log_info "Persist across reboot (sudo): sudo cloudflared --config ${config} service install"
}

main "$@"
