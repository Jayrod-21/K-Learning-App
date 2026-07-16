# Review: Device-adaptive Phase D2 — Review-library grid + Settings two-column

Reviewer: independent senior front-end review (React/TS, responsive + a11y). Scope: `client/src/pages/ReviewLibrary.{tsx,css,test.tsx}` + `client/src/pages/Settings.{tsx,css,test.tsx}` as of commit `018a9b1` on `worktree-agent-a8848647ce728b0e0`, diffed against `rebuild`. Code not modified. jsdom does no layout, so grid geometry was verified by independent re-derivation of the width arithmetic plus CSS-source inspection; the on-screen desktop visual check remains **pending post-deploy**.

## Summary verdict: **PASS** — 0 BLOCKER, 2 SHOULD-FIX, 4 NIT

Mobile is provably unchanged on both pages (exact-class-string assertion on ReviewLibrary, wrapper-absence + order assertions on Settings, and the mobile-first `matches: false` test baseline means every pre-existing test in both files re-exercises the mobile branch). The fixed 2-column Review-library grid is orphan-free by construction at every ≥768px width — I re-derived the arithmetic independently and it checks out, including the counterfactual that `auto-fit` **would** have stranded Uploads across the ~976–1207px viewport band. Settings' two-column layout is column-major with DOM/tab/SR order identical to mobile, verified in source and pinned by a document-order test. The two SHOULD-FIXes are (1) a real-but-rare 2FA state-loss edge when a live resize crosses the 1024px boundary (iPad rotation), and (2) two factual overclaims in the load-bearing CSS arithmetic comment.

## Independent arithmetic re-derivation

### Review-library grid width (the orphan question)

Inputs verified in source: sidebar rail `--sidebar-w: 248px` (`client/src/styles/index.css:249`), desktop shell cap `--shell-desktop-max-width: 1160px` (`index.css:250`), applied with `flex: 1 1 auto` at ≥768px (`index.css:1174-1180`) so the shell genuinely claims `min(viewport − 248, 1160)`; `.km-library { padding: 0 22px 32px }` (`index.css:1754`); grid `gap: 12px` (`ReviewLibrary.css:103`).

| Viewport | Content column | List width (−44 padding) | Card width, fixed 2-col ((w−12)/2) |
|---|---|---|---|
| 768 | 520 | **476** | ~232 |
| 948 | 700 | **656** | ~322 |
| 1024 | 776 | **732** | ~360 |
| 1280 | 1032 | 988 | ~488 |
| ≥1408 (cap) | 1160 | **1116** | ~552 |

Bolded values match the builder's comment (`ReviewLibrary.css:85-87`) exactly. With `repeat(2, minmax(0, 1fr))` and a compile-time-fixed 4 shelves (`ReviewLibrary.tsx:97-119`, `SECTIONS`), the layout is a clean 2×2 at **every** ≥768px width — no stranded shelf is possible at any width, by construction. Confirmed.

**Auto-fit counterfactual** (`minmax(220px, 1fr)`, gap 12): N columns fit when list width ≥ 220N + 12(N−1). 3 columns need ≥684px → viewport ≥ 684+44+248 = **976px**, matching the builder's "~976px" (`ReviewLibrary.css:88`). From 976px, 4 shelves in 3 columns = 3+1 with Uploads alone in a half-empty second row — D1's exact orphan blocker. So the builder was right: auto-fit was the wrong tool here, and the fixed 2-col is the correct fix. One correction to the comment's scope, though: 4 columns fit at list width ≥916px → viewport ≥ **1208px**, where auto-fit would render a single 4-up row (no orphan, but 220–279px cards inconsistent with the 2-up look below it). The orphan band is ~976–1207px — which covers the most common laptop widths (1024/1152/1200), so the conclusion stands — but "at every desktop width" (`ReviewLibrary.css:89-90`) is an overclaim. See SHOULD-FIX 2.

