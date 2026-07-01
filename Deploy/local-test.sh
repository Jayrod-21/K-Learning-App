#!/usr/bin/env bash
# =============================================================================
# Korean Master — local-test.sh
# -----------------------------------------------------------------------------
# The authoritative TEST GATE for this self-hosted (no-CI-service) box. It is the
# local analog of GitHub Actions `.github/workflows/ci.yml` + the Azure pipeline's
# BuildAndTest test half: run it and it must pass BEFORE building images and
# standing the stack up (test -> build -> smoke -> stand up -> validate -> switch).
#
# Every suite runs in a PINNED container matching CI's toolchain, so the result is
# reproducible and independent of whatever happens to be installed on the host:
#   * JS suites  -> node:20-slim   (glibc, same major as CI's setup-node 20)
#   * Py suites  -> python:3.12     (project's requires-python; host is 3.14)
# node_modules is an anonymous volume per run (never the host tree) so deps install
# fresh against the lockfile, exactly like CI. The suites mount the source tree
# read-write and write gitignored build artifacts (dist/, *.egg-info) back into the
# checkout — so this gate is REPRODUCIBLE (fresh deps every run) but not fully
# hermetic; the writes are all to gitignored paths and never committed.
#
# HARD gates (a failure fails the whole run, exit 1):
#   1. client : npm ci -> lint -> tsc --noEmit -> build      (ci.yml client-checks)
#   2. server : npm ci -> lint -> typecheck -> test          (ci.yml server-checks)
#   3. db     : pytest db/tests  (testcontainers spins its own postgres:16-alpine)
#   4. kiwi   : pytest --no-slow (fake Kiwi; no 100MB model download)
#   5. secret scan : the ci.yml security-scan grep (fail if a key is in source)
#
# SOFT gates (reported, non-blocking — mirrors CI's `|| true` on these):
#   6. ingest ruff lint
#   7. npm audit (client + server)
#   8. pip-audit (ingest loader deps + kiwi) — SCA, mirrors ci.yml's pip-audit steps
#
# NOTE on ingest pytest: ci.yml's ingest job runs ONLY ruff + pip-audit (no
# pytest). The tools/ingest/tests suites are DB-loader tests that run during the
# corpus ingest phase against the real km-db — that is where they belong, not a
# skip. This gate matches CI for ingest and adds db + kiwi on top.
#
# Usage:  Deploy/local-test.sh [--fast]
#   --fast   skip the db + kiwi Python suites (JS + secret scan only) for a quick
#            inner-loop check. The full run (no flag) is the gate before a deploy.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

readonly NODE_IMAGE="node:20-slim"
readonly PY_IMAGE="python:3.12"

# Results accumulate here; printed as a table at the end.
declare -a RESULTS=()
HARD_FAIL=0

record() {  # record <severity HARD|SOFT> <name> <status PASS|FAIL> [note]
    local sev="$1" name="$2" status="$3" note="${4:-}"
    RESULTS+=("${status}|${sev}|${name}|${note}")
    if [[ "$status" == "FAIL" && "$sev" == "HARD" ]]; then
        HARD_FAIL=1
    fi
}

# Run a HARD suite: on failure, record + keep going (so we see ALL failures, not
# just the first) but the ERR trap must not abort — hence `if ! ...`.
hard() {  # hard <name> <cmd...>
    local name="$1"; shift
    log_info "── HARD: ${name} ──"
    if "$@"; then
        log_info "✔ ${name} passed"
        record HARD "$name" PASS
    else
        log_err "✘ ${name} FAILED"
        record HARD "$name" FAIL
    fi
}

soft() {  # soft <name> <cmd...>
    local name="$1"; shift
    log_info "── soft: ${name} ──"
    if "$@"; then
        record SOFT "$name" PASS
    else
        log_warn "soft gate ${name} reported issues (non-blocking)"
        record SOFT "$name" FAIL
    fi
}

# --- Suite implementations ---------------------------------------------------

