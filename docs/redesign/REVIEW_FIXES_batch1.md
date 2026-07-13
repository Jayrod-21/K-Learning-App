# Review: fix-pass for Today+Progress batch

**Reviewer:** independent re-review (30yr, fresh eyes) — did not write the batch code,
the three original reviews, or the fix-pass. Verified every claim in
`FIX_REPORT_batch1.md` against the actual code on `feat/redesign-today-progress`
@ `20c9f37` (fix-pass, on top of `083388d` batch, off `rebuild`).

## Summary verdict: **PASS**

Every BLOCKER and SHOULD-FIX from the three original reviews is genuinely fixed,
not just claimed-fixed. The one finding I probed hardest — B1 (F-138's UTC-vs-local
test gap) — holds up: the new test suite would actually fail if the bug it guards
against reappeared, verified by tracing exactly which assertion breaks under a
simulated regression. All four gates were re-run independently (not copy-pasted
from the report) and match the report's numbers exactly. No regressions found in
the 6 pre-existing `CollapsibleTile` consumers or in any praised behavior. Working
tree is clean of any scratch edits from this review.

---

## Finding-by-finding verification

| ID | Orig severity | Fix status | Does the test catch the bug? | Notes |
|---|---|---|---|---|
| B1 (F-138 local-day) | BLOCKER | **FIXED** | **Yes.** | `client/src/lib/localDay.ts:39-67` extracts `isLocalToday`/`localDayParts` with an injectable `dayParts` param (default `localDayParts`, real local getters — production behavior byte-identical). `client/src/lib/localDay.test.ts` has 2 tests that jointly close the gap the review demanded: (1) L37-57 spies on `Date.prototype.getFullYear/getMonth/getDate` vs. their UTC twins and asserts the DEFAULT call path invokes only the local trio — this fails deterministically in CI (UTC) if the default param were ever swapped for a UTC-getter function, since it checks *which method was called*, not *what it returned*. (2) L68-100 injects two simulated extractors (a fixed +9h/KST one vs. a UTC one) against a genuine UTC-day-vs-KST-day crossing (`2026-01-01T16:00:00.000Z` vs ref `2026-01-02T10:00:00.000Z`) and asserts the comparison logic itself produces the right true/false split — this is host-TZ-independent (pure epoch-ms math, never reads the real clock). Together: test 1 proves "the default wiring calls local getters, not UTC," test 3 proves "the boundary-comparison logic honors whichever extractor it's given." A regression to hardcoded UTC in EITHER the default param or the comparison would be caught by one of the two. `Today.tsx:105` imports `isLocalToday` from the new module; no inline duplicate remains (confirmed by grep — only the 3 real call sites at `Today.tsx:376/380/384`). |
| C-1 (shared variant) | SHOULD-FIX (headline) | **FIXED** | **Yes** (3 new `CollapsibleTile.test.tsx` tests) | `CollapsibleTile.tsx:75-88` adds `surface?: 'card'\|'city'` (default `'card'`). Grepped all 6 pre-existing consumers (`Review.tsx:817`, `Settings.tsx:1298`, `Hanja.tsx:1779,2309`, `Topik.tsx:396,443`, `Grammar.tsx:1008`, `Mistakes.tsx:154,260,271`) — **none pass `surface`**, confirmed backward-compatible by construction, and independently by re-running their 6 test files in isolation: **231/231 pass** (matches report). `Progress.tsx:589,618,629` now render all 3 sections with `surface="city"` + `rail` + per-section `tone` (`accent`/`plain`/`blue`). `Today.tsx:456` Writing tile uses `surface="city" tone="accent" rail`; the old page-scoped Night-glow duplicate is gone — grepped `Today.css` for the `[data-theme="dark"] .km-today__writingTile...` block cited in the original review and it no longer exists (only tightened-padding rules remain at `Today.css:207-212`), and the orphaned `.km-today__writingWrap` wrapper rule is also gone. `CollapsibleTile.css:20-22` adds the `.km-citycard.km-collapsible{padding:0}` two-class override to beat `CityCard.css`'s single-class padding rule regardless of load order — a real fix, not a coincidence of source order. `CollapsibleTile.test.tsx:104-142` has 3 real new tests: default-stays-`Card`-not-`CityCard`, `surface="city"` renders `CityCard` root with `tone`/`rail`/`feat` forwarded (asserts actual DOM classes, not just prop pass-through), and `rail` omitted renders no `DancheongRail`. |
| C-2/C-3 (header) | SHOULD-FIX | **FIXED** | N/A (structural, visually verified via code) | `Today.tsx:596-609` now renders a single `<SkylineHeader title={...}>` with a real `<h1 id="today-title">` inside the `title` slot — identical recipe to `Progress.tsx:559-572`'s `<h1 id="progress-title">`. Confirmed the `<h1>` is a real heading node, not decorative (`aria-hidden` is only on the icon span, not the `h1`). The separate `Topbar` is gone from `Today.tsx` (grepped `^import` lines — no `Topbar` import remains; only a doc-comment mentions it historically). Both pages now render the same `<div className="km-{today,progress}__rail-divider"><DancheongRail tone="accent" /></div>` immediately below the skyline (`Today.tsx:611-614`, pre-existing `Progress.tsx`) — C-3 folded in as claimed. |
| S1 (Writing done-today) | SHOULD-FIX | **FIXED** | **Yes** (`Today.test.tsx`, per report; visually confirmed in source) | `Today.tsx:474-481`: `<DoneTodayRow count={writingDoneToday} .../>` now lives inside the `title` prop (the always-visible header face `CollapsibleTile` renders regardless of collapsed state), matching Grammar/TOPIK's placement — no longer nested in `children` (the collapsed body). |
| S2 (limit 20→100) | SHOULD-FIX | **FIXED** | N/A (server-validated ceiling, not a client unit test) | `Today.tsx:341,346,351` all raised to `limit: 100`. Verified against the actual Zod schemas (not just the fix report's word): `server/src/routes/grammarDrill.ts:536` — `AttemptsQuerySchema.limit: z.coerce.number().int().min(1).max(100).default(20)`, feeding `listAttempts`/`listGrammarAttempts`. `server/src/routes/writing.ts:292` — same shape, feeding `fetchWritingAttempts`. `server/src/routes/topik.ts:1060` — same shape at the `GET /topik/attempts` route (traced the client's `fetchAttemptHistory` → `api.get('/topik/attempts')` → this exact schema, not one of `topik.ts`'s other 4 `limit` schemas at different ceilings). All three ceilings are genuinely `max(100)` — `limit: 100` will not 400. |
| SF1 (trend-line numeric test) | SHOULD-FIX | **FIXED** | **Yes — verified by hand, not just trusted** | `Progress.test.tsx:1450-1477`. Independently recomputed: `HISTORY_3` Overall series 42/53/67 at x=0,1,2 → x̄=1, ȳ=54, Σ(dx·dy)=25, Σ(dx²)=2 → slope=12.5, intercept=41.5. Chart geometry: `PAD.left=36`, `INNER_W` step gives `x(0)=36`, `x(2)=564` (asserted as exact strings — correct, integer geometry). Score→pixel: `yFor(score) = PAD.top + ((100-score)/100)*INNER_H` with `PAD.top=14, INNER_H=216` → `yFor(41.5)=140.36`, `yFor(66.5)=86.36`, matching the test's `toBeCloseTo` assertions exactly. This is a genuine numeric test: a flipped-sign or wrong-denominator regression in `regressionTrend` would produce different y1/y2 and fail this test, unlike the pre-existing count-only assertions. |
| SF2 (trend vs. reference line color) | SHOULD-FIX | **FIXED** | N/A (CSS, no test expected/needed) | `Progress.css:164-165` — `.km-progress__trendfit { stroke: var(--paper-mute); }`, unconditional (no theme override needed since `--paper-mute` isn't itself theme-conditional the same way the old faint/mute split was). `.km-progress__refline` (`Progress.css:112-113`) stays `--paper-faint`, unchanged. The two are now visually distinct tokens in both themes, not just dark. |
| SF3 (paper-faint caption contrast) | SHOULD-FIX | **FIXED** | **Yes — real computed-contrast guard, not a hardcoded pass** | `Progress.css:182-185` — `.km-progress__trendnote` moved from `--paper-faint` to `--paper-dim`. `tokensContrast.test.ts:138-166` adds a `describe('secondary text contrast (--paper-dim, WCAG AA)')` block that parses the ACTUAL token values out of `index.css` (light + dark blocks) and computes real WCAG luminance/contrast math (not asserting a pre-known number) against 4 surfaces × 2 themes = 8 tests, mirroring the pre-existing `--paper-mute` guard block exactly (`tokensContrast.test.ts:109-136`). This is a genuine regression guard: if a future re-tint dropped `--paper-dim` below 4.5:1 on any surface, this test would fail — confirmed structurally identical in mechanism to the existing, previously-reviewed `--paper-mute` guard. |
| S4 (dangling PR-report comment) | SHOULD-FIX | **FIXED (comments only, as instructed)** | N/A | `Today.tsx:3,17,64` all now name `BUGS_AND_FEATURES.md` directly with the verbatim follow-up ticket titles. Grepped for "the PR report" — zero hits remaining. |

---

## Praise-intact check

All confirmed still present, unchanged in substance:

- **Honest null-not-zero states** — `DoneTodayRow` still `return null` while loading (`Today.tsx:289` `if (count === null) return null;`), only its position in the JSX tree moved (S1), not its gating logic.
- **Reduced-motion gating** — `@media (prefers-reduced-motion: reduce)` still present in `CollapsibleTile.css:81` and `Today.css:92`; `SkylineHeader.css:58` still gates its parallax on `no-preference`.
- **Accent-orthogonal `--km-tone` plumbing** — `CollapsibleTile`'s new `surface="city"` path forwards `tone` straight to `CityCard`, which is the same accent-aware chain the original reviews already verified (`--vermilion` re-pointed per `data-accent`); no new hardcoded hex introduced anywhere in the diff (spot-checked `Today.css`, `Progress.css`, `CollapsibleTile.css` — only token references).
- **OLS `n<3`/`den===0` guards** — untouched at `Progress.tsx:473` (`if (n < 3) return null;`) and `Progress.tsx:483` (`if (den === 0) return null;`). SF1 only added a test proving the existing formula correct; the formula itself is unmodified.

## New findings introduced by the fix-pass

**None found — no BLOCKER, SHOULD-FIX, or NIT.** Specifically checked for regression risk in the two riskiest surfaces the fix-pass touched:
- The `CollapsibleTile` prop-surface change is additive and defaulted; all 6 pre-existing consumers pass their own isolated test run (231/231) with zero modification needed to those consumer files.
- The header refactor (`Today.tsx`) removes the `Topbar` import cleanly — no dangling unused import, no orphaned CSS class (`km-today__hero`, `km-today__writingWrap` both absent from `Today.css` — grepped, zero hits).

---

## Gate results (independently re-run, not copied from the fix-pass report)

Run from `client/` on `20c9f37`:

- `npm run lint` → **0 problems** (clean).
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0 errors** (clean, no output).
- `npx vitest run` → **115 test files passed (115), 1628 tests passed (1628)** — matches the fix-pass report exactly.
- `npx vite build --outDir /tmp/km-rr-batch1` → **exit 0** (confirmed via `$?` on an unpiped rerun to `/tmp/km-rr-batch1-2`, not just tail'd output). 798.92 kB main bundle, 560ms build, only the pre-existing >500kB chunk-size advisory, no errors.
- Bonus check not in the original gate list: isolated re-run of the 6 pre-existing `CollapsibleTile` consumer test files (`Review/Settings/Hanja/Topik/Grammar/Mistakes.test.tsx`) → **6 files passed (6), 231 tests passed (231)** — matches the fix-pass report's backward-compatibility claim exactly.

## Recommendation

**Ready to PR into `rebuild`.** All 8 findings across the 3 original reviews (B1, C-1, C-2, C-3, S1, S2, SF1, SF2, SF3 — 9 IDs, one being a headline+2 sub-items) are genuinely FIXED with tests that would actually catch the regressions they guard against, not just presence-only assertions. No praise item was undone. No new findings introduced. All 4 gates are green and independently reproduced. No follow-up fix-pass needed for this batch; the fix-pass's own S4 follow-up-ticket list (Hanja/Reading/Listening daily-attempt signals, resumed-TOPIK item count, shared `LineChart` trend prop) is correctly deferred as out-of-scope future work, not a gap in this batch.

Working tree left clean — no scratch edits made during this review (only reads, greps, and gate re-runs).
