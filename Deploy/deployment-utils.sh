#!/usr/bin/env bash
# =============================================================================
# Korean Master — deployment-utils.sh
# -----------------------------------------------------------------------------
# Shared library for the blue/green deploy state machine. This file is the
# NORMATIVE interface: the function names below are called by name from the
# orchestration scripts (azure-deploy-inactive.sh, azure-switch-production.sh,
# check-active-env.sh, bg-health.sh, cleanup.sh, rebuild-environment.sh) and by
# the Azure pipeline. Do not rename a function without updating every caller.
#
# Architecture (locked, see PASS_DEPLOY_CONTRACT.md):
#   * Blue/green on ONE host. ONE SHARED Postgres (km-db) that BOTH colors point
#     to. A "switch" is therefore a pure nginx flip — no data is copied.
#   * Compose projects are SEPARATE and share volumes + networks:
#       km-shared : km-lb, km-db, km-backup        (docker-compose.shared.yml)
#       km-blue   : km-server-blue,  km-client-blue,  km-kiwi-blue
#       km-green  : km-server-green, km-client-green, km-kiwi-green
#   * Ports: prod 1840 / test 1841 / blue-direct 1842 / green-direct 1843.
#
# SECURITY: this library sources the server .env which holds real secrets
# (POSTGRES_PASSWORD, ANTHROPIC_API_KEY, TOTP_SECRET_ENC_KEY, DATABASE_URL).
# It NEVER echoes a secret value. save_env_var logs only the KEY, never VALUE.
# The loggers write to stderr and emit no variable expansions of secrets.
#
# This file is meant to be SOURCED, not executed. It guards against direct
# execution at the bottom. When sourced it sets `set -Eeuo pipefail` and an ERR
# trap for the caller (every orchestration script wants the same posture); a
# caller that has already set these simply re-affirms them.
# =============================================================================

# --- Strict mode (applies to the sourcing shell) -----------------------------
set -Eeuo pipefail

# Resolve the directory THIS library lives in so callers can be invoked from any
# cwd and still find sibling files (compose files, nginx confs, the live
# nginx.conf, the .env). Works whether sourced or executed.
# shellcheck disable=SC2128  # BASH_SOURCE[0] is intentional (the lib's own path)
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)"
export DEPLOY_DIR

# Repository root = the parent of Deploy/. The migrate CLI and `python` are run
# from here (db/migrate.py reads DATABASE_URL from the process environment).
REPO_ROOT="$(cd -- "${DEPLOY_DIR}/.." >/dev/null 2>&1 && pwd -P)"
export REPO_ROOT

# --- Configurable, non-secret locations --------------------------------------
# The server-side persistent .env (runtime source of truth; gitignored, 0600).
# Overridable for tests via KM_ENV_FILE, defaults to Deploy/.env.
ENV_FILE="${KM_ENV_FILE:-${DEPLOY_DIR}/.env}"
# The live nginx.conf the km-lb container bind-mounts. update_nginx_config swaps
# one of the nginx-${color}-active.conf templates into this path.
LIVE_NGINX_CONF="${KM_LIVE_NGINX_CONF:-${DEPLOY_DIR}/nginx.conf}"

# Compose file paths (per the locked layout).
COMPOSE_SHARED_FILE="${DEPLOY_DIR}/docker-compose.shared.yml"
SHARED_PROJECT="km-shared"

# How long verify_local_app polls: ATTEMPTS tries, SLEEP seconds apart.
VERIFY_ATTEMPTS="${KM_VERIFY_ATTEMPTS:-10}"
VERIFY_SLEEP="${KM_VERIFY_SLEEP:-5}"
# How long wait_healthy waits for a container's healthcheck to report healthy.
HEALTHY_ATTEMPTS="${KM_HEALTHY_ATTEMPTS:-60}"
HEALTHY_SLEEP="${KM_HEALTHY_SLEEP:-5}"

