# Review — Batch 2: Library → Uploads + PDF Viewer (F-155 swipe focus)

**Reviewer:** independent senior React/TS reviewer (did not write this code)
**Branch:** `feat/redesign-library` @ `2c2d4ad` (off `rebuild`)
**Scope:** `client/src/pages/Uploads.tsx`/`.css`, `client/src/pages/UploadViewer.tsx`/`.css`, their test files
**Tickets:** F-128 (Uploads slice), F-155 (paired with F-130)
**Verification run (this review, read-only):** `vitest run` on both test files — **58/58 pass**; `tsc -p tsconfig.app.json --noEmit` — **clean**; `eslint … --report-unused-disable-directives` — **clean**.

## Verdict: **APPROVED — 0 BLOCKER, 2 SHOULD-FIX, 2 NIT**

The F-155 gesture is correctly built and is a faithful, understood port of `SwipeCarousel.tsx`'s proven Pointer Events model — not a superficial copy. Axis-lock, deferred pointer capture, primary-button-only arming, and all three cleanup paths (`pointercancel`/`pointerleave`/`lostpointercapture`) are present and logically sound. The zoom/pan interaction correctly disarms the swipe above fit-width. The lazy single-`<img>`-mount architecture is untouched — the drag is a `translateX` nudge on a wrapper div around the *same* `PageImage`, never a sliding track. No regression to arrow/keyboard/rotate/zoom/reorder — confirmed both by reading the diff (toolbar buttons are byte-identical, just re-wrapped) and by the full green test run. F-128 reskin on both pages matches the established hub-header recipe (`SkylineHeader`+`DancheongRail`+`CityCard`) from the Today/Progress batch, and both files are hex-clean. The two SHOULD-FIX items are test-coverage gaps, not logic bugs — I traced both code paths line-by-line and they are correct as written.

---

## Ticket checklist

| # | Claimed | Actually done? | Evidence |
|---|---|---|---|
| F-155 | Pointer-based swipe-to-turn-page, axis-locked, zoom-aware | **YES** | `UploadViewer.tsx:547-629` (handlers), `:1000-1034` (wiring). All 8 new tests in `UploadViewer.test.tsx:652-788` dispatch real `pointerdown/move/up/cancel` sequences (not a synthetic `swipe` event) and pass. |
| F-130 (PDF-viewer half) | Touch swipe on the viewer works | **YES, this half** | Same evidence as F-155 — `onPointerDown`+friends are real DOM pointer handlers, and `touchAction` is set correctly per zoom state (see F-155 verdict below). The carousel half of F-130 (`SwipeCarousel.tsx`) is untouched by this diff — out of this batch's scope. |
| F-128 (Uploads list) | Hub-header recipe + CityCard rows + giwa/watermark empty state | **YES** | `Uploads.tsx:192-209` (`SkylineHeader`+`DancheongRail`), `:255` (`CityCard tone="plain" rail` per row), `:233-241` (`.km-giwa`/`.km-hangul-watermark` empty state). Tests: `Uploads.test.tsx:337-350` (header/rail/CityCard count), `:352-360` (empty-state classes + `data-glyph`). |
| F-128 (Upload viewer) | Same recipe + CityCard page surface | **YES** | `UploadViewer.tsx:772-792` (header/rail), `:1000` (`CityCard tone="plain" rail` around the page box). Test: `UploadViewer.test.tsx:790-803`. |
| F-128 non-negotiable — no hardcoded hex | — | **YES** | `grep -nE "#[0-9a-fA-F]{3,8}"` over all 4 touched source/CSS files returns nothing. |
| F-128 non-negotiable — both themes, WCAG AA | — | **YES, by inheritance** | New CSS (`Uploads.css`, `UploadViewer.css` diff) only adds spacing/layout rules and one text color (`--paper-mute`, `UploadViewer.css:108`) — that token is documented in `styles/index.css:187` as "AA-checked against every dark host it can sit on" and is already the app-wide convention for meta/secondary text (used by `.km-resources__pager-count` etc., unchanged). No new color decision was made in this diff. |

---

## F-155 gesture-correctness verdict (explicit, per-mechanism)

- **8px axis-lock (horizontal vs. vertical):** **CORRECT.** `SWIPE_AXIS_LOCK_PX = 8` (`UploadViewer.tsx:178`), gated identically to `SwipeCarousel.tsx:170` — no move is committed to an axis until `|dx|` or `|dy|` clears 8px (`:571`). A vertical-dominant move surrenders immediately via `endSwipe()` (`:583-589`), so native scroll is never hijacked. Test: `UploadViewer.test.tsx:695-716` sends `dy=140` vs `dx=10`/`dx=130` and asserts the page never changes, including a large horizontal delta sent *after* the vertical surrender (regression-proofs against "re-arming").

