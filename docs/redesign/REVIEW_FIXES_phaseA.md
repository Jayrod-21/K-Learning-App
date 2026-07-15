# Re-review — Phase A fix-pass (B-017 / F-173 / act() timing)

Branch `feat/beta-phaseA-partials` @ `a79d190` (base `rebuild`). Independent
re-review of `FIX_REPORT_phaseA.md`'s claims against the actual diff
(`git diff 2c0c805 a79d190`). Did not write the original code, did not review
the pre-fix originals, did not run the fix-pass. Verified everything below
directly against source and by re-running the gates.

## Verdict: PASS

All 3 SHOULD-FIX items are genuinely fixed, no regressions, no scope creep.
Ready to ship.

## Finding-by-finding

### 1. B-017 — rubric bucketing exhaustiveness → **FIXED**

`client/src/pages/Mistakes.tsx` now has two exhaustive `switch` statements
over `WritingAttemptDTO['rubric']` (`WritingRubric = 'topik_ii_53' |
'topik_ii_54' | 'free_write'`):

- `writingRubricLabel` (label per row) — `switch` with a `default: { const
  exhausted: never = rubric; throw ... }` branch.
- New `writingRubricBucket(rubric): 'topik' | 'generated'` — same idiom,
  used by both `topikAttempts`/`generatedAttempts` filters, replacing the
  old two-way `.filter(!== 'free_write')` / `.filter(=== 'free_write')`
  split flagged by the original review.

**Sanity check performed:** temporarily widened `WritingRubric` in
`client/src/types/domain.ts` to add a 4th member (`'bonus_round'`), re-ran
`tsc -p tsconfig.app.json --noEmit --incremental false`. Result: **2 compile
errors**, both at the two `never`-typed default branches in `Mistakes.tsx`
(`TS2322: Type '"bonus_round"' is not assignable to type 'never'`). Reverted
the change immediately (`git diff --stat` on `domain.ts` confirms clean
restore). This is a real compile-time guarantee, not a `default:` fallthrough
dressed up — a 4th rubric value cannot ship without touching this file.

**Existing behavior unchanged:** `topik_ii_53`/`topik_ii_54` → `'topik'`
bucket / "Q53"/"Q54" label; `free_write` → `'generated'` bucket / "Free
write" label — confirmed by reading the switch bodies directly (no logic
change, only the exhaustiveness mechanism changed).

