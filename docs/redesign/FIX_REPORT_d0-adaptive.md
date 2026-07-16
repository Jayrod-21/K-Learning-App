# Fix Report — Phase D0, device-adaptive shell foundation

Independent fix-pass against `docs/redesign/REVIEW_d0-adaptive.md` (1 BLOCKER,
3 SHOULD-FIX, 3 NIT). All addressed. PRAISE items (mobile-unchanged claim
verification, the shared `matchMedia` test default, `useDeviceClass`'s
shape) were left untouched.

## BLOCKER-1 — `.km-shell` doesn't fill the flex row / Sidebar doesn't pin left

**Disposition: FIXED.** `client/src/styles/index.css`:

- `.km-shell`'s `@media (min-width: 768px)` override now adds
  `flex: 1 1 auto; min-width: 0;` alongside the existing `max-width:
  var(--shell-desktop-max-width)`. `.km-shell` is now the row's only
  flex-grow item, so it claims all space left over after `Sidebar`'s fixed
  width, clamped by its own max-width cap — the "wider content column"
  deliverable is no longer a no-op. `min-width: 0` overrides the flex-item
  default `min-width: auto`, which would otherwise floor the item at its
  content's min-content width (a real risk with wide inline content at
  narrower tablet widths).
- `.km-appframe`'s `@media (min-width: 768px)` override changes
  `justify-content: center` → `justify-content: flex-start` (made
  explicit rather than left as the implicit default). Reasoning: even
  with the flex-grow fix, per CSS Flexbox §8.1 any leftover free space
  beyond `.km-shell`'s max-width cap is offered to `.km-shell`'s own
  pre-existing `margin: 0 auto` BEFORE `justify-content` ever sees it — so
  in practice `justify-content` becomes a no-op once `flex-grow` is
  correctly set. Left at `center` it would have been harmless MOST of the
  time, but that safety depends on `.km-shell` never losing its
  `margin: auto`, which is a subtle, easy-to-break invariant for a future
  editor to rely on unknowingly. Setting it to `flex-start` explicitly
  removes the dependency: `Sidebar` (fixed width, `flex-shrink: 0`) is
  pinned to the row's start (the true viewport left edge) unconditionally,
  and `.km-shell`'s own `margin: 0 auto` is the sole, explicit owner of
  centering ITS box within the remaining track. Both changes are
  documented in-place with a fuller flexbox trace (see the CSS comments
  immediately above each rule).

Test added (`Shell.deviceAdaptive.test.tsx`, describe
`'.km-appframe / .km-shell flex layout (fix-pass: BLOCKER-1)'`): two
CSS-source-text assertions (matching the codebase's existing
`fontSizeUnits.test.ts`/`tokensContrast.test.ts` convention for
layout/token regressions jsdom cannot observe via real layout) confirming
`.km-shell`'s desktop block carries `flex: 1 1 auto; min-width: 0;` and
`.km-appframe`'s desktop block carries `justify-content: flex-start`. This
is a config-presence guard, not a pixel-layout guard — see "Visual
verification" below for why real layout couldn't be screenshot-verified
here.

## SHOULD-FIX-1 — `LearnMenu` moved from sibling → descendant of `.km-shell`

**Disposition: FIXED — restored as a sibling.** `client/src/components/Shell.tsx`:
moved the `learnPhase !== 'closed' ? <LearnMenu .../> : null` block out of
`.km-shell`'s JSX subtree and rendered it as a direct sibling of the
`.km-shell` `<div>`, both children of `.km-appframe` — this matches the
exact pre-D0 DOM shape (previously both were direct children of
`ExamActiveProvider`; `.km-appframe`'s `display: contents` keeps it
invisible to the box tree below 768px, so nothing about mobile's rendered
tree changed as a result of this fix). Updated `Shell.tsx`'s header comment
to state the sibling relationship and why it matters (`.km-learnmenu` is
`position: fixed; inset: 0` and must never risk being trapped inside a
future transformed/filtered `.km-shell`).

Test added (`Shell.deviceAdaptive.test.tsx`, describe `'Shell — LearnMenu
DOM position (fix-pass: restored pre-D0 sibling relationship)'`): opens the
LEARN hexagon, then asserts `.km-shell` does not `.contains()`
`.km-learnmenu` and that both share the same `parentElement`.

## SHOULD-FIX-2 — Sidebar chat action doesn't honor the `/settings` quiet zone