# =============================================================================
# Logging — structured, to STDERR, NEVER secrets.
# -----------------------------------------------------------------------------
# Format: "<ISO8601> <LEVEL> [deploy] <message>". stdout is reserved for machine
# output (e.g. --get-active prints just the color) so logs go to stderr.
# Callers MUST NOT pass a secret value as a log argument.
# =============================================================================
_log() {
    local level="$1"; shift
    printf '%s %-5s [deploy] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$*" >&2
}
log_info() { _log INFO "$@"; }
log_warn() { _log WARN "$@"; }
log_err()  { _log ERROR "$@"; }

# --- ERR trap ----------------------------------------------------------------
# Fail loud: report the command and line that failed, on stderr, then let the
# non-zero status propagate (pipefail/errexit already abort). Re-armed by every
# orchestration script via `trap _on_err ERR` after sourcing; armed here too so
# even a bare `source deployment-utils.sh && some_fn` is covered.
_on_err() {
    local exit_code=$?
    log_err "command failed (exit ${exit_code}) at line ${BASH_LINENO[0]:-?}: ${BASH_COMMAND}"
    return "$exit_code"
}
trap _on_err ERR

# =============================================================================
# require_cmd — fail loud if a required external tool is missing.
# =============================================================================
require_cmd() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        log_err "required command not found on PATH: ${cmd}"
        return 1
    fi
}

# =============================================================================
# load_environment — source the server .env, fail loud if missing.
# -----------------------------------------------------------------------------
# Exports every var defined in the .env into the current process so children
# (docker compose --env-file also reads it; `python db/migrate.py` reads
# DATABASE_URL from the environment). NEVER prints any value. Validates a small
# set of keys that the state machine cannot function without.
# =============================================================================
load_environment() {
    if [[ ! -f "$ENV_FILE" ]]; then
        log_err "environment file not found: ${ENV_FILE}"
        log_err "copy Deploy/.env.example to Deploy/.env on the server and fill in real values (chmod 600)."
        return 1
    fi

    # Warn (do not fail) if the secrets file is group/world readable.
    local perms
    if perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null)"; then
        if [[ "$perms" != "600" && "$perms" != "400" ]]; then
            log_warn "secrets file ${ENV_FILE} has permissions ${perms}; expected 600. Run: chmod 600 ${ENV_FILE}"
        fi
    fi

    # Export everything defined while sourcing. `set -a` marks new vars for
    # export; we restore the prior allexport state afterwards so we don't change
    # the caller's shell options. The file is trusted server-side config; we do
    # not `eval` arbitrary input beyond it.
    local had_allexport=0
    [[ -o allexport ]] && had_allexport=1
    set -a
    # shellcheck disable=SC1090  # path is dynamic by design (configurable .env)
    source "$ENV_FILE"
    [[ "$had_allexport" -eq 0 ]] && set +a

    # Validate keys the state machine depends on. We check presence only and
    # NEVER log the values.
    local missing=()
    local required=(ACTIVE_ENVIRONMENT POSTGRES_USER POSTGRES_DB DATABASE_URL)
    local key
    for key in "${required[@]}"; do
        if [[ -z "${!key:-}" ]]; then
            missing+=("$key")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_err "environment file is missing required keys: ${missing[*]}"
        return 1
    fi

    if [[ "$ACTIVE_ENVIRONMENT" != "blue" && "$ACTIVE_ENVIRONMENT" != "green" ]]; then
        log_err "ACTIVE_ENVIRONMENT must be 'blue' or 'green', got an unexpected value."
        return 1
    fi

    log_info "environment loaded from ${ENV_FILE} (active=${ACTIVE_ENVIRONMENT})"
}

