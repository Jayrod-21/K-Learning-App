# REVIEW — post-beta polish batch (feat/post-beta-polish @ 77e076d)

Independent senior React/TS review. Read-only — no code changes, no git operations performed. Scope: F-132 (auto-theme), F-174 (LineChart trend), F-177 (PageHubHeader migration), F-178 (Hanja tile ochre regression test), F-180/181/182 (Hanja StateChip/masteredCount/promoteState), F-186 (WordPopover → Sheet).

Verification performed beyond static reading: `npx tsc --noEmit` (clean), `npx eslint` on every changed source file (clean), `npx vitest run` on all 8 changed/added test files — **268/268 passing**.

## Verdict: PASS WITH ONE BLOCKER

One real regression (Today.tsx header spacing) slipped through the F-177 migration — Progress.tsx got the pixel-parity fix, Today.tsx did not, and no test catches it. Everything else in this batch — the F-132 auto-theme clock logic, F-174's opt-in trend line, F-186's Sheet migration, and the Hanja F-180/181/182 fixes — is correct, well-tested, and safe to ship once the one blocker is fixed.

---

## Per-ticket checklist

### F-132 — Auto-theme by time of day
- [x] Injectable-clock design: `resolveAutoTheme(now, getHours?)` (`client/src/hooks/theme-context.ts:42-50`) defaults to real `Date.prototype.getHours` but takes an extractor purely for tests.
- [x] Tests prove day/night independent of the wall clock: `theme-context`'s pure-function tests inject an hour directly (`ThemeProvider.test.tsx:288-308`, all 24 hours partitioned into the two branches), and the provider-level tests pin `vi.setSystemTime` (`ThemeProvider.test.tsx:78-80`) rather than depending on whenever the suite happens to run.
- [x] 60s poll runs only in `'auto'` and cleans up: `ThemeProvider.tsx:167-175`, `useEffect` keyed on `mode`, returns `clearInterval`. Verified by `ThemeProvider.test.tsx:231-248` ("stops polling once the mode leaves auto") — advancing 5 min after leaving auto produces no flip. No dedicated "unmount clears the interval" test exists, but the cleanup function is the same one that already fires on the mode-change path in that test, and `useEffect` cleanup semantics guarantee it also fires on unmount — low-risk, not blocking (see NIT-1).
- [x] Manual override wins: `setMode('dark')`/`toggleTheme()` while in `'auto'` immediately re-resolves and pins an explicit mode (`ThemeProvider.tsx:211-216`); tested at `ThemeProvider.test.tsx:251-286` including a case where the clock crosses the boundary *after* the override and nothing changes.
- [x] **Two-copies-must-stay-in-sync footgun is documented and currently consistent.** `theme-context.ts:22-32` and `index.html:34-38` both call out, in comments, that the boundary is hand-duplicated because the inline bootstrap `<script>` cannot import a TS module. Checked both boundaries by hand:
  - TS: `hour >= AUTO_DAY_START_HOUR (6) && hour < AUTO_DAY_END_HOUR (18)` → light (`theme-context.ts:46-49`).
  - Bootstrap: `hour >= 6 && hour < 18` → `'light'` (`index.html:51-52`).
  Identical today. This is still a real hazard for the *next* person who changes one without the other — nothing enforces the sync beyond a comment (see SHOULD-FIX-1).
- [x] Persistence correct: `'auto'` is stored verbatim in `km.theme` (unlike `'system'`, which clears the key) — `ThemeProvider.tsx:188-197`, `readStoredMode` accepts `'auto'` (`ThemeProvider.tsx:49`).

### F-174 — LineChart trend line
- [x] Default-off, byte-identical for existing consumers: `trend = false` (`LineChart.tsx:174`), gates both the regression call (`LineChart.tsx:221`) and every render branch off it. Grepped the whole client tree — **Progress.tsx is the only real consumer** (`Progress.tsx:106,324-330`); the shared component's own test file is the other hit. Pinned by `LineChart.test.tsx:189-200` ("draws no trend line ... by default") using a fixture long enough (n=4) that the regression *would* draw if the gate were broken.
- [x] Math verified: `regressionTrend` (`LineChart.tsx:80-105`) is textbook least-squares over (index, value); guarded at `n < 3` and at `den === 0` (unreachable but defensive). `LineChart.test.tsx:202-239` hand-verifies the exact fixture (42/53/67 → slope 12.5, intercept 41.5) against Progress's own `TrendChart`'s SF1 fixture, including geometry-exact `x1`/`x2` pixel assertions and `toBeCloseTo` on the y-values that pass through the value→pixel map. Matches the ticket's request for regression parity with `TrendChart`.
- [x] Emphasized-latest-dot correct and independent of the n<3 trend guard: `isLatest = trend && i === n - 1` (`LineChart.tsx:334`) — renders at `n === 2` with `trend` on even though the line itself doesn't (`LineChart.test.tsx:241-264`).

