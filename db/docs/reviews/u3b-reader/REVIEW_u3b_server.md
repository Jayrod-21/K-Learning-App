# Independent Review — U3b Server Surface (`feat/u3b-chapter-reader`)

Reviewer: independent senior review (not the author). Scope: server surface only —
`server/src/routes/reading.ts`, `server/src/app.ts` mount, nginx allow-list (both colors),
`server/tests/routes/reading.test.ts`, and the new seed helpers in
`server/tests/helpers/seed.ts`. The migration itself is out of scope (another reviewer has it).

## Summary verdict

**PASS.** No blockers found. IDOR posture is correct and matches the established
`uploads.ts`/`vocab.ts` precedent (uniform 404, user-scoped queries, parameterized SQL,
bounded/coerced ids). The nginx allow-list update is present in all 4 required locations. Test
coverage genuinely exercises the IDOR paths and would catch a regression in the
chapter-detail scoping; one path (the list route's belt-and-suspenders `user_id` filter) has
a test that would still pass if that specific redundant filter were removed, because a prior
gate already 404s first — flagged below as a coverage nit, not a security gap.

**Findings: 0 BLOCKER, 1 SHOULD-FIX, 2 NIT, 3 PRAISE.**

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
1. `reading.ts:20-26` — header comment is internally inconsistent / confusing on first
   read (see Detailed Findings #1). Not a functional bug (behavior + tests agree), but it
   will mislead the next engineer who edits this file, which is exactly the failure mode
   this codebase's doc-comments elsewhere (`uploads.ts`, `vocab.ts`) are written to prevent.

### NIT
1. `reading.ts:58-98` — the list route does not gate on `book_uploads.type = 'literature'`,
   so calling it against a non-literature owned upload silently returns `200 { chapters: [] }`
   rather than a distinguishable error. Harmless today (no ingestion path ever attaches
   chapters to a non-literature upload), but worth a thought if a future loader bug ever
   attaches chapters to the wrong upload type.
2. `reading.test.ts` has no case that would fail if the *redundant* `AND user_id = $1` on
   the `reading_chapters` query in the list route (`reading.ts:94`) were deleted — the
   preceding ownership pre-check (`reading.ts:75-81`) already 404s first, so that specific
   line is untested in isolation. Not a security gap (defense-in-depth code, and the
   detail-route equivalent at `reading.ts:143` IS effectively tested — see Praise #2) — just
   noting for completeness per the review brief's explicit ask.

### PRAISE (fix-pass must not undo)
1. `reading.ts:151-165` — the chapter-detail route's passage query scopes only by
   `chapter_id` (no `user_id` on that second query), and that is *correct*, not an
   oversight: `chapterId` is only ever used in the passages query after the chapter SELECT
   at `reading.ts:139-145` has already proven `id = $1 AND user_id = $2` matched. There is
   no code path where `chapterId` reaches the passages query without having passed that
   gate first (the handler `throw`s and returns via `next(err)` before falling through).
   This is the right shape for the "ownership already established, second query trusts the
   verified id" pattern, and the IDOR test at `reading.test.ts:190-204` (owner seeds a
   passage with a literal `'비밀 내용'` body, a second user requests the same chapter id)
   would fail loudly (200 body leak) if a future edit accidentally scoped the passages query
   on the wrong variable or dropped the chapter-ownership gate. Keep this test; it is
   the one guarding the single riskiest line in the file.
2. `reading.test.ts:190-204` and `reading.test.ts:103-121` — both cross-user IDOR tests
   assert the uniform `404`, not a differentiated error, matching the "don't confirm
   existence" contract in the header doc and in `uploads.ts`. Good discipline; matches the
   sibling test suite's convention.
3. Nginx allow-list is correctly updated in **all 4** required locations: `reading` is
   present in the regex `location ~ ^/(...|uploads|reading)(/|$)` at both `nginx-blue-
   active.conf:82` and `:137`, and both `nginx-green-active.conf:82` and `:137` — confirmed
   by direct grep, not by reading the app.ts comment alone. This is exactly the class of bug
   (`km-nginx-api-route-allowlist` — the F-012 lesson) that has bitten this repo before, and
   it was NOT missed here.

## Detailed findings

### 1. Confusing/self-contradictory header comment — `reading.ts:20-26` (SHOULD-FIX)

```
20   *   - IDOR: reading_chapters.user_id is the book owner (pinned to it by the
21   *     migration-044 composite FK, so it can never drift), so every read scopes
22   *     directly on `user_id = getUserId(req)`. Another user's upload id yields an
23   *     empty chapter list; another user's chapter id yields 404 (not 403 — don't
24   *     confirm existence), identical to a missing id so probing id-space reveals
25   *     nothing. The chapter-list endpoint additionally 404s an upload the user
26   *     doesn't own (or that isn't a real upload), so the client can tell "not
27   *     your book" from "your book, no chapters yet" without leaking other users'
28   *     ids (the ownership check is itself user-scoped).
```

Line 22-23 says "another user's upload id yields an *empty chapter list*." Lines 25-26 then
say the list route "*additionally 404s*" a not-owned upload. These two sentences describe
two different (and mutually exclusive, for the same request) behaviors for the exact same
scenario. Read in isolation, sentence 1 sounds like a design decision (return `[]`, don't
leak existence via a 404/200 split); sentence 2 says the opposite happened (404, not `[]`).

The *actual implemented and tested* behavior is sentence 2: `reading.ts:75-81`'s ownership
pre-check throws `NotFoundError` before the chapters query ever runs, and
`reading.test.ts:103-121` explicitly asserts `404` for another user's upload id, not `200
[]`. So the code and tests agree with each other — only the comment is internally
inconsistent. Best read as: sentence 1 is describing what the *bare* `user_id` scoping on
`reading_chapters` alone would produce if the pre-check didn't exist, as motivation for why
the pre-check was added — but as written it reads as a factual claim about current behavior,
directly contradicted two sentences later. Recommend rewording before merge so a future
reader doesn't have to reverse-engineer which sentence is stale.

### 2. IDOR trace — chapter list route (`reading.ts:58-108`)

- `ChapterListQuerySchema` requires `source_upload_id`, coerced/bounded (`z.coerce.number
  ().int().positive().max(MAX_ID)`) — missing param → Zod required-field failure → 400
  (tested `reading.test.ts:123-126`); non-numeric or `0` → 400 (tested `:128-132`).
- Ownership gate (`:75-81`): `SELECT id FROM book_uploads WHERE id = $1 AND user_id = $2`.
  Both "upload doesn't exist" and "upload exists, owned by someone else" fail this query
  identically (no row) → same `NotFoundError` → same 404 response shape. No distinguishable
  signal leaks to the caller either way (verified by reading the single `if (owned.rows
  .length === 0)` branch — there's only one throw site, not two).
- Chapters query (`:85-98`) additionally filters `WHERE user_id = $1 AND source_upload_id =
  $2`. Given the composite FK asserted in the header (`reading_chapters.user_id` is pinned
  to the owning `book_uploads.user_id`), this is redundant with the pre-check but harmless —
  defense-in-depth, not a bug. (Composite FK enforcement itself is the migration reviewer's
  concern, not verified independently here — flagged as an assumption this route's safety
  partially rests on.)
- Response: `{ chapters: [{ id, chapter_number, title, start_page, end_page }] }`, `id`
  coerced `Number()` from pg's BIGINT string — correct, matches the `uploads.ts` /
  `vocab.ts` convention for BIGINT DTOs.

### 3. IDOR trace — chapter detail route (`reading.ts:116-183`)

- `ChapterParamsSchema`: `chapterId` coerced/bounded, same MAX_ID pattern. Garbage
  (`abc`, `-1`) → 400, tested `reading.test.ts:206-210`.
- Chapter SELECT (`:131-145`): `WHERE id = $1 AND user_id = $2` — single query folds
  "missing" and "not yours" into one `NotFoundError` → uniform 404. Tested at `:185-188`
  (nonexistent) and `:190-204` (cross-user, with a seeded secret-body passage to prove no
  leak).
- Passages SELECT (`:154-165`): `WHERE chapter_id = $1` only, **no** `user_id` filter — this
  is safe *because* `chapterId` cannot reach this line without having already matched
  `user_id = getUserId(req)` in the query immediately above (the function returns via
  `next(err)` on the `NotFoundError` throw before falling through). Traced the control flow
  line-by-line to confirm there's no alternate path (e.g., no reuse of a request-supplied
  chapter id elsewhere, no re-fetch by a different variable) — confirmed safe.
- Response DTO explicitly re-lists `chapter` fields (`:168-176`) rather than spreading the
  raw row — marginally more defensive against an accidental future `SELECT *`-style column
  leak than the list route's spread-based DTO (`:102`), but this is a style asymmetry
  between the two handlers, not a bug in either.

### 4. SQL / injection posture

All 4 queries across both handlers are parameterized (`$1`, `$2`, …) with no string
interpolation of request-derived values — confirmed by reading every query literal in the
file. `MAX_ID = Number.MAX_SAFE_INTEGER` bound on both `source_upload_id` and `chapterId`
matches the established `vocab.ts:44-48` / `uploads.ts:97-102` rationale (Zod's
`int().positive()` alone would pass a 20-digit value and overflow Postgres `int8`,
surfacing as an unhandled 500 instead of a clean 400/404) — correctly mirrored here.

### 5. nginx allow-list (grepped directly, not inferred from comments)

```
nginx-blue-active.conf:82:   location ~ ^/(...|uploads|reading)(/|$) {
nginx-blue-active.conf:137:  location ~ ^/(...|uploads|reading)(/|$) {
nginx-green-active.conf:82:  location ~ ^/(...|uploads|reading)(/|$) {
nginx-green-active.conf:137: location ~ ^/(...|uploads|reading)(/|$) {
```
`reading` present in all 4 locations (2 per file × 2 files) — the route will not be shadowed
by the SPA catch-all in prod on either blue or green. `app.ts:103-106`'s comment correctly
flags the requirement and matches what's actually in both conf files.

### 6. Mount ordering — `app.ts:106`

`/reading` is mounted after `/uploads` and before the 404 fallthrough (`:109`) and error
handler (`:116`). No prefix collision with any existing router (`/reading` doesn't share a
segment with any sibling mount — `/grammar` vs `/grammar-drill` is the only place this repo
has needed defensive ordering, and `/reading` has no such sibling). Ordering is correct and
non-issue.

### 7. Auth / rate-limiting consistency

- `router.use(requireAuth)` at the top of `reading.ts:41`, identical placement to
  `uploads.ts:91` and `vocab.ts:23`. Both routes additionally apply `cheapLimiter()`
  (`:60`, `:118`) — the correct tier for cheap, read-only, non-media, non-Claude-cost
  endpoints, matching `vocab.ts`'s GET routes and `uploads.ts`'s metadata GETs (`mediaLimiter`
  is reserved for the actual byte-streaming route in `uploads.ts`, which has no analog
  here since passages are `TEXT`, not images).
- Auth-required test (`reading.test.ts:45-53`) covers both routes with a table-driven
  `it.each`, asserting 401 unauthenticated — consistent with sibling suites.

### 8. Test completeness

Covered: auth-required (both routes), ordering (both routes, seeded out-of-order),
owned-empty-list 200, owned-empty-passages 200, nonexistent-id 404 (both routes),
cross-user 404 (both routes, with a real secret-body seed to make the leak check
meaningful rather than vacuous), missing required param 400, garbage/zero/negative param
400 (both routes). This is a complete match against the review brief's checklist. The one
gap is the redundant-filter point noted under NIT #2 above — not a security hole, a coverage
completeness note only.

Seed helpers (`seed.ts:731-781`, `seedReadingChapter` / `seedReadingPassage`) insert directly
via parameterized `INSERT ... RETURNING id`, bypassing the route layer entirely (appropriate
for test setup) and mirror the existing `seedBookUpload` helper's shape/conventions
(`Number(rows[0]!.id)` return, optional-fields-with-defaults pattern). No concerns.

## Coordination observations

- The migration (out of scope here) is a load-bearing assumption for Finding #2's
  "redundant but harmless" characterization and for the header's composite-FK claim
  (`reading.ts:20-21`) — the migration reviewer should independently confirm
  `reading_chapters.user_id` truly cannot drift from `book_uploads.user_id` (i.e., the FK is
  actually composite/enforced, not just asserted in a comment). If that FK is *not* actually
  enforced at the DB level, Finding #2's "redundant" characterization of the `user_id` filter
  on the chapters query would become load-bearing rather than defense-in-depth, and the same
  question would apply to whether `reading_passages` rows could ever exist under a chapter
  they don't logically belong to.
- No client-side (`Reading.tsx`, `client/src/services/reading.ts`) or loader
  (`load_literature.py`) code was in scope for this review per the assignment; those are
  presumably covered by other reviewers per `U3_READER_DESIGN.md`'s phase breakdown.
