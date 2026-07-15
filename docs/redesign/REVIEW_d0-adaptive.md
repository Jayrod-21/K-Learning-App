# Review — Phase D0, device-adaptive shell foundation

Reviewed: `hooks/useDeviceClass.ts(+test)`, `components/Sidebar.tsx(+test)`,
`components/Shell.tsx`, `components/Shell.deviceAdaptive.test.tsx`,
`components/BottomNav.tsx`, `lib/nav.ts`, `styles/index.css`, `test/setup.ts`.
Diff base: `rebuild` → `d4cb091` on `worktree-agent-ab936ece4ae52cb06`.

Verification performed beyond static reading: full client test suite run
(`npx vitest run` — 120 files / 1990 tests, all pass), targeted re-run of the
5 files touched by this phase (64/64 pass), `tsc -b --noEmit` (clean), and a
manual CSS-flexbox trace of the new `.km-appframe`/`.km-shell`/`.km-sidebar`
layout (no headless browser was available in this sandbox to screenshot it —
see BLOCKER-1 for why static tracing is nonetheless conclusive here).

## Summary verdict: REQUEST CHANGES

One BLOCKER, all in CSS, not JS/TS logic: `.km-shell` has no `flex-grow` /
`flex-basis` / explicit width, so in the new `.km-appframe` flex row at
≥768px it will size to its own content's natural width rather than
stretching to fill the space up to the new `--shell-desktop-max-width`
(1160px) cap — the headline "wider, centered content column with the
sidebar offset correctly" deliverable of this phase is very likely a visual
no-op today, and the persistent Sidebar will likely float centered in the
middle of a wide viewport rather than sitting pinned to the left edge. This
is untestable by the current suite (happy-dom performs no real layout) and
is exactly the kind of thing a senior reviewer would refuse to sign off —
see BLOCKER-1 for the full trace and the one-line fix.

Everything else checked out well. **Mobile is behaviorally unchanged**: the
`learnPhase` state machine (safety timeout, route-change-close, reduced-motion
bypass) is textually untouched, `BottomNav`'s active-tab logic is a verified
no-op refactor onto a shared matcher, and the new `test/setup.ts` global
`matchMedia` default is sound — verified it doesn't mask any prior coverage
(it's *protective*, not masking: it stops 19+ pre-existing `Shell.test.tsx`
assertions from silently breaking now that `Shell` calls `useDeviceClass()`).
The one real gap on mobile is a DOM-nesting change to where `LearnMenu`
mounts (SHOULD-FIX-1) — currently harmless in practice, but it contradicts
the PR's own "byte-equivalent" claim and introduces latent fragility.

Routes/labels in `Sidebar` are the real `lib/nav.ts` manifest (verified
against `NAV_ITEMS` directly) — no hardcoded/wrong paths. Keyboard nav,
focus-visible, `aria-current`, and the shared longest-prefix matcher are all
correct.

## Findings

### BLOCKER