### F-177 — Today + Progress → PageHubHeader
- [x] Same `<h1 id>`/`aria-labelledby` wiring preserved on both pages (`Today.tsx:695,707`; `Progress.tsx:552,570` — `today-title`/`progress-title` match on both ends).
- [x] Same eyebrow/heading content carried through unchanged (`Bilingual` pairs passed as `eyebrow`/`heading` props, same JSX that used to live inline).
- [x] Dead inline recipe + CSS removed cleanly: `SkylineHeader`/`DancheongRail`/`Eyebrow` imports and JSX dropped from both pages; `Today.css`'s `.km-today__skyline`/`.km-today__title`/`.km-today__rail-divider` and `Progress.css`'s `.km-progress__skyline`/`.km-progress__rail-divider` deleted, nothing dangling.
- [x] No behavior change to carousels/counts/charts — confirmed no other hunks touch that code in either page's diff.
- [ ] **Progress's pixel-exact title gap preserved — Today's is NOT. See BLOCKER-1.**

### F-178 — Hanja tile ochre on Today
- [x] Confirmed this is a **regression test only**, not a functional change — `git diff rebuild -- client/src/pages/Today.tsx` shows the `ActivityTile tone="ochre"` / `Pill tone="ochre"` / `DoneTodayRow tone="ochre"` block (`Today.tsx:802-825`) is untouched by any hunk; it was already `ochre` on the `rebuild` base, not the pre-ochre `plain` fallback the ticket describes. `Today.test.tsx:615-630` ("F-178: the Hanja tile uses the shared ochre skill tone") now pins it so a future regression back to `plain` would be caught. No bug here — ticket description was stale relative to `rebuild`, and the fix-pass correctly treated it as a test-coverage gap rather than inventing a redundant code change.

### F-180 — Hanja "Practicing" StateChip tone mismatch
- [x] `EncounteredBand`'s chip now passes `tone="ochre"` (`Hanja.tsx:724`), reusing the same `--km-mastery-practicing` token the index grid's `HanjaCell` reads, instead of the accent-tracking `--vermilion`. New CSS rule at `Hanja.css:113-122` reads the identical token, with the already-measured AA numbers (5.20:1 Day / 10.03:1 Night) cited rather than re-derived. `Hanja.test.tsx:1250-1263` confirms the rendered class; `Hanja.test.tsx:1265-1289` goes further and parses both CSS source files to confirm the chip rule and the grid rule both cite `var(--km-mastery-practicing)` — a real cross-file consistency proof, not just a DOM-class snapshot.

### F-181 — Hanja masteredCount no-op reconfirmation
- [x] Traced the move: previously `setMasteredCount((n) => n + 1)` ran unconditionally on every right answer; now it's inside the `if (next !== current.state)` guard alongside the `onSetState` write (`Hanja.tsx:2546-2560`). A no-op reconfirmation on an already-`banked` character advances the queue (`setQueue` still runs unconditionally, correctly — the character still leaves the session) but neither writes state nor bumps the displayed count.
- [x] Real test, not just an assertion of intent: `Hanja.test.tsx:1197-1231` ("F-181") seeds a 3-character session, confirms the progress bar stays at `aria-valuenow=1` after a no-op right-answer on the already-banked starting character, then confirms a *genuine* promotion (practicing→banked) on the next character both writes (`setHanjaStateMock` called) and bumps the bar to `2`. This distinguishes "the guard swallows the no-op" from "the guard swallows everything," which is the failure mode a lazier test could have missed.

