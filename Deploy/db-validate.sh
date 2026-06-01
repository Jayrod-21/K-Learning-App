#!/usr/bin/env bash
# =============================================================================
# Korean Master — backup-integrity validator
# =============================================================================
# WHAT: prove a custom-format dump is restorable AND faithful, WITHOUT touching
#       the live database. We restore the dump into a throwaway scratch DB on
#       km-db, then compare it to the live DB:
#         * table count (public schema), and
#         * per-table row count.
#       Drift is reported per-table; the scratch DB is always dropped.
#
# WHY: "the dump file exists" is not "the dump is good". A truncated or
#       corrupted dump still has bytes. This restores it for real and counts
#       rows so we know the backup would actually recover us. Run it from the
#       km-backup loop (or on demand) as the backup-integrity gate.
#
# NON-DESTRUCTIVE to the live DB: we only CREATE/DROP a uniquely-named scratch
#       database (km_validate_<utc>_<pid>). We never write to $POSTGRES_DB.
#
# DRIFT IS EXPECTED in some cases and NOT inherently an error: if writes landed
#       between the dump and "now", the live DB legitimately has more rows. The
#       script reports drift and exits 1 so a human can judge; the *structural*
#       check (the dump restores at all, table set matches) is the hard gate
#       and exits 2.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=Deploy/deployment-utils.sh
source "$SCRIPT_DIR/deployment-utils.sh"

DB_CONTAINER="${DB_CONTAINER:-km-db}"
SCRATCH_DB=""   # set once we know we created it, so cleanup can drop it

usage() {
  cat >&2 <<'EOF'
Usage: db-validate.sh <dump-file>

  <dump-file>   Custom-format dump to validate. MUST live under $BACKUP_DIR
                (visible inside km-db at /backups).

Restores the dump into a throwaway scratch DB on km-db, compares table count
and per-table row counts against the live DB, reports drift, then drops the
scratch DB. Does NOT modify the live database.

Exit codes:
  0  dump restores AND matches the live DB exactly
  1  dump restores but counts drift from live (review needed)
  2  dump is unusable (bad path, bad format, restore failed) — HARD failure
EOF
}

# Cleanup always drops the scratch DB, even on error/interrupt. `|| true` so a
# cleanup hiccup never masks the real status.
cleanup() {
  if [[ -n "$SCRATCH_DB" ]]; then
    docker exec "$DB_CONTAINER" dropdb -U "$POSTGRES_USER" --if-exists "$SCRATCH_DB" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'log_err "db-validate.sh failed at line $LINENO (exit $?)"' ERR

FILE="${1:-}"
case "$FILE" in
  -h|--help) usage; exit 0 ;;
  "") log_err "no dump file given"; usage; exit 2 ;;
esac
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

# Path-traversal guard + in-container path translation (same as db-restore.sh).
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
    log_err "visible inside $DB_CONTAINER at /backups."
    exit 2
    ;;
esac
if [[ "$REL" == *".."* ]]; then
  log_err "refusing dump path containing '..': $REL"
  exit 2
fi

if ! docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" >/dev/null 2>&1; then
  log_err "DB container '$DB_CONTAINER' is not running — cannot validate"
  exit 2
fi

# Format gate before doing any work.
log_info "db-validate: checking dump format ($IN_CONTAINER_PATH)"
if ! docker exec "$DB_CONTAINER" pg_restore --list "$IN_CONTAINER_PATH" >/dev/null 2>&1; then
  log_err "$FILE is not a valid custom-format pg_restore dump"
  exit 2
fi

# --- Create the scratch DB ---------------------------------------------------
# Unique name: timestamp + pid so concurrent validations never collide. The
# name is built from numeric/lowercase parts only, so it's a safe identifier.
SCRATCH_DB="km_validate_$(date -u +%Y%m%d%H%M%S)_$$"
log_info "db-validate: creating scratch DB $SCRATCH_DB"
docker exec "$DB_CONTAINER" dropdb -U "$POSTGRES_USER" --if-exists "$SCRATCH_DB" >/dev/null 2>&1 || true
docker exec "$DB_CONTAINER" createdb -U "$POSTGRES_USER" "$SCRATCH_DB" >/dev/null

# --- Restore the dump into the scratch DB ------------------------------------
log_info "db-validate: restoring dump into $SCRATCH_DB"
if ! docker exec "$DB_CONTAINER" \
      pg_restore -U "$POSTGRES_USER" -d "$SCRATCH_DB" \
        --exit-on-error --no-owner --no-privileges \
        "$IN_CONTAINER_PATH" >/dev/null 2>&1; then
  log_err "dump failed to restore into a clean scratch DB — backup is UNUSABLE"
  exit 2
fi

# Helper: run a single psql query against a DB inside km-db, return trimmed
# scalar output. -t = tuples only, -A = unaligned (no padding/whitespace).
psql_scalar() {
  local db="$1" sql="$2"
  docker exec "$DB_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$db" -t -A -v ON_ERROR_STOP=1 -c "$sql"
}

