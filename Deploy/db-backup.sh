#!/usr/bin/env bash
# =============================================================================
# Korean Master — production DB backup (blue/green-aware wrapper)
# =============================================================================
# WHAT: pg_dump the ONE shared `km-db` database in custom format
#       (`-Fc -Z 6 --no-owner --no-privileges`) to a timestamped file under
#       $BACKUP_DIR, prune by retention, and optionally copy off-site.
#
# WHY a separate script from db/scripts/backup.sh:
#   * db/scripts/backup.sh is the LOCAL-DEV wrapper (talks to the `db` compose
#     service via `docker compose exec`, 14-day default retention).
#   * THIS script is the PRODUCTION wrapper: it talks to the named container
#     `km-db` directly (the shared Postgres both colors point to), reads its
#     config from the persistent server `.env` via deployment-utils.sh, and
#     defaults to the 90-day retention the deploy plan mandates. The dump
#     format and flags are deliberately identical so a dev dump and a prod
#     dump are interchangeable for `pg_restore`.
#
# SHARED-DB NOTE: blue/green share one database, so there is exactly one DB to
#   back up regardless of which color is live. We still record the active color
#   in backup-info.txt for forensic context (which code was serving traffic
#   when the snapshot was taken).
#
# SAFETY:
#   * Dump files are chmod 0600 — they contain the full dataset.
#   * The retention prune runs AFTER the new dump is durable, so a failed
#     backup can never delete the last good one.
#   * Atomic write: dump to `.partial`, rename into place. A half-written file
#     never appears as a valid backup.
#   * Secrets are never echoed. POSTGRES_PASSWORD reaches pg_dump via the
#     container's own environment (it already has it); we never pass it on a
#     command line or print it.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=Deploy/deployment-utils.sh
source "$SCRIPT_DIR/deployment-utils.sh"

# ERR trap: surface the failing command + line, then exit non-zero so callers
# (the deploy scripts, the km-backup loop, cron) can react. `log_err` is a
# deployment-utils helper that never prints secrets.
trap 'log_err "db-backup.sh failed at line $LINENO (exit $?)"' ERR

DB_CONTAINER="${DB_CONTAINER:-km-db}"

# How this script reaches Postgres to run pg_dump:
#   exec   (default) — HOST context: `docker exec km-db pg_dump`. The host has no
#                      postgres-client installed, so we borrow km-db's pg_dump and
#                      the password never leaves the container. Used by the
#                      pre-deploy backup in azure-deploy-inactive.sh.
#   direct           — IN-CONTAINER context (the km-backup sidecar): connect over
#                      the network with `pg_dump -h $PGHOST`. The sidecar IS a
#                      postgres image on km-internal with the creds injected, so
#                      it needs neither the Docker socket nor a docker CLI. This is
#                      the model the reference deployment uses. The sidecar sets
#                      BACKUP_DB_ACCESS=direct in docker-compose.shared.yml.
BACKUP_DB_ACCESS="${BACKUP_DB_ACCESS:-exec}"

usage() {
  cat >&2 <<'EOF'
Usage: db-backup.sh [--dir DIR]

  --dir DIR   Override the backup target directory (default: $BACKUP_DIR
              from the server .env, falling back to ./backups).

Produces:
  <dir>/km-<UTCstamp>.dump   custom-format pg_dump of the shared km-db (0600)
  <dir>/backup-info.txt      metadata for the most recent backup

Reads from the persistent server .env (via deployment-utils.sh):
  POSTGRES_USER, POSTGRES_DB          required — which DB to dump
  BACKUP_DIR                          default target dir
  BACKUP_RETENTION_DAYS  (default 90) prune dumps older than this
  BACKUP_OFFSITE_DIR     (optional)   copy each dump here too; empty = skip
EOF
}

DIR_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ $# -ge 2 ]] || { log_err "--dir requires an argument"; usage; exit 2; }
      DIR_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_err "unexpected argument: $1"
      usage
      exit 2
      ;;
  esac
done

