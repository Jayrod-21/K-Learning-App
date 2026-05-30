# Review P3A: server additions

Independent senior review of the Pass 3 server surface: migrations 011/012,
PATCH /auth/me, GET /auth/me extension, vocabLists routes (7), POST
/conversation/:id/messages/stream, app mount, SECURITY.md §10, and the
accompanying tests.

## Summary verdict

**REQUEST CHANGES** — two BLOCKER findings: (1) the streaming endpoint claims
to propagate client abort to the upstream Claude proxy but no `AbortSignal` is
plumbed through `CallContext`, so a closed client never stops the upstream
spend; (2) PATCH /auth/me lacks any optimistic-concurrency check while
bumping `users.version`, allowing silent last-writer-wins lost updates on a
field set that includes the canonical recovery channel. Three SHOULD-FIX
items concern a dropped `final` promise, inconsistent seed-vs-append
not-found behavior, and a missing PATCH /auth/me test file.

Outside those, the design choices (FOR UPDATE on parent during membership
writes, dup-detect-before-INSERT for a meaningful 409, idempotency-check
BEFORE the version gate, SSE error-frame instead of next(err) after headers,
audit-log domain-only on email change) are all senior-quality calls and
should be preserved in the fix pass.

## Bar checklist

Mapping the Bar §5 done-criteria + the EVAL CRITERIA points in the brief.