# =============================================================================
# save_env_var KEY VALUE — idempotent sed-or-append into the server .env.
# -----------------------------------------------------------------------------
# Updates an existing `KEY=...` line in place, or appends `KEY=VALUE` if absent.
# NEVER logs VALUE (it may be a secret or a state value we still don't echo, to
# keep one uniform rule). Writes via a temp file + atomic mv so a crash can't
# leave a half-written .env. Preserves 0600 permissions.
# =============================================================================
save_env_var() {
    local key="$1"
    local value="$2"

    if [[ -z "$key" ]]; then
        log_err "save_env_var: empty key"
        return 1
    fi
    # Guard the key shape so we never inject a malformed line or a sed
    # metacharacter via the key. Values are written literally (see below).
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        log_err "save_env_var: invalid key name (must match [A-Za-z_][A-Za-z0-9_]*): ${key}"
        return 1
    fi
    if [[ ! -f "$ENV_FILE" ]]; then
        log_err "save_env_var: ${ENV_FILE} does not exist; run load_environment first."
        return 1
    fi

    local tmp
    tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
    # Ensure the temp file is private before any content lands in it.
    chmod 600 "$tmp"

    # Rewrite line-by-line in awk so the VALUE never passes through a sed
    # replacement (no metacharacter interpretation, no value on a command line
    # that could surface in `ps`). The value is handed in via an awk variable.
    if grep -qE "^${key}=" "$ENV_FILE"; then
        awk -v k="$key" -v v="$value" '
            $0 ~ "^"k"=" { print k"="v; replaced=1; next }
            { print }
            END { if (!replaced) print k"="v }
        ' "$ENV_FILE" >"$tmp"
    else
        cat "$ENV_FILE" >"$tmp"
        printf '%s=%s\n' "$key" "$value" >>"$tmp"
    fi

    mv -f "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    # Log the KEY only — never the value.
    log_info "saved ${key} to ${ENV_FILE} (value redacted)"
}

# =============================================================================
# _nginx_active_color_from_lb — read the live km-lb config's prod API upstream
# and infer the color, or print nothing if the LB isn't reachable.
# -----------------------------------------------------------------------------
# The km-lb container holds the swapped nginx.conf at /etc/nginx/nginx.conf. The
# `upstream km_prod_api { server km-server-<color>:4000; }` block names the
# active color. We read it from inside the container so we reflect what is
# actually live (not just the file on disk). Falls back to the on-disk live conf
# if `docker exec` is unavailable. Prints "blue" | "green" | "" (unknown).
# =============================================================================
_nginx_active_color_from_lb() {
    local conf=""
    if command -v docker >/dev/null 2>&1 \
        && docker inspect -f '{{.State.Running}}' km-lb >/dev/null 2>&1; then
        conf="$(docker exec km-lb cat /etc/nginx/nginx.conf 2>/dev/null || true)"
    fi
    if [[ -z "$conf" && -f "$LIVE_NGINX_CONF" ]]; then
        conf="$(cat "$LIVE_NGINX_CONF" 2>/dev/null || true)"
    fi
    if [[ -z "$conf" ]]; then
        printf ''
        return 0
    fi

    # Parse the km_prod_api upstream's server line. Match the color in
    # km-server-<color>:4000 within (or just after) the km_prod_api block.
    # SC2016: the awk program is single-quoted ON PURPOSE — $0 and m[1] are awk
    # tokens that must NOT be expanded by the shell. The 3-arg match() is a gawk
    # extension; the grep fallback just below covers mawk/busybox awk builds that
    # lack it, so the parse stays portable.
    local color
    # shellcheck disable=SC2016
    color="$(printf '%s\n' "$conf" \
        | awk '
            /upstream[[:space:]]+km_prod_api/ { inblk=1 }
            inblk && match($0, /km-server-(blue|green)/, m) { print m[1]; exit }
            inblk && /}/ { inblk=0 }
        ' 2>/dev/null || true)"

    # Fallback for awk builds without match() capture groups (mawk): grep it.
    if [[ -z "$color" ]]; then
        color="$(printf '%s\n' "$conf" \
            | grep -oE 'km-server-(blue|green)' \
            | head -n1 \
            | sed -E 's/km-server-//' 2>/dev/null || true)"
    fi
    printf '%s' "$color"
}