**Disposition: FIXED.** `client/src/components/Sidebar.tsx`: added a local
`isSettingsPath()` helper (segment-boundary prefix match, mirroring
`ChatFab.isHiddenPath`'s shape) and gated the chat button on
`!examActive && !isSettingsPath(location.pathname)`. Deliberately scoped to
`/settings` only — Sidebar's chat entry still stays visible on `/chat`
(documented as a considered difference, not an oversight: a persistent rail
entry isn't a floating dot sitting on top of the page a user is already
chatting from). Doc comment updated to state both the new `/settings`
parity and the `/chat` divergence explicitly.

Tests added (`Sidebar.test.tsx`, describe `'Sidebar — /settings quiet zone
(mirrors ChatFab)'`): hides on `/settings`, hides on a `/settings/*`
sub-route, stays visible on `/chat`, and a `/settingsomething` sibling path
is NOT falsely caught by the prefix match.

## SHOULD-FIX-3 — `useDeviceClass.ts` overclaims a tablet/desktop CSS distinction

**Disposition: FIXED.** `client/src/hooks/useDeviceClass.ts`: rewrote the
`'desktop'` bucket's doc comment to state plainly that 'tablet' and
'desktop' are NOT visually distinguished yet in D0 — the wider content cap
applies at the SAME `@media (min-width: 768px)` breakpoint that mounts the
sidebar — and that the three-bucket split exists so a later phase can
introduce a real 1024px-gated rule without another hook change.

## NIT-1 — `.km-sidebar__group` has no `role="group"`

**Disposition: FIXED (trivial).** Added `role="group"` to the `<div
aria-labelledby={LEARN_HEADING_ID}>` in `Sidebar.tsx`.

## NIT-2 — `BottomNav` and `Sidebar` share the same `aria-label`

**Disposition: FIXED (trivial).** `Sidebar.tsx`'s `<nav>` now uses
`aria-label="Primary navigation, sidebar"` (distinct from `BottomNav`'s
`"Primary navigation"`), with a comment explaining why. Updated the one
existing assertion in `Sidebar.test.tsx` that checked the old label;
`BottomNav.test.tsx` and the mobile-chrome assertion in
`Shell.deviceAdaptive.test.tsx` were unaffected (they check `BottomNav`'s
landmark, which is untouched).

## NIT-3 — `Shell.test.tsx`'s implicit `matchMedia` coupling undocumented

**Disposition: FIXED (trivial).** Added a paragraph to `Shell.test.tsx`'s
file header documenting that its ~19 `hexButton()`-based assertions now
implicitly depend on `test/setup.ts`'s `matches: false` default (and that
`mockReducedMotion()`'s own stub also resolves to `'mobile'` for the
device-class queries), pointing at `Shell.deviceAdaptive.test.tsx` for the
Sidebar-chrome coverage this file intentionally doesn't duplicate.

## Visual verification

No headless browser is available in this sandbox: `npx playwright
--version` failed (package not installed, auto-install declined
non-interactively), no `puppeteer` package under `node_modules`, and no
system `chromium`/`google-chrome`/`chromium-browser` binary. Per the task's
fallback instruction, no further effort was spent wiring one up.

**The flex layout fix is reasoned-but-NOT-screenshot-verified.** The
reasoning is laid out in full above and in the CSS comments in
`client/src/styles/index.css` (the `.km-appframe`/`.km-shell` `@media
(min-width: 768px)` blocks): `flex: 1 1 auto` + `min-width: 0` on
`.km-shell` makes it the row's sole growable item (claims remaining space
up to its max-width cap, where the original diff left it sized to its own
content); `justify-content: flex-start` on `.km-appframe` makes Sidebar's
left-edge pin explicit and independent of `.km-shell`'s own auto-margin
behavior. A real screenshot pass (desktop viewport, e.g. 1440×900) is
recommended as a follow-up the orchestrator can get via another channel.

## Gate results (exact)

- **Client lint:** `npx eslint .` — 0 problems.
- **tsc:** `npx tsc -b --noEmit` — 0 errors.
- **vitest, targeted (7 files touched/added by this fix-pass):**
  `Shell.test.tsx`, `Shell.deviceAdaptive.test.tsx`, `Sidebar.test.tsx`,
  `BottomNav.test.tsx`, `useDeviceClass.test.tsx`, `fontSizeUnits.test.ts` —
  6 files / 78 tests, all pass.
- **vitest, full suite:** `npx vitest run` — 120 files / 1997 tests, all
  pass (1990 baseline + 7 new: 4 in `Sidebar.test.tsx`'s `/settings` quiet
  zone, 1 DOM-sibling test + 2 CSS-presence tests in
  `Shell.deviceAdaptive.test.tsx`).
- **Build:** `npx vite build --outDir /tmp/km-d0fix` — exit 0. (Pre-existing
  "chunks larger than 500 kB" warning is unrelated to this fix-pass — no
  new imports were added.)

## Self-assessment

All 1 BLOCKER + 3 SHOULD-FIX are directly fixed at the root cause (CSS
flexbox properties, DOM nesting, path-hide parity, doc accuracy), not
patched around. Both NITs that were trivial in-file were also fixed. Every
fix has an assertable regression test added in this same commit, using the
codebase's own established conventions (CSS-source-text assertions for
layout/config the test environment can't otherwise observe; DOM
containment checks for structural relationships; `/settings`-prefix
matching mirroring `ChatFab`'s existing pattern). The one residual gap,
called out honestly rather than glossed over, is that the flex fix has not
been visually screenshotted in a real browser — the reasoning is sound and
spec-grounded (CSS Flexbox §8.1/§9.7 auto-margin-vs-justify-content
ordering, explicitly reasoned through rather than assumed), but a
senior-engineer sign-off on a pure-CSS layout bug ultimately wants a real
render, and this sandbox cannot provide one.
