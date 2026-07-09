# U3a review — test + seed-helper surface

Reviewer scope: `server/tests/helpers/seed.ts` (new `sourceUploadId` param),
`server/tests/routes/vocab.test.ts` and `server/tests/routes/grammar.test.ts`
(new `source_upload_id` filter describe blocks). Route SQL itself is covered
by another reviewer; I read it only for context to judge whether the tests
actually exercise the ownership guard.

## Summary verdict

**APPROVE WITH SHOULD-FIX.** No blockers. The core IDOR/ownership-guard test
in both files is real — it seeds a row tagged to the *owner's* upload and
asserts a *different* user querying that same upload id gets zero rows, which
would only pass if the `EXISTS (... bu.user_id = $7)` guard is actually
wired in. It fails for the right reason if the guard is removed (see
Detailed Findings #1). The seed-helper diff is clean and safe. The main gap
is coverage asymmetry: the grammar block has 3 tests where vocab has 5,
missing the "omitted filter → all rows" and "non-existent id → empty 200"
cases that the review brief explicitly calls out as required boundary tests,
plus neither file tests the "tagged to a different *owned* upload is
excluded" case (equality-vs-EXISTS-only bug class).

## Findings by category

**BLOCKER:** none.

**SHOULD-FIX:**
- SF-1: `grammar.test.ts` U3a block is missing the "omit filter → returns all
  rows (tagged + untagged)" test that `vocab.test.ts` has.
- SF-2: `grammar.test.ts` U3a block is missing the "non-existent upload id →
  200 empty" test that `vocab.test.ts` has.
- SF-3: Neither file tests a row tagged to a *different upload the same user
  owns* being excluded when filtering by the first upload — the one case
  that would catch an EXISTS-only implementation bug (guard checks ownership
  but drops the `source_upload_id = $6` equality), which the current tests
  don't fully rule out.

**NIT:**
- N-1: Garbage-id boundary test uses inconsistent invalid values across
  files (`-1` in vocab vs `0` in grammar) — harmless, both correctly 400, but
  worth aligning for readability.
- N-2: No test drives `source_upload_id` above `Number.MAX_SAFE_INTEGER`
  (the `MAX_ID` bound the route comments call out as a defense against pg
  overflow). Consistent with the rest of the codebase's existing ID-param
  tests (none of them test this either), so not a regression — just noting
  it's still an open gap if a reviewer wanted it closed.

**PRAISE (fix-pass must not undo):**
- P-1: The ownership-guard test genuinely exercises the guard rather than
  passing vacuously — see Detailed Findings #1. This is the test that
  matters most in this surface and it's done correctly.
- P-2: `seedVocabEntry`/`seedKgiuEntry` diffs are minimal, additive-only,
  default to `NULL`, and don't disturb any existing positional/param
  ordering — verified no existing caller can regress (see #3).
- P-3: Both new describe blocks correctly re-`TRUNCATE` the shared
  reference table in their own `beforeEach`, matching the sibling
  domain/book_level filter blocks' established isolation pattern.

## Detailed findings

### 1. IDOR/ownership-guard test — real, not vacuous

`server/tests/routes/vocab.test.ts:190-211` and
`server/tests/routes/grammar.test.ts:220-233`.

Both seed an entry tagged with `ownerUpload` (owned by user A), then have a
*second, distinct* registered user B query
`?source_upload_id=${ownerUpload}` and assert `200` + empty result
(`total: 0` / `entries: []`).

I checked this against the actual route SQL (`server/src/routes/vocab.ts`
diff, `server/src/routes/grammar.ts` diff — read for context only): the
filter is `source_upload_id = $6::bigint AND EXISTS (SELECT 1 FROM
book_uploads bu WHERE bu.id = $6 AND bu.user_id = $7)`, where `$7` is the
*requesting* user's id. `vocab_entries`/`kgiu_entries` themselves carry no
`user_id` — they're shared reference rows scoped only through the tagged
upload. If the `EXISTS` clause were deleted (leaving bare
`source_upload_id = $6`), user B's query would return the row (it's tagged
with `ownerUpload`, and nothing else gates it), so `total`/`entries` would be
non-empty and the test would fail. This confirms the assertion depends on
the guard, not on the row being absent for unrelated reasons — the row
*does* exist and *is* tagged with the id being queried; only the
cross-user ownership check keeps it out. This is exactly the test a 30-year
reviewer would insist on, and it's implemented correctly.

### 2. Boundary tests — present but asymmetric between the two files

`vocab.test.ts` (5 tests, lines 152-226) covers all four boundary shapes the
brief calls for: narrows-correctly (159-177), omitted-filter-returns-all
(179-188), IDOR-zero-rows (190-211), non-existent-id-empty-200 (213-219),
garbage-id-400 (221-225).

`grammar.test.ts` (3 tests, lines 198-240) covers only narrows-correctly
(205-218), IDOR-zero-rows (220-233), garbage-id-400 (235-239). It is missing
the omitted-filter and non-existent-id cases (SF-1, SF-2 above). Given the
grammar route's WHERE clause is a near-identical mirror of the vocab route's
(`server/src/routes/grammar.ts` lines ~93-99 vs
`server/src/routes/vocab.ts` lines ~130-138), there's no principled reason
for grammar's test coverage to be thinner — this reads like the grammar
block was written first/faster and the last two vocab cases weren't ported
back. Recommend adding both to `grammar.test.ts` before merge; they're cheap
(each is a ~10-line copy of the vocab equivalent, symbol-for-symbol).

### 3. Seed-helper correctness — clean

`server/tests/helpers/seed.ts`:

- `seedVocabEntry` (lines 74-117): INSERT column list
  (`...proficiency, source_upload_id)`, line 99) has 12 columns; VALUES
  clause (`...$9::proficiency_level, $10`, line 101) has 12 slots (10
  params + 2 inline literals); the params array (lines 103-114) supplies
  exactly 10 values in the same order the `$N` placeholders reference them,
  ending with `opts.sourceUploadId ?? null` at `$10` (line 113). Verified
  by direct column-by-column comparison against the pre-diff version
  (`git diff -- server/tests/helpers/seed.ts`) — the only change is the
  additive 12th column/param; nothing upstream was reordered. Default
  `?? null` preserves every existing caller's behavior (no caller anywhere
  in the test suite passes a positional args array, all use the options
  object, so this is safe by construction).