**Card-width sanity:** at 768–~900px viewports, cards are ~232–290px — *below* the narrowest width these rows ever rendered at pre-D2 (≈276px at a 320px phone, ≈331px at 375px), contradicting the comment's own "all comfortably inside the range these rows already render at (330px-wide mobile column up …)" (`ReviewLibrary.css:93-95` — 232 < 330, internally inconsistent). Content survives inspection: the row is wrap-safe (`min-width: 0` chained at every level, `ReviewLibrary.css:114-133`; short labels; `__rowdesc` wraps), CityCard padding 14/16 leaves ~200px of content at the worst case, and DancheongRail is `position: absolute` (`DancheongRail.css:11`) so the card's new flex context doesn't disturb it — so I expect no breakage, but this exact band (768–900px) is the one to eyeball in the pending post-deploy visual check. See SHOULD-FIX 2.

**Orphan guard** (`ReviewLibrary.css:149-152`): `:last-child:nth-child(odd)` in a 2-column grid is precisely "trailing item with no partner"; the list's only children are the four `role="listitem"` divs (`ReviewLibrary.tsx:155-193`), so `nth-child` counts nothing else. Inert at the current even count, spans a hypothetical fifth shelf full-width. Correct, and pinned by test (`ReviewLibrary.test.tsx:305-318`).

### Settings column width (the ≥1024-not-768 question)

Inputs verified: `.km-settings` has **no** side padding (`index.css:4982`), groups carry `margin: 0 18px 16px` (`index.css:4984`), CollapsibleTile content pads 22px per side (`CollapsibleTile.css:30,78`). No `gap` on `.km-settings__cols` — the adjacent 18px group margins form the 36px gutter, exactly as the comment claims, and the outer 18px edges match mobile's.

| Viewport | Content column | Per column (÷2) | Controls (−36 margins −44 padding) |
|---|---|---|---|
| 1024 | 776 | 388 | **~308** |
| ≥1408 (cap) | 1160 | 580 | **~500** |
| 375 phone (1 col) | 375 | 375 | **~295** |

All three bolded figures match `Settings.css:170-178` exactly. The tablet rejection is sound: at 768px a two-column split would leave (520/2) − 36 − 44 = **180px** of control width — far below the 295px floor these forms were designed against — and no sane intermediate breakpoint exists that the app doesn't already own, so reusing the existing 1024px `'desktop'` bucket (no new breakpoint, no hook change) is the right call. The test pins tablet-stays-single-column explicitly (`Settings.test.tsx:2348-2356`) and pins the CSS gate at 1024-not-768 including a negative 768px check (`Settings.test.tsx:2413-2440`).

## A11y / order audit

- **Settings column-major = mobile order, verified in source:** desktop branch renders col1 = `profileGroup`, `twoFactorGroup`; col2 = `notificationsGroup`, `appearanceGroup`, `feedbackGroup` (`Settings.tsx:1349-1359`); non-desktop fragment renders the same five in the same sequence (`Settings.tsx:1361-1368`). Document order — and therefore tab order and screen-reader order — is Profile → 2FA → Notifications → Appearance → Beta feedback in **both** branches. Pinned by `expectGroupOrder()`, which walks `getAllByRole('button')` in document order (`Settings.test.tsx:2317-2337`) and runs in the mobile, tablet, and desktop tests.
- **Independent column wrappers:** two plain divs, laid out by `grid-template-columns: repeat(2, minmax(0,1fr))` with `align-items: start` (`Settings.css:190-199`). Because each column is a single grid item containing its own flow stack, expanding a CollapsibleTile in one column cannot stretch a shared grid row or open a gap under the other column's tiles — the failure mode the comment names is structurally impossible, not just styled away. Confirmed.
- **ReviewLibrary:** the grid is row-major auto-placement over unchanged DOM order (Vocabulary, Grammar / TOPIK, Uploads), so visual reading order = DOM = tab order. No heading structure changes on either page; the disclosure buttons keep their `aria-expanded` contract in the two-column branch (behavior test at `Settings.test.tsx:2394-2404`).
- **`minmax(0, 1fr)` + `min-width: 0`** used consistently on both pages (F-129 convention) — no min-content blowout from long unbroken strings.