LIST_TABLES_SQL="SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;"

# --- Compare table counts ----------------------------------------------------
# P-SF4: capture psql output to a var and check ITS exit status BEFORE reading into
# the array. `mapfile < <(psql …)` cannot observe a psql failure (the process-
# substitution exit status is invisible to mapfile even under `set -e`), so a
# transient psql error would otherwise yield an empty array and be misreported as a
# structural "table set mismatch" (exit 2) instead of a tooling error (exit 3).
LIVE_TABLES_RAW=""; DUMP_TABLES_RAW=""
if ! LIVE_TABLES_RAW="$(psql_scalar "$POSTGRES_DB" "$LIST_TABLES_SQL")"; then
  log_err "db-validate: failed to list tables on live DB $POSTGRES_DB (psql/tooling error, not a dump problem)"
  exit 3
fi
if ! DUMP_TABLES_RAW="$(psql_scalar "$SCRATCH_DB" "$LIST_TABLES_SQL")"; then
  log_err "db-validate: failed to list tables on scratch DB $SCRATCH_DB (psql/tooling error, not a dump problem)"
  exit 3
fi
mapfile -t LIVE_TABLES <<< "$LIVE_TABLES_RAW"
mapfile -t DUMP_TABLES <<< "$DUMP_TABLES_RAW"
# `mapfile <<<` on an empty string yields one empty element — normalize to 0.
[[ "${LIVE_TABLES[*]}" == "" ]] && LIVE_TABLES=()
[[ "${DUMP_TABLES[*]}" == "" ]] && DUMP_TABLES=()
LIVE_TABLE_COUNT="${#LIVE_TABLES[@]}"
DUMP_TABLE_COUNT="${#DUMP_TABLES[@]}"

log_info "db-validate: live tables=$LIVE_TABLE_COUNT  dump tables=$DUMP_TABLE_COUNT"

STRUCTURAL_FAIL=0
DRIFT=0

if [[ "$LIVE_TABLE_COUNT" -ne "$DUMP_TABLE_COUNT" ]]; then
  log_warn "db-validate: TABLE COUNT MISMATCH (live=$LIVE_TABLE_COUNT dump=$DUMP_TABLE_COUNT)"
  # A table-set difference is structural, not benign row drift.
  STRUCTURAL_FAIL=1
fi

# Build membership sets so we can report tables present on one side only.
declare -A IN_DUMP=()
for t in "${DUMP_TABLES[@]}"; do [[ -n "$t" ]] && IN_DUMP["$t"]=1; done
declare -A IN_LIVE=()
for t in "${LIVE_TABLES[@]}"; do [[ -n "$t" ]] && IN_LIVE["$t"]=1; done
for t in "${LIVE_TABLES[@]}"; do
  [[ -z "$t" ]] && continue
  if [[ -z "${IN_DUMP[$t]:-}" ]]; then
    log_warn "db-validate:   table in LIVE but missing from dump: $t"
    STRUCTURAL_FAIL=1
  fi
done
for t in "${DUMP_TABLES[@]}"; do
  [[ -z "$t" ]] && continue
  if [[ -z "${IN_LIVE[$t]:-}" ]]; then
    log_warn "db-validate:   table in dump but missing from LIVE: $t"
    STRUCTURAL_FAIL=1
  fi
done

# --- Compare per-table row counts (only for tables present in both) ----------
for t in "${LIVE_TABLES[@]}"; do
  [[ -z "$t" ]] && continue
  [[ -z "${IN_DUMP[$t]:-}" ]] && continue
  # Identifier comes straight from pg_tables, so it's a real table name; quote
  # it for safety against mixed-case / reserved names.
  live_n="$(psql_scalar "$POSTGRES_DB" "SELECT count(*) FROM \"$t\";")"
  dump_n="$(psql_scalar "$SCRATCH_DB"   "SELECT count(*) FROM \"$t\";")"
  if [[ "$live_n" == "$dump_n" ]]; then
    log_info "db-validate:   ok    $t ($live_n rows)"
  else
    log_warn "db-validate:   DRIFT $t (live=$live_n dump=$dump_n)"
    DRIFT=1
  fi
done

# --- Verdict -----------------------------------------------------------------
if [[ "$STRUCTURAL_FAIL" -eq 1 ]]; then
  log_err "db-validate: STRUCTURAL mismatch — the dump's table set differs from live. Treat as a bad backup."
  exit 2
fi
if [[ "$DRIFT" -eq 1 ]]; then
  log_warn "db-validate: dump restores and the schema matches, but row counts drift from live."
  log_warn "db-validate: this is EXPECTED if writes happened after the dump was taken — review the drift above."
  exit 1
fi
log_info "db-validate: PASS — dump restores cleanly and matches the live DB exactly."
exit 0