client_suite() {
    # Mount client/ read-write, with anonymous volumes over BOTH node_modules and
    # dist/ so `npm ci` and `npm run build` write into throwaway volumes, not the
    # host tree — keeps the checkout clean between runs.
    docker run --rm \
        -v "${REPO_ROOT}/client":/app -v /app/node_modules -v /app/dist \
        -w /app "$NODE_IMAGE" \
        sh -ec 'npm ci && npm run lint && npx tsc --noEmit && npm run build'
}

server_suite() {
    # The server tests are testcontainers INTEGRATION tests (vitest.config.ts has
    # 120s "testcontainers warm-up" timeouts; tests/helpers/app.ts boots a Postgres
    # container and injects DATABASE_URL / TOTP_SECRET_ENC_KEY). They therefore
    # need the Docker socket to spawn sibling containers, and --network host so the
    # in-container test process reaches those containers' host-mapped ports via
    # localhost (clean on Linux — same as db_suite). This is how CI's ubuntu runner
    # provides them (docker present), not a shortcut.
    # Mount the WHOLE repo at /repo and run from /repo/server: the tests apply the
    # REAL migrations to their testcontainer Postgres (tests/helpers/pg.ts reads
    # ../../../db/migrations relative to server/tests/helpers). A shallow mount of
    # just server/ makes that resolve to /db/migrations (ENOENT). Mounting at
    # checkout depth reproduces the real layout — CI checks out the whole repo.
    # Anonymous volume over server/node_modules keeps the container's install off
    # the host tree.
    # NOTE on the Docker socket: SENIOR_ENGINEER_BAR §6.3 forbids mounting the
    # socket into an *application* container. These are throwaway TEST containers on
    # the operator's own box whose whole job is to spawn testcontainers siblings —
    # the trust boundary is "you already run this repo's tests." It is deliberately
    # NOT the app runtime (the km-* app/service containers never get the socket; the
    # km-backup design avoids it too).
    docker run --rm \
        --network host \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "${REPO_ROOT}":/repo -v /repo/server/node_modules \
        -w /repo/server "$NODE_IMAGE" \
        sh -ec 'npm ci && npm run lint && npm run typecheck && npm test'
}

db_suite() {
    # testcontainers needs the Docker socket to spawn postgres:16-alpine; --network
    # host lets the in-container pytest reach that sibling's host-mapped port via
    # localhost (clean on Linux). Repo mounted read-only; deps installed fresh.
    docker run --rm \
        --network host \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "${REPO_ROOT}":/repo:ro \
        -w /repo "$PY_IMAGE" \
        sh -ec '
            pip install --quiet --no-cache-dir \
                "psycopg[binary]==3.2.3" "structlog==24.4.0" \
                "testcontainers[postgres]>=4,<5" "pytest>=8,<10" &&
            python -m pytest db/tests \
                --ignore=db/tests/test_discriminator_coverage.py \
                -p no:cacheprovider -q'
    # NOTE: test_discriminator_coverage.py is a DATA-coverage test — it asserts the
    # DB enums cover every source type found in tools/ingest/output/*.json (gitignored,
    # generated by the parsers). It is a POST-INGEST integrity check, run in the ingest
    # phase against the real km-db, not a pre-build migration gate. The migration
    # up/down tests here ARE the gate.
}

kiwi_suite() {
    # Fake-Kiwi path (--no-slow) — installs the service + dev extras, no model.
    # Mount the WHOLE repo at /repo and run from services/kiwi within it: the tests
    # resolve paths via Path(__file__).resolve().parents[4] (test_lemmatizer.py),
    # which assumes a real checkout's directory depth. A shallow mount of just
    # services/kiwi makes parents[4] not exist -> IndexError at collection. Mounting
    # at checkout depth reproduces the real layout the tests are written for.
    docker run --rm \
        -v "${REPO_ROOT}":/repo \
        -w /repo/services/kiwi "$PY_IMAGE" \
        sh -ec 'pip install --quiet --no-cache-dir -e ".[dev]" && python -m pytest --no-slow -q'
}

