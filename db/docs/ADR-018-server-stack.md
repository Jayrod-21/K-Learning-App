# ADR-018: Server stack — Postgres client and auth library choices

**Status:** Accepted
**Date:** 2026-05-28
**Owner:** Agent B3 (server + loaders)
**Depends on:** ADR-001 (foundation), ADR-002 (auth model)

## Context

We need to commit to specific libraries for the Express server before we
can ship route handlers. Two questions a reasonable engineer would have
preferences on:

1. Which Postgres client?
2. Which Argon2 binding?

## Decisions

### D1. Postgres client: `pg` (node-postgres), not `postgres.js`

- **Why `pg`:**
  - Mature, ubiquitous, well-understood. Senior engineers know its quirks.
  - `pg.Pool` has been the default choice for ~a decade; lots of operational
    knowledge in the field (idle timeouts, statement timeout per session,
    `application_name`, `keepAlive`).
  - First-class TypeScript types via `@types/pg`.
  - Stable connection-pool semantics — `pool.connect()` returns a typed
    `PoolClient` you can pass to a transactional helper. Easy to wrap.
- **Why not `postgres.js`:**
  - Faster on microbenchmarks, but the difference doesn't show in our
    workload (request latency is dominated by Postgres planner + Korean
    text search, not the wire driver).
  - Its tagged-template-literal API is genuinely nice (`sql\`SELECT … ${id}\``
    is auto-parameterized) but it also makes ad-hoc string concatenation
    *look* like raw SQL — easier to footgun. With `pg`, all caller-facing
    SQL goes through our wrapper `query(text, params)`, which is verbose
    enough that it draws attention to the boundary.
  - Pool semantics are more opinionated (their `END` requires more care).
- **Consequence:** The whole codebase imports `query` and `withTransaction`
  from `src/db/pool.ts`; no direct `pool.query` calls outside that module.
  We'll add an ESLint rule to enforce this once the lint config lands.

### D2. Argon2 binding: `@node-rs/argon2`, not `argon2` (node-gyp)

- **Why `@node-rs/argon2`:**
  - Pure Rust binding via Napi-RS, prebuilt binaries for the platforms we
    target (linux-x64, linux-arm64, darwin-arm64). Doesn't drag node-gyp +
    Python + C toolchain into the install path — same toolchain as some of
    our other npm deps.
  - Actively maintained; the maintainer (lyonbot / cyclism / authors of
    the napi-rs umbrella) ships frequent updates.
  - Same Argon2id parameters we'd choose under the `argon2` package; the
    PHC encoding is identical, so we can migrate later if desired without
    a data migration.
- **Why not `argon2` (node-gyp variant):**
  - Build-from-source on environments without prebuilts is painful; we hit
    this on multiple ARM workloads in other projects.
- **Why not bcrypt:** see ADR-002 §D1. We're on Argon2id by design.
- **Parameters:** `memoryCost=65536 (64 MiB), timeCost=3, parallelism=1` —
  baseline from ADR-002. Verifier reads params off the PHC string, so we
  can upgrade per-user on next login without a global re-hash.

### D3. Cookie parser: `cookie-parser`

- Drop-in middleware, written by the Express team, no surprises. We don't
  need signed cookies (cookies carry opaque session tokens whose validity
  is checked against the DB; signing would buy nothing and add a key to
  rotate).

### D4. Rate limiter: `express-rate-limit`

- In-memory store is fine for single-instance deployment. When/if we go
  multi-instance, swap the store for `rate-limit-redis` and keep the
  bucket configuration; the rest of the code doesn't change.
- Bar §"Security" — per-IP and per-user separate buckets. We expose both:
  `authLimiter` (IP only, failures-only count), `cheapLimiter` (IP),
  `expensiveLimiter` (user-or-IP).

### D5. HTTP client for upstream calls: `undici`

- Native to Node 18+. We use it for the Kiwi proxy with explicit
  `headersTimeout` and `bodyTimeout`. No need for `axios` or `node-fetch`.

### D6. Test runner: Vitest + testcontainers, NOT SQLite

- Senior bar §"Testing": "No SQLite stand-in." Each test file spins up a
  Postgres 16-alpine container, applies migrations, runs tests, tears
  down. Slow on cold start, but the only way to catch enum/trigger/
  generated-column behavior.
- Vitest over Jest because the test files are TypeScript-first and
  Vitest's TS support is leaner (no ts-jest in the path).

## Consequences

- All env-driven config goes through `src/config/index.ts` (Zod schema).
- All DB access goes through `src/db/pool.ts` (parameterized helper).
- The Argon2id constraint in `users.password_hash` (migration 001) is
  satisfied by every hash this lib produces.
- The Claude proxy is wired via `setClaudeProxy()` so B4 stays a separate
  package — see ADR-019 implied (loader orchestration is its own ADR).

## Open questions

- Whether to introduce `pg-format`/`pg-promise` patterns. **No** — they
  reintroduce the string-concat risk we're avoiding with the wrapper.
- Distributed rate limiting: not now. Document the swap path (`rate-limit-redis`).