**Test:** the pre-existing B-017 rubric-split test
(`Mistakes.test.tsx`, "fetches the real writing history and renders it split
into the TOPIK/Generated sub-sections") is unchanged and still asserts the
free-write attempt does not leak into the TOPIK sub-section — passes
unmodified against the new switch-based bucketing.

### 2. F-173 — honest no-total fallback → **FIXED**

`Today.tsx` now computes `hasRealTotal = openAttempt?.totalItems !==
undefined` and branches the resume banner/progress rendering on it:

- **`hasRealTotal === true`** (real server `totalItems`): unchanged "X of N
  answered" wording (`resumeAnsweredEn`/`resumeAnsweredKr`) feeds both the
  aria-label and a `SubwayProgress` bar + caption — byte-for-byte the old
  behavior.
- **`hasRealTotal === false`** (`totalItems` absent): plain "X answered"
  wording, **no "of N"**, and the JSX renders only a
  `<div className="km-today__resumeProgressCount">` caption with **no
  `SubwayProgress` element at all** — confirmed by reading the diff's JSX
  branch directly; there is no code path that renders a progressbar role
  when `hasRealTotal` is false.

**`hasRealTotal` correctness on `0`:** the check is `!== undefined`, not a
truthiness/falsy check, so a genuine `totalItems: 0` from the server would
correctly be treated as a real total (edge case, but handled correctly by
construction — no coercion bug).

**Tests verified against the two fixtures:**
- `ATTEMPT` (`totalItems: 20`, `answered: 12`, deliberately non-equal per the
  fixture's own comment) — asserts `aria-valuemax="20"`,
  `aria-valuetext="12 of 20 answered"`, and the visible "12 of 20 answered"
  caption. This test is unchanged by the fix-pass and would fail if `steps`
  regressed to `answered` or the wiring broke.
- `ATTEMPT_NO_TOTAL` (`totalItems` field absent, `answered: 7`) — rewritten
  test now asserts: aria-label reads exactly "Resume exam — Reading mock, 7
  answered" (not "7 of 7 answered"); `queryByRole('progressbar', { name:
  'Resumed exam progress' })` returns null (bar role fully absent, not just
  unstyled); visible caption reads "7 answered"; `queryByText(/7 of 7
  answered/)` returns null anywhere in the region. Both the button-name
  exact-match and the negative progressbar/text queries would fail against
  the pre-fix code (which rendered "7 of 7 answered" + a real progressbar).

Both fixtures read directly from `Today.test.tsx` lines ~190–213 confirm
`totalItems` is genuinely `20` (present, non-equal to `answered`) in
`ATTEMPT` and genuinely absent (no key at all) in `ATTEMPT_NO_TOTAL` — not a
typo'd `0` or falsy value that would make the `!== undefined` check
coincidentally pass.

SHOULD-FIX #2 from the original review (server-side `totalItems` /
`totalItemsExact` wire-contract gap) is correctly left out of scope — this
is a client-only diff and the fix report documents it as a follow-up in a
code comment, which is the right call.

### 3. Mistakes act() timing → **FIXED**

`Mistakes.test.tsx`'s "B-017: the writing-review section renders even while
mistakes are loading or errored" test is now `async` and, after the
synchronous heading assertion, does `await screen.findByRole('button', {
name: /TOPIK writing responses/ })`. This forces the mocked
`fetchWritingAttempts()` promise (set in `beforeEach`) to settle before the
test returns, closing the act()-warning risk the original review flagged.
No assertion was removed or weakened — the synchronous heading check (the
actual point of the test: the section renders during the mistakes-feed error
state) still runs first and unconditionally.

## New findings

None. No regression, no new BLOCKER/SHOULD-FIX introduced by this fix-pass.

## Regression / scope check

- `git diff 2c0c805 a79d190 --stat` touches exactly 4 source files
  (`Mistakes.tsx`, `Mistakes.test.tsx`, `Today.tsx`, `Today.test.tsx`) plus 3
  new/updated docs. No other files changed.
- `ShowMore.tsx`/`ShowMore.css`/`ShowMore.test.tsx` (F-121's fix, a PRAISE
  item in the original review) are untouched by this diff — confirmed empty
  diff on those paths between `2c0c805` and `a79d190`.
- `--km-mastery-*` CSS custom properties: `grep -rn "km-mastery-"` across
  `client/src` returns 27 hits, none in the changed files or their diffs —
  untouched.
- PRAISE items from both original reviews (real `GET /writing/attempts`
  fetch, `AbortController`/`ctrlRef`/`reloadTick` fetch hygiene, honest empty
  state, error+retry wiring, `SubwayProgress`/`Hanja.tsx` precedent,
  `current={answered}` semantics, deep-link `?mode=mock` behavior) — none of
  the underlying code for these was touched; only the rubric-bucketing logic
  and the no-total branch of the resume-progress JSX changed.

## Gate results (client/) — re-run independently

- `npm run lint` — **0 errors / 0 warnings**
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — **0 errors**
- `npx vitest run` — **117 test files passed, 1961 tests passed**
- `npx vite build --outDir /tmp/km-phaseArr` — **exit 0**; only the
  pre-existing `>500kB` chunk-size advisory on `index-*.js` (842.24 kB /
  gzip 243.35 kB), unrelated to this diff (present before it, a bundling
  concern not introduced here)

All four numbers match `FIX_REPORT_phaseA.md`'s claimed gate results exactly.

## Recommendation

**Ready to ship.** All 3 SHOULD-FIX items are genuinely closed (verified by
direct code reading, a live type-widening compile-break test for B-017, and
fixture-level confirmation for F-173), no regressions, no scope creep, gates
clean. No further fix-pass needed.
