# Fix Report — Device-adaptive epic, Phase D1 (Today + Progress use desktop width)

Fix-pass against `docs/redesign/REVIEW_d1-adaptive.md`, worked on
`worktree-agent-a07b9fdec3939bd71` @ base 75e7687. Scope: `pages/Today.tsx/.css/.test.tsx`,
`pages/Progress.tsx/.css/.test.tsx`. Did not write the original code or the review — this is
an independent fix pass; an independent re-review follows.

## Disposition summary

| Finding | Disposition |
|---|---|
| BLOCKER — tablet-portrait (768–935px) orphan tile | **FIXED** |
| SHOULD-FIX #1 — Progress "two columns at tablet width" comment wrong | **FIXED** |
| SHOULD-FIX #2 — CSS regression tests only assert `display: grid` | **FIXED** |
| SHOULD-FIX #3 — Progress readability cap not centered | **FIXED** |
| NIT #1 — `mockViewportWidth` duplicated across 4 test files | **NOT APPLIED** (see below) |
| NIT #2 — `SkillTrendsBody`'s two branches duplicate `SERIES_PANELS.map` | **FIXED** |

## BLOCKER — tablet-portrait orphan tile

### Root cause (confirmed independently, then fixed)

`.km-today__grid` (`client/src/pages/Today.css`) used `grid-template-columns: repeat(auto-fit,
minmax(220px, 1fr))`. `auto-fit` only collapses a repeated track to 0 width when that track is
unused in **every** row of the grid — it is a per-grid decision, not a per-row/masonry reflow.
With exactly 3 tiles auto-placed into 2 computed columns, row 1 uses both columns (so neither is
eligible to collapse), and row 2's lone 3rd tile sits at half width next to a genuinely dead,
unfilled cell. The prior comment claimed 220px was chosen specifically to avoid this at 768px;
that arithmetic was wrong.

### Real width arithmetic (no browser needed — CSS Grid track-fitting is exact)

Shell geometry (`client/src/styles/index.css:249-250`): `--sidebar-w: 248px` (fixed), `.km-shell`
uncapped until `--shell-desktop-max-width: 1160px` (reached at viewport 1408px). No horizontal
padding anywhere in `.km-shell` → `.km-today` → `.km-today__section` → `.km-today__grid`
(verified: all vertical-only/layout-only declarations). So:

```
available content width A(viewport) = viewport − 248,  for viewport in [768, 1408]
```

Grid: `repeat(auto-fit, minmax(220px, 1fr))`, `gap: 14px`. Max columns `n` such that
`n·220 + (n−1)·14 ≤ A`:

| Viewport | A (available) | n=2 fits? (454) | n=3 fits? (688) | Computed columns |
|---|---|---|---|---|
| **768px** | 520px | 454 ≤ 520 ✓ | 688 ≤ 520 ✗ | **2** |
| **900px** | 652px | 454 ≤ 652 ✓ | 688 ≤ 652 ✗ | **2** |
| **936px** | 688px | 454 ≤ 688 ✓ | 688 ≤ 688 ✓ | **3** |
| **1024px** | 776px | — | 688 ≤ 776 ✓ (n=4 needs 922, ✗) | **3** |

So the dead-orphan window is exactly **768–935px** (2 computed columns, 3 tiles) — 768 and 900 are
inside the broken band, 936 and 1024 are outside it (3 real columns, already even, already
correct). This matches the review's own computed threshold exactly.

### Fix applied

