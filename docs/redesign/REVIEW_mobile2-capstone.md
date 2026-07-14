# REVIEW — Mobile-correctness capstone, round 2

**Scope:** round-2 mobile fixes `bd4783b..c6a4436` on `feat/mobile-hardening`.
Four fixes: (1) PDF `<img>` drag/callout shutoff (UploadViewer), (2) Carousel 1
converted to the native-scroll-snap peek slider to match Carousel 2 (Today),
(3) SkillsCompare TOPIK pills abbreviated to `T1…T6`/`Native`, (4) Grammar tab
removed from the Library subnav.

**Reviewer stance:** independent senior mobile engineer; reasoning at real 360px
+ touch, because jsdom tests cannot see layout, touch-action arbitration, or the
image-drag subsystem.

---

## VERDICT: SHIP-SAFE — 0 BLOCKERS

All four fixes are mobile-correct by reasoning. No new 360px page-level
x-overflow, no touch regression, reduced-motion honored on both peek carousels,
AA-neutral (no color/contrast changes), no hardcoded hex. The one item that
warrants an honest caveat is the PDF swipe — see the confidence call below; it is
NOT a blocker (the fix is correct and strictly additive, it either fixes the
gesture or leaves it exactly as-is), but I cannot certify it on-device from a
jsdom bench.

- BLOCKER: 0
- SHOULD-FIX: 0
- NIT: 2
- PRAISE: 4

---

## Per-fix 360px / real-touch reasoning

### 1. PDF swipe — `<img>` drag-source + iOS callout shutoff
Files: `UploadViewer.tsx:356-371` (the `<img>`: `className`, `draggable={false}`,
`onDragStart` veto), `UploadViewer.css:89-97` (`.km-upload-viewer__img`:
`-webkit-touch-callout/-webkit-user-drag/user-drag/user-select: none`).

DOM the finger lands on (verified): the gesture handlers are on
`.km-upload-viewer__page` (`UploadViewer.tsx:1042-1053`,
`onPointerDown/Move/Up/Cancel/Leave`). The `<img>` is nested two levels down
(`.km-upload-viewer__page` → `.km-upload-viewer__pageDrag` → `PageImage`'s
`<img>`, at `:1055-1071`) and at fit-zoom is `width:100%`, so the finger DOES land
on the `<img>`. Pointer events bubble, so a `pointerdown` on the image reaches the
parent handler — the architecture is sound.

Touch-action arbitration (already-present, still correct): the parent box carries
`touch-action: pan-y` when `swipeEligible` (`:1044`). Per the CSS Touch-Action
model the used gesture set is the intersection along the target→root ancestor
chain; the `<img>` is `auto` but the ancestor is `pan-y`, so horizontal is
reserved for JS regardless of the img being the hit-target. So the scroll/pan half
was never the gap — which is exactly the diff's own diagnosis.

Why the img fix is the right next lever: an `<img>` is (a) an implicit HTML5 drag
SOURCE (`draggable` defaults `true` for `img`/`a`) and (b) on iOS a long-press
"Save/Copy/Share" callout target AND an iOS drag-and-drop "lift" target. Both are a
SEPARATE browser subsystem from `touch-action`/`preventDefault` (which only govern
pan/scroll) — neither of those can stop the engine deciding a touch is "lifting the
image." The fix targets that subsystem at the correct element:
- `draggable={false}` + `onDragStart→preventDefault` — kills the HTML5 drag source
  (belt-and-braces; some engines historically ignored a bare `draggable` on nested
  content). Primarily a desktop-mouse + Android-Chrome image-drag defense.
- `-webkit-touch-callout: none` — the CORRECT iOS property to suppress the
  long-press callout and (with user-drag off) the iOS image-lift. This is the one
  that plausibly frees a real iOS swipe.
- `-webkit-user-drag: none` / `user-drag: none` — desktop-Safari/WebKit image drag.
- `user-select: none` — stops a drag ever seeding a selection marquee.

No residual gap on the element side: no ancestor is a drag source (a `<div>`
defaults `draggable:false`); the rotated 90/270 branch keeps the same class on its
absolutely-positioned `<img>` (`:398-399`, `pageLayout`), so covered there too.
Letterbox area above/below the image is a plain `<div>` (not a drag source), so
swipes that start off the bitmap also work.

Honest confidence: see the dedicated call below.

