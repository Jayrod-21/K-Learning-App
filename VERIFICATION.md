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
python db/migrate.py up                  # expect 001 … 022 applied, no error
# round-trip the most recent ones down then up to prove reversibility
python db/migrate.py down --to 019       # 022 → 021 → 020 → 019 downgrade cleanly
python db/migrate.py up                  # back to 022
```

Pass criteria: forward applies 001–022 with no error; the down/up round-trip
succeeds (each `*.down.sql` reverses its `*.up.sql`). New since the last run:
018 = `users.preferences` JSONB; 019 = `grammar_drill_attempts`; 020 = the
grammar-production-card unique index; 021 = the `user_mined` corpus enum value
(its down is a documented no-op — Postgres has no DROP VALUE); 022 = the
`user_mined` vocab CHECK relaxations + corpus_sources seed (the 021→022 split is
required — a freshly-added enum value can't be used in the tx that adds it).
This down round-trip is where 020–022's reversibility is exercised (closes the
FU-NF-33-review note that the downs were reasoned but not yet run).

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
npx vitest run                           # FULL suite — unit + Docker-gated routes
```

Pass criteria: tsc 0; eslint 0; **all** vitest files pass (the 23 route suites
that only collected in the sandbox now execute against real Postgres — incl.
the Pass-9 `settings` + `grammarDrill` route tests). The in-memory unit tests
(128 today) must stay green.

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
4. Deploy to dad's home Postgres + serve via the Cloudflare Tunnel.

## Outstanding before/with this pass

- **FU-NF-44** — bump `@anthropic-ai/sdk` 0.80 → current (clears the 2 prod
  moderates; verify with §2 + §3 + tsc since it touches every Claude path).
- **FU-NF-43 (c)** — confirmed here: the route suites run green under Docker.
- The §3 Vision smoke case (above).

## Checklist

- [ ] §1 migrations 001–019 apply + round-trip
- [ ] §2 tsc 0 · eslint 0 · full vitest green (incl. route suites)
- [ ] §3 real-Claude smoke (4 pass) + Vision case added & passing
- [ ] §4 loaders idempotent, row counts sane
- [ ] §5 SW registers · offline shell · install flow · Lighthouse PWA+a11y ≥ 90
- [ ] §6 SW excludes the API · `npm audit --omit=dev` 0 (post FU-NF-44)
- [ ] §7 promote rebuild → main
