# Server — security threat model

> Per global standing orders: *"WHAT specific attacks exist for this type of
> app and HOW do we defend against each one?"*

This server is the Express API behind the Korean Master app. It owns
authentication, session storage, Postgres access, and proxies the Kiwi
(B1) and Claude (B4) services. Everything user-facing flows through here.

## 1. Authentication — credential attacks

### 1.1 Brute-force / credential stuffing
- **Defense 1:** Argon2id password hashing (`memoryCost=65536 (64 MiB), timeCost=3, parallelism=1`).
  Memory-hard → GPU-cracking economics are unfavorable. Hash encoding is
  stored in `users.password_hash`; the `ck_users_password_hash_argon2id`
  DB constraint enforces the algorithm prefix and length.
- **Defense 2:** Per-IP rate limit on `/auth/login` and `/auth/register`
  via `authLimiter` (default: 10/min/IP, only counts failures).
- **Defense 3:** Login response shape and timing identical for "unknown
  email" and "wrong password" — `verifyPassword` always runs, against a
  dummy hash if the user doesn't exist. Prevents username enumeration.

### 1.2 Session hijacking
- **Defense 1:** Server-side opaque tokens (ADR-002), 32 random bytes
  (256-bit) from `crypto.randomBytes`, stored as SHA-256 hex in the DB.
  A DB read yields hashes, not usable credentials.
- **Defense 2:** Cookie attributes locked:
  - `HttpOnly` → JS can't read the cookie → XSS can't steal the session.
  - `Secure` → cookie only sent over HTTPS (skipped in `development`).
  - `SameSite=Strict` → no cross-site send → CSRF mitigated.
  - `Path=/`, no `Domain` → host-only.
- **Defense 3:** Idle timeout (7d default) + absolute expiry (30d default).
  Rotation = new row, never mutate `expires_at`. Logout = revoke row.

### 1.3 Session fixation
- **Defense:** Login always issues a new session row; we don't accept a
  client-suggested session ID. Tokens are minted server-side only.

### 1.4 Password handling in transit
- **Defense:** All endpoints require HTTPS in production (Cloudflare
  Tunnel + origin TLS). Server enforces `Secure` cookies in non-dev.

## 2. Injection

### 2.1 SQL injection
- **Defense:** Every query uses `$1, $2, …` parameter placeholders.
  The `db/pool.ts` wrapper exists specifically to prevent ad-hoc raw
  queries; callers never touch the raw `Pool`. ESLint rule TODO: ban
  `pool.query` outside that module.
- **Defense:** Zod schemas reject obviously hostile inputs (length caps,
  alphabet caps) before they reach SQL.

### 2.2 NoSQL / JSONB injection
- **Defense:** Inputs destined for JSONB columns are `JSON.stringify`'d
  from Zod-validated objects, then sent as a parameter (`$N::jsonb`).
  Never string-concatenated into SQL.

### 2.3 Log injection
- **Defense:** Inbound correlation IDs are validated against
  `^[A-Za-z0-9_-]{1,128}$` before logging — no newlines, no ANSI escapes
  from upstream callers can corrupt log lines.

## 3. Authorization

### 3.1 IDOR (Insecure Direct Object Reference)
- **Defense:** Every user-state query is scoped by `WHERE user_id = $userId`
  where `$userId` comes from the authenticated session, never the client.
- **Defense:** A defense-in-depth middleware on `/progress` rejects bodies
  whose `user_id` doesn't match the session.
- **Defense:** Optimistic concurrency via the `version` column on
  `conversations` and `vocab_cards` — a stale write returns 409, not a
  silent overwrite.

### 3.2 Privilege escalation via registration
- **Defense:** `RegisterSchema` permits only `{ email, password, display_name? }`.
  Roles/flags cannot be set from the client.

## 4. Data exposure

### 4.1 PII / secrets in logs
- **Defense:** Pino is configured with `redact` covering `password`,
  `password_hash`, `token`, `cookie`, `authorization` (and `*.` variants).
  A typo that nests one of those under another key still gets caught.
- **Defense:** Session tokens NEVER logged. The DB stores SHA-256 hashes;
  we log only the first 8 chars of a `token_hash` for correlation. (Per
  ADR-002 §"Logging".)

### 4.2 Error-message leakage
- **Defense:** `errorHandler` returns generic 500 bodies; stack traces
  log to stderr with the correlation ID. Clients see `{code, message,
  correlationId}` and nothing more.

## 5. DoS / abuse

### 5.1 Slow endpoints / upstream costs
- **Defense:** Per-route rate limits — cheap bucket (define, list,
  reading) at 120/min/IP; expensive bucket (lemmatize, enrich,
  grade-writing, conversation messages) at 20/min/user-or-IP.
- **Defense:** Express body limit at 256 KB. Argon2 input capped at 256
  bytes before hashing. Upstream timeouts 5s (Kiwi).
- **Defense:** DB `statement_timeout` set per session (default 5s).
  Long-running query can't take the pool with it.

### 5.2 Open redirect / CORS
- **Defense:** `cors({ origin: CLIENT_ORIGIN })` — single env-pinned
  origin, with `credentials: true` only because we use cookies. No `*`,
  no reflected `Origin`.

### 5.3 Pool exhaustion via long external I/O
- **Defense:** Claude / Kiwi calls happen OUTSIDE any open transaction.
  `withTransaction` is reserved for short DB-only operations.

## 6. Supply chain

### 6.1 Dependency vulns
- **Defense:** `npm audit` in CI; pinned versions in `package.json`;
  Dependabot watches the repo (TODO: enable).
- **Defense:** Helmet adds standard hardening headers
  (`Content-Security-Policy`, `Strict-Transport-Security`,
  `X-Content-Type-Options`, etc.).

## 7. Cryptography hygiene

- Random: `crypto.randomBytes(32)` for session tokens. Never `Math.random()`.
- Hash: SHA-256 for session-token storage (fast — not a password). Argon2id
  for passwords (slow + memory-hard — what passwords need).
- No homegrown crypto. No JWT signing keys to leak (we chose opaque tokens).

## 8. Operational

### 8.1 What we monitor
- Per-route latency p50/p95/p99 (TODO: ship to Prometheus).
- 4xx / 5xx rate by route (Pino → log shipper).
- Auth failure rate per IP (rate-limiter exports headers, future scrape).
- DB pool utilization (pg client emits stats).

### 8.2 Incident response
- Every error includes a correlation ID returned to the client; users
  can paste it into a support request and we find the request in seconds.
- "Log me out everywhere": ADR-002 §"Open questions" — a single SQL
  UPDATE on `sessions` revokes all of a user's tokens.

## 9. Things explicitly deferred

- **MFA / TOTP:** Single-user app today; ADR-002 §D6 says we add a
  `user_mfa_factors` table when multi-user lands.
- **Email-verification flow:** Schema column `users.email_verified_at`
  exists; verification-token table + sending logic ship with the API
  when we open registration beyond Jared.
- **CAPTCHA on login:** Deferred until traffic shows we need it.
- **WAF:** Cloudflare in front handles this layer.

## 10. Pass 3 surfaces — additional threat model

### 10.1 `PATCH /auth/me` — profile update (display_name / email / phone)

**Threat — email change without verification.** A user (legitimate or
session-hijacker) with a valid cookie can rewrite `users.email`. The
canonical recovery channel (email) now points at an address we never
confirmed control of. Full email-verification is **deferred** per
`Repository/client/SECURITY.md §"Deferred"` — same posture as registration.

**Defences (Pass 3):**
- Authenticated route (`requireAuth` + cookie). Anonymous callers can't
  reach the surface.
- `authLimiter` per-IP bucket — the same rate budget as login. Justified
  inline in the route comment: email/phone rotation in a tight loop is the
  same class of abuse as credential stuffing and should starve on the
  same allowance. A separate `profileLimiter` was considered and rejected
  to keep the rate-limit posture simple.
- Audit: every email change writes a WARN-level structured log with the
  user id, correlation id, and the **domain only** (right of `@`) of both
  the old and new addresses. The local part is PII (§4.1) and is never
  logged.
- `.strict()` Zod schema — extra keys (`role`, `is_admin`, …) are 400'd
  before SQL.
- Phone shape validated by the same regex the DB CHECK enforces
  (`ck_users_phone_shape` — see migration 011) — a payload that passes
  Zod can't trip a constraint violation.
- 23505 / `UNIQUE` violation on email surfaces as a generic 409 with no
  hint about which field collided (matches `/auth/register`).

**Acknowledged residual risk.** Until verification ships, the entire
account-recovery story rests on the cookie remaining uncompromised. The
"log me out everywhere" SQL (ADR-002 §"Open questions") is the manual
recovery path; the password-change endpoint will hard-revoke all sessions
on a successful update.

### 10.2 `/vocab/lists/*` — user-curated vocab lists

