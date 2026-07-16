# Re-Review — Phase D0 fix-pass verification (device-adaptive shell foundation)

Independent re-review of `docs/redesign/FIX_REPORT_d0-adaptive.md` against
`docs/redesign/REVIEW_d0-adaptive.md`'s findings. Verified against
`git diff rebuild -- client/` (full phase) and `git diff d4cb091 29bd397`
(the fix-pass commit alone), plus direct file reads and a fresh run of all
four gates. No test-only verification was used for the layout claim — CSS
was traced by hand against the Flexbox spec, per the task's instruction,
since jsdom cannot render real layout.

## Summary verdict: **PASS WITH CONDITIONS**

All 1 BLOCKER + 3 SHOULD-FIX + 3 NIT items are fixed at the root cause, each
backed by a real regression test (or, for the BLOCKER, a CSS-source-text
guard — the strongest thing possible without a real browser). No
regressions found: mobile behavior is unchanged, the `matchMedia` default
is still protective, and all PRAISE items remain intact and untouched. The
one condition: the desktop flex layout fix is **spec-correct by careful
hand-trace, not yet screenshot-verified in a real browser** — ship is fine,
but get a real 1440×900 screenshot before calling D0 visually done.

## Findings

### BLOCKER-1 — `.km-shell` doesn't fill the flex row / Sidebar doesn't pin left

**Status: FIXED (verified by independent spec trace, screenshot-pending).**

Confirmed in `client/src/styles/index.css`:
- `.km-appframe` at `@media (min-width: 768px)`: `display: flex;
  justify-content: flex-start;` (line ~1120-1127) — changed from the
  original `justify-content: center`.
- `.km-shell` at the same breakpoint (line ~1174-1180): `max-width:
  var(--shell-desktop-max-width); flex: 1 1 auto; min-width: 0;` — the
  base rule's `margin: 0 auto` (line 1136) is untouched and NOT cleared by
  the override, so it still applies at ≥768px.
- `.km-sidebar` (line ~1221-1226): `flex-shrink: 0; width: var(--sidebar-w);`
  — a fixed width, no `flex-grow` (so it defaults to `0`), confirmed
  unchanged by this fix-pass.

Independent flexbox walk (done without reading the fix report's own
reasoning first, then cross-checked against it):

1. Flex-basis resolution: Sidebar's basis = its fixed width (definite).
   `.km-shell`'s basis = `auto` → resolves to its own content
   (max-content), same starting point the original BLOCKER identified.
2. Free-space distribution: Sidebar has `flex-grow: 0` (frozen at its
   basis); `.km-shell` has `flex-grow: 1` — it is the row's only flexible
   item, so 100% of the row's free space is offered to it. This is the fix:
   in the pre-fix code `.km-shell` had no `flex-grow` at all (initial value
   `0`), so it never received any of this space and sat at max-content
   width regardless of viewport size — exactly BLOCKER-1's diagnosis.