### 2. Carousel 1 → shared peek slider (matches Carousel 2)
Files: `Today.tsx:601-703` (Carousel 1 now `.km-today__peek{Outer,Track,Item}`),
`Today.css:200-298` (shared mechanism).

At 360px: identical mechanism to Carousel 2 — `flex: 0 0 78%`, `max-width:78%`,
`scroll-snap-align:center`, track `overflow-x:auto` + `scroll-snap-type:x
mandatory` + `scroll-padding-inline:11%` + `padding:4px 11% 10px`
(`Today.css:230-263`). 78% center tile + 11% peek each side = partial neighbors
visible → peek confirmed. Scroll is native (zero JS gesture code), so tap-vs-scroll
is the browser's own disambiguation — clean by construction, no hand-rolled
threshold to get wrong. `scroll-snap-stop: always` (`:262`) enforces one-tile-per-
fling ("spin table" feel), matching Carousel 2 exactly.

Page-overflow: the track's overflow is internal (`overflow-x:auto`), so the row
scrolls within its own box, not the page. `.km-today__peekOuter { margin:0 -2px }`
(`:227`) bleeds 2px each side — but that is (a) identical to what Carousel 2
already shipped and (b) clipped by the `.km-shell__scroll { overflow-x:hidden }`
backstop (`index.css:1022`, confirmed present). No NEW page-level x-scroll. Both
carousels are now byte-identical in mechanism → they behave identically, as the
user asked.

Height variance note (non-issue): Carousel 1's first item swaps
Skeleton/ActivityTile/PlanErrorCard of differing heights, but `.km-today__peekTrack`
is `display:flex` with default `align-items:stretch`, so items equalize to the
tallest — no ragged overflow. Same pattern Carousel 2 already relies on.

### 3. SkillsCompare TOPIK pills — do all 7 fit 360px?
Files: `SkillsCompare.tsx:80-101` (`shortRefLabel`/`fullRefName`), `:169-194`
(visible `<span aria-hidden>` short code + full name on `aria-label`/`title`),
base pill style `index.css:2030-2042`, mobile stack `SkillsCompare.css:78-83`.

Computed fit (pills: `T1…T6` = 2 chars, `Native` = 6 chars; base `.km-skillscompare__pick`
= `padding:5px 9px` → 18px h-pad, `font:11px/600`, `letter-spacing:0.04em`):
- `T1..T6`: ~13-16px text + 18px pad ≈ 31-34px each → 6 × ≈ 192-204px
- `Native`: ~33-48px text + 18px pad ≈ 51-66px
- Picker chrome: 2px pad ×2 + 1px border ×2 = 6px
- **Total ≈ 249-276px.** The picker `<480px` stacks below the eyebrow
  (`SkillsCompare.css:78-83`) so it gets the FULL card width (~320-328px inside a
  360px viewport). **~276px << ~320px → all 7 fit with headroom; the scroll rail
  never engages.** Confirmed: pills fit without scrolling at 360px.

Row does not overflow the page: even in the (non-triggered) overflow case, the
excess is absorbed by the picker's own `overflow-x:auto` internal rail
(`SkillsCompare.css:46-55`), which is the dormant fallback — harmless when idle
(desktop already fit, so it never showed there either). Consumers are Progress.tsx
and Diagnostic.tsx — both mobile surfaces — so this matters and is handled.

A11y is preserved, not degraded: visible short code is `aria-hidden`, and the full
`kr · en` name rides `aria-label` + `title` (`SkillsCompare.tsx:186-192`), so SR
users and hover-tooltip users keep the unabbreviated name. Radio semantics intact.

### 4. Grammar tab removed from Library subnav
Files: `LibrarySubnav.tsx:35-38` (`SECTION_IDS` now 2 ids).

Pure nav-item removal: `review-grammar` dropped from the strip; `/review/grammar`
(`ReviewGrammar.tsx`) never rendered this component (it carries its own BackButton),
so nothing is orphaned — Grammar stays reachable via the Library index. Mobile
layout impact of 3→2 tabs: the strip is a flex row; fewer items = MORE room, never
less → strictly safer at 360px, no overflow risk introduced. Fine.

---

## Findings

