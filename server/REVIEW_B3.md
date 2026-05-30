# Review: B3 — Express API + corpus loaders

**Reviewer:** Independent senior (30y) — did not author the code.
**Date:** 2026-05-28
**Scope:** `Repository/server/`, `Repository/db/migrations/005_*`,
`Repository/tools/ingest/load_to_postgres.py`, `Repository/tools/ingest/loaders/`,
`Repository/tools/ingest/tests/test_load_*.py`, ADR-018, ADR-019, SECURITY.md.

## Summary verdict

**PASS WITH CONDITIONS** — the security-critical surface (auth, sessions,
SQL, rate limits, CORS, helmet, correlation IDs) is genuinely well done and
ADR-002-compliant; the migration is clean and reversible; loaders are
idempotent and resumable. Conditions are (a) loader tests do not cover
the resume / idempotency / sha256-change properties that ADR-019 §D10
explicitly committed to, and (b) several routes still rely on
`req.user!.id` non-null assertions which `tsconfig` strict mode tolerates
but the bar treats as a code smell. None of these are security blockers.

## Bar checklist (§5)

| # | Bar item | Status | Notes |
|---|---|---|---|
| 1 | Lint passes (no warnings) | Unknown | No lint config committed; `eslint` declared in deps but no `.eslintrc.*` found. |
| 2 | Type-check passes (strict mode) | PASS | `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noImplicitReturns`. No `any` in audited files. |
| 3 | All tests pass | Not run by reviewer | Test suite is well-shaped (Vitest + testcontainers). |
| 4 | Every public function tested | PARTIAL | Auth and lemmatize have tests; `/define`, `/enrich`, `/grade-writing`, `/progress`, `/vocab`, `/grammar`, `/reading`, `/conversation` have NO route tests in `tests/`. |
| 5 | EXPLAIN ANALYZE on non-trivial queries | Not verified | No EXPLAIN artifacts in this PR. Most queries are single-table single-row lookups on indexed columns; the `/vocab/cards/init` CTE is the only complex one and is unindexed-specific. |
| 6 | SECURITY.md with attack-vectors | PASS | `server/SECURITY.md` is substantive — concrete threats + concrete defenses, not boilerplate. |
| 7 | README.md with "how to test" | PASS | Clear, accurate. |
| 8 | ADRs for non-obvious decisions | PASS | ADR-018 (server stack) and ADR-019 (loader orchestration) are well written. |
| 9 | Migrations reversible AND tested both directions | PARTIAL | `005.down.sql` is complete and ordered correctly; no automated up/down round-trip test artifact in this PR. |
| 10 | No `TODO`/`FIXME` without ticket | PASS (minor) | One unticketed `TODO` in `SECURITY.md` §2.1 ("ESLint rule TODO: ban pool.query") and §6.1 ("Dependabot watches the repo (TODO: enable)"). Documentation TODOs, not code. |
| 11 | No `console.log`/`print()` | PASS | `config/index.ts:61` uses `console.error` deliberately at startup before the logger is constructed, with an eslint-disable comment. Acceptable. |
| 12 | No commented-out code | PASS in TS. Stale `.js` stub files in `server/src/**` are explicit "// Deprecated" one-liners — leftover from harness inability to delete; ugly but not commented-out logic. |
| 13 | No hardcoded secrets/URLs/paths | PASS | Everything env-driven via Zod. `.env.example` ships safe placeholders. |

## Findings

### BLOCKER
*(none)*

### SHOULD-FIX
1. **Loader tests skip the resume/idempotency/sha256 properties ADR-019 §D10 promised.**
2. **Stale `.js` stub files clutter `src/` and conflict with TS resolution conventions.**
3. **CORS config inconsistency — `.env.example` uses `CLIENT_URL`, code reads `CLIENT_ORIGIN`.**
4. **Non-null assertions on `req.user!.id` throughout the routes.**
5. **`/define` uses one-shot cache for KRDICT availability — never re-checks if B2 ships later.**
6. **`load_state.last_item_id` resume logic is correct but mis-accounted for the `skipped_running` counter.**
7. **`@anthropic-ai/sdk` listed as a direct server dependency.**
8. **Per-route tests are missing for everything beyond `/auth`, `/health`, `/lemmatize`.**

### NIT
- `loaders/load_*.py` open/close 3 separate connection-from-pool contexts per file (initial transaction, per-batch transactions, final count query, final mark_complete). Could collapse the post-loop count-and-mark into a single connection. Performance is fine; tidiness matter only.
- `routes/define.ts:85` raises `NotFoundError(\`no dictionary entry for "${word}"\`)` — echoes raw user input back in the error message. Length-capped (64 chars) by the Zod schema, but still preferable to keep the message constant and put the input in `details`.
- `routes/auth.ts:40` regex `^[^@\s]+@[^@\s]+\.[^@\s]+$` is redundant with Zod's `.email()` and slightly stricter; pick one.
- `migrations/005`: `uq_iyagi_episodes_number UNIQUE (episode_number)` (line 220) means two distinct podcast feeds can never share an episode_number. Iyagi only has one feed today, so this is fine — flag for the day a second feed exists.
- The dummy hash in `auth/passwords.ts:56` is a literal not generated at process start — anyone who reads source knows the exact stored bytes. Doesn't matter (it's only used to consume CPU time on missing users), but mention-worthy.