# =============================================================================
# get_active_environment — the live active color.
# -----------------------------------------------------------------------------
# Source of truth: .env ACTIVE_ENVIRONMENT. Cross-check against the live km-lb
# upstream; warn (do not fail) on mismatch — check-active-env.sh is the script
# that turns a mismatch into a hard error. Prints the .env value on stdout so
# callers can `INACTIVE=$(get_inactive_environment)` cleanly.
# =============================================================================
get_active_environment() {
    if [[ -z "${ACTIVE_ENVIRONMENT:-}" ]]; then
        log_err "get_active_environment: ACTIVE_ENVIRONMENT unset; call load_environment first."
        return 1
    fi
    local declared="$ACTIVE_ENVIRONMENT"
    local live
    live="$(_nginx_active_color_from_lb)"
    if [[ -n "$live" && "$live" != "$declared" ]]; then
        log_warn "active color mismatch: .env says '${declared}' but live km-lb routes prod to '${live}'."
    fi
    printf '%s' "$declared"
}

# =============================================================================
# get_inactive_environment — the other color (the deploy target).
# =============================================================================
get_inactive_environment() {
    local active
    active="$(get_active_environment)"
    if [[ "$active" == "blue" ]]; then
        printf 'green'
    else
        printf 'blue'
    fi
}

# =============================================================================
# update_nginx_config COLOR — make COLOR the prod (1840) target.
# -----------------------------------------------------------------------------
# Copies nginx-${COLOR}-active.conf over the live nginx.conf the km-lb mounts,
# then reloads nginx gracefully (zero-downtime). If the graceful reload fails
# (e.g. the container is unhealthy), force-recreate km-lb so the new config is
# picked up. Idempotent: copying the same active config and reloading is a no-op
# in effect.
# =============================================================================
update_nginx_config() {
    local color="$1"
    if [[ "$color" != "blue" && "$color" != "green" ]]; then
        log_err "update_nginx_config: COLOR must be blue|green, got '${color}'."
        return 1
    fi
    local src="${DEPLOY_DIR}/nginx-${color}-active.conf"
    if [[ ! -f "$src" ]]; then
        log_err "update_nginx_config: missing routing template ${src}"
        return 1
    fi
    require_cmd docker

    # S-SF5: VALIDATE THE CANDIDATE BEFORE SWAPPING. The color templates are
    # bind-mounted read-only into km-lb (docker-compose.shared.yml), so we can
    # `nginx -t -c` the candidate in place WITHOUT first overwriting the live
    # nginx.conf. This closes the prior failure mode where a bad config was written
    # to the live file and then the force-recreate fallback booted km-lb onto it.
    # If km-lb is cold (not running yet), we can't pre-validate inside it — fall
    # through to the swap + force-recreate, which surfaces any error on boot.
    local candidate_in_lb="/etc/nginx/nginx-${color}-active.conf"
    if docker exec km-lb test -f "$candidate_in_lb" >/dev/null 2>&1; then
        if ! docker exec km-lb nginx -t -c "$candidate_in_lb" >/dev/null 2>&1; then
            log_err "update_nginx_config: candidate ${color} config FAILED nginx -t; NOT swapping. Live routing unchanged."
            return 1
        fi
        log_info "candidate ${color} config validated (nginx -t) — safe to swap."
    else
        log_warn "km-lb not running (or template not mounted); cannot pre-validate ${color} — will validate on (re)start."
    fi

    # Atomic swap of the live file (temp + mv) so km-lb never reads a partial
    # file even if it re-reads mid-copy.
    local tmp
    tmp="$(mktemp "${LIVE_NGINX_CONF}.XXXXXX")"
    cat "$src" >"$tmp"
    mv -f "$tmp" "$LIVE_NGINX_CONF"
    log_info "wrote live nginx.conf from nginx-${color}-active.conf"

    # Reload gracefully; the candidate was already validated above.
    if docker exec km-lb nginx -t >/dev/null 2>&1; then
        if docker exec km-lb nginx -s reload >/dev/null 2>&1; then
            log_info "km-lb reloaded gracefully (prod -> ${color})"
            return 0
        fi
        log_warn "graceful reload failed despite valid config; force-recreating km-lb"
    else
        log_warn "nginx -t failed inside km-lb (or container down); force-recreating km-lb"
    fi

    # Fallback: recreate just the LB from the shared project.
    docker compose -p "$SHARED_PROJECT" -f "$COMPOSE_SHARED_FILE" up -d --force-recreate km-lb
    log_info "km-lb force-recreated (prod -> ${color})"
}

