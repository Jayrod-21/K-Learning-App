# Review

Branch `feat/beta-phaseA-partials` @ 2c0c805 (base `rebuild`).
Scope: `client/src/pages/Mistakes.tsx`, `Mistakes.css`, `Mistakes.test.tsx`,
`client/src/components/ShowMore.tsx`, `ShowMore.css`, `ShowMore.test.tsx`.
Tickets: **B-017** (writing-review section, was a stub) and **F-121**
(ShowMore final-reveal focus visibility).

## Summary verdict: PASS WITH CONDITIONS

No blockers. B-017 is genuinely un-stubbed: a real `GET /writing/attempts`
fetch, a correct and currently-exhaustive rubric split, an honest empty state,
and a real error+retry path — none of it is a disguised "coming soon." F-121
moves the focus target from a clipped `.km-sr-only` node to a visible in-flow
`<p>` and both the new WCAG 2.4.7 (visible focus) and the pre-existing 2.4.3
(focus-not-lost) behaviors are covered by tests that actually assert on the
DOM, not tautologies. Two SHOULD-FIX items (below) are low-severity
robustness/hygiene gaps worth a follow-up, not a blocking rework.

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **Rubric bucketing is a two-way filter, not an exhaustive check** — `client/src/pages/Mistakes.tsx:622-623` (`topikAttempts = attempts.filter((a) => a.rubric !== 'free_write')` / `generatedAttempts = attempts.filter((a) => a.rubric === 'free_write')`) and `writingRubricLabel` (`Mistakes.tsx:495-501`, if/if/else-fallback) are correct today because `WritingRubric` (`client/src/types/domain.ts:1910`) and the DB `ck_writing_attempts_rubric` CHECK (migration 056) both close the enum to exactly `topik_ii_53 | topik_ii_54 | free_write`. But neither the filter nor the label function is written to fail loudly if a 4th value ever appears (server bug, future migration widening the type without updating this file) — it would silently land in the TOPIK bucket / render as "Free write" instead of surfacing as unrecognized. Given how much this exact codebase's own migration comments (056) worry about drift in this taxonomy ("a real DB-constrained split... never a client-invented category"), an exhaustive `switch` with a `default` that throws/asserts-never would cost little and close the gap.
- **Test doesn't await the in-flight writing fetch before asserting** — `client/src/pages/Mistakes.test.tsx:633-639` (`B-017: the writing-review section renders even while mistakes are loading or errored`) calls `renderPage()` and asserts synchronously while the default-mocked `fetchWritingAttempts()` promise is still unresolved at test end. Likely benign (RTL flushes microtasks between tests) but can produce an "update not wrapped in act(...)" warning if the surrounding test run doesn't settle it — worth an `await screen.findByRole(...)` or equivalent if CI logs show the warning.

### NIT
- `client/src/pages/Mistakes.css:220` uses only `-webkit-line-clamp`/`-webkit-box-orient` (no unprefixed `line-clamp` alongside). It's the long-standing de-facto cross-browser idiom (Firefox/Safari/Chrome all honor the webkit-prefixed trio), so it works everywhere in practice — just flagging it's the only line-clamp use in the codebase, so there's no established local convention to check it against.
- `WritingAttemptRow`'s meta line (`Mistakes.tsx:520-529`) is a small, one-off inline layout; fine as written, no action needed.

