#!/usr/bin/env bash
# =============================================================================
# Korean Master — km-backup container entrypoint (nightly backup loop)
# =============================================================================
# WHAT: the long-running PID 1 of the `km-backup` container. Each iteration it
#       sleeps until the next $BACKUP_TIME in $BACKUP_TZ, runs db-backup.sh
#       (which dumps the shared km-db, prunes by retention, and optionally
#       copies off-site), then loops.
#
# WHY a loop instead of host cron: the deploy stack is self-contained Docker on
#       dad's server — we don't want to depend on host crontab being installed
#       and pointed at the right script with the right env. The backup schedule
#       travels with the compose stack. The container shares the km_backups
#       volume + reads the server .env, so it has everything db-backup.sh needs.
#
# SIGNALS: traps SIGTERM/SIGINT so `docker stop` shuts the loop down cleanly
#       (no orphaned half-sleep). We sleep in the background and `wait` on it so
#       the trap fires immediately instead of after the full sleep.
#
# ROBUSTNESS: a single failed backup must NOT kill the loop — tomorrow's backup
#       should still run. We therefore DON'T `set -e`; we log a failed backup
#       and continue. set -uo pipefail still catches unset vars and pipe
#       failures everywhere else.
# =============================================================================

set -Euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=Deploy/deployment-utils.sh
source "$SCRIPT_DIR/deployment-utils.sh"

# --- Clean shutdown ----------------------------------------------------------
TERM_REQUESTED=0
SLEEP_PID=""
request_shutdown() {
  TERM_REQUESTED=1
  log_info "km-backup: shutdown signal received — exiting after current step"
  # Interrupt an in-progress sleep so we react immediately.
  if [[ -n "$SLEEP_PID" ]]; then
    kill "$SLEEP_PID" 2>/dev/null || true
  fi
}
trap request_shutdown SIGTERM SIGINT

# Interruptible sleep: sleep in the background, wait on it. When a signal
# arrives, request_shutdown kills the sleep and wait returns.
sleep_interruptible() {
  local secs="$1"
  sleep "$secs" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || true
  SLEEP_PID=""
}

# Compute seconds from now until the next HH:MM in the configured timezone.
# Uses GNU date arithmetic; if today's HH:MM already passed, target tomorrow.
# Echoes an integer >= 0. Defensive: if date math fails, fall back to 1h so we
# never busy-loop.
seconds_until_next() {
  local hhmm="$1" tz="$2"
  local now target
  now="$(TZ="$tz" date +%s)"
  target="$(TZ="$tz" date -d "today $hhmm" +%s 2>/dev/null || echo "")"
  if [[ -z "$target" ]]; then
    log_warn "km-backup: could not parse BACKUP_TIME='$hhmm' in TZ='$tz'; defaulting to a 1h interval"
    echo 3600
    return 0
  fi
  if [[ "$target" -le "$now" ]]; then
    target="$(TZ="$tz" date -d "tomorrow $hhmm" +%s)"
  fi
  echo $(( target - now ))
}

# Schedule + DB config reach this container via the compose `environment:` block
# (no .env is mounted into the sidecar). If a .env IS present (host/dev runs), pick
# it up too — but NEVER hard-fail on its absence: that is what was crash-looping
# the container. db-backup.sh applies the same tolerant rule when it runs.
load_environment_optional
BACKUP_TIME="${BACKUP_TIME:-03:00}"
BACKUP_TZ="${BACKUP_TZ:-America/Chicago}"

# Validate BACKUP_TIME up front — a typo here would otherwise silently fall
# back to hourly forever.
if ! [[ "$BACKUP_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  log_warn "km-backup: BACKUP_TIME='$BACKUP_TIME' is not HH:MM (24h); proceeding but date math may fall back to hourly"
fi

log_info "km-backup: loop started — nightly at $BACKUP_TIME ($BACKUP_TZ), retention ${BACKUP_RETENTION_DAYS:-90}d"

# Optional: run one backup immediately on container start so a freshly stood-up
# stack has a baseline backup without waiting until the first BACKUP_TIME. Gate
# it behind BACKUP_ON_START (default off) to avoid surprise dumps on restart.
if [[ "${BACKUP_ON_START:-false}" == "true" ]]; then
  log_info "km-backup: BACKUP_ON_START=true — taking an initial backup now"
  if "$SCRIPT_DIR/db-backup.sh"; then
    log_info "km-backup: initial backup ok"
  else
    log_err "km-backup: initial backup FAILED (continuing into the schedule)"
  fi
fi

while [[ "$TERM_REQUESTED" -eq 0 ]]; do
  SECS="$(seconds_until_next "$BACKUP_TIME" "$BACKUP_TZ")"
  log_info "km-backup: next backup in ${SECS}s (at $BACKUP_TIME $BACKUP_TZ)"
  sleep_interruptible "$SECS"

  # If we woke because of a shutdown signal, don't fire a backup — just exit.
  [[ "$TERM_REQUESTED" -eq 1 ]] && break

  log_info "km-backup: firing scheduled backup"
  if "$SCRIPT_DIR/db-backup.sh"; then
    log_info "km-backup: scheduled backup ok"
  else
    # A failed backup is logged but does NOT break the loop — tomorrow's run
    # must still happen. Monitoring should alert on the absence of a fresh
    # backup-info.txt / the error log line.
    log_err "km-backup: scheduled backup FAILED — will retry at the next $BACKUP_TIME"
  fi

  # Guard against a pathological same-second re-trigger (clock skew): nudge past
  # the target minute so seconds_until_next computes tomorrow, not 0.
  sleep_interruptible 61
done

log_info "km-backup: loop exited cleanly"
exit 0