**Threat — IDOR / cross-user list access.** A list belongs to exactly one
user. Every read or write path that names a `listId` must verify the
session user owns it.

**Defences:**
- Every query joins `vocab_lists` with `WHERE id = $listId AND user_id =
  $sessionUserId AND deleted_at IS NULL`. A request for another user's
  list yields a 404 with no body — we don't confirm the list exists.
- Append / remove paths take `FOR UPDATE` on the parent row so concurrent
  callers can't race the position-increment math.
- `.strict()` Zod schemas on every body. Path params validated by
  `validateParams`.
- Soft delete is the **only** delete path for lists; membership rows
  hard-delete. There is no admin "purge" endpoint over the wire.

**Threat — corpus tampering via membership API.** `vocab_entries` is
reference data; deleting one under a list is a footgun.

**Defence:** FK `fk_vocab_list_entries_entry` is `ON DELETE RESTRICT`
(migration 012). A corpus-row delete that has live memberships fails
loudly — the operator must clean memberships first.

**Threat — duplicate-add collision under retry.** The UNIQUE constraint on
`(list_id, entry_id)` (migration 012) would surface a generic 500 from a
23505 if we let it. Instead the route detects the duplicate set BEFORE
INSERT and returns 409 with the duplicate ids in the body so the client
can render a meaningful "already in list" message.

### 10.3 `POST /conversation/:id/messages/stream` — Server-Sent Events

**Threat — connection-pool DoS via held streams.** A malicious client
opens streams and never reads them, holding sockets + B4 worker
goroutines hostage.

**Defences:**
- `expensiveLimiter` per-user bucket (default 20/min) caps fresh
  attempts.
- `req.on('close', …)` fires an `AbortController` that propagates to the
  upstream B4 call (see `services/claude/index.ts → generateConversation`
  worker). The persisted-message branch is skipped when the response was
  aborted mid-stream — no half-turn lands in the DB.
- B4's own per-route token-bucket (`CLAUDE_RATE_LIMIT_CONVERSATION`) is
  consumed on cache miss only (`services/claude/SECURITY.md §"Stream
  hijack via abandoned reader"`). Cache hits replay locally with no
  upstream cost.

**Threat — persisted half-turn under upstream failure.** If we persisted
the user turn before the assistant turn was assembled, a stream failure
would leave the conversation with a hanging user message.

**Defence:** persistence is the very last step. Stream errors → SSE
`event:error` frame → close the connection → no DB write. The next
attempt re-streams cleanly.

**Threat — retry storm produces duplicate assistant turns.** A network
blip mid-stream means the client doesn't know if the turn persisted.
Naïve retries double-spend the Claude budget AND insert a duplicate row.

**Defence:** request-level idempotency via `X-Request-Id` header
(matches our correlation-id alphabet `^[A-Za-z0-9_-]{1,128}$`). The
endpoint scans the persisted `messages` JSONB for a prior assistant turn
tagged with that id; if found, the response replays the cached text
without re-streaming. Clients that don't supply the header opt out and
get the legacy semantics. A query-string fallback (`?request_id=…`) is
accepted for environments that strip custom headers.

**Threat — SSE byte-stream corruption from the central error handler.**
The standard `errorHandler` returns JSON. Routing a mid-stream error to
it would write JSON bytes into an already-open SSE response and confuse
every parser downstream.

**Defence:** the streaming handler catches its own errors. Pre-headers
errors `next(err)` cleanly to the standard handler. Post-headers errors
serialize as an SSE `event:error` frame and call `res.end()` — never
`next(err)`.

**Threat — proxy buffering reorders or coalesces frames.** Cloudflare,
nginx, and similar default to buffering responses; with SSE that
delays the streaming UX or — worse — closes the response after a fixed
window.

**Defences:**
- `Cache-Control: no-cache, no-transform` + `Connection: keep-alive` +
  `X-Accel-Buffering: no` set at response open.
- `res.flushHeaders()` called immediately so the client sees the open
  connection before the first delta.

## 11. Bar checks before declaring done

- [x] Parameterized queries — wrapper-enforced, audited in code review.
- [x] Zod at every boundary — body, query, params.
- [x] Per-IP and per-user rate limits in separate buckets.
- [x] HttpOnly+Secure+SameSite=Strict cookies.
- [x] Correlation IDs through every request, in every log line.
- [x] Structured logs with secret redaction.
- [x] Integration tests against a real Postgres in Docker.
- [x] No secrets in code; env via Zod schema.

## 12. Pass 4 surface — additional threat model

### 12.1 `GET /plan/today` — daily study plan

`GET /plan/today` composes the Today screen's plan from existing tables. It is
authenticated, **read-only**, and takes no body, query, or path parameters.

- **AuthZ / IDOR.** The only user identifier is `getUserId(req)`, read from the
  session — never from the request. Every user-scoped query is
  `WHERE user_id = $1` against that value (due count + diagnostic snapshot).
  Content tables (`ttmik_lessons`, `iyagi_episodes`, `writing_prompts`) are
  shared reference data with no per-user rows, so there is no cross-tenant read
  to leak. A test asserts user A's plan never counts user B's due cards.
- **SQL injection.** No client string reaches SQL. The deterministic-selection
  key is built from `user_id` (session-derived) + the day boundary
  (`(now() AT TIME ZONE 'Asia/Seoul')::date`, a server-side SQL expression) +
  the row id, all passed as bound parameters / server-side values, never
  concatenated from input. The 'Asia/Seoul' literal is a fixed string in the
  route source, not a request value. Band-preference params (`book_level`,
  `proficiency_level`) are derived server-side from numeric snapshot estimates
  and cast to their enums; an out-of-range value can only yield NULL (no band
  preference), never an injection.
- **Plan-rollover boundary.** The day component of the selection hash is pinned
  to `(now() AT TIME ZONE 'Asia/Seoul')::date`, so the plan rolls over at
  midnight in the app's target locale regardless of the DB session timezone. A
  bare `current_date` would evaluate in the session `TimeZone` GUC (UTC on a
  stock container), reshuffling the plan mid-morning (09:00 KST) for a
  Korea-resident user. Not a security hole — the endpoint is read-only — but the
  pin keeps the determinism guarantee honest and session-TZ-independent.
- **DoS / cost.** `cheapLimiter` (per-user) caps polling. The handler runs five
  small queries and calls no upstream (no Claude proxy), so it cannot amplify
  cost. The `md5(...)`-ordered selection is `ORDER BY … LIMIT 1`, but `md5` is
  not indexable: Postgres hashes every candidate row and takes the top one — a
  scan + top-1, not index-bounded work. That is acceptable here because the
  corpora are small curated reference banks (hundreds of rows) and `cheapLimiter`
  caps how often the scan can run; the partial index on `writing_prompts`
  narrows the active/band filter but does not satisfy the hash ordering.
- **Output integrity.** Every field is plain data (titles, integer minutes,
  level labels). The client renders them as React children (escaped). No HTML is
  emitted, so no stored-XSS path through corpus titles.
- **Information disclosure.** The response reveals only the user's own due count
  and which modality is weakest — data the user already owns. Raw estimate values
  are never returned, only the derived `largestGap` label, keeping the diagnostic
  scores server-side until the Diagnostic screen (Pass 5) surfaces them
  deliberately.

### 12.2 `writing_prompts` (migration 013)

Shared reference data, no `user_id`, no soft-delete (retired via `is_active`).
Seeded inline with `ON CONFLICT (source_id) DO NOTHING` — re-applying the
migration is idempotent and cannot duplicate or corrupt the bank. No runtime
route mutates this table, so there is no injection or authZ surface beyond the
read in §12.1.

## 13. Pass 5 surface — live Diagnostic (`/diagnostic/*`, migration 014)

Pass 5 turns the Diagnostic screen from a client-graded mock into a real,
adaptive, **server-graded** flow. The endpoints (`server/src/routes/diagnostic.ts`)
start a CAT-lite run, serve one item at a time, grade each answer server-side,
and on finish write a `diagnostic_snapshots` row. Tables: `diagnostic_runs` +
`diagnostic_responses` (migration 014). This section enumerates the attack
vectors specific to a graded assessment and the defenses in place.

### 13.1 Answer tampering — THE security property of this pass

- **Attack.** A graded diagnostic is worthless if the client can see (or set)
  the correct answer. If the served item carried `correct_answer`, a user could
  read it from the network tab and "pass" every item, or POST a forged
  `is_correct: true` to inflate their estimate.
- **Defense — correct answer is column-private + grading is server-side.**
  `diagnostic_responses.correct_answer` (and the `explain` text) live ONLY in the
  database. The wire `ClientItem` is assembled by `toClientItem()`, which copies
  a strict allow-list of fields (`responseId`, `ordinal`, `section`, `level`,
  `kind`, `prompt`, `hint`, `passage`, `underline`, `audio`, `choices`) — it has
  no path to the correct answer or explanation. The client submits only its
  *picked choice id*; the server compares it against the column. The client
  never sends, and the server never trusts, an `is_correct` flag.
