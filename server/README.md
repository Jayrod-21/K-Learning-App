# Korean Master — API server

Express + TypeScript API for the Korean Master app. Owns auth, sessions,
Postgres access, and proxies for the Kiwi (B1) and Claude (B4) services.

## Requirements

- Node **>=20.19** (declared in `package.json`'s `engines`). Prod/CI/Docker all
  run Node 22 (`server/Dockerfile`, `.github/workflows/ci.yml`,
  `Deploy/local-test.sh`) — 22 is the intended runtime. The `engines` floor is
  set to 20.19 rather than `>=22` so `npm ci`/`npm install` don't hard-fail on
  a host still running Node 20.x (uuid@14's actual undeclared floor, per its
  `require(esm)` support — see the rationale comment atop `server/Dockerfile`);
  it does not weaken the CI/Docker guarantee, since those environments already
  pin the 22 image/action version directly. (F-085)

## Stack

- TypeScript (strict mode, `noUncheckedIndexedAccess`)
- Express 4
- Postgres 16 via `pg` (see [ADR-018](../db/docs/ADR-018-server-stack.md))
- Argon2id passwords via `@node-rs/argon2`
- Zod for request validation
- Pino for structured logging
- Helmet + CORS for HTTP hardening
- Vitest + testcontainers for integration tests

## Layout

```
src/
  app.ts                    Express app factory (createApp())
  index.ts                  Server entry point — main()
  config/index.ts           Env-var schema (Zod) + loadConfig()
  logging.ts                Pino + redaction
  db/pool.ts                Pool wrapper — parameterized queries only
  auth/passwords.ts         Argon2id hash/verify
  auth/sessions.ts          Opaque session tokens, cookie helpers
  middleware/
    auth.ts                 requireAuth — cookie session → req.user
    correlation.ts          UUID per request, child logger
    errors.ts               Domain errors + central handler
    rateLimits.ts           cheap / expensive / auth buckets
    validate.ts             Zod request-validation helpers
  services/
    kiwi.ts                 Kiwi proxy (B1)
    claudeProxy.ts          Claude proxy seam (B4 injectable)
  routes/
    auth.ts                 register / login / logout / me
    lemmatize.ts            POST /lemmatize → B1
    define.ts               GET  /define   → KRDICT (B2)
    enrich.ts               POST /enrich   → B4
    gradeWriting.ts         POST /grade-writing → B4
    progress.ts             Study log + named metrics
    vocab.ts                Vocab corpus + FSRS cards
    reading.ts              TTMIK / Iyagi units + sentences
    grammar.ts              KGIU corpus + user grammar bank + identify
    conversation.ts         AI tutor sessions
    health.ts               GET /health (DB ping)

tests/
  auth.test.ts              Register/login/logout/me, rate-limit, zod
  lemmatize.test.ts         Kiwi proxy (mock server)
  health.test.ts            Health endpoint
  helpers/
    pg.ts                   testcontainers Postgres + migrations
    app.ts                  Build the app against the test DB
```

## Environment

Configuration is read from environment variables. The schema is in
`src/config/index.ts` and validated at startup — invalid config crashes
the process. All variables:

| Name | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`/`test`/`production` |
| `PORT` | no | `3001` | |
| `DATABASE_URL` | yes | — | `postgres://user:pass@host:5432/db` |
| `DATABASE_POOL_MAX` | no | `10` | |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no | `5000` | Per-session timeout |
| `KIWI_URL` | yes | — | Base URL of B1's Kiwi service |
| `CLAUDE_PROXY_URL` | no | — | Reserved for future direct-link variant |
| `SESSION_COOKIE_NAME` | no | `km_sid` | |
| `SESSION_LIFETIME_DAYS` | no | `30` | Absolute expiry |
| `SESSION_IDLE_TIMEOUT_DAYS` | no | `7` | App-enforced (ADR-002) |
| `CLIENT_ORIGIN` | yes | — | Single pinned CORS origin |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | |
| `RATE_LIMIT_CHEAP_MAX` | no | `120` | per IP per window |
| `RATE_LIMIT_EXPENSIVE_MAX` | no | `20` | per user/IP per window |
| `RATE_LIMIT_AUTH_MAX` | no | `10` | per IP per window (failures only) |
| `LOG_LEVEL` | no | `info` | pino levels |

## Endpoints

Auth:
- `POST /auth/register {email, password, display_name?}`
- `POST /auth/login {email, password}`
- `POST /auth/logout`
- `GET  /auth/me`

Engine:
- `POST /lemmatize {text}` — proxy to Kiwi
- `GET  /define?word=…` — KRDICT lookup (returns 503 if B2 not deployed)
- `POST /enrich {lemma, source_sentence, context?}` — Claude enrich
- `POST /grade-writing {prompt, user_answer, rubric_version, target_level}`

App:
- `GET  /progress`, `PUT /progress/:metricType {value}`, `POST /progress/study-log`
- `GET  /vocab/entries?...`, `GET /vocab/entries/:entryId`, `GET /vocab/cards/due`,
  `POST /vocab/cards/init {corpus, proficiency?, limit}`,
  `POST /vocab/cards/:cardId/reviews {…FSRS payload…, expected_version}`
- `POST /conversation`, `POST /conversation/:id/messages`, `GET /conversation`
- `GET  /grammar/kgiu?...`, `GET /grammar/kgiu/:id`, `POST /grammar/bank`,
  `GET /grammar/bank`, `POST /grammar/identify {span, sentence}`
- `GET  /reading/units?corpus=ttmik|iyagi&...`,
  `GET /reading/units/:corpus/:unitId/sentences`

System:
- `GET /health`

All authenticated routes use cookie sessions (`km_sid`).

## How to run

```
npm install
npm run build
npm start
```

Dev mode (auto-reload):

```
npm run dev
```

## How to test

The tests boot a real Postgres in Docker via `testcontainers-node`,
apply every migration in `Repository/db/migrations/`, then exercise
the API through Supertest.

```
npm test
```

Requires Docker (or a Docker-compatible container runtime — Podman with
`DOCKER_HOST` exported also works).

Tests are slow on cold start (Postgres warm-up) — ~30s. The container is
reused per test file.

## Coordination with parallel agents

- **B1 (Kiwi):** This server proxies to `${KIWI_URL}/lemmatize`.
- **B2 (KRDICT):** `/define` queries `krdict_entries` (table from migration 003).
  Until B2 ships, the endpoint returns 503 with a clear message.
- **B4 (Claude):** `setClaudeProxy()` registers the proxy implementation;
  `/enrich`, `/grade-writing`, and `/grammar/identify` go through it. In
  development without B4, set up a stub via `setClaudeProxy({ ... })`.

## Gotchas

- `cookie-parser` must be wired before any route that reads cookies; the
  app factory does it in the right order — don't reorder.
- The DB pool is held in a module-level singleton. Tests swap it via
  `setPoolForTesting(pool)`; production never touches that path.
- `trust proxy` is set to `1` so `req.ip` and rate-limit keying use the
  upstream-supplied IP. If you change the proxy topology, revisit this.
