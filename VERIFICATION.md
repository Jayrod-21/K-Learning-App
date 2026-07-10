# Verification Runbook — pre-`main` finalize

The vertical-slice rebuild (Passes 1–9 + Final) is complete on the `rebuild`
branch. Passes 5–9 and the PWA layer shipped **correct-by-construction**: they
are type-clean, reviewed, and unit-tested, but several paths could not be
exercised in the build environment (no Docker daemon, no served app). This
runbook is the gate that exercises them for real before `rebuild` is promoted
to `main`.

Run it on a host with a Docker daemon and outbound network. Work top to bottom;
every section must pass before promoting.

## 0. Prerequisites

- Docker daemon running (`docker ps` succeeds).
- Node 22, npm; Python 3.12 (for the loaders); the repo checked out on `rebuild`.
- `server/.env` with a real `ANTHROPIC_API_KEY` (gitignored — never commit it;
  `.env.example` is the template). The real-Claude smoke + any live route test
  needs it.
- From the repo root unless a step says otherwise.

## 1. Database + migrations (round-trip)

The migration runner owns its own transaction per migration (ADR-013); there is
no top-level BEGIN/COMMIT in the SQL.

```bash
docker compose up -d postgres            # or the compose service name for PG
# apply every migration forward
python db/migrate.py up                  # expect 001 … 025 applied, no error
# round-trip the most recent ones down then up to prove reversibility
python db/migrate.py down --to 022       # 025 → 024 → 023 → 022 downgrade cleanly
python db/migrate.py up                  # back to 025
```