3. Clamp: `.km-shell`'s grown size is capped by `max-width:
   var(--shell-desktop-max-width)`. On a wide viewport this clamp binds
   before the item would otherwise consume the entire remaining track, so
   there is leftover free space in the flex line *after* Sidebar + the
   capped `.km-shell`.
4. That leftover space is absorbed in one of two ways, and — importantly —
   **both independently pin Sidebar to the left edge**:
   - Per CSS Flexbox §8.1, positive free space is offered to a flex item's
     own auto margins *before* `justify-content` is evaluated. `.km-shell`
     is the only item here with `margin: 0 auto` (auto left+right), so all
     leftover space is absorbed into `.km-shell`'s own left/right margins,
     split evenly — this centers `.km-shell`'s box *within its own track*
     (the space to the right of Sidebar), not the [Sidebar, shell] pair as
     a unit. Sidebar itself never enters this margin calculation, so it
     stays exactly where its frozen basis placed it: flush against the
     row's start.
   - Even hypothetically ignoring the auto-margin step, `justify-content:
     flex-start` packs the two items against the row's start edge and
     pushes any undistributed leftover space to the end of the line — which
     again leaves Sidebar pinned at the true start, not centered as a unit
     with `.km-shell`.
   Both mechanisms agree, which is a meaningful strengthening over the
   original diagnosis: even if a future edit removed `.km-shell`'s
   `margin: 0 auto`, the explicit `flex-start` alone still keeps Sidebar
   pinned left. This is genuine defense-in-depth, not redundant belt-and-
   suspenders.
5. `min-width: 0` correctly overrides the flex-item default `min-width:
   auto`, which would otherwise floor `.km-shell` at its content's
   min-content width and could force horizontal overflow on a narrower
   tablet viewport with wide inline content (a real, if secondary, risk the
   fix report called out and actually addressed rather than hand-waved).

**Independent verdict: yes — by CSS spec, `.km-shell` will widen to fill
the remaining row space up to the `--shell-desktop-max-width` cap (instead
of sizing to its own content as before), and `Sidebar` will pin to the true
left edge of the viewport, not float centered with the content column as a
unit.** This is a correct, root-cause fix, not a workaround. It is,
however, still **reasoned from the spec, not observed in a real
compositor** — no headless browser was available in this environment
either (confirmed: no `playwright`/`puppeteer` in `node_modules`, no system
Chromium binary). A real screenshot at a desktop viewport (e.g. 1440×900,
checking Sidebar flush-left with no dead space to its own left, and the
content column visibly wider than the old ~480-720px mobile-first cap) is
the one remaining verification step before this can be called fully closed.

Regression test added (`Shell.deviceAdaptive.test.tsx`): two CSS-source-text
regex assertions confirming the exact properties are present. This is a
config-presence guard (it would catch someone reverting the fix), not a
pixel-layout guard — consistent with the codebase's existing convention
for CSS/token regressions jsdom cannot observe (`fontSizeUnits.test.ts`
style). Appropriately honest about its own limits in both the fix report
and the test's own comments.

Confirmed **mobile is untouched**: `@media (max-width: 480px) { .km-shell
{ border-left: none; border-right: none; } }` (line ~1146-1148) was not
touched by the fix-pass diff, and `.km-appframe`'s base rule (`display:
contents;`, no media query) is unchanged — below 768px the wrapper remains
a no-op in the box tree exactly as before D0.

### SHOULD-FIX-1 — `LearnMenu` sibling restoration

**Status: FIXED.** Read `client/src/components/Shell.tsx` directly (not
just the diff) and confirmed the final JSX shape: `LearnMenu` is now
rendered as a direct child of `.km-appframe`, as a sibling of the
`.km-shell` `<div>` — not nested inside it. Diffed against
`git show rebuild:client/src/components/Shell.tsx`: pre-D0, `.km-shell` and
`LearnMenu` were both direct children of `ExamActiveProvider`. Post-fix,
they are both direct children of `.km-appframe`, which is itself the sole
child of `ExamActiveProvider` and is `display: contents` below 768px — so
the rendered **box tree** below 768px is exactly the same shape as pre-D0
(one more React-only wrapper element, invisible to CSS box generation).
This matches the "byte-equivalent... box tree" claim precisely (box tree,
not React element tree — a fair and accurate framing).

Regression test added and verified present:
`Shell.deviceAdaptive.test.tsx`'s new describe block opens the LEARN
hexagon and asserts `shell.contains(learnMenu) === false` and
`learnMenu.parentElement === shell.parentElement`. This is a real DOM
containment assertion, not a CSS-text guard, and it is the correct check
for this claim (unlike BLOCKER-1, jsdom CAN observe DOM containment
directly, so this test is a genuine regression guard, not just a
config-presence proxy).

The doc comment (`Shell.tsx:41-48`) was also updated to state the
`position: fixed` containing-block risk explicitly, addressing the
review's secondary ask (fix the comment even if the structural fix
weren't made) as well as the structural fix itself.

### SHOULD-FIX-2 — Sidebar `/settings` quiet zone

**Status: FIXED.** `client/src/components/Sidebar.tsx` adds a local
`isSettingsPath()` (lowercase, `=== '/settings' || startsWith('/settings/')`
— a segment-boundary prefix match, same shape as `ChatFab.isHiddenPath`)
and gates the chat rail button on `!examActive &&
!isSettingsPath(location.pathname)`. Confirmed `/chat` is deliberately
excluded from the hide (Sidebar's chat entry still renders there),
documented in both `Sidebar.tsx`'s header comment and inline at the
gate — this is exactly the "considered difference, not oversight"
resolution the review asked for confirmation on, and it's a defensible
product call (a persistent rail item isn't "noise" the way a floating FAB
sitting over the same page is).

Four new tests in `Sidebar.test.tsx` cover: hide on `/settings`, hide on
`/settings/security` (sub-route), stays visible on `/chat`, and a
`/settingsomething` sibling path is correctly NOT caught by the prefix
match (a real edge case for a naive `startsWith('/settings')` check, and
this implementation correctly requires the following `/` or exact match).
All four read as intended and were re-run — pass.

### SHOULD-FIX-3 — `useDeviceClass.ts` doc-comment overclaim

**Status: FIXED.** `hooks/useDeviceClass.ts`'s `'desktop'` bucket comment
now explicitly states tablet and desktop are NOT visually distinguished in
D0, names the shared 768px breakpoint as the reason, and explains the
three-bucket split exists for a future phase. Accurately reflects the CSS
(single `@media (min-width: 768px)` block, no second 1024px-gated rule
anywhere in the diff — confirmed by grep, no `1024px` media query exists in
`styles/index.css`).

### NIT-1 — `role="group"` on `.km-sidebar__group`

**Status: FIXED.** Confirmed `role="group"` added alongside the existing
`aria-labelledby={LEARN_HEADING_ID}` in `Sidebar.tsx`.

### NIT-2 — duplicate `aria-label="Primary navigation"`

**Status: FIXED.** `Sidebar`'s `<nav>` now reads `aria-label="Primary
navigation, sidebar"`, with a comment explaining the distinct-landmark
rationale. `BottomNav.tsx` is confirmed untouched (still plain "Primary
navigation" — correct, since only one of the two ever mounts at a time
today). The one pre-existing `Sidebar.test.tsx` assertion checking the old
label string was updated in the same commit; `BottomNav.test.tsx` was
correctly left alone.

