#!/usr/bin/env bash
# =============================================================================
# Korean Master — pg_dump wrapper
# =============================================================================
# WHAT: pg_dump in custom format (`-Fc`, compressed, restorable per-table)
#       writes to $BACKUP_DIR/korean_master-<utc-timestamp>.dump.
# WHY:  Custom format gives us `pg_restore --list` introspection and per-table
#       restore. Plain SQL dumps balloon and are slow to restore at our scale.
# RETENTION: files older than $BACKUP_RETENTION_DAYS are pruned. Defaults to
#       14 days. The retention pass runs AFTER the new backup writes, so a
#       failed backup never deletes the previous good one.
# =============================================================================

set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_DB:?POSTGRES_DB required}"
BACKUP_DIR="${BACKUP_DIR:-./db/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DB_SERVICE="${DB_SERVICE:-db}"
COMPOSE="${COMPOSE:-docker compose}"

# 0700 because dumps contain everything — schema, data, and (depending on
# extension state) sometimes credentials. Owner-only access on the host FS.
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/korean_master-$TS.dump"

echo ">> dumping $POSTGRES_DB to $OUT"
# pg_dump runs INSIDE the container so we don't have to install postgres-client
# on the host. -Fc = custom format. -Z 6 = moderate compression.
# --no-owner / --no-privileges keeps the dump portable across PG users.
$COMPOSE exec -T "$DB_SERVICE" \
  pg_dump \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -Fc -Z 6 \
    --no-owner --no-privileges \
  > "$OUT.partial"

# Atomic rename — half-written files never appear as a "good" backup.
mv "$OUT.partial" "$OUT"
chmod 0600 "$OUT"
echo ">> wrote $(du -h "$OUT" | cut -f1) — $OUT"

# Retention. Use -mtime +N — files modified more than N days ago.
# N6 (REVIEW_A3): emit a structured ">> pruned: <file>" line per file so the
# operational log (single line per cron run) is greppable. `find -print
# -delete` would print to stdout but without our prefix.
echo ">> pruning dumps older than $RETENTION_DAYS days"
PRUNED=0
while IFS= read -r -d '' f; do
  echo ">> pruned: $f"
  rm -f -- "$f" || true
  PRUNED=$((PRUNED + 1))
done < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'korean_master-*.dump' \
    -mtime "+$RETENTION_DAYS" -print0 2>/dev/null || true
)
echo ">> pruned $PRUNED file(s)"

echo ">> done"
