# Fix-pass report — Today + Progress (Wave-2 redesign, batch 1)

Branch `feat/redesign-today-progress` @ `083388d`. Scope: every BLOCKER +
SHOULD-FIX from `REVIEW_batch1-today.md` (1 BLOCKER, 4 SHOULD-FIX),
`REVIEW_batch1-progress.md` (2 SHOULD-FIX), and `REVIEW_batch1-fidelity.md`
(3 SHOULD-FIX, including the headline shared-component finding). NITs out of
scope except where they auto-resolved as a side effect of the required
fixes (noted below). No page rewrites beyond what the reviews called for;
all PRAISE items (honest null-not-zero states, reduced-motion gating,
accent-orthogonal tone plumbing, the OLS guards) left untouched.

## Findings

| ID | Finding | Disposition | Files touched |
|---|---|---|---|
| **B1** | F-138's test suite can't prove `isLocalToday` uses LOCAL (not UTC) day-boundary math — CI runs UTC, where the two are byte-for-byte identical, so no test exercising only the ambient clock could ever catch a regression | **FIXED** | `isLocalToday`'s behavior is unchanged (still real local `Date` getters). Extracted to `client/src/lib/localDay.ts` (new; also resolves an `react-refresh/only-export-components` lint error from exporting a plain function alongside the page component) with an injectable third parameter (`dayParts`, default = `localDayParts`, the real local getters) so a test can swap in a deterministic, host-TZ-independent day-extraction strategy without `vi.useFakeTimers`. New `client/src/lib/localDay.test.ts` (4 tests): (1) a `Date.prototype` spy proves the DEFAULT call path invokes `getFullYear`/`getMonth`/`getDate` and never their UTC twins; (2) a direct structural check on `localDayParts`; (3) a simulated +9h/KST extractor proves the day-boundary COMPARISON picks the local interpretation over UTC's at a genuine UTC-day-vs-local-day crossing (`2026-01-01T16:00:00.000Z` vs. ref `2026-01-02T10:00:00.000Z` — same KST day, different UTC day); (4) malformed-timestamp guard. `Today.tsx` now imports `isLocalToday` from `lib/localDay` instead of defining it inline; all 3 real call sites (grammar/writing/TOPIK) unchanged |
| **C-1** (headline) | Progress's 3 `CollapsibleTile` sections render plain `Card` (no Night glow / Day dancheong) while Today's Writing tile hand-rolled the same CityCard glow inline — two workarounds for one shared-component gap, and a fidelity miss on Progress vs. the mockup's "wall-to-wall neon" signboards | **FIXED** | Added `surface?: 'card' \| 'city'` (default `'card'`, fully backward-compatible) plus `tone`/`rail`/`feat` passthrough to `client/src/components/CollapsibleTile.tsx`. `surface="city"` swaps the internal `<Card>` for `<CityCard>`; `surface="card"` (the default, used by every pre-existing consumer) renders byte-identically to before. `CollapsibleTile.css`: added a `.km-citycard.km-collapsible { padding: 0 }` override (two-class selector beats `CityCard.css`'s single-class 20px-padding rule regardless of stylesheet load order). `CollapsibleTile.test.tsx`: +3 tests — default stays plain `Card` (no `km-citycard` class), `surface="city"` renders a `CityCard` root carrying `tone`/`rail`/`feat` with identical aria wiring, and `rail` omitted renders no `DancheongRail`. Verified via grep that every pre-existing consumer (`Review.tsx`, `Settings.tsx`, `Hanja.tsx`, `Topik.tsx`, `Grammar.tsx`, `Mistakes.tsx`) never passes `surface` — confirmed unaffected by re-running their test files (231/231 pass, see below) |
| C-1 (Progress) | — | **FIXED** | `Progress.tsx`: all 3 `CollapsibleTile` sections now render `surface="city"` + `rail`, with per-section `tone` matching the mockup's own palette — TOPIK compare = `accent` (tracks the global accent pick, the featured/open-by-default section), Progress by skill = `plain` (quiet neutral edge for read-only trend data), Mastery = `blue` (fixed hue, matching the prototype's mastery signboard). Page-top doc comment updated (no longer claims "CityCard is NOT used here"). `Progress.css` — no redundant rule existed to remove (Progress never duplicated CityCard's glow formula; only Today had a copy) |
| C-1 (Today) | — | **FIXED** | `Today.tsx`: Writing's `CollapsibleTile` now renders `surface="city" tone="accent" rail`; the standalone sibling `<DancheongRail tone="accent" />` and its `.km-today__writingWrap` positioning wrapper are removed (CityCard supplies its own leading-edge rail + `position: relative` now). `Today.css`: deleted the `[data-theme="dark"] .km-today__writingTile.km-collapsible {...}` Night-glow CSS copy (the block the review cited) and the now-unused `.km-today__writingWrap` rule — the shared `surface="city"` variant owns that treatment now. Header/content padding tightening (F-133) kept, since it's independent of surface |
| **C-2** | Today renders a bare `SkylineHeader` + a separate `Topbar` below it; Progress overlays its heading in `SkylineHeader`'s own `title` slot — two different header treatments for the app's two hub pages | **FIXED** | `Today.tsx`: replaced the bare `<SkylineHeader />` + `<Topbar krTitle="오늘" title="Today" .../>` pair with a single `<SkylineHeader title={<><Eyebrow>...</Eyebrow><h1 id="today-title" className="kr-display km-today__title">...</h1></>} />`, matching Progress's exact recipe. The `<h1>` stays a REAL heading node (not decorative) with the same `id="today-title"` the section's `aria-labelledby` already pointed at — no accessibility regression. `Topbar` import removed (no longer used on this page); `Today.css` — replaced `.km-today__hero` with `.km-today__skyline`/`.km-today__title` mirroring `.km-progress__skyline`/`.km-progress__title` |
| **C-3** | Progress renders a `DancheongRail` divider under its header; Today has none — folded into the C-2 fix | **FIXED** | `Today.tsx`/`Today.css`: added the same `<div className="km-today__rail-divider"><DancheongRail tone="accent" /></div>` Progress already renders, right after the new `SkylineHeader`. Both hub pages now share one consistent header stack |
| **S1** | Writing's "done today" count is invisible unless the tile is expanded (nested in the collapsed body), unlike Grammar/TOPIK, which show it on the always-visible tile face | **FIXED** | `Today.tsx`: moved `<DoneTodayRow count={writingDoneToday} .../>` from `children` (the collapsed body) into `title` (the always-visible header row `CollapsibleTile` renders regardless of collapsed state) — reads at a glance now, matching Grammar/TOPIK, without expanding the tile. New test in `Today.test.tsx`: navigates to the Writing carousel page WITHOUT expanding it and asserts `aria-expanded="false"` while `'1 essay graded today'`/`'Done today'` are already visible |
| **S2** | The 3 F-138 attempt-history fetches request `limit: 20`; a user with more than 20 grammar drills/essays/TOPIK attempts in one day would silently under-count | **FIXED** | `Today.tsx`: raised all 3 `realFn` calls (`listGrammarAttempts`, `fetchWritingAttempts`, `fetchAttemptHistory`) from `limit: 20` to `limit: 100` — confirmed via `server/src/routes/{grammarDrill,writing,topik}.ts` that `100` is each route's own Zod-validated ceiling (`z.coerce.number().max(100)`), so this is the real safe upper bound, not an arbitrary guess; a code comment documents that ceiling and why 100 is comfortably above any realistic single-day count. Mock-fallback fixtures' echoed `limit` field updated to `100` to match (cosmetic — mocks always return empty `attempts`, never a fabricated count) |
| S4 | `Today.tsx` code comments pointed at "the PR report" for two follow-up tickets that don't exist anywhere durable | **FIXED (comments only — no BUGS_AND_FEATURES.md edit, per instructions)** | `Today.tsx`: both comments now name `BUGS_AND_FEATURES.md` directly and state the follow-up ticket titles verbatim (see the ticket list below for the orchestrator to file) instead of "the PR report" |
| **SF1** | No test asserted the F-142 trend line's actual rendered coordinates — only element count/presence, so a broken slope/intercept formula could slip through undetected | **FIXED** | `Progress.test.tsx`: new test hand-verifies the `HISTORY_3` fixture's OLS regression (Overall scores 42/53/67 → slope 12.5, intercept 41.5 → y=41.5 at x=0, y=66.5 at x=2) and asserts the rendered `<line class="km-progress__trendfit">`'s `x1`/`x2` (exact string match — integer chart-geometry coordinates) and `y1`/`y2` (numeric `toBeCloseTo`, since the score→pixel mapping isn't float-exact: `140.35999999999999` in practice) |
| **SF2** | The F-142 trend line and the pre-existing TOPIK reference line both resolved to `--paper-faint` in LIGHT theme — only the dark-theme override told them apart, distinguishable only by dash spacing | **FIXED** | `Progress.css`: `.km-progress__trendfit`'s base rule now uses `--paper-mute` (a step darker/more legible than `--paper-faint` in both themes) instead of `--paper-faint`; the now-redundant `[data-theme='dark'] .km-progress__trendfit { stroke: var(--paper-mute) }` override was removed (dark's value is unchanged, just no longer theme-conditional). `.km-progress__refline` (the TOPIK threshold) is untouched at `--paper-faint`, so the two lines are now visually distinct in BOTH themes, not just Night |
| **SF3** | Verify the smallest new muted-caption text (`--paper-faint` at ~12px) meets WCAG AA in both themes | **FAILED verification → deepened, per the existing `--paper-mute`-guard pattern** | Measured `--paper-faint` on this page's card surfaces: **~2.0:1 (light) / ~3.2:1 (dark)** — well under the 4.5:1 AA floor for real text (`.km-progress__trendnote`, F-142's new caption, was the one offender; every other `--paper-faint` use on the page is a genuinely decorative graphical element — axis ticks, threshold lines — which only needs the 3:1 non-text bar). Fix: `Progress.css` — `.km-progress__trendnote` now uses `--paper-dim`, the token every OTHER caption on this page already uses (`.km-progress__note`, `.km-progress__readout`, `.km-progress__legend`, `.km-progress__state`), which measures 7.7–13.3:1 across all 4 card surfaces in both themes. `tokensContrast.test.ts`: new `describe('secondary text contrast (--paper-dim, WCAG AA)')` block (8 new tests: 2 themes × 4 surfaces `ink`/`ink-1`/`ink-2`/`ink-3`), mirroring the existing `--paper-mute` guard, so a future re-tint of `--paper-dim` can't silently regress this pairing the way `--paper-faint` did here |