## Mobile-unchanged audit

- **ReviewLibrary:** the only render change is the `cn(...)`-appended modifier (`ReviewLibrary.tsx:129,147-151`); on mobile `cn` drops the falsy operand and the class attribute is the literal pre-D2 string. Pinned by an **exact** `getAttribute('class') === 'km-library__list'` assertion at the default mobile baseline *and* at an explicit stubbed 375px (`ReviewLibrary.test.tsx:232-246`) — this is a real trip-wire; any wrapper, any extra class, fails it. All D2 CSS lives behind `@media (min-width: 768px)` and a class mobile never carries (double gate).
- **Settings:** the non-desktop branch is a bare fragment — no wrapper node — around the five groups in original order; the five group elements are built **once** as consts (`Settings.tsx:1094-1321`) and rendered by whichever branch is live, so props/handlers/DOM cannot diverge between layouts. The group JSX is a verbatim move (confirmed against the diff), the only textual change being JSX comments becoming JS comments (no DOM). Pinned by wrapper-absence + count + order tests (`Settings.test.tsx:2339-2346`). Additionally, `src/test/setup.ts` re-installs a `matches: false` matchMedia before every test, so the ~70 pre-existing tests in these two files all re-exercise the mobile branch — any mobile behavioral drift would have failed them.
- **No persistence/behavior change in Settings:** no new state writes, no endpoint changes, no handler changes; `useDeviceClass()` is called unconditionally at a stable hook position (`Settings.tsx:1091`). Layout-only, as briefed — with the one resize caveat below.

## Findings

### BLOCKER

None.

### SHOULD-FIX

1. **Live resize across 1024px remounts all five groups and wipes TwoFactorSection's one-shot state — and the trigger is realistic (iPad rotation).** Crossing the boundary swaps the section's second child between a `div.km-settings__cols` and a fragment (`Settings.tsx:1343-1368`); React reconciles by type, so all five groups unmount/remount. The builder's comment (`Settings.tsx:1082-1090`) acknowledges the remount and claims "every durable value lives in this component's state or on the server, so nothing user-entered is lost" — true for user-*entered* data (profile buffer, schedule drafts live in the surviving Settings component), but incomplete: `TwoFactorSection` holds its own `flow` and `codes` state (`Settings.tsx:1508-1510`), and freshly regenerated recovery codes are **shown once, never persisted** by design (`Settings.tsx:1462-1464`). A user who regenerates codes on an iPad in portrait (768px = tablet) and rotates to landscape (1024px = desktop) loses the codes display *after* the old codes were already invalidated server-side. Recoverable (regenerate again with password re-auth) and rare, but it is a sharper edge than D1's accepted tile-collapse tradeoff, and the in-code claim is subtly wrong. Fix options, cheapest first: (a) correct the comment and accept, documenting the 2FA edge explicitly; (b) lift `codes`/`flow` into the Settings component so the display survives the remount; (c) key the five groups and render them as direct grid children with `grid-column` assignments instead of branch-swapped wrappers (avoids the remount entirely, at the cost of the independent-column-wrapper property). Given single-user scope, (a) or (b).

2. **The load-bearing arithmetic comment in `ReviewLibrary.css` overclaims twice — in a phase whose entire justification is that arithmetic.** (a) `ReviewLibrary.css:88-91`: auto-fit strands Uploads "at every desktop width" — actually only across ~976–1207px viewports; at ≥1208px auto-fit computes 4 columns (a single 4-up row, no orphan). The conclusion (fixed 2-col) is still right, and the band it protects covers the common laptop widths, but the comment should state the real band. (b) `ReviewLibrary.css:92-95`: "per-card widths of ~232px … all comfortably inside the range these rows already render at (330px-wide mobile column up to …)" is internally inconsistent — 232 < 330. In the 768–~900px viewport band, cards are narrower than any width these rows have ever rendered at (pre-D2 floor ≈276px at a 320px phone). Content is wrap-safe so this is almost certainly fine visually, but (i) correct the comment, and (ii) make the 768–900px band a named target of the pending post-deploy visual check. These are documentation fixes, elevated above NIT because future editors are explicitly invited to trust this comment's numbers (the CSS-source test at `ReviewLibrary.test.tsx:278-303` points to it as the authority).