### PRAISE
- **B-017 passes the "irony guard" cleanly.** The old stub (`.km-mistakes__stub`, "coming soon" copy) is fully deleted from both `Mistakes.tsx` and `Mistakes.css`; the replacement fetches real data (`services/writing.ts:188` `fetchWritingAttempts`), and the empty state reads "No graded TOPIK writing yet — your next Q53/Q54 grade will appear here" / "No responses to a generated prompt yet." (`Mistakes.tsx:685-699`) — an honest empty, not a hidden stub. The test at `Mistakes.test.tsx:333-382` explicitly asserts `queryByText(/coming soon/i)` is absent in both the populated and empty cases.
- **Rubric split is correct and verified against the real constraint.** `topik_ii_53` and `topik_ii_54` both land in "TOPIK writing responses," `free_write` lands in "Generated prompts" — confirmed against `ck_writing_attempts_rubric` (`db/migrations/056_writing_rubric_widen.up.sql:44`) and the `WritingRubric` type (`domain.ts:1910`); the test explicitly checks the free-write fixture does NOT leak into the TOPIK sub-section (`Mistakes.test.tsx:369-372`).
- **Fetch hygiene is a verified match to the established pattern, not a smell.** The `AbortController` + `ctrlRef` + `reloadTick` + `/* eslint-disable react-hooks/set-state-in-effect */ setLoading(true); setError(null); /* eslint-enable */` block (`Mistakes.tsx:587-613`) is byte-for-byte the same shape as `ReviewDictionary.tsx:213-219` and `ReviewVocab.tsx`'s `VocabBrowse` fetch effect (`ReviewVocab.tsx:494-534`), including the `ApiError`/`'canceled'` guard and `errorMessageFor` fallback-copy contract (`client/src/lib/errorCopy.ts:30-48`, verified the plain-`Error('boom')` case falls through to the caller's own fixed copy, matching the test's literal string).
- **Real error+retry, not swallowed.** `Mistakes.test.tsx:404-424` mocks a rejected-then-resolved fetch, asserts the `ErrorCard` message renders, clicks Retry, and asserts the tiles actually appear after the retry succeeds — this exercises the real `refetch`/`reloadTick` wiring end to end, not just presence of an error string.
- **F-121 is a real, visible fix, and both WCAG criteria are tested.** The stand-in is now a normal in-flow `<p className="km-showmore__done focusring">` (`ShowMore.tsx:82-89`) styled with visible muted text + hairline border (`ShowMore.css:44-57`), not clipped-offscreen. `ShowMore.test.tsx:85-109` asserts the focused node lacks `km-sr-only`, carries `km-showmore__done`, and is a `<P>` tag — while the pre-existing 2.4.3 regression guard (`document.activeElement` is never `document.body`, `ShowMore.test.tsx:80`) is intact and unweakened.
- **No scope creep.** Both diffs stay tightly inside the two tickets; the CSS additions (`km-mistakes__writingRow*`) explicitly mirror `ReviewVocab.tsx`'s existing `.km-resources__entry-row` shape rather than inventing a new layout language, and shared classes (`.km-reference__row/list/empty`, `.km-pill--default`, `.km-mistakes__state`/`.km-mistakes__skeleton-line`) are reused verbatim from the existing stylesheet, not duplicated.

## Detailed findings (file:line)

- `client/src/pages/Mistakes.tsx:495-501` — `writingRubricLabel`, non-exhaustive if/if/else.
- `client/src/pages/Mistakes.tsx:622-623` — non-exhaustive two-way rubric filter.
- `client/src/pages/Mistakes.tsx:577-624` — `WritingReviewSection` fetch effect; matches `ReviewDictionary.tsx:213-219` / `ReviewVocab.tsx:494-534` pattern.
- `client/src/pages/Mistakes.tsx:661-704` — loading/error/data render branches; reuses `.km-mistakes__state`/`.km-mistakes__skeleton-line` already used at `Mistakes.tsx:603-608`.
- `client/src/pages/Mistakes.css:182-233` — stub CSS removed, real row/list styling added; only unprefixed-missing `line-clamp` nit.
- `client/src/pages/Mistakes.test.tsx:309-323` — safe default mock in `beforeEach` so unrelated mistakes-only tests don't trip an unmocked call.
- `client/src/pages/Mistakes.test.tsx:333-425` — the three B-017 tests (populated/split, empty, error+retry) — real behavior, not tautological.
- `client/src/pages/Mistakes.test.tsx:633-639` — synchronous assertion while writing-fetch promise may still be pending; SHOULD-FIX (test hygiene only).
- `client/src/components/ShowMore.tsx:62-105` — `<p>` stand-in replacing `<span>`; `focusring` class added.
- `client/src/components/ShowMore.css:38-57` — visible styling for `.km-showmore__done`.
- `client/src/components/ShowMore.test.tsx:57-109` — updated + new tests asserting visibility, not just presence.
- `db/migrations/038_writing_attempts.up.sql:144-145`, `db/migrations/056_writing_rubric_widen.up.sql:40-44` — the authoritative 3-value rubric CHECK constraint the client-side split was verified against.
- `client/src/types/domain.ts:1897,1910` — `WritingRubric` type mirrors the DB CHECK exactly.
