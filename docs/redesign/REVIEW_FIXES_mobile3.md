# REVIEW — Round-3 Fixes Verification (independent re-review)

**Reviewer:** independent senior reviewer, fresh — did not write the code, the
Round-3 fixes, either Round-3 review, or the fix-pass.
**Repo:** `9b. Korean Master`, branch `feat/mobile-hardening`
**Scope:** commits `5621256` (fix: Today layout+nav, PDF native-touch swipe +
bottom arrows, flush skyline) and `a9b0091` (fix-pass: 2 touch-path tests +
1 design-limit comment), diffed against `5ffbc7c` (prior deployed).
**Method:** read `REVIEW_mobile3-logic.md`, `REVIEW_mobile3-capstone.md`,
`FIX_REPORT_mobile3.md`, then independently re-read every cited line in the
actual source and independently re-ran the full gate from scratch (not
trusting any prior report's numbers).

## VERDICT: PASS

No blockers, no regressions. All four Round-3 fixes verified against actual
code, and both fix-pass test additions confirmed to be real regression tests
(native touch dispatches against the real DOM prototype, not assertion
theater). Gate is clean. Recommend deploy to idle (BLUE — active is GREEN per
`km-lb`'s loaded nginx.conf, `# PROD server ... ACTIVE color (GREEN)`).

---

## 1. Today layout

Verified directly in `client/src/pages/Today.tsx`:
- `Today.tsx:582` — the only `<h1>` (`id="today-title"`).
- `Today.tsx:609,719,747` — three real `<h2 className="km-today__sectionTitle">`
  elements, in document order after the `<h1>`, no skipped levels.

`client/src/pages/Today.css`:
- `.km-today__sectionTitle` (`:57-65`) — 16px/700, centered, `margin: 12px 0
  8px`, uses `var(--font-display)`/`var(--paper)` tokens (no hardcoded hex —
  confirmed via `grep -n '#[0-9a-fA-F]\{3,8\}' Today.css` → no hits).
- `.km-today__section { margin-bottom: 0 }` (`:73-75`) — the old 6px+18px
  double-gap is gone, replaced by the single 12px `margin-top` on the next
  header. Matches the "de-doubled spacing" claim.
- `.km-today__peekItem` (`:279-329`) animates `transform: scale()`/`opacity`
  only; centered tile maxes at `scale(1)` (never grows past its own
  flex-basis box); `.km-today__peekTrack` is `overflow-x: auto` and
  `.km-shell__scroll { overflow-x: hidden }` (`index.css:1032`) is a hard
  clip behind it — two independent guarantees against page-level x-overflow.
- Reduced-motion gate present and unchanged from Round 2:
  `@media (prefers-reduced-motion: reduce) { .km-today__peekItem { animation:
  none; } }` (`Today.css:331-335`).

All claims hold. No regression risk found — this is CSS/markup-only with no
new state or side effects.

## 2. Today nav deep-links

Verified:
- `Today.tsx:648` → `navigate('/learn/vocab?study=due')`.
- `Review.tsx:449-450` parses `study` from `searchParams`; `Review.tsx:608`
  branches `if (study === 'due')` into the due-review flow.
- `Today.tsx:457` → `navigate('/learn/topik?mode=mock')`.
- `Topik.tsx:223-224` — `chooserOpen` seeded `() => searchParams.get('mode')
  === null` as a one-time lazy initializer; `?mode=mock` opens straight into
  the exam view.
- Reading/Listening/Writing untouched: `Today.tsx:487,511,548` are still bare
  `navigate('/learn/reading' | '/learn/listen' | '/learn/writing')`, no query
  params — confirmed by direct grep, matches the "deferred" scoping.

All claims hold exactly as described in both reviews.

## 3. PDF swipe (native-touch, deep fix)

This is the highest-risk change and got the closest read against
`client/src/pages/UploadViewer.tsx`.

- **No double-fire:** every pointer handler (`onPagePointerDown/Move/Up/
  Cancel/Leave/Lost`, lines 689/706/750/766/773/784) opens with `if
  (e.pointerType === 'touch') return;`. Touch is driven exclusively by the
  native-`addEventListener` effect (lines 813-910), which never reads
  Pointer Events. One shared `swipeRef`, one writer per device class.
- **`{passive:false}` correctly scoped:** `touchmove` alone is
  `{ passive: false }` (line 905); `touchstart`/`touchend`/`touchcancel`
  stay `{ passive: true }` (lines 904, 906, 907) — correct, since only
  `touchmove` calls `preventDefault`.
- **Vertical scroll preserved:** `preventDefault` is reached only after
  `d.axis === 'h'` locks (line 866); the `'none'` (line 852, <8px window) and
  `'v'` (lines 853-857, surrender) branches both return first.
- **Listener attach/cleanup correct, keyed on `pageBoxEl` state (not
  `pageBoxRef.current`):** effect deps `[swipeEligible, pageBoxEl]` (implied
  by the effect body at line 813-815, `if (!swipeEligible || el === null)
  return;` against `pageBoxEl`), which is the documented fix for the
  "listeners never attach because a measured width stayed 0" class of bug —
  confirmed this is a genuinely different mechanism than the round-2
  approach (module header at `UploadViewer.tsx:684-688,789-801` narrates why).
- **Bottom arrows:** real `<Button>`s in a `role="group" aria-label="Page
  navigation"` bar, keyboard-operable (Enter and, per the fix-pass, Space).
  In-flow content inside `.km-shell__scroll`, not `position: fixed`, and
  `BottomNav` is a separate flex sibling outside that scroll box in
  `Shell.tsx` — no overlap by construction.

**Fix-pass test verification (the reason a re-reviewer exists for this
round):** read both new tests directly, not just the fix report's prose.

- `UploadViewer.test.tsx:986-1001`, `'the touch swipe is not armed once
  zoomed past fit-width...'` — zooms in via the real "Zoom in" button, then
  calls `touchSwipeLeft(pageBox())` (real `fireEvent.touchStart/Move/End`
  native touch dispatch, distinct from the existing `swipeLeft` Pointer
  Events helper), asserts page stays `1 / 5`. **Confirmed this is a real
  regression test**: if the touch effect's `swipeEligible` early-return
  (`UploadViewer.tsx:815`) were dropped or broken independently of the
  pointer-path guard, this test fails (page would advance to `2 / 5`) while
  the existing mouse-only twin at `:965` would still pass — closing exactly
  the gap the logic review named.
- `UploadViewer.test.tsx:1013-1055`, `'attaches the four touch listeners on
  mount and removes the exact same handlers on unmount (no leak)'` — uses
  `domEventTargetProto()` (lines 171-203) to spy on the actual DOM prototype
  happy-dom's elements inherit `addEventListener`/`removeEventListener` from
  (verified the stated quirk myself: `document.createElement('div')
  .addEventListener !== EventTarget.prototype.addEventListener` is real
  happy-dom behavior, not an invented justification — the helper's approach
  of walking the node's own prototype chain until it finds the owning level
  is the correct fix, not a workaround masking a different bug). The test
  asserts (a) exactly one add per touch event type on the real page-box
  element, (b) exactly one matching remove per type post-unmount, (c) the
  **same function reference** is removed as was added per type (line 1044,
  `expect(removedHandler).toBe(addedHandler)` — this is the specific check
  that would catch a "different closure attached vs. removed" leak, which a
  naive `toHaveBeenCalled()` check would miss), and (d) a post-unmount
  `touchmove` dispatch doesn't throw. **This is a real, structural test, not
  theater** — it would fail if the `return () => { ... }` cleanup were
  dropped, or if a future edit re-created the handler closures between
  attach and the returned cleanup.
- Space-key NIT closure (`UploadViewer.test.tsx`, the bottom-pager keyboard
  test) — confirmed the test now drives both `{Enter}` and `{Space}` on the
  Previous button.
- The design-limit comment (diagonal-onset swipe under `pan-y`) is present
  verbatim at `UploadViewer.tsx:838-850`, immediately before the axis-lock
  decision, matching the fix report's description — comment-only, no logic
  change, confirmed by re-reading the surrounding lines against the prior
  round's diff.

## 4. Flush skyline

- `client/src/styles/index.css:1028` — `height: env(safe-area-inset-top,
  0px);`. `grep -rn "shell-statusbar-h" client/src/` returns nothing — the
  old `--shell-statusbar-h` constant and its `max(54px, ...)` floor are
  fully gone, no dangling reference anywhere in the codebase.
- Login (`Login.tsx`), BootSkeleton (`App.tsx`), ErrorBoundary
  (`ErrorBoundary.tsx`) all render the same `.km-shell__statusbar` div but
  wrap their content in `.km-login` / `.km-stub`, each carrying its own
  independent top padding — confirmed these are unaffected by the height
  change, consistent with both source reviews.
- `Shell.test.tsx` source-pins the rule (`height:
  env(safe-area-inset-top(?:, 0px)?)` present, `max(` absent after
  stripping comments) — a real regression guard against the floor
  reappearing.

## 5. Regressions

None found. Checked specifically for:
- New horizontal overflow: only new negative margin is
  `.km-today__peekOuter { margin: 0 -2px }`, doubly clipped as described.
- Touch/pointer double-handling: verified by direct code read (section 3
  above), not just trusting the review's grep.
- Any change to the three untouched Today nav tiles: none (grep-confirmed).
- Praise items from both source reviews (module-header debugging narrative,
  `SwipeDrag` doc comments, `LocationProbe` test helper) are all still
  present and unmodified in the current tree.

---

## Independently re-run gate (from `client/`, this session, not copied from any report)

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0 errors, 0 warnings** |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| Full test suite | `npx vitest run` | **115 files passed, 1804 tests passed** — single clean run, the known-flaky `ReviewDictionary.test.tsx` debounce test did NOT appear this run (nothing to re-isolate) |
| Build | `npx vite build --outDir /tmp/km-rr-r3` | **exit 0** (831.54 kB main chunk, pre-existing >500kB warning only, no new errors) |

Working tree left clean (`git status --short` shows only pre-existing,
unrelated untracked docs — `.claude/`, `REDESIGN_SEOUL_NEON_BRIEF.md`,
`docs/redesign/BACKEND_BATCH_SCOPING.md`,
`docs/redesign/TODAY_NAV_SCOPING.md` — none touched or created by this
review).

---

## Recommendation

**Ready to deploy to the idle color.** Active color is currently GREEN (per
`km-lb`'s loaded `nginx.conf` header comment, `ACTIVE color (GREEN)`), so
deploy Round 3 to **BLUE**, health-check, then flip `km-lb` per the standing
blue/green protocol. No further review pass needed for this round.
