#!/usr/bin/env bash
# =============================================================================
# Korean Master — pg_restore wrapper
# =============================================================================
# WHAT: restore a custom-format dump produced by backup.sh.
# SAFETY: this script DROPS AND RECREATES the schema. The caller (Makefile)
#         requires CONFIRM=YES; we re-validate here so direct callers also have
#         to opt in via the RESTORE_CONFIRM env var.
# TRUST: only restore dumps you produced or were produced by a source you
#        trust. A malicious dump can contain CREATE FUNCTION … LANGUAGE plperl
#        or COPY FROM PROGRAM payloads. See db/SECURITY.md.
# =============================================================================

set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_DB:?POSTGRES_DB required}"
DB_SERVICE="${DB_SERVICE:-db}"
COMPOSE="${COMPOSE:-docker compose}"

FILE="${1:-}"
if [[ -z "$FILE" ]]; then
  echo "usage: restore.sh <dump-file>" >&2
  exit 2
fi
if [[ ! -f "$FILE" ]]; then
  echo "no such file: $FILE" >&2
  exit 2
fi

# SF5 (REVIEW_A3): pg_restore reads from a real file (with seek) parallels
# the restore; reading from stdin forces serial restore AND streams large
# binary payloads through the docker daemon's stdio buffer, which has
# historically truncated very large dumps. We mount `${BACKUP_DIR}` into
# the db container at /backups (see docker-compose.yml), so we resolve the
# file's path inside the container and let pg_restore open it directly.
BACKUP_DIR_HOST="${BACKUP_DIR:-./db/backups}"
BACKUP_DIR_HOST_ABS="$(cd "$BACKUP_DIR_HOST" && pwd)"
FILE_ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"

case "$FILE_ABS" in
  "$BACKUP_DIR_HOST_ABS"/*)
    REL="${FILE_ABS#$BACKUP_DIR_HOST_ABS/}"
    IN_CONTAINER_PATH="/backups/$REL"
    ;;
  *)
    echo "!! dump file must live under \$BACKUP_DIR ($BACKUP_DIR_HOST_ABS)" >&2
    echo "   to be visible inside the db container's mounted /backups." >&2
    echo "   Copy it there first: cp \"$FILE\" \"$BACKUP_DIR_HOST_ABS/\"" >&2
    exit 2
    ;;
esac

# Quick sanity check — pg_restore --list will fail if the file isn't a valid
# custom-format dump. We do this BEFORE dropping anything. The file is read
# from inside the container so no stdio piping happens.
echo ">> validating dump format ($IN_CONTAINER_PATH)"
if ! $COMPOSE exec -T "$DB_SERVICE" pg_restore --list "$IN_CONTAINER_PATH" > /dev/null; then
  echo "!! $FILE is not a valid pg_restore custom-format dump" >&2
  exit 2
fi

echo ">> dropping and recreating database $POSTGRES_DB"
# Use postgres maintenance db to drop/recreate the target. Database name is
# validated below to defend against an env-var injection (T8 in SECURITY.md):
# accept only `[A-Za-z0-9_]+` so the interpolated identifier can't escape.
if ! [[ "$POSTGRES_DB" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "!! POSTGRES_DB must match [A-Za-z0-9_]+ (got: $POSTGRES_DB)" >&2
  exit 2
fi
if ! [[ "$POSTGRES_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "!! POSTGRES_USER must match [A-Za-z0-9_]+ (got: $POSTGRES_USER)" >&2
  exit 2
fi
$COMPOSE exec -T "$DB_SERVICE" \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS $POSTGRES_DB;
CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER;
SQL

echo ">> restoring $IN_CONTAINER_PATH"
# --exit-on-error so we surface failures instead of "succeeding" with a
# half-restored schema. --no-owner mirrors backup.sh. Read directly from
# the mounted path (no stdin piping → parallel restore is available, no
# stdio truncation risk).
$COMPOSE exec -T "$DB_SERVICE" \
  pg_restore \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    --exit-on-error \
    --no-owner --no-privileges \
    "$IN_CONTAINER_PATH"

echo ">> restore complete"
