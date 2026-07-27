#!/usr/bin/env bash
# =============================================================================
# Korean Master — load-krdict.sh
# -----------------------------------------------------------------------------
# Loads the KRDICT bulk dictionary (LMF XML, DTD_LMF_REV_16) into the SHARED
# km-db. Additive + idempotent (upsert by source_id/homograph; --resume picks up
# after a crash) — safe on a live DB; this is NOT a destructive restore.
#
# DATA arrives by USB, CODE ships in the km-loader image.
#   1. Download the bulk XML from krdict.korean.go.kr ("사전 전체 내려받기" ->
#      "XML 전체 내려받기"), unzip it (the 11 *.xml volumes), and copy the XML
#      directory to a USB dir:
#        cp -r krdict_xml/ /media/usb/krdict/
#   2. On the server:
#        export DEPLOY_TAG=<the deployed release tag>
#        bash Deploy/load-krdict.sh /media/usb/krdict
#
# Options (passed through to the loader):
#        --source-label LBL   provenance label (default KRDICT-bulk-<date-less>)
#        --dry-run            parse + validate only, no DB writes
#        --resume             resume after a crash (same label + sha256)
#   e.g. bash Deploy/load-krdict.sh /media/usb/krdict --source-label KRDICT-2026-05
#
# Prereqs: km-db up + migrated (003 krdict_* tables + 026 vocabulary_level); the
# km-loader:$DEPLOY_TAG image loaded. Reads the server .env for DB creds.
#
# License: KRDICT is CC BY-SA 2.0 KR — attribute 국립국어원 한국어기초사전. See
# tools/ingest/KRDICT_README.md.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

main() {
    local data_dir="${1:-}"
    if [[ -z "$data_dir" ]]; then
        log_err "usage: $(basename "$0") <dir-with-krdict-xml> [--source-label LBL] [--dry-run] [--resume]"
        return 2
    fi
    shift

    load_environment
    : "${DEPLOY_TAG:?export DEPLOY_TAG (the deployed release tag) before running}"

    # Provide a default provenance label unless the caller passed one. We do NOT
    # invent a timestamp here (no clock dependence in the script); override with
    # --source-label for a specific vintage, e.g. KRDICT-2026-05.
    local has_label=0
    local arg
    for arg in "$@"; do
        if [[ "$arg" == "--source-label" || "$arg" == --source-label=* ]]; then
            has_label=1
            break
        fi
    done

    log_info "load-krdict: loading KRDICT LMF from ${data_dir} into the shared DB"
    # WORKDIR /app/tools/ingest so `python -m load_krdict` resolves (it uses
    # top-level imports, run from the ingest dir — see KRDICT_README.md).
    if [[ "$has_label" -eq 1 ]]; then
        run_loader "$data_dir" /app/tools/ingest -- \
            python -m load_krdict --source /data "$@"
    else
        run_loader "$data_dir" /app/tools/ingest -- \
            python -m load_krdict --source /data --source-label "KRDICT-bulk" "$@"
    fi
    log_info "load-krdict: done"
}

main "$@"
