# Review — Round 3 (mobile3-logic): Today layout, nav deep-links, PDF native-touch swipe, flush skyline

**Reviewer:** independent senior React/TS reviewer (no prior involvement in this branch)
**Branch:** `feat/mobile-hardening` @ `5621256` (off `rebuild`)
**Diff reviewed:** `5ffbc7c..5621256` (`git diff 5ffbc7c 5621256 --stat`)
**Files:** `client/src/pages/Today.{tsx,css,test.tsx}`, `client/src/pages/UploadViewer.{tsx,css,test.tsx}`, `client/src/components/Shell.{tsx,test.tsx}`, `client/src/styles/index.css`

## Verdict: PASS

No blockers. All four fix classes verified working as described, with test coverage that would catch a real regression in the vast majority of cases. Two SHOULD-FIX items (test-coverage gaps, not code defects) and a handful of NITs below. This is senior-grade, well-reasoned work — the module-header narration of two "real-device follow-up" false starts before finding the actual root cause (native-touch vs. Pointer-Events-on-a-scrollable-box) is exactly the kind of debugging trail I'd want from someone I was mentoring.

---

## Per-fix checklist

### 1. Today layout (headers, spacing, scaling)

| Item | Status | Evidence |
|---|---|---|
| `<h2>`s are real heading elements | ✅ | `Today.tsx:609,719,747` — plain `<h2 className="km-today__sectionTitle">`, not a styled `<div>`/`<Eyebrow>`. |
| Heading order sane vs. page `<h1>` | ✅ | `Today.tsx:582` is the only `<h1>` (`id="today-title"`); the three `<h2>`s follow it in document order, no skipped levels, no other heading tags anywhere in the file (`grep -n "<h[1-3]" Today.tsx` returns exactly these four). |
| Scaling is visual-only, can't overflow at 360px | ✅ | `Today.css:279-329` — `.km-today__peekItem` animates only `transform: scale()`/`opacity`; the centered tile's max is `scale(1)` (its own untransformed flex-basis box), never `>1`; the containing `.km-today__peekTrack` (`Today.css:255-273`) is `overflow-x: auto` with `scroll-snap-type: x mandatory`, so even a scale bug couldn't push page-level horizontal scroll — worst case is rail-internal overflow. |
| Reduced-motion gated | ✅ | `Today.css:331-335`, `@media (prefers-reduced-motion: reduce) { .km-today__peekItem { animation: none; } }` — same specificity as the `@supports` rule and declared later in source order, so it correctly wins the cascade regardless of `@supports` nesting. Pre-existing from Round 2, unchanged/still present. |
| No hardcoded hex | ✅ | `grep -n "#[0-9a-fA-F]\{3,8\}"` across all 5 changed files returns nothing. `.km-today__sectionTitle` reuses `var(--font-display)`/`var(--paper)` (`Today.css:57-65`), the same AA-checked tokens `.km-today__tileHeadline` already uses. |
| Spacing tightened correctly | ✅ | `.km-today__section { margin-bottom: 0; }` (was `6px`) + `.km-today__sectionTitle { margin: 12px 0 8px; }` (was the eyebrow's `18px 0 8px`) — combined inter-section gap goes from 24px to 12px, verified by `Today.test.tsx`'s new CSS-source-pinning test. |

**Test-coverage note:** `Today.test.tsx` adds 4 new tests (`renders the three section titles as real, centered <h2> headers`, two CSS-source-pinning tests, one for the peek-pop mechanism) that all read from source rather than measuring layout — correct call given happy-dom does no layout, and consistent with the codebase's existing pattern for this class of assertion (`Shell.test.tsx` does the same for the statusbar fix, see below).

### 2. Today nav deep-links

| Item | Status | Evidence |
|---|---|---|
| Due-now → `/learn/vocab?study=due` | ✅ | `Today.tsx:648`. |
| Review.tsx consumes `study=due` → opens FSRS session | ✅ | `Review.tsx:449-452` parses `study` from `searchParams`; `Review.tsx:608` branches `if (study === 'due')` into the due-review flow (not the lists-first landing). |
| TOPIK resume → `/learn/topik?mode=mock` | ✅ | `Today.tsx:457`. |
| Topik.tsx skips the chooser on non-null `mode` | ✅ | `Topik.tsx:223-224` — `chooserOpen` is seeded `() => searchParams.get('mode') === null`, a one-time lazy initializer, so `?mode=mock` correctly opens straight into the exam. `Topik.tsx:214` also correctly resolves `mode` itself off the same param for the actual view logic. |
| Location-probe test asserts full `pathname+search` | ✅ | `Today.test.tsx` adds `LocationProbe` (renders `location.pathname + location.search`) and re-points `renderTodayAt`'s mock routes at it for `/learn/vocab` and `/learn/topik`. The three relevant tests now assert e.g. `'VOCAB PAGE /learn/vocab?study=due'` and `'TOPIK PAGE /learn/topik?mode=mock'` — a route-match-only assertion (`getByRole` on route, or `screen.getByText('TOPIK PAGE')` as it was pre-fix) would NOT have caught a missing query param, since react-router's `<Route path>` matching ignores `?search` entirely. This is a real, not cosmetic, strengthening of the test. |
| Reading/Listening/Writing tiles + counts left untouched | ✅ | `Today.tsx:487` (`navigate('/learn/reading')`), `:511` (`/learn/listen`), `:548` (`/learn/writing`) — all three still bare paths, no query params added. Confirmed no other diff touches these three `onClick`s (`git diff` shows zero lines changed in that vicinity apart from a comment cross-reference at `Today.tsx:59` explaining the topik param). |

No issues. This is a clean pair of fixes with a test-quality upgrade (the location probe) that specifically targets the bug class both fixes belong to.

### 3. PDF swipe (native-touch fix)

This is the highest-risk change in the diff (402 lines in `UploadViewer.tsx` alone) and got the most scrutiny.

| Item | Status | Evidence |
|---|---|---|
| No double-handling (touch can't fire both paths) | ✅ | Every one of the six mouse/pen handlers (`onPagePointerDown/Move/Up/Cancel/Leave/Lost`, `UploadViewer.tsx:689-787`) opens with `if (e.pointerType === 'touch') return;`. Both families share one `swipeRef` and both arm-guards (`if (swipeRef.current !== null) return;`, `:697` and `:821`) reject a second start while a gesture is live — so even on a hybrid touch+mouse device, whichever family claims the ref first blocks the other, and a touch's synthetic PointerEvent (`pointerType: 'touch'`) is rejected by the pointer-family guard before it can touch `swipeRef` at all. |
| `{passive:false}` listener correctly attached/removed | ✅ | `UploadViewer.tsx:891-900` — `touchmove` explicitly `{ passive: false }` (the other three touch listeners stay `{ passive: true }`, correctly, since they never call `preventDefault`); cleanup removes all four on effect re-run/unmount. Effect deps are `[swipeEligible, pageBoxEl]` (`:901`) — `pageBoxEl` is a **state mirror** of the callback-ref-assigned DOM node (`:548-555`), which is the documented fix for the "containerWidth stayed 0, listeners never attached" class of bug: depending on the *node identity* (null → element, exactly once per mount) rather than a *measured value* that can legitimately stay 0 under both real narrow layouts and happy-dom's no-layout test environment. |
| Vertical scroll still works | ✅ | `onTouchMove` (`:832-860`) only calls `preventDefault()` after `d.axis === 'h'` locks (`:853`); the `'none'` (undecided, within the 8px lock window) and `'v'` (surrendered) branches both return before reaching that line — confirmed by `UploadViewer.test.tsx`'s `'leaves a vertical-dominant touch drag alone, preserving native scroll (no preventDefault)'` test (native-touch version, not just the old pointer-based one). |
| Zoom-pan intact | ✅ | `swipeEligible = zoom <= FIT_ZOOM` (`:677`) gates BOTH the pointer-handler guard (`:691`) and the touch effect's attach condition (`:815`, `if (!swipeEligible \|\| el === null) return;`), and also flips `touchAction` to `'auto'` on the box (`:1237`) when not eligible — three independent points all keyed off the same flag, so zooming past fit-width correctly hands touch back to native pinch/pan. |
| Keyboard/Prev-Next (bottom bar) work | ✅ | `UploadViewer.tsx:1280-1306` — real `<Button>`s (real `<button>` underneath), `aria-label`s intact, `role="group" aria-label="Page navigation"`. Test: `'the bottom pager shows the live page-N-of-M readout and stays keyboard-operable'` focuses the Next button and drives it via `user.keyboard('{Enter}')`. |
| Bottom arrows don't overlap global BottomNav | ✅ | The pager (`UploadViewer.css:60-68`) is normal in-flow content (no `position: fixed/sticky`), rendered as a sibling *after* the `CityCard` inside `<section className="screen ...">`, which itself renders inside `Shell.tsx`'s `<main className="km-shell__scroll">` (`Shell.tsx:156`). `BottomNav` is a separate flex sibling *outside* `.km-shell__scroll` (`Shell.tsx:161-168`), not an overlay — so `.km-shell__scroll` already gets `flex: 1` and shrinks to leave BottomNav its own space; the pager just scrolls within that box like any other content. No overlap is possible by construction, not by luck. |

**SHOULD-FIX (test-coverage gap, not a code defect):** the "disarmed once zoomed past fit-width" behavior is only tested via the **mouse/pointer** path (`UploadViewer.test.tsx`, `'the swipe gesture is not armed once zoomed past fit-width'`, uses `swipeLeft()`). There is no equivalent test using `touchSwipeLeft()` after zooming in to confirm the native-touch effect actually detaches its listeners (rather than, say, still calling `preventDefault` and eating the native pinch/pan gesture). By inspection the code is correct (`swipeEligible` gates the effect's attach condition identically to the pointer guard), but this specific interaction for the *touch* code path — the one this whole round exists to fix — is unverified by any test. Recommend adding a `touchSwipeLeft` variant of that test.

**SHOULD-FIX (test-coverage gap):** no test asserts the touch listeners are actually removed via `removeEventListener` (e.g. via a `vi.spyOn(el, 'removeEventListener')` count check) on unmount or on a `swipeEligible` flip. The cleanup function exists and looks correct by inspection (`:895-900`), but nothing in the suite would fail if a future edit dropped the cleanup return or mismatched a listener's options object (a `{ passive: false }` add paired with a bare `removeEventListener(name, fn)` remove — which is fine per spec since options don't need to match for removal, but a *different function reference* on remove would silently leak, and there's no test that would catch it).

Neither of the above is a blocker: the current implementation is correct on inspection, and the untested paths are symmetrical to already-tested sibling paths (mouse-zoom-gate is tested; touch-cleanup-shape mirrors the existing SwipeCarousel pattern this was ported from). But per the review brief's "test can't catch its bug" blocker criterion — these two specific regressions (touch-not-disarmed-at-zoom, listener-leak-on-unmount) would currently slip through CI undetected if reintroduced.

### 4. Blank gap fix (`.km-shell__statusbar`)

| Item | Status | Evidence |
|---|---|---|
| Flush on non-notch (0px) | ✅ | `index.css:1015` (post-diff), `height: env(safe-area-inset-top, 0px);` — no `max()` floor remains; `--shell-statusbar-h` constant fully deleted (`index.css` diff, and `grep -rn "shell-statusbar-h" client/src/` returns nothing anywhere in the codebase — no dangling reference). |
| Still clears the notch on notched devices | ✅ | Same declaration — `env(safe-area-inset-top, 0px)` resolves to the real inset when the UA reports one; the `0px` is only the fallback for UAs that don't support `env()` at all (correctly matches "flush" there too, per the browser having no notch concept to report). |
| No page relied on the 54px | ✅ | Login (`Login.tsx:86`, `.km-login` has its own `padding: 32px 22px 80px`, `index.css:1531-1532`), BootSkeleton (`App.tsx:229-238`, `.km-stub` has `padding: 28px 20px 80px`, `index.css:1776-1778`), and ErrorBoundary (`ErrorBoundary.tsx:45`, same `.km-stub`) all render the identical `.km-shell__statusbar` div and are therefore affected by the same height change — but each wraps its content in a class carrying its own independent top padding, so none of them actually depended on the removed 54px floor for visual breathing room. Worth noting explicitly: these three pages don't have a *separate* padding rule that was preserved untouched — they share the exact same `.km-shell__statusbar` CSS as `Shell.tsx`, and are safe only because their *content* wrappers (`.km-login`, `.km-stub`) carry their own padding independently of the statusbar spacer. That distinction matters for the next person touching this file: a future page that reuses `.km-shell__statusbar` WITHOUT its own content padding would go flush-to-the-very-top on non-notch devices, which may or may not be desired. |
| Regression test | ✅ | `Shell.test.tsx` — new `describe('Shell — status-bar spacer...')` block source-pins the rule: asserts `height: env(safe-area-inset-top(?:, 0px)?);` present and asserts `not.toMatch(/\bmax\(/)` after stripping comments (correctly avoids false-positiving on the rule's own doc-comment, which mentions `max(54px, ...)` as the regression it fixes). |

No issues.

---

## Detailed findings

### SHOULD-FIX

1. **`UploadViewer.tsx` / `UploadViewer.test.tsx` — zoom-disarms-touch is untested for the touch path itself.** File: `client/src/pages/UploadViewer.tsx:815` (the guard), `client/src/pages/UploadViewer.test.tsx:931-944` (the existing mouse-only test). Add a `touchSwipeLeft`-based sibling test after zooming in, mirroring the existing mouse test, to close the gap described above.

2. **`UploadViewer.tsx` — no listener-leak regression test.** File: `client/src/pages/UploadViewer.tsx:891-900`. A `vi.spyOn(el, 'addEventListener')`/`removeEventListener` pair-count assertion around mount/unmount and around a `swipeEligible` flip (zoom in → zoom out) would catch a future edit that breaks the cleanup symmetry. Not currently covered.

### NIT

3. **`UploadViewer.test.tsx:1042-1094`, "arrows moved to the bottom" tests** — the keyboard-operability test (`'stays keyboard-operable'`) only exercises `{Enter}`; real `<button>` elements also activate on Space, and while this is standard native behavior not custom logic, a Space-key assertion would make the "keyboard-operable" claim in the test name fully literal rather than partially so. Cosmetic only — native `<button>` semantics are not something this codebase needs to re-verify.

4. **`Shell.tsx` module header (`:5-8`) and `index.css:1013-1024` comment** — both now correctly describe the fix, but neither comment flags that `.km-shell__statusbar` is reused verbatim by `Login.tsx`, `App.tsx` (`BootSkeleton`), and `ErrorBoundary.tsx` outside the `Shell` component itself. A future reader of `Shell.tsx` alone would reasonably assume this class is Shell-local. Consider a one-line cross-reference (`"Also rendered directly by Login/BootSkeleton/ErrorBoundary — see their own top-padding wrappers"`) at `index.css:1013` next to the rule, since that's the shared point of truth.

### PRAISE

5. **`UploadViewer.tsx:138-198` (module header, "F-155 real-device follow-up #1/#2").** The debugging narrative — first fixing the `<img>` native-drag-source issue, discovering swipe *still* failed, then correctly diagnosing that `touch-action: pan-y` on a genuinely-scrollable container is a much bigger native-pan grant than the same value on `SwipeCarousel`'s non-scrolling viewport, and that Pointer Events don't carry the same same-thread-first-refusal guarantee as a real non-passive `touchmove` listener — is exactly right and non-obvious. This is the kind of root-cause reasoning that's easy to stop short of (the #1 fix "looks like" the fix and isn't).

6. **`Today.css:290-311` and `UploadViewer.tsx:249-260` (`SwipeDrag` interface doc)** — both sites document *why* a shared ref/shape works across two input families instead of just asserting that it does. Good practice for the next engineer who has to reason about touch/pointer interaction without a debugger attached to a phone.

7. **`Today.test.tsx`'s `LocationProbe` helper** — a small, well-targeted addition that closes a real hole (route-only matching ignores `?search`) rather than a cosmetic test-count bump. This is the right fix for "the test could pass with the bug still present."

---

## Coordination

- No blockers — this diff is safe to ship as-is.
- Two SHOULD-FIX items are both **additional test coverage**, not code changes; they can be picked up as a fast follow without gating this round. Suggest filing them against the UploadViewer touch-swipe test file specifically so they don't get lost among the broader mobile-hardening backlog.
- Flagging item 4 (comment cross-reference) as a low-cost documentation improvement for whoever next touches `.km-shell__statusbar` — no code risk today, but the shared-class fact is easy to miss from `Shell.tsx` alone.
