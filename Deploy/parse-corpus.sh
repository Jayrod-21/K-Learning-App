#!/usr/bin/env bash
# =============================================================================
# Korean Master — parse-corpus.sh
# -----------------------------------------------------------------------------
# STAGE 1 of the corpus ingest: turn the raw TTMIK PDFs into the structured JSON
# the loaders consume (tools/ingest/output/*.json). STAGE 2 is Deploy/load-
# corpora.sh (km-loader → km-db).
#
# Only the TTMIK lesson + Iyagi PDFs are parsed here — those are the sources with
# a real text layer (parse_*.py shells out to `pdftotext -layout`, no OCR). Per
# tools/ingest/README.md the Darakwon grammar/vocab, TOPIK papers, and KRDICT are
# BLOCKED (image-only/bad-OCR PDFs, or a missing XML source) and are not attempted
# here — they are follow-ups requiring OCR / source acquisition.
#
# Runs the parsers in a pinned python:3.12 container (project's requires-python)
# with poppler-utils + the parser deps, the raw corpus mounted READ-ONLY and
# tools/ingest/ mounted read-write so output/ lands in the (gitignored) repo path
# the loaders + the discriminator-coverage test expect.
#
# Usage:  Deploy/parse-corpus.sh [CORPUS_DIR]
#   CORPUS_DIR defaults to ~/data/korean-master/corpus (the local gitignored copy).
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

readonly PY_IMAGE="python:3.12"
readonly DEFAULT_CORPUS="/home/jared-williams/data/korean-master/corpus"

main() {
    require_cmd docker
    local corpus="${1:-$DEFAULT_CORPUS}"
    if [[ ! -d "$corpus" ]]; then
        log_err "parse-corpus: corpus dir not found: ${corpus}"
        return 1
    fi

    # Fail fast if the six text-layer PDFs aren't where we expect (clear remedy
    # beats an opaque pdftotext error six layers deep).
    local lessons="${corpus}/TTMIK/Lessons/Lesson Scripts"
    local iyagi="${corpus}/TTMIK/이야기들/이야기 Scripts"
    local p missing=()
    for p in \
        "${lessons}/TTMIK Level 1 - 3.pdf" \
        "${lessons}/TTMIK Level 4 - 6.pdf" \
        "${lessons}/TTMIK Level 7 - 9.pdf" \
        "${iyagi}/TTMIK Talking 1 - 50.pdf" \
        "${iyagi}/TTMIK Talking 51 - 100.pdf" \
        "${iyagi}/TTMIK Talking 101 - 146.pdf"; do
        [[ -f "$p" ]] || missing+=("$p")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_err "parse-corpus: missing expected PDFs:"
        for p in "${missing[@]}"; do log_err "  - ${p}"; done
        return 1
    fi

    log_info "parsing TTMIK lessons + Iyagi from ${corpus} → tools/ingest/output/"
    # -w /ingest so the parser scripts resolve; output/ is written into the mounted
    # repo tools/ingest/. Corpus is read-only. UTF-8 locale so the Korean paths +
    # pdftotext output round-trip cleanly.
    docker run --rm \
        -e LC_ALL=C.UTF-8 -e LANG=C.UTF-8 \
        -v "${REPO_ROOT}/tools/ingest":/ingest \
        -v "${corpus}":/corpus:ro \
        -w /ingest "$PY_IMAGE" \
        bash -ec '
            apt-get update -qq && apt-get install -y -qq --no-install-recommends poppler-utils >/dev/null
            pip install --quiet --no-cache-dir structlog pydantic
            mkdir -p output
            echo "== TTMIK lessons =="
            python parse_ttmik.py "/corpus/TTMIK/Lessons/Lesson Scripts/TTMIK Level 1 - 3.pdf" output/ttmik_1_3.json --slug ttmik-1-3 --series-title "TTMIK Levels 1-3"
            python parse_ttmik.py "/corpus/TTMIK/Lessons/Lesson Scripts/TTMIK Level 4 - 6.pdf" output/ttmik_4_6.json --slug ttmik-4-6 --series-title "TTMIK Levels 4-6"
            python parse_ttmik.py "/corpus/TTMIK/Lessons/Lesson Scripts/TTMIK Level 7 - 9.pdf" output/ttmik_7_9.json --slug ttmik-7-9 --series-title "TTMIK Levels 7-9"
            echo "== TTMIK Iyagi =="
            python parse_iyagi.py "/corpus/TTMIK/이야기들/이야기 Scripts/TTMIK Talking 1 - 50.pdf"   output/iyagi_1_50.json    --slug ttmik-iyagi-1-50   --series-title "TTMIK 이야기 #1-50"
            python parse_iyagi.py "/corpus/TTMIK/이야기들/이야기 Scripts/TTMIK Talking 51 - 100.pdf" output/iyagi_51_100.json  --slug ttmik-iyagi-51-100 --series-title "TTMIK 이야기 #51-100"  --episode-offset 50
            python parse_iyagi.py "/corpus/TTMIK/이야기들/이야기 Scripts/TTMIK Talking 101 - 146.pdf" output/iyagi_101_146.json --slug ttmik-iyagi-101-146 --series-title "TTMIK 이야기 #101-146" --episode-offset 100
        '

    log_info "parse-corpus DONE — output JSON:"
    ls -la "${REPO_ROOT}/tools/ingest/output/"*.json >&2 2>/dev/null || true
    log_info "Next: Deploy/load-corpora.sh \"${REPO_ROOT}/tools/ingest/output\" --corpus all"
}

main "$@"