# Config source: on the HOST the persistent server .env is the source of truth;
# inside the km-backup sidecar there is NO .env (config is injected via the
# compose environment), so load it only when present. db-backup.sh then validates
# the specific values it needs below — regardless of which path supplied them.
load_environment_optional

# Reconcile the two credential namespaces. The host .env uses POSTGRES_*; the
# sidecar's compose environment uses libpq's PG* names. Accept either so the same
# script serves both contexts.
POSTGRES_USER="${POSTGRES_USER:-${PGUSER:-}}"
POSTGRES_DB="${POSTGRES_DB:-${PGDATABASE:-}}"
PGHOST="${PGHOST:-$DB_CONTAINER}"

: "${POSTGRES_USER:?POSTGRES_USER (or PGUSER) required — set it in the server .env or the km-backup environment}"
: "${POSTGRES_DB:?POSTGRES_DB (or PGDATABASE) required — set it in the server .env or the km-backup environment}"

# Identifier hardening (mirrors db/scripts/restore.sh): these values are
# interpolated into a docker exec argument list. Reject anything that isn't a
# plain Postgres identifier so a tampered .env can't smuggle extra flags.
if ! [[ "$POSTGRES_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  log_err "POSTGRES_USER must match [A-Za-z0-9_]+ (got: $POSTGRES_USER)"
  exit 2
fi
if ! [[ "$POSTGRES_DB" =~ ^[A-Za-z0-9_]+$ ]]; then
  log_err "POSTGRES_DB must match [A-Za-z0-9_]+ (got: $POSTGRES_DB)"
  exit 2
fi

BACKUP_DIR="${DIR_OVERRIDE:-${BACKUP_DIR:-$SCRIPT_DIR/backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-90}"
OFFSITE_DIR="${BACKUP_OFFSITE_DIR:-}"

# NAS safety net. When backups target a network (NFS) mount, a silent fallback to
# local disk — because the share happens to be unmounted — is a classic data-loss
# trap: dumps appear to succeed but aren't on the NAS. With BACKUP_REQUIRE_MOUNT
# =true we refuse to run unless BACKUP_DIR is a real mountpoint. Checked only in
# `exec` mode: that runs on the HOST, where BACKUP_DIR IS the NFS mount. In the
# sidecar BACKUP_DIR is the in-container /backups bind, whose mount state can't
# reflect the host NFS, so the check there would be meaningless.
if [[ "$BACKUP_DB_ACCESS" == "exec" && "${BACKUP_REQUIRE_MOUNT:-false}" == "true" ]]; then
  if ! mountpoint -q -- "$BACKUP_DIR"; then
    log_err "BACKUP_REQUIRE_MOUNT=true but '$BACKUP_DIR' is not a mountpoint — NFS share not mounted? Refusing to back up to local disk."
    exit 1
  fi
fi

# 0700 dir, 0600 files — dumps are the full dataset. On a local FS we own the dir
# and can lock it down; on an NFS export the server controls the mode, so a failed
# chmod on the mount root is a warning, not a hard error (per-dump files are still
# created 0600 below, which we DO own).
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR" 2>/dev/null \
  || log_warn "could not chmod 0700 '$BACKUP_DIR' (network mount?); relying on the share's own permissions"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/km-$TS.dump"

# Active color is informational only (shared DB). Don't let a failure to read
# it abort the backup — that would be backwards.
ACTIVE_COLOR="$(get_active_environment 2>/dev/null || echo 'unknown')"

log_info "db-backup: dumping shared $POSTGRES_DB from $DB_CONTAINER -> $OUT (active color: $ACTIVE_COLOR)"

# Dump flags are identical in both modes so a host dump and a sidecar dump are
# interchangeable for pg_restore: -Fc = custom format (introspectable via
# pg_restore --list, per-table restore); -Z 6 = moderate compression;
# --no-owner/--no-privileges keeps the dump portable across roles.
if [[ "$BACKUP_DB_ACCESS" == "direct" ]]; then
  # IN-CONTAINER: connect to the shared km-db over the network. PGPASSWORD is
  # supplied by the compose environment (never echoed). Verify reachability
  # before creating a 0-byte partial.
  : "${PGPASSWORD:?PGPASSWORD required in direct mode (set it in the km-backup environment)}"
  if ! pg_isready -h "$PGHOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    log_err "shared DB not reachable at '$PGHOST' — cannot back up"
    exit 1
  fi
  pg_dump \
    -h "$PGHOST" \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -Fc -Z 6 \
    --no-owner --no-privileges \
  > "$OUT.partial"
else
  # HOST: pg_dump runs INSIDE km-db (no postgres-client on the host; the password
  # never leaves the container). Verify the container is up first.
  if ! docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" >/dev/null 2>&1; then
    log_err "DB container '$DB_CONTAINER' is not running — cannot back up"
    exit 1
  fi
  docker exec "$DB_CONTAINER" \
    pg_dump \
      -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" \
      -Fc -Z 6 \
      --no-owner --no-privileges \
  > "$OUT.partial"
fi

# Atomic publish: rename only after the dump completed without error.
mv "$OUT.partial" "$OUT"
chmod 0600 "$OUT"

DUMP_SIZE="$(du -h "$OUT" | cut -f1)"
log_info "db-backup: wrote $DUMP_SIZE -> $OUT"

# Backup metadata (P-SF6). We write TWO files via _write_info:
#   1. A PER-DUMP sidecar "<dump>.info" that lives and dies WITH its dump, so the
#      metadata for ANY retained backup is always available (the README restore
#      drill points operators at specific older dumps). Pruned with its dump below.
#   2. backup-info.txt — a "last backup" convenience breadcrumb, overwritten each
#      run. Both written atomically (temp + mv) so a reader never sees a partial.
_write_info() {
  local dest="$1"
  cat > "$dest.partial" <<EOF
Korean Master — backup metadata
================================
UTC timestamp : $TS
Active color  : $ACTIVE_COLOR
DB container  : $DB_CONTAINER
Database      : $POSTGRES_DB
Dump file     : $OUT
Dump size     : $DUMP_SIZE
Retention     : ${RETENTION_DAYS}d
Offsite       : ${OFFSITE_DIR:-<none — pending Q-BACKUP>}
EOF
  mv "$dest.partial" "$dest"
  chmod 0600 "$dest"
}
_write_info "$OUT.info"
_write_info "$BACKUP_DIR/backup-info.txt"

# Off-site copy (optional). If BACKUP_OFFSITE_DIR is set we mirror the dump
# there; otherwise we log that it's intentionally skipped. NOTE: off-site
# encryption is pending dad's Q-BACKUP — see SECURITY.md. The destination is
# assumed already-encrypted-at-rest (e.g. an encrypted external volume / rclone
# crypt remote) until that question is answered.
if [[ -n "$OFFSITE_DIR" ]]; then
  mkdir -p "$OFFSITE_DIR"
  chmod 0700 "$OFFSITE_DIR" 2>/dev/null || true
  cp -p "$OUT" "$OFFSITE_DIR/"
  chmod 0600 "$OFFSITE_DIR/$(basename "$OUT")" 2>/dev/null || true
  log_info "db-backup: copied off-site -> $OFFSITE_DIR/$(basename "$OUT")"
else
  log_info "db-backup: offsite skipped — pending Q-BACKUP (BACKUP_OFFSITE_DIR unset)"
fi

# Retention prune — AFTER the new dump is durable. -mtime +N = older than N
# days. We prune local dumps only; off-site retention is the off-site system's
# job (and we don't want to silently delete the last remote copy). Each dump's
# per-dump .info sidecar (P-SF6) is pruned together with it so metadata never
# orphans or outlives the backup it describes.
log_info "db-backup: pruning local dumps older than ${RETENTION_DAYS}d in $BACKUP_DIR"
PRUNED=0
while IFS= read -r -d '' f; do
  log_info "db-backup: pruned $f"
  rm -f -- "$f" || true
  rm -f -- "$f.info" || true
  PRUNED=$((PRUNED + 1))
done < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'km-*.dump' \
    -mtime "+$RETENTION_DAYS" -print0 2>/dev/null || true
)
log_info "db-backup: pruned $PRUNED file(s)"

log_info "db-backup: done"
