# Review — F-021 "Review mistakes" (GET /topik/mistakes)

**Reviewer:** independent senior full-stack review (read-only), branch `feat/f021-mistakes`, commit `e9be26b`.
**Scope:** `server/src/routes/topik.ts` (new route), `server/tests/routes/topik.test.ts`, `client/src/services/topik.ts`, `client/src/pages/Mistakes.tsx`/`.css`/`.test.tsx`, `client/src/data/mocks/mistakes.ts`, `client/src/App.tsx`, `client/src/lib/nav.ts`.

## Verdict

**APPROVE.** No BLOCKER. The answer-key exposure is airtight against IDOR — every row is filtered on `r.user_id = $1` where `$1` is `getUserId(req)`, a value derived from the server-side session (never client input), so the endpoint cannot return an item the caller did not personally answer. The 30-day-window and user-scoping tests are real regression tests, not decorative — each would fail if the corresponding filter were dropped. One SHOULD-FIX: a doc-comment inaccuracy (both server and client) claims `/items` "strips the key" as the safety contrast, which is false — `/items` already serves the inline answer key for every item in the pool, by design (confirmed in this same file's own header and its own test, `'returns mapped DTOs with inline answers + the matching total'`). This doesn't create a new leak (the data was never secret to any authenticated user), but the comment misrepresents the actual security boundary and should cite `/mock` (the only answer-stripped route) instead.

Ran: server `tsc --noEmit` clean, `vitest run tests/routes/topik.test.ts` → **46/46 passed**. Client `tsc --noEmit` clean, `eslint .` clean, `vitest run src/pages/Mistakes.test.tsx` → **3/3 passed**.

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **Misleading security comment: "/items strips the key" is false.** `server/src/routes/topik.ts:484` reads "(contrast /items, which strips the key)". `/items` (`server/src/routes/topik.ts:400-452`) uses the same `mapRows`/`mapRowToDTO` as every study surface and serves `options[].correct` + `explanation` inline for **every** item in the pool — this is confirmed by the file's own top-of-file header (`server/src/routes/topik.ts:11-20`, "STUDY mode serves the `correct` flag + explanation INLINE in every TopikItemDTO — by design") and by the existing test `'returns mapped DTOs with inline answers + the matching total'` (`server/tests/routes/topik.test.ts:78` area). Only `POST /topik/mock` is answer-stripped (via `toMockItemDTO`). The same inaccuracy is repeated client-side: `client/src/services/topik.ts:192` says the mistakes surface "intentionally carries the answer key (unlike the answer-stripped browse)" — but the browse (`/items`) is not answer-stripped either.
   - **Impact:** Not a live vulnerability — since `/items` already exposes every item's answer key to any authenticated user regardless of attempt history, `/mistakes` serving the key for attempted items adds no new exposure. But the comment's false premise ("items are normally locked down, this is a deliberate carve-out") could mislead a future reviewer or maintainer into believing there's a meaningful confidentiality boundary around the answer key that doesn't actually exist in this app — e.g., someone might reason "don't worry, only /mistakes and /study leak the key" when in fact /items does too.
   - **Fix:** Correct both comments to name `/mock` (the actual answer-stripped route) as the contrast, and drop or reword the implication that `/items` is gated.

### NIT

1. **`mode` is typed as bare `string`, not a union.** `MistakeDTO.mode: string` (`server/src/routes/topik.ts:472`) and the client `Mistake.mode: string` (`client/src/services/topik.ts:176`) lose the `'study' | 'mock'` domain the DB `CHECK` constraint guarantees (`ck_topik_responses_mode`, `db/migrations/015_topik_responses.up.sql:89-90`). Not a bug — `Mistakes.tsx:43` only branches on `=== 'mock'` and defaults everything else to "학습", which is safe — but a narrower type would let the compiler flag a typo in that comparison. Low priority since the row is DB-sourced and CHECK-constrained.
2. **No backfill when a page's cap is partly consumed by ungradeable rows.** The `LIMIT $3` is applied in SQL before `mapRowToDTO` drops ungradeable rows (`server/src/routes/topik.ts:513-515`) — if several of a user's most-recent N mistakes reference an item that's since become ungradeable (corpus edit), the response silently returns fewer than `limit` items with no way to "top up" to the requested count. This mirrors an already-accepted tradeoff elsewhere in the file (`/items`' own note, `server/src/routes/topik.ts:395-398`) and is very unlikely in practice (mistakes are inherently recent, corpus edits invalidating items are rare), so it's a NIT rather than a SHOULD-FIX.