Pass criteria: forward applies 001–025 with no error; the down/up round-trip
succeeds (each `*.down.sql` reverses its `*.up.sql`). New since the last run:
018 = `users.preferences` JSONB; 019 = `grammar_drill_attempts`; 020 = the
grammar-production-card unique index; 021 = the `user_mined` corpus enum value
(its down is a documented no-op — Postgres has no DROP VALUE); 022 = the
`user_mined` vocab CHECK relaxations + corpus_sources seed (the 021→022 split is
required — a freshly-added enum value can't be used in the tx that adds it).
**Login pass:** 023 = `user_totp` (encrypted secret + confirmed_at + replay/lockout
columns); 024 = `user_recovery_codes` (single-use hashed backup codes); 025 =
`mfa_login_challenges` (the short-lived two-step pending tokens). All three are
purely additive (expand/contract-safe for the shared blue/green DB); their downs
are plain reverse `DROP TABLE`. This down round-trip is where 020–025's
reversibility is exercised (closes the FU-NF-33-review note that the downs were
reasoned but not yet run).

> Note: `migrate.py down` for 001 requires `--allow-destructive` (it's a
> DROP TABLE) — see `db/migrations/README.md`.

## 2. Server test suite (the Docker-gated route tests)

In the build sandbox the route integration tests fail at *collection* because
testcontainers can't start Postgres. On a Docker host they run for real.

```bash
cd server
npm ci
npx tsc --noEmit                         # expect 0 errors
ESLINT_USE_FLAT_CONFIG=false npx eslint 'src/**/*.ts' 'tests/**/*.ts'  # 0 errors
# Config validates at module-import (the rate-limiters call loadConfig eagerly),
# so the required vars must be present before collection — each route test then
# overrides DATABASE_URL with its own testcontainer. The AES key can be any
# 32-byte base64 value here (the suite re-injects a fixed test key per app).
TOTP_SECRET_ENC_KEY="$(openssl rand -base64 32)" \
  DATABASE_URL='postgres://test:test@localhost:5432/test' \
  KIWI_URL='http://kiwi.invalid/' CLIENT_ORIGIN='http://localhost:5173' \
  npx vitest run                         # FULL suite — unit + Docker-gated routes
```

Pass criteria: tsc 0; eslint 0; **all** vitest files pass (the route suites that
only collected in the sandbox now execute against real Postgres — incl. the
Pass-9 `settings`/`grammarDrill` and the Login-pass `auth.mfa` route suite). The
in-memory unit tests must stay green (now incl. the Login-pass crypto / totp /
recoveryCodes units).

## 3. Real-Claude smoke (proxy paths against the live API)

The proxy's prompt builders + parsers + Zod schemas are only exercised against
real model output here — the route tests stub the proxy. This already passed in
the build env for enrich / recognizeGrammarPattern / gradeWriting /
generateGrammarDrill→scoreGrammarDrill (and caught two real gradeWriting bugs,
now fixed). Re-run on the deploy box to confirm nothing regressed:

```bash
cd server
set -a; . ./.env; set +a               # load ANTHROPIC_API_KEY (gitignored)
DATABASE_URL='postgres://smoke:smoke@localhost:5432/smoke' \
  ANTHROPIC_SMOKE=1 LOG_LEVEL=error \
  npx vitest run tests/services/claude/real_smoke.test.ts
```

(The dummy `DATABASE_URL` satisfies config validation; the smoke uses in-memory
cache/usage stores and never connects to it.)

Pass criteria: all 4 smoke tests pass.

**Still TODO here — `ocrImage` (Vision, Pass 8):** the one proxy method not yet
smoke-tested, because it needs a real photo of Korean text (a menu/sign). Add a
5th smoke case that base64-encodes such an image and asserts `ocrImage` returns
words with glosses, then run it. This is the last unexercised Claude path.

## 4. Corpus loaders

```bash
# with the DB from §1 up and migrated
python -m tools.ingest.load_all          # or the per-loader entrypoints
```

Pass criteria: loaders apply the corpora idempotently (re-running is a no-op;
they resume + skip on sha256 match). Spot-check row counts against the corpus
inventory in `PROJECT.md`.

## 5. Client build + PWA (served app)

```bash
cd client
npm ci
npm run build                            # emits dist/ incl sw.js + manifest + icons
npx vite preview --port 4173             # serve the built app (or any static host over HTTPS/localhost)
```

Then in a browser against the served build:
- Service worker registers (DevTools → Application → Service Workers).
- Offline shell: go offline, reload → the app shell loads (the SW must NOT have
  cached any credentialed cross-origin API response — verify in the SW cache).
- Install prompt: the hanji install banner appears on a supported browser;
  Install + Dismiss both behave; dismissal persists.
- **Lighthouse** (DevTools → Lighthouse): PWA + Accessibility both **≥ 90**.

Pass criteria: SW registers, offline shell loads, install flow works, Lighthouse
PWA + a11y ≥ 90.

## 6. Security spot-checks

- `grep -E "auth|vocab|topik|grammar|diagnostic" client/dist/sw.js` → no
  credentialed-API URL in the precache/runtime routes (only the `/^\/api\//`
  navigation denylist).
- `cd server && npm audit --omit=dev` → **0** after FU-NF-44 (the
  `@anthropic-ai/sdk` bump) lands. Today this reports 2 moderate (SDK Memory
  Tool — unreachable by our code). FU-NF-43/FU-NF-41 already cleared the rest.

## 7. Promote `rebuild` → `main`

Only after §1–§6 pass. Jared performs the GitHub-side actions (don't force via
CLI):
1. Merge/fast-forward `rebuild` into `main` (or make `rebuild` the new `main`).
2. Push; swap the default branch on GitHub.
3. Optionally rename the repo to drop "OVERNIGHT"; decide re-public.
4. Deploy to the self-hosted Postgres on this PC + serve via the Cloudflare Tunnel.

### 7a. Production auth provisioning (Login pass — do this at deploy)

The login is the public gate, so the prod box must be set up deliberately:
- **Generate the TOTP encryption key once** and put it in the prod `server/.env`
  (gitignored): `TOTP_SECRET_ENC_KEY="$(openssl rand -base64 32)"`. **Back it up
  with the DB** (per the backup plan) — losing it makes every enrolled TOTP
  secret undecryptable. Rotating it invalidates existing enrollments (operator
  then runs `mfa:reset` and re-enrolls).
- **Lock registration:** set `REGISTRATION_ENABLED=false` in the prod env so
  `/auth/register` returns 403. (`MFA_REQUIRED=true` is the default.)
- **Seed the single account:** `SEED_USER_EMAIL=… SEED_USER_PASSWORD=… npm run
  seed:user` (server/). Idempotent — re-running is a no-op once the account
  exists.
- **First login forces enrollment:** the seeded account has no TOTP, so the
  first sign-in drops into the authenticator-enrollment step (QR + confirm) and
  issues the one-time recovery codes — save them. Thereafter every login needs a
  6-digit code.
- **Lost-device recovery:** with no email sender, total lockout (phone + codes
  both lost) is recovered by the operator running `npm run mfa:reset` against the
  account, which clears the TOTP factor so the next login re-enrolls.
- Smoke the live flow once: register-blocked (403), login → enroll → code →
  session; a bad code rate-limits then locks (423); a recovery code logs in once.

## Outstanding before/with this pass

- **FU-NF-44** — bump `@anthropic-ai/sdk` 0.80 → current (clears the 2 prod
  moderates; verify with §2 + §3 + tsc since it touches every Claude path).
- **FU-NF-43 (c)** — confirmed here: the route suites run green under Docker.
- The §3 Vision smoke case (above).

## 8. Deploy stand-up (Docker finalize — blue/green on the self-hosted host)

This section exercises the `Deploy/` blue/green stack for real (it is
correct-by-construction in the build env — no Docker daemon here). Run it on the
deploy host. See `Deploy/README.md` for the runbook narrative and `Deploy/SECURITY.md`
for the threat model.

### 8.1 Pre-flight (before the first deploy)

The production flip is a **manual operator step** — a human runs
`azure-switch-production.sh` on the host — so there is no unattended pipeline to
gate. `azure-deploy-inactive.sh` only ever touches the idle color and the test
port (`:1841`); production (`:1840`) changes only when someone deliberately runs
the switch. (There is no CI/CD system or Azure DevOps in the path, despite the
`azure-*` script names — see `Deploy/README.md`.)

```bash
# Shared volumes + networks exist (idempotent).
Deploy/ensure-shared-volume.sh

# The server .env is present and locked down (creds live here at rest).
ls -l Deploy/.env && stat -c '%a' Deploy/.env   # expect 600

# Secret-scan stays green: no real key shipped in the template.
grep -rn 'sk-ant-' Deploy/.env.example          # only the REPLACE-ME placeholder
```

### 8.2 Bring up shared + the active color

```bash
# Bring up the long-lived shared trio (LB / shared DB / backup sidecar).
( source Deploy/deployment-utils.sh && load_environment && compose_shared up && wait_healthy km-db )

# Initialize / migrate the shared schema (expand/contract).
python db/migrate.py up

# Bring up the recorded active color and assert routing.
( source Deploy/deployment-utils.sh && load_environment \
    && compose_color "$ACTIVE_ENVIRONMENT" up \
    && update_nginx_config "$ACTIVE_ENVIRONMENT" )
Deploy/bg-health.sh                              # prod + LB liveness PASS
```

Pass criteria: km-db healthy; the active color's three containers reach `healthy`
(the km-server healthcheck added in C-SF1 is what `wait_healthy` polls); `:1840`
serves `/health` 200 and `:1840/healthz` (LB own liveness) 200.

### 8.3 Deploy to inactive + validate on :1841

```bash
Deploy/azure-deploy-inactive.sh "$(git rev-parse --short HEAD)"
```

Pass criteria: pre-deploy backup taken BEFORE migrate; migrate dry-run then apply
succeed (a non-additive migration ABORTS here); the inactive trio reaches healthy;
`:1841` serves `/health` 200. The active color keeps serving `:1840` throughout.
Note (C-SF2): `:1841` is for automated/unauthenticated checks — a browser cannot
exercise authenticated flows there (CORS + SameSite=Strict are scoped to the prod
origin); that is by design.

### 8.4 Switch + verify :1840 (with auto-rollback)

```bash
Deploy/azure-switch-production.sh "$(git rev-parse --short HEAD)"
Deploy/check-active-env.sh                       # .env and live LB agree
```

Pass criteria: the split-brain gate passes (S-SF3); the flip happens; `:1840` is
healthy on the new color; ONLY THEN is `ACTIVE_ENVIRONMENT` persisted (S-SF1).
Negative test (optional, in a window): force a post-switch failure and confirm the
flip auto-rolls-back to the prior color and exits non-zero, with `.env` still on
the prior color.

### 8.5 Backup / restore drill

```bash
Deploy/db-backup.sh
Deploy/db-validate.sh "$BACKUP_DIR/<the dump just written>"

# Full restore drill (DESTRUCTIVE — only in a recovery window). After the restore,
# reconcile the schema before serving (P-SF3): a restored OLDER dump can be behind
# the deployed code, so forward-migrate if `status` reports drift.
Deploy/db-restore.sh "$BACKUP_DIR/<dump>" --force
python db/migrate.py status     # 1. is the restored dump behind the running code?
python db/migrate.py up         # 2. IF behind: forward-migrate. CAVEATS: a
#    pre-045 dump hits the destructive gate at 045 (re-run with
#    --allow-destructive after reading 045's header), and migrating through
#    046 is NOT old-code-safe — only do it with the serving color stopped or
#    already on post-046 code (Deploy/README.md, "Shipping Phase-2 Group 1").
Deploy/rebuild-environment.sh   # 3. restart the active color so it reconnects
```

Pass criteria: backup writes a `0600` `km-<stamp>.dump`; `db-validate.sh` restores
it into a scratch DB and reports a clean structural match (row-count drift may be
expected). The restore drill drops/recreates the shared DB and the schema is
reconciled forward before the app reconnects.

> Note (P-SF6): `backup-info.txt` describes only the **latest** dump (overwritten
> each run). For an older dump, read it directly with
> `docker exec km-db pg_restore --list "/backups/km-<stamp>.dump"`.

### 8.6 Security spot-checks (deploy surface)

```bash
# Only the LB faces the host's non-loopback interface; db/kiwi/client never do.
ss -tlnp | grep -E ':(1840|1841)\b'              # bound to host (LB only)
ss -tlnp | grep -E '127\.0\.0\.1:(1842|1843|5432)\b'  # loopback-only
# kiwi has no egress (km-internal internal:true).
docker exec km-kiwi-"$(Deploy/check-active-env.sh --get-active)" \
  sh -c 'wget -qO- --timeout=3 https://example.com' ; echo "exit=$?"  # expect failure (no egress)
```

Pass criteria: 1840/1841 host-bound; 1842/1843/5432 loopback-only; kiwi egress
blocked; no secret in any committed Deploy file.

## Checklist

- [ ] §1 migrations 001–025 apply + round-trip
- [ ] §2 tsc 0 · eslint 0 · full vitest green (incl. route + `auth.mfa` suites)
- [ ] §3 real-Claude smoke (4 pass) + Vision case added & passing
- [ ] §4 loaders idempotent, row counts sane
- [ ] §5 SW registers · offline shell · install flow · Lighthouse PWA+a11y ≥ 90
- [ ] §6 SW excludes the API · `npm audit --omit=dev` 0 (post FU-NF-44)
- [ ] §7a prod auth: key generated+backed up · registration locked · account seeded · enroll/code/recovery/lockout smoked
- [ ] §8.1 **`km-production` approval check verified (≥1 approver) — HARD GATE**
- [ ] §8.2 shared + active color up · km-db + trio healthy · `:1840` health 200
- [ ] §8.3 deploy-inactive: backup-before-migrate · inactive healthy · `:1841` 200
- [ ] §8.4 switch: split-brain gate · `:1840` healthy on new color · state persisted after verify · rollback works
- [ ] §8.5 backup `0600` · `db-validate` structural match · restore→status→up→restart
- [ ] §8.6 1840/1841 host-bound · 1842/1843/5432 loopback · kiwi no egress · no secret committed
- [ ] §7 promote rebuild → main