### NIT-3 — undocumented `matchMedia` coupling in `Shell.test.tsx`

**Status: FIXED.** A new paragraph was added to `Shell.test.tsx`'s file
header documenting the implicit dependency on `test/setup.ts`'s `matches:
false` default, and clarifying `mockReducedMotion()`'s own stub also
resolves device-class queries to `'mobile'`. Cross-referenced to
`Shell.deviceAdaptive.test.tsx` for where the Sidebar-chrome coverage
actually lives. This is comment-only, as expected for a NIT of this kind —
no test behavior changed.

## Regression check

- **Mobile provably unchanged**: `.km-appframe` base rule (`display:
  contents`) and the `@media (max-width: 480px)` border rule are both
  outside this fix-pass's diff. The `LearnMenu` DOM move is now a verified
  no-op on the box tree below 768px (see SHOULD-FIX-1 above). No mobile
  test assertions were altered except the one `aria-label` string update
  (NIT-2, sidebar-only, does not touch `BottomNav`).
- **`matchMedia` default still protective, not masking**: no changes were
  made to `test/setup.ts` in this fix-pass; the PRAISE-1 finding from the
  original review stands untouched and unaffected by any of the four fixes.
- **PRAISE items 1-5 all confirmed intact**: none of the files/lines they
  reference (`test/setup.ts`, `lib/nav.ts`'s `matchActiveNavId`,
  `useDeviceClass`'s SSR handling, the reduced-motion CSS blanket rule,
  `NAV_ITEMS` cross-check) appear anywhere in the `d4cb091..29bd397` diff.
- **No new regressions introduced by the fixes themselves**: the full
  vitest run (below) passes at 1997/1997, up from the pre-fix-pass
  1990/1990 baseline (+7 new tests: 4 Sidebar `/settings` tests, 1 DOM-
  sibling test, 2 CSS-presence tests — exactly matching the fix report's
  own count).

## Gate results (fresh run, this re-review — exact commands)

- **Lint**: `npm run lint` (`eslint .`) → clean, 0 problems.
- **Typecheck**: `npx tsc -p tsconfig.app.json --noEmit --incremental false`
  → clean, 0 errors, no output.
- **Tests**: `npx vitest run` → **120 files passed (120), 1997 tests passed
  (1997)**. Matches the fix report's claimed count exactly.
- **Build**: `npx vite build --outDir /tmp/km-d0rr` → exit 0, built in
  575ms. Same pre-existing "chunks larger than 500 kB" warning as noted in
  the fix report (unrelated to this phase — no new imports).

## Recommendation

**Ship.** All 7 findings (1 BLOCKER + 3 SHOULD-FIX + 3 NIT) are correctly
and durably fixed at the root cause, each with an appropriate regression
test given the constraints of the test environment. No regressions
detected in mobile behavior, existing test coverage, or the PRAISE items.
The BLOCKER fix is spec-correct by careful independent hand-trace — two
independent flexbox mechanisms (auto-margin absorption and
`justify-content: flex-start`) both confirm Sidebar pins to the true left
edge and `.km-shell` widens to fill the row up to its cap.

**One condition before calling D0 visually closed**: get a real-browser
screenshot at a desktop viewport (~1440×900) confirming what the CSS trace
predicts — Sidebar flush against the left edge with no dead space to its
left, and the content column visibly wider than before. Nothing in this
sandbox can render real layout (no Playwright/Puppeteer/system Chromium
available), so this check must happen in whatever environment the
orchestrator ships from next, before D1 builds on top of this foundation.
