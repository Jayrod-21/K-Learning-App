# Korean Master — Deploy Security (threat model)

Scope: the **production deployment surface** — the blue/green Docker stack on
the self-hosted host, secret handling, the backup/restore tooling, and the
manually-run deploy scripts. Application-level threats (auth, input validation,
the Claude proxy) are covered in `server/SECURITY.md`, `client/SECURITY.md`, and
`db/SECURITY.md`; this document covers what the *deploy* adds or exposes.

Per the project's standing order, each surface is enumerated as **attack vector
→ defense**.

---

## 1. Authentication & authorization

The deploy introduces **no new public auth surface**. The application login is
the gate, and the load balancer (`km-lb`) is the **only** public ingress.

* **Vector:** an attacker reaches an internal service (API, kiwi, DB, a color's
  client) directly, bypassing the app.
  **Defense:** only `km-lb` binds a non-loopback host port (1840/1841), and even
  those sit behind the Cloudflare Tunnel. Per-color server debug ports
  (1842/1843) bind `127.0.0.1` only. `km-db` binds `127.0.0.1` only. Kiwi and
  the client containers bind **no** host port — they are reachable solely over
  the internal Docker networks.
* **Vector:** the test port (1841) is used to reach an unreleased/unapproved
  build in production.
  **Defense:** 1841 serves the *inactive* color for pre-switch validation only;
  it requires the same app login. Promotion to 1840 is a deliberate manual step
  — an operator runs `azure-switch-production.sh`; nothing flips production
  automatically.

---

## 2. Secret handling

Secrets: `POSTGRES_PASSWORD`, `ANTHROPIC_API_KEY`, `TOTP_SECRET_ENC_KEY` (and
the composed `DATABASE_URL`).

* **Vector:** secrets committed to git.
  **Defense:** the runtime `.env` is gitignored. `Deploy/.env.example` ships
  **placeholders only**. CI's `gitleaks` job fails the build on a committed
  secret (e.g. a literal `sk-ant-…` key). No real key appears anywhere in this
  directory.
* **Vector:** secrets leak into logs.
  **Defense:** the three secrets live **only** in the host `.env`; no deploy
  script ever `echo`s a secret value (the reference example's
  `echo "DATABASE_PASSWORD"` debug line was deliberately **not** carried over).
* **Vector:** the `.env` is world-readable on the host.
  **Defense:** it is `chmod 0600`, owned by the deploy user.
* **Vector:** a stale secret lingers after rotation.
  **Defense:** rotation is a single edit-in-place of the `.env` line followed by
  restarting the active color — there is no second copy of the secret (no CI
  variable store) that could drift out of sync.

---

## 3. Public-ingress posture

* **Vector:** the database is exposed to the internet.
  **Defense:** `km-db` is on `km-internal` (a bridge with `internal: true` — no
  egress) and its only host binding is `127.0.0.1:5432`. It is unreachable from
  off-host and from the edge network.
* **Vector:** the kiwi morphology service is reached or used to exfiltrate.
  **Defense:** kiwi lives on `km-internal` only, has **no host port**, and the
  network has **no egress** — even a compromised kiwi cannot call out. Kiwi runs
  as a non-root user on a read-only rootfs with a `/tmp` tmpfs (see its
  Dockerfile).
* **Vector:** the per-color client/server containers are addressed directly.
  **Defense:** clients have no host port; server debug ports are loopback-only.
  All public traffic is funneled through the LB's path-split routing.

---

## 4. Cloudflare Tunnel posture

* **Vector:** the origin is hit directly, bypassing Cloudflare's WAF/TLS.
  **Defense:** the only off-loopback host ports are 1840/1841, and the tunnel
  (`cloudflared`) is the documented path to them; no public DNS A record points
  at the host IP. TLS terminates at the tunnel.
