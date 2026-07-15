# REVIEW — Backend batch server routes + services (`feat/backend-batch` @ 6d05e93)

Independent senior backend review. Scope: new/changed server routes + services vs `rebuild`.
Files: `routes/{hanja,reading,ttmik,topik,vocab,krdict,writing,plan}.ts`, `services/cardReview.ts`,
`tests/routes/*`, `tests/helpers/seed.ts`.

## VERDICT: PASS — 0 BLOCKERS

Senior-grade work. Every write path is user-scoped or existence-gated as appropriate, every attempt
row is server-stamped (never client-supplied), the one shared-transaction write (F-171) is genuinely
atomic, all SQL is parameterized, and the tests exercise the exact security boundaries a regression
would break (cross-user 404 + no-row, 409 whole-transaction rollback, exact totals, NULL-IN, OR-group
parenthesization). Server slice runs green: **446 passed / 446**, typecheck clean.

Findings: 0 BLOCKER · 0 SHOULD-FIX · 2 NIT · several PRAISE.

---

## Per-route checklist (correctness + security)

### F-171 Hanja attempt logging — `services/cardReview.ts`, `routes/hanja.ts`
- [x] **Atomic.** Insert of `hanja_attempts` (cardReview.ts:228-234) is inside `withTransaction`. The 409
  path (`ConflictError`, :187) throws *before* it, and the 404 paths (:128, :134) earlier still — a stale
  version or cross-user/non-hanja probe writes NEITHER `card_reviews` NOR `hanja_attempts`. Verified by test
  "stale expected_version → 409, and nothing is written" (asserts `hanja_attempts` rowCount 0).
- [x] **Flag defaults off.** `logHanjaAttempt?: boolean`; vocab route never passes it → no insert, no column
  read. Hanja route sets it (hanja.ts:743). Vocab behavior byte-identical.
- [x] **No N+1.** Single `LEFT JOIN hanja_characters` on the already-locked SELECT (`FOR UPDATE OF vc` so the
  join target isn't locked). `hanja_char` NULL on vocab calls, never read.
- [x] **Server-stamped.** `user_id`, `card_id`, `char` all from the locked DB row / session; `correct` derived
  server-side (`rating !== 'again'`). Nothing client-supplied. Defensive `card.hanja_char !== null` guard belt-
  and-suspenders against a NOT NULL violation.
- [x] **GET /hanja/attempts** — `WHERE user_id = $1`, `COUNT(*) OVER ()`, `ORDER BY created_at DESC, id DESC`,
  Zod-bounded limit(1..100)/offset. IDOR test asserts another user sees `[]`/total 0.

### F-172 Reading attempts — `routes/reading.ts` (NEW endpoints)
- [x] **IDOR-safe (ownership).** Both arms resolve the target `WHERE id = $1 AND user_id = $2` (reading.ts:698,
  717) → uniform 404 before any INSERT. Tests "another user's chapter → 404" / "another user's story → 404"
  assert 404 **and** zero rows written — they would FAIL if the `user_id` filter regressed.
- [x] **Title server-derived.** `titleSnapshot` from the scoped row (chapter title / `Chapter N` fallback /
  story title), never client text. `.strict()` discriminated union rejects a `storyId` smuggled onto the
  chapter arm (test present).
- [x] **Validation at boundary.** Zod discriminated union on `sourceKind`, positive int ids ≤ MAX_ID,
  passageNumber optional positive ≤ MAX_INT4. 8-case rejection table.
- [x] **GET** user-scoped, `COUNT(*) OVER ()`, newest-first, offset ceiling 100k. IDOR test present.

### F-172 Listening attempts — `routes/ttmik.ts` (NEW endpoints)
- [x] **Existence-gate (correct for public corpus).** `ttmik_lessons`/`iyagi_episodes` are licensed PUBLIC
  content — no per-user ownership possible/appropriate. Garbage (level,number)/episode 404s before INSERT
  (tests assert 404 + zero rows). Documented deliberately (ttmik.ts:60-70).
- [x] **Server-derived title**, `.strict()` bodies, bounded ints. GET user-scoped across BOTH corpora (one
  `listening_attempts` table), `COUNT(*) OVER ()`. IDOR test asserts per-user isolation.

### F-173 TOPIK resume item-count — `routes/topik.ts` GET /attempt
- [x] **`resolveServedTotal` reuse is correct.** Same helper `GET /topik/attempts` uses; re-derives the served
  cap via the identical `resolveMockTest` + `LIMIT OFFICIAL_MOCK_SECTION_SIZE` query.
- [x] **Never fabricates.** `totalItems: served?.totalItems ?? answered` — on an unresolvable paper it falls
  back to the real answered-count LOWER BOUND, never a guess above known. Test "falls back to the answered
  count" confirms (totalItems == answered == 2, topikLevel null).
- [x] **Deterministic I/II resolution.** `resolveMockTest` `ORDER BY test_number DESC, topik_level DESC LIMIT 1`
  (no requestedLevel, as `/mock` + resume replay send) → a resumed attempt re-resolves the SAME paper it was
  served. Cap test asserts 50 (`OFFICIAL_MOCK_SECTION_SIZE`) against 55 seeded items.
- [x] Null-attempt early-return added (topik.ts:943) — no crash on no active attempt.

### F-175 KRDICT grammar-morpheme exclusion — `routes/krdict.ts`
- [x] **NULL-safe.** `(part_of_speech IS NULL OR part_of_speech NOT IN ('어미','조사'))` — untagged rows are
  KEPT (bare `NOT IN` would drop them via 3-valued UNKNOWN). Explicit NULL-safety test present.
- [x] **Parenthesization correct.** Search branch wraps the 3-way ILIKE OR group in parens and ANDs the
  exclusion outside it (krdict.ts:190-193) — precedence bug (AND binding only the last OR arm) avoided. The
  test deliberately gives a 어미 row a definition containing the search term `학` so an un-parenthesized query
  would leak it; test asserts total 1 / only `학교`.
- [x] **Total exact.** Exclusion folded into the same WHERE the `COUNT(*) OVER ()` window rides — no separate
  count, no client adjustment.

### F-176 Vocab theme facet — `routes/vocab.ts`
- [x] **Exact match**, parameterized `($6::text IS NULL OR theme = $6)`, Zod-bounded (trim, 1..200) so an
  absurd value 400s at the boundary. Uses the `ix_vocab_entries_theme_subsection` leading column.
- [x] **GET /vocab/themes** — DISTINCT with the 42803 fix (COLLATE in the select list aliased back to `theme`
  so ORDER BY matches). No params → no injection surface. Auth-required. Empty corpus → `[]`.
- [x] Param renumbering ($6→theme, source-filter shifted to $7/$8, limit/offset $9/$10) verified consistent.

### Count reconciliation — `routes/vocab.ts` GET /vocab/cards/due
- [x] **Total cannot drift from page.** `COUNT(*) OVER ()` is on the SAME single query as the page — identical
  WHERE incl. the graduated-card exclusion `(c.grammar_entry_id IS NULL OR ge.graduated_at IS NULL)` and the
  hanja exclusion `c.hanja_character_id IS NULL`; window computed post-WHERE/pre-LIMIT. Test graduates a card
  and asserts page shrinks 2→1 AND total 2→1 in lock-step; separate test asserts total 7 with limit 2; separate
  test asserts per-user isolation (A=3, B=0).

### F-183 Writing prompt by id — `routes/writing.ts` GET /prompts/:id
- [x] **Scope-safe.** Shared reference data (no user ownership); the `is_active AND rubric IS NOT NULL` gate
  yields a uniform 404 for retired / untagged-legacy / unknown ids — no distinction leaked (nothing private to
  leak; documented). Tests cover all three → 404.
- [x] **Param validation.** `z.coerce.number().int().positive().max(MAX_ID)` via `validateParams` — `0/-1/abc/1.5`
  all 400 before the query (digits-only, bounded, no injection). Parameterized `$1`.

### `routes/plan.ts` GET /today (Wave 2, in-batch)
- [x] Reading re-sourced from user-owned `reading_chapters` + `generated_stories`; every UNION leg scoped
  `WHERE user_id = $1` — no cross-user leak (was previously public `ttmik_lessons`). Additive DTO fields only.
  Deterministic per-day md5 ordering preserved. `$1`=userId (bigint) for WHERE, `$2`=userKey (text) for hash —
  correct split.

---

## Findings

### NIT-1 — reading POST passageNumber not cross-checked against the chapter (reading.ts:707)
`passageNumber` is stored as client-supplied (bounded to MAX_INT4) without verifying it ≤ the chapter's actual
passage count. It is the caller's own self-reported progress marker on their own row (same trust model as a
hanja self-rating), so this is not a security issue — only a data-quality nit. No action required.

