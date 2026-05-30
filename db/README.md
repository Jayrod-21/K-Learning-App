# Korean Master — database harness

The Postgres service, its migration runner, backup/restore tooling, and tests.

This README documents the **harness**. The migrations themselves
(`001_core_schema`, `002_darakwon_corpora`, …) are owned by separate agents
and tested separately.

---

## Quick start

```bash
# from Repository/
cp db/.env.example db/.env       # then edit the password
make db-up                       # start Postgres, wait for healthy
make db-migrate                  # apply all migrations
make db-migrate-status           # see what's applied
```

That's it. The Makefile is the only interface you should need.

---

## What's in here

```
db/
├── migrate.py              # Python migration runner (idempotent, transactional, checksummed)
├── migrations/             # NNN_<name>.{up,down}.sql — written by A1 / A2 / …
├── scripts/
│   ├── backup.sh           # pg_dump custom format → BACKUP_DIR
│   └── restore.sh          # pg_restore + DROP/CREATE database
├── tests/
│   └── test_migrations.py  # testcontainers-backed integration suite
├── docs/
│   ├── ADR-001-database-choices.md             # (foundation — pre-existing)
│   ├── ADR-002-auth-and-sessions.md            # (A1 — schema)
│   ├── ADR-003-fsrs-storage.md                 # (A1 — schema)
│   ├── ADR-004-soft-fk-to-corpus.md            # (A1 — schema)
│   ├── ADR-005-stable-cols-vs-jsonb.md         # (A2 — schema)
│   ├── ADR-006-tsvector-language-config.md     # (A2 — schema)
│   ├── ADR-007-vocab-relations-hybrid-target.md# (A2 — schema)
│   ├── ADR-008-kgiu-vs-grammar-entries.md      # (A2 — schema)
│   ├── ADR-009-compose-layout.md               # (A3 — harness)
│   ├── ADR-010-migration-runner-choice.md      # (A3 — harness)
│   ├── ADR-011-backup-strategy.md              # (A3 — harness)
│   ├── ADR-012-postgres-version-pin.md         # (A3 — harness)
│   ├── ADR-013-migration-tx-ownership.md       # (fix-pass — runner owns tx)
│   └── README.md                               # ADR numbering policy
├── .env.example
├── README.md               # this file
└── SECURITY.md             # threat model
```

---

## Makefile targets

| Target | What it does |
|---|---|
| `make db-up` | Start the `db` service, wait until `pg_isready` succeeds. |
| `make db-down` | Stop the container. **Volume preserved.** |
| `make db-reset CONFIRM=YES` | Wipe the volume and restart. **DESTRUCTIVE.** |
| `make db-migrate` | Apply all pending `*.up.sql` migrations. |
| `make db-migrate-status` | Show applied vs pending. |
| `make db-migrate-dry-run` | Print the plan without writing. |
| `make db-rollback CONFIRM=YES` | Roll back the most recent migration. |
| `make db-backup` | `pg_dump -Fc` to `$BACKUP_DIR/korean_master-<UTC>.dump`. |
| `make db-restore FILE=… CONFIRM=YES` | DROP + recreate DB, restore from file. |
| `make db-test` | Run the integration suite (spins a throwaway Postgres). |
| `make db-shell` | Open `psql` in the running container. |
| `make db-lint` | `sqlfluff lint db/migrations` against the Postgres dialect. |

---

## How the migration runner works

`db/migrate.py` is ~350 lines of Python with three responsibilities:

1. **Discovery.** Find `NNN_<name>.up.sql` / `.down.sql` pairs and order by
   version. Missing one half → error before anything runs.
2. **State.** Read `schema_migrations` to know what's been applied. Each row
   stores `version`, `name`, `checksum` (SHA-256 of the up SQL), `applied_at`,
   `applied_by`, `duration_ms`.
3. **Apply / rollback.** Each migration runs inside a single transaction with
   the bookkeeping write — partial application is impossible. Checksum
   mismatches refuse to run (someone edited an applied migration).

