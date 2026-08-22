#!/usr/bin/env bash
# =============================================================================
# Korean Master — local-standup.sh
# -----------------------------------------------------------------------------
# FIRST-TIME cold bring-up of the stack on a fresh host (the M box). This is the
# scripted form of the README "First-time server setup" sequence, for the case
# where NO color is serving yet — so azure-deploy-inactive.sh (which deploys the
# *inactive* color while the *active* one keeps serving) does not yet apply.
#
# It brings the SHARED trio + the recorded ACTIVE color up, initializes the
# schema on the empty shared DB, routes the LB, and verifies prod on :1840.
#
# Run ONCE, after Deploy/local-build.sh has produced the images. Steady-state
# releases afterward use the normal zero-downtime flow:
#     Deploy/local-build.sh <tag>
#     Deploy/azure-deploy-inactive.sh <tag>     # stage + validate inactive on :1841
#     Deploy/azure-switch-production.sh <tag>    # flip prod -> new color
#
# Idempotent: re-running converges on the same active steady state (migrations
# already applied are no-ops; compose up recreates only what changed). If the
# stack is merely wedged, prefer rebuild-environment.sh (it also bounces the DB).
#
# USAGE:
#     Deploy/local-standup.sh [--allow-destructive]
#
# --allow-destructive: pass migrate.py's destructive flag through to the
# schema-init step. REQUIRED on any fresh (empty) database: the migration
# chain contains 045 (hygiene_cleanup, deliberate DROP TABLE of superseded
# ad-hoc bak tables), so a plain `up` — and, since the ADR-010 amendment, the
# dry-run too — aborts with DestructiveBlocked at 045. On an EMPTY database
# the flag is safe by construction (there is no data to lose; 045's DROPs are
# `IF EXISTS` no-ops there). On a database that already carries data, read
# the pending migrations' headers before passing it.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

readonly PROD_PORT=1840

