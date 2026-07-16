# Re-Review — Device-adaptive epic, Phase D1 fix-pass

Independent re-review at `worktree-agent-a07b9fdec3939bd71` @ 6c6f766, base `rebuild`.
Did not write the original code, the review, or the fix-pass. Verified the fix-pass diff
(`git diff 75e7687 6c6f766 -- client/`) and full D1 scope (`git diff rebuild -- client/`,
6 files: `Progress.css/.tsx/.test.tsx`, `Today.css/.test.tsx/.tsx` — `Today.tsx`'s 305-line
diff is pre-existing D1 feature work from 75e7687, untouched by this fix-pass).

jsdom cannot render real layout — verified by re-deriving the CSS Grid track-fitting
arithmetic independently (not by re-reading the fix-pass's numbers and trusting them) and
by tracing the DOM shape (`TileRail`, Today.tsx:573-602) that the selector claims operate on.

## Finding-by-finding

### BLOCKER — tablet-portrait (768–935px) orphan tile — **FIXED, verified independently**

Re-derived the shell geometry from scratch, not copied from the fix report:
- `--sidebar-w: 248px` fixed (`styles/index.css:249`).
- `.km-appframe` is a flex row (Sidebar + `.km-shell`) only `≥768px` (`styles/index.css:1117-1127`).
- `.km-shell` is `flex: 1 1 auto; min-width: 0;` at `≥768px`, capped at `--shell-desktop-max-width:
  1160px`, no horizontal padding of its own (`styles/index.css:1130-1180` — only borders, no
  `padding`).
- `.km-today`, `.km-today__section` carry no horizontal padding (`Today.css:19-21`, `:104-106`,
  verified by reading both rules directly — vertical-only declarations).
- → Available content width at viewport `v` (768 ≤ v ≤ 1408, below the 1160px cap kicking in) =
  `v − 248`. At 768px that is **520px**, matching both the original review and the fix report.

Re-derived the column-fit arithmetic independently: grid is `repeat(auto-fit, minmax(220px,
1fr))`, `gap: 14px` (`Today.css:434-435`). Max `n` s.t. `220n + 14(n−1) ≤ A`:
- 768px → A=520: n=2 → 454 ≤ 520 ✓; n=3 → 688 ≤ 520 ✗ → **2 columns**.
- 935px → A=687: n=3 → 688 ≤ 687 ✗ → still **2 columns**.
- 936px → A=688: n=3 → 688 ≤ 688 ✓ → **3 columns** (exact boundary, no gap or overlap with the
  media query's `max-width: 935px`).
- 1024px → A=776: n=3 fits (688), n=4 needs 922 ✗ → **3 columns**.

This matches the fix report's table exactly — independently reproduced, not just checked for
internal consistency.

**DOM shape verified** (`Today.tsx:580-589`, `TileRail`): in the grid branch, `.km-today__grid`'s
*only* children are `.km-today__gridItem` divs, one per tile in the `tiles` array, mapped 1:1 with
no extra wrapper/skeleton siblings mixed in at the grid level. This matters because the fix's
selector reasons about sibling position (`:nth-child`), and a stray non-tile sibling would silently
break the count. Confirmed clean.

**Selector logic re-derived independently** (`Today.css:477-481`):
```css
@media (min-width: 768px) and (max-width: 935px) {
  .km-today__grid > :last-child:nth-child(odd) { grid-column: 1 / -1; }
}
```
`:last-child` = last element among *all* siblings; `:nth-child(odd)` = sibling-index parity among
*all* siblings (both selectors count identically here since every child matches `:last-child`'s
type-agnostic form and there are no non-tile siblings) — so combined, this matches iff the last
child's 1-indexed position is odd:
- **N=1** (Suggested-learning empty-corpus case): position 1, odd → matches. Redundant but
  harmless — `auto-fit` already stretches a single item to fill the row on its own (no other track
  is ever used in any row, so both/all unused tracks collapse to the one that is) — confirmed this
  independently from first principles of `auto-fit`'s per-grid (not per-row) collapse rule, not by
  trusting the fix report's claim.
- **N=2**: position 2, even → does **not** match. Grid computes 2 real columns at 768–935px (per
  the arithmetic above), so both tiles fill both tracks in row 1 evenly with no override applied —
  correct, no spurious span.
- **N=3** (Carousel 1, always; Carousel 2, commonly): position 3, odd → matches. Item 3 gets
  `grid-column: 1 / -1`. Per CSS Grid auto-placement (sparse packing, default `grid-auto-flow:
  row`): items 1–2 already occupy both column tracks in row 1, so item 3's full-row span cannot fit
  in row 1 and is placed in row 2, spanning both tracks — i.e., true full width, not stuck at
  1-of-2 columns. This is the correct fix for the exact defect described in the BLOCKER.

**Boundary check**: media query cutoff (935/936) exactly matches the arithmetic cutoff (687/688
available width) — no gap where the defect could reappear un-covered, no overlap where the
override could wrongly fire on an already-even 3-column row.

**Verdict: the orphan is genuinely fixed for 1-of-1, 2-of-2 (correctly untouched), and 3-of-3
(correctly spanned) across the full 768–1024px range checked, both at the arithmetic level and by
tracing the actual DOM/selector mechanics — not just re-stating the fix report's own numbers.**

### SHOULD-FIX #1 — Progress "two columns at 768px" comment — **FIXED, verified independently**

Re-derived the padding chain from the actual CSS, not copied: `.km-citycard.km-collapsible {
padding: 0; }` (`CollapsibleTile.css:20-22`) zeroes CityCard's own pad, but
`.km-collapsible__content { padding: 0 22px 18px; }` (`CollapsibleTile.css:77-79`) re-adds 22px
each side (44px total horizontal) around the grid's actual content. `768 − 248 (sidebar) − 44
(content pad) = 476px`. Grid is `minmax(260px,1fr)`, gap 20px: n=1 → 260 ≤ 476 ✓; n=2 → 540 ≤ 476
✗ → 1 column at 768px, matching the corrected comment (`Progress.css:572-591`) and its stated
thresholds (2-col ≥850px, 3-col ≥1088px) — independently reproduced, not just checked for
self-consistency. A 1-column stack has no leftover row to strand a 5th panel in, so this was
correctly scoped as a comment-only fix, not a layout fix.

### SHOULD-FIX #2 — tests now pin grid geometry — **FIXED, verified**

`Today.test.tsx`'s CSS-source test now asserts `grid-template-columns: repeat(auto-fit,
minmax(220px, 1fr));` and a new test asserts the scoped `@media (min-width: 768px) and
(max-width: 935px)` block contains `.km-today__grid > :last-child:nth-child(odd)` and
`grid-column: 1 / -1;`. `Progress.test.tsx` equivalently pins `minmax(260px, 1fr)` and the
`margin-inline: auto;` centering rule. Confirmed by reading the actual test file diffs (not just
the fix report's description) — the regex patterns match the real CSS verbatim, and running them
green (128/128, see gates below) confirms the assertions actually execute against the real
stylesheet text, not a copy.

### SHOULD-FIX #3 — Progress readability cap centered — **FIXED, verified**

`Progress.css:611-617` now reads `max-width: 640px; margin-inline: auto;` on
`.km-progress__note, .km-mastery__list`, matching Today's `.km-today__section--topik
.km-carousel { max-width: 640px; margin: 0 auto; }` pattern (functionally equivalent centering,
different but valid syntax). Comment-and-code consistent; no other rule downstream overrides
`margin-inline`.

### NIT #1 — `mockViewportWidth` duplication — **correctly left NOT APPLIED**

Fix report's reasoning (scope discipline — the other two duplicates live in D0 test files outside
this fix-pass's touched-file set) is sound and matches the original review's own "not blocking"
characterization. No objection.

### NIT #2 — `SkillTrendsBody` duplicate JSX — **FIXED, verified**

`Progress.tsx:384-397` now computes `skillPanels` once and hands the same array to both the grid
`<div>` and `<SwipeCarousel>` wrappers (`Progress.tsx:412-424`), matching `TileRail`'s "map once,
wrap conditionally" shape. Confirmed by reading the diff directly — no behavioral change, pure
extraction, same `key`/props per panel.

## No-regression check

- **Mobile byte-identical**: confirmed by diffing 75e7687→6c6f766 directly — every changed line is
  either inside an `@media (min-width: 768px)` block (all four touched rules) or the *narrower*
  `@media (min-width: 768px) and (max-width: 935px)` block (strictly a subset of ≥768px). No
  mobile-scoped selector, no unscoped rule, no JS branch (`isGridLayout`/`useDeviceClass`) was
  touched by this fix-pass. `Today.tsx`'s only fix-pass-era change is the `Progress.tsx` JSX
  extraction (Today.tsx itself has zero diff between 75e7687 and 6c6f766 — its 305-line diff vs.
  `rebuild` is entirely pre-existing D1 feature work, confirmed by `git diff 75e7687 6c6f766`
  showing no `Today.tsx` hunk at all).
- **Deep-links / skeleton / error-state preservation**: untouched by this fix-pass — `TileRail`'s
  tile-passthrough (Today.tsx:580-589) and `SkillTrendsBody`'s per-skill degradation path are
  exactly as the original review verified them; the only change in that area (`skillPanels`
  extraction) is a pure refactor with identical JSX output per panel.
- **PRAISE items intact**: all 4 hold — none of the fix-pass's 6 changed files touch the
  double-gating (CSS media + JS `isGridLayout`), the `TileRail` single-source-of-truth, or the
  baseline test suite's mobile assertions.

## Gate results (run independently in the worktree)

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0** — clean, no output |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0** — clean, no output |
| Targeted tests | `npx vitest run src/pages/Today.test.tsx src/pages/Progress.test.tsx` | **128/128 pass** (2 test files) |
| Build | `npx vite build --outDir /tmp/km-d1rr` | **0** — clean build; only the pre-existing, unrelated >500kB chunk-size advisory warning (not a fix-pass regression, and not a hard failure) |

All four gates were run fresh in this session, not carried over from the fix report.

## Independent width-arithmetic verdict on the orphan fix

**The orphan is genuinely eliminated across 768–1024px** (and by extension the full
768–935px broken band plus the 936px+ already-correct band): re-derived the sidebar/shell/section
padding chain from the raw CSS (not the fix report's numbers) and got the identical 520px/688px/
768/936px thresholds; independently traced the `TileRail` DOM output to confirm `.km-today__grid`
has no non-tile siblings that could desync the `:nth-child` count; and independently reasoned
through CSS Grid's sparse auto-placement algorithm to confirm a `grid-column: 1/-1` item that
can't fit in the already-full row-1 tracks correctly falls through to row 2 and spans both
tracks there, not just one.

**2-of-2 stays clean**: `nth-child(2)` is even, so the override selector structurally cannot match
a 2-tile grid — verified this is not incidental but a direct consequence of the selector's parity
logic, confirmed against the real possible tile-count range (`suggestedTiles` is built via
conditional `.push()` calls for listening/reading/writing, so 2-of-3 is a real, reachable state,
not just a hypothetical) — a 2-tile row at 768–935px renders as 2 even, un-spanned columns.

No count (1, 2, or 3) produces a visibly broken result in the 768–1024px range checked. The
768/850/936/1024px+ breakpoint transitions are exact (no off-by-one gap or overlapping-rule
window between the arithmetic thresholds and the media query's `max-width: 935px`/`min-width:
936px implied` boundary).

## Recommendation

**Ship.** All 4 phase-1 findings (BLOCKER + 3 SHOULD-FIX) are fixed and independently re-verified
by construction (not just re-reading the fix-pass's own claims); the 1 correctly-deferred NIT is
appropriately scoped out; no regression in mobile, deep-links, or the double-gating discipline;
all 4 requested gates are green, run fresh in this session. The desktop visual/real-browser check
(the one thing neither this review nor the fix-pass could do — jsdom has no layout engine) remains
genuinely pending post-deploy, as the brief anticipated; nothing else is blocking merge.