### NIT

1. **The test matchMedia stub answers `matches: true` for every non-min-width query.** `mockViewportWidth` returns `width >= threshold` with `threshold = 0` when the query has no `min-width` (`ReviewLibrary.test.tsx:208-227`, `Settings.test.tsx:2291-2311`) — so under the stub, `(prefers-color-scheme: dark)` and `(prefers-reduced-motion: reduce)` both report **true**, the inverse of `setup.ts`'s deliberate all-false baseline. Harmless for the current assertions and consistent with the D1 idiom in Today.test.tsx, but a stub that returns `false` for non-width queries would keep the baseline honest. Worth fixing once, in a shared test helper, rather than in each copy.
2. **`display: flex` on `.km-library__list--grid .km-library__row` beats `.km-library .km-library__row { display: block }` (`ReviewLibrary.css:38-46`) only by source order** — both selectors are (0,2,0). Correct today because both live in the same co-located file with the grid block later; fragile to an innocent reorder. A one-line comment on the grid rule (or `.km-library .km-library__list--grid .km-library__row`) would pin it.
3. **The Settings negative CSS assertion is a proximity heuristic:** `/@media \(min-width: 768px\)[\s\S]{0,400}km-settings__cols/` (`Settings.test.tsx:2434-2438`) misses a 768px-gated rule more than 400 chars upstream of the class mention. Acceptable as belt-and-braces (the positive 1024px block assertion is the real gate), just don't rely on it alone.
4. **Grid vertical gap is 12px vs the mobile stack's 8px** (`ReviewLibrary.css:103` vs `index.css:1775-1779`). Presumably deliberate (matches D1's grid gap); noting it so the post-deploy visual check compares the rhythms knowingly.

### PRAISE

- The fixed-2-col-over-auto-fit decision is exactly right for a compile-time-fixed item count, and the reasoning is written down *at the decision site* with re-derivable numbers — this review could check it precisely because the builder showed the work.
- The `:last-child:nth-child(odd)` orphan guard is a genuinely elegant future-proof: provably inert at n=4, provably correct at n=5, and test-pinned so it can't be "cleaned up."
- Independent column wrappers in Settings make the cross-column-gap failure mode impossible by structure rather than by styling — the strongest kind of fix.
- Building the five Settings groups once and rendering them from either branch eliminates by construction the classic two-layout bug (props drifting between copies).
- The exact-class-string mobile assertion in ReviewLibrary is the strictest practical form of "mobile byte-identical" jsdom can express, and both CSS-source tests pin the breakpoint *numbers*, not just the existence of a media query — a copy-pasted 768 in Settings.css would fail CI.

## Verification runs (this review)

- `npx vitest run src/pages/ReviewLibrary.test.tsx src/pages/Settings.test.tsx` — **83/83 pass** (2 files).
- `npx tsc --noEmit` — clean.
- `npx eslint` on the four changed TS/TSX files — clean.
- Grep for `km-settings__cols` / `km-settings__col` / `km-library__list--grid` outside the two pages — no collisions.

## Pending

- Post-deploy desktop visual check (jsdom cannot verify layout): 2×2 shelf grid at 768 / 1024 / 1280 / ≥1408; the 768–900px card-width band specifically (SHOULD-FIX 2b); Settings two-column at 1024 and at the cap; iPad-rotation crossing (SHOULD-FIX 1) if a physical device is handy.
