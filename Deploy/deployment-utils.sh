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
# Architecture (locked, see Deploy/README.md):
#   * Blue/green on ONE host. ONE SHARED Postgres (km-db) that BOTH colors point
#     to. A "switch" is therefore a pure nginx flip — no data is copied.
#   * Compose projects are SEPARATE and share volumes + networks:
#       km-shared : km-lb, km-db, km-backup, km-worker  (docker-compose.shared.yml)
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
# The active-color signal BOTH km-server-blue and km-server-green bind-mount
# read-only (Phase 1.3 story-runner gating): a single line naming which color
# is currently promoted, so each server process can tell whether IT is the
# active one without a restart (a switch is a pure nginx reload — see
# azure-switch-production.sh). Deliberately a separate file from ENV_FILE:
# ENV_FILE holds secrets and both colors already receive its values as env
# vars at container start, but mounting the raw secrets FILE into a running
# container is a needless extra read surface — this file holds nothing but a
# color name. write_active_color_file (below) keeps it in sync with
# ACTIVE_ENVIRONMENT.
ACTIVE_COLOR_FILE="${KM_ACTIVE_COLOR_FILE:-${DEPLOY_DIR}/active-color}"

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
    # NEVER log the values. DATABASE_URL is intentionally NOT required here — the
    # POSTGRES_* primitives are the single source of truth for the credentials
    # (.env.example documents this), and DATABASE_URL is DERIVED below.
    local missing=()
    local required=(ACTIVE_ENVIRONMENT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB)
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

    # Derive DATABASE_URL for HOST-run tooling (db/migrate.py reads it from the
    # environment) from the single-source-of-truth POSTGRES_* primitives, unless
    # the operator pinned an explicit one in the .env. The host reaches the shared
    # km-db over the loopback-mapped port (POSTGRES_HOST_PORT, default 5432); the
    # CONTAINERS compose their own DATABASE_URL (@km-db) independently. Keeping the
    # credentials in exactly one place (the POSTGRES_* trio) means a rotated
    # password can never drift between a stored URL and the primitives.
    if [[ -z "${DATABASE_URL:-}" ]]; then
        export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB}"
    fi

    # BACKUP_DIR must be a HOST directory (db-backup.sh redirects pg_dump stdout to
    # it on the host; the containers bind-mount it at /backups). If it is unset, or
    # it is the legacy in-CONTAINER value "/backups" (not writable from the host —
    # a root-owned mount point), normalize it to a persistent host dir next to the
    # .env. An operator can still pin any other absolute host path explicitly.
    if [[ -z "${BACKUP_DIR:-}" || "${BACKUP_DIR}" == "/backups" ]]; then
        export BACKUP_DIR="$(dirname -- "$ENV_FILE")/backups"
    fi

    log_info "environment loaded from ${ENV_FILE} (active=${ACTIVE_ENVIRONMENT})"
}