## Follow-up tickets for the orchestrator to file (S4)

Do NOT edit `BUGS_AND_FEATURES.md` per instructions — code comments in
`Today.tsx` now point at it by name with these exact titles:

1. **(F) Hanja daily-attempt signal** — `services/hanja` only exposes
   lifetime aggregate bands, no per-attempt history endpoint, so the Hanja
   tile can't show a real "done today" count the way Grammar/Writing/TOPIK
   do.
2. **(F) Reading/Listening daily-attempt signal** — `services/reading` /
   `services/ttmik` expose no per-attempt log at all, same gap as Hanja.
3. **(F) Resumed-TOPIK item-count for SubwayProgress** — Today deliberately
   omits `SubwayProgress` (device #5) because an in-progress mock exam's
   item-count total isn't available client-side today without fabricating a
   denominator or a disproportionate extra fetch.
4. **(F) Shared `LineChart` trend-line prop for the Progress skill
   carousel** — F-142's dashed OLS trend line only applies to the
   diagnostic `TrendChart` (a page-local SVG); the separate, shared
   `LineChart` component behind the "Progress by skill" carousel got neither
   a trend line nor the new latest-point emphasis, per
   `REVIEW_batch1-progress.md`'s F-142 checklist note (ambiguous "all
   graphs" ticket wording, out of scope for a shared read-only component in
   this batch).