- `seedKgiuEntry` (lines 129-171): same shape — INSERT column list gains
  `source_upload_id` (line 155), VALUES gains `$8` (line 157), params array
  appends `opts.sourceUploadId ?? null` (line 167). The existing
  placeholder-to-column mapping is unusual (`$4`→pattern, `$6`→category,
  `$5`→proficiency, `$7`→unit — placeholders aren't in column order) but
  that layout is pre-existing, not introduced by this diff, and the new
  `$8`/`source_upload_id` slots straightforwardly onto the end without
  touching any of that existing mapping.
- Both new JSDoc blocks (lines 84-89, 139-144) correctly describe the param
  as nullable, defaulting to NULL, and its purpose (exercising the U3a
  filter) — accurate and useful for future readers.

### 4. Test isolation — correct, no cross-test bleed

`vocab.test.ts:155-157` and `grammar.test.ts:201-203` each `TRUNCATE` the
shared reference table (`vocab_entries` / `kgiu_entries` respectively) in a
block-local `beforeEach`, matching the exact pattern used by the adjacent
`domain + book_level filters` blocks (`vocab.test.ts:231-232`,
`grammar.test.ts:117-118`). Because vitest runs `beforeEach` hooks
outermost-first, the file-level `beforeEach` (`vocab.test.ts:38-40` —
truncates `users`/`sessions`/`vocab_cards` CASCADE; `grammar.test.ts:33-35`
— truncates `users`/`sessions`/`grammar_entries` CASCADE) always runs before
the block-local one, so by the time each U3a test body runs, both the
user-scoped tables and the reference table are freshly empty regardless of
what earlier describe blocks left behind. No ordering hazard between blocks.

### 5. Missing case a 30yr engineer would flag (SF-3 detail)

None of the 8 new tests seed two *different, both-owned* uploads for the
same user and confirm filtering by upload A excludes a row tagged to upload
B. The existing "narrows to entries tagged with the given owned upload"
tests (`vocab.test.ts:159-177`, `grammar.test.ts:205-218`) pair a tagged row
with an *untagged* (`source_upload_id IS NULL`) row, which only rules out an
implementation that ignores the filter entirely — it does not rule out an
implementation bug where the `EXISTS` ownership check is present but the
`source_upload_id = $6` equality is accidentally dropped (i.e., "any row
tagged with *any* upload owned by this user matches", not "this specific
upload"). Concretely: if the WHERE clause were mis-refactored to
`$6::bigint IS NULL OR EXISTS (SELECT 1 FROM book_uploads bu WHERE bu.id =
source_upload_id AND bu.user_id = $7)` (dropping the outer equality against
the query param), the current tests would still pass, because the untagged
control row has `source_upload_id IS NULL` and would never satisfy that
`EXISTS` either way. A second-upload-same-owner case is the only test shape
that would catch this class of bug. Recommend adding it to both files.

## Coordination observations

- The route SQL in `server/src/routes/vocab.ts` and
  `server/src/routes/grammar.ts` (not my assigned surface, read only for
  context) implements the identical `source_upload_id = $N AND EXISTS(...
  user_id = $M)` guard shape in both routes — the test asymmetry (SF-1/SF-2)
  is purely a test-authoring gap, not a reflection of divergent route
  behavior. Whoever owns the route-SQL review should not need to re-derive
  this; the two routes are structurally identical for this filter.
- Nothing in this surface touches the nginx allow-list concern the design
  doc calls out (`db/docs/U3_READER_DESIGN.md:78-80`) — that's a U3b/reading
  concern, not applicable to U3a's vocab/grammar routes.
- No conflicts observed between the seed-helper changes and anything else
  in flight; the new `sourceUploadId` param is purely additive and isolated
  to the two functions touched.
