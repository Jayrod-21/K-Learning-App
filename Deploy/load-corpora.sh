#!/usr/bin/env bash
# =============================================================================
# Korean Master — load-corpora.sh
# -----------------------------------------------------------------------------
# Loads the 9 bundled corpora (TTMIK, Iyagi, TOPIK, KGIU grammar x3, 2000 Words
# x2, Hanja) into the SHARED km-db. Additive + idempotent: re-running is a no-op
# for unchanged data (the loaders resume + skip on sha256 match), so it is safe
# to run on a live DB without touching the login/2FA account (this is NOT a
# destructive restore — contrast db-restore.sh).
#
# DATA arrives by USB, CODE ships in the km-loader image.
#   1. On a machine with the repo, copy the corpus JSON to a USB dir:
#        cp tools/ingest/output/*.json /media/usb/corpora/
#   2. On the server, plug in the USB (say it mounts at /media/usb/corpora) and:
#        export DEPLOY_TAG=<the deployed release tag>     # e.g. the Build.BuildId
#        bash Deploy/load-corpora.sh /media/usb/corpora
#
# Any extra flags are passed through to the loader, e.g.:
#        bash Deploy/load-corpora.sh /media/usb/corpora --dry-run
#        bash Deploy/load-corpora.sh /media/usb/corpora --corpus ttmik
#
# Prereqs: km-db up + migrated (the corpus tables exist); the km-loader:$DEPLOY_TAG
# image loaded (the pipeline does this in DeployToInactive). Reads the server
# .env for the DB creds. No secret is ever echoed.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

main() {
    local data_dir="${1:-}"
    if [[ -z "$data_dir" ]]; then
        log_err "usage: $(basename "$0") <data-dir-with-corpus-json> [extra loader flags]"
        log_err "  <data-dir> holds the corpus JSON (contents of tools/ingest/output/*.json)."
        return 2
    fi
    shift

    load_environment
    : "${DEPLOY_TAG:?export DEPLOY_TAG (the deployed release tag) before running}"

    log_info "load-corpora: loading all corpora from ${data_dir} into the shared DB"
    # WORKDIR /app so `python -m tools.ingest.load_to_postgres` resolves the
    # package; --input-dir /data points the discovery globs at the bind mount.
    # Default is --corpus all; callers can override via passthrough flags.
    if [[ "$*" == *"--corpus"* ]]; then
        run_loader "$data_dir" /app -- \
            python -m tools.ingest.load_to_postgres --input-dir /data "$@"
    else
        run_loader "$data_dir" /app -- \
            python -m tools.ingest.load_to_postgres --input-dir /data --corpus all "$@"
    fi
    log_info "load-corpora: done"
}

main "$@"
