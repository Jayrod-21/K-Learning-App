# Fix report: Device-adaptive Phase D2 — review findings

Fix-pass on `REVIEW_d2-adaptive.md` (0 BLOCKER, 2 SHOULD-FIX, 4 NIT against commit `018a9b1`). Scope: client only. The Review-library grid decision (fixed 2-col) and all mobile behavior are unchanged; the orphan guard is kept.

## SHOULD-FIX 1 — Settings resize across 1024px remounted the groups and wiped TwoFactorSection's shown-once recovery codes

**FIXED — the CSS single-tree approach (the review's option (c), refined).**

The desktop/non-desktop render branch is gone. `Settings.tsx` now renders the five groups inside **one always-mounted `.km-settings__grid` wrapper at every width**, and `Settings.css` turns that wrapper into a **row-major 2-column grid at ≥1024px** (styleless plain `<div>` below — the groups stack exactly as before). `useDeviceClass` is no longer imported by Settings at all: the 1024px gate lives solely in the media query.

**Why no remount is possible now:** the React element tree is identical at every viewport width — there is no device-class-dependent branch anywhere in the component, so a media-query flip cannot change the tree shape. Crossing 1024px is pure style recalculation; component instances (TwoFactorSection's one-shot `codes`/`flow` state, open tiles, in-flight flows) and their DOM nodes all survive. Verified three ways:

1. **New test** (`Settings.test.tsx`, "resize across 1024px does NOT remount the groups"): stubs a live matchMedia at 1024px (desktop), runs the real regenerate flow until the new recovery codes render, then crosses to 768px — firing the matchMedia `change` listeners exactly like a real `MediaQueryList` — plus a forced top-down rerender, and asserts **DOM-node identity** (`getByText('NEW11-NEW22')` is the *same element* captured before the crossing, ditto the 2FA disclosure header) and that the tile stays expanded. Then crosses back up (768→1280) and re-asserts. Node identity is the sharp assertion: a remount necessarily creates new elements even if the text reappeared.
2. **Negative control**: the same test was run against the pre-fix `Settings.tsx`/`Settings.css` (restored from `018a9b1` temporarily) and **fails** there (1 failed | 64 skipped), passing only with the fix — it is a real trip-wire, not a tautology.
3. The single-tree shape itself is pinned at mobile/768/1024/1440 (`expectSingleGridTree`: exactly one `.km-settings__grid`, exactly five `.km-settings__group` direct children, canonical order).

**Consequences accepted (and documented in the code, not overclaimed):**

- **Row-major replaces the JS column-major grouping** (blessed by the fix brief; the review confirmed row-major DOM order is the a11y-correct one). DOM = tab = SR = visual reading order is the mobile order (Profile → 2FA → Notifications → Appearance → Beta feedback) in every layout. Desktop rows: Profile | 2FA, Notifications | Appearance, Beta feedback.
- **The per-column-wrapper property is traded away** (review PRAISE item 3): with the groups as direct grid items, expanding a tile grows its whole grid row, so its row-mate shows blank space beneath while the tile is open (`align-items: start` keeps the mate's card at natural height). Bounded by one open tile, tiles start collapsed (F-038) — a cosmetic cost, accepted as the price of eliminating real data loss. Stated plainly in the Settings.css comment.
- **A trailing odd group gets an orphan guard** (same `:last-child:nth-child(odd)` shape as ReviewLibrary's): with five groups, Beta feedback spans the full row — the exact width every group had at desktop pre-D2 — instead of stranding at half width beside a blank cell. Pinned in the CSS-source test.
- **Mobile/tablet DOM gains one inert wrapper `<div>`** (unavoidable: the no-remount guarantee requires the wrapper to exist at every width). It carries zero styles below 1024px, so rendering, spacing, and behavior are unchanged; the readability arithmetic (~308px controls at 1024px → ~500px at cap, 36px gutter from the doubled 18px margins) is untouched. The old "no wrapper node on mobile" test assertions were updated to the new, stronger contract: *identical tree at every width*.

## SHOULD-FIX 2 — Overclaims in the ReviewLibrary.css arithmetic comment

**FIXED (documentation).** Both corrections applied to the load-bearing comment:

- (a) auto-fit now states the real orphan band: Uploads is stranded across **~976–1207px** viewports, and at **≥1208px** (list ≥916px = 4·220+3·12) auto-fit computes four columns — a single 4-up row, no orphan, but ~220–270px cards clashing with the 2-up look just below. The band covers the common laptop widths (1024/1152/1200), so the fixed-2-col conclusion stands and is now stated at its true scope.
- (b) the false "all comfortably inside the range these rows already render at (330px…)" claim is replaced with the real numbers: ~232px cards at a 768px viewport are **narrower than the pre-D2 floor** (≈276px at a 320px phone, ≈331px at 375px). **232px is confirmed acceptable for a shelf card**: the row is wrap-safe end to end (`min-width: 0` chained wrapper → button → card → rowTop; short labels; `__rowdesc` wraps), and CityCard's 14px/16px padding leaves ~200px of content at the worst case — matching the review's own content inspection. The 768–900px band is named in the comment as a target of the pending post-deploy visual check.

Grid geometry, breakpoints, and the orphan guard are byte-identical to the reviewed version (the CSS-source tests still pass unchanged).

## NITs

- **NIT 1 (stub answers `true` for non-width queries) — FIXED, once.** New shared helper `client/src/test/viewport.ts` replaces the per-file `mockViewportWidth` copies in `ReviewLibrary.test.tsx` and `Settings.test.tsx`. Non-`min-width` queries (`prefers-color-scheme`, `prefers-reduced-motion`, …) now report `false`, matching `setup.ts`'s baseline. The helper is also *live*: it returns a controller whose `set(width)` fires registered `change` listeners with a real event payload (`{matches, media}` — ThemeProvider reads `e.matches`), which is what powers the SHOULD-FIX 1 crossing test. **Skipped:** migrating the remaining copies in `Today.test.tsx`, `Progress.test.tsx`, and `Shell.deviceAdaptive.test.tsx` — those files are outside D2's scope and their tests don't depend on non-width queries; consolidation is a safe follow-up.
- **NIT 2 (source-order-dependent `display: flex` vs `display: block`) — FIXED.** The grid row rule is now `.km-library .km-library__list--grid .km-library__row` — specificity (0,3,0) beats the (0,2,0) base reset regardless of file order — with a comment explaining why the prefix exists.
- **NIT 3 (400-char proximity heuristic in the negative CSS assertion) — SKIPPED** per the review's own assessment ("acceptable as belt-and-braces; the positive 1024px block assertion is the real gate"). The assertion was retargeted from `km-settings__cols` to `km-settings__grid`, semantics unchanged.
- **NIT 4 (12px grid gap vs 8px mobile stack) — SKIPPED** (no code change, as the review intended — it's deliberate, matching D1's grid gap). Noted here so the post-deploy visual check compares the rhythms knowingly.

## Gates (exact)

| Gate | Result |
|---|---|
| `npm run lint` | 0 errors, 0 warnings (exit 0) |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | 0 errors (exit 0); `include: ["src"]` covers the new `src/test/viewport.ts` and both test files |
| `npx vitest run src/pages/ReviewLibrary.test.tsx src/pages/Settings.test.tsx` | **84/84 pass** (2 files; 83 pre-existing + 1 new crossing test) |
| `npx vite build --outDir /tmp/km-d2fix` | success (exit 0, PWA precache 15 entries) |
| Negative control | crossing test **fails** against `018a9b1`'s Settings.tsx/css, passes with the fix |

## Files touched

- `client/src/pages/Settings.tsx` — branch removed, one always-mounted `.km-settings__grid` tree; comments rewritten (no remount claim is now true by construction)
- `client/src/pages/Settings.css` — `.km-settings__cols`/`__col` → `.km-settings__grid` (row-major, `min-width: 0` items, odd-last-child full-width guard); comment rewritten with the row-stretch tradeoff stated honestly
- `client/src/pages/Settings.test.tsx` — D2 block rewritten (single-tree contract at 4 widths, new no-remount crossing test, CSS gate test retargeted); `renderSettings` split into `settingsUi()` + `renderSettings()` for the rerender
- `client/src/pages/ReviewLibrary.css` — comment corrections (real orphan band, real card-width floor), specificity fix on the grid row rule; **no geometry/selector-behavior changes** to the grid, breakpoints, or orphan guard
- `client/src/pages/ReviewLibrary.test.tsx` — shared viewport helper
- `client/src/test/viewport.ts` — new shared, live matchMedia width stub
