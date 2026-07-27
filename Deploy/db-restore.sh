#!/usr/bin/env bash
# =============================================================================
# Korean Master — production DB restore (blue/green-aware wrapper)
# =============================================================================
# WHAT: restore a custom-format dump (produced by db-backup.sh) into the shared
#       `km-db` database. This DROPS AND RECREATES the database.
#
# WHY a separate script from db/scripts/restore.sh:
#   * db/scripts/restore.sh is local-dev (compose service `db`).
#   * THIS one targets the named container `km-db` and is blue/green-aware: the
#     shared DB serves BOTH colors, so a restore is a destructive recovery /
#     rollback action that wipes data the live production code is using. It
#     therefore REFUSES to run while a color is actively serving unless
#     --force is given (you are expected to take traffic down, or knowingly
#     accept the blast radius, first).
#
# SAFETY (threat-modeled — see SECURITY.md):
#   * Path-traversal guard: the dump must resolve to a real file UNDER
#     $BACKUP_DIR. We then address it by its path INSIDE the container's
#     /backups mount (km-db mounts km_backups at /backups), exactly like
#     db/scripts/restore.sh — pg_restore reads a real seekable file (parallel
#     restore, no docker stdio truncation on large dumps) and a `../` argument
#     can never escape the backup root.
#   * Format gate: `pg_restore --list` must succeed BEFORE we drop anything.
#   * Identifier gate: POSTGRES_DB / POSTGRES_USER must be plain identifiers
#     (defends against env-var injection into the drop/recreate SQL).
#   * Active-color gate: refuse unless --force when a color is serving.
#   * TRUST: only restore dumps you produced. A malicious custom-format dump
#     can carry CREATE FUNCTION … LANGUAGE plperlu or COPY FROM PROGRAM
#     payloads that run as the DB superuser. See db/SECURITY.md.
#   * No secret is ever echoed.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=Deploy/deployment-utils.sh
source "$SCRIPT_DIR/deployment-utils.sh"

trap 'log_err "db-restore.sh failed at line $LINENO (exit $?)"' ERR

DB_CONTAINER="${DB_CONTAINER:-km-db}"

usage() {
  cat >&2 <<'EOF'
Usage: db-restore.sh <dump-file> [--force]

  <dump-file>   Custom-format dump to restore. MUST live under $BACKUP_DIR
                (so it is visible inside km-db at /backups). Use db-backup.sh
                output, e.g. $BACKUP_DIR/km-20260531T030000Z.dump.
  --force       Restore even though a color is actively serving production
                traffic. The shared DB is wiped and recreated — this is a
                recovery/rollback action, so by default we refuse while live.

DESTRUCTIVE: drops and recreates the shared km-db database.
EOF
}

FILE=""
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) log_err "unknown flag: $1"; usage; exit 2 ;;
    *)
      if [[ -z "$FILE" ]]; then
        FILE="$1"; shift
      else
        log_err "unexpected argument: $1"; usage; exit 2
      fi
      ;;
  esac
done

if [[ -z "$FILE" ]]; then
  log_err "no dump file given"
  usage
  exit 2
fi
if [[ ! -f "$FILE" ]]; then
  log_err "no such file: $FILE"
  exit 2
fi

load_environment

: "${POSTGRES_USER:?POSTGRES_USER required (set it in the server .env)}"
: "${POSTGRES_DB:?POSTGRES_DB required (set it in the server .env)}"

