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

## Shipping Phase-2 Group 1 (migrations 045–047) — ONE-TIME brief-downtime release

**The standard zero-downtime flow above does NOT work for this release. Do not
run `azure-deploy-inactive.sh` first.** Two reasons:

1. **045 is deliberately destructive** (`DROP TABLE` of two superseded ad-hoc
   `topik_items_explanation_bak_*` snapshot tables). `migrate.py`'s destructive
   gate blocks it, and the scripted deploy never passes `--allow-destructive`
   (by design — see `SECURITY.md` §7). The apply must be a one-time, manual,
   flagged `run_migrate` call.
2. **046 is not expand/contract.** It drops `uq_topik_attempts_user`, the full
   unique index the OLD (pre-046) server code's
   `ON CONFLICT (user_id) DO UPDATE` upserts arbitrate on. The replacement is a
   *partial* unique (`WHERE status = 'active'`) that an unqualified
   `ON CONFLICT (user_id)` cannot infer — so from the moment 046 applies, the
   still-running old color 500s (`42P10`) on every TOPIK save and mock submit,
   and mis-renders migrated history rows as resumable attempts. The
   old-code-on-new-schema overlap the blue/green flow depends on is therefore
   UNSAFE for this release. The 046 schema end-state is correct; the accepted
   trade (single-user app) is a **brief downtime window** instead of a
   two-phase migration.

**Consequence for rollback-by-flip:** once 046 is applied, flipping the LB back
to a color running pre-046 code is NOT a valid recovery — it lands old code on
the new schema, the exact `42P10` breakage above. `azure-switch-production.sh`'s
post-flip auto-rollback is off the table for this release window; recovery is
the migration rollback (below) or the pre-deploy backup.

### Release procedure (stop → migrate → password → new color → verify → flip)

Run on the host, from the repo checkout root, during an idle window:

```bash
# 0. Preconditions — add the km_app credentials to Deploy/.env FIRST:
#        KM_APP_USER=km_app
#        KM_APP_PASSWORD=<openssl rand -hex 32>     # hex = URL-safe, required
#    Both color compose files hard-fail (`${KM_APP_PASSWORD:?}`) on EVERY
#    compose command — including teardown and rebuild-environment.sh — until
#    these exist. See Deploy/.env.example for the full commentary.

# 1. Build the release images + export the tag for run_migrate
Deploy/local-build.sh "$(git rev-parse --short HEAD)"
export DEPLOY_TAG="$(git rev-parse --short HEAD)"

# 2. Pre-migration backup (a manual flagged apply must NOT skip the safety
#    net the scripted deploy would have taken)
bash Deploy/db-backup.sh

# 3. DOWNTIME BEGINS — stop the ACTIVE color so no old code runs against the
#    post-046 schema (check-active-env.sh --get-active prints the color)
source Deploy/deployment-utils.sh && load_environment
compose_color "$(bash Deploy/check-active-env.sh --get-active)" down

# 4. One-time flagged migration apply (045 + 046 + 047)
run_migrate --allow-destructive up

# 5. One-time km_app password provisioning (047 creates the role with a NULL
#    verifier; nothing can authenticate as km_app until this runs)
bash Deploy/set-km-app-password.sh

# 6. Stage the NEW color (migrations are now a no-op; the idle color starts
#    with the km_app DATABASE_URL, authenticates, and must pass health on :1841)
Deploy/azure-deploy-inactive.sh "$DEPLOY_TAG"

# 7. Flip prod to the new color and verify :1840 — DOWNTIME ENDS
Deploy/azure-switch-production.sh "$DEPLOY_TAG"
```

If step 6 or 7 fails: do **not** restart the old color against the migrated
schema. Fix forward on the new color, or roll the schema back (below) and only
then restart the old color.

### Rollback (also brief-downtime; DESTROYS attempt history)

```bash
source Deploy/deployment-utils.sh && load_environment
compose_color <new-color> down                       # stop the new color
run_migrate --allow-destructive --target 044 down    # roll 047, 046, 045 back
compose_color <old-color> up                         # restart the old build
# then re-point the LB: bash -c 'source Deploy/deployment-utils.sh; load_environment; nginx_switch <old-color>'
```

