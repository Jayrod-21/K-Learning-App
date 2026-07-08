# Korean Master — Production Deployment (blue/green)

This directory is the **production deployment runbook** for Korean Master: a
blue/green Docker stack on a single self-hosted host — **the project's own
PC** — fronted by an nginx load balancer and reached from the internet through
a Cloudflare Tunnel. A deploy is **run by hand on that host** (see
[Deploy → test → switch](#deploy--test--switch-flow)): it stands up the
*inactive* color, validates it on a test port, and flips the load balancer to
it. The database is **one shared Postgres** that both colors point at, so a
switch is a pure nginx reload — no data is copied and user uploads survive
unchanged.

> **Local development** uses `docker-compose.yml` at the repo root and the
> scripts in `db/scripts/` (see [Relationship to `db/scripts/`](#relationship-to-dbscripts-local-dev)).
> Everything in *this* directory is for the **production** blue/green host.

---

## Architecture

```
                          Internet
                             │
                             ▼
                  ┌──────────────────────┐
                  │  Cloudflare Tunnel    │  (DNS + TLS; the app login is the gate)
                  │   cloudflared         │
                  └──────────┬───────────┘
                             │  → 127.0.0.1:1840 (prod)
                             ▼
        ┌──────────────────────────────────────────────┐
        │  km-lb   (nginx)                               │
        │    :1840  prod  → ACTIVE color                 │
        │    :1841  test  → INACTIVE color               │
        │    /healthz (LB's own liveness, never proxied) │
        └───────┬───────────────────────────┬───────────┘
                │ km-edge                     │ km-edge
        ┌───────▼─────────┐          ┌────────▼────────┐
        │  BLUE trio      │          │  GREEN trio     │
        │  km-client-blue │          │  km-client-green│   (static nginx SPA)
        │  km-server-blue │          │  km-server-green│   (API :4000)
        │  km-kiwi-blue   │          │  km-kiwi-green  │   (morphology :8000)
        └───────┬─────────┘          └────────┬────────┘
                │ km-internal (internal: true — no egress)
                └──────────────┬───────────────┘
                               ▼
                      ┌──────────────────┐
                      │  km-db (Postgres) │  ← ONE shared DB, both colors
                      │  127.0.0.1:5432   │     volume: km_db_data
                      └─────────┬─────────┘
                                │ km_backups volume (/backups)
                                ▼
                      ┌──────────────────┐
                      │  km-backup        │  nightly pg_dump loop
                      │  (km-backup-      │  (km-backup-entrypoint.sh)
                      │   entrypoint.sh)  │
                      └──────────────────┘

Shared volumes (survive a color switch):
  km_db_data   → km-db   /var/lib/postgresql/data
  km_images    → BOTH km-server-{blue,green} at $IMAGE_STORAGE_DIR (user OCR uploads)
  km_book_uploads → BOTH km-server-{blue,green} at $BOOK_UPLOAD_STORAGE_DIR (uploaded book PDFs)
  km_backups   → km-db + km-backup /backups (pg_dump target)
```

`km-server` reaches its OWN color's kiwi at `http://km-kiwi-${COLOR}:8000`. The
LB serves the SPA and the API on **one origin** and splits by path prefix (the
client is built with `VITE_API_URL` unset → same-origin, `SameSite=Strict`
cookies hold). See `nginx-{blue,green}-active.conf`.

---

## Ports

| Port | Bind          | Purpose                                              |
|------|---------------|------------------------------------------------------|
| 1840 | host (LB)     | **prod** → ACTIVE color (Cloudflare Tunnel → here)   |
| 1841 | host (LB)     | **test** → INACTIVE color (validate before switch)   |
| 1842 | `127.0.0.1`   | blue server direct (debug only, loopback)            |
| 1843 | `127.0.0.1`   | green server direct (debug only, loopback)           |
| 5432 | `127.0.0.1`   | km-db (loopback only; `$POSTGRES_HOST_PORT`)         |
| 4000 | internal      | server (per color, no host binding)                  |
| 80   | internal      | client nginx (per color, no host binding)            |
| 8000 | internal      | kiwi (per color, no host binding)                    |

Only **1840/1841** face the host's non-loopback interface, and even those sit
behind the Cloudflare Tunnel. The database, kiwi, and client containers are
never publicly reachable. See `SECURITY.md`.

---

## Deploy → test → switch flow

Deploys are run **by hand on the host** — there is no CI/CD system driving
them. (The `azure-*` script names are historical: they were adapted from an
Azure Pipelines reference, but everything runs locally on this PC — there is no
Azure DevOps agent, pipeline, or cloud involved.) A release is three fail-fast
steps run from the repo checkout root; the active color keeps serving until the
final flip:

1. **Build** — `local-build.sh [TAG]` builds the five images (`km-server`,
   `km-client`, `km-kiwi`, `km-migrate`, `km-loader`) straight into the local
   Docker image store (default tag `local`; pass a git short SHA for an
   immutable release). Does not touch the running stack.
2. **Deploy to inactive** — `azure-deploy-inactive.sh <TAG>` takes a pre-deploy
   DB backup → runs the migrations on the shared DB (dry-run expand/contract
   gate, **then** apply) → brings up the **inactive** color → verifies it on
   **:1841**. Production (**:1840**) is untouched the whole time.
3. **Switch** — `azure-switch-production.sh <TAG>` flips the LB to the new color
   and verifies **:1840**. A failed post-switch health check **auto-rolls back**
   the flip.

```bash
Deploy/local-build.sh             "$(git rev-parse --short HEAD)"   # 1. build images
Deploy/azure-deploy-inactive.sh   "$(git rev-parse --short HEAD)"   # 2. deploy + migrate + validate :1841
Deploy/bg-health.sh                                                 # (check all colors/ports)
Deploy/azure-switch-production.sh "$(git rev-parse --short HEAD)"   # 3. flip prod → new color
```

> **CI vs. deploy:** `.github/workflows/ci.yml` (+ `gitleaks.yml`) runs the full
> lint/type/test suite on every PR and gates merges into `rebuild`. It does
> **not** deploy — deploying is the manual step sequence above, run on the host
> after the merge.

---

## Reading and flipping the active color

The active color lives in two places that must agree:

* the `ACTIVE_ENVIRONMENT` line in the persistent server `.env`, and
* the live `km-lb` nginx config (which upstream `:1840` points at).

```bash
Deploy/check-active-env.sh --get-active   # prints just: blue | green
Deploy/check-active-env.sh                # cross-checks .env vs live nginx; exits 1 on drift
```

A flip is `nginx_switch <color>` followed by writing `ACTIVE_ENVIRONMENT`
(both done by `azure-switch-production.sh`). Never edit the live `nginx.conf` by
hand — it is overwritten from `nginx-${color}-active.conf` on every switch.

---

## Secrets

* The **source of truth** is a single gitignored, `chmod 0600` `.env` on the
  host (alongside this directory's compose files). Containers read it; it is
  backed up with the DB. `Deploy/.env.example` is the **template** —
  placeholders only, never real values.
* The three sensitive values — `POSTGRES_PASSWORD`, `ANTHROPIC_API_KEY`, and
  `TOTP_SECRET_ENC_KEY` — live **only** in that local `.env`. They are never
  committed, and the deploy scripts never echo or log them.

To rotate a secret: edit the line in the host `.env` and restart the active
color (`rebuild-environment.sh`, or recreate just that trio with
`compose_color <active> up`). See `SECURITY.md` for the full posture.

---

## Backup / restore drill

Backups: `km-backup` runs `km-backup-entrypoint.sh`, which sleeps until
`$BACKUP_TIME` (`$BACKUP_TZ`) and fires `db-backup.sh` nightly — a custom-format
`pg_dump` of the shared DB to `$BACKUP_DIR/km-<UTCstamp>.dump` (`0600`), pruned
past `$BACKUP_RETENTION_DAYS` (default 90), optionally mirrored to
`$BACKUP_OFFSITE_DIR`.

```bash
# Take an ad-hoc backup now
Deploy/db-backup.sh                      # uses $BACKUP_DIR from the .env
Deploy/db-backup.sh --dir /mnt/extra     # override the target dir

# Verify a backup is actually restorable + faithful (non-destructive — restores
# into a throwaway scratch DB and compares table/row counts to live)
Deploy/db-validate.sh "$BACKUP_DIR/km-20260531T030000Z.dump"

# Restore (DESTRUCTIVE — drops & recreates the shared DB). Refuses while a color
# is serving unless --force, because the shared DB backs both colors.
Deploy/db-restore.sh "$BACKUP_DIR/km-20260531T030000Z.dump" --force

# Reconcile the schema AFTER a restore (a restored older dump can be behind the
# deployed code — see the restore script's closing log lines):
python db/migrate.py status             # 1. is the restored dump behind?
python db/migrate.py up                 # 2. IF behind: forward-migrate (expand/contract = safe)
#                                       # 3. restart the active color so it reconnects:
Deploy/rebuild-environment.sh           #    (or `compose_color <active> up` to recreate just that trio)
```

**Recommended drill cadence:** run `db-validate.sh` against the latest dump
weekly. A dump that won't restore is not a backup.

> **Backup metadata is per-run, not per-dump (P-SF6).** `db-backup.sh` writes a
> single `backup-info.txt` describing the **most recent** dump only; it is
> overwritten each night while retention keeps up to `$BACKUP_RETENTION_DAYS` of
> dumps. So `backup-info.txt` is a breadcrumb for the latest dump, **not** an
> index of older ones. To inspect an older dump, read it directly:
> `docker exec km-db pg_restore --list "/backups/km-<stamp>.dump"` (the dump's UTC
> timestamp is in its filename; the active color at dump time is only recorded for
> the latest run). Don't point an operator at `backup-info.txt` for a dump that
> isn't the newest.

---

## Emergency rebuild

If the stack is wedged (LB half-flipped, a color stuck unhealthy):

```bash
Deploy/rebuild-environment.sh   # tears down both colors + shared, brings the
                                # active color back up, re-applies nginx, health-checks
```

This causes a **1–2 minute interruption** and is for critical failures only.
Named volumes (`km_db_data`, `km_images`, `km_book_uploads`, `km_backups`) are
preserved — no data loss. If the DB itself is corrupt, restore from a backup
*after* the rebuild.

---

## Cloudflare Tunnel

`cloudflared` runs on the host and forwards the public hostname to
`http://localhost:1840` (prod). The tunnel terminates TLS, so the LB sees plain
HTTP from the tunnel and the nginx configs set `X-Forwarded-Proto https` /
`X-Forwarded-Port 443` so the server emits correct absolute URLs and keeps
`Secure` cookies. Point the tunnel's test hostname (if any) at `:1841` to
preview the inactive color. The tunnel is the **only** public ingress; no host
port other than 1840/1841 is exposed off-loopback.

---

## First-time host setup

1. Install Docker + the Docker Compose plugin.
2. Copy `Deploy/.env.example` → `.env` next to the compose files; fill in real
   values; `chmod 0600 .env`. Set `ACTIVE_ENVIRONMENT=blue` (or green) and the
   `BACKUP_*` knobs.
3. `Deploy/ensure-shared-volume.sh` (creates `km_db_data`, `km_images`,
   `km_book_uploads`, `km_backups`).
4. Bring up shared + the active color (the deploy script does this on first run,
   or `compose_shared up` + `compose_color <active> up`).
5. `python db/migrate.py up` to initialize the schema.
6. Start `cloudflared` pointing at `:1840`.

> The production flip is a **manual operator step** — a human runs
> `azure-switch-production.sh` — so there is no unattended auto-deploy to guard
> against. `azure-deploy-inactive.sh` only ever touches the idle color and the
> test port (`:1841`); production is never affected until someone runs the
> switch.

See `VERIFICATION.md` (repo root) **§8 Deploy stand-up** for the full,
copy-pasteable stand-up + switch + backup/restore verification checklist.

---

## Relationship to `db/scripts/` (local dev)

| Concern   | Local dev (`db/scripts/`)            | Production (`Deploy/`)                          |
|-----------|--------------------------------------|------------------------------------------------|
| DB target | `db` compose service (`docker compose exec`) | named container `km-db` (`docker exec`) |
| Config    | shell env / repo `.env`              | persistent server `.env` via deployment-utils.sh |
| Backup    | `backup.sh` (14-day default)         | `db-backup.sh` (90-day default, offsite-aware) |
| Restore   | `restore.sh` (path-guarded)          | `db-restore.sh` (path-guarded + active-color gate) |
| Validate  | —                                    | `db-validate.sh` (scratch-DB restore + diff)   |

The dump **format is identical** (`-Fc -Z 6 --no-owner --no-privileges`), so a
dev dump and a prod dump are interchangeable for `pg_restore`. The `Deploy/`
scripts are the blue/green-aware wrappers; they do not replace `db/scripts/` —
they target the shared production `km-db` and add the safety gates production
needs.

## File index

| File                        | Role                                              |
|-----------------------------|---------------------------------------------------|
| `azure-pipelines.yml`       | legacy Azure Pipelines def — **unused** (deploys are manual, see above) |
| `local-build.sh`            | build the 5 images into the local Docker store    |
| `azure-deploy-inactive.sh`  | deploy+migrate+validate the inactive color (:1841) |
| `azure-switch-production.sh`| flip the LB to the new color (:1840), auto-rollback |
| `db-backup.sh`              | pg_dump the shared DB, prune, optional offsite     |
| `db-restore.sh`             | restore a dump (path-guarded, active-color gated)  |
| `db-validate.sh`            | prove a dump restores + matches live (scratch DB)  |
| `km-backup-entrypoint.sh`   | the km-backup container's nightly loop             |
| `README.md` / `SECURITY.md` | this runbook / the deploy threat model             |

(Compose files, nginx configs, the prod client image, `deployment-utils.sh`,
and the orchestration scripts — `azure-deploy-inactive.sh`,
`azure-switch-production.sh`, `bg-health.sh`, `check-active-env.sh`,
`cleanup.sh`, `ensure-shared-volume.sh`, `rebuild-environment.sh` — are
documented inline and owned by the compose/orchestration passes.)