if ! [[ "$POSTGRES_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  log_err "POSTGRES_USER must match [A-Za-z0-9_]+ (got: $POSTGRES_USER)"
  exit 2
fi
if ! [[ "$POSTGRES_DB" =~ ^[A-Za-z0-9_]+$ ]]; then
  log_err "POSTGRES_DB must match [A-Za-z0-9_]+ (got: $POSTGRES_DB)"
  exit 2
fi

BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"

# --- Path-traversal guard (mirrors db/scripts/restore.sh) --------------------
# Resolve the dump's absolute path and require it to live under the backup
# root. km-db mounts km_backups at /backups, so we translate the host path to
# its in-container path and let pg_restore open it directly (seekable file =>
# parallel restore, no stdio truncation on large dumps; `../` can't escape).
if [[ ! -d "$BACKUP_DIR" ]]; then
  log_err "backup dir does not exist: $BACKUP_DIR"
  exit 2
fi
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd)"
FILE_ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"

case "$FILE_ABS" in
  "$BACKUP_DIR_ABS"/*)
    REL="${FILE_ABS#"$BACKUP_DIR_ABS"/}"
    IN_CONTAINER_PATH="/backups/$REL"
    ;;
  *)
    log_err "dump file must live under \$BACKUP_DIR ($BACKUP_DIR_ABS) so it is"
    log_err "visible inside $DB_CONTAINER at /backups. Copy it there first:"
    log_err "  cp \"$FILE\" \"$BACKUP_DIR_ABS/\""
    exit 2
    ;;
esac

# Defense in depth: reject a resolved relative path that still contains a
# traversal component (symlink games, weird basenames). The case above already
# anchors to the prefix; this is belt-and-suspenders.
if [[ "$REL" == *".."* ]]; then
  log_err "refusing dump path containing '..': $REL"
  exit 2
fi

if ! docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" >/dev/null 2>&1; then
  log_err "DB container '$DB_CONTAINER' is not running — cannot restore"
  exit 1
fi

# --- Active-color gate -------------------------------------------------------
# The shared DB backs whichever color is live. Restoring wipes it, so unless
# the operator passed --force we refuse while a color is serving. We treat
# "can't determine active color" as "assume serving" — fail safe.
ACTIVE_COLOR="$(get_active_environment 2>/dev/null || echo 'unknown')"
if [[ "$FORCE" -ne 1 ]]; then
  log_err "active color is '$ACTIVE_COLOR' and is serving the shared DB."
  log_err "A restore wipes and recreates $POSTGRES_DB — both colors lose data."
  log_err "Re-run with --force once you have accepted the blast radius"
  log_err "(e.g. taken the LB down or during a planned recovery window)."
  exit 1
fi

# --- Format gate (before destroying anything) --------------------------------
log_info "db-restore: validating dump format ($IN_CONTAINER_PATH)"
if ! docker exec "$DB_CONTAINER" pg_restore --list "$IN_CONTAINER_PATH" >/dev/null 2>&1; then
  log_err "$FILE is not a valid custom-format pg_restore dump"
  exit 2
fi

# --- Drop + recreate ---------------------------------------------------------
log_warn "db-restore: DROPPING and recreating $POSTGRES_DB on $DB_CONTAINER (active color: $ACTIVE_COLOR, --force=$FORCE)"
docker exec -i "$DB_CONTAINER" \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS $POSTGRES_DB;
CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER;
SQL

# --- Restore -----------------------------------------------------------------
# --exit-on-error so a partial restore surfaces as a failure instead of a
# silently half-loaded schema. --no-owner/--no-privileges mirrors the dump.
log_info "db-restore: restoring $IN_CONTAINER_PATH into $POSTGRES_DB"
docker exec "$DB_CONTAINER" \
  pg_restore \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    --exit-on-error \
    --no-owner --no-privileges \
    "$IN_CONTAINER_PATH"

# Post-restore schema reconciliation (P-SF3). A restored dump can be at a LOWER
# schema version than the deployed code expects, which fails at runtime. Sequence
# the operator explicitly: check status, migrate up if behind, restart.
log_info "db-restore: restore complete."
log_info "db-restore: NEXT STEPS — reconcile the restored schema with the deployed code:"
log_info "  1) python3 db/migrate.py status     # is the restored DB behind the code?"
log_info "  2) python3 db/migrate.py up         # if behind, apply pending (expand/contract) migrations"
log_info "  3) restart the active color so the app reconnects:"
log_info "       Deploy/rebuild-environment.sh   # or compose_color <active> up -d --force-recreate"