- **Defense — reveal only after commit.** The correct choice + explanation are
  returned in the `/answer` response (`result.correctAnswer`, `result.explain`)
  *after* the pick is persisted with `answered_at`. There is no endpoint that
  returns an unanswered item's answer. (A route test asserts the ClientItem on
  both `POST /diagnostic` and the `/answer` `next` item has no `correctAnswer` /
  `explain` property.)

### 13.2 Run ownership / IDOR

- **Attack.** Enumerate `runId` / `responseId` to read or mutate another user's
  run, or to read their snapshot.
- **Defense — every query is user-scoped.** `getUserId(req)` (session-derived) is
  a predicate on every read and write: `loadUserRun` filters `WHERE id = $1 AND
  user_id = $2` and throws `NotFoundError` (404, not 403 — we don't confirm the
  run exists) when the run isn't the caller's. `/finish` and `/latest`/
  `/trajectory` snapshot reads filter `WHERE user_id = $1`. A `runId` or
  `responseId` is NEVER trusted for ownership on its own. (A route test confirms
  user B answering user A's run → 404.)

### 13.3 Double-answer / replay / out-of-order

- **Attack.** Re-POST the same answer (or an arbitrary earlier `responseId`) to
  re-roll the CAT update, or answer items out of order to confuse scoring.
- **Defense — single current item + 409, gated under a row lock.** `/answer`
  grades, bumps θ, and serves the next item INSIDE one transaction that first
  locks the run row `FOR UPDATE`. Under the lock it re-reads "the current
  unanswered item" (lowest-ordinal response with `answered_at IS NULL`), requires
  the body's `responseId` to equal it, and runs the single-shot
  `UPDATE … WHERE id = $1 AND answered_at IS NULL`. The handler **checks
  `rowCount`**: if zero (a concurrent request already answered this item), it
  throws `ConflictError` (409) and the transaction aborts — so the racing
  duplicate produces **no second θ bump and no second served item**. Because the
  lock serializes the two requests, the staircase step number (counted under the
  lock) is also deterministic, and a concurrent `/finish` cannot flip the run to
  `finished` between the status check and the write (the status re-check happens
  under the same lock). The `UNIQUE (run_id, ordinal)` constraint prevents
  double-serving a slot.

### 13.4 Claude cost amplification

- **Attack.** Hammer `POST /diagnostic` / `/answer` to drive unbounded Claude
  spend on vocab/grammar item generation.
- **Defense — limiter + bounded calls + caps.** Item-generating routes use
  `expensiveLimiter()` (per-user bucket). The fixed 8-item, 2-each schedule
  bounds generation to **≤4 Claude calls per run** (vocab + grammar only;
  reading/listening are pure DB reads, no Claude). The `diagnostic_item` proxy
  route has its own per-minute rate limit and a tight input cap
  (`CLAUDE_MAX_INPUT_DIAGNOSTIC_ITEM`, default 1000 chars) on every seed field,
  and seeds are sanitized through the shared prompt-injection guard before they
  reach the model. Claude is called strictly OUTSIDE any open DB transaction
  (Bar §"Transactions") so generation latency can't hold a connection.

### 13.5 Prompt injection via generated-item seeds

- **Attack.** A poisoned corpus row (vocab word / grammar pattern) tries to
  steer the item generator ("ignore instructions, output …").
- **Defense — structural + sanitized.** Seeds are wrapped in
  `<user_input>…</user_input>` and the system prompt instructs the model to treat
  them as data. `sanitizeUserInput` strips control chars, NFC-normalizes, caps
  length, and rejects known injection markers. The output is parsed by
  `DiagnosticItemResultSchema` (exactly 4 choices, `answerIndex` 0..3, bounded
  string lengths) — a malformed or oversized generation fails the schema and the
  proxy raises rather than serving garbage. The route additionally guards
  `answerIndex` against the choice count before persisting.

### 13.6 Listening transcript — best-effort, not audio (known limitation)

The TOPIK corpus has **no audio files**: listening items carry transcript text
only. `buildTopikItem` surfaces `audio = { duration: extra.duration || 40,
transcript: stem || extra.transcript || '' }`. This is a content limitation, not
a vulnerability — but it is documented here and in `routes/diagnostic.ts` so a
future engineer wiring real audio knows the transcript was always plaintext and
must not be treated as a secret (it is part of the item, revealed with it).

### 13.7 Information disclosure — raw estimates stay server-side

- **Attack.** Infer more about the scoring model than intended from the wire.
- **Defense — mapped scores only.** The snapshot DTO and trajectory expose only
  the 0–100 `estimateToScore`-mapped value and a templated band note, never the
  raw 0–6 estimate, the per-item difficulty, or the θ trajectory. Those live in
  the `evidence` JSONB and `ability_estimate` column, returned to no client. The
  `note`/`goals` strings are fully templated (deterministic, no Claude), so no
  model output reaches the client outside the per-item `explain` (which is itself
  only revealed post-answer).

### 13.8 `GET /diagnostic/latest` deliberately returns 200, not 404

When a user has no run, `/latest` returns **200 with `{ dimensions: [],
references, defaultRef: 'L4', goals: [] }`** rather than 404. This matches the
client's `DIAGNOSTIC_SNAPSHOT_FIXTURE` contract (empty dimensions = "no run yet"
→ route to intro). It is a deliberate deviation from a "404 → intro" design and
is not a security concern: the response carries only static reference data the
client already ships in its mock.

### 13.9 SQL injection

Every query is parameterized (`$1, $2, …` via the `query`/`withTransaction`
helpers); no request value is concatenated into SQL. The dynamic `WHERE
proficiency = $n` / `id <> ALL($n)` fragments append only bound-parameter
placeholders, never input. Enum casts (`::topik_section`, `::proficiency_level`)
mean an out-of-range value errors at the cast, it cannot inject.

## 14. Pass 6 surface — TOPIK Prep (`/topik/*`, migration 015)

Pass 6 takes the TOPIK Prep Study mode LIVE and adds the Mock-Test **server
route** (the mock taking UI is deferred to FU-NF-39). The endpoints
(`server/src/routes/topik.ts`) browse the item pool, assemble a mock (full test,
original order) or a study draw (shuffled cross-test), and grade a submitted
answer, logging each attempt to `topik_responses` (migration 015). This section
enumerates the attack vectors and the defenses in place.

### 14.1 Study answers are PUBLIC by design; Mock answers are STRIPPED + server-graded

- **Design fact (Study).** TOPIK items are **public reference data** (real past
  exams, freely available). STUDY mode is a study tool, not a secured assessment,
  so the locked decision (contract §B) is to serve the `correct` flag +
  `explanation` **inline** in every `TopikItemDTO` — `options[i].correct` is set
  on the `(answer − 1)` index, and `explanation` is surfaced. The `/answer`
  route's grade is therefore a *convenience + analytics* record, not a trust
  boundary: a user could compute `correct` client-side from the DTO. The server
  still grades server-side and logs the attempt so analytics ("accuracy", "weak
  areas") are computed from a single, server-owned source of truth, not a
  client-asserted flag (the client never sends `is_correct`).
- **Mock-mode answer-strip + server grading (FU-NF-39 — CLOSED).** MOCK mode is
  the OPPOSITE of study, and follows the Pass-5 Diagnostic pattern because it is a
  scored, timed surface:
  - **Answer-stripped at the boundary.** `POST /topik/mock` returns
    `{ sourceTest, section, items }` where each item is built by `toMockItemDTO`,
    whose return type **`Omit`s `options[].correct` AND the `explanation` field**.
    The strip is **type-level**: the mock wire type has nowhere to carry the
    answer, so a regression that tried to copy `correct`/`explanation` onto a mock
    item would fail to compile. The `correct` flag never reaches a mock client.
  - **Graded server-side.** `POST /topik/mock/submit` loads the section's items
    for `sourceTest` from the DB and grades each submitted `picked` against the
    DB answer — never a client-asserted flag. Skipped items count as incorrect.
    It returns the score (`totalItems/answered/correct/percentage/band`) plus a
    per-item reveal array (`correctChoiceId` + `explanation`) — the answer is
    revealed only NOW, post-exam, mirroring the diagnostic's post-answer reveal.
  - **Section-constrained.** Mock is reading/listening MCQ only; the writing
    section (constructed-response, would route to the gradeWriting engine) is
    rejected at the boundary (400 via `MockSectionSchema`) and **deferred to
    FU-NF-47**. So mock currently strips + grades exactly the two MCQ sections.

### 14.2 Answer log is user-scoped — IDOR / mass-assignment

- **Attack.** Forge a `topik_responses` row under another user's id (to pollute
  their analytics), or read another user's answer history.
