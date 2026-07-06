# Review

Independent review of `server/src/routes/topik.ts` + `server/tests/routes/topik.test.ts`
on `fix/sweep-batch-b` (`git diff HEAD~1`). Scope: the new shared constant
`ANSWERABLE_ITEM_SQL` (survivor guard + picture-choice exclusion) applied to
`GET /items`, `POST /study`, `resolveMockSourceTest`, `POST /mock` assembly, and
`POST /mock/submit` grading. Cross-checked against `db/docs/SWEEP_REVIEW_TOPIK_REF.md`
findings P2-1 (60 unanswerable picture-choice listening items) and P3-3 (`/study`
lacked the survivor guard).

## Verdict

**APPROVE.** The fix is correct, the five sites are consistent, and the highest-risk
property — that `/mock` assembly and `/mock/submit` grading agree exactly — holds
by construction (byte-identical SQL). No legit item is wrongly excluded, no
placeholder numbering shifted, no injection surface, no test-corpus starvation.
One real SHOULD-FIX: the new test never exercises `/mock/submit` directly, so
"assembly and grading agree" is verified by code inspection here, not by the
regression test itself — a future edit to only one of the two sites would not be
caught. `42/42` tests pass (`npx vitest run tests/routes/topik.test.ts`).

## Findings

### SHOULD-FIX

- **New test doesn't call `/mock/submit`, so it can't catch assembly/grading drift.**
  The added test (`server/tests/routes/topik.test.ts:142-186`) posts to `/topik/study`
  and `/topik/mock` and asserts the picture item is absent from both, but never posts
  to `/topik/mock/submit`. Given this PR's own stated highest risk is assembly vs.
  grading divergence, the test should also submit the assembled mock (or a synthetic
  answer set for `sourceTest: 950, section: 'listening'`) and assert `totalItems`
  reflects only the answerable items (i.e. excludes the picture item), so a future
  change to only one of the two `ANSWERABLE_ITEM_SQL` call sites fails CI instead of
  only being caught by manual code review.