1. **`.km-shell` does not fill the flex row at ≥768px — the tablet/desktop
   wide-content deliverable is very likely a no-op, and the Sidebar will
   likely not be pinned to the left edge.** `styles/index.css` — `.km-appframe`
   becomes `display: flex; justify-content: center;` at `@media (min-width:
   768px)` (around line 1009), with `Sidebar` (fixed `width: var(--sidebar-w)`,
   `flex-shrink: 0` — line ~1069) and `.km-shell` as its two row children.
   `.km-shell`'s own `@media (min-width: 768px)` override (line ~1139) sets
   only `max-width: var(--shell-desktop-max-width)` and clears the borders —
   it sets no `flex-grow`, no `flex-basis`, no `width`. Per the CSS Flexbox
   spec, a flex item with `flex-basis: auto` (the initial value) and no
   definite `width` resolves its flex-basis to the item's own *content* size
   (max-content), and with the initial `flex-grow: 0` it will **not** stretch
   to absorb the row's remaining free space. Concretely: `.km-shell` will
   render at whatever width its own descendants naturally want (bounded above
   by the new 1160px cap, but very unlikely to reach it for pages designed
   mobile-first around ~480px), not at the cap itself. Two visible
   consequences: (a) most pages will keep rendering close to their current
   narrow width even at wide viewports — the whole point of raising
   `--shell-desktop-max-width` doesn't show up until some other change forces
   wider content; (b) `justify-content: center` then centers the
   **sidebar+shell pair as a unit** in the viewport, so the persistent left
   rail will float in the middle of a wide monitor with dead space to its
   own left, rather than being pinned to the real left edge — the opposite of
   the intended "persistent left sidebar" pattern.

   This is invisible to the current test suite by construction — happy-dom
   does not perform real box-model layout, so `Sidebar.test.tsx` and
   `Shell.deviceAdaptive.test.tsx`'s `getByText`/`getByRole` assertions all
   pass regardless of computed pixel widths (confirmed: ran the full 1990-test
   suite, all green). This needs an actual screenshot pass in the /fixpass or
   `/verify` step, not just unit tests.

   **Fix**: give `.km-shell` `flex: 1 1 auto;` (or `flex-grow: 1; min-width:
   0;`) inside the `@media (min-width: 768px)` block, so it claims the row's
   remaining space up to its `max-width` cap, with the Sidebar staying pinned
   left via its own `flex-shrink: 0` + fixed width.

### SHOULD-FIX