| Criterion | Status | Notes |
|-----------|--------|-------|
| Migrations: no top-level BEGIN/COMMIT | PASS | Both 011 and 012 leave tx ownership to the runner per ADR-013. |
| Migrations: idempotent CREATE/ALTER | PASS | `IF NOT EXISTS` on table/column/constraint/index; DO-block guards CHECK constraint pre-PG17. |
| Migrations: DROP gated by --allow-destructive | PASS-by-runner | Down files note runner enforces this; no inline guard required. |
| FK ON DELETE/UPDATE semantics correct | PASS | `vocab_lists.user_id` CASCADE (user gone → lists gone); `vocab_list_entries.entry_id` RESTRICT (corpus row can't be silently orphaned). |
| NOT NULL where appropriate | PASS | Every column except `name_en`, `deleted_at`, `phone`. |
| CHECK constraints | PASS | length, kind whitelist, position >= 0, version >= 1, phone shape+length. |
| ENUM vs string-union | PASS | TEXT + CHECK for `kind` justified inline (cheaper to grow than ALTER TYPE). |
| Audit columns | PASS on `vocab_lists` (created_at, updated_at, version, deleted_at); MEMBERSHIP table has only `added_at` — justified ("hard delete; immutable"). |
| Surrogate BIGINT IDENTITY PK | PASS | Both tables. |
| UNIQUE on natural keys | PASS | `uq_vocab_list_entries_list_entry (list_id, entry_id)`. |
| Indexes named-and-justified via COMMENT ON INDEX | PASS | Both indexes have COMMENT ON INDEX with the supporting query. |
| Phone CHECK regex mirrors route Zod regex EXACTLY | PASS | Both are `^[+0-9 ()-]+$`, length 7–32. Confirmed character-by-character. |
| PATCH /me Zod `.strict()` + `.refine()` | PASS | Both applied. |
| PATCH /me email-uniqueness → 409 reuses register shape | PASS | 23505 → `ConflictError('email already in use')`, same pattern as register. |
| PATCH /me audit log on email change | PASS | WARN level, domain-only, with userId + event + before/after domains. |
| PATCH /me rate limit choice justified | PASS | `authLimiter` reuse documented inline; rejection of separate `profileLimiter` reasoned in code + SECURITY.md §10.1. |
| PATCH /me parameterized always | PASS | No string interpolation. |
| GET /me extension is additive | PASS | Adds `display_name`, `phone` to existing `{id, email}`; tests still assert on the original key. |
| vocabLists: every route `requireAuth` | PASS | `router.use(requireAuth)` at line 51. |
| vocabLists: every read scoped by user_id | PASS | All five list-id-bearing routes filter `user_id = $session`. IDOR test in suite confirms 404. |
| vocabLists: FOR UPDATE on parent for membership writes | PASS | POST /entries and DELETE /entries both `SELECT … FOR UPDATE`. |
| vocabLists: duplicate-add returns 409 with offending ids | PASS | Dup-check pre-INSERT; ConflictError carries the dup ids (first 10). |
| vocabLists: DELETE list = soft delete; DELETE entry = hard delete | PASS | Matches migration design. |
| vocabLists: zod bodies + path-param coercion + range | PASS | `.strict()` everywhere; params via `z.coerce.number().int().positive()`. |
| Streaming: SSE protocol correctness | PASS | `Content-Type: text/event-stream`, `data: <json>\n\n` frames, terminal `done` frame, `res.end()`. |
| Streaming: `req.on('close')` triggers AbortController | PARTIAL | Controller created and `.abort()` fires, but signal not passed downstream (see BLOCKER-1). |
| Streaming: persist-after-complete | PASS | `withTransaction` is the very last step; aborted streams skip persistence. |
| Streaming: idempotency check BEFORE version gate | PASS | Replay branch at lines 413–432 runs before the version check at 434. |
| Streaming: error frames after headers don't route to JSON handler | PASS | Inline catch at 567–583 writes SSE-format error and `res.end()`; never `next(err)`. |
| Streaming: `expensiveLimiter` applied | PASS | Mounted at line 338. |
| Streaming: AbortController-aware downstream call | **FAIL** | `proxy.generateConversation` does not accept a `signal` in `CallContext`; see BLOCKER-1. |
| SECURITY.md §10 covers all three Pass 3 surfaces | PASS | §10.1 PATCH /me, §10.2 vocabLists, §10.3 SSE; each with named attack vectors + defenses. |
| Email-verification deferral acknowledged | PASS | §10.1 cross-links to client/SECURITY.md "Deferred" but does **not** cite a ticket id — see SF-3 below. |
| Tests: real-Postgres integration | PASS | All Pass 3 tests use `startPostgres()` via testcontainers (helpers/pg.ts). No SQLite. |
| Tests: auth gate on every route | PASS | `vocab lists — auth required` covers all 7 routes; SSE has a 401 test; `routes.auth-required.test.ts` smoke-tests `/vocab/lists`. |
| Tests: IDOR | PASS | "user A creates list, user B gets 404" for GET, PATCH, POST entries, DELETE entry. |
| Tests: duplicate-add | PASS | `409 on duplicate add` + body `error.code === 'conflict'`. |
| Tests: SSE happy + stale-version + idempotent-replay | PASS | All three present. |
| Tests: SSE cancel mid-stream | **MISSING** | No client-disconnect test; see SHOULD-FIX SF-4. |
| Tests: PATCH /auth/me | **MISSING** | No PATCH cases in `auth.test.ts`; see SHOULD-FIX SF-5. |
| No console.log / commented-out code | PASS | None observed. |
| No hardcoded secrets / URLs | PASS | All env-driven. |
| Reversible migrations both directions | PASS | Down files restore prior state. |
| No external I/O inside tx | PASS | Streaming endpoint and non-streaming endpoint both call B4 outside `withTransaction`. |

## Findings

### BLOCKER

- **BL-1: Client abort never reaches the Claude proxy.**
  `server/src/routes/conversation.ts:385-392` creates an `AbortController` and
  `req.on('close')` calls `abort.abort()`, but on line 460 the call site is
  `proxy.generateConversation(input, { requestId: req.correlationId, userId })`
  — there is no `signal` in `CallContext`. The interface
  (`server/src/services/claude/index.ts:128-135`) defines only `requestId`,
  `userId`, `bucketKey`. So `abort.abort()` does nothing observable upstream;
  the B4 worker runs to completion and bills the tokens regardless. The
  threat-model claim in `server/SECURITY.md:228-231` ("`req.on('close', …)`
  fires an `AbortController` that propagates to the upstream B4 call") and
  the route docstring at `conversation.ts:332-335` are both false. This is a
  real DoS / cost-amplification surface — a malicious client opens a stream
  and immediately disconnects; the server pays in full.

- **BL-2: PATCH /auth/me bumps `users.version` without an optimistic-
  concurrency gate.**
  `server/src/routes/auth.ts:288-302` issues
  `UPDATE … SET version = version + 1 WHERE id = $1` with no
  `AND version = $expected`. The Bar §1 ("Optimistic concurrency via the
  `version` column for any row a user might edit … verify the row count")
  applies to `users` exactly because email is the canonical recovery
  channel. Two concurrent PATCH requests (browser tab + mobile) both reading
  version=N race and the second silently overwrites the first — no 409, no
  audit trail of the lost change. The route docstring at lines 250-254
  acknowledges that the UPDATE runs unconditionally, but the rationale given
  ("we don't bump `users.version` if every supplied field equals the current
  value") is contradicted by the SQL: version is bumped regardless. Either
  add `expected_version` to `PatchMeSchema` and gate the UPDATE, or drop the
  `version = version + 1` clause and rely on `updated_at` for change
  tracking. The vocab_lists PATCH at least documents the deferral inline
  ("Pass 3 UI is single-tab-per-user"); PATCH /me has no such defense and
  the surface is higher-value.

### SHOULD-FIX

- **SF-1: `final` promise is leaked when the client closes mid-stream.**
  `server/src/routes/conversation.ts:470-494` — on disconnect the
  `for await` loop breaks and the function returns without ever awaiting
  `final`. With BL-1 unfixed the worker keeps running and eventually
  resolves; with BL-1 fixed it rejects on abort. In either case there is no
  `.catch()` on `final`, so a rejection becomes an `unhandledRejection`
  process event. Fix: `void final.catch(() => undefined)` immediately after
  destructuring at line 463, or await it inside a try/catch in the abort
  branch.

- **SF-2: Seeds path silently swallows invalid entry_ids; POST /entries
  errors loudly. Inconsistent UX for the same conceptual operation.**
  `server/src/routes/vocabLists.ts:180-200` (seeds) skips ids missing from
  `vocab_entries` via `WHERE EXISTS` and reports `appended = N - skipped`
  with no signal about why N was less than requested. By contrast POST
  /:id/entries at lines 436-446 throws `NotFoundError` listing the missing
  ids. A user dragging the same selection through "create list with seeds"
  vs "add to existing list" gets two different behaviors. Pick one — I'd
  surface the missing ids in the create response too (`{ list, appended,
  skipped_ids }`) or 404 like the append path. Without this, "appended=0"
  is indistinguishable from "every id was invalid" vs "every id was already
  in the list" (the latter is impossible on a freshly-created list, but the
  point stands for the symmetric case).

- **SF-3: SECURITY.md §10.1 does not cite a ticket id for the deferred
  email-verification flow.**
  `server/SECURITY.md:160-187` says the email-verification flow is deferred
  and references `Repository/client/SECURITY.md §"Deferred"` for parity, but
  the Bar §"No TODO / FIXME in committed code without a ticket number" and
  the global standing-orders deploy checklist ("Email verification" is item
  #1 of three) both want a tracked deferral, not a prose deferral. Add the
  ticket id (issue number, ADR number, or follow-up task slug) so the
  scheduler can pick it up.

- **SF-4: No SSE cancel-mid-stream test.**
  `server/tests/routes/conversation.test.ts:186-260` covers happy path,
  stale version, idempotent replay, and unauth — but does not exercise the
  abort path. The very behavior BL-1 broke could have been caught with a
  test that does `req.destroy()` after the first delta and asserts the DB
  row didn't gain the assistant turn. Add a test using a `http.request`
  client that destroys the socket after `data: {"event":"delta"` is seen,
  then queries `conversations.messages` and asserts the half-turn never
  landed.

- **SF-5: No PATCH /auth/me tests in `auth.test.ts`.**
  `wc -l tests/routes/auth.test.ts` is 159 lines and `grep -i patch` returns
  nothing. The brief explicitly calls for "PATCH cases" and BL-2 + the
  surface's sensitivity (email rotation) make this the highest-value test
  gap. At minimum: rename-only happy path, strict-extra-key 400, refine
  empty-body 400, email-change 409 conflict, phone shape 400, audit log
  emitted on email change. The middleware test
  (`routes.auth-required.test.ts`) only covers GETs and does not exercise
  PATCH.

- **SF-6: `validateQueryStream` reinvents `validateQuery`.**
  `server/src/routes/conversation.ts:347-360` says
  *"kept inline because only this route needs it"*, but the inline wrapper
  exists because the streaming route wants the validated query under a
  different key (`validatedStreamQuery`). The actual `validateQuery` from
  `middleware/validate.ts:25` already supports any schema. Either use
  `validateQuery(StreamQuerySchema)` (and accept that the field shows up as
  `validatedQuery`) or — if the separate key matters — generalize the
  middleware to accept a key name parameter and update both call sites. The
  current comment is misleading and the duplication is the kind of drift
  the bar's "DRY rule of three" would normally catch on the next addition.

### NIT

- **N-1: Redundant truthy check in dup detection.**
  `server/src/routes/vocabLists.ts:459`:
  `if (existing.rowCount && existing.rowCount > 0)`. The `rowCount > 0` is
  enough; node-postgres types `rowCount` as `number | null` post-v8, hence
  the guard. Either `if ((existing.rowCount ?? 0) > 0)` or just
  `if (existing.rowCount)`. Cosmetic.

- **N-2: BIGINT array passed as `number[]`.**
  `server/src/routes/vocabLists.ts:437, 457, 485` send `uniqueIds: number[]`
  cast to `bigint[]`. Safe up to `Number.MAX_SAFE_INTEGER` (2^53). At
  current ID volumes this is fine; if vocab_entries ever cross that
  threshold (won't, given corpus size), switch to string ids end-to-end.

- **N-3: `before.rows[0]?.email` is double-checked.**
  `server/src/routes/auth.ts:269-279` reads the prior email solely for the
  audit log diff; if `phone` or `display_name` is the only field being
  changed, the SELECT is a wasted round-trip. Could be short-circuited with
  `if (newEmail) { /* SELECT before email */ }`. Minor latency win.

- **N-4: `toLowerCase()` on a citext comparison is dead code.**
  `server/src/routes/auth.ts:324`: `newEmail !== beforeEmail.toLowerCase()`.
  citext returns the email in whatever case it was inserted in; the column
  is case-INSENSITIVE for comparison but case-PRESERVING for return. Since
  `newEmail` was already lowercased on line 265 and `beforeEmail` was
  inserted lowercased via `register`, the comparison is robust either way,
  but the `.toLowerCase()` documents an intent that the surrounding code
  could express by typing `beforeEmail` as `Lowercase<string>`-equivalent
  (a branded type) — see the comment in CALL_REVIEW or just drop the
  lowercase since both sides are already canonical.

- **N-5: SSE comment says "We do NOT emit SSE `event:` lines"; the JSON
  payload uses `"event"` as a key.**
  `server/src/routes/conversation.ts:329` and the wire format at 321-326
  use `"event": "start"` etc. inside the JSON. That's fine — the comment is
  about the SSE `event:` line type, not the JSON property name — but a
  reader skimming the docstring may conflate them. Consider renaming the
  JSON key to `kind` or `type` to remove the ambiguity (also matches the
  internal `ev.type` discriminator already used on line 472).

### PRAISE — preserve in fix pass

- **P-1: Idempotency check BEFORE the version gate.**
  `server/src/routes/conversation.ts:407-432`. The inline comment is
  textbook — a retry naturally carries the old `expected_version`, so a
  version-gate-first design would defeat the entire purpose. Replay is
  read-only, version-change-free, and safe. Do not refactor this ordering.

- **P-2: Dup-detect BEFORE INSERT under `FOR UPDATE`.**
  `server/src/routes/vocabLists.ts:421-464`. The choice to surface the
  duplicate set instead of `ON CONFLICT DO NOTHING` is the design's
  explicit ask, and the inline comment explains why. The FOR UPDATE
  serializes concurrent appenders so the dup-check + INSERT pair is
  TOCTOU-safe. Preserve both.

- **P-3: Persistence is the very last step in the streaming path.**
  `server/src/routes/conversation.ts:497-553`. Mid-stream abort → no
  half-turn. Persistence failure AFTER a successful stream surfaces the
  assistant text in the error frame (`recovered_text`) so the client can
  still render and offer a manual save. This is mature error UX — keep it.

- **P-4: Post-headers errors are SSE-framed, not `next(err)`'d.**
  `server/src/routes/conversation.ts:567-583`. Routing a mid-stream error
  to the JSON error handler would corrupt the byte stream. The inline
  catch handles this correctly and logs at warn level.

- **P-5: PATCH /me audit log records domain only.**
  `server/src/routes/auth.ts:324-336`. Logging the local part would be a
  PII leak; logging the domain only gives forensic value (was the new
  address `gmail.com` vs `protonmail.com`?) without the leak. The comment
  cross-links to the SECURITY.md §4.1 rule. Preserve.

- **P-6: Phone regex + length mirrors the DB CHECK exactly.**
  `server/src/routes/auth.ts:69-71` ↔ `db/migrations/011_user_profile_fields
  .up.sql:42-49`. Character-by-character match. A payload that passes Zod
  cannot trip the DB constraint, which means a 23514 from the DB is
  diagnosable as a real bug, not a boundary skew. Preserve.

- **P-7: Migration 012 reasoned out the `position UNIQUE` tradeoff inline.**
  `db/migrations/012_vocab_lists.up.sql:23-32`. The decision to NOT enforce
  UNIQUE on `(list_id, position)` is explicit, cited to the Bar's "no
  business logic in the DB" principle, and includes the tie-break read
  contract. This is the kind of inline ADR-light decision the bar wants.

- **P-8: `vocab_lists.kind` is TEXT + CHECK, not an enum, with the reason
  written down.**
  `db/migrations/012_vocab_lists.up.sql:28-32, 82-84`. Growing an enum
  requires `ALTER TYPE`, which Postgres can't roll back. TEXT + CHECK is
  the right call for an open-ended discriminator.

- **P-9: `app.ts` mount order documents the routing precedence.**
  `server/src/app.ts:60-65`. The comment explicitly notes
  `/vocab/lists` must come before `/vocab` and explains why. This is the
  kind of "future engineer protection" that prevents subtle regressions.

- **P-10: SECURITY.md §10 actually enumerates attack vectors, not
  hand-waves.** Each of the three subsections names a concrete threat,
  describes the mechanism, and lists the defense by code reference. Some
  reviewers ship §10 as a one-paragraph note; this is the standard the bar
  wants.

## Detailed findings — proposed fixes

**BL-1** (`server/src/routes/conversation.ts:385-392, 460-463` +
`services/claude/index.ts:128-135`):
1. Extend `CallContext` with `readonly signal?: AbortSignal;`.
2. Plumb the signal into the worker coroutine in
   `services/claude/index.ts:342-…` — guard the cache-miss path's upstream
   call with the AbortSignal and translate `AbortError` into a terminal
   `error` event on the queue + reject `outcomePromise` with a typed
   `AbortError`.
3. At the call site (`conversation.ts:460`), pass `signal: abort.signal`.
4. Add a SSE-disconnect integration test (see SF-4) that asserts the
   upstream call was cancelled (the Claude proxy fake should expose a
   `lastCallWasAborted` flag for the test).

**BL-2** (`server/src/routes/auth.ts:220-235, 288-302`):
- Option A (preferred — matches conversation route + bar): add
  `expected_version: z.number().int().positive()` to `PatchMeSchema`, and
  change the UPDATE to:
  ```
  WHERE id = $1 AND version = $expected AND deleted_at IS NULL
  ```
  On `rowCount === 0` re-check whether the row exists; throw
  `ConflictError('stale user version')` vs `UnauthorizedError`
  accordingly.
- Option B: drop `version = version + 1` from PATCH /me and document that
  `users.version` is reserved for future use. Leaves the field in place
  but doesn't pretend to enforce optimistic concurrency.

**SF-1** (`server/src/routes/conversation.ts:463`):
- Immediately after `const { events, final } = proxy.generateConversation(…)`:
  ```ts
  final.catch(() => undefined); // prevent unhandledRejection on abort
  ```
- In the abort branch (current line 490-494) optionally await `final` inside
  a try/catch and emit a warn log noting the upstream call was aborted.

**SF-2** (`server/src/routes/vocabLists.ts:180-200`):
- Mirror the POST /entries flow: validate `seed_entry_ids` against
  `vocab_entries` first, throw `NotFoundError` with missing ids if any,
  then INSERT cleanly. OR, if the seeds-are-best-effort posture is
  intentional, change the response to
  `{ list, appended: N, skipped_invalid: [...], skipped_existing: [...] }`
  so the client can render an accurate summary.

**SF-3** (`server/SECURITY.md:160-187`): add a ticket id beside each
"deferred" mention; line 161 for the deferral itself and line 184 for the
"Acknowledged residual risk" paragraph.

**SF-4** (`server/tests/routes/conversation.test.ts:186-260`):
- New test "client disconnects mid-stream → no assistant turn persisted":
  use `http.request` directly (supertest auto-drains), destroy the socket
  on first `delta`, wait 500 ms for the worker to settle, then assert
  `SELECT messages FROM conversations` shows only the user turn (or
  nothing if the user turn isn't persisted either) and `version` did
  not bump.
- New test "client disconnect aborts the upstream call": once BL-1 is
  fixed, the proxy fake's `lastCallWasAborted` flag should be true after
  a mid-stream destroy.

**SF-5** (`server/tests/routes/auth.test.ts`): new `describe('PATCH /auth/me')`
block with at minimum:
- `requires auth → 401` (no cookie).
- `renames display_name → 200 + new shape`.
- `empty body → 400 'no profile fields supplied'`.
- `strict — extra key {role: "admin"} → 400`.
- `phone shape valid → 200, phone returned`.
- `phone shape invalid → 400`.
- `email change → 200 + audit-log WARN line with event=profile_email_changed`
  (use a log capture stream).
- `email collision → 409` (register second user, change first user's
  email to second's).
- `stale version (Option A above) → 409`.

**SF-6** (`server/src/routes/conversation.ts:347-360`): replace
`validateQueryStream` with `validateQuery(StreamQuerySchema)` and refactor
line 372-374 to read `(req as Request & { validatedQuery: … }).validatedQuery`.
Drop the misleading comment.

## Coordination observations

These cut across the client services / screens the brief flagged and matter
for the fix pass on this PR.

- **CO-1: PATCH /auth/me lacks `expected_version` — but the GET /me response
  also doesn't return `version`.** Even if BL-2 is fixed via Option A
  (adding `expected_version`), clients need a way to read the current
  version. The current `GET /me` projection (`auth.ts:196-207`) returns
  `id, email, display_name, phone` — no `version`. The Settings screen
  on the client will need it. Either include `version` in the GET /me
  payload or add a header (`ETag: "version-N"`) on the response. This
  affects the client Settings service contract — flag it now or the
  fix-pass will silently land Option B.

- **CO-2: vocab_lists response shape diverges across endpoints.**
  - GET /vocab/lists returns each list with `entry_count` and
    `last_added_at` aggregated via LEFT JOIN.
  - GET /vocab/lists/:id returns the list with `entry_count` only.
  - POST /vocab/lists returns `{ list, appended }` (no `entry_count`).
  - PATCH /vocab/lists/:id returns `{ list }` (no `entry_count`, no
    `appended`).
  The client Lists screen will assemble all four into a single
  in-memory model. Picking a single canonical `VocabListSummary` type
  (likely `{ id, name_kr, name_en, kind, version, created_at,
  updated_at, entry_count }`) and returning it identically from
  every endpoint cuts the client's normalization layer. Pass 3 can
  ship as-is, but flag it for the client review.

- **CO-3: SSE `event` JSON key collides with the SSE protocol's `event:`
  line.** Already noted in N-5. The conversation client service will
  parse `data:` payloads and switch on the inner `event` field. A
  rename to `kind` or `type` would (a) avoid the protocol-level
  conflation and (b) match the worker's `ev.type` discriminator.
  Coordinate with the client streaming service before locking the
  wire format — this is a one-shot rename window.

- **CO-4: Idempotency-replay 200 vs first-call 200 are indistinguishable
  at the HTTP status level.** The replay emits an extra
  `idempotent_replay: true` flag inside the SSE frames. The client
  needs to read that flag to skip counter increments / animations. Make
  sure the client streaming service surfaces this through its event
  type union, not just as a stringly-typed boolean.

- **CO-5: PATCH /vocab/lists/:id allows clearing `name_en` to null via
  `nullable().optional()`, but PATCH /auth/me does not allow clearing
  `display_name` or `phone` (only `.optional()`, not `.nullable()`).**
  Inconsistent. Decide whether Settings UI should be able to clear a
  display name (probably yes — currently the user can only overwrite,
  not delete). Coordinate with the client field UX.

- **CO-6: Both PATCHes bump `version` unconditionally without
  optimistic-concurrency gates.** BL-2 covers /auth/me. The same
  shortcut on /vocab/lists is documented inline as "single-tab UX
  deferral", which is defensible. If BL-2 is fixed via Option A, apply
  the same pattern to /vocab/lists/:id PATCH and DELETE so the
  optimistic-concurrency posture is uniform across mutate paths.

---

End of review. Cite `file:line` references are inline.