### F-182 — promoteState no-op branch test coverage
- [x] `Hanja.test.tsx:1150-1166` ("F-182") is a standalone test independent of F-181's: right answer on an already-`banked` character advances the queue but never calls `setHanjaStateMock`. Real regression coverage — a future double-write or mis-promotion on the no-op branch would fail this test specifically.

### F-186 — WordPopover → Sheet
- [x] Props byte-for-byte unchanged: `WordPopoverProps` still exposes exactly `data`/`onClose`/`onAdd?`/`isLoading?` (`WordPopover.tsx:97-117`); all three real call sites — `Images.tsx:317-326`, `Reading.tsx:760-765`, `Ttmik.tsx:1498-1503` — pass the same shape, unchanged.
- [x] **No live `useModalA11y` call remaining in WordPopover** — grepped the whole client tree for call sites (not just imports): the only invocation touching this component's tree is inside `Sheet.tsx:84`; `WordPopover.tsx`'s own references to "useModalA11y" are all in prose comments. `Sheet.tsx` and `hooks/useModalA11y.ts` are untouched by this diff (`git diff rebuild --stat` shows zero hunks in either), so the shared primitive's contract didn't move either — this is a pure consumer migration, lowest possible blast radius.
- [x] No double focus-trap/scroll-lock, and it's independently tested twice, from two angles: `WordPopover.test.tsx:78-82` proves Escape fires `onClose` exactly once (a duplicated `useModalA11y` would double-fire), and `WordPopover.test.tsx:112-127` proves the ref-counted body-scroll lock restores the true pre-lock baseline (`'scroll'`, not `''`) on unmount — if WordPopover still ran its own copy of the hook alongside `Sheet`'s, an unbalanced acquire/release pairing would either fail to restore the baseline or restore the wrong one. Also `WordPopover.test.tsx:90-108` confirms rendering happens on `Sheet`'s own markup (`.km-sheet`/`.km-sheet__backdrop`/`.km-sheet__panel`) with `tone="accent"`, not a parallel dialog.
- [x] Dead `.km-popover` chrome removed cleanly from `index.css` without touching inner content rules: only `.km-popover__backdrop` and `.km-popover` (the outer fixed-position/backdrop wrapper) were deleted (`styles/index.css` diff); `.km-popover__head`, `.km-popover__pills`, etc. — every inner content rule — is untouched.
- [x] The 3 real consumers render/behave identically — no prop changes at any call site, confirmed above.

---

## Findings

### BLOCKER-1 — Today.tsx lost 14px of title→rail-divider gap in the F-177 migration (Progress got the fix, Today didn't)

**Files:** `client/src/pages/Today.tsx:706-710`, `client/src/pages/Today.css` (deleted rule, no replacement), vs. `client/src/pages/Progress.tsx:566-579` + `client/src/pages/Progress.css:43-49` (correct).

Before this batch, both hub pages carried the *identical* extra bottom margin on their title:
```css
/* base rebuild, both files */
.km-today__title    { margin: 4px 0 14px; }   /* Today.css */
.km-progress__title { margin: 4px 0 14px; }   /* Progress.css */
```
The shared `PageHubHeader` component's own base recipe uses a smaller margin:
```css
/* components/PageHubHeader.css:16-18 */
.km-hubheader__title { margin: 4px 0 0; }
```
**Progress.tsx's migration accounted for this.** It passes `className="km-progress__hub"` to `PageHubHeader` (`Progress.tsx:567`) and adds a scoped override:
```css
/* Progress.css:43-49, this batch */
.km-progress__hub .km-hubheader__title { margin-bottom: 14px; }
```
with an explicit comment: *"this page's title carried one extra step of bottom margin ... restored here ... so the migration is byte-for-byte visually, not just structurally."*

**Today.tsx's migration does not.** It renders:
```tsx
<PageHubHeader
  titleId="today-title"
  eyebrow={<Bilingual en={dateEn} kr={dateKr} />}
  heading={<Bilingual kr="오늘" en="Today" />}
/>
```
— no `className`, no override — and `Today.css`'s replacement comment (`Today.css:21-25`) only explains where the old rules went, it doesn't restore the 14px. The net effect: Today's title-to-dancheong-rail gap shrinks from 18px (4px top + 14px bottom) to 4px, a real, visible layout regression on one of the app's two most-visited screens. This is exactly the class of bug PR reviewers are told to watch for on this ticket ("Progress's pixel-exact title gap preserved") — the same fix was needed on both pages (their pre-migration CSS was identical), and only one got it.