1. **`LearnMenu` moved from a DOM sibling of `.km-shell` to a descendant
   nested inside it — contradicts the PR's "byte-equivalent" mobile claim,
   and introduces latent fragility, though no visible regression today.**
   `components/Shell.tsx:181-211` (compare against the diff's `-`/`+` lines).
   Before this PR, `LearnMenu` was a direct sibling of the `.km-shell` div
   (both children of whatever renders `<Shell/>`, since neither
   `ExamActiveProvider` nor `React.Context.Provider` generate a DOM node).
   After this PR, at mobile widths (`sidebarLayout === false`), `LearnMenu` is
   rendered *inside* `.km-shell`, one level deeper, inside the new fragment
   alongside `.km-shell__nav`. The PR's own doc comments (Shell.tsx:37-40,
   the CSS comment at `styles/index.css` ~line 1003) claim "mobile's rendered
   box tree is unaffected" — that's not accurate; the tree genuinely changed
   shape. I verified this is currently harmless: `.km-learnmenu` is
   `position: fixed; inset: 0;` (`styles/index.css:1442`), and `.km-shell`
   sets no `transform`/`filter`/`perspective`/`contain`/`will-change`
   anywhere (grepped the full stylesheet), so it does not establish a new
   containing block for the fixed-positioned overlay — `LearnMenu` still
   positions against the real viewport exactly as before, regardless of DOM
   depth. But the invariant that used to hold ("LearnMenu can never be
   affected by anything that happens to `.km-shell`'s box model") no longer
   holds: a future, entirely unrelated change that adds `transform`/`filter`/
   `will-change` to `.km-shell` (a common thing to reach for — a scroll-snap
   hint, a hardware-acceleration nudge, an entrance animation) would silently
   trap `LearnMenu` inside `.km-shell`'s box instead of the viewport,
   breaking the honeycomb overlay with no warning from this PR's tests.
   Recommend either fixing the doc comment to stop claiming byte-equivalence,
   or (stronger) keeping `LearnMenu` as a true sibling of `.km-appframe`
   rather than nesting it inside `.km-shell`, which would fully restore the
   old invariant at zero cost.

2. **`Sidebar`'s chat action doesn't honor the `/settings` "quiet zone" that
   `ChatFab` enforces on mobile.** `components/ChatFab.tsx:32` hides the FAB
   on `/chat` AND `/settings` — its own doc comment (`ChatFab.tsx:14`) calls
   the settings hide "deliberate...per the design," framing it as product
   policy, not FAB-specific chrome. `components/Sidebar.tsx:633` only hides
   the chat rail entry on `examActive`; it stays visible and clickable on
   `/settings` (and on `/chat`, which Sidebar's own doc comment at line
   496-499 explicitly and reasonably justifies keeping visible — a
   persistent rail entry isn't a floating FAB, so "chat button on the chat
   page is noise" doesn't obviously carry over). The `/settings` quiet zone
   is the one that looks like an unintentional drop rather than a considered
   difference. Recommend confirming intent; if the quiet zone is meant to be
   universal, Sidebar should hide the same way on `/settings`.

3. **`useDeviceClass.ts`'s doc comment overclaims a tablet/desktop CSS
   distinction that doesn't exist yet.** `hooks/useDeviceClass.ts:10-13`
   describes `'desktop'` (≥1024px) as the bucket where "the content column's
   max-width grows," implying `'tablet'` (768-1023px) does not get it. But
   the actual CSS (`styles/index.css`, the `@media (min-width: 768px)` block
   wrapping `.km-shell`) applies the SAME `--shell-desktop-max-width` cap
   starting at the tablet breakpoint (768px) — there is no second media query
   gated on `DESKTOP_MIN_WIDTH`/1024px anywhere in this diff. Low severity —
   the review's own acceptance bar groups "tablet/desktop" together for D0 —
   but the comment should say so rather than implying a distinction that
   isn't implemented, so a future reader doesn't go looking for a 1024px CSS
   rule that was never written.

### NIT

1. `components/Sidebar.tsx` (~line 620): `.km-sidebar__group` is a bare
   `<div aria-labelledby={LEARN_HEADING_ID}>` with no `role="group"`. A
   role-less (`generic`) element's `aria-labelledby` isn't reliably surfaced
   by all screen readers as a distinct navigable group. Low severity — the
   adjacent real `<h2>` already gives heading-navigation users a landmark for
   "Learn" — but `role="group"` would make the relationship robust rather
   than decorative.
2. `BottomNav.tsx:131` and `Sidebar.tsx:603` both render `<nav
   aria-label="Primary navigation">`. Harmless today since `Shell` mounts
   them mutually exclusively, but if the two were ever rendered
   simultaneously (a debug/preview toggle, a transitional breakpoint state)
   two identically-named `navigation` landmarks would be indistinguishable
   by landmark-navigation. Worth a distinct label if that ever becomes
   possible.
3. `components/Shell.test.tsx`'s ~19 pre-existing `hexButton()`-based
   assertions now implicitly rely on `test/setup.ts`'s new `matches: false`
   default to keep resolving `deviceClass` to `'mobile'` — before this PR
   they had no dependency on `matchMedia` at all. Not a bug (verified sound —
   see PRAISE-1), but a one-line comment in `Shell.test.tsx` noting the new
   coupling would save a future engineer touching `setup.ts`'s default from
   unknowingly breaking 19 assertions in a file they never opened.

### PRAISE

1. **The `test/setup.ts` global `matchMedia` default is sound and does NOT
   mask any real coverage** — this was the sharpest risk called out in the
   review brief, and it holds up under scrutiny. It's deliberately
   `matches: false` (the mobile-first "nothing matches" safe default,
   consistent with every other matchMedia-driven feature's off-state), set
   in a `beforeEach` (not a load-time stub) specifically so a test file's own
   explicit override reliably wins for its own tests (Vitest fires
   outer/earlier-registered `beforeEach` hooks first). Independently
   verified: (a) full client suite — 120 files / 1990 tests — passes; (b)
   every pre-existing `matchMedia` consumer (`InstallPrompt.tsx`,
   `ThemeProvider.tsx`, `Chat.tsx`, `Shell.tsx`'s reduced-motion check)
   already fully self-stubs `matchMedia` for every test in its own file,
   confirmed line-by-line; (c) nothing in the existing suite relied on
   happy-dom's real, unstubbed (desktop-sized) `matchMedia` default, because
   no production code queried `min-width` before this PR — `useDeviceClass`
   is the first. The change is *protective*, not coverage-masking: it's what
   stops `Shell.test.tsx`'s ~19 existing assertions from silently flipping to
   render `Sidebar` instead of `BottomNav` now that `Shell` calls
   `useDeviceClass()`, which would otherwise happen because happy-dom's own
   internal viewport defaults to a desktop-ish 1024×768.
2. `matchActiveNavId` extraction (`lib/nav.ts:404-423`) is a clean,
   well-justified dedup — diffing `BottomNav`'s old inline matcher against
   the new shared function shows the logic is textually identical modulo
   generic parameterization, so this is a verified zero-behavior-change
   refactor, and it's what lets `Sidebar` agree with `BottomNav` on "you are
   here" by construction instead of by discipline.
3. `useDeviceClass`'s SSR/first-paint handling (`getServerSnapshot` returning
   a constant `'mobile'`, graceful degrade to `'mobile'` when `matchMedia` is
   absent entirely) correctly mirrors the codebase's existing external-store
   hook conventions (`ThemeProvider`, `useKeyboardOpen`) and both paths are
   directly tested.
4. Reduced-motion handling for the new Sidebar hover/active-state
   transitions required zero new code — the existing global `@media
   (prefers-reduced-motion: reduce) { *, *::before, *::after {...} }` blanket
   rule (`styles/index.css:701`) already neutralizes `.km-sidebar__link`'s
   `160ms` transitions, and the builder correctly relied on it instead of
   writing a redundant override.
5. Every routed id `Sidebar` renders (`today`, `progress`, all 7
   `LEARN_SUBPAGE_IDS`, `review`, `settings`) is a real `lib/nav.ts` manifest
   entry with the real path/label/kr — verified directly against `NAV_ITEMS`
   (`lib/nav.ts:75-300`), not hardcoded or guessed.

## Detailed findings (file:line reference index)

- BLOCKER-1: `client/src/styles/index.css` ~1009 (`.km-appframe` flex row),
  ~1139-1150 (`.km-shell`'s `@media (min-width: 768px)` override, missing
  `flex-grow`), ~1065-1080 (`.km-sidebar`'s `flex-shrink: 0` + fixed width,
  for contrast).
- SHOULD-FIX-1: `client/src/components/Shell.tsx:181-211` (new JSX
  structure) vs. the PR diff's removed lines (old structure); doc claim at
  `Shell.tsx:37-40`; `.km-learnmenu` position at
  `client/src/styles/index.css:1442-1443`.
- SHOULD-FIX-2: `client/src/components/ChatFab.tsx:14,32` (mobile hide
  rule) vs. `client/src/components/Sidebar.tsx:633` (sidebar hide rule).
- SHOULD-FIX-3: `client/src/hooks/useDeviceClass.ts:10-13` vs.
  `client/src/styles/index.css:1139-1150`.
- NIT-1: `client/src/components/Sidebar.tsx` ~616-626 (`.km-sidebar__group`).
- NIT-2: `client/src/components/BottomNav.tsx:131`,
  `client/src/components/Sidebar.tsx:603`.
- NIT-3: `client/src/components/Shell.test.tsx` (whole file, no local
  matchMedia stub outside `mockReducedMotion()`).
- PRAISE-1: `client/src/test/setup.ts:1210-1224`;
  cross-checked against `client/src/components/InstallPrompt.test.tsx:50-53`,
  `client/src/hooks/ThemeProvider.test.tsx:49-60`,
  `client/src/pages/Chat.test.tsx:833-840`,
  `client/src/components/Shell.test.tsx:83-97,226`.
- PRAISE-2: `client/src/lib/nav.ts:404-423` vs. the diff's removed
  `matchActiveId` body in `client/src/components/BottomNav.tsx`.
- PRAISE-5: `client/src/lib/nav.ts:75-300` (`NAV_ITEMS`) vs.
  `client/src/components/Sidebar.tsx:535-541` (`SIDEBAR_ROUTE_IDS`).