### PRAISE

1. **IDOR posture is genuinely solid.** `getUserId(req)` (`server/src/middleware/auth.ts:52-58`) throws `UnauthorizedError` if `req.user` is somehow unpopulated rather than silently defaulting — so there is no path where `$1` in the mistakes query could be `undefined`/coerced to something a client controls. Combined with `router.use(requireAuth)` (`server/src/routes/topik.ts:41`) gating every route in the file, the query's `WHERE r.user_id = $1` is unconditionally session-derived.
2. **The regression tests are real, not theater.** `server/tests/routes/topik.test.ts:346-357` (user-scope) actually asserts `resB.body.mistakes.length` is `0` for a second user despite user A having mistakes seeded — if the `WHERE r.user_id = $1` clause were ever dropped, this assertion would fail immediately. Likewise the 40-day-old row + `?days=90` widen (`:339-345`, `:359-360`) is a real regression test for the `make_interval` window: if the day filter were removed, the default-window assertion (`resA.body.mistakes.length` === 1) would fail because the old row would also appear.
3. **Query design matches the existing index without new migration work.** `(user_id, answered_at DESC)` (`ix_topik_responses_user_answered_at`, `db/migrations/015_topik_responses.up.sql:136-141`) exactly matches the query's equality predicate (`user_id`) + range predicate (`answered_at`) + `ORDER BY answered_at DESC` — a textbook left-prefix btree usage. `is_correct` isn't in the index, but as a low-cardinality boolean it's correctly left as a post-index-scan filter rather than bloating the index; this is the right call, not an oversight.
4. **SQL injection surface is clean.** `make_interval(days => $2)` and `$1`/`$3` are all bound parameters (`server/src/routes/topik.ts:499-509`), and `days`/`limit` are validated server-side by `MistakesQuerySchema` (`z.coerce.number().int().min(1).max(90|200)`, `:454-457`) before ever reaching SQL — no string concatenation, no dynamic identifiers.

## Detailed

### Backend — `server/src/routes/topik.ts`

- **Route registration & auth (`:41`, `:490-535`):** `router.use(requireAuth)` gates the whole file; `/mistakes` additionally runs `cheapLimiter()` and `validateQuery(MistakesQuerySchema)` before the handler, matching every sibling route's shape.
- **Query correctness (`:499-509`):**
  ```sql
  SELECT ${ITEM_COLUMNS},
         r.id AS response_id, r.picked, r.answered_at, r.mode::text AS mode
    FROM topik_responses r
    JOIN topik_items i ON i.id = r.topik_item_id
    JOIN topik_tests t ON t.id = i.topik_test_id
   WHERE r.user_id = $1
     AND r.is_correct = false
     AND r.answered_at > now() - make_interval(days => $2)
   ORDER BY r.answered_at DESC
   LIMIT $3
  ```
  - `r.user_id = $1` — session-derived (`getUserId(req)`, `:494`), never client-supplied. This is the load-bearing IDOR defense and it's correct.
  - `r.is_correct = false` — excludes correct answers; verified by the seeded-pair test (`server/tests/routes/topik.test.ts:280-320`: one miss + one ace, only the miss returned).
  - `answered_at > now() - make_interval(days => $2)` is a strict rolling window (correctly excludes the answer made exactly at the boundary — acceptable "> not >=" semantics for a "last N days" feature, no off-by-one concern raised by the spec).
  - `topik_item_id` FK is `ON DELETE RESTRICT` (`db/migrations/015_topik_responses.up.sql:84-86`), so the joined item is guaranteed to exist; the only failure mode is the item becoming *ungradeable* (edited corpus), which `mapRowToDTO` catches and the route correctly skips (`:513-515`) rather than crashing or serving a malformed DTO.
  - No N+1: this is a single query with two JOINs, same pattern as `/items`.