# =============================================================================
# load_environment_optional — like load_environment, but tolerate a MISSING .env.
# -----------------------------------------------------------------------------
# The km-backup sidecar receives its config through the compose `environment:`
# block (PG* creds + BACKUP_* schedule); NO .env is mounted into that container.
# Calling the strict load_environment there crash-loops the container ("env file
# not found"). This variant sources the .env when it IS present (host/dev runs,
# where it remains the source of truth and full validation applies), and
# otherwise returns 0 so the caller proceeds on the process environment alone.
# Callers validate whatever THEY actually need (db-backup.sh checks its creds).
# =============================================================================
load_environment_optional() {
    if [[ -f "$ENV_FILE" ]]; then
        load_environment
        return
    fi
    log_info "no env file at ${ENV_FILE}; using the injected process environment as-is"
    return 0
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
# write_active_color_file COLOR — atomically (re)write ACTIVE_COLOR_FILE.
# -----------------------------------------------------------------------------
# Keeps the bind-mounted active-color signal (Phase 1.3 story-runner gating)
# in sync with ACTIVE_ENVIRONMENT. Not a secret — world-readable is fine — but
# still written via temp-file + atomic mv so a concurrent read (a server tick
# in either color) never observes a half-written file. Callers: every place
# that persists ACTIVE_ENVIRONMENT should call this too (currently
# azure-switch-production.sh post-flip, and local-standup.sh's cold seed).
# =============================================================================
write_active_color_file() {
    local color="$1"
    if [[ "$color" != "blue" && "$color" != "green" ]]; then
        log_err "write_active_color_file: color must be 'blue' or 'green', got '${color}'"
        return 1
    fi
    local tmp
    tmp="$(mktemp "${ACTIVE_COLOR_FILE}.XXXXXX")"
    printf '%s\n' "$color" >"$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "$ACTIVE_COLOR_FILE"
    log_info "wrote active color '${color}' to ${ACTIVE_COLOR_FILE}"
}

# =============================================================================
# _nginx_active_color_from_lb — read the live km-lb config's PROD API backend
# and infer the color, or print nothing if the LB isn't reachable.
# -----------------------------------------------------------------------------
# The km-lb container holds the swapped nginx.conf at /etc/nginx/nginx.conf. The
# PROD server (`listen 1840`) routes the API to the ACTIVE color via
# `set $api_backend "km-server-<color>:4000";`. We read the config from inside
# the container so we reflect what is actually live (not just the file on disk),
# scope the match to the prod (1840) server block so the test (1841) backend for
# the inactive color can never be mistaken for active, and take the FIRST
# km-server-<color> at/after `listen 1840`. Falls back to the on-disk live conf
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

    # Scope to the PROD (listen 1840) server block, then take the color of the
    # first km-server-<color> backend inside it. awk is portable here (no gawk
    # 3-arg match()): once inside the 1840 block, gsub strips everything around
    # the color token on the matching line. The grep fallback below covers any
    # awk that mis-handles this. Both anchor on `listen 1840` so the inactive
    # color's test-port (1841) backend is never read as active.
    local color
    # shellcheck disable=SC2016
    color="$(printf '%s\n' "$conf" \
        | awk '
            /listen[[:space:]]+1840/ { inprod=1 }
            inprod && /listen[[:space:]]+1841/ { inprod=0 }
            inprod && /km-server-(blue|green)/ {
                line=$0
                sub(/.*km-server-/, "", line)
                sub(/[^a-z].*/, "", line)
                print line
                exit
            }
        ' 2>/dev/null || true)"

    # Fallback: the prod (1840) block precedes the test (1841) block in the file,
    # so the FIRST km-server-<color> in the whole config is the active one.
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

    # Write the new live config IN PLACE (cp truncates + rewrites the SAME file),
    # NOT via mktemp+mv. km-lb bind-mounts this single file
    # (docker-compose.shared.yml). A single-file bind mount is pinned to the
    # file's INODE at container creation: mv/rename installs a NEW inode at the
    # path, so a RUNNING km-lb keeps reading the OLD file and `nginx -s reload`
    # reloads stale config — the color switch then silently no-ops and prod
    # returns 502 on the supposedly-new color. (Verified: an mv over a
    # bind-mounted file is invisible to the container; an in-place cp is visible.)
    if ! cp -f "$src" "$LIVE_NGINX_CONF"; then
        log_err "update_nginx_config: failed writing live config ${LIVE_NGINX_CONF}"
        return 1
    fi
    log_info "wrote live nginx.conf from nginx-${color}-active.conf"

    # Apply by FORCE-RECREATING km-lb rather than `nginx -s reload`. Recreating
    # re-binds whatever inode the live path currently points to AND loads it,
    # which (a) applies the new config deterministically and (b) RECOVERS a km-lb
    # that was previously started against a since-replaced inode (the historical
    # mv bug above). A graceful reload cannot do (b): on a stale-bound container
    # it "succeeds" but reloads the old in-container file. The colors stay up;
    # only the LB proxy blips (~1-2s) — an acceptable trade for a correct,
    # deterministic switch on this single-host deploy. The candidate was already
    # `nginx -t`-validated above, so this will not boot km-lb onto a bad config.
    # (A fully zero-downtime alternative is to bind-mount a DIRECTORY and reload,
    # since renames within a mounted dir ARE visible — left as a future change.)
    if docker compose -p "$SHARED_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_SHARED_FILE" up -d --force-recreate km-lb >/dev/null 2>&1; then
        log_info "km-lb recreated (prod -> ${color})"
        return 0
    fi
    log_err "update_nginx_config: failed to recreate km-lb (prod -> ${color})"
    return 1
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
# run_migrate ARGS... — run db/migrate.py in the pre-built km-migrate container.
# -----------------------------------------------------------------------------
# WHY a container, not the host's Python: migrate.py needs psycopg[v3] +
# structlog + Python 3.10+, which the deploy agent may not have (and we don't
# want to mutate host Python). It must also run ON the km-internal network — the
# same place km-db lives — so it reaches the DB by compose hostname (km-db:5432)
# regardless of host port maps.
#
# WHY a PRE-BUILT image, not a runtime `pip install`: km-internal is declared
# `internal: true` (docker-compose.shared.yml) and therefore has NO internet
# egress, so a container on it CANNOT reach PyPI. The deps are instead baked into
# km-migrate on the hosted build agent (Deploy/migrate.Dockerfile) and the image
# is docker-load'd on the server alongside km-server/client/kiwi. So this helper
# performs ZERO network installs — it only talks to km-db.
#
# The image carries deps only; the repo (migrate.py + migration SQL) is mounted
# read-only so the migration set matches the deployed revision and the image
# never needs a rebuild when a migration is added. The image tag tracks the
# release: DEPLOY_TAG must be exported by the caller (azure-deploy-inactive.sh).
# Pass the migrate.py args verbatim, e.g.
#   run_migrate --dry-run up
#   run_migrate up
# (NOTE: --dry-run is a GLOBAL flag and must precede the subcommand.)
# =============================================================================
run_migrate() {
    require_cmd docker
    : "${POSTGRES_USER:?run_migrate: POSTGRES_USER not set (call load_environment)}"
    : "${POSTGRES_PASSWORD:?run_migrate: POSTGRES_PASSWORD not set}"
    : "${POSTGRES_DB:?run_migrate: POSTGRES_DB not set}"
    : "${DEPLOY_TAG:?run_migrate: DEPLOY_TAG not set (export the release tag before calling)}"

    local migrate_image="km-migrate:${DEPLOY_TAG}"
    # The image is built + saved in BuildAndTest and docker-load'd in
    # DeployToInactive (azure-pipelines.yml). It is NEVER built or pip-installed
    # here — km-internal is egress-blocked by design, so a runtime install is
    # impossible. Fail fast with a clear message if the load step didn't run.
    if ! docker image inspect "$migrate_image" >/dev/null 2>&1; then
        log_err "run_migrate: image ${migrate_image} not found locally."
        log_err "It is built + saved in BuildAndTest and docker-load'd in DeployToInactive."
        log_err "Running manually? docker load the km-migrate-<tag>.tar artifact, or"
        log_err "build it: docker build -t ${migrate_image} -f Deploy/migrate.Dockerfile Deploy"
        return 1
    fi

    # In-container DSN: reach km-db over the shared network by hostname (NOT the
    # host loopback DATABASE_URL the host tooling uses).
    local container_dsn="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@km-db:5432/${POSTGRES_DB}"

    docker run --rm \
        --network km-internal \
        -v "${REPO_ROOT}:/repo:ro" \
        -w /repo \
        -e DATABASE_URL="$container_dsn" \
        "$migrate_image" \
        python db/migrate.py "$@"
}

# =============================================================================
# run_loader DATA_DIR WORKDIR -- CMD...  — run a baked loader against km-db.
# -----------------------------------------------------------------------------
# Runs the km-loader image (loader code + deps baked in) on km-internal so it can
# reach the shared km-db by hostname, with the host DATA_DIR bind-mounted
# read-only at /data. Used for the MANUAL corpus / KRDICT load: the data is
# gitignored and arrives by USB, so only DATA crosses the mount; CODE ships in the
# image. Mirrors run_migrate (same image-presence guard, same in-container DSN).
#
#   run_loader /srv/usb/corpora /app -- \
#       python -m tools.ingest.load_to_postgres --input-dir /data --corpus all
#
# DATA_DIR  host directory to expose at /data (must exist).
# WORKDIR   container working directory (/app for the corpus loader package;
#           /app/tools/ingest for `python -m load_krdict`).
# CMD...    the loader invocation (everything after the literal `--`).
# =============================================================================
run_loader() {
    require_cmd docker
    : "${POSTGRES_USER:?run_loader: POSTGRES_USER not set (call load_environment)}"
    : "${POSTGRES_PASSWORD:?run_loader: POSTGRES_PASSWORD not set}"
    : "${POSTGRES_DB:?run_loader: POSTGRES_DB not set}"
    : "${DEPLOY_TAG:?run_loader: DEPLOY_TAG not set (export the release tag before calling)}"

    local data_dir="$1"
    local workdir="$2"
    shift 2
    if [[ "${1:-}" == "--" ]]; then
        shift
    fi
    if [[ $# -eq 0 ]]; then
        log_err "run_loader: no loader command given after '--'."
        return 2
    fi
    if [[ ! -d "$data_dir" ]]; then
        log_err "run_loader: data dir not found: ${data_dir}"
        return 1
    fi
    local data_abs
    data_abs="$(cd "$data_dir" && pwd -P)"

    local loader_image="km-loader:${DEPLOY_TAG}"
    # Same contract as run_migrate: built + saved in BuildAndTest, docker-load'd
    # in DeployToInactive. Never built/pip-installed here (km-internal has no
    # egress). Fail fast if the load step didn't run.
    if ! docker image inspect "$loader_image" >/dev/null 2>&1; then
        log_err "run_loader: image ${loader_image} not found locally."
        log_err "It is built + saved in BuildAndTest and docker-load'd in DeployToInactive."
        log_err "Running manually? docker load the km-loader-<tag>.tar artifact, or"
        log_err "build it: docker build -t ${loader_image} -f Deploy/loader.Dockerfile ${REPO_ROOT}"
        return 1
    fi

    # In-container DSN: reach km-db over the shared network by hostname (NOT the
    # host loopback DATABASE_URL). DATA_DIR is mounted read-only — loaders only
    # read it.
    local container_dsn="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@km-db:5432/${POSTGRES_DB}"

    log_info "run_loader: ${loader_image} (data=${data_abs}) -> ${*}"
    docker run --rm \
        --network km-internal \
        -v "${data_abs}:/data:ro" \
        -w "$workdir" \
        -e DATABASE_URL="$container_dsn" \
        "$loader_image" \
        "$@"
}

# =============================================================================
# build_worker — build the km-worker GPU Whisper image ON THIS HOST.
# -----------------------------------------------------------------------------
# UNLIKE km-migrate/km-loader (CI-built, docker-save/load'd as tar artifacts),
# km-worker is built directly on the server: the CUDA + cuDNN + baked-large-v3
# image is multi-GB (a tar artifact would be impractical) and it targets THIS
# host's GPU. The BUILD needs internet egress (apt, pip, the ~3 GB Hugging Face
# model download on first build); the RUNTIME (km-internal) needs none — that
# is exactly why everything is baked. Repo root is the build context so
# `COPY tools` works (same contract as loader.Dockerfile).
#
# Tags km-worker:${WORKER_IMAGE_TAG:-latest} — the same tag the km-worker
# service in docker-compose.shared.yml runs. After a rebuild, restart it:
#   compose_shared up   (recreates km-worker on the new image)
# =============================================================================
build_worker() {
    require_cmd docker
    local worker_image="km-worker:${WORKER_IMAGE_TAG:-latest}"
    log_info "build_worker: building ${worker_image} (context=${REPO_ROOT})"
    docker build \
        -t "$worker_image" \
        -f "${DEPLOY_DIR}/worker.Dockerfile" \
        "${REPO_ROOT}"
}

# =============================================================================
# run_worker_once — one-off foreground km-worker run for smoke/manual drains.
# -----------------------------------------------------------------------------
# Mirrors run_loader: a --rm container on km-internal reaching the shared km-db
# by hostname — but authenticating as the least-privilege km_app role (the
# worker is app-plane, not operator-plane; it must never carry POSTGRES_USER).
# `--gpus all` uses the host nvidia runtime directly (the long-lived service in
# docker-compose.shared.yml instead declares a device reservation). The shared
# km_audio_uploads volume is mounted READ-ONLY — the worker only reads blobs.
#
# Foreground on purpose: watch the JSON logs, Ctrl-C to stop. The worker's
# claim/settle/reap protocol (076) makes an interrupted run safe — a killed
# 'running' job is reaped after AUDIO_STALE_RUN_MINUTES.
#
#   run_worker_once                      # drain with .env/default knobs
#   WHISPER_DEVICE=cpu run_worker_once   # forced-CPU smoke test
#
# NB: the forced-CPU smoke still passes `--gpus all`, so the host needs the
# nvidia container toolkit either way — it smokes the CPU COMPUTE path, it is
# NOT a no-GPU-host fallback (this helper is M-only, like the image).
# =============================================================================
run_worker_once() {
    require_cmd docker
    : "${KM_APP_PASSWORD:?run_worker_once: KM_APP_PASSWORD not set (call load_environment; see set-km-app-password.sh)}"
    : "${POSTGRES_DB:?run_worker_once: POSTGRES_DB not set (call load_environment)}"

    # Takes NO arguments: the image ENTRYPOINT is the worker loop and every
    # knob is an env var (see header). Reject strays so a mistyped invocation
    # fails loud instead of silently ignoring what was passed.
    if [[ $# -ne 0 ]]; then
        log_err "run_worker_once: takes no arguments (got: $*). Configure via env vars, e.g. WHISPER_DEVICE=cpu run_worker_once."
        return 2
    fi

    local worker_image="km-worker:${WORKER_IMAGE_TAG:-latest}"
    # Host-built (see build_worker) — there is no CI tar to docker-load.
    if ! docker image inspect "$worker_image" >/dev/null 2>&1; then
        log_err "run_worker_once: image ${worker_image} not found locally."
        log_err "km-worker is built ON this host, not shipped by CI. Build it:"
        log_err "  build_worker    (docker build -f Deploy/worker.Dockerfile ${REPO_ROOT})"
        return 1
    fi

    # GPU-collision guard: the long-lived km-worker service (compose) and this
    # one-off would BOTH load large-v3 onto the single 8 GB RTX 3070 — a
    # coin-flip CUDA OOM, and per worker.py an OOM settles the in-flight job
    # 'failed' (poisons real jobs). Refuse while the service is live. Same
    # fail-fast style as the image guard above.
    if [[ -n "$(docker ps --filter name='^/km-worker$' --filter status=running -q)" ]]; then
        log_err "run_worker_once: the km-worker service is live; it and this one-off would contend for the single GPU (CUDA OOM poisons jobs)."
        log_err "Stop km-worker first (docker stop km-worker), run the one-off, then restore the service:  compose_shared up"
        return 1
    fi

    # Volume-existence guard: the -v mount below would AUTO-CREATE an
    # unlabeled km_audio_uploads if it doesn't exist (ensure_volume is
    # inspect-then-skip, so the app=korean-master label would never be
    # retrofitted). Mirror run_loader's data-dir guard: require the canonical
    # creator to have run; never auto-create here.
    if ! docker volume inspect km_audio_uploads >/dev/null 2>&1; then
        log_err "run_worker_once: volume km_audio_uploads not found. Run ensure-shared-volume.sh first (the single labeled creator)."
        return 1
    fi

    # In-container DSN: reach km-db over the shared network by hostname, as
    # km_app (same principal + grants as the compose service and km-server).
    local container_dsn="postgres://${KM_APP_USER:-km_app}:${KM_APP_PASSWORD}@km-db:5432/${POSTGRES_DB}"

    log_info "run_worker_once: ${worker_image} (one-off, GPU, km-internal)"
    docker run --rm \
        --gpus all \
        --network km-internal \
        -v km_audio_uploads:/var/audio-uploads:ro \
        -e DATABASE_URL="$container_dsn" \
        -e AUDIO_UPLOAD_STORAGE_DIR=/var/audio-uploads \
        -e AUDIO_STALE_RUN_MINUTES="${AUDIO_STALE_RUN_MINUTES:-60}" \
        -e WHISPER_MODEL="${WHISPER_MODEL:-large-v3}" \
        -e WHISPER_DEVICE="${WHISPER_DEVICE:-auto}" \
        -e WHISPER_COMPUTE_TYPE="${WHISPER_COMPUTE_TYPE:-auto}" \
        -e POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-5}" \
        "$worker_image"
}

# =============================================================================
# run_audio_corpus_loader SET_DIR -- ARGS... — bulk-ingest one corpus audio set.
# -----------------------------------------------------------------------------
# Runs tools/audio_stt/load_audio_corpus.py (the operator analog of POST
# /audio: audio_sources + audio_tracks + audio_transcription_jobs + blobs) in a
# --rm container on km-internal. The already-running km-worker service then
# drains the enqueued jobs — no worker restart, no GPU here, and no contention:
# the loader upserts sources, INSERTs tracks/jobs, and makes guarded-safe
# UPDATEs (a failed->pending track flip guarded on transcript_status='failed',
# plus short per-track FOR UPDATE row locks), so it never touches a row the
# worker owns; the worker claims with FOR UPDATE SKIP LOCKED.
#
# IMAGE: km-worker:${WORKER_IMAGE_TAG:-latest} — chosen because it is already
# built on this host (the service is running from it) and has the loader's
# entire dep set baked (python + psycopg + structlog). The CURRENT repo is
# bind-mounted RO at /repo and used as the workdir (run_migrate's exact
# maneuver), so the loader code that runs is the checkout's, NOT the image's
# stale COPY — zero rebuild needed. Overriding the ENTRYPOINT is what turns
# the worker image into a plain python runner for this one-off.
#
# MOUNTS: km_audio_uploads RW at /var/audio-uploads (this is the ONE writer
# besides km-server — the worker mounts it RO); SET_DIR RO at /data (data
# only ever crosses the mount read-only, run_loader's stance); repo RO.
# AUTH: operator-plane POSTGRES_USER (run_loader's posture — this is a manual
# corpus ingest, not an app-plane service).
#
#   run_audio_corpus_loader ~/data/korean-master/corpus/Folktales -- \
#       --slug korean-folktales --title "Korean Folktales" --user 1 [--dry-run]
#
# `--set-dir /data` is supplied by the helper; pass everything else after
# `--` (see the loader's --help: --slug/--title/--user required, --kind /
# --dry-run / --limit optional). For a multi-set --manifest run, invoke
# docker directly with the same mounts and a manifest whose set_dir values
# are /data-relative container paths.
# =============================================================================
run_audio_corpus_loader() {
    require_cmd docker
    : "${POSTGRES_USER:?run_audio_corpus_loader: POSTGRES_USER not set (call load_environment)}"
    : "${POSTGRES_PASSWORD:?run_audio_corpus_loader: POSTGRES_PASSWORD not set}"
    : "${POSTGRES_DB:?run_audio_corpus_loader: POSTGRES_DB not set}"

    local set_dir="${1:-}"
    if [[ -z "$set_dir" ]]; then
        log_err "run_audio_corpus_loader: usage: run_audio_corpus_loader SET_DIR -- --slug S --title T --user N [...]"
        return 2
    fi
    shift
    if [[ "${1:-}" == "--" ]]; then
        shift
    fi
    if [[ $# -eq 0 ]]; then
        log_err "run_audio_corpus_loader: no loader args after '--' (need at least --slug/--title/--user)."
        return 2
    fi
    if [[ ! -d "$set_dir" ]]; then
        log_err "run_audio_corpus_loader: set dir not found: ${set_dir}"
        return 1
    fi
    local set_abs
    set_abs="$(cd "$set_dir" && pwd -P)"

    local worker_image="km-worker:${WORKER_IMAGE_TAG:-latest}"
    # Host-built (see build_worker) — and guaranteed present wherever the
    # km-worker service is running, which is exactly where this helper is for.
    if ! docker image inspect "$worker_image" >/dev/null 2>&1; then
        log_err "run_audio_corpus_loader: image ${worker_image} not found locally."
        log_err "It is the km-worker image (built on this host — see build_worker)."
        return 1
    fi
    # Never auto-create the shared volume unlabeled (run_worker_once's guard).
    if ! docker volume inspect km_audio_uploads >/dev/null 2>&1; then
        log_err "run_audio_corpus_loader: volume km_audio_uploads not found. Run ensure-shared-volume.sh first (the single labeled creator)."
        return 1
    fi

    local container_dsn="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@km-db:5432/${POSTGRES_DB}"

    log_info "run_audio_corpus_loader: ${worker_image} (set=${set_abs}) -> ${*}"
    docker run --rm \
        --network km-internal \
        -v "${REPO_ROOT}:/repo:ro" \
        -w /repo \
        -v km_audio_uploads:/var/audio-uploads:rw \
        -v "${set_abs}:/data:ro" \
        -e DATABASE_URL="$container_dsn" \
        -e AUDIO_UPLOAD_STORAGE_DIR=/var/audio-uploads \
        --entrypoint /opt/venv/bin/python \
        "$worker_image" \
        -m tools.audio_stt.load_audio_corpus --set-dir /data "$@"
}

# =============================================================================
# verify_worker — post-standup assertion that km-worker is actually serving.
# -----------------------------------------------------------------------------
# WHY: docker-compose.shared.yml deliberately runs km-worker with
# ${KM_APP_PASSWORD:-} (NOT the color files' `:?` hard-fail) so a cold box can
# bootstrap km-db/km-lb BEFORE migration 047 + set-km-app-password.sh exist.
# That choice converts "compose refuses to start" into "km-worker crash-loops
# quietly while km-db/km-lb look green" — a dropped/typo'd password or a stale
# image silently benches the transcription queue. This helper is the
# compensating control that `:-` owes: it asserts the worker is (1) running
# and NOT restart-looping and (2) the km_app queue grants it depends on are
# live on km-db.
#
# NOT wired as a hard gate into azure-deploy-inactive.sh: that script's
# compose_shared up happens BEFORE migrations by design (cold-box ordering),
# where a crash-looping worker is the documented, tolerated state — a hard
# gate there would break the bootstrap the `:-` exists to permit. Operators
# run this AFTER a standup/rebuild (password set, migrations applied):
#     source Deploy/deployment-utils.sh && load_environment && verify_worker
# =============================================================================
verify_worker() {
    require_cmd docker
    : "${KM_APP_PASSWORD:?verify_worker: KM_APP_PASSWORD not set (call load_environment; see set-km-app-password.sh)}"
    : "${POSTGRES_DB:?verify_worker: POSTGRES_DB not set (call load_environment)}"

    # (1) Container state: must be running, and RestartCount must be STABLE.
    # Two samples a beat apart: a live crash-loop increments between them; a
    # nonzero-but-stable count is historical (e.g. pre-password bootstrap) and
    # only worth a warn.
    local state restarts restarts2
    if ! state="$(docker inspect -f '{{.State.Status}}' km-worker 2>/dev/null)"; then
        log_err "verify_worker: container km-worker not found (compose_shared up not run, or the image was never built — see build_worker)."
        return 1
    fi
    if [[ "$state" != "running" ]]; then
        log_err "verify_worker: km-worker state='${state}' (expected 'running'). Inspect: docker logs km-worker"
        return 1
    fi
    restarts="$(docker inspect -f '{{.RestartCount}}' km-worker)"
    sleep 5
    state="$(docker inspect -f '{{.State.Status}}' km-worker 2>/dev/null || true)"
    restarts2="$(docker inspect -f '{{.RestartCount}}' km-worker 2>/dev/null || echo -1)"
    if [[ "$state" != "running" || "$restarts2" -gt "$restarts" || "$restarts2" -lt 0 ]]; then
        log_err "verify_worker: km-worker is restart-looping (state='${state}', RestartCount ${restarts} -> ${restarts2})."
        log_err "Most likely the km_app password: compose runs it with \${KM_APP_PASSWORD:-} (empty until set-km-app-password.sh). Inspect: docker logs km-worker"
        return 1
    fi
    if [[ "$restarts2" != "0" ]]; then
        log_warn "verify_worker: RestartCount=${restarts2} (historical restarts; stable across the sample window)"
    fi

    # (2) km_app grant smoke: the worker's queue UPDATE privilege must be live
    # (047's blanket + default-privilege grants covering the 073-077 tables).
    # Same posture as run_worker_once: km_app principal, km-internal, no ports.
    # postgres:16-alpine is guaranteed local (km-db runs it); --pull never so
    # this can never turn into a network fetch; PGCONNECT_TIMEOUT bounds a
    # hung connect. NEVER echoes the password (env-injected, not argv).
    local grant
    grant="$(docker run --rm --pull never \
        --network km-internal \
        -e PGPASSWORD="${KM_APP_PASSWORD}" \
        -e PGCONNECT_TIMEOUT=10 \
        postgres:16-alpine \
        psql -h km-db -U "${KM_APP_USER:-km_app}" -d "${POSTGRES_DB}" -tA \
        -c "select has_table_privilege('km_app','audio_transcription_jobs','UPDATE')" \
        2>/dev/null || true)"
    if [[ "$grant" != "t" ]]; then
        log_err "verify_worker: km_app grant smoke FAILED (has_table_privilege('km_app','audio_transcription_jobs','UPDATE') -> '${grant:-no-response}', expected 't')."
        log_err "Check that migrations (047 + 073-077) are applied and set-km-app-password.sh has run."
        return 1
    fi

    log_info "verify_worker: km-worker running (RestartCount=${restarts2}) and km_app queue grants live — OK"
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
# compose_shared up|down — bring the shared services up/down
# (km-lb / km-db / km-backup / km-worker).
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
            log_info "compose up: project=${SHARED_PROJECT} (km-lb/km-db/km-backup/km-worker)"
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
# verify_upload_body_limit NAME PORT — smoke-check the LB's upload body cap.
# -----------------------------------------------------------------------------
# Regression guard: the km-lb nginx once sat at its 1 MB client_max_body_size
# DEFAULT and silently 413'd book uploads before they ever reached the server
# (fixed by setting 320m in nginx.conf + both nginx-{blue,green}-active.conf).
# This POSTs a ~2 MiB body to /uploads on the given port and FAILS if the
# response is 413 — proof the cap regressed. The expected result is 401 (the
# unauthenticated request TRAVERSED nginx and reached the app's auth layer);
# any non-413 code passes the gate, with a warn if it isn't the expected 401.
# The body is piped from /dev/zero (curl --data-binary @- buffers stdin and
# sends a Content-Length, which nginx checks against the cap up front), so no
# temp file is created. NAME is a label for logs only. Returns 0 unless 413.
# =============================================================================
verify_upload_body_limit() {
    local name="$1"
    local port="$2"
    require_cmd curl

    local url="http://localhost:${port}/uploads"
    local code
    code="$(head -c 2097152 /dev/zero \
        | curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
              -X POST -H 'Content-Type: application/octet-stream' \
              --data-binary @- "$url" 2>/dev/null || true)"

    if [[ "$code" == "413" ]]; then
        log_err "verify ${name}: 2 MiB POST ${url} returned 413 — the LB is capping request bodies at nginx's 1 MB default again."
        log_err "client_max_body_size must be 320m in Deploy/nginx.conf AND both Deploy/nginx-{blue,green}-active.conf (all server blocks). Do NOT switch."
        return 1
    fi
    if [[ "$code" == "401" ]]; then
        log_info "verify ${name}: 2 MiB POST ${url} -> 401 (reached the app's auth layer; body-size cap OK)"
    else
        log_warn "verify ${name}: 2 MiB POST ${url} -> '${code:-no-response}' (expected 401; not 413, so the body cap is OK — but the route may not be reaching the server as expected)"
    fi
    return 0
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