# =============================================================================
# nginx_switch TARGET_COLOR — flip prod to TARGET_COLOR (thin wrapper).
# -----------------------------------------------------------------------------
# Kept as a distinct named entry point because the orchestration scripts and the
# contract call it by this name; the actual mechanism is update_nginx_config.
# =============================================================================
nginx_switch() {
    local target="$1"
    log_info "switching prod nginx routing to ${target}"
    update_nginx_config "$target"
}

# =============================================================================
# compose_color COLOR up|down — bring a color trio up or down.
# -----------------------------------------------------------------------------
# Each color is its own compose project (km-blue / km-green) sharing the named
# volumes + networks. `up` is `up -d`. Passes the server .env via --env-file so
# the color services read DATABASE_URL / secrets / image tags from it.
# =============================================================================
compose_color() {
    local color="$1"
    local action="${2:-up}"
    if [[ "$color" != "blue" && "$color" != "green" ]]; then
        log_err "compose_color: COLOR must be blue|green, got '${color}'."
        return 1
    fi
    local file="${DEPLOY_DIR}/docker-compose.${color}.yml"
    if [[ ! -f "$file" ]]; then
        log_err "compose_color: missing compose file ${file} (Builder A owns it)."
        return 1
    fi
    require_cmd docker
    local project="km-${color}"
    case "$action" in
        up)
            log_info "compose up: project=${project}"
            docker compose -p "$project" --env-file "$ENV_FILE" -f "$file" up -d
            ;;
        down)
            log_info "compose down: project=${project}"
            # Do NOT pass -v: named volumes are shared and must survive.
            docker compose -p "$project" --env-file "$ENV_FILE" -f "$file" down
            ;;
        *)
            log_err "compose_color: action must be up|down, got '${action}'."
            return 1
            ;;
    esac
}

# =============================================================================
# compose_shared up|down — bring the shared trio (km-lb/km-db/km-backup) up/down.
# =============================================================================
compose_shared() {
    local action="${1:-up}"
    if [[ ! -f "$COMPOSE_SHARED_FILE" ]]; then
        log_err "compose_shared: missing compose file ${COMPOSE_SHARED_FILE} (Builder A owns it)."
        return 1
    fi
    require_cmd docker
    case "$action" in
        up)
            log_info "compose up: project=${SHARED_PROJECT} (km-lb/km-db/km-backup)"
            docker compose -p "$SHARED_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_SHARED_FILE" up -d
            ;;
        down)
            log_info "compose down: project=${SHARED_PROJECT}"
            # Never -v: km_db_data / km_backups must survive.
            docker compose -p "$SHARED_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_SHARED_FILE" down
            ;;
        *)
            log_err "compose_shared: action must be up|down, got '${action}'."
            return 1
            ;;
    esac
}

# =============================================================================
# get_latest_backup — print the path of the newest backup dump, or empty.
# -----------------------------------------------------------------------------
# Reads $BACKUP_DIR from the loaded env (falls back to Deploy/backups). The
# backup files are named km-<UTCstamp>.dump by Deploy/db-backup.sh (Builder C).
# Used by rollback/restore tooling and surfaced for operators.
# =============================================================================
get_latest_backup() {
    local dir="${BACKUP_DIR:-${DEPLOY_DIR}/backups}"
    if [[ ! -d "$dir" ]]; then
        log_warn "get_latest_backup: backup dir not found: ${dir}"
        printf ''
        return 0
    fi
    local latest
    # Newest by mtime; restrict to the known dump naming to avoid stray files.
    latest="$(find "$dir" -maxdepth 1 -type f -name 'km-*.dump' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -n1 | cut -d' ' -f2- || true)"
    printf '%s' "$latest"
}

