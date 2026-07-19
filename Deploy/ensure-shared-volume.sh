#!/usr/bin/env bash
# =============================================================================
# ensure-shared-volume.sh — idempotently create the shared docker objects that
# the three compose projects (km-shared / km-blue / km-green) all reference.
# -----------------------------------------------------------------------------
# WHY this exists: blue/green declare km-internal, km-edge, and km_images as
# `external: true` (see docker-compose.{blue,green}.yml). `external: true` means
# "attach to a pre-existing object; do NOT create it" — so on a cold box, OR if a
# color is brought up before km-shared, compose would error "network/volume not
# found". This script is the single, idempotent creator: run it before any
# `compose_color … up` (Builder B's deployment-utils.sh calls it). km-shared also
# declares these inline, so once it is up the objects exist either way; running
# this first makes the ordering robust and lets a color stand up alone.
#
# Idempotent: `inspect || create` — already-present objects are left untouched, so
# re-running never disturbs live data (named volumes survive a color switch).
#
# Networks created with the SAME flags km-shared declares (km-internal is
# --internal so it has no egress) so a network this script creates is
# indistinguishable from one km-shared would have made.
# =============================================================================
set -Eeuo pipefail

# Fail loud with the offending line so a half-create is never silent.
trap 'echo "[ensure-shared-volume] ERROR on line ${LINENO}" >&2' ERR

log() { printf '[ensure-shared-volume] %s\n' "$*"; }

# --- Named volumes -----------------------------------------------------------
# km_db_data       → km-db pgdata (shared DB; the switch never copies it)
# km_images        → user-uploaded OCR images, mounted by BOTH colors' servers
# km_book_uploads  → user-uploaded book PDFs (U1a), mounted by BOTH colors' servers
# km_audio_uploads → uploaded audio blobs (Track A); read-only on km-worker,
#                    read-write on both colors' servers once A-3 lands
# (backups use a host BIND mount, not a named volume — see azure-deploy-inactive.sh)
ensure_volume() {
    local volume="$1"
    if docker volume inspect "${volume}" >/dev/null 2>&1; then
        log "volume ${volume} already exists — leaving untouched"
    else
        log "creating volume ${volume}"
        docker volume create \
            --label app=korean-master \
            "${volume}" >/dev/null
    fi
}

# --- Networks ----------------------------------------------------------------
# km-internal: bridge + --internal (no egress) — km-db, km-server-*, km-kiwi-*.
# km-edge:     bridge — km-lb ↔ client/server; server egress to the Claude API.
# The `--internal` flag MUST match shared.yml's `internal: true`, else a color
# attaching expecting no-egress would silently get egress.
ensure_network() {
    local network="$1"
    shift
    local extra_args=("$@")
    if docker network inspect "${network}" >/dev/null 2>&1; then
        log "network ${network} already exists — leaving untouched"
    else
        log "creating network ${network}"
        docker network create \
            --driver bridge \
            --label app=korean-master \
            "${extra_args[@]}" \
            "${network}" >/dev/null
    fi
}

main() {
    log "ensuring shared docker volumes + networks"

    ensure_volume km_db_data
    ensure_volume km_images
    ensure_volume km_book_uploads
    ensure_volume km_audio_uploads
    # NOTE: backups are NOT a named volume — they are a host BIND mount
    # (${BACKUP_DIR}) so the host scripts and the containers share one location.
    # The deploy creates that host dir (it needs the loaded .env); see
    # azure-deploy-inactive.sh.

    # km-internal is --internal (matches shared.yml internal: true).
    ensure_network km-internal --internal
    ensure_network km-edge

    log "done"
}

main "$@"