* **Vector:** the origin mis-handles forwarded scheme and downgrades cookies.
  **Defense:** because TLS terminates upstream, the nginx configs set
  `X-Forwarded-Proto https` and `X-Forwarded-Port 443` so the app keeps emitting
  `Secure` cookies and correct absolute URLs. (The app trusts these only because
  the LB is the sole ingress — see §7.)

---

## 5. nginx hardening

* **Vector:** version/banner disclosure aids targeted exploits.
  **Defense:** `server_tokens off` in the client image config; the LB configs
  expose only the path-split proxy and a local `/healthz`.
* **Vector:** request smuggling / header injection through the proxy.
  **Defense:** the LB uses a single anchored regex location for the exact set of
  server route prefixes (kept in sync with `server/src/app.ts`) and a catch-all
  `location /` to the client; `proxy_pass` uses a bare upstream so the URI is
  preserved verbatim (no rewrite gymnastics to get wrong). Standard forwarding
  headers (`Host`, `X-Real-IP`, `X-Forwarded-For/Proto/Port/Host`) are set
  explicitly.
* **Vector:** a slow upstream (Claude-backed routes) ties up the LB or breaks
  streaming.
  **Defense:** the API location uses `proxy_buffering off` + 120s read/send
  timeouts (> the server's 30s Claude timeout) so SSE/streaming works without
  unbounded buffering.

---

## 6. Backups — confidentiality & integrity

* **Vector:** a dump (full dataset) is read by another local user.
  **Defense:** `db-backup.sh` writes dumps `chmod 0600` into a `chmod 0700`
  directory; `backup-info.txt` is `0600` too.
* **Vector:** a half-written dump is mistaken for a good backup; a failed backup
  deletes the last good one.
  **Defense:** atomic write (`.partial` → `mv`); the retention prune runs **only
  after** the new dump is durable.
* **Vector:** off-site copies leak the dataset.
  **Defense:** off-site is opt-in (`BACKUP_OFFSITE_DIR`); when unset we log
  "offsite skipped — pending Q-BACKUP" rather than silently doing nothing.
  **OPEN ITEM (Q-BACKUP):** off-site **encryption-at-rest** is pending an
  operator decision. Until answered, the off-site destination is assumed to be an
  already-encrypted target (encrypted external volume or an `rclone crypt`
  remote). Do not point `BACKUP_OFFSITE_DIR` at an unencrypted cloud bucket.
* **Vector:** a backup silently rots and won't restore when needed.
  **Defense:** `db-validate.sh` restores each dump into a throwaway scratch DB
  and compares table + row counts to live — run weekly (see README drill).

---

## 7. Migrate-on-deploy (expand/contract) safety

* **Vector:** a deploy migration breaks the still-live old code (the shared DB
  backs both colors during a deploy).
  **Defense:** migrations are **expand/contract / additive** by contract — the
  active old color keeps reading/writing while new migrations apply. The deploy
  runs `python db/migrate.py up` against the shared DB *before* the switch; a
  pre-deploy backup is taken first. An **undeclared** non-additive migration is
  a release engineering error and aborts the deploy at the dry-run step
  (`migrate.py` refuses destructive SQL without `--allow-destructive` — since
  the ADR-010 amendment the `--dry-run` gate evaluates this too — and the
  scripted deploy never passes the flag).
  **Sanctioned exception — deliberate destructive release:** a release whose
  migrations are *knowingly* non-additive (e.g. Phase-2 Group 1: 045's
  `DROP TABLE`, 046's old-code-incompatible index swap) does NOT go through the
  scripted zero-downtime flow at all. It follows the operator-run
  **brief-downtime** procedure in `README.md` §"Shipping Phase-2 Group 1":
  pre-migration backup → stop the active color → one manual
  `run_migrate --allow-destructive up` → any out-of-band steps (047's
  `set-km-app-password.sh`) → bring up the new color → health gate → flip.
  The flag is typed by a human against a stopped stack, never wired into a
  script — so the "never passes" property of the automated path is preserved,
  and old code never runs against the new schema. Rollback-by-flip is invalid
  inside such a window (old code + new schema); recovery is the migration
  rollback or the pre-deploy backup, per the runbook.
* **Vector:** a migration corrupts the DB mid-deploy.
  **Defense:** `migrate.py` wraps each migration body + its bookkeeping row in
  ONE transaction (partial application is impossible), and a pre-deploy dump
  exists to restore from. A migration failure stops the deploy with the active
  color untouched.

---

## 8. Restore guardrails

* **Vector:** path traversal — restoring an attacker-chosen file outside the
  backup root.
  **Defense:** `db-restore.sh` / `db-validate.sh` resolve the dump's absolute
  path, require it to live under `$BACKUP_DIR`, reject any residual `..`, and
  address it by its in-container `/backups/<rel>` path (mirrors
  `db/scripts/restore.sh`). pg_restore opens a real seekable file (no docker
  stdio truncation on large dumps).
* **Vector:** an accidental restore wipes production while users are on it.
  **Defense:** the shared DB backs both colors, so `db-restore.sh` **refuses**
  unless `--force` when a color is actively serving; an unknown active color is
  treated as "serving" (fail safe).
* **Vector:** env-var injection into the drop/recreate SQL (`POSTGRES_DB` /
  `POSTGRES_USER`).
  **Defense:** both are validated against `^[A-Za-z0-9_]+$` before
  interpolation, in every DB script.
* **Vector:** a malicious dump runs code as the DB superuser on restore
  (`CREATE FUNCTION … plperlu`, `COPY FROM PROGRAM`).
  **Defense:** only restore dumps we produced or trust; the format gate
  (`pg_restore --list`) confirms it is a real custom-format dump but does **not**
  sandbox its contents. See `db/SECURITY.md`. This is a trust boundary, not a
  technical control — documented so it isn't forgotten.

---

## 9. Image provenance (built locally, no registry)

* **Vector:** a poisoned image is pulled from a compromised public registry.
  **Defense:** images are **built on the host from this repo checkout** by
  `local-build.sh`, straight into the local Docker image store. There is no
  external registry in the path and no registry credentials to steal.
* **Vector:** the wrong image version is deployed.
  **Defense:** `local-build.sh` tags all five images with the same tag (a git
  short SHA for a real release), and the deploy/switch scripts take that exact
  tag as their argument and pin the color trio to it.

---

## 10. Deploy host blast radius

Builds and deploys are run **by hand on the host** by an operator with access to
the host Docker daemon. There is no CI/CD agent — the deploy scripts execute
directly in the operator's shell.

* **Vector:** untrusted code from a PR runs against the host during a deploy.
  **Defense:** PR CI runs only in **GitHub Actions hosted runners**, which have
  no access to this host. Nothing deploys automatically: an operator pulls the
  merged `rebuild` branch and runs the scripts deliberately, so only reviewed,
  merged code is ever built and deployed here.
* **Vector:** the operator's Docker access is leveraged to escape onto the host.
  **Defense:** scope is acknowledged and minimized — the deploy scripts only
  build/run this project's compose stack; secrets stay in the `0600` `.env`;
  `cleanup.sh` prunes images/containers but **preserves named volumes** so a
  buggy cleanup can't delete the DB. Treat the host as part of the trust
  boundary: keep it patched and off shared accounts. (Running Docker rootless or
  behind a socket proxy is a known future hardening.)

---

## Residual risks / open items

* **Q-BACKUP** — off-site encryption-at-rest policy (§6). Tooling is
  parametrized and ready; the destination/crypto choice is an operator call.
  Not a deploy blocker.
* **Deploy host isolation** (§10) — rootless Docker / socket proxy is a future
  hardening, not yet applied.
* **Dump trust** (§8) — restoring an untrusted dump is a deliberate operator
  action with documented risk, not a technical sandbox.
