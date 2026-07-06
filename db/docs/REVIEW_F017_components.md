# F-017 Component Review — SwipeCarousel + LineChart

Reviewer: independent senior React review (component slice only).
Commit: `ca1cc09` (`feat(today): swipeable per-skill stats carousel (F-017)`), branch `feat/f017-stats-carousel`.
Scope: `client/src/components/SwipeCarousel.{tsx,css,test.tsx}`, `client/src/components/LineChart.{tsx,css,test.tsx}`.
Test run (Docker, node:20-slim): the two shipped suites pass — **16/16** (8 carousel, 8 chart), 705ms.

## Verdict

**REQUEST CHANGES — 1 BLOCKER.** The carousel has a real, empirically reproduced stuck-drag bug: a mouse gesture that never locks horizontal (a vertical drag, or a press that leaves the viewport before any in-element move) and is released outside the viewport leaves `dragRef` populated forever, and the `dragRef.current !== null` guard in `onPointerDown` then silently ignores every subsequent swipe until the component remounts. Touch is protected by implicit pointer capture; mouse is not. Everything else in both components is genuinely strong — the LineChart is NaN-safe on every degenerate input I probed (empty, single point, all-equal, all-zero, non-finite, negative), and both components have zero effects and zero render-time ref access, so the strict `react-hooks/set-state-in-effect` / `react-hooks/refs` rules are satisfied in spirit, not just in letter.

## BLOCKER

### B1. Mouse drag state gets permanently stuck; all future swipes are then silently ignored
`client/src/components/SwipeCarousel.tsx:106-116` (the `dragRef.current !== null` early-return), `:139-144` (axis `'v'` keeps the ref), `:132-137` (capture only acquired once axis locks `'h'`).

Mechanism: mouse pointers have **no implicit pointer capture** (touch does), and the component deliberately defers `setPointerCapture` until the axis lock decides `'h'` — a sound choice on its own (capturing on `pointerdown` would retarget `click` away from interactive content inside pages, e.g. the LineChart hit buttons). But it means that for any gesture still in axis `'none'` or surrendered to `'v'`, `pointerup` is only seen if it happens over the viewport. Release the mouse anywhere else and neither `onPointerUp` nor `onPointerCancel` ever fires (mouse gestures do not get `pointercancel`), so `endDrag()` never runs. From then on, `onPointerDown` line 109 — "A second touch while a gesture is live is ignored" — rejects **every** new gesture, because the dead gesture is immortal. Two easy real-world triggers on desktop:

1. Press on the carousel, drag downward (scroll-ish / selection-ish motion — axis locks `'v'`), release below the carousel.
2. Press and flick the mouse out of the viewport fast enough that no `pointermove` fires in-element, release outside.

**Empirically confirmed**: I wrote a two-case probe test (temporary file, deleted after the run) dispatching `pointerup` on `document.body` after each trigger, then performing a fully valid 120px horizontal swipe with a fresh `pointerId`. Both cases FAIL — the carousel stays on page 1, i.e. the valid follow-up swipe is swallowed. Impact: swipe interaction permanently dead for the session (dots/keyboard still work, and touch devices are unaffected), with no error and no recovery.

**Fix (minimal, no capture-timing change needed):**
- In `onPointerMove`, when the axis decision is `'v'` (line 142), call `endDrag()` instead of keeping the ref — the gesture is surrendered, so there is nothing left to track. This alone fixes trigger 1.
- Add `onPointerLeave` on the viewport that calls `endDrag()` when `dragRef.current?.axis !== 'h'` (during `'h'` the pointer is captured, so leave is not a concern). This fixes trigger 2.
- Belt-and-braces: add `onLostPointerCapture={endDrag}` so an externally revoked capture during an `'h'` drag can't strand `dragX` mid-track either.
- Add the two probe scenarios as regression tests (pattern: `fireEvent.pointerUp(document.body, …)` to model an off-element release, then assert a subsequent swipe still snaps).

## SHOULD-FIX

### S1. Non-primary pointers arm gestures
`SwipeCarousel.tsx:106-116`. `onPointerDown` doesn't check `e.isPrimary` or `e.button`. A right-click press arms a gesture; if the context menu suppresses the corresponding `pointerup` (platform-dependent), that's a third route into B1's stuck state, and even after B1 is fixed a right-press-drag would move the track. Guard: `if (!e.isPrimary || e.button !== 0) return;`.

### S2. Mouse-dragging the track selects text/SVG content in the pages
`SwipeCarousel.css:9-15`. No `user-select` handling. A horizontal mouse drag across a page visibly smears a text selection through the chart's tick labels and readout while the track moves — standard hand-rolled-dragger polish gap. Fix: `user-select: none; -webkit-user-select: none;` on `.km-carousel__viewport` (or toggled via the existing `--dragging` class if selection inside pages must remain possible at rest).

### S3. LineChart hit layer floods the tab order — up to 30 tab stops per chart
`LineChart.tsx:242-270`. One real `<button>` per point is a genuinely good pattern for making the data keyboard-reachable, but with the 30-day series every chart injects up to 30 sequential tab stops (and the API allows 90). A keyboard user must tab through all of them to get from the active carousel page to the dot tablist. The dots correctly use roving tabindex; the hit layer should too — one tab stop, Left/Right arrows move `hoverIdx` (and focus), Home/End jump to first/last. Inactive pages are `inert`, which contains the damage to one chart at a time, but 30 stops on the active page is still keyboard-hostile.