## Praise items — confirmed untouched

- `isLocalToday`'s local-getter implementation, malformed-timestamp guard,
  and null-while-loading semantics — byte-identical behavior, only an
  injectable (default-unused) third parameter added.
- `DoneTodayRow`'s "never show a fabricated zero" discipline — untouched;
  S1 only moved WHERE it renders, not its gating logic.
- `regressionTrend`'s OLS math, `n<3`/`den===0` guards, and endpoint
  clamping — untouched (SF1 only added a test proving the existing formula
  correct).
- `isNewBest`, the independent per-fetch failure isolation
  (`useEndpointOrMock`), reduced-motion gating on `SkylineHeader`/tile
  hover, and the accent-orthogonal `--km-tone` plumbing — all untouched.
- No hardcoded hex introduced anywhere in this fix pass — every new/changed
  color reference is an existing design token (`--paper-mute`, `--paper-dim`,
  `--km-tone` via `CityCard`/`DancheongRail`).

## Gate results

Run from `client/`:

- `npm run lint` → **0 problems** (clean `eslint .` output).
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0 errors**.
- `npx vitest run` → **115 test files passed (115), 1628 tests passed
  (1628)** — up from the pre-fix 1611 (17 new tests: 3 in
  `CollapsibleTile.test.tsx`, 1 in `Today.test.tsx` (S1), 4 in the new
  `lib/localDay.test.ts` (B1), 1 in `Progress.test.tsx` (SF1), 8 in
  `tokensContrast.test.ts` (SF3)). Re-ran the 6 pre-existing
  `CollapsibleTile` consumer test files in isolation
  (`Review/Settings/Hanja/Topik/Grammar/Mistakes.test.tsx`) — **6 files
  passed (6), 231 tests passed (231)** — confirming the shared-component
  change is fully backward-compatible.
- `npx vite build --outDir /tmp/km-fix-batch1` → **exit 0** (verified via
  `$?` on an unpiped run, not just tail'd output — 798.92 kB main bundle,
  562ms build, only the pre-existing >500kB chunk-size advisory, no errors).

## Self-assessment against the gate

All four gate commands pass with the numbers above. No regressions in any
of the 6 pre-existing `CollapsibleTile` consumers, confirmed both by the
full-suite run and an isolated re-run of just those 6 files.