- **Defense — session-stamped writes.** Every `topik_responses` row is inserted
  with `getUserId(req)` (session-derived) as `user_id`; the route accepts NO
  client-supplied user id (mass-assignment closed at the boundary — the
  `AnswerBodySchema` is `.strict()` and contains only `picked`/`timeMs`/`mode`).
  Reads (analytics, a future history endpoint) filter `WHERE user_id = $1` against
  the session value and are backed by `ix_topik_responses_user_item` /
  `ix_topik_responses_user_answered_at`. A route test confirms two users each
  answering the SAME public item produce one row apiece, each under their own id.
- **itemId is reference data.** `topik_items` is public and not user-owned, so an
  `itemId` path param carries no ownership to verify — but a missing/ungradeable
  id is a clean 404 (no silent insert against nothing), and the logged row is
  still always the caller's.

### 14.3 SQL injection — parameterized + enum-normalized inputs

- **Attack.** Inject via the `section` / `level` / `source_test` filters or the
  answer body.
- **Defense — bound params + zod-to-enum normalization.** Every query is
  parameterized; no request value is concatenated into SQL. `section` is
  normalized by zod (`SectionSchema`) which accepts EITHER the topik_section enum
  OR the Korean label (`읽기`/`듣기`/`쓰기`) and maps both to the enum string,
  bound and cast `::topik_section`; `level` is a `z.enum(['L3','L4','L5+'])` bound
  and cast `::proficiency_level`; `source_test` is `z.coerce.number().int()`. An
  unrecognized section/level fails validation (400) before reaching SQL, and the
  enum cast would error (not inject) on any value that somehow slipped through.
  The dynamic `WHERE` fragments append only `$n` placeholders, never input.

### 14.4 DoS / cost

- **Attack.** Hammer the study draw or the pool browse to load the DB.
- **Defense — cheapLimiter + bounded reads.** Every `/topik/*` route uses
  `cheapLimiter()` (per-IP). No route calls any upstream (no Claude), so there is
  no cost amplification. `POST /topik/study` is `ORDER BY random() LIMIT n` with
  `n` capped at 50 by `StudyBodySchema`; `GET /topik/items` is `LIMIT`-capped at
  100 with an offset, plus a bounded `count(*)` for the page total; `POST
  /topik/mock` is bounded by a single test's item count (a real TOPIK test is
  ≤70 items). The `random()` order scans the (filtered) pool — acceptable because
  the corpus is a small curated reference bank and the limiter caps how often the
  scan can run; the `ix_topik_items_section_proficiency` index narrows the
  section/level filter even though it cannot satisfy the random ordering.

### 14.5 Output integrity

Every DTO field is plain data (Korean/English option text, integer level/number,
explanation text). The client renders them as React children (escaped); no HTML
is emitted, so there is no stored-XSS path through corpus item/option text.

## 15. Pass 7 surface — Hanja (`/hanja/*`, migration 016)

Pass 7 takes the **Hanja screen** live. The endpoints
(`server/src/routes/hanja.ts`) browse the hanja corpus with the caller's
per-character state folded in, feature one character per day, report the user's
progress counts, and upsert a character's state. The reference data lives in
`hanja_characters` + `hanja_compounds`; the per-user state lives in
`hanja_progress` (all migration 016). This section enumerates the attack vectors
and the defenses in place.

### 15.1 Reference data is PUBLIC — and carries no answer secret

- **Design fact.** `hanja_characters` (reading, gloss, strokes, level,
  frequency) and `hanja_compounds` (containing words) are **public reference
  data** — derived from the Darakwon vocab corpora + the public-domain Unihan
  database. Unlike the Diagnostic (§13), a hanja's reading/gloss is **not a quiz
  answer** that must be withheld: the Hanja screen is a browse/study surface, not
  a scored assessment. Serving the full character record to any authenticated
  user is the intended behavior, not a leak. There is consequently no
  answer-strip and no column-private field on these tables.

### 15.2 Per-user progress is user-scoped — IDOR / mass-assignment

- **Attack.** Forge a `hanja_progress` row under another user's id (to pollute
  their progress), or read another user's state through the list endpoint.
- **Defense — session-stamped writes, session-scoped reads.** Every
  `hanja_progress` write is `INSERT … ON CONFLICT (user_id, char) DO UPDATE`
  with `user_id = getUserId(req)` (session-derived); the route accepts NO
  client-supplied user id. `StateBodySchema` is `.strict()` and contains only
  `state`, so a `userId` smuggled in the body is a 400 (mass-assignment closed at
  the boundary — a route test asserts this). The list join (`GET /hanja`), the
  `/today` weighting, and the `/progress` counts all filter
  `hp.user_id = $1`/`vcrd.user_id = $1` against the session value, never a client
  value — backed by `ix_hanja_progress_user_state`. `UNIQUE (user_id, char)`
  guarantees a user holds at most one state per character, so the upsert can
  never create a second row, and a user can never address another user's row (the
  conflict key includes their own `user_id`). A route test confirms one user's
  banked state does not appear in a second user's list.
- **The `/today` weighting reads only the caller's own data.** The
  recently-mined signal joins `vocab_cards` filtered to `user_id = $1` (and
  `deleted_at IS NULL`); it never reads another user's cards. The fallback and
  the deterministic-per-day pick read only the public corpus.

### 15.3 `:char` param — single-codepoint validation + parameterized SQL

- **Attack.** Inject via the `:char` path param or the `filter` query, or stamp
  progress against a giant/garbage "character" to bloat the table.
- **Defense — zod single-codepoint guard + bound params + DB CHECK.** `:char`
  is validated to **exactly one Unicode codepoint** (`[...s].length === 1`)
  before it reaches SQL; `filter` is a `z.enum(['all','banked','practicing',
  'new'])` (an unknown value is a 400, never SQL). Every query is parameterized —
  no request value is concatenated into SQL; the only dynamic WHERE fragments
  are fixed literals chosen by the validated `filter` enum plus a `$n`
  placeholder. The DB `CHECK (char_length(char) = 1)` on `hanja_progress` is the
  backstop if a codepoint somehow slips the route guard, and the `state` is
  CHECK-constrained at both the zod layer and the column.
- **Decoupled-from-corpus is intentional, not a hole.** `:char` is NOT validated
  against `hanja_characters` (progress survives a corpus reload — see migration
  016). The blast radius of stamping a non-corpus character is one extra,
  one-codepoint, user-owned row that simply never surfaces in the list (which
  LEFT JOINs *from* the corpus) — bounded and harmless.

### 15.4 DoS / cost

- **Attack.** Hammer the list or `/today` to load the DB.
- **Defense — cheapLimiter + bounded reads + indexes.** Every `/hanja/*` route
  uses `cheapLimiter()` (per-IP). No route calls any upstream (no Claude), so
  there is no cost amplification. The corpus is a small curated reference bank
  (~758 rows); `GET /hanja` returns the whole (filtered) set ordered by an
  indexed `frequency DESC`, with compounds aggregated via a per-character LATERAL
  join keyed on the indexed `hanja_compounds.character_id`. `/today` runs three
  bounded `LIMIT 1` queries; `/progress` is five indexed `count(*)` scalars. None
  of these grow with user count — they scan a fixed-size corpus joined to the
  caller's own (indexed) progress rows.

### 15.5 Output integrity