- **The `tooFew` assertion in the new test doesn't actually exercise the SQL-level
  fix.** `mapRowToDTO` (`topik.ts:207-210`) already drops any row with `< 2` options
  post-fetch, independent of this diff — that guard predates this PR. So
  `studyIds).not.toContain(String(tooFew))` (test line ~172) would pass identically
  whether or not `ANSWERABLE_ITEM_SQL` is in the `/study` WHERE clause; it doesn't
  regression-test P3-3. The P3-3 finding's actual symptom — "`ORDER BY random() LIMIT
  10` wastes slots on ungradeable rows, so a 10-item draw returns ~9" — needs a pool
  where good items ≥ `limit` but bad rows are mixed in, so the *count* of returned
  items is the assertion, not just membership. As written, the test's pool (3 rows,
  `limit: 50`) can never reproduce that undercount regardless of the fix.

## NIT

- `ANSWERABLE_ITEM_SQL`'s doc comment (`topik.ts:349-358`) is thorough about *what*
  and *why* but doesn't explicitly state the placeholder-safety invariant ("contains
  no `$n` placeholders — do not add one without renumbering every call site"). Given
  this review was specifically asked to check for placeholder-numbering regressions,
  a one-line invariant comment would make that safe-by-inspection for the next editor
  instead of safe-by-audit.

## PRAISE

- **`POST /mock/submit` gained a real defense-in-depth fix, not just a cosmetic one.**
  Pre-diff, the grading query (`topik.ts:614-623` region) had **no SQL-level survivor
  guard at all** (not even the pre-existing `jsonb_array_length>=2 AND answer IS NOT
  NULL` that `/mock` assembly already had) — it relied entirely on `mapRows` dropping
  `<2`-option rows post-fetch, and had no defense against bare-glyph picture items
  leaking into the grading universe. This diff brings grading up to the same
  SQL-enforced guard as assembly, which is a strictly stronger design (matches the
  file's own stated philosophy of "build the WHERE once so N queries agree by
  construction," `topik.ts:399-401`).
- Placeholder numbering is untouched everywhere, correctly reasoned: `ANSWERABLE_ITEM_SQL`
  contributes zero entries to any `params`/`filterParams` array (it's ANDed into the
  filter list as a single pre-built string with no `$n` inside), so `$1`/`$2`/... in
  all five call sites still line up with their original array positions.
- DB-verified: exactly 60 rows match the exclusion predicate, all `section=listening`,
  no `section=reading` row is caught, and the regex sweep (`options->>0 ~ '①|②|③|④'`)
  found no near-miss variant (e.g. `'①번'`, padded glyph) slipping through — the fix
  is tuned to exactly the corpus the sweep identified, no more, no less.

## Detailed

### 1. Mock assembly vs. grading — byte-identical WHERE (highest risk, CONFIRMED SAFE)

`server/src/routes/topik.ts:521-530` (`/mock` assembly) vs. `server/src/routes/topik.ts:614-623`
(`/mock/submit` grading):

```
diff <(sed -n '521,530p' topik.ts) <(sed -n '614,623p' topik.ts)
9c9
<       [sourceTest, body.section],
---
>       [body.sourceTest, body.section],
```

The only difference is the JS variable feeding `$1` (`sourceTest` — the resolved value,
possibly server-picked — in assembly; `body.sourceTest` — client-echoed from the
assembly response — in grading), which is expected: `/mock` returns the resolved
`sourceTest` in its response specifically so the client can round-trip it into
`/mock/submit` (`topik.ts:501-503`, `532-536`). The SQL text itself — `SELECT
${ITEM_COLUMNS} ... WHERE t.test_number = $1 AND i.section = $2::topik_section AND
${ANSWERABLE_ITEM_SQL} ORDER BY i.item_number` — is identical. Given identical
`(test_number, section)` inputs, the two queries return the identical item set.
Verified this was NOT true of only one side pre-diff: prior to this PR, `/mock/submit`
had zero SQL-level survivor guard (see PRAISE above) while `/mock` assembly already
had the pre-picture-exclusion guard — the two were only "accidentally" consistent
because `mapRows` independently dropped `<2`-option rows on the grading side. This PR
converts that accidental agreement into structural agreement.

### 2. Placeholder numbering — all 5 sites checked, none shifted

- `GET /items` (`topik.ts:402-438`): `filters` starts as `[ANSWERABLE_ITEM_SQL]` (was
  2 non-parameterized strings, now 1 non-parameterized string — net effect on
  `filterParams.length` is zero either way since neither entry ever pushed a param).
  `$1`/`$2`/`$3` for `section`/`level`/`source_test` are pushed conditionally and
  numbered by `filterParams.length` at push time — unaffected. `limitPlaceholder`/
  `offsetPlaceholder` computed as `filterParams.length+1`/`+2` — unaffected.
- `resolveMockSourceTest` (`topik.ts:483-492`): single `$1` (section) — `ANSWERABLE_ITEM_SQL`
  is ANDed in with no placeholder of its own — unaffected.
- `POST /mock` assembly (`topik.ts:521-530`) and `POST /mock/submit` grading
  (`topik.ts:614-623`): `$1`=test_number, `$2`=section, both pre-existing; the new
  `AND ${ANSWERABLE_ITEM_SQL}` line is appended after `$2` in the WHERE clause text
  but introduces no new placeholder — unaffected.
- `POST /study` (`topik.ts:713-734`): `filters` starts as `[ANSWERABLE_ITEM_SQL]` (was
  `[]` — this is the actual P3-3 fix). `section`→`$1`, `level`→`$2` pushed
  conditionally via `params.length`, then `limit`→final `$${params.length}` — all
  three still track `params.length` correctly since `ANSWERABLE_ITEM_SQL` never
  touches `params`.

### 3. Injection — confirmed a fixed literal, no interpolation of external input

`ANSWERABLE_ITEM_SQL` (`topik.ts:359-361`) is a module-level `const` string built once
from hardcoded glyphs (`'①','②','③','④'`) and a fixed column-reference expression
(`i.options`, `i.answer`) — no request/session/DB value is ever concatenated into it.
It's spliced into each query via template-literal interpolation (`${ANSWERABLE_ITEM_SQL}`),
which is the same "build a fixed WHERE fragment, `${}` it into the query text, and pass
真actual values only via `$n` placeholders" pattern already used by `ITEM_COLUMNS`
and `whereClause` elsewhere in this file — consistent with the codebase's existing
idiom, not a new pattern to scrutinize. Actual runtime values only ever enter via
`$n` placeholders, never string interpolation.

`i.options->>0` is safe given the guard ordering concern raised in the task: Postgres
does not guarantee left-to-right short-circuit evaluation of `AND` in a `WHERE` clause,
but this doesn't matter here because `jsonb_array_length(options) >= 2` failing does
NOT make `options->>0` throw — a `jsonb` array index out of bounds (or on an empty
array) returns SQL `NULL`, not an error. The only case `->>0` (or `jsonb_array_length`)
would error is `options` holding a non-array JSON value (e.g. a corrupted object row) —
that's a pre-existing risk in `jsonb_array_length(i.options)` from before this diff,
not introduced or worsened here.

### 4. Over/under-exclusion — DB-verified against the live corpus

```sql
-- All 60 excluded rows, grouped:
SELECT section, has_image, image_text IS NULL, count(*)
FROM topik_items
WHERE jsonb_array_length(options)>=2 AND answer IS NOT NULL
  AND options->>0 IN ('①','②','③','④')