main() {
    # Optional migrate.py passthrough (see USAGE in the header). Kept as an
    # array so the empty case expands to nothing under `set -u`.
    local migrate_flags=()
    if [[ "${1:-}" == "--allow-destructive" ]]; then
        migrate_flags+=(--allow-destructive)
        shift
        log_warn "destructive migrations PERMITTED for this stand-up (--allow-destructive)"
    fi
    if [[ $# -gt 0 ]]; then
        log_err "local-standup: unknown argument(s): $*"
        log_err "usage: $(basename "$0") [--allow-destructive]"
        return 2
    fi

    log_info "=== local-standup START (first-time cold bring-up) ==="
    load_environment

    local active="$ACTIVE_ENVIRONMENT"
    local tag_var="${active^^}_IMAGE_TAG"
    local tag="${!tag_var:-}"
    if [[ -z "$tag" ]]; then
        log_err "local-standup: ${tag_var} is empty in the .env; cannot resolve the image tag."
        return 1
    fi
    log_info "active color=${active}, image tag=${tag}"

    # --- Preflight: the images must already exist (built by local-build.sh) ---
    # run_migrate resolves km-migrate:${DEPLOY_TAG}; the color trio resolves
    # km-{server,client,kiwi}:${tag}. Fail fast with a clear remedy rather than
    # letting compose error on a missing image mid-bring-up.
    local img missing=()
    for img in "km-server:${tag}" "km-client:${tag}" "km-kiwi:${tag}" "km-migrate:${tag}" "km-loader:${tag}"; do
        docker image inspect "$img" >/dev/null 2>&1 || missing+=("$img")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_err "local-standup: missing images: ${missing[*]}"
        log_err "build them first:  Deploy/local-build.sh ${tag}"
        return 1
    fi
    # run_migrate reads DEPLOY_TAG to pick km-migrate:<tag>.
    export DEPLOY_TAG="$tag"

    # --- Shared volumes + host backup dir -----------------------------------
    log_info "ensuring shared named volumes exist"
    bash "${DEPLOY_DIR}/ensure-shared-volume.sh"
    if [[ -n "${BACKUP_DIR:-}" ]]; then
        log_info "ensuring host backup dir exists: ${BACKUP_DIR}"
        mkdir -p "$BACKUP_DIR"
        chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
    fi

    # --- Seed the live nginx.conf BEFORE km-lb starts -----------------------
    # km-lb bind-mounts LIVE_NGINX_CONF (a single file). On a cold box it does
    # not exist yet; seed it from the active color's routing template. A stale
    # DIRECTORY at that path (from a prior failed mount) would make Docker mount a
    # dir — remove it first. (Same handling as azure-deploy-inactive.sh.)
    if [[ -d "$LIVE_NGINX_CONF" ]]; then
        log_warn "live nginx.conf path is a directory (stale mount); removing it"
        rmdir "$LIVE_NGINX_CONF" 2>/dev/null || rm -rf -- "$LIVE_NGINX_CONF"
    fi
    if [[ ! -f "$LIVE_NGINX_CONF" ]]; then
        log_info "seeding live nginx.conf from nginx-${active}-active.conf"
        mkdir -p "$(dirname "$LIVE_NGINX_CONF")"
        cp -- "${DEPLOY_DIR}/nginx-${active}-active.conf" "$LIVE_NGINX_CONF"
    fi

    # --- Seed the active-color file BEFORE the color trio starts -------------
    # Phase 1.3 story-runner gating: km-server-{blue,green} both bind-mount
    # ACTIVE_COLOR_FILE read-only. On a cold box it does not exist yet — same
    # stale-directory hazard as LIVE_NGINX_CONF above, same fix (remove, then
    # let write_active_color_file recreate it as a plain file).
    if [[ -d "$ACTIVE_COLOR_FILE" ]]; then
        log_warn "active-color path is a directory (stale mount); removing it"
        rmdir "$ACTIVE_COLOR_FILE" 2>/dev/null || rm -rf -- "$ACTIVE_COLOR_FILE"
    fi
    if [[ ! -f "$ACTIVE_COLOR_FILE" ]]; then
        write_active_color_file "$active"
    fi

    # --- Ensure the services_default network (B1) ---------------------------
    # docker-compose.shared.yml declares services_default as an EXTERNAL network that
    # km-lb attaches to for Cloudflare-tunnel ingress. On the production host the
    # cloudflared/"services" compose project owns + creates it, so ensure-shared-
    # volume.sh deliberately does NOT create it. On THIS box (M) we own the tunnel and
    # nothing has created it yet — and `compose_shared up` hard-fails with
    # "network services_default declared as external, but could not be found" if it is
    # absent. Create it as a plain bridge if missing (idempotent). When the cloudflared
    # container is configured (Cloudflare step) it attaches to this same network; a
    # host-mode cloudflared just leaves it as a harmless bridge km-lb also sits on.
    if docker network inspect services_default >/dev/null 2>&1; then
        log_info "network services_default already exists"
    else
        log_info "creating external network services_default (this box owns the tunnel)"
        docker network create services_default >/dev/null
    fi

    # --- Shared trio up; wait for the DB ------------------------------------
    log_info "bringing the shared trio up (km-lb / km-db / km-backup)"
    compose_shared up
    wait_healthy km-db

    # --- Initialize the schema on the empty shared DB -----------------------
    # First boot: the DB is empty. Dry-run gates (should be a clean forward
    # migration on an empty DB), then apply. Same runner the deploy uses.
    # NB: a fresh chain traverses 045 (deliberately destructive), so a cold
    # stand-up needs the --allow-destructive passthrough — see the header.
    log_info "migration dry-run"
    if ! run_migrate "${migrate_flags[@]}" --dry-run up; then
        log_err "migration DRY-RUN failed on the empty DB. Aborting before any change."
        log_err "If the error is DestructiveBlocked: the chain contains migration 045"
        log_err "(deliberate DROP TABLE — safe on an empty DB). Re-run:"
        log_err "    $(basename "$0") --allow-destructive"
        return 1
    fi
    log_info "applying migrations to the shared DB"
    if ! run_migrate "${migrate_flags[@]}" up; then
        log_err "migration APPLY failed. Inspect km-db; the stack is not yet serving."
        return 1
    fi
    log_info "schema initialized"

    # --- Bring the active color up + wait healthy ---------------------------
    log_info "bringing the active color trio up: km-${active}"
    compose_color "$active" up
    wait_healthy "km-kiwi-${active}"
    wait_healthy "km-server-${active}"
    wait_healthy "km-client-${active}"

    # --- Route the LB at the active color, verify prod ----------------------
    log_info "routing prod (1840) -> ${active}"
    update_nginx_config "$active"

    if ! verify_local_app "km-prod" "$PROD_PORT"; then
        log_err "prod (${PROD_PORT}) never became healthy on ${active}. Inspect km-server-${active} logs."
        return 1
    fi

    log_info "=== local-standup DONE — prod healthy on :${PROD_PORT} (active=${active}). ==="
    log_info "Next: provision the admin user + enroll MFA, then start the Cloudflare Tunnel to :${PROD_PORT}."
}

main "$@"