> **DATA LOSS:** `046.down` collapses attempt history to one row per user
> (all other TOPIK attempts are DELETEd — irrecoverably, short of the step-2
> backup) and drops `topik_responses.attempt_id`. Note the runner's destructive
> gate does **not** catch this mechanically (it matches `DROP TABLE`/`TRUNCATE`
> etc., not `DELETE`/`DROP COLUMN` — see 046.down's header); pass
> `--allow-destructive` anyway, as above, because the loss is real.
> `047.down` drops the `km_app` role — the color you restart must use a
> pre-047 `DATABASE_URL` (the superuser), i.e. a pre-047 compose file/checkout.

### After this release

Subsequent releases return to the normal **zero-downtime** blue/green flow at
the top of this section — migrations are expand/contract again, the scripted
deploy's dry-run gate (which now fails fast on destructive SQL) stays
unflagged, and rollback-by-flip is valid again. The one *permanent* change:
any **fresh database** (first-time host setup, cold stand-up) always traverses
045, so cold schema initialization needs the flag once — use
`Deploy/local-standup.sh --allow-destructive` (safe on an empty DB; the
destructive statements are `IF EXISTS` no-ops there).

---

## Shipping Phase-2 Group 2 (migrations 048–052) — standard zero-downtime flow

Group 2 needs **no special protocol**: all five ups are expand-only (new
tables 048/051/052; add-column/add-constraint expansions 049/050 — 049
deliberately keeps `vocab_list_entries.entry_id` under its 012 name instead
of renaming it, exactly so the still-serving old color keeps working; see the
049 up header). Ship with the normal scripted sequence at the top of this
file: `azure-deploy-inactive.sh` (applies 048–052 unflagged — nothing trips
the destructive gate, and nothing needs to) → health-check →
`azure-switch-production.sh`. **Rollback-by-flip remains valid**: pre-Group-2
code runs correctly against the post-052 schema. No `set-km-app-password.sh`
step either — 047's `ALTER DEFAULT PRIVILEGES` auto-grants `km_app` DML on
the five new tables.

The only Group-2-specific caution is a **schema rollback** (down, not flip):
`run_migrate --allow-destructive --target 047 down` drops the 048/051/052
tables outright, and the 050/049 downs discard all hanja cards (+ their FSRS
review history) and all grammar/hanja list memberships via DELETE +
DROP COLUMN — real data loss the destructive gate does not mechanically match
(same caveat as 046.down; see both down headers). Take a `db-backup.sh`
snapshot before any manual rollback.

---

## Shipping Phase-2 Group 3 (migrations 053–055) — standard zero-downtime flow

Group 3 needs **no special protocol**: all three ups are add-only (053 adds
two `claude_route` enum values via `ADD VALUE IF NOT EXISTS`; 054 creates the
new `generated_stories` table; 055 adds one more enum value plus a nullable
`conversations.title` column — no default, so no table rewrite). Nothing is
renamed and nothing in use is dropped, so the still-serving old color keeps
working while the migrations apply. Ship with the normal scripted sequence at
the top of this file: `azure-deploy-inactive.sh` (applies 053–055 unflagged —
nothing trips the destructive gate on the way up) → health-check →
`azure-switch-production.sh`. **Rollback-by-flip remains valid**: pre-Group-3
code runs correctly against the post-055 schema (it never references
`generated_stories` or `conversations.title`, and unused enum values are
harmless). No `set-km-app-password.sh` step either — 047's `ALTER DEFAULT
PRIVILEGES` auto-grants `km_app` DML on `generated_stories`. No nginx change
needed: every new endpoint lives under the existing `/writing`, `/reading`,
and `/conversation` prefixes already in the km-lb allow-list (the F-012
`/ttmik`-class trap does not apply here).

The only Group-3-specific caution is a **schema rollback** (down, not flip):
`run_migrate --allow-destructive --target 052 down` is required to cross
054's `DROP TABLE generated_stories` (destroys the generated-story library),
and 055's down discards all conversation titles via `DROP COLUMN` — data
loss the destructive gate does not mechanically match (same caveat as the
049/050 downs above; see the down headers). 053's down is a documented no-op
(enum values are retained — removal would need a type rewrite over the
`claude_cache`/`claude_usage` route columns). Take a `db-backup.sh` snapshot
before any manual rollback.

---

## Reading and flipping the active color

The active color lives in three places that must agree:

* the `ACTIVE_ENVIRONMENT` line in the persistent server `.env`,
* the live `km-lb` nginx config (which upstream `:1840` points at), and
* `Deploy/active-color.d/active-color` — a one-line file naming the active
  color, inside `Deploy/active-color.d/`, a small dedicated directory
  bind-mounted **read-only as a directory** (not the file directly) into BOTH
  `km-server-blue` and `km-server-green` so each process can tell whether IT
  is the active one (Phase 1.3: gates the story-TTS/illustration job runners
  so only the active color claims live work — see `config/index.ts`'s
  `isRunnerActiveColor`). It is a *directory* mount deliberately: a Linux
  bind mount of a single FILE pins the container's mountpoint to the inode
  that existed at container start, so `write_active_color_file`'s atomic
  temp-file + `mv` (which swaps the host directory entry to a new inode)
  would never be observed by an already-running container — the newly
  active color's runners would stall forever after the very first switch.
  Mounting the enclosing directory instead means only the filename's inode
  resolution changes, which containers DO observe live, with no restart.
  `Deploy/active-color.d/` is deliberately a separate directory from the
  secrets-bearing `.env` (it holds nothing but a one-line color name); the
  directory itself is committed empty (`active-color.d/.gitkeep`) so the
  mount source always exists on a fresh checkout, while the mutable value
  file inside it is gitignored. `check-active-env.sh` does not check it
  (its drift is low-stakes — `SKIP LOCKED` makes concurrent claiming safe,
  just unpredictable — so it is kept in sync by `write_active_color_file`
  rather than gated).

```bash
Deploy/check-active-env.sh --get-active   # prints just: blue | green
Deploy/check-active-env.sh                # cross-checks .env vs live nginx; exits 1 on drift
```

A flip is `nginx_switch <color>` followed by writing `ACTIVE_ENVIRONMENT` and
`Deploy/active-color.d/active-color` (all three done by
`azure-switch-production.sh`). Never edit the live `nginx.conf` or
`active-color.d/active-color` by hand — both are overwritten by the deploy
scripts (`nginx.conf` from `nginx-${color}-active.conf` on every switch;
`active-color.d/active-color` via `write_active_color_file`, which writes a
temp file INSIDE `active-color.d/` and renames it into place so the mount
sees the change).

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
python db/migrate.py up                 # 2. IF behind: forward-migrate
#    CAVEATS for step 2: (a) a pre-045 dump traverses 045 (deliberately
#    destructive) — the plain `up` aborts with DestructiveBlocked; read 045's
#    header, then re-run with `--allow-destructive`. (b) forward-migrating
#    through 046 is NOT old-code-safe: do it only with the serving color
#    STOPPED or already running post-046 code (see §"Shipping Phase-2 Group 1").
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
5. Initialize the schema: `python db/migrate.py --allow-destructive up` — the
   flag is required because the chain contains 045 (deliberate `DROP TABLE`;
   its statements are `IF EXISTS` no-ops on an empty DB, so this is safe on a
   fresh database). Or run the whole cold bring-up with
   `Deploy/local-standup.sh --allow-destructive`, which scripts steps 3–5.
   Then provision the app role's password once: `bash Deploy/set-km-app-password.sh`
   (migration 047 creates `km_app` without one; the app cannot authenticate
   until this runs).
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
| `local-build.sh`            | build the 5 images into the local Docker store    |
| `azure-deploy-inactive.sh`  | deploy+migrate+validate the inactive color (:1841) |
| `azure-switch-production.sh`| flip the LB to the new color (:1840), auto-rollback |
| `local-standup.sh`          | first-time cold bring-up (`--allow-destructive` for a fresh DB) |
| `set-km-app-password.sh`    | one-time/rotation km_app password provisioning (047) |
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