### PRAISE
- The pool wrapper (`db/pool.ts`) and ESLint plan to ban raw `pool.query` outside that file is exactly the right way to enforce "parameterized queries always" — the framework physically discourages footguns rather than relying on review.
- Argon2id implementation is precisely as ADR-002 specifies: PHC-encoded, parameter-rotatable, dummy-verify path for missing users, byte-cap on input, identical timing+shape between "unknown user" and "wrong password".
- Session module: opaque 32-byte token, base64url-encoded for the cookie, SHA-256 stored in DB, lookup short-circuits malformed shapes BEFORE hitting the DB (`/^[A-Za-z0-9_-]{42,44}$/`), idle-timeout enforced at app layer with auto-revocation, rotation = new row never `expires_at` mutation. Exactly the design.
- Correlation middleware sanitizes inbound IDs against `^[A-Za-z0-9_-]{1,128}$` to prevent log-injection — a defense most teams forget.
- Migration 005: `CHECK (jsonb_typeof(passages) = 'object')`, `CHECK (jsonb_typeof(options) = 'array')`, `content_hash ~ '^[0-9a-f]{64}$'` — the table actively rejects bad shapes instead of merely documenting them.
- The `topik_items` design correctly implements the DESIGN_SPEC's "one pool, two assembly modes" — the FK to `topik_tests` preserves mock-test reassembly while `(corpus, source_id)` UNIQUE lets the study-mode random draw work without joins.
- Loader orchestrator's `load_state` table is the right abstraction: every loader resumes via the same checkpoint contract; operators can inspect state with one SELECT.
- SECURITY.md goes beyond rote OWASP enumeration. §2.3 (log-injection), §3.1 (IDOR defense-in-depth), §7 (no homegrown crypto, no JWT keys), §9 (explicit defer list) are the kind of detail that distinguish a designed threat model from a checklist.

## Detailed findings

### SHOULD-FIX 1 — Loader tests miss ADR-019 §D10 properties

File: `Repository/tools/ingest/tests/test_load_kgiu.py:70-85`
File: `Repository/tools/ingest/tests/test_load_ttmik.py`, `test_load_iyagi.py`, `test_load_topik.py`, `test_load_vocab_2000.py` (same shape — I sampled the kgiu one)

ADR-019 §D10 explicitly enumerates five properties every loader test must
cover:
1. Correct row counts — *covered*.
2. FK integrity — *implied by count + cascade*; not explicit.
3. **Resume — kill after N items, restart, assert final count = fixture.** *Not covered.*
4. **Idempotency — load twice, assert row count stable.** *Not covered.*
5. **Sha256 change detection — modify fixture, re-run without --force, assert re-load.** *Not covered.*

The single test (`test_kgiu_loader_writes_expected_counts`) loads the
fixture once and asserts row count. This is the single happy-path
property. Resume and idempotency are the *interesting* properties — the
ones the implementation is non-trivial for. Without them, regressions
in the upsert/checkpoint code are invisible to CI.

Recommendation: at minimum, add a second test per family that calls
`load()` twice in a row and asserts (a) row count unchanged and (b) the
second result's `loaded` is 0 (or `skipped` equals the fixture size).
A resume test can mock `mark_in_progress` and then call `load()` again.

### SHOULD-FIX 2 — Stale `.js` stub files in `src/`

Files: `server/src/index.js`, `server/src/middleware/auth.js`,
`server/src/routes/{progress,vocab,conversation,grammar,reading}.js`,
`server/src/services/{claudeService,supabaseService}.js`

Each file is a 1-2 line `module.exports = {}` with a `// Deprecated`
comment claiming "the harness cannot delete it". With `"type":
"commonjs"` and the build path going through `dist/`, these don't break
production. But:

- They contradict bar §"Process — No commented-out code (use git history)".
- Any developer doing a directory listing or grep over `src/` will land
  on them and wonder. The README's `Layout` table lists only `.ts` files;
  the directory contains parallel `.js` files saying "deprecated". That
  cognitive overhead is not free.
- The claim "the harness cannot delete it" is not a fact — it can; the
  stubs are choices.

Recommendation: `git rm` the eight stub files. If the prior schema requires
them as placeholders, document why in one README sentence.

### SHOULD-FIX 3 — `.env.example` ↔ config mismatch

File: `server/.env.example:5` declares `CLIENT_URL=http://localhost:5173`.
File: `server/src/config/index.ts:36` requires `CLIENT_ORIGIN`.

A developer following `.env.example` to set up a local environment will
get a startup crash: "Invalid configuration … CLIENT_ORIGIN is required".
The `.env.example` also predates the Postgres move — it carries Anthropic
key and Claude tuning vars but does not surface SESSION_*/RATE_LIMIT_*/
CLIENT_ORIGIN/KIWI_URL.

Recommendation: regenerate `.env.example` from the Zod schema. The README
table already has the source of truth; the example file should mirror it.