GROUP BY 1,2,3;
--  listening | f | t | 12
--  listening | t | t | 48
```

All 60 are `section=listening`; none are `reading` (no legit reading item is caught).
12 of the 60 have `has_image=false` (inconsistent with the `SWEEP_REVIEW_TOPIK_REF.md`
narrative that all 60 are `has_image=true`) — inspected these individually and they
are genuinely the same class of bug: their `stem` embeds a bracketed Korean
description of the picture/graph (`[그림 선택: ...]` / `[그래프 선택: ...]`) but the
`options` JSONB is still the bare `["①","②","③","④"]` array the client actually
renders as clickable choices (`mapRowToDTO`, `topik.ts:215-224`, maps `options[i]` →
`kr` verbatim) — so functionally these are exactly as unanswerable via the app UI as
the `has_image=true` ones; the `has_image` flag is just an inconsistently-set corpus
attribute, not a signal the fix depends on (correctly — the fix keys off `options`
content, not `has_image`).

```sql
-- Full options array, not just element 0 — confirms ALL 4 choices are bare glyphs,
-- not just a coincidental first element:
SELECT options, count(*) FROM topik_items
WHERE jsonb_array_length(options)>=2 AND answer IS NOT NULL AND options->>0 IN ('①','②','③','④')
GROUP BY options;
--  ["①", "②", "③", "④"] | 60
```

```sql
-- Near-miss variant sweep (padding, "①번", trailing space) — none found:
SELECT options->>0, count(*) FROM topik_items
WHERE jsonb_array_length(options)>=2 AND answer IS NOT NULL AND options->>0 ~ '①|②|③|④'
GROUP BY 1;
--  ① | 60
```

No under-exclusion (no variant glyph form slips past `NOT IN`) and no
over-exclusion (no reading item, no item with real option text starting with `①`,
is caught).

### 5. Starvation — no test/section fully empties post-fix

```sql
SELECT t.test_number,
  count(*) FILTER (WHERE jsonb_array_length(i.options)>=2 AND i.answer IS NOT NULL) AS before_g,
  count(*) FILTER (WHERE jsonb_array_length(i.options)>=2 AND i.answer IS NOT NULL
                     AND i.options->>0 NOT IN ('①','②','③','④')) AS after_g
FROM topik_items i JOIN topik_tests t ON t.id=i.topik_test_id
WHERE i.section='listening' GROUP BY t.test_number
HAVING count(*) FILTER (WHERE jsonb_array_length(i.options)>=2 AND i.answer IS NOT NULL
                          AND i.options->>0 NOT IN ('①','②','③','④')) = 0;
-- 0 rows: no listening test loses all its gradeable items
```

Repeated for `section='reading'`: 0 rows differ before vs. after at all (no reading
item is touched, as expected). Also confirmed the mock picker's pick is unaffected:
`max(test_number)` among gradeable-post-guard listening items is still `102` — same
test the pre-fix `SWEEP_REVIEW_TOPIK_REF.md` repro named, so the "highest test with
a gradeable item in-section" candidate set didn't lose its top entry; the mock
picker still resolves normally rather than degrading to `null`/"no mock." Grouped by
`(section, proficiency)`, the only `(section, proficiency)` bucket that goes to 0
post-guard is `writing`/`''` (blank proficiency), which was **already 0 pre-guard**
— not a regression, just an empty bucket that stayed empty (and `/study`'s
`SectionSchema` still principally serves reading/listening/writing generally, while
`/mock` rejects writing outright via `MockSectionSchema` regardless of this fix).

### 6. Test suite

```
npx vitest run tests/routes/topik.test.ts
 ✓ tests/routes/topik.test.ts (42 tests) 27753ms
 Test Files  1 passed (1)
      Tests  42 passed (42)
```

`beforeEach` (`topik.test.ts:56-60`) truncates `topik_items`/`topik_tests` (and
`topik_responses`/`sessions`/`users` via CASCADE) before every test, so the new
test's 3-row pool (`normal`, `picture`, `tooFew`, all `testNumber: 950`) is fully
isolated from the corpus and from other tests — real isolation, not shared fixture
state. Confirmed the `picture`-exclusion assertions genuinely fail on pre-fix code:
with `limit: 50` against a 3-row truncated pool, pre-fix `/study` (no guard at all)
and pre-fix `/mock` (guard without the glyph exclusion) would both return the
`picture` row (`mapRowToDTO` maps a valid 4-element string array with a non-null
answer into a normal DTO — it has no special-case for bare-glyph option text), so
`not.toContain(picture)` is a real regression test for P2-1 on both routes. The
`tooFew` assertion, per the SHOULD-FIX above, is not — `mapRowToDTO`'s pre-existing
`rawOptions.length < 2 → null` guard (line 210) already drops it regardless of this
diff's SQL guard.
