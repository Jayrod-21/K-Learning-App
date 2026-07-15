# Fix Report — Phase A batch (B-017 / F-121 / F-173)

Branch `feat/beta-phaseA-partials` @ 2c0c805 (base `rebuild`). Independent
fix-pass against `REVIEW_phaseA-mistakes.md` and `REVIEW_phaseA-today.md`
(2 independent reviewers, 0 BLOCKER, 3 SHOULD-FIX). This pass addresses all 3
SHOULD-FIX items; no PRAISE items were touched or undone.

## Findings addressed

### 1. B-017 — rubric bucketing non-exhaustive → FIXED

**Files:** `client/src/pages/Mistakes.tsx`

The review flagged two related spots:
- `writingRubricLabel` (`Mistakes.tsx:360-366` pre-fix) — an if/if/else-fallback
  over `WritingRubric`.
- The TOPIK/Generated split (`Mistakes.tsx:487-488` pre-fix) — a two-way
  `.filter(a.rubric !== 'free_write')` / `.filter(a.rubric === 'free_write')`.

Both silently misfile (or fall through to a wrong default) if `WritingRubric`
ever grows a 4th member without every call site being updated in lockstep.

**Fix:** Converted both to exhaustive `switch` statements with a
`const exhausted: never = rubric` default branch, matching the codebase's own
existing idiom for this exact problem (`Diagnostic.tsx:925-943`'s
`sectionLabel`, `Ttmik.tsx:1753-1758`'s `TranscriptPanel` line-kind switch).
Added a new `writingRubricBucket(rubric): 'topik' | 'generated'` helper used
by both `topikAttempts`/`generatedAttempts` filters, so there is exactly one
place a 4th rubric value would need handling, and skipping it is a **compile
error** (TS4 exhaustiveness via `never`), not merely a `default:` code path.
The `never`-typed branch also throws at runtime (rather than silently
returning) in case an unrecognized value ever reaches it despite the type
guarantee (e.g. a server/client version skew bypassing the compiler) — belt
and suspenders, but the compile-time guarantee is the actual fix the review
asked for.

Existing behavior for the 3 real values is unchanged: `topik_ii_53`/
`topik_ii_54` → TOPIK bucket / "Q53"/"Q54" label; `free_write` → Generated
bucket / "Free write" label.

**Test:** No new test was strictly required (TS exhaustiveness is enforced at
compile time, not by a runtime assertion), but the existing B-017 rubric-split
test (`Mistakes.test.tsx:543-589`) continues to pass unchanged and still
proves the 3-value split renders correctly.

### 2. F-173 — misleading no-total fallback → FIXED

**Files:** `client/src/pages/Today.tsx`, `client/src/pages/Today.test.tsx`

Confirmed the reviewer's trace: when `openAttempt.totalItems` is `undefined`
(pre-F-173 fixture / cached data), `resumeTotalItems` fell back to `answered`,
so the UI rendered "N of N answered" plus a `SubwayProgress` bar clamped to
~100% fill — reading as "exam complete" directly beside a "Resume exam" CTA
that says the opposite.

**Fix:** Added `hasRealTotal = openAttempt?.totalItems !== undefined` —
true only when the server actually sent a `totalItems` field (as opposed to
the client-side `?? answered` fallback covering its absence). Built
`resumeAnsweredEn`/`resumeAnsweredKr` once, gated on `hasRealTotal`:
- `hasRealTotal === true` → unchanged "X of N answered" / "N문항 중 X개 답변함"
  wording, used for both the aria-label and the `SubwayProgress` bar +
  caption.
- `hasRealTotal === false` → the pre-existing (pre-F-173) "X answered" /
  "X개 답변함" wording, no "of N", **and no `SubwayProgress` bar at all** (a
  bar built from `totalItems ?? answered` always renders ~100% full, which is
  the exact "reads as complete" bug being fixed — there is no honest partial
  bar to draw when the true total is unknown).

This is a strict narrowing of an existing fallback path — the real-total case
(the common, correct path per both reviews) is byte-for-byte unchanged.

Left alone per the review's own scoping: SHOULD-FIX #2 (the wire contract
collapsing "true total" and "server gave up, echoed `answered`" into the same
`totalItems` value) is a server-side fix, explicitly out of scope for this
client-only diff — noted in the new code comment for whoever picks it up.

**Test:** Rewrote
`F-173: falls back to the real answered count... when a saved attempt
predates totalItems` (now titled
`F-173 fix-pass SHOULD-FIX #1: ...shows the honest "N answered" wording`,
`Today.test.tsx:1214-1237`) against the `ATTEMPT_NO_TOTAL` fixture (7
answered, no `totalItems`) to assert:
- the resume banner's accessible name is `Resume exam — Reading mock, 7
  answered` (not "7 of 7 answered"),
- no `progressbar` role named "Resumed exam progress" is rendered at all,
- the visible caption reads "7 answered", and "7 of 7 answered" is absent
  anywhere in the region.

The `ATTEMPT` fixture case (`totalItems: 20`, `answered: 12`,
`Today.test.tsx:1193-1212`) is unchanged and still asserts the full "12 of
20" bar + readout — confirms the real-total path is untouched.

### 3. Mistakes test act() timing → FIXED

**File:** `client/src/pages/Mistakes.test.tsx`

`B-017: the writing-review section renders even while mistakes are loading or
errored` (`Mistakes.test.tsx:633`) asserted synchronously while the default
`fetchWritingAttempts()` mock's resolved promise (set in `beforeEach`) could
still be in flight at test end.

**Fix:** Made the test `async` and added
`await screen.findByRole('button', { name: /TOPIK writing responses/ })`
after the synchronous heading assertion — this both proves the heading
renders immediately (unaffected by the mistakes-feed error state, the actual
point of the test) and lets the writing fetch's effect settle fully before
the test returns, closing the act()-warning risk. No behavior assertion was
removed or weakened.

## Self-assessment

- All 3 SHOULD-FIX items are genuinely fixed, not just silenced — each fix is
  paired with a test that would fail against the pre-fix code (verified by
  construction: the exhaustive switches are strictly more restrictive than
  the if/filter chains they replace; the Today.tsx honest-fallback test
  asserts the literal absence of the old "7 of 7"/progressbar output; the
  Mistakes.test.tsx fix actually awaits the previously-unawaited fetch).
- No PRAISE item was touched: the `AbortController`/`ctrlRef`/`reloadTick`
  fetch-hygiene block, the empty-state copy, the error+retry wiring, F-121's
  `ShowMore` fix, and the `SubwayProgress`/`Hanja.tsx` wiring precedent are
  all untouched.
- SHOULD-FIX #2 from `REVIEW_phaseA-today.md` (the `totalItems`/`totalItemsExact`
  wire-contract gap) was correctly identified by the reviewer as server-side
  and out of scope for this client-only diff — left as a documented follow-up,
  not addressed here.
- No review suggestion was rejected; both reviewers' proposed fixes matched
  what was implemented (exhaustive switch / assertNever for B-017; drop "of
  N" + bar for the no-total fallback for F-173; await the fetch for the
  act() timing item).

## Gate results (client/)

- `npm run lint` — **0 errors / 0 warnings**
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — **0 errors**
- `npx vitest run` — **117 files passed / 1961 tests passed**
- `npx vite build --outDir /tmp/km-phaseAfix` — **exit 0** (pre-existing
  >500kB chunk-size advisory only, unrelated to this diff, not a new issue)