```bash
python db/migrate.py up                                # apply all pending
python db/migrate.py up --target 003                   # apply through 003
python db/migrate.py up --dry-run                      # show plan
python db/migrate.py status                            # what's applied
python db/migrate.py --allow-destructive down          # roll back 1
python db/migrate.py --allow-destructive down --target 002  # roll back to 002
```

### Destructive-statement guard

Migrations whose SQL (comments stripped) contains `DROP TABLE`, `DROP SCHEMA`,
`DROP TYPE`, `DROP INDEX`, `TRUNCATE`, or `DROP DATABASE` require
`--allow-destructive`. This is paired-keystroke insurance against rolling out
an irreversible change without meaning to.

### Why not Alembic / Sqitch / Flyway?

See `docs/ADR-010-migration-runner-choice.md`. Short version: we own raw SQL on
purpose (ADR-001 §D11), Alembic presumes SQLAlchemy models, Sqitch is Perl,
Flyway pulls a JVM. ~350 lines of audited Python is cheaper than any of those.

---

## How to test this

### One-shot

```bash
make db-test
```

The test suite spins up a real Postgres 16 container via `testcontainers-python`
(NOT SQLite — that's banned by SENIOR_ENGINEER_BAR §2.testing), writes synthetic
migrations into a tmp dir, and exercises:

- Discovery / ordering / missing-pair detection
- Destructive-content detection (and that SQL comments are stripped first)
- Full up → down → up lifecycle, asserting tables come and go
- Checksum mismatch detection when a migration file is edited post-apply
- `--dry-run` makes no changes
- A failing migration leaves zero residue

### Prereqs

```bash
pip install psycopg[binary] structlog pytest testcontainers[postgres] sqlfluff
```

Docker must be runnable by the current user (testcontainers needs to launch
containers).

---

## Backups

`make db-backup` runs `pg_dump -Fc -Z 6` inside the container, writes a
timestamped file to `$BACKUP_DIR` (default `./db/backups`), then prunes files
older than `$BACKUP_RETENTION_DAYS` (default 14).

The directory is created with mode `0700` and files written with `0600` — dumps
contain everything, treat them like passwords. See `SECURITY.md`.

### Cadence

Schedule from cron / systemd on dad's box:

```cron
0 4 * * * cd /opt/korean-master && make db-backup >> /var/log/korean-master/backup.log 2>&1
```

### Restore

```bash
make db-restore FILE=db/backups/korean_master-20260528T040000Z.dump CONFIRM=YES
```

`restore.sh` validates the dump format BEFORE dropping anything, terminates
existing connections, drops + recreates the database, then runs `pg_restore
--exit-on-error`. A half-restored DB is impossible.

**Do not restore dumps you didn't produce.** See `SECURITY.md` §"Restore from
untrusted dump".

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `make db-up` hangs at "waiting for db" | First boot — Postgres is running `initdb` | Wait 10–20s, retry; `docker compose logs db` to confirm |
| `migrate.py` exits 3 (connect.failed) | `DATABASE_URL` wrong or DB not up | `make db-up`, check `db/.env` |
| `ChecksumMismatch` on `db-migrate` | Someone edited an already-applied migration file | Revert the file, OR write a new migration that fixes the schema forward |
| `DestructiveBlocked` | Migration has `DROP TABLE` etc. | Confirm the intent, re-run with `--allow-destructive` |
| `db-test` fails with `Docker not available` | testcontainers can't reach Docker | Ensure the daemon is running and your user is in the `docker` group |
| `permission denied: db/scripts/backup.sh` | Scripts not executable on a fresh checkout | `chmod +x db/scripts/*.sh` (the Makefile invokes them via `bash`, so this is cosmetic) |
| Port `5432` already in use | Local Postgres / Supabase CLI / pgAdmin | Set `POSTGRES_HOST_PORT=5433` in `db/.env` |

### Resetting from scratch

```bash
make db-reset CONFIRM=YES
make db-migrate
```

---

## Hosting context

This stack runs on dad's home Ubuntu+Docker server, reached from the internet
via a Cloudflare Tunnel that terminates at the `server` (Express) container —
**never at the DB**. The compose file binds Postgres to `127.0.0.1` on the host
specifically so a misconfigured firewall doesn't expose it. See DESIGN_SPEC.md
for the broader hosting picture.