Kept `minmax(220px, 1fr)` unchanged (legibility target preserved — shrinking the floor to force 3
columns at 768px, e.g. to ~164px, would leave a tablet-portrait tile with only ~84px of text
width after the 36px icon + 12px gap + 32px padding chrome, wrapping full sentences like "FSRS
scheduling · due for review" across 4+ lines — genuinely cramped, not just narrow). Instead, added
a media-scoped rule that spans a trailing lone tile full width instead of leaving it stranded:

```css
@media (min-width: 768px) and (max-width: 935px) {
  .km-today__grid > :last-child:nth-child(odd) {
    grid-column: 1 / -1;
  }
}
```

`:last-child:nth-child(odd)` matches exactly a trailing tile with no sibling to its right in the
final row:
- **1-of-1** (Suggested learning's empty-corpus single-tile case): `nth-child(1)` is odd →
  matches, but this is harmless/redundant — a lone tile already spans full width via `auto-fit`'s
  own per-grid collapse (no other track is ever used, so both collapse to the one that is).
- **2-of-2**: `nth-child(2)` is even → does **not** match — a full, even 2-tile row must not be
  spanned.
- **3-of-3** (Carousel 1, always; Carousel 2, commonly): `nth-child(3)` is odd → matches, spans
  the lone 3rd tile full width in row 2 instead of leaving it at half width with a dead cell.

Scoped to exactly 768–935px: below that range there's nothing to fix (mobile uses the untouched
peek slider), and at ≥936px 3 real columns already fit evenly, so applying the override there
would wrongly break an already-correct 3-column row into a 2-then-full-width-3rd layout.

**Column-count-per-breakpoint result, post-fix:**

| Viewport | Carousel 1 (always 3 tiles) | Carousel 2 (1–3 tiles) |
|---|---|---|
| 768px | 2 even columns, 3rd tile spans full width row 2 (no orphan) | Same pattern for 3 tiles; 1–2 tiles stretch evenly (unchanged, `auto-fit` collapse) |
| 900px | Same as 768px | Same as 768px |
| 936px | 3 even columns (override inactive, not needed) | 3 even columns for 3 tiles; 1–2 still stretch evenly |
| 1024px | 3 even columns | 3 even columns / stretch for fewer |

The false comment (`Today.css:401-410` pre-fix) was corrected to describe the actual per-grid
collapse mechanics, the real 520px/688px arithmetic, and why the scoped override is needed and
safe.

**Files touched:** `client/src/pages/Today.css` (corrected header comment + new scoped rule).

## SHOULD-FIX #1 — Progress "two columns at tablet width" comment

### Verified arithmetic

Chain: `Progress.tsx` `CollapsibleTile surface="city"` → `.km-citycard.km-collapsible { padding:
0 }` (`CollapsibleTile.css:20-22`) zeroes CityCard's own 20px pad, but
`.km-collapsible__content { padding: 0 22px 18px }` (`CollapsibleTile.css:78`) re-adds 22px each
side around `SkillTrendsBody`. So:

```
available at 768px = 768 − 248 (sidebar) − 44 (22px × 2 content padding) = 476px
```

Grid: `minmax(260px, 1fr)`, `gap: 20px`. `n=1`: `260 ≤ 476` ✓. `n=2`: `2·260+20 = 540 ≤ 476` ✗ →
**1 column at 768px**, not "two columns" as the old comment claimed. 2 columns actually start at
available ≥ 540px → viewport ≥ **850px**; 3 columns (`3·260+40=820`) start at viewport ≥ **1088px**.

This was never a layout bug — a single column has no leftover row to strand anything in — just an
inaccurate design comment. Corrected `client/src/pages/Progress.css`'s header comment with the
real thresholds (768/850/1088) and the exact padding chain that produces 476px, not 520px.

**Files touched:** `client/src/pages/Progress.css` (comment only, no behavior change).

## SHOULD-FIX #2 — Widen CSS regression tests

Both `Today.test.tsx` and `Progress.test.tsx` had a CSS-source test that only asserted
`display: grid;` inside the `≥768px` media block — a change that silently swapped the column
scheme (fixed 2-col, fixed 5-col, etc.) would not have been caught. Widened both to also assert
the exact `grid-template-columns` value:

- `Today.test.tsx`: now asserts `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));`,
  and a **new** test pins the BLOCKER fix's scoped rule (`@media (min-width: 768px) and
  (max-width: 935px)`, selector `.km-today__grid > :last-child:nth-child(odd)`, `grid-column: 1 /
  -1;`).
- `Progress.test.tsx`: now asserts `grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));`,
  and a **new** test pins SHOULD-FIX #3's centering (`max-width: 640px; margin-inline: auto;`).

jsdom cannot render real layout, so these remain source pins (regex over the stylesheet text), not
rendered-geometry assertions — correctness of the geometry itself is established by construction
via the arithmetic above, per the brief.

**Files touched:** `client/src/pages/Today.test.tsx`, `client/src/pages/Progress.test.tsx`.

## SHOULD-FIX #3 — Center the Progress readability cap

`.km-progress__note` / `.km-mastery__list` had `max-width: 640px` with no `margin`, so at desktop
widths they sat flush-left with a large empty gutter to the right inside an otherwise-centered
card — inconsistent with Today's equivalent TOPIK cap (`.km-today__section--topik .km-carousel {
max-width: 640px; margin: 0 auto; }`). Added `margin-inline: auto;` (the reviewer's own suggested
property) to `client/src/pages/Progress.css`'s readability-guard rule, and documented the parity
with Today's cap in the comment.

**Files touched:** `client/src/pages/Progress.css`.

## NIT #1 — `mockViewportWidth` duplication (NOT applied)

The identical `mockViewportWidth` helper is duplicated verbatim across `Today.test.tsx`,
`Progress.test.tsx`, `Shell.deviceAdaptive.test.tsx`, and `useDeviceClass.test.tsx`. Extracting it
to a shared test util would require touching two files outside this fix-pass's scope
(`Shell.deviceAdaptive.test.tsx` / `useDeviceClass.test.tsx` belong to Phase D0, not D1), and the
review itself flagged this as "not blocking." Left as-is to keep this fix-pass's diff scoped to
the D1 findings; flagging for a future dedicated cleanup pass rather than opportunistically
touching D0 test files here.

## NIT #2 — `SkillTrendsBody` duplicate JSX (applied)

`Progress.tsx`'s grid/carousel branches each independently re-mapped `SERIES_PANELS` into
`SkillTrendPanel` nodes — identical bodies, differing only in the wrapper element. Extracted to a
single `skillPanels` array computed once and handed to whichever wrapper `isGridLayout` picks,
matching `Today.tsx`'s `TileRail` "map once, wrap conditionally" shape so the two call sites can no
longer drift apart on props/keys.

**Files touched:** `client/src/pages/Progress.tsx`.

## Self-assessment

- The BLOCKER's root cause (CSS Grid's per-grid, not per-row, `auto-fit` track-collapse) was
  independently re-derived from the CSS before applying a fix, then checked against the review's
  own arithmetic — the numbers match (520px/688px thresholds, 768–935px orphan band).
- The chosen fix (media-scoped `:last-child:nth-child(odd)` span) is the review's own explicitly
  offered second fix direction ("accept 2 columns at the low end but explicitly span the last item
  across the full row... when the item count doesn't fill the last row"), not a smaller/cramped
  minmax floor — chosen because it preserves the original 220px legibility target instead of
  trading it away, and because it structurally cannot fire outside the exact 768–935px band where
  the defect exists (verified by re-deriving the 936px 3-column threshold and confirming the
  override is media-scoped to end just before it).
- Progress's SERIES_PANELS grid has a structurally similar "N items into 2 computed columns"
  shape (5 panels, 2/2/1 split) that could in principle strand its 5th panel the same way — but the
  independent reviewer explicitly assessed this as visually acceptable ("2/2/1 — acceptable, not
  five squeezed columns") and did not flag it as a defect, only the comment's wrong thresholds
  (SHOULD-FIX #1, which is what was fixed). Not touched further, to stay disciplined to the
  reviewer's actual findings rather than inventing new scope; noted here for visibility in case a
  future review wants to revisit it.
- All 4 PRAISE items (mobile byte-equivalence, double-gating, deep-link/skeleton preservation,
  clean baseline suite) were left untouched — no fix in this pass altered the mobile branch, the
  grid/JS gating, or any tile's underlying JSX.

## Gate results

- `npm run lint` → **0** (clean)
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0** (clean)
- `npx vitest run` → **120 files passed / 2027 tests passed** (one apparent failure —
  `src/pages/review/ReviewDictionary.test.tsx`, unrelated to this fix-pass's files — on a single
  full-suite run; re-ran in isolation (18/18 pass) and re-ran the full suite again (120/120 files,
  2027/2027 tests pass) — confirmed pre-existing test-run flakiness, not caused by this change)
  `npx vitest run src/pages/Today.test.tsx src/pages/Progress.test.tsx` → **128/128** pass
  (126 original + 2 new CSS-pin tests)
- `npx vite build --outDir /tmp/km-d1fix` → **0** (clean; pre-existing >500kB chunk-size
  advisory warning only, unrelated to this change)