Every DTO field is plain data (the character, Korean/English glosses, integer
strokes, a level string, the compounds' word/gloss strings). The client renders
them as React children (escaped); no HTML is emitted, so there is no stored-XSS
path through the corpus text. Empty-source fields (`gloss_kr`, `etymology`) are
served as `''` (the client's default), never as `null` that could surprise a
consumer.

## 16. Pass 8 surface — Images / OCR mining (`/images/*`, migration 017)

Pass 8 takes the **Images screen** live. The user uploads a photo containing
Korean text; the server runs it through Claude Vision (OCR), stores the photo as
a blob, and persists the mined content words. This pass introduces THREE new
high-value attack surfaces at once — **file uploads**, an **external Vision
call**, and **blob storage** — so it gets the full new-app treatment. The code
lives in `server/src/routes/images.ts` + `server/src/services/imageStore.ts` +
the `image_ocr` Claude route.

### 16.1 Malicious upload — wrong/forged content type

- **Attack.** Upload an SVG (script-bearing), an HTML file, or an executable
  with a `.png` name and `Content-Type: image/png`; or a polyglot file that is a
  valid PNG header glued to script. The goal is stored XSS (if the blob is ever
  served as `text/html`) or RCE on a naive image processor.
- **Defense — NEVER trust the client mime; magic-byte sniff the buffer.** multer
  has a `fileFilter` that drops a declared mime outside the
  `image/jpeg`/`image/png`/`image/webp` allowlist EARLY (so an 8 MiB `.svg`
  isn't even buffered). That filter is a cheap pre-screen, NOT the authority.
  After multer, `sniffImageMime(buffer)` inspects the leading bytes —
  JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WEBP `RIFF…WEBP` — and the
  request is rejected `400` unless the BYTES are a real allowlisted image. A
  renamed SVG/HTML/exe fails the sniff. The DB `mime` column stores the SNIFFED
  type (CHECK-constrained to the allowlist in migration 017), never the client
  value. We do NOT decode/transcode the image (no ImageMagick/sharp), so there
  is no image-parser RCE surface; the bytes are stored verbatim and served back
  with `X-Content-Type-Options: nosniff` so a browser can never reinterpret a
  blob as HTML/JS. Route tests assert both the magic-byte reject and the
  declared-mime reject persist nothing.

### 16.2 Path traversal / filename injection into the blob store

- **Attack.** Use a crafted filename (`../../etc/cron.d/x`, an absolute path, a
  null byte) so the server writes the upload outside the store root or reads an
  arbitrary file back via the blob endpoint.
- **Defense — server-generated UUID paths + resolve-under-root guard.** The blob
  filename is built ENTIRELY from server-trusted values:
  `{sessionUserId}/{serverUUID}.{extFromSniffedMime}`. The client-declared
  filename is stored ONLY for display (`original_filename`, sanitized of control
  chars + path separators + length-capped) and is NEVER part of a filesystem
  path. `saveBlob` guards its inputs (userId is a positive integer, captureId
  matches a UUID regex) and asserts the destination is under the root.
  `readBlob` treats the stored relative path as untrusted on the way back in:
  it rejects absolute paths, `normalize`s, `resolve`s against the root, and
  asserts the result stays under the root (with a trailing-separator-aware
  prefix check so `/var/images-evil` is not accepted for root `/var/images`). A
  traversal trip throws; the blob route maps it (and a missing file) to `404`.

### 16.3 IDOR — reading another user's captures, words, or blobs

- **Attack.** Enumerate capture ids and fetch `/images/:id`, `/images/:id/blob`,
  or pull another user's mining history via the list.
- **Defense — every query is user-scoped via `getUserId(req)`.** The list, the
  single-capture read, and the blob read all filter
  `WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL` against the SESSION
  user — never a client value. Another user's id (or a soft-deleted row) returns
  `404`, not `403`: we don't confirm the existence of a row the caller may not
  see. The blob row's `mime`/`blob_path` are read only after the user-scope
  check passes, so no filesystem touch happens for a row the caller doesn't own.
  Route tests assert the cross-user `404` on both `:id` and `:id/blob`.

### 16.4 Vision cost amplification / DoS

- **Attack.** Hammer `POST /images/ocr` to run up the Anthropic Vision bill, or
  upload huge files to exhaust memory.
- **Defense — per-user daily cap + size cap + per-minute limiter + bounded
  memory.** Before any upstream call, the route counts the user's captures since
  `date_trunc('day', now())` and returns `429` at the configured
  `IMAGE_OCR_DAILY_CAP` (default 20/day). The count includes soft-deleted rows
  so deleting captures can't reset the Vision budget — the cap is a COST control,
  not a storage quota. The 8 MiB `multer` `fileSize` limit bounds both per-call
  Vision cost and per-request memory (memory storage is intrinsically bounded by
  that limit; `files: 1` rejects multi-file floods). An oversize upload trips
  multer's `LIMIT_FILE_SIZE`, which the route maps to **`413` Payload Too Large**
  (the correct HTTP semantic for an oversize body, and the status the client keys
  its "image is too large" copy off — distinct from the `400` it shows for an
  unsupported/forged image); every other `MulterError` (unexpected field, too
  many files/parts) maps to `400`. The Claude proxy's own `image_ocr` per-minute
  limiter (default 10/min) bounds bursts, and `expensiveLimiter` (per-user) sits
  in front of the route. Route tests assert the `429` at the cap and the `413` on
  an oversize upload.

### 16.5 Atomicity — no half-captures on Vision or DB failure

- **Attack / failure mode.** The Vision call succeeds but the DB write fails (or
  vice-versa), leaving a capture row with no words, or words with no row, or a
  blob with no row.
- **Defense — Vision outside the tx, then one transaction for blob + rows.** The
  Vision OCR call happens BEFORE any transaction opens (Bar §1: no external I/O
  inside an open tx — connection-hogging deadlocks are how prod goes down). A
  Vision failure throws → `502 UpstreamError` and NOTHING is written. On success,
  a single `withTransaction` writes the blob, the `image_captures` row, and all
  `image_words` together; any DB error rolls the whole unit back. A blob written
  to disk before a later DB error in the same tx becomes an orphan FILE (harmless,
  GC-able) — never an orphan ROW. The proxy error is mapped to a generic `502`
  that never forwards the upstream's status or provider-specific details to the
  wire (mirrors §13.7 / the diagnostic route).

### 16.6 No bounding boxes (design note, not a hole)

The OCR result carries NO coordinates/boxes (locked decision — Claude Vision's
word transcription is reliable but its geometry is not). `image_words` has no box
columns and the client renders the real photo plus a tappable word list rather
than an overlay. There is consequently no coordinate data to leak or to trust.

### 16.7 Blob serving headers + output integrity

Blobs are served only to the authenticated owner with `Cache-Control: private,
max-age=0, must-revalidate` (never shared-cache), `X-Content-Type-Options:
nosniff` (the browser must honor our content-type, never sniff bytes into an
executable type), and the exact sniffed `mime`. The same-origin `<img src>` sends
the session cookie. Every text DTO field (caption, word glosses) is plain data
the client renders as escaped React children — no HTML is emitted, so there is no
stored-XSS path through OCR text. Empty fields are served as `''`, never `null`.

### 16.8 Deferred / known gaps

- **Blobs are on the LOCAL filesystem, not durable/offsite storage.** A host loss
  loses the photos (the DB rows survive and the blob endpoint then `404`s the
  bytes — handled gracefully, not a 500). Moving to S3 (or equivalent) with
  server-side encryption is the planned follow-up; `blob_path` is stored RELATIVE
  precisely so the root can move without a data migration.
- **No malware scanning / image re-encoding.** We store bytes verbatim and never
  decode them server-side, which removes the image-parser RCE surface but means
  a blob is whatever the user uploaded. `nosniff` + private cache +
  owner-only serving keep that bounded; a ClamAV-style scan is a future option if
  the threat model grows.
- **Down-migration does not delete blob files.** Rolling back 017 drops the rows
  but leaves the files on disk (the store is not transactional with Postgres);
  filesystem cleanup is an operational task (noted in `017_*.down.sql`).
- **OCR-to-vocab banking is NOT wired this pass** — it shares the deferred
  KRDICT→`vocab_entries` mapping (FU-NF-33). The capture/words are stored as
  mining history; banking a word into the SRS deck comes later.

## 17. Pass 9 surface — Settings prefs + Grammar drills (`/settings/*`, `/grammar-drill/*`, migrations 018–019)

Pass 9 adds two server features: a tiny **preferences** sync (`/settings/prefs`,
migration 018) and a **grammar production-drill** loop (`/grammar-drill/*`,
migration 019, two new Claude routes). The preferences route is a low-surface,
cheap, authed CRUD on a JSONB column; the grammar-drill loop is the interesting
surface — it generates a drill, hands the learner a task, then scores their
free-text Korean answer, so it carries the same answer-stripping + IDOR +
scored-once + Claude-cost properties as the Diagnostic (§13).

### 17.1 Preferences — IDOR + unknown-key injection + corrupt-blob resilience

- **Attack.** Read or write another user's preferences; smuggle an unknown key or
  a tampered palette value into the JSONB blob; or poison the column so a later
  read 500s and breaks the Settings screen.
- **Defense.** There is NO `:id` in the path — the subject is always the session
  user (`getUserId(req)`), so cross-user access is structurally impossible.
  `PrefsSchema` is `.strict()` at every level, so `validateBody` rejects an
  unknown key or a bad enum as a clean `400`; the whole blob is REPLACED (not
  merged), so a crafted partial can't smuggle extra keys. On READ, the stored
  blob is re-validated through the SAME schema; an empty `{}` (the migration
  default) or a legacy/corrupt shape falls back to `DEFAULT_PREFS` (logged at
  `warn`), never a `500` — a user's own bad data must not break their screen. No
  Claude, no external I/O → the standard cheap limiter is sufficient. Profile
  PII (name/email/phone) lives in its OWN columns (edited via `PATCH /auth/me`),
  not in this blob, so there is nothing sensitive to leak here.

### 17.2 Drill generation — answer-stripping (THE property of this surface)

- **Attack.** Read the reference model answer off the generation response and
  paste it back as the "production", turning a production drill into a copy
  exercise (a measurement-validity leak, the grammar analogue of the diagnostic's
  correct-answer leak in §13.2).
- **Defense.** The generated item is persisted WITH its reference model
  (`item` JSONB, server-only column), but the generation RESPONSE strips
  `referenceModelKr`/`referenceModelEn` (`toPublicItem` → `DrillItemPublic`). The
  learner never sees the model answer until AFTER they submit. The reference is
  revealed only in the `/submit` response, once an answer is committed. Route
  tests assert the gen response omits both reference fields and that the row
  still stores them.

### 17.3 Drill submit — IDOR + scored-once (concurrent double-submit)

- **Attack.** Submit against another user's `attemptId` to score/overwrite their
  attempt; or double-submit the same attempt concurrently to get two paid Claude
  calls to both land on the row (cost amplification + a non-deterministic final
  score).
- **Defense.** The submit handler loads the attempt scoped to `(id, user_id)`;
  another user's id → `404` (not `403` — don't confirm existence). The scoring
  write is a SINGLE-SHOT `UPDATE … WHERE id=$1 AND user_id=$2 AND scored_at IS
  NULL`. A lone such UPDATE is itself atomic: Postgres serializes the two racers
  on the row write-lock the UPDATE takes, so AT MOST ONE matches the predicate
  (`rowCount 1`) and the loser sees `rowCount 0` → `409` — no separate `FOR
  UPDATE` pre-read is needed (unlike the diagnostic's `/answer`, §13.3, whose
  `FOR UPDATE` read is load-bearing because it derives θ/the pending item under
  the lock; here the score is already computed before the UPDATE, so a lock-read
  would be a redundant round-trip). The cheap pre-load before the Claude call
  spares the already-scored common case a paid call, but it is NOT relied on for
  correctness — the `rowCount` gate is the authoritative single-shot guard. This
  is the same `scored_at IS NULL` gate the diagnostic uses on `answered_at`
  (§13.3). The loser's Claude call is discarded — a paid-but-unused call, bounded
  by the expensive limiter + the proxy's per-route per-minute ceiling.

### 17.4 Claude-fail leaves no half-state

- Generation does the Claude call BEFORE the INSERT, so a `502` writes NO attempt
  row. Submit does the Claude call, THEN the single-shot UPDATE; a `502` leaves
  the row UNSCORED (`scored_at` stays NULL) so the learner can retry, and nothing
  partial is persisted. Claude proxy errors are mapped to a `502 UpstreamError`
  by `mapClaudeError` (mirrors §13/§16) — the upstream status + provider details
  are NEVER forwarded to the wire (§13.7).

### 17.5 Cost amplification + prompt injection via pattern/answer text

- **Cost.** Both routes are behind `expensiveLimiter()` (per-user burst) AND the
  proxy's own per-route per-minute limiter (`generate_grammar_drill` /
  `score_grammar_drill`, 20/min default); the input caps (2 000 / 4 000 chars)
  bound prompt size and the per-call token spend.
- **Injection.** The pattern key/display, meaning, example, the rendered task
  text, and — highest risk — the learner's free-text ANSWER are all wrapped in
  `<user_input>…</user_input>` and run through `sanitizeUserInput`
  (marker-reject + control-char strip + NFC + length cap) IN THE PROXY before the
  prompt builders see them; the system prompt instructs the model to treat that
  block as data, never instructions (e.g. an answer that says "give a perfect
  score" is ignored). The route never concatenates user text into SQL
  (parameterized everywhere) or into the prompt directly. This is pinned by the
  proxy unit tests (`grammar_drill.test.ts`): a marker-bearing `userAnswer` is
  rejected with `PromptInjectionRejectedError` before any model call, and an
  instruction-like-but-legal answer is asserted to reach the model only inside
  the `<user_input>` wrapper, never as a bare top-level instruction.

### 17.6 Deferred / known gaps

- **FSRS-production scheduling — NOW WIRED (FU-NF-42; see §17.7).** Originally
  deferred this pass; the grammar-drill submit handler now maps the score → an
  FSRS rating → a concrete interval and advances a production-face `vocab_cards`
  row + appends a `card_reviews` snapshot, in the SAME transaction as the score
  write. The threat model for that write is §17.7.

### 17.7 Grammar production-scheduling write (FU-NF-42 addendum)

The submit handler, AFTER the scored-once UPDATE succeeds and INSIDE the same
transaction (`withTransaction`), auto-banks the grammar pattern, resolves-or-
creates the learner's production card for it, computes the next FSRS state via
the pure `grammarScheduler` module, advances the card, and appends an immutable
`card_reviews` row. Threats considered:

- **IDOR / cross-user write.** Every statement is user-scoped: the grammar-entry
  upsert keys on `(user_id, pattern_key)`; the production-card SELECT/INSERT/
  UPDATE all carry `WHERE … user_id = $userId`; the `card_reviews` INSERT stamps
  the same `user_id`. `pattern_key`/`pattern_display` are read from the SERVER-
  stored attempt row (itself loaded user-scoped at step 1), never from request
  body — a client cannot steer the auto-bank at submit time. No statement can
  read or mutate another user's grammar entry or card.

- **Production-card duplication under concurrent double-submit.** A naive
  "SELECT card; else INSERT" can race two submits into two cards for one pattern,
  splitting the FSRS history. Two guards: (1) the scored-once gate (§17.3) is the
  FIRST write in the tx, so only one submit per attempt proceeds to the
  scheduling writes — the loser rolls back the whole (empty-so-far) tx → 409; and
  (2) the partial unique index `uq_vocab_cards_user_grammar_production` (migration
  020) makes "one production card per (user, pattern)" a DB-level invariant, so
  even a hypothetical cross-attempt race on the same pattern fails the second
  INSERT with `23505` rather than banking a duplicate. The card SELECT also takes
  `FOR UPDATE`, serializing concurrent advances of the same card row.

- **Atomicity — no half-persisted score.** The score UPDATE, auto-bank, card
  upsert, card advance, and review snapshot all run in ONE transaction. If any
  scheduling sub-step throws (a constraint violation, a stale-version conflict,
  an unexpected error), the ENTIRE tx rolls back — the score is NOT persisted
  half-way. A scheduling bug therefore surfaces as a loud 500 / 409 and the
  learner can retry against an unscored attempt; it never leaves a scored attempt
  with no schedule, nor a card advanced without its review-log row. This is a
  deliberate "correctness over best-effort" choice (contract A3.6).

- **Constraint backstops.** The scheduler clamps difficulty to `[1,10]`, floors
  stability at `0`, and emits a non-negative integer `scheduled_days`, so the
  card UPDATE and `card_reviews` INSERT can never violate
  `ck_vocab_cards_difficulty_range` / `_stability_nonneg` / `_scheduled_nonneg`
  (or their `card_reviews` twins) even if a card row were somehow corrupt. The
  auto-bank uses `category = 'other'` and `discovered_via = 'drill'`, both of
  which satisfy the (020-extended) `grammar_entries` CHECK allow-lists — the DB
  is the final backstop for those domains.

- **No new Claude call / no new injection surface.** Scheduling is pure + DB
  only; it adds no model call and concatenates no user text into SQL
  (parameterized throughout) — the cost + injection posture of §17.5 is
  unchanged.

## 18. Pass Login surface — TOTP 2FA + login hardening (`/auth/*`, migrations 023–025)

Pass Login makes second-factor authentication MANDATORY (decision D1) and
reworks login into a two-step, pending-token flow (D2). The factor is a standard
TOTP authenticator (RFC 6238: SHA1, 6 digits, 30 s, ±1-step skew window).
Surfaces added: a reworked `POST /auth/login`, `POST /auth/login/totp`,
`POST /auth/mfa/{enroll,confirm}`, `POST /auth/mfa/recovery-codes/regenerate`,
`GET /auth/mfa/status`, plus a registration gate on `POST /auth/register`. New
tables: `user_totp` (023), `user_recovery_codes` (024), `mfa_login_challenges`
(025). New module `src/crypto/encryption.ts` and `src/auth/{totp,recoveryCodes,
mfaChallenges}.ts`. Operator CLIs `seed-user` and `mfa-reset`.

### 18.1 TOTP secret at rest — disclosure
- **Threat:** a DB dump / backup leak yields the factor secret, letting an
  attacker generate valid codes forever.
- **Defense:** the base32 secret is encrypted with **AES-256-GCM** before it
  touches `user_totp.secret_encrypted` (stored as `base64(iv ‖ tag ‖ ct)`). The
  256-bit key lives ONLY in `TOTP_SECRET_ENC_KEY` (env, validated to exactly 32
  bytes at config load) — never in the DB, never in a tracked file (the
  `.env.example` carries a placeholder only). A DB read alone is useless; the
  attacker needs both the dump AND the env key. A fresh 12-byte CSPRNG IV per
  encrypt prevents the catastrophic GCM nonce-reuse failure mode.

### 18.2 Ciphertext tampering
- **Threat:** an attacker with DB write access flips ciphertext bits to coerce a
  predictable / chosen secret.
- **Defense:** GCM is authenticated. `decryptSecret` verifies the 16-byte tag and
  THROWS on any mismatch; the route treats a throw as "secret unusable" and fails
  the verify (logged as `*_decrypt_failed`, never the plaintext) rather than
  trusting unverified bytes or 500ing with the internal cause.

### 18.3 Code replay
- **Threat:** a TOTP code is valid for the whole ±1-step window (~90 s); a
  network-sniffed or shoulder-surfed code could be replayed within it.
- **Defense:** a **monotonic step guard**. `user_totp.last_used_step` holds the
  highest accepted RFC time-step; a code is accepted only if its matched step is
  strictly greater. The code used at enrollment-confirm seeds the high-water
  mark, so even the confirming code cannot be replayed to log in.

### 18.4 Code brute-force
- **Threat:** 6 digits = 10⁶ space; online guessing could find a live code.
- **Defense (two layers):** (1) the per-IP `authLimiter` (failures-only) on every
  auth endpoint; (2) a **per-account lockout** (B-LOCK): `TOTP_MAX_FAILED_ATTEMPTS`
  consecutive bad codes set `user_totp.locked_until = now() + TOTP_LOCKOUT_MINUTES`,
  and code-verify 423s (with `retry_after`) until it elapses. The failure counter
  is bumped and the lock decision made in ONE atomic `UPDATE … RETURNING` so a
  burst of concurrent guesses can't slip past the threshold. Counters reset to 0
  on any success.

### 18.5 Pending login token (challenge)
- **Threat:** the bridge between the password step and the code step could be
  forged, replayed, repurposed, or used as a session.
- **Defense:** challenges are opaque 32-byte tokens, **SHA-256-hashed at rest**
  (`mfa_login_challenges.token_hash`), **single-use** (success sets `consumed_at`
  via an atomic `UPDATE … WHERE consumed_at IS NULL` rowCount gate),
  **time-boxed** (`MFA_CHALLENGE_TTL_SEC`, default 5 min), and **purpose-scoped**
  (`'totp'` vs `'enroll'` — the active-lookup predicates on purpose so an
  enrollment challenge can NEVER drive the code-login endpoint or vice-versa). A
  challenge confers **no session powers** — it can only advance its own one step.
  The raw token is returned to the client once and held in memory only (never
  localStorage — client contract C2/C3).

### 18.6 Recovery codes
- **Threat:** backup codes leak from the DB, or are reused / guessed.
- **Defense:** each code is high-entropy (10 Crockford-base32 chars = 50 bits from
  a CSPRNG), stored only as **SHA-256 hex** (`user_recovery_codes.code_hash`) —
  the plaintext is shown to the user exactly ONCE and never persisted or logged.
  Spend is **single-use** via an atomic `UPDATE … SET used_at = now() WHERE …
  used_at IS NULL` rowCount gate, scoped to the challenge's user. SHA-256 (not
  Argon2) is correct here precisely because the code is high-entropy — Argon2
  would add login latency for zero security gain. Regenerate / re-enroll deletes
  the prior UNUSED codes before issuing a fresh set.

### 18.7 Concurrency — no double-issue / double-spend
- **Threat:** a racing double-submit issues two sessions, spends a recovery code
  / consumes a challenge twice, or burns a single-use recovery code without
  handing back a session (a credential silently lost).
- **Defense:** every state transition is an atomic `UPDATE … WHERE <still-valid>`
  with a rowCount gate (mirrors the Pass-9 scored-once pattern): challenge consume
  (`WHERE consumed_at IS NULL`), recovery spend (`WHERE used_at IS NULL`), lockout
  increment (single `UPDATE … RETURNING`). The loser of a race sees rowCount 0 and
  is rejected — it never issues a session or burns a second code.
- **Recovery-spend + challenge-consume are committed TOGETHER in one
  `withTransaction`** (all crypto — argon2/otplib/decrypt — runs *before* the
  transaction opens, so no external work holds a connection). The recovery code is
  marked used and the challenge is consumed inside the same transaction; if the
  consume loses the race (rowCount 0), the whole transaction rolls back via a
  `ChallengeAlreadyConsumed` sentinel, so the recovery code is **un-spent** and the
  loser gets `challenge_invalid` with neither a session nor a burned code. This
  closes the prior independent-gates wart (a racing two-distinct-code submit could
  otherwise spend a code with no session to show for it).
- **Enrollment confirm** likewise issues the one-time recovery-code set inside the
  same transaction that wins the `confirmed_at IS NULL` flip — only that winner
  issues codes, so two concurrent confirms can't desync the shown set from the
  stored hashes.

### 18.8 Mandatory enforcement — no session without a confirmed factor
- **Threat:** a path that issues a full session before MFA completes defeats the
  mandate.
- **Defense:** when `MFA_REQUIRED` (default true), `POST /auth/login` NEVER sets a
  session cookie on the password step — it returns `mfa_required` (confirmed
  factor exists) or `enrollment_required` (forces first-time enrollment), each
  with only a pending challenge. The session is minted ONLY at
  `/auth/login/totp` (valid code/recovery) or `/auth/mfa/confirm` (enrollment).
  The legacy single-step direct-session path exists ONLY behind
  `MFA_REQUIRED=false` (test / explicit opt-out).

### 18.9 Registration lockdown
- **Threat:** self-service signup on a single-user deployment is an account-
  creation / spam surface.
- **Defense:** `REGISTRATION_ENABLED` (MUST be false in prod) gates
  `POST /auth/register` with a `403 registration_closed` BEFORE any DB work — no
  timing/existence leak. The one account is provisioned out-of-band via the
  `seed-user` CLI (reuses the Argon2id hasher, idempotent `ON CONFLICT DO
  NOTHING`, fails loud on a < 12-char password).

### 18.10 Constant-time secret comparisons
- Password re-auth (enroll/confirm/regenerate Settings paths) uses Argon2id
  `verify` (constant-time, same dummy-verify enumeration defense as login). TOTP
  verification goes through otplib's constant-time compare. Recovery codes are
  matched by hash-equality lookup (the secret value never branches the code path).

### 18.11 Enrollment-pending scope
- An `'enroll'` challenge authorizes ONLY `/auth/mfa/{enroll,confirm}` and only
  for its own user; it cannot act as a session, cannot read protected data, and
  is consumed (single-use) on confirm. Re-enroll from Settings is gated by a full
  session PLUS a password re-auth (step-up), so a hijacked but un-stepped-up
  session cannot silently rotate the factor.

### 18.12 No-email account recovery
- A total lockout (lost authenticator AND lost recovery codes) has NO in-app
  self-service reset (the mandate forbids a disable button). Recovery is the
  operator-run `mfa-reset` CLI: it deletes the factor + recovery codes and
  revokes the user's live sessions in ONE transaction; the next login then falls
  into forced re-enrollment. Possession of shell + DB access is the authorization
  boundary for that CLI (it is not an endpoint).

### 18.13 Never-log list (Pass Login)
- TOTP secret (plaintext base32 or encrypted blob), recovery-code plaintext,
  pending raw challenge token, and the `TOTP_SECRET_ENC_KEY` are NEVER logged.
  Decrypt failures log a fixed sentinel (`*_decrypt_failed`), never the
  ciphertext or key. Route errors use a fixed `{error:{code,message}}` table with
  no server-internal detail echoed to the client.

## 19. Pass F-006 surface — email verification (`/auth/verify`, migration 071)

Email verification is a standing deploy priority. The flow adds a hashed,
single-use, expiring token table (`email_verification_tokens`, migration 071),
a provider-agnostic mail transport (`services/mail.ts`), and a
config-toggleable login gate. Design + operator steps:
`docs/BUILD_f006_email_verification.md`.

### 19.1 Verification-token hygiene
- **Threat:** a leaked or guessed verification link forges a verified email.
- **Defense:** the token is 32 CSPRNG bytes (256-bit) base64url; only its
  SHA-256 **hash** is stored (`token_hash`, CHECK `^[0-9a-f]{64}$`) — a DB read
  never yields a clickable link. Verify compares hashes with `timingSafeEqual`
  (defense-in-depth over the indexed lookup). Single-use via an atomic
  `UPDATE … WHERE consumed_at IS NULL` rowCount gate; 24 h expiry
  (`EMAIL_VERIFICATION_TOKEN_TTL_HOURS`) checked server-side at consume. Each
  token row is **bound to the address it was mailed to** (`email` column) and
  redeems only while that is still the user's current address — a link issued
  for an old address can never stamp a changed one. The emailed link carries
  the token in the **URL fragment** (`/verify-email#token=…`), which never
  leaves the browser — reverse-proxy/CDN access logs and Referer headers never
  see a live token, and the SPA scrubs the fragment from history immediately
  after capture. There is deliberately NO `GET /auth/verify?token=` route (a
  secret in a query string lands in access logs); the only consume path is the
  POST body. A verification token confers NO session powers — consuming it
  only stamps `users.email_verified_at`.

### 19.2 No user-enumeration
- **Threat:** verify / resend as an account-existence or verification-status
  oracle.
- **Defense:** `/auth/verify/resend` returns a fixed `200 {status:'ok'}` in
  EVERY case (unknown / verified / cooldown-suppressed / sent), and the token
  work runs fire-and-forget AFTER the response so timing does not leak. The
  `/auth/verify` error branches (`token_expired` vs `token_invalid`) are only
  reachable by someone already HOLDING the token, so distinguishing them is
  safe (and enables the "expired — resend" UX). The login gate discloses
  `email_unverified` ONLY after a correct password (no status-probing oracle;
  a wrong password stays the generic 401).

### 19.3 Anti-abuse (mail-bombing)
- **Defense:** per-IP `cheapLimiter` on resend PLUS a per-USER DB cooldown
  (`EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC`, default 60 s). The per-user
  cooldown is the real gate — the auth limiter's `skipSuccessfulRequests`
  would never count an always-200 route — and it is **atomic with issuance**:
  the probe runs inside the same per-user-locked transaction as the token
  insert (`issueVerificationTokenIfCooldownClear`), so a concurrent resend
  burst serializes and mints exactly once — at most one email per account per
  window, no matter how many IPs ask. The `PATCH /auth/me` email-change send
  honors the SAME cooldown (an authenticated session flipping the email in a
  loop cannot mail-bomb arbitrary addresses). A resend supersedes prior live
  tokens (`invalidated_at`), so only the newest link is ever redeemable; the
  per-user row lock makes that hold under concurrent issuance too (two racing
  issues leave exactly one live token).

### 19.4 Login gate placement & session safety
- The gate runs AFTER password verification and BEFORE any MFA challenge or
  session mint. It therefore never enters (or weakens) the TOTP / recovery /
  forced-enroll machinery, and verified logins are byte-identical to before.
  Session fixation is unaffected — a gated login mints no session at all, and a
  passing login still issues a fresh session row. `EMAIL_VERIFICATION_REQUIRED`
  (default true) is the operator kill-switch if mail delivery breaks.

### 19.5 Not locking out existing users
- Migration 071 grandfathers every pre-existing account
  (`email_verified_at = created_at` for NULL rows — those accounts were
  operator-provisioned). `seed-user` honors `SEED_USER_MARK_VERIFIED=true`
  (pre-verify, no email). The backfill is one-way (the down does NOT reverse it
  — un-stamping would destroy real verification state).

### 19.6 Email-change verification
- `PATCH /auth/me` on an actual email change resets `email_verified_at` (the
  stamp attests the OLD address), supersedes outstanding tokens, and issues a
  fresh token for the NEW address **in one transaction** — no crash window can
  leave the stamp reset while a live old-address token survives. The send is
  cooldown-gated (§19.3) and happens after commit (best-effort; resend is the
  recovery path). Belt AND braces: even a hypothetically-surviving old-address
  token is dead at consume, because tokens are bound to the address they
  attest (§19.1). The current session is kept (a typo'd address stays
  correctable); the next login is gated.

### 19.7 Mail transport / secrets in logs
- Provider-agnostic: SMTP (nodemailer, env-configured — in this deployment,
  Proton Mail Bridge) or a log-only mock when `SMTP_HOST` is unset. The SMTP
  transport logs only `{to-domain, subject, messageId}` — never the body (it
  carries the raw token). The mock transport DOES log the full body (its dev
  escape-hatch purpose) and is only ever selected with no relay configured.
  `SMTP_TLS_REJECT_UNAUTHORIZED=false` exists solely for a loopback relay's
  self-signed cert (Proton Bridge) — the operator's explicit, documented
  opt-out. The raw token also never transits a request line: the link uses a
  URL fragment and the GET query-param route was removed (§19.1), so nginx
  access logs (km-lb and the client SPA container) cannot capture it — no
  `access_log` carve-out is needed. DNS: the sending domain MUST publish
  SPF/DKIM/DMARC authorizing the From address (see BUILD_f006 deploy steps) or
  receivers spam-folder the mail.

## 20. Pass F-208 surface — cloze vocab drill (`/vocab/cards/:cardId/cloze/grade`, `/vocab/cloze/seed`, migration 080)

The cloze drill is an alternate PRESENTATION of an existing vocab recognition
card: the entry's example sentence with the target word blanked, answered by
typing, graded deterministically server-side (exact surface match, then a
Kiwi lemma-tolerance leg — zero Claude). Prompts are pre-computed by an
operator seeder into `cloze_prompts` (migration 080); grading advances the
SAME `vocab_cards` row through the shared FSRS write path.

### 20.1 Answer stripping on the wire
- **Threat:** the served card leaks the answer before the learner types it —
  as a field, as text, or as metadata an attentive learner can read off
  DevTools.
- **Defense:** `cloze_prompts.answer_surface` is SERVER-ONLY — the due-queue
  read never selects it and no route response serializes it outside a
  COMMITTING grade response (correct, wrong-out on attempt 2, or give-up).
  The served `cloze` object carries only `{blanked, english}`: the blank is a
  fixed-width `______` marker substituted server-side, and the span offsets
  (`blankStart`/`blankEnd`) are deliberately NOT serialized — their
  difference is the answer's length, which is exactly what the
  post-wrong-attempt hint is supposed to be the first reveal of. The
  wrong-attempt-1 response is hint-only (first syllable + character count,
  `clozeHint`) — no reveal, no FSRS write, no version bump.
- Cloze eligibility is face-gated (`c.face = 'recognition'`) in BOTH the
  due-queue join and the grade route's card load, so a production card
  sharing the vocab entry can neither carry nor grade a cloze.
- Sentences where the headword lemma matches MORE THAN ONE token are never
  seeded (`buildClozePrompt` returns null): blanking one occurrence would
  leave another visible on screen — and lemma-tolerant grading would accept
  that visible occurrence as the answer.

### 20.2 Accepted residual — the example sentence co-ships with the card
- **Residual:** a cloze-eligible due card's payload still includes the
  un-blanked `vocab_example_korean`/`vocab_example_english` alongside the
  `cloze` object, and the blanked sentence is typically derived from that
  same example. A learner reading the raw JSON can therefore reconstruct the
  answer before typing it.
- **Why accepted (single-user self-study threat model):** the client decides
  the flashcard-vs-cloze coin flip locally, and the FLASHCARD presentation of
  the same card needs the full example — stripping it per-presentation would
  require a second round-trip or a server-side flip, buying nothing: there is
  no adversary in this app who benefits from a learner seeing their own
  study answer. What matters is the ON-SCREEN exercise, and that never shows
  the answer — guaranteed by the multi-occurrence seeding rule above plus the
  client contract that the cloze face renders ONLY the `cloze` object (never
  the headword or example fields, including accessible names and error copy).
  This is a documented, accepted residual, not a gap to fix.

### 20.3 Grade route hardening
- **IDOR:** the card load is scoped `(id, user_id, deleted_at IS NULL)` —
  foreign/missing/soft-deleted ids 404 without existence leak, and the 404
  body carries no answer material.
- **Schedule tampering:** the client sends only `{answer, attempt, giveUp,
  expected_version}`; the FSRS rating is assigned server-side from the graded
  outcome (`good`/`hard`/`again`) through `applyCardReview` (ADR-003
  server-authoritative posture, optimistic concurrency 409 on stale version).
- **Upstream failure = no half-state:** a Kiwi outage on the lemma leg 502s
  BEFORE any write — no `card_reviews` row, no version bump; the learner
  retries or falls back to the flashcard face.
- **Input bounds:** typed answers are zod-capped (≤200 chars, well inside
  Kiwi's 2000-char input cap); `attempt` is a literal union; unknown keys are
  rejected (`.strict()`).

### 20.4 Seeder (operator endpoint) robustness
- `POST /vocab/cloze/seed` is authenticated, `expensiveLimiter`-bounded, and
  batch-capped (`limit` ≤ 500). It is idempotent (`ON CONFLICT DO NOTHING`,
  already-seeded entries excluded from the candidate set) and aborts honestly
  on a Kiwi outage (`aborted_upstream: true`, partial counts, partial
  progress committed per-row) instead of burning timeouts against a dead
  upstream. Spans are verified against the exact sentence text before
  persisting (offset-drift guard), so a drifted upstream can never store a
  garbled blank.