### NIT-2 — reading/ttmik POST lookup+insert are two statements, not one transaction (reading.ts:697-726, ttmik.ts)
The existence/ownership SELECT and the INSERT run as separate `query()` calls. If the target row were deleted
between them the INSERT would hit the FK and 500 instead of 404. In practice the target is the caller's own (or
immutable public) content within a single request, so the window is inert; a single-statement
`INSERT ... SELECT ... WHERE user_id = $2` would tighten it but is not warranted. Note only.

### PRAISE
- **cardReview.ts F-171** anchoring the attempt-log write in the existing review transaction (not a second
  route-level call) is exactly right — atomicity by construction, and the 409-rollback test proves it.
- **krdict test** deliberately constructs the AND/OR-precedence trap (a 어미 row whose definition contains the
  search term) — a test that genuinely catches the bug it guards, not a happy-path rubber stamp.
- **vocab due count** test graduates a card mid-test and asserts page and total move together — directly targets
  the "665 due vs 0 due" drift bug.
- Every attempts endpoint has an explicit cross-user IDOR test asserting `[]`/404 + zero rows — these fail if
  the `user_id` scope regresses.

---

## Server-test run result

```
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd)":/repo \
  -v /repo/server/node_modules -w /repo/server node:20-slim \
  sh -ec 'npm ci && npm run typecheck && npx vitest run \
    tests/routes/{hanja,reading,ttmik,vocab,topik,krdict,writing}.test.ts'
```
- typecheck: **clean**
- Test Files: **7 passed (7)**
- Tests: **446 passed (446)**  (duration ~506s)

## Coordination
- No overlap with the mobile/frontend batch (different files). No code changes made by this review.
- Migrations 059/060/061 (hanja/reading/listening `_attempts`) are consumed correctly by the routes; migration
  correctness itself is out of this route-level scope but the constraints/FKs behaved as expected under the
  real testcontainer suite.