No test catches this. `Today.test.tsx:499-528` (new F-177 test) asserts the shared component's classes are present and the old page-local classes are gone, and that the `<h1>` content/id/aria-labelledby survived — all true — but asserts nothing about the actual margin/gap, so it passes green despite the regression.

**Fix:** add the same pattern Progress got — either pass `className="km-today__hub"` to `Today.tsx`'s `PageHubHeader` call and add `.km-today__hub .km-hubheader__title { margin-bottom: 14px; }` to `Today.css`, or (cleaner, since the value is identical on both pages) fold `margin: 4px 0 14px` into `PageHubHeader.css`'s own base rule and drop the per-page override from `Progress.css` too — decide which one is actually "the design" and stop carrying it as two special cases of a "shared" component that don't actually share this value.

### SHOULD-FIX-1 — F-132's dual-boundary sync has no automated guard, only a comment

`theme-context.ts:22-32` and `index.html:34-38` are honest that the 06:00/18:00 boundary is hand-duplicated because the bootstrap script can't import TS, and today they agree. But nothing would catch a future drift except a human reading both files at once — no test reads `index.html`'s inline script and cross-checks it against `AUTO_DAY_START_HOUR`/`AUTO_DAY_END_HOUR`. Given the ticket's own PROBE flags this as "a real footgun," it's worth a cheap regression test: a unit test that `readFileSync`s `index.html` (the same pattern `Hanja.test.tsx:1265-1289` already uses to cross-check CSS files), extracts the `>= N && < M` literals via regex, and asserts they equal the exported constants. Not a blocker — nothing is wrong today — but it converts "a comment asks you to remember" into "CI tells you if you forget," which is the more durable fix for a hazard this doc itself calls out.

### NIT-1 — No test asserts the `'auto'` poll interval is cleared specifically on unmount (only on mode-change)

`ThemeProvider.test.tsx:231-248` proves the interval stops firing once `mode` leaves `'auto'` via `setMode('light')`, which does exercise the same `useEffect` cleanup path React also runs on unmount — so this is not a functional gap, just a coverage gap on the specific "component unmounts while still in auto mode" edge (e.g., navigating away from Settings mid-auto). Given `useEffect` cleanup semantics are identical for both triggers, this is genuinely low-risk; flagging only because the PROBE explicitly asked about unmount cleanup as a named scenario.

### PRAISE
- The F-181/F-182 Hanja tests are exactly the kind of test that actually catches its own regression: they assert both directions (no-op doesn't write/bump, real promotion does), rather than only asserting the happy path the ticket describes.
- F-186's scroll-lock test (`WordPopover.test.tsx:112-127`) is a genuinely clever proof of "no double-lock" — restoring the true pre-lock baseline value (not `''`) is the one assertion that would fail under an unbalanced double-acquire/release, and the comment explains why.
- F-174's trend-line test hand-verifies the regression math against Progress's own `TrendChart` fixture rather than just snapshotting output — this is real math verification, not just "a line rendered."
- The `resolveAutoTheme` injectable-clock design is the right shape (mirrors `lib/localDay.ts`'s existing `dayParts` convention per the code comment) — it makes the pure-function tests fully deterministic without faking global `Date`, and the provider tests separately pin `vi.setSystemTime` for the integration path. Good defense in depth.

---

## Coordination

- **BLOCKER-1** is a one-line CSS/prop fix (mirror Progress's `className` + scoped-margin pattern onto Today, or consolidate the 14px into `PageHubHeader.css` itself) plus one new assertion in `Today.test.tsx` checking the actual computed/rule-sourced margin the way `Hanja.test.tsx:1265-1289` already does for CSS-token consistency. Should not require touching `PageHubHeader.tsx` itself unless the team picks the "consolidate" option.
- No other ticket in this batch needs code changes. SHOULD-FIX-1 is optional hardening (a test, not a code change) and can be picked up whenever the theme code is next touched.
- Full test suite for the 8 changed/added test files passes (268/268), `tsc --noEmit` is clean, `eslint` is clean on every changed source file — the batch is otherwise release-quality.
