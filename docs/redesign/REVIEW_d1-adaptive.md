# Review — Device-adaptive epic, Phase D1 (Today + Progress use desktop width)

Reviewed at `worktree-agent-a07b9fdec3939bd71` @ 75e7687, diffed against `rebuild`.
Scope: `pages/Today.tsx/.css/.test.tsx`, `pages/Progress.tsx/.css/.test.tsx`.

Verified independently before writing findings:
- `npx vitest run src/pages/Today.test.tsx src/pages/Progress.test.tsx` → **126/126 pass**.
- `npx tsc -b --noEmit` → clean.
- Traced the actual desktop shell geometry (`--sidebar-w: 248px`, `--shell-desktop-max-width: 1160px`, `styles/index.css:249-250`; no horizontal padding anywhere in the `.km-today`/`.km-today__section`/`.km-today__grid` chain, and 44px total horizontal padding in the `.km-progress__trendGrid` chain via `CollapsibleTile.css:78`'s `.km-collapsible__content { padding: 0 22px 18px; }`) to do exact CSS Grid track-fitting arithmetic at 768/850/936/1024/1280px, since jsdom cannot render real layout.

## Summary verdict

**1 BLOCKER, 3 SHOULD-FIX, 2 NIT, 4 PRAISE.** Mobile is provably byte-identical (verified by reading the unmodified peek-slider JSX/CSS and by tests that pin it at both the implicit default and an explicit 375px width), and every deep-link / skeleton / error-state branch survives into the grid because `TileRail` and the grid/carousel conditional pass through the *exact same* tile nodes — no logic was cloned or forked. The blocker is a real, construction-provable visual defect: at the **768–935px tablet-portrait range** (a large, common device bucket — e.g. iPad-class portraits sit at 768–834px), Today's "Review & drills" carousel (which *always* has exactly 3 tiles) and "Suggested learning" (whenever all 3 tasks resolve, the typical case) render as **2 filled tiles + 1 half-width orphan tile with visible dead space beside it**, directly contradicting the code's own comment, which explicitly claims the chosen `220px` minimum was picked *so this would not happen*. The arithmetic in that comment is simply wrong for its own stated 768px case.

## Findings

### BLOCKER

1. **Today's `≥768px` grid produces a lopsided 2-fill + dead-orphan row for every 3-tile carousel, at the exact tablet widths the comment claims it avoids** — `client/src/pages/Today.css:400-410` (comment) and `:411-416` (rule); reproduced by `Today.tsx:936-1045` (Carousel 1, always 3 tiles: Grammar/Vocab/Hanja) and `Today.tsx:1065-1080` (Carousel 2, 1–3 tiles). See "Detailed findings" below for the full arithmetic.

### SHOULD-FIX

1. **Progress's "two columns at tablet width" comment is factually wrong at 768px** — `client/src/pages/Progress.css:572-579`. Actual available width at 768px (476px, after the `CollapsibleTile` content padding) only fits **1** `minmax(260px,1fr)` column, not 2; the claimed 2-column "2/2/1 split" doesn't start until ~850px. Not a broken layout (a 1-column stack is visually fine), but the design doc is inaccurate about what actually ships, and it means the "use the desktop width" goal doesn't kick in for the Progress skill grid until well past the 768px breakpoint it's gated on.
2. **Neither new CSS regression test asserts the actual grid geometry, only `display: grid`** — `client/src/pages/Today.test.tsx:499-510` and `client/src/pages/Progress.test.tsx:164-176`. A future edit that silently drops `auto-fit`/`minmax(220px,1fr)` (e.g. swapping in a fixed 2-column grid, which would *fix* the BLOCKER above, or a fixed 5-column grid, which would make Progress's orphan-row problem worse) would not be caught by either test. Recommend widening the regex to also require `grid-template-columns` and the specific `220px`/`260px` minimum, so the exact geometry these findings are about is pinned going forward.
3. **The `640px` readability cap on Progress prose/lists isn't centered, unlike the equivalent TOPIK cap on Today** — `client/src/pages/Progress.css:594-599` (`.km-progress__note`, `.km-mastery__list`, no `margin`) vs. `client/src/pages/Today.css:432-435` (`.km-today__section--topik .km-carousel { max-width: 640px; margin: 0 auto; }`, centered). At desktop widths the capped note/list sits flush-left with a large empty gutter to its right inside an otherwise-centered card. Purely cosmetic, but the two "cap the reading measure" treatments in the same phase disagree on whether to center — worth a `margin-inline: auto` for consistency, or an explicit note that left-aligned is intentional here.

### NIT

1. The `mockViewportWidth` matchMedia stub is now duplicated verbatim across at least 4 test files (`Today.test.tsx:390-408`, `Progress.test.tsx:83-101`, plus — per their own header comments — `Shell.deviceAdaptive.test.tsx` and `useDeviceClass.test.tsx` from D0). Worth extracting to a shared test util at some point; not blocking.
2. `SkillTrendsBody`'s two branches (`Progress.tsx:398-425`) duplicate the entire `SERIES_PANELS.map(...)` JSX verbatim, differing only in the wrapper element (`<div className="km-progress__trendGrid">` vs `<SwipeCarousel>`). Today's `TileRail` (`Today.tsx:573-602`) shows the cleaner pattern — map the children once, pass them into whichever wrapper — that Progress could adopt to avoid the two call sites drifting apart later.

### PRAISE

1. `TileRail` (`Today.tsx:546-602`) is a clean single point of truth for the peek/grid decision shared by both Today carousels — they structurally cannot drift apart on how they respond to the breakpoint, and the `centerRef` design makes the mobile-only scroll-centering concern a true no-op at desktop (never attached in the grid branch) without any extra conditional at the call sites.
2. Double-gating discipline: the grid classes only exist inside `@media (min-width: 768px)` blocks in CSS, *and* the div they style is never mounted at all unless `isGridLayout` is true in JS (`Today.tsx:616`, `Progress.tsx:538`). An accidental mobile leak is essentially impossible by construction — belt-and-suspenders, matching this codebase's established F-129 convention.
3. Deep-link/skeleton/error-state preservation in the grid branch is real, not just asserted: `TileRail`/`SkillTrendsBody` pass through the exact same `ActivityTile`/`SkillTrendPanel` JSX nodes used on mobile — nothing was forked or re-implemented for the grid path — and this is exercised by a live click test at grid width (`Today.test.tsx:469-479`) plus a loading-skeleton-in-grid test (`Today.test.tsx:481-497`).
4. Full targeted suite (126/126) and `tsc -b --noEmit` both pass clean on the delivered branch — verified independently, not just carried over from the PR description.

## Detailed findings (file:line, with arithmetic)

### BLOCKER — Today grid dead-orphan row at 768–935px

**Claim in code** (`Today.css:401-410`):
> "`repeat(auto-fit, minmax(220px, 1fr))` ... `auto-fit` collapses any unfilled repeated track to 0 width and hands that space to the tracks that DO hold a tile ..., so 1–2 tiles stretch to fill the row evenly instead of leaving a dead gap where a 3rd tile would have gone, and a real 3-tile row still gets 3 even columns once the track is wide enough. 220px keeps a tile's icon+text legible at the narrow end of tablet width (768px, minus the 248px sidebar rail) **without forcing a lone 3rd tile onto its own row there**."

**Actual geometry at 768px viewport:**
- Sidebar rail: fixed `248px` (`client/src/styles/index.css:249`, `.km-sidebar { width: var(--sidebar-w) }`).
- Shell content column: `viewport − 248px`, uncapped until `1160px` (`client/src/styles/index.css:250`); no horizontal padding anywhere between `.km-shell`/`.km-today`/`.km-today__section`/`.km-today__grid` (`Today.css:19-21`, `:104-106`, `:411-416` — all vertical-only or layout-only declarations).
- → Available width at 768px = **520px**.
- Grid: `repeat(auto-fit, minmax(220px, 1fr))`, `gap: 14px` (`Today.css:412-416`). Max columns `n` s.t. `n·220 + (n−1)·14 ≤ 520`:
  - `n=2`: `2·220+14 = 454 ≤ 520` ✓
  - `n=3`: `3·220+28 = 688 ≤ 520` ✗
  - → **only 2 columns fit at 768px.** 3 columns don't fit until available width ≥ 688px, i.e. viewport ≥ **936px**.
- CSS Grid's `auto-fit` track-collapse only removes a repeated track that has **no item in any row of the grid** — it is not a per-row/masonry reflow. With exactly 3 items auto-placed into 2 columns (row-major): row 1 gets items 1–2 (filling both columns), row 2 gets item 3 in column 1. Column 2 is *used* in row 1, so it does not collapse; row 2's column 2 remains a normal, empty grid cell.
- **Net visible result at 768–935px:** row 1 shows 2 full-width-ish tiles; row 2 shows one tile at roughly half the row's width with a visibly empty cell beside it — the opposite of the comment's claim of "no dead gap" and "3 even columns."

**Why this is a BLOCKER, not a SHOULD-FIX:**
- Carousel 1 ("Review & drills") *always* renders exactly 3 tiles — Grammar/Vocab/Hanja are unconditional (`Today.tsx:936-1045`, `TileRail` called with a 3-element `tiles` array literal). This is not a rare data-dependent edge case; it reproduces on **every** visit to Today at a tablet-portrait viewport.
- Carousel 2 ("Suggested learning") hits the identical defect whenever all 3 of listening/reading/writing resolve, which is the typical/common case, not the empty-corpus edge case (`Today.tsx:1065-1080`).
- 768–935px is not a narrow/theoretical range — it's the bulk of real tablet-portrait devices (iPad-class portraits are 768–834px logical width), and it's the exact range this phase's own `useDeviceClass` (`hooks/useDeviceClass.ts:41-46`) classifies as `'tablet'` and routes into this grid.
- The review brief's own request to check "768/1024/1280" catches this immediately — at 1024/1280 the layout looks fine (3–4 even columns), so a check that stopped at those two widths alone would have missed it; 768 is where it breaks.
- This is a visual defect "by construction" (provable from the CSS + the fixed tile counts, no browser needed) in the flagship deliverable of a phase literally titled "make Today ... use the desktop width" — at the exact breakpoint that phase turns on.

**Suggested fix directions** (not applied by this review — flagging only): lower the `minmax` floor so 3 columns fit at 768px (`3·x+28 ≤ 520 → x ≤ 164px`, i.e. `164px` or smaller — check if a tile still reads legibly that narrow), or accept 2 columns at the low end but explicitly span the last item across the full row (`:only-child`/`:last-child { grid-column: 1 / -1 }` when the item count doesn't fill the last row) so it *does* stretch instead of leaving a dead cell — which is actually what the current comment already believes happens. Either fix should come with a corrected comment and, per SHOULD-FIX #2 above, a test that pins the actual `grid-template-columns` value.

### SHOULD-FIX #1 — Progress column-count comment, full arithmetic

Chain: `Progress.tsx:649-658` (`CollapsibleTile surface="city"`) → `CollapsibleTile.tsx` renders `CityCard` (`className="km-collapsible"`) → `.km-citycard.km-collapsible { padding: 0 }` (`CollapsibleTile.css:20-22`) zeroes CityCard's own 20px pad, but `.km-collapsible__content { padding: 0 22px 18px }` (`CollapsibleTile.css:78`) re-adds `22px` each side around the actual content, including `SkillTrendsBody`.
- Available width at 768px = `768 − 248 (sidebar) − 44 (22×2 content pad)` = **476px**.
- Grid: `minmax(260px,1fr)`, `gap: 20px` (`Progress.css:580-586`). `n=1`: `260 ≤ 476` ✓. `n=2`: `2·260+20 = 540 ≤ 476` ✗.
- → **1 column at 768px**, not the "two columns at tablet width" the comment (`Progress.css:576-577`) claims. 2 columns actually start at available-width ≥ 540px, i.e. viewport ≥ **850px** (2/2/1 split from there); 3 columns (`3·260+40=820`) start at viewport ≥ **1088px**.
- Because a single column has no "leftover row" to strand an orphan in, this case is not visually broken the way Today's is — it's simply an inaccurate comment, and it means the five-panels-at-once benefit is real (no more paging) even at 768px, but the "wide grid" visual upgrade specifically doesn't arrive until ~850px.

### Mobile-unchanged verification (why I did not flag anything here)

- `Today.tsx:592-602` (`TileRail`'s non-grid branch) renders `.km-today__peekOuter > .km-today__peekTrack > .km-today__peekItem`, byte-identical to the pre-D1 inline JSX this replaced (compared against the diff's removed lines) — same classes, same `ref={t.centerRef}` attachment point, same children.
- `useCenterOnMountRef` (`Today.tsx:536-543`) is unmodified; its `firedRef` guard plus stable `useCallback([])` identity means it fires at most once whichever markup it first attaches to, and the grid branch simply never attaches it (`TileRail`'s `if (isGridLayout)` branch has no `ref` at all) — confirmed by reading `Today.tsx:580-589`.
- `src/test/setup.ts:14-60`'s `beforeEach` stubs `matchMedia` to `matches: false` globally (mobile-first default), so every pre-existing test in both files — none of which were touched except the new blocks appended at the end — continues to exercise the mobile branch unchanged. The D1 test blocks additionally re-confirm this at an *explicit* 375px width (`Today.test.tsx:425-434`, `Progress.test.tsx:116-123`), not just relying on the implicit default.
- `Progress.tsx:398-425`'s `SwipeCarousel` else-branch (mobile) is untouched byte-for-byte from before D1 (same `SERIES_PANELS.map` body, same `ariaLabel`).
- Full suite run confirms all of the above hold at runtime, not just on paper (126/126 pass, see top of this doc).

### Deep-link / data-state preservation in the grid branch (why I did not flag anything here)

- Every `RailTile.node` in `Today.tsx` (grammar/vocab/hanja/listening/reading/writing) is the exact same `ActivityTile` JSX with its original `onClick`/`ariaLabel` — `TileRail` only wraps `t.node` in a `<div>`, it never reconstructs or conditionally alters the tile content (`Today.tsx:580-602`). Confirmed both by reading the diff (no tile JSX was duplicated or forked between grid/peek) and by `Today.test.tsx:469-479`'s live click test at grid width, which asserts `navigate(readingHref(t))` still fires.
- The Vocab tile's skeleton/data/error three-way branch (`Today.tsx:973-1010`) is untouched — it lives inside the `node:` value passed to `TileRail`, so the grid wrapper can't affect which of the three renders. `Today.test.tsx:481-497` exercises this directly at grid width (1024px) and asserts the skeleton (`aria-busy="true"`) appears inside `.km-today__grid`.
- Progress's `SkillTrendsBody` grid branch (`Progress.tsx:398-412`) maps the same `SERIES_PANELS`/`SkillTrendPanel` used by the carousel branch — no separate data path, so the per-skill "Couldn't load"/"No data yet" degradation (`SkillTrendPanel`, `Progress.tsx:284-340`) applies identically in both layouts.