secret_scan() {
    # ci.yml security-scan "Check for committed secrets" (HARD). Scan REPO_ROOT via a
    # path arg (no `cd` — avoids leaking cwd into the rest of main; N3). Exclude
    # node_modules/.git/dist so a host `npm ci` tree can't false-positive or slow the
    # scan (CI runs on a fresh checkout with no node_modules — this keeps parity).
    local excl=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist)
    ! grep -rn "${excl[@]}" "ANTHROPIC_API_KEY\s*=\s*sk-" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.py" "$REPO_ROOT" \
        || { log_err "API key literal found in source!"; return 1; }
    ! grep -rn "${excl[@]}" "SUPABASE_SERVICE_KEY\s*=\s*eyJ" --include="*.ts" --include="*.js" --include="*.tsx" "$REPO_ROOT" \
        || { log_err "Supabase key literal found in source!"; return 1; }
    return 0
}

ingest_ruff() {
    docker run --rm -v "${REPO_ROOT}/tools/ingest":/app:ro -w /app "$PY_IMAGE" \
        sh -ec 'pip install --quiet ruff && ruff check .'
}

npm_audit() {
    docker run --rm -v "${REPO_ROOT}/client":/c:ro -v "${REPO_ROOT}/server":/s:ro "$NODE_IMAGE" \
        sh -ec 'cd /c && npm audit --audit-level=high; cd /s && npm audit --audit-level=high'
}

pip_audit() {
    # SCA of the two Python surfaces we ship, mirroring ci.yml's pip-audit steps
    # (ingest-checks + security-scan). Non-blocking (soft), like CI's `|| true`.
    #   * tools/ingest has no manifest of its own — audit the loader deps that
    #     Deploy/loader.Dockerfile bakes (keep this pin set in lockstep with it).
    #   * services/kiwi declares deps in pyproject.toml — audit its resolved deps.
    docker run --rm -v "${REPO_ROOT}/services/kiwi":/kiwi:ro "$PY_IMAGE" \
        sh -ec '
            pip install --quiet --no-cache-dir pip-audit &&
            echo "== pip-audit: tools/ingest loader deps ==" &&
            pip install --quiet --no-cache-dir \
                "psycopg[binary]==3.2.3" "psycopg-pool>=3.2,<4" "structlog==24.4.0" \
                "pydantic>=2,<3" "defusedxml>=0.7,<0.8" &&
            echo "== pip-audit: services/kiwi ==" &&
            pip install --quiet --no-cache-dir -e /kiwi &&
            pip-audit --strict --progress-spinner=off'
}

# --- Orchestration -----------------------------------------------------------

main() {
    local fast=0
    case "${1:-}" in
        "")      ;;
        --fast)  fast=1 ;;
        *)       log_err "unknown argument: '${1}'. Usage: $(basename "$0") [--fast]"; return 2 ;;
    esac
    require_cmd docker

    log_info "=== local-test START (gate: ${NODE_IMAGE} + ${PY_IMAGE}) ==="

    hard "client (lint/tsc/build)" client_suite
    hard "server (lint/typecheck/test)" server_suite
    hard "secret-scan" secret_scan
    if [[ "$fast" -eq 0 ]]; then
        hard "db (migration tests)" db_suite
        hard "kiwi (api/lemmatizer)" kiwi_suite
    else
        log_warn "--fast: skipping db + kiwi Python suites (NOT a full gate)"
    fi

    soft "ingest ruff" ingest_ruff
    soft "npm audit (high)" npm_audit
    soft "pip-audit (ingest+kiwi)" pip_audit

    # --- Summary -------------------------------------------------------------
    log_info "=== local-test SUMMARY ==="
    printf '\n  %-6s %-5s %s\n' "STATUS" "SEV" "SUITE" >&2
    printf '  %-6s %-5s %s\n' "------" "----" "-----" >&2
    local row status sev name note
    for row in "${RESULTS[@]}"; do
        IFS='|' read -r status sev name note <<<"$row"
        printf '  %-6s %-5s %s%s\n' "$status" "$sev" "$name" "${note:+  ($note)}" >&2
    done
    printf '\n' >&2

    if [[ "$HARD_FAIL" -ne 0 ]]; then
        log_err "TEST GATE FAILED — hard suite(s) red. Do NOT build/deploy until green."
        return 1
    fi
    log_info "=== TEST GATE PASSED — safe to build → smoke → stand up ==="
}

main "$@"