### SHOULD-FIX 4 — `req.user!.id` non-null assertions

Files: `server/src/routes/progress.ts:38,81,108`, `routes/vocab.ts:84,143,235`,
and similar in other routes.

`requireAuth` populates `req.user` and `req.session`, so the assertion is
correct in practice. But:

- TypeScript's `!` is exactly the unsafe escape hatch the bar §"Type
  safety" wants to avoid.
- A future refactor that mounts a route without `requireAuth` will crash
  at runtime instead of failing at compile time.

Recommendation: either (a) define an `AuthenticatedRequest` type whose
`user` is non-optional and have `requireAuth` widen the type, or (b) a
small helper `getUserId(req): number` that throws a typed error if
absent. The current pattern works but isn't aligned with the strictness
the rest of the file demonstrates.

### SHOULD-FIX 5 — `/define` caches KRDICT availability forever

File: `server/src/routes/define.ts:36-51`

`_krdictReady` is set on the first call and never invalidated. If B2
ships *after* the server has been running, every request continues to
hit the 503 path until the server restarts. This isn't theoretically
wrong (operators restart on deploy), but the comment "Cache the
existence check so we don't probe pg_class on every request"
underestimates the cost: an `EXISTS` query on `information_schema`
against an internal pool is microseconds.

Recommendation: either drop the cache entirely (lookup is cheap), or
add a TTL (e.g., re-check every 5 minutes) so a freshly-deployed B2 is
visible without an API restart.

### SHOULD-FIX 6 — `skipped_running` mis-accounting in load_kgiu

File: `Repository/tools/ingest/loaders/load_kgiu.py:96-98`

```python
if cp.status == "in_progress" and cp.last_item_id:
    batch = [b for b in batch if b.id > cp.last_item_id]
    if not batch:
        skipped_running += cfg.batch_size  # ← wrong magnitude
        continue
```

When the filtered batch is empty, the counter adds `cfg.batch_size`
(e.g. 200), but the original pre-filter batch may have been smaller
than the configured batch size (the final batch slice from `batched`).
Cosmetic — affects only the return-value `skipped` count visible to
operators; doesn't affect DB state. Worth fixing for honest telemetry.

Recommendation: capture `original_size = len(batch)` before the filter
and add that to `skipped_running`.

### SHOULD-FIX 7 — `@anthropic-ai/sdk` dependency on the server

File: `server/package.json:18` lists `"@anthropic-ai/sdk": "^0.80.0"` as
a direct server dependency.

`claudeProxy.ts:13` explicitly says "we never import @anthropic-ai/sdk
here." If B4's module is the boundary, the SDK should be B4's transitive
dependency — not a top-level dependency of the server package. Having
the SDK in `package.json` means an `npm audit` finding in the SDK
shows up against the server even when the server doesn't load it, and
makes it possible for a future change in `server/src` to accidentally
import the SDK directly.

Recommendation: remove the SDK from the server's `dependencies`. Let it
come in transitively via B4 (`services/claude/*`).

### SHOULD-FIX 8 — Route tests cover ~25% of the surface

Files in `server/tests/`: `auth.test.ts`, `health.test.ts`,
`lemmatize.test.ts`. That's it.

The bar (§5 #4) says "every public function tested". The README
advertises 14 endpoints; 3 of them are tested. `/progress` (with the
defense-in-depth ownership middleware), `/vocab/cards/:id/reviews`
(with optimistic concurrency), and `/grammar/identify` (which proxies
to Claude) are the highest-leverage to add — they're the ones with
non-trivial logic worth regression-protecting.

Recommendation: add at least one happy-path + one auth-failure test
per route file. The testcontainers harness is already there.

## Coordination observations

- **Migration numbering:** 005 correctly takes the next slot after B4's
  004. No collision. Comment block at the top names the dependencies
  correctly (001 enums, 002 corpus_sources, 003/004 numbering only).
- **B4 boundary:** `services/claudeProxy.ts` correctly wraps B4 behind
  a `setClaudeProxy()` seam — the proxy is built at startup
  (`index.ts:21`) and the route handlers call `getClaudeProxy()`. No
  direct Anthropic-SDK usage in B3-owned code (modulo the
  `package.json` finding above).
- **B1 boundary:** `services/kiwi.ts` proxies cleanly with timeout +
  single retry on connect errors only (not 4xx). Zod-validates the
  response shape before returning. Good.
- **B2 boundary:** `/define` degrades gracefully via the
  `information_schema` existence probe (503 with explanatory message
  rather than 500). See SHOULD-FIX 5 for the TTL nit.
- **ADR-013 transaction ownership:** Migration 005 .up and .down both
  have explicit comment banners saying "no top-level BEGIN/COMMIT" and
  honor it. Confirmed by reading both files.
- **ADR-001 §D8 enums:** `topik_item_type` is created in 005 with
  `multiple_choice, short_answer_blanks, chart_description, essay`,
  which matches the DESIGN_SPEC TOPIK item shapes. The other enums
  (`corpus`, `topik_section`, `book_level`, `proficiency_level`) are
  reused from 001, not re-declared. Correct.