# =============================================================================
# verify_local_app NAME PORT [PATH] — poll an HTTP endpoint until healthy.
# -----------------------------------------------------------------------------
# curl http://localhost:PORT${PATH:-/health} up to VERIFY_ATTEMPTS times with
# VERIFY_SLEEP between tries. Treats HTTP 200 as healthy. NAME is a label for
# logs only. The prod (1840) and test (1841) ports use /health (proxied to the
# color's server). The LB's own liveness uses /healthz — pass it explicitly.
# Returns 0 on first 200, 1 if never healthy.
# =============================================================================
verify_local_app() {
    local name="$1"
    local port="$2"
    local path="${3:-/health}"
    require_cmd curl

    local url="http://localhost:${port}${path}"
    local attempt
    for (( attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++ )); do
        local code
        # -s silent, -o /dev/null discard body, -w status only, --max-time bound
        # each probe so a hung upstream can't stall the whole loop.
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || true)"
        if [[ "$code" == "200" ]]; then
            log_info "verify ${name}: ${url} healthy (200) on attempt ${attempt}/${VERIFY_ATTEMPTS}"
            return 0
        fi
        log_warn "verify ${name}: ${url} not ready (got '${code:-no-response}'), attempt ${attempt}/${VERIFY_ATTEMPTS}"
        if (( attempt < VERIFY_ATTEMPTS )); then
            sleep "$VERIFY_SLEEP"
        fi
    done
    log_err "verify ${name}: ${url} never returned 200 after ${VERIFY_ATTEMPTS} attempts"
    return 1
}

# =============================================================================
# wait_healthy CONTAINER — block until a container's healthcheck is healthy.
# -----------------------------------------------------------------------------
# Polls `docker inspect --format '{{.State.Health.Status}}'`. Succeeds on
# "healthy", fails fast on a container that is missing or has exited, and times
# out after HEALTHY_ATTEMPTS*HEALTHY_SLEEP. Containers without a healthcheck
# report empty status — we then fall back to "running" as healthy enough.
# =============================================================================
wait_healthy() {
    local container="$1"
    require_cmd docker

    local attempt
    for (( attempt = 1; attempt <= HEALTHY_ATTEMPTS; attempt++ )); do
        if ! docker inspect "$container" >/dev/null 2>&1; then
            log_warn "wait_healthy ${container}: not found yet, attempt ${attempt}/${HEALTHY_ATTEMPTS}"
            sleep "$HEALTHY_SLEEP"
            continue
        fi

        local state
        state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
        if [[ "$state" == "exited" || "$state" == "dead" ]]; then
            log_err "wait_healthy ${container}: container ${state} — aborting wait"
            return 1
        fi

        local health
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
        case "$health" in
            healthy)
                log_info "wait_healthy ${container}: healthy on attempt ${attempt}/${HEALTHY_ATTEMPTS}"
                return 0
                ;;
            "")
                # No healthcheck defined; running is the best signal we have. S-SF6:
                # warn loudly — "running" is weaker than "healthy" (the process may be
                # up but not yet serving), and every color service is SUPPOSED to
                # define a healthcheck, so a missing one is a regression worth
                # surfacing, not silently accepting.
                if [[ "$state" == "running" ]]; then
                    log_warn "wait_healthy ${container}: NO healthcheck defined — accepting 'running' as up (weaker signal; a healthcheck should be defined)"
                    return 0
                fi
                ;;
            *)
                log_warn "wait_healthy ${container}: health='${health}' state='${state}', attempt ${attempt}/${HEALTHY_ATTEMPTS}"
                ;;
        esac
        sleep "$HEALTHY_SLEEP"
    done
    log_err "wait_healthy ${container}: never became healthy after ${HEALTHY_ATTEMPTS} attempts"
    return 1
}

# =============================================================================
# Guard: this file is a library. Refuse to be executed directly so a stray
# `./deployment-utils.sh` doesn't run strict-mode-then-nothing and look like a
# success. Sourcing (the intended use) skips this block.
# =============================================================================
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    log_err "deployment-utils.sh is a library and must be sourced, not executed."
    log_err "usage: source \"\$(dirname \"\$0\")/deployment-utils.sh\""
    exit 1
fi