- **`picked` handling (`:459-475`, `:518`):** `picked: row.picked as ChoiceId` reads a DB column CHECK-constrained to `'a'|'b'|'c'|'d'` (`ck_topik_responses_picked`) — the cast is safe because it's trusted DB data being read, not client input being cast (contrast with a `req.body as X` cast, which would be a real red flag). This exact pattern is otherwise unused elsewhere in the file (other `ChoiceId` casts are on server-computed values), but is sound here.
- **Comment accuracy (`:472-489`):** see SHOULD-FIX #1 above — the "(contrast /items, which strips the key)" line at `:484` misidentifies which route is answer-stripped.

### Tests — `server/tests/routes/topik.test.ts:279-361`

- Test 1 (`:280-320`) seeds a missed item and an aced item, submits both, and asserts `mistakes.length === 1` with the correct `item.id`, `picked`, `mode`, and that `item.explanation`/the correct option are present on the wire. This proves both the `is_correct=false` filter and the full-DTO-serving behavior in one assertion block.
- Test 2 (`:322-361`) is the IDOR + window test: user A gets a fresh miss plus a directly-inserted 40-day-old miss; user A's default-window response is asserted to have exactly the fresh one; user B (no responses) gets an empty array; widening to `?days=90` surfaces both. This is a genuine regression test for both the `user_id` filter and the `make_interval` window — a dropped `WHERE r.user_id = $1` would make the `resB` assertion fail; a dropped/broken day-window filter would make the default-window assertion (`length === 1`) fail.
- Both new tests ran green under real Postgres via testcontainers (per repo test convention), not against a mock.

### Client

- **`client/src/services/topik.ts:169-206`** (`fetchMistakes`, `Mistake` type) — thin, typed pass-through matching the server envelope (`{ mistakes: [...] }` → unwrapped array), field names (`responseId`/`picked`/`answeredAt`/`mode`/`item`) match the server DTO exactly. No `signal`-handling bugs (optional signal forwarded to `api.get`).
- **`client/src/pages/Mistakes.tsx`** — renders via `useEndpointOrMock` (`:97-101`) following the established per-screen convention (mock fallback + dev-only badge). Correct/wrong-pick highlighting (`:56-79`) is driven off `o.correct` (server-authoritative) and `o.id === picked` (server-authoritative) — never derived from client-side re-grading, so there's no way for the client to mismark an option. No `dangerouslySetInnerHTML` anywhere in the file; all text (`item.prompt`, `item.passage`, `o.kr`, `item.explanation`) renders as ordinary React children, so React's default escaping applies — no XSS surface.
- **Loading / empty / error states** (`:116-141`) are all explicitly handled and each has a corresponding assertion in `Mistakes.test.tsx`.
- **Nav & routing** — `client/src/App.tsx` adds the `/mistakes` route; `client/src/lib/nav.ts` adds the `mistakes` nav item (icon `history`, which exists in `client/src/components/Icon.tsx:31,120`) to `MORE_TAB_IDS` first, matching the PR description. `/topik` is already covered by the nginx allow-list regex prefix (`Deploy/nginx-blue-active.conf:82,129`, `^/(...|topik|...)(/|$)`), so `/topik/mistakes` needs no allow-list change — confirmed correct, not just asserted.

### Client tests — `client/src/pages/Mistakes.test.tsx`

- Covers data (prompt + explanation + "Your answer" tag + "Correct answer:" text all present), empty, and error states — 3 tests, matching the commit message's claim. Assertions target visible text rather than CSS class names or internal props, consistent with Testing Library best practice (asserting behavior/output, not implementation) — a reasonable choice given the correct/wrong marking is also expressed as visible text ("Your answer" / "Correct answer:") alongside the CSS classes, so the meaningful behavior is still exercised without over-coupling to class names.