### S4. Test gaps (component suites)
- `SwipeCarousel.test.tsx` — no test for **pointercancel** cleanup, none for the **off-element release / gesture-recovery** path (would have caught B1), none for **edge overscroll** (rightward swipe on page 1 / leftward on the last page stays put — the `goTo` clamp is only exercised via `initialIndex`), and none for **multi-touch ignore** (second `pointerId` during a live gesture). The suite covers snap, spring-back, and vertical-surrender — the right three happy paths — but every miss is on the failure/edge side, which is exactly where this component's risk lives.
- `LineChart.test.tsx` — no test for the **all-zero series** (`niceCeil(0) → 1` baseline behavior) or an **all-equal flat line**; both work (verified by reading the math), but they're the classic divide-by-zero shapes and cheap to pin. No test that the crosshair/readout handles hover via mouse (`mouseEnter`) as well as focus — focus alone is tested.

## NIT

### N1. Page change is not announced to screen readers on swipe
`SwipeCarousel.tsx:194-229`. Dot navigation announces fine (focus moves to the newly selected tab, "Page 2 of 3, selected"), but a swipe changes the visible panel with no live-region announcement. For a non-rotating carousel driven by a tabs pattern this is defensible per the APG, and SR touch users will use the dots — noting for completeness.

### N2. Focus is dropped to `<body>` when the focused page is swiped away
`SwipeCarousel.tsx:222-223`. If focus is inside a page (e.g. a chart hit button) and the page changes, the panel becomes `inert` and the browser dumps focus on `<body>`. Moving focus to the active dot (or new panel) on programmatic page change would be kinder; low priority for this app's usage.

### N3. Stale `rawIndex` can resurface after a shrink/regrow of `children`
`SwipeCarousel.tsx:79-84`. The render-time clamp is the right call (and correctly avoids a fix-up effect), but `rawIndex` itself is never reconciled: shrink 5→3 while on page 5 shows page 3, and a later regrow to 5 snaps back to page 5 unexpectedly. Unreachable with the current fixed-5-panel caller; worth a comment at most.

### N4. Stale `hoverIdx` if `points` shrinks while hovered
`LineChart.tsx:213-221`. `xs[hoverIdx]` becomes `undefined` → React omits `x1`/`x2` → a crosshair at x=0. The readout is guarded (`readoutPt !== undefined`), so no crash; unreachable with the load-once data flow.

### N5. Duplicate `date` values would collide React keys
`LineChart.tsx:232,248`. `key={`hit-${p.date}`}` assumes date uniqueness. The server contract guarantees one point per day, so this is contract-trusting, not wrong — but the component is generic and filters its input defensively elsewhere; an index-suffixed key would cost nothing.

## PRAISE

- **State discipline is exemplary.** Neither component contains a single `useEffect`; drag bookkeeping lives in a ref mutated only by handlers, dot refs land via callback refs, and the index clamp happens at render time instead of a fix-up effect (`SwipeCarousel.tsx:79-84`). Both strict hook rules (`set-state-in-effect`, `refs`) are satisfied in spirit — I found no render-time ref reads slipping past lint.
- **LineChart's NaN-safety is complete.** Every degenerate shape I probed is handled by construction: empty → "No data yet" (`:125-131`), single point → centered dot, no line/area (`:64, :149-151, :224-229`), non-finite filtered (`:122`), `yMax` can never be 0 (`%` → 100; else `niceCeil ≥ 1`, `:79-87, :133-134`), out-of-range values clamp into the plot (`:68-73`), and `formatDay` degrades gracefully on malformed dates instead of "undefined NaN" (`:104-110`) — including the UTC-midnight date-parsing trap most people miss. The shipped tests cover empty, single, non-finite, all-non-finite, %-fixed scale, and auto-scale.
- **The axis lock + `touch-action: pan-y` pairing is correct** (`SwipeCarousel.tsx:125-146`, `SwipeCarousel.css:14`): vertical-dominant gestures are surrendered so page scroll survives, capture is deliberately deferred until horizontal lock so `click` retargeting can't break interactive page content, and the snap decision reads the raw event delta rather than the damped state (`:158-164`) — a subtle staleness bug avoided on purpose.
- **The ARIA carousel/tabs contract is textbook**: `aria-roledescription="carousel"` on a labeled region, tab↔panel wired both ways with `useId`, roving tabindex, arrow-wrap + Home/End per the APG, `aria-hidden` + `inert` on inactive pages (React 19.2 supports the boolean `inert` prop natively — verified), and reduced-motion kills both the track and dot transitions in CSS.
- **Always-visible readout as the tooltip's home** (`LineChart.tsx:157-159, :275-282`) — the latest value is never gated behind a pointer, and `role="status"` announces hover/focus changes politely.
- **Drag re-renders are cheap by design**: `setDragX` per move re-renders only the carousel shell; the page subtrees bail out on referentially stable child elements, so five charts don't reconcile at pointer-move frequency.

## Bottom line

Fix B1 (three-line change plus regression tests) before merge; S1 belongs in the same patch. S2/S3 are polish that should land soon after. The rest of both components is well above the bar — the LineChart in particular can ship as-is.
