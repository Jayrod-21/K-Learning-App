#!/usr/bin/env bash
# =============================================================================
# Korean Master — local-build.sh [TAG]
# -----------------------------------------------------------------------------
# Build the five deploy images on THIS host. This is the local-host analog of
# the Azure pipeline's BuildAndTest stage: on a self-hosted single box (no CI
# agent, no image registry, no tar artifacts) we build the images directly into
# the local Docker image store, from which the blue/green compose files and the
# run_migrate / run_loader helpers resolve them by name:tag.
#
# Images built (exact build contexts per each Dockerfile's header):
#   km-server   -f server/Dockerfile            (context: server/)
#   km-client   -f client/Dockerfile.prod       (context: repo root — needs
#                                                 client/ AND Deploy/client-nginx.conf)
#   km-kiwi     -f services/kiwi/Dockerfile     (context: services/kiwi/)
#   km-migrate  -f Deploy/migrate.Dockerfile    (context: Deploy/)
#   km-loader   -f Deploy/loader.Dockerfile     (context: repo root — bakes tools/)
#
# TAG: image tag to build (default: `local`, matching the *_IMAGE_TAG defaults
# in Deploy/.env). For a real release, pass an immutable tag (e.g. the git short
# SHA): `Deploy/local-build.sh "$(git rev-parse --short HEAD)"`, then deploy it
# to the inactive color with azure-deploy-inactive.sh <TAG>.
#
# This script does NOT touch the running stack, the DB, or the .env — it only
# produces images. Bringing them up is local-standup.sh (first boot) or the
# azure-deploy-inactive.sh → azure-switch-production.sh flow (steady state).
# =============================================================================
set -Eeuo pipefail
# Reuse the house loggers / require_cmd / REPO_ROOT. Sourcing does NOT read the
# .env (no secrets loaded here) — load_environment is never called.
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

main() {
    local tag="${1:-local}"
    require_cmd docker

    log_info "=== local-build START (tag=${tag}) — building 5 images ==="
    # All builds run from the repository root so repo-root-relative contexts
    # (km-client, km-loader) and subdir contexts resolve consistently.
    cd "$REPO_ROOT"

    log_info "[1/5] km-server:${tag}  (context: server/)"
    docker build -f server/Dockerfile -t "km-server:${tag}" server

    log_info "[2/5] km-client:${tag}  (context: repo root, Dockerfile.prod)"
    docker build -f client/Dockerfile.prod -t "km-client:${tag}" .

    log_info "[3/5] km-kiwi:${tag}  (context: services/kiwi/)"
    docker build -f services/kiwi/Dockerfile -t "km-kiwi:${tag}" services/kiwi

    log_info "[4/5] km-migrate:${tag}  (context: Deploy/)"
    docker build -f Deploy/migrate.Dockerfile -t "km-migrate:${tag}" Deploy

    log_info "[5/5] km-loader:${tag}  (context: repo root)"
    docker build -f Deploy/loader.Dockerfile -t "km-loader:${tag}" .

    log_info "=== local-build DONE (tag=${tag}) ==="
    # Show what we produced so the operator can eyeball sizes / confirm the tag.
    docker image ls \
        --filter "reference=km-server:${tag}" \
        --filter "reference=km-client:${tag}" \
        --filter "reference=km-kiwi:${tag}" \
        --filter "reference=km-migrate:${tag}" \
        --filter "reference=km-loader:${tag}" \
        --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}' >&2
}

main "$@"
