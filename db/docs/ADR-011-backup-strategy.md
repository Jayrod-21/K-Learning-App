# ADR-011: Backup strategy — pg_dump custom format, host-local, 14-day retention

**Status:** Accepted (initial; revisit when domain content / Claude
enrichment data accumulates value beyond replaceable corpora)
**Date:** 2026-05-28

## Context

The DB holds:

1. **Reference corpora** (TTMIK, Iyagi, TOPIK item pool, KRDICT, vocab lists)
   — large, but reconstructible from source files in the parent folders.
2. **User-generated state** (Jared's vocab cards, FSRS review history,
   diagnostics, banked grammar, mined sentences) — **irreplaceable**.
3. **Claude enrichment cache** — costs money to regenerate and represents
   accumulated work; replaceable but expensive.

A backup loss means hours-to-weeks of progress lost, plus Claude API spend.

## Decision

- **Tool:** `pg_dump -Fc` (custom format) via `db/scripts/backup.sh`, called
  by `make db-backup`.
- **Location:** `$BACKUP_DIR` on the host, default `./db/backups`, mode 0700.
- **Cadence:** Daily 04:00 UTC via cron on dad's box (operator runbook task,
  not a container responsibility).
- **Retention:** 14 days, enforced by `find -mtime +14 -delete` in the same
  script. The pass runs AFTER the new write so a failed backup never deletes
  the previous good one.
- **Off-host copy:** **deferred** — see Open questions.
- **Restore drill:** quarterly. Use `make db-restore FILE=…` against a
  scratch container or `db-reset` to prove the backup is good.

## Rationale

- `pg_dump -Fc` is restorable per-table, compressible, and introspectable
  with `pg_restore --list`. Plain SQL dumps are slower to restore at any
  meaningful size.
- Logical backups (vs `pg_basebackup` / streaming replication) are right for
  our scale (single-instance, no replicas, recovery time of minutes is
  acceptable).
- 14 days is a balance between blast radius if the host is compromised (T5 in
  SECURITY.md) and recovery window for a "I deleted that yesterday" mistake.
  Two weeks lets a problem surface across a normal review cycle.
- Off-host backup is the right next step but adds operational complexity
  (encryption key management, remote storage credentials). We commit to it
  before any data Jared can't afford to lose accumulates.

## Trade-offs

- **No PITR** (point-in-time recovery). To get PITR we'd need WAL archiving
  + `pg_basebackup`. Worth it once we have continuous incoming data.
- **No off-host copy yet.** A single house fire or disk loss = total data
  loss. Acceptable while content is reconstructible; not acceptable once
  user-generated state has real value.

## Open questions / next ADRs

- **ADR-???: Offsite encrypted backups.** Likely Cloudflare R2 + `age`
  encryption to a key Jared controls. Trigger when: (a) FSRS history
  exists, OR (b) Claude enrichment cache exceeds $20 to rebuild.
- **ADR-???: PITR via WAL-G.** Trigger when: continuous-arrival data
  (e.g., daily Claude grading sessions) exists and a single-day rollback
  loses meaningful work.

## Consequences

- A documented, scriptable backup that runs on a cron line.
- The operator runbook needs the cron entry (`README.md` "Backups → Cadence").
- File permissions are tight (0700 dir, 0600 file). Anyone with `BACKUP_DIR`
  read access has the database.
