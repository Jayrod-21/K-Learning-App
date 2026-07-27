#!/usr/bin/env bash
# =============================================================================
# Korean Master — cleanup.sh
# -----------------------------------------------------------------------------
# Reclaim disk after a deploy: prune dangling images, images older than 168h
# (7 days), and stopped containers. Run by the pipeline after deploy/switch.
#
# PRESERVES (never removed):
#   * named volumes km_db_data / km_images / km_book_uploads / km_backups (data —
#     DB, uploaded OCR images, uploaded book PDFs, backups). We NEVER prune
#     volumes here.
#   * the image currently used by the running active color's containers (so a
#     `docker compose up` after cleanup can still recreate them, and so an
#     emergency rollback to the active color is always possible).
#
# Idempotent and safe to run repeatedly. Best-effort: a prune that finds nothing
# is success.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

# Images created within this window are kept regardless of dangling status.
readonly MAX_IMAGE_AGE_HOURS=168

main() {
    require_cmd docker
    load_environment

    local active
    active="$(get_active_environment)"
    log_info "cleanup: preserving the active color (${active}) images + named volumes"

    # --- Collect the in-use image IDs we must NOT remove --------------------
    # The active color's three containers, plus the shared trio. We resolve their
    # backing image IDs so a prune by tag/age can't strip an image a running
    # container depends on.
    local keep_ids=()
    local c
    for c in "km-server-${active}" "km-client-${active}" "km-kiwi-${active}" km-lb km-db km-backup; do
        local id
        id="$(docker inspect --format '{{.Image}}' "$c" 2>/dev/null || true)"
        if [[ -n "$id" ]]; then
            keep_ids+=("$id")
        fi
    done
    log_info "cleanup: ${#keep_ids[@]} in-use image(s) protected"

    # --- 1. Stopped containers ----------------------------------------------
    # `container prune` only removes containers in the "exited"/"created" state;
    # running containers (both colors, shared trio) are untouched.
    log_info "pruning stopped containers"
    docker container prune --force >/dev/null 2>&1 || log_warn "container prune reported an issue (continuing)"

    # --- 2. Dangling images --------------------------------------------------
    # Dangling = untagged layers left by rebuilds. None of these are in-use by a
    # running container, but we still skip any whose ID we protected, defensively.
    log_info "pruning dangling images"
    docker image prune --force >/dev/null 2>&1 || log_warn "dangling image prune reported an issue (continuing)"

    # --- 3. Images older than the age window, except protected ---------------
    # Enumerate images with a creation timestamp; remove those older than the
    # cutoff and not in the keep set. We remove by ID and never with --force so a
    # still-referenced image (e.g. the inactive color, kept for fast rollback if
    # within the window) is left alone by docker's own ref-count guard.
    local cutoff_epoch
    cutoff_epoch="$(date -u -d "${MAX_IMAGE_AGE_HOURS} hours ago" +%s 2>/dev/null || true)"
    if [[ -z "$cutoff_epoch" ]]; then
        log_warn "could not compute the age cutoff; skipping age-based image prune"
    else
        # Format: "<id> <RFC3339 created>" per image.
        local line removed=0
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            local id created_iso created_epoch
            id="${line%% *}"
            created_iso="${line#* }"
            created_epoch="$(date -u -d "$created_iso" +%s 2>/dev/null || true)"
            [[ -z "$created_epoch" ]] && continue
            (( created_epoch >= cutoff_epoch )) && continue  # too new, keep

            # Skip protected (in-use) image IDs. docker prefixes IDs with sha256:.
            # Guard the loop on a non-empty array so `set -u` is satisfied without
            # the "${arr[@]:-}" form (which shellcheck flags as SC2128).
            local protected=0 keep
            if [[ ${#keep_ids[@]} -gt 0 ]]; then
                for keep in "${keep_ids[@]}"; do
                    if [[ "$keep" == "$id" || "$keep" == "sha256:${id}" || "sha256:${keep}" == "$id" ]]; then
                        protected=1; break
                    fi
                done
            fi
            (( protected )) && continue

            # No --force: docker refuses to delete an image a container still
            # references, which is exactly the safety we want.
            if docker image rm "$id" >/dev/null 2>&1; then
                removed=$((removed + 1))
            fi
        done < <(docker image ls --all --no-trunc --format '{{.ID}} {{.CreatedAt}}' 2>/dev/null || true)
        log_info "age-based image prune removed ${removed} image(s) older than ${MAX_IMAGE_AGE_HOURS}h"
    fi

    log_info "cleanup: done (named volumes and the active color's image preserved)"
}

main "$@"