- **`setPointerCapture` deferred until axis locks `'h'`:** **CORRECT.** Only reached inside the `d.axis = 'h'` branch (`:573-580`), feature-detected + try/caught exactly like `SwipeCarousel.tsx:176-182`. An undecided ('none'-axis) gesture never captures, so it can't break interactive content underneath it before the axis is known.

- **Primary-button-only:** **CORRECT.** `if (!e.isPrimary || e.button !== 0) return;` (`:553-554`), identical guard to `SwipeCarousel.tsx:151`. Test: `UploadViewer.test.tsx:718-737` exercises both a `button: 2` (right-click) and an `isPrimary: false` (second touch point) and asserts neither arms anything.

- **Stuck-drag safety — `pointercancel`/`pointerleave`/`lostpointercapture` all end the drag cleanly:** **CORRECT by inspection, PARTIALLY tested (see S-1).** All three handlers are wired (`onPagePointerCancel` `:614-618`, `onPagePointerLeave` `:620-629`, `onLostPointerCapture={endSwipe}` at `:1013`) and each unconditionally or conditionally (per `SwipeCarousel`'s own documented logic — leave only ends a still-uncaptured `'none'`-axis gesture) clears `swipeRef.current` so a new `pointerId` is never blocked by the `if (swipeRef.current !== null) return;` guard in `onPagePointerDown` (`:555`). Only `pointercancel` has a dedicated test (`UploadViewer.test.tsx:740-757`, which does verify the actual invariant that matters — a fresh swipe with a **new** `pointerId` works immediately after). `pointerleave` and `lostpointercapture` have **no** dedicated test — see S-1.

- **Snap threshold (48px / 20% width) calls the SAME `goPrev`/`goNext` as the arrows:** **CORRECT, verified.** `SWIPE_MIN_SNAP_PX = 48`, `SWIPE_SNAP_FRACTION = 0.2` (`:180-182`), threshold computed off the raw release delta not the damped state (`:604-607`), and `goNext()`/`goPrev()` (`:608-609`) are the exact same functions bound to the toolbar buttons (`:815-832`) — there is only one definition of each (`:534-535`), not a duplicate implementation for the gesture path. Confirmed identical-function-call by reading, not just by test.

- **Zoom interaction (`swipeEligible = zoom <= FIT_ZOOM`):** **CORRECT.** `:540`. Above fit-width, `onPagePointerDown` bails before arming anything (`:548`), and `touchAction` on the page box switches `'pan-y'` → `'auto'` (`:1004`) so the browser's native two-axis pan takes over instead of the swipe-reserving single-axis mode. Test: `UploadViewer.test.tsx:759-772` zooms to 125% then dispatches a full valid leftward swipe and asserts the page does **not** turn — this is a real behavioral test of the disarm, not just a prop assertion.

**Net F-155 verdict: the gesture is built correctly.** The one gap is in test *breadth*, not implementation correctness (detailed in S-1 below) — I traced the `pointerleave`/`lostpointercapture` code paths by hand against `SwipeCarousel`'s already-proven equivalent and they match line-for-line in intent.

---

## Findings

### SHOULD-FIX

**S-1 — `pointerleave` and `lostpointercapture` cleanup paths have no dedicated test; a regression there would ship silently.**
`UploadViewer.tsx:620-629` (`onPagePointerLeave`) and the `onLostPointerCapture={endSwipe}` wiring at `:1013` are exactly the two mechanisms the ticket calls out by name for "no stuck drag." Of the 8 new tests (`UploadViewer.test.tsx:652-788`), only `pointercancel` (`:740-757`) exercises a mid-gesture abort-and-recover. No test dispatches a `pointerleave` event (e.g., axis still `'none'`, pointer leaves the box, then a *new* `pointerId` must still be able to arm a gesture) or a `lostpointercapture` event. Concretely: if someone later inverted the `d.axis !== 'h'` guard at `:628` (a one-character typo away — `!==` → `===`), or deleted the `onLostPointerCapture` prop entirely, the full 58-test suite would still pass. This is the same gap `SwipeCarousel.test.tsx` itself has (no `pointerleave`/`lostpointercapture` test there either — confirmed via grep), so it isn't a regression introduced by this PR specifically, but the ticket explicitly asked "do the tests exercise pointercancel-cleanup" as one of the 8 named scenarios, and only 1 of the 2 documented stuck-drag exits is actually covered. Recommend adding one `pointerleave`-while-`'none'`-axis test and one `lostpointercapture` test (both cheap — same `fireEvent` pattern already in the file), for this component and ideally back-filled onto `SwipeCarousel.test.tsx` too.

**S-2 — Design-mock deviation: the mock's floating overlay page-turn arrows aren't implemented (pre-existing, not introduced by this PR).**
`km-final.html:140-142` (the approved Uploads/PDF mock) shows circular `.arrow` buttons absolutely positioned *over* the page image itself (`left:8px`/`right:8px`, inside the `.pdf` card). The shipped viewer instead keeps Prev/Next as ordinary buttons in the toolbar row above the `CityCard` (`UploadViewer.tsx:812-832`). This is **not a regression from this diff** — `git diff rebuild` shows the toolbar's button markup is byte-for-byte unchanged, only re-wrapped — so it isn't this batch's bug to fix, but since the design-fidelity bar for F-128 is "the actual character-device components, not a flat token reskin," worth a follow-up ticket if pixel-fidelity to the mock's floating-arrow affordance matters. Functionally the toolbar buttons + swipe already satisfy the ticket's "swipe (or arrows) to change page" requirement.

### NIT

**N-1 — No `pageCount < 2` early-bail before arming the swipe gesture.**
`SwipeCarousel.tsx:147` bails (`if (count < 2) return;`) before doing any drag bookkeeping when there's nothing to page between. `UploadViewer.tsx`'s `onPagePointerDown` (`:547-561`) has no equivalent — a single-page upload still arms the ref, computes damped `dx` both directions (`pageNum <= 1 && pageNum >= pageCount` are both true, so every drag is damped 3:1), and calls `setSwipeDragX` on every move. Harmless (the page can never actually change since both `goPrev`/`goNext` are no-ops via `goToPage`'s clamp), just wasted renders for the — presumably rare — single-page-book case.

**N-2 — Swipe threshold constants are duplicated from `SwipeCarousel.tsx` rather than imported.**
`UploadViewer.tsx:177-184` restates all four tuning constants with a comment explaining why (module-private, non-exported, the two gestures commit differently). This is a documented, deliberate choice, not an oversight, and four numbers is a low duplication cost — noting only because a future tuning pass on one gesture's feel needs to remember to check the other file too.

### PRAISE

**P-1 — The "no sliding track" constraint is genuinely honored, and the interaction it produces is a nice, unintended-looking touch.**
On a successful page turn, `pageNum` changes (remounting a fresh `PageImage` via its `${pageNum}-${retryToken}` key) in the same batched update that resets `swipeDragX` to `null` (`UploadViewer.tsx:608-611`). Because the wrapper div (`.km-upload-viewer__pageDrag`) itself never unmounts, the new page's image appears already offset at the old drag position and then CSS-transitions to rest (`UploadViewer.css:93-98`) — effectively "the new page slides in from the direction you swiped" without ever mounting two images at once. Worth calling out because it would have been easy to get this subtly wrong (e.g., reset the transform in the same tick as the key change and lose the animation, or keep the old image mounted a beat too long and violate the lazy-mount contract) — it doesn't.

**P-2 — Test discipline matches the ticket's own bar.** All 8 new gesture tests dispatch full, realistic `pointerId`/`isPrimary`/`button`/`clientX`/`clientY` sequences (`UploadViewer.test.tsx:97-148` for the shared helpers) rather than a shortcut synthetic event, and specifically assert on the resulting `img[src]` / pager text, not just internal state — these would catch a real regression in the axis-lock, the zoom-disarm, and the primary-button guard.

**P-3 — Cross-page consistency with the earlier Today/Progress batch.** Both `Uploads.tsx` and `UploadViewer.tsx` adopt the identical `SkylineHeader` + rail-divider + `CityCard tone="plain" rail` recipe already established and fixpassed in the prior batch (per `docs/redesign/REVIEW_batch1-*.md`), rather than inventing a new pattern — reduces the surface a future design-fidelity pass has to re-check.

---

## Coordination observations

- No overlap/conflict with `docs/redesign/REVIEW_batch2-vocab.md`'s BLOCKER (that review's B-1 is `MyVocabLists`/Vocab-specific; this diff never touches that file).
- `SwipeCarousel.tsx`/`.css`/`.test.tsx` are untouched by this diff (confirmed via `git diff rebuild --stat`) — the PDF-viewer gesture is a deliberate, documented reimplementation, not a shared-component change, so this review's findings (S-1 in particular) don't retroactively block anything already shipped for `SwipeCarousel`, though S-1's test-gap observation applies equally there and would be a cheap shared fix.
- F-130 ("Carousels + PDF viewer" touch-swipe) is only half-closed by this batch — the carousel half is out of scope here and should stay tracked separately until `SwipeCarousel`'s own touch behavior is (re-)verified on a real device/CI a11y pass.