### NIT-1 — `shortRefLabel` abbreviation depends on the server label being exactly `"TOPIK N"`
`SkillsCompare.tsx:88` regex `/^TOPIK\s+(\d+)$/i`. Labels come from server
`snap.references` (`Progress.tsx:224-233`) / Diagnostic. If a future label drifts to
`"TOPIK Level 4"` or `"TOPIK4"`, the regex misses and the pill falls back to the
FULL label. That is a safe, self-healing degradation (full label + the dormant
scroll rail keeps every pill reachable), so it is genuinely a NIT — but worth a
one-line note so a future label change isn't a surprise. No action required now.

### NIT-2 — `-webkit-user-drag` / `user-drag` are non-standard and unknown-property on some engines
`UploadViewer.css:91-92`. Harmless (ignored where unsupported; the standard
`draggable={false}` + `onDragStart` veto carry the load), and the code comment
already frames them as belt-and-braces. Flagging only for completeness — no change.

### PRAISE
- The diff's root-cause reasoning (touch-action governs pan/scroll; image
  drag/callout is a distinct subsystem the earlier trio couldn't reach) is
  exactly right and unusually well-documented in-code.
- Carousel 1 was converted by REUSING Carousel 2's classes rather than duplicating
  the geometry — the two are now provably identical, which is what the user asked
  for and eliminates drift.
- Short-pill fix keeps the full label on `aria-label`/`title` — the accessible name
  did not regress while the visible row got smaller. Correct a11y instinct.
- Grammar-tab removal correctly verified that `/review/grammar` doesn't depend on
  the subnav, so nothing is orphaned.

---

## Cross-cutting mobile safety

- **New 360px page x-overflow?** None. Carousel 1's only bleed is the pre-existing
  `-2px` outer margin (same as Carousel 2), clipped by `.km-shell__scroll
  overflow-x:hidden`. SkillsCompare row fits and otherwise self-contains its
  overflow. Subnav got narrower content.
- **Touch regression?** None. Carousel 1 moved from a hand-rolled pointer engine to
  native scroll-snap (strictly fewer ways to get touch wrong). PDF change is
  additive to the img only. No handler was moved off a working node.
- **Reduced-motion?** Honored for BOTH peek carousels: they share
  `.km-today__peekItem`, and `@media (prefers-reduced-motion: reduce){
  .km-today__peekItem{animation:none} }` (`Today.css:294-298`) sits after the
  `@supports(animation-timeline:view())` pop block (`:275-292`) at equal
  specificity, so it wins by source order. Unsupported browsers just render a flat,
  fully-legible row.
- **AA / hex:** no color or contrast surface changed; grep of the three changed CSS
  files finds no hardcoded hex.

---

## HONEST CONFIDENCE CALL — will the PDF swipe actually work on-device this time?

**~65%** that this round fully fixes the horizontal swipe on a real phone.

Why not higher:
- Every property in the fix is CORRECT and targets the right subsystem, and the fix
  is strictly additive — worst case it changes nothing, it cannot make the gesture
  worse. That is why it is not a blocker.
- On **iOS Safari** specifically, `-webkit-touch-callout:none` (+ user-drag off) is
  the genuinely-plausible unblocker: iOS image-lift / long-press is the classic
  thing that eats a drag on an `<img>` when `touch-action` is already correct. If
  the on-device failure was iOS image-lift, this fixes it. Confidence there is
  higher, ~70%.
- On **Android Chrome**, `draggable={false}` kills the HTML5 image drag, but a
  *fast* horizontal flick rarely triggers Android's drag (that's usually a
  long-press-then-drag). So if Android was the failing platform and the culprit was
  something OTHER than image-drag, this fix may not move it.

The residual 35% risk is that the true blocker on the specific failing device was
NOT the image-drag/callout subsystem — e.g. a passive-listener / pointer-capture
timing issue, the `.km-upload-viewer__pageDrag` transform interacting with the
gesture, or an axis-lock threshold (`SWIPE_AXIS_LOCK_PX=8`) that a slow real thumb
never crosses cleanly. jsdom cannot exercise any of these, so I cannot certify the
gesture end-to-end from this bench.

**Recommendation:** ship it (additive + correct), but the FIRST post-deploy check on
the actual phone must be: open a multi-page PDF and confirm a horizontal thumb-swipe
turns the page on BOTH an iPhone (Safari) and an Android (Chrome). If it still fails
on Android, the next probe is pointer-capture/axis-lock, not more image properties.

## MOBILE-SAFE TO REDEPLOY? — YES.
Zero blockers, zero touch regressions, zero new 360px overflow. The one unverifiable
item (PDF on-device) is additive and needs a 60-second manual phone check post-deploy,
not a code change.
