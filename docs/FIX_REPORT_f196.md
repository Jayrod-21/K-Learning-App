# Fix-pass report — F-196 PastExams crash guard (NIT round)

Input: `docs/REVIEW_f196.md` (PASS — 0 BLOCKER, 0 SHOULD-FIX, 4 NIT, 5 PRAISE), base commit `bfe9092`, branch `fix/f196-pastexams-crash`. Fix-pass agent did not author or review the original change.

## NIT-by-NIT disposition

### NIT-1 — Render-phase `console.warn` + StrictMode double-warn → **FIXED**

`PastExams.tsx`: added module-level `warnedAnomalies: Set<string>` + `warnOnce(message)`; both anomaly paths in `mockSectionFromKr` (`'쓰기'` case and the `never` default) now call `warnOnce` instead of `console.warn`. Dedup is per distinct message, so StrictMode's dev double-render, refetch re-renders, and N identical anomalous rows log once, while a *different* unknown section value still gets its own line. Chose warn-once over moving the log to an effect deliberately: React 18+ StrictMode double-invokes mount effects too, so an effect alone would not fix the double-log, and it would force `mockSectionFromKr` to surface a "reason" channel to the component just for logging — more machinery, same noise.

Guard behavior unchanged: `'쓰기'`/unknown still returns `null`, `reEnterHref` still returns `null`, the row still degrades to the read-only branch. The compile-time `const exhausted: never` guard and the byte-identical working-section `Link` branch are untouched.

Test coverage for the new behavior (`PastExams.test.tsx`):
- New test: renders TWO `'쓰기'` rows in one list, asserts both degrade gracefully and `warn.mock.calls.length <= 1`. The `<= 1` (rather than `=== 1`) makes it order-independent — the module-level set may already contain the message from the earlier read-only test in a full-file run (0 calls) but not in isolation (1 call); a reverted mutant (plain `console.warn`) emits 2 and fails either way. Verified by mutation: reverted `warnOnce` → `console.warn` via sed, suite went 11 passed / 1 failed (the new test), then restored.
- The existing read-only `'쓰기'` test keeps its `toHaveBeenCalledWith(stringContaining('쓰기'))` assertion (it is the first test in the file to render `'쓰기'`, so it observes the one allowed call); a comment now documents that declaration-order dependence.
- No StrictMode-wrapper test was forced — the dedup mechanism (the actual code change) is what the two-row test exercises; simulating StrictMode's dev-only double render in vitest would pin React internals, not our behavior.

### NIT-2 — Warn prefix is a third style (`PastExams:` vs `km.settings:` vs `[api]`) → **SKIPPED**

Reviewer's own finding states no single project convention exists ("not a violation"). With two incumbent styles there is nothing canonical to converge on; picking either would be churn justified only by taste, and inventing a project-wide convention is out of scope for this fix. Message content already matches project character per the review.

### NIT-3 — Listening full-href pin partial (pre-existing) → **FIXED**

Reviewer's condition ("only worth touching if these tests are edited anyway") is met — this pass edits the test file. `PastExams.test.tsx` listening test now pins the full navigation result `'/learn/topik?mode=mock&section=listening&exam=91&level=TOPIK+II'` instead of the `section=listening` substring, matching the reading test's exactness. Strict superset of the old assertion; no behavior change.

### NIT-4 — Sibling test doesn't re-assert the writing row's visibility → **FIXED**

Added `expect(screen.getByText(/TOPIK II · 쓰기 91회/)).toBeInTheDocument()` to the sibling-isolation test, making the "siblings unaffected AND anomalous row still shown" claim self-contained (a regression that *dropped* the anomalous row entirely would previously have passed this test).

## Gates (this worktree, after fixes)

```
cd client && npm run lint                                   → 0 errors, 0 warnings
npx tsc -p tsconfig.app.json --noEmit --incremental false   → 0 errors
npx vitest run src/pages/PastExams.test.tsx                 → 1 file, 12/12 passed (was 11; +1 dedup test)
npx vite build --outDir /tmp/km-f196fix-dist                → success
```

Mutation re-check: `warnOnce` → `console.warn` revert kills the new dedup test (12 → 11 passed / 1 failed); the original triple-kill of the reverted-throw mutant is untouched (that test's render/visibility/warn assertions are unchanged).

## Self-assessment

- All 5 PRAISE items preserved verbatim: non-null `<Link>` branch, `rowBody` extraction, `never` exhaustiveness guard, null-return (never guess) anomaly semantics, read-only-row a11y, and doc-comment narrative are byte-identical apart from `console.warn` → `warnOnce` inside the two anomaly cases.
- Risk of the change: module-level `Set` persists for the page module's lifetime — intended (warn once per session per distinct anomaly), unbounded growth impossible in practice (keys are one fixed string + one per distinct unknown wire value).
- Known residual: the read-only `'쓰기'` test's warn assertion depends on being the first `'쓰기'`-rendering test in the file (documented in-code); acceptable vs. exporting a test-only reset hook from production code.

Files changed: `client/src/pages/PastExams.tsx`, `client/src/pages/PastExams.test.tsx`, this report.
