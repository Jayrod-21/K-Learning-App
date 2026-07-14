# Review: mobile-hardening — scroll-lock ref-count + swipe preventDefault

**Reviewer:** independent senior React/TS review (30yr), did not write this code.
**Branch:** `feat/mobile-hardening` @ `9a9389f` (off `rebuild`)
**Scope:** `client/src/hooks/useModalA11y.{ts,test.tsx}`, `client/src/components/SwipeCarousel.{tsx,css,test.tsx}`
**Method:** static trace of the diff + full current files, cross-referenced every consumer, reasoned through real touch/pointer semantics (jsdom/happy-dom cannot exercise these), ran the actual suite (`npx vitest run` on both test files — 36/36 pass).

## Verdict: PASS, with one live consumer bug surfaced (pre-existing, not introduced by this diff) and one scope gap (duplicate implementation not patched)

The two mechanisms under review — the module-level ref-counted scroll lock and the axis-gated `preventDefault` — are both **correct** by construction and reasoning. Neither leaks, neither breaks vertical scroll. Zero blockers in the two changed files themselves. However, the consumer-compat sweep the task asked for turned up a **real, currently-live bug** in `MockMode.tsx`'s `ExamRunner` (an unmemoized `onClose` colliding with a 1-second countdown re-render, causing focus to thrash in/out of an open `alertdialog` every second) — this predates the diff and isn't caused by it, but it means the honest answer to "do all 9 named consumers still lock/restore correctly" is **no, one does not**, on the focus-restore axis (not the scroll-lock axis, which is unaffected). I'm also flagging that `UploadViewer.tsx` is a hand-rolled duplicate of `SwipeCarousel`'s exact pointer model (per its own doc comment) that was **not** given the same `preventDefault`/`touch-action`/`overscroll-behavior-x` treatment — same bug class, still live there.

---

## (a) Ref-count correctness under overlap + StrictMode — CORRECT

`client/src/hooks/useModalA11y.ts:75-99`:

```ts
let scrollLockCount = 0;
let scrollLockBaselineOverflow = '';

function acquireScrollLock(): void {
  if (scrollLockCount === 0) {
    scrollLockBaselineOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount += 1;
}

function releaseScrollLock(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = scrollLockBaselineOverflow;
  }
}
```

Called from the main effect at `useModalA11y.ts:148-177`, `acquireScrollLock()` at L154, `releaseScrollLock()` at L167 (in the returned cleanup). Traced:

- **Baseline captured only on 0→1**: gated by `if (scrollLockCount === 0)` (L80) — correct, single guard, no way around it.
- **Restore only on N→0**: gated by `if (scrollLockCount === 0)` *after* the decrement (L96) — correct.
- **Clamp at 0**: `Math.max(0, scrollLockCount - 1)` (L95) — an unpaired extra release can't go negative. In practice this is unreachable anyway: `acquireScrollLock`/`releaseScrollLock`/the two module vars are **not exported** (confirmed via grep — zero references outside this file), and the only caller is the effect's own acquire/cleanup pair, which is structurally symmetric — `if (!open) return;` (L149) sits *before* `acquireScrollLock()`, so there is no code path that calls one without the other for the same effect instance. No leak path exists.
- **Re-open after full close re-captures the CURRENT baseline**: yes — since the guard is `scrollLockCount === 0`, a fresh 0→1 transition always re-reads `document.body.style.overflow` at that moment, not a stale value. Covered explicitly by the new test `useModalA11y.test.tsx:275-288` (changes baseline to `'scroll'` between closes, verifies the second lock/unlock cycle honors the new baseline).
- **StrictMode double-invoke**: React 18 StrictMode (dev-only) runs `setup → cleanup → setup` for effects before the first real commit settles, synchronously (no browser paint in between, and — per React's actual implementation — this is done as a whole-subtree pass, not strictly per-component: mount-all → unmount-all → remount-all for the just-mounted tree). I traced both the per-component and whole-tree-interleaved orderings for two modals mounting together: in both cases the shared counter nets out to the same, correct final state, because the design is **order-independent as long as acquire/release pairs stay symmetric** — which they do, since every cleanup is the direct closure-paired counterpart of its own setup. This is the structural reason the rewrite is StrictMode-safe: a counter doesn't care *which* instance's acquire/release fires when, only that they're paired. The naive old per-instance capture/restore was **not** order-independent (a second instance's captured "baseline" could be the first instance's `'hidden'`), which is the actual bug class being fixed — not StrictMode, but overlap.
- **Gap**: the StrictMode-safety property above is verified by reasoning, not by a test — the new tests (`useModalA11y.test.tsx:199-288`) call plain `render()`, not wrapped in `<StrictMode>`, even though the app *does* run StrictMode in dev (`client/src/main.tsx:1,15`). SHOULD-FIX (test-coverage gap, not a code defect).

**Does the new overlapping-order test actually reproduce the old leak?** Yes, confirmed by re-deriving the old code's behavior against the test at `useModalA11y.test.tsx:214-241`: under the old per-instance `previousOverflow = document.body.style.overflow` capture, modal B (opened while A is still open) would have captured `'hidden'` as *its* baseline (A already set it). The test's own intermediate assertion — `a.unmount()` then `expect(...).toBe('hidden')` (L232-233) — would **fail under the old code**, because A's cleanup would restore A's captured `'auto'` immediately, while B is still mounted and needs the lock. This is an earlier and clearer failure than even the final "permanently stuck" symptom the bug report describes, so the test doesn't just detect the eventual manifestation, it catches the leak at the first wrong write. Confirmed genuine regression test, not a tautology.

### CONSUMER COMPAT — `useModalA11y` (9 named consumers)

| Consumer | `onClose` identity | Verdict |
|---|---|---|
| `Sheet.tsx:84` | pass-through prop, caller-owned | OK — generic, correctness depends on caller (see rows below) |
| `WordPopover.tsx:124-129` via `Ttmik.tsx:1121,1361` | `useCallback` (`handleClose`) | **OK** |
| `WordPopover.tsx` via `Reading.tsx:686,745` | `useCallback` (`handleClose`) | **OK** |
| `WordPopover.tsx` via `Images.tsx:316-318` | **inline arrow**, not memoized | NIT — see below |
| `UploadTypeModal.tsx` → `Sheet` via `Uploads.tsx:293-295` | **inline arrow**, not memoized | NIT — see below |
| `LearnMenu.tsx:205-210` via `Shell.tsx:124,169` (`closeLearn`) | `useCallback` | **OK** |
| `MyVocabLists.tsx:140-148,312-320` (`closeCreate`) | `useCallback`, with an explicit comment documenting *why* | **OK** |
| `Chat.tsx:809-813` (`dismissContextPopup`, L789) | `useCallback` | **OK** |
| `Tickets.tsx:1128-1131` (`closeFileSheet`) | `useCallback`, with an explicit comment documenting *why* (F-128) | **OK** |
| `Review.tsx:757-764` (`closeCreate`) | `useCallback` | **OK** |
| **`MockMode.tsx` `ExamRunner` (`confirmRef`), L1449-1455** | **inline arrow, NOT memoized** | **BUG (pre-existing) — see below** |

#### `MockMode.tsx` — live focus-thrash bug (pre-existing, not caused by this diff)

`client/src/pages/topik/MockMode.tsx:1449-1455`:

```ts
useModalA11y({
  open: confirming,
  onClose: () => {
    setConfirming(false);
  },
  containerRef: confirmRef,
});
```

`onClose` is a fresh arrow every render. The *same* `ExamRunner` component runs a 1-second countdown interval (`MockMode.tsx:1567-1578`, `setInterval(..., 1000)` → `setRemaining(...)`), which re-renders `ExamRunner` every second for the entire duration of the mock exam — **including while the submit-confirmation `alertdialog` (`confirming === true`) is open**, since nothing pauses the timer for the confirm step.

Per the hook's own effect (`useModalA11y.ts:148-177`), the dependency array is `[open, onClose]`. Every tick: `onClose` changes identity → effect tears down (queues a microtask to refocus whatever was captured as `previouslyActive` *when this particular effect instance mounted*) → effect re-sets-up (captures a *new* `previouslyActive` = whatever is focused *right now*, synchronously, before the queued microtask has run). Tracing two ticks: the queued refocus from tick *N* fires *after* tick *N+1*'s setup has already re-captured — so the target oscillates between "inside the dialog" and "the trigger control behind it" once per second, for as long as the confirm dialog stays open. Concretely: a keyboard/screen-reader user's focus gets yanked out of an open `role="alertdialog"` onto the page behind it, and back, every second.

This is precisely the failure mode two other consumers in this same codebase explicitly guard against and document:
- `Tickets.tsx:1119-1128`: *"An inline arrow here would retrigger that effect on each such render, each time re-capturing 'the element focused right now' as the restore target... `useCallback` keeps the reference stable."*
- `MyVocabLists.tsx:140-146,312-318`: same pattern, same fix.

`MockMode.tsx`'s `ExamRunner` is the one call site that didn't get the `useCallback` treatment, and it's also the one call site with a guaranteed once-a-second re-render while the dialog can be open — the exact precondition the other two comments warn about. **This is not introduced by the ref-count rewrite** (the surrounding effect shape — `previouslyActive` capture + `queueMicrotask` restore + `[open, onClose]` deps — is untouched by this diff); it's a latent bug in a named consumer that the task explicitly asked to verify, so I'm reporting it as found. Scroll-lock itself is *not* broken by this (the acquire/release pair still nets out correctly every tick, since it's synchronous), but I would not sign off "MockMode still locks/restores correctly" without qualification — it locks correctly, it does **not** restore focus correctly while open.

**Recommended fix (not applied — no code changes per review scope):** wrap `onClose` in `useCallback(() => { setConfirming(false); }, [])` at `MockMode.tsx:1451-1453`, matching the established pattern.

#### Two lower-severity NITs (same shape, no active retrigger found)

- `Images.tsx:316-318` passes an inline `onClose={() => { setPopData(null); }}` to `WordPopover` (vs. `Ttmik.tsx`/`Reading.tsx`'s `useCallback`'d `handleClose`). I checked for any interval/poll in `Images.tsx` that would cause a re-render while the popover is open — found none, so this is currently inert. It's inconsistent with the sibling call sites and one accidental future re-render source away from the exact `MockMode` bug above. NIT (harden for consistency).
- `Uploads.tsx:293-295` passes an inline `onClose={() => { setModalOpen(false); }}` to `UploadTypeModal`/`Sheet`. Same check, same result (no active re-render trigger in that file today). NIT.

---

## (b) Swipe fix preserves vertical scroll — CORRECT

`SwipeCarousel.tsx:171-229` (`onPointerMove`), traced against real touch-action/Pointer-Events semantics, not just the jsdom tests:

- **No `preventDefault` before the axis decides**: the 8px lock window is `d.axis === 'none'` (L178); the `preventDefault` call is at L221, gated by `if (d.axis !== 'h') return;` at L202, which sits *after* the axis-decision block. A nascent gesture inside the 8px window never reaches L221. Correct — a nascent vertical scroll is never blocked pre-decision.
- **No `preventDefault` when `axis === 'v'`**: the vertical-surrender branch (L192-200) calls `endDrag()` and `return`s immediately, *before* L202/L221 are ever reached in that same call, and never again for that gesture (the ref is cleared, so subsequent `pointermove`s for this `pointerId` hit the early-return guard at L173). Confirmed no path from "surrendered vertical" to `preventDefault`.
- **CSS placement**: `touch-action: pan-y` (`SwipeCarousel.css:19`) and `overscroll-behavior-x: contain` (`SwipeCarousel.css:28`) are both on `.km-carousel__viewport` — the same element `viewportRef` attaches the pointer handlers to (`SwipeCarousel.tsx:287-297`). This is load-bearing and correct: `touch-action` only applies to the element the touch physically contacts; declaring it on an ancestor would be silently ignored for a touch landing on a descendant.
- **Real-device race reasoning (this is the part jsdom can't tell you)**: `touch-action: pan-y` tells the browser upfront that vertical panning is a *native*, off-main-thread gesture on this element. When a real finger's motion is vertical-dominant, the browser's own gesture recognizer may commit to native scrolling *independently* of — and possibly faster than — this component's 8px JS threshold. Once the browser has committed, subsequent Pointer Events for that same touch become **non-cancelable** (`cancelable: false`) by spec/browser behavior. The code's `if (e.cancelable) e.preventDefault()` (L221) is not defensive boilerplate — it's the correct handling of that race: if the browser wins the race and already started a native vertical pan, the event is non-cancelable, so this call silently no-ops (nothing to veto — a native scroll is already in flight and unaffected). If the JS wins the race (horizontal intent is clear inside the 8px window), the event is still cancelable and the veto works. I don't see a way this can result in a legitimate vertical scroll being blocked: either the browser already owns the gesture (non-cancelable, no-op) or JS has already independently decided `axis === 'v'` and returned before ever reaching this line.
- **Why Pointer Events instead of Touch Events matters here**: React's synthetic event system marks certain event types (`touchstart`/`touchmove`/`wheel`) as passive-by-default at the root listener, which would make `preventDefault()` inside a `touchmove` handler silently fail with a console warning. Pointer events are not on that auto-passive list, so `preventDefault()` inside `onPointerMove` actually takes effect. This is a real, correct design choice, not incidental — worth calling out as a genuine strength (PRAISE).
- **Synthetic-click suppression claim** (`SwipeCarousel.tsx:210-220` comment: *"a browser that has seen `preventDefault()` called during an active touch's move sequence will not replay it as a tap"*): this matches the Pointer Events spec's compatibility-mouse-event suppression rule (UAs must not dispatch compatibility mouse events, including `click`, if `preventDefault()` was called on the `pointerdown` **or any `pointermove`** of that pointer's active sequence) — accurate, and is the actual mechanism that fixes the reported "swipe registers as a tap on the tile underneath" bug (Today's tiles are full-page `<button>`s per the comment at L212-213).

### New tests actually assert the right things

Ran `npx vitest run src/components/SwipeCarousel.test.tsx src/hooks/useModalA11y.test.tsx` — **36/36 pass**.

- `SwipeCarousel.test.tsx:68-91` — vertical-dominant drag: asserts `fireEvent.pointerMove(...)` (the dispatch call) returns `true` (L84), which is exactly "was NOT prevented" per DOM `dispatchEvent` semantics (`dispatchEvent` returns `false` iff a cancelable event had `preventDefault()` called). This is a correct proxy for "scroll preserved" given jsdom/happy-dom can't observe an actual scroll.
- `SwipeCarousel.test.tsx:93-129` — three-move sequence directly asserting: undecided move → not prevented (L108); the move that crosses the threshold horizontally → prevented on that *same* move (L116, not a tick late); a subsequent 'h' move → still prevented (L123, not just the first). This directly matches the code's guard structure and would catch a regression that only prevented the first h-move, or that prevented on the last undecided move.
- Both new tests use `pointerType: 'touch'` explicitly (comment at L36-42 notes correctly that nothing in the component branches on `pointerType`, so this is confirming behavioral parity, not exercising a different code path — an honest description of what the test covers and doesn't).

**Caveat, stated plainly per the task's framing**: none of this — including the real ones I traced above — can be verified by jsdom/happy-dom's `cancelable` defaults (testing-library's `fireEvent` eventMap defaults pointer events to `cancelable: true`, unlike the dynamic `cancelable: false` a real browser can assign mid-gesture once it's committed to a native scroll). The reasoning above is sound but is reasoning, not a running assertion; there is no way to close that gap in this stack short of real-device/BrowserStack testing, which is out of scope here.

### CONSUMER COMPAT — `SwipeCarousel`

| Consumer | Notes | Verdict |
|---|---|---|
| `Progress.tsx:384-394` (Progress by skill) | uses default (non-loop) viewport | **OK**, unaffected |
| `Progress.tsx:877-879` (Attempt history, `loop`) | loop mode | **OK**, unaffected — loop only changes damping/wrap logic, not the preventDefault gate |
| `Today.tsx:583-673` (Review and drills, `loop`) | loop mode | **OK**, unaffected |
| `Today.tsx:719-771` (TOPIK, `cornerSlot`) | corner overlay | **OK** — corner slot is a separate absolutely-positioned child, doesn't intercept the viewport's own pointer handlers except where it paints |

### Scope gap: `UploadViewer.tsx` is a duplicate, unpatched

`UploadViewer.tsx:111-121`'s own doc comment states it is *"reusing `components/SwipeCarousel.tsx`'s exact Pointer Events model"* for its swipe-to-turn-page gesture — but it is a **separate, hand-rolled implementation**, not a consumer of the `SwipeCarousel` component, so this diff's fix does not reach it. Confirmed via grep: `UploadViewer.tsx`'s `onPagePointerMove` (`UploadViewer.tsx:562-591`) has **no `preventDefault` call at all**, and `UploadViewer.css` has **no `touch-action` or `overscroll-behavior-x` declarations** (both greps came back empty). This means the exact "swipe registers as a tap on the underlying content" bug this PR fixes for `SwipeCarousel` is very likely still live on the upload/book viewer's page-turn gesture. Not this diff's fault (different file, not touched, not in the two-file scope this review was scoped to) — flagging as a **coordination item**: whoever owns the mobile-hardening backlog should file a follow-up to port the same `preventDefault`/`touch-action: pan-y`/`overscroll-behavior-x: contain` treatment into `UploadViewer.tsx`, since it explicitly claims parity with `SwipeCarousel`'s model and currently doesn't have it.

---

## Findings summary

**BLOCKER:** none in the reviewed diff.

**SHOULD-FIX:**
1. `MockMode.tsx:1451-1453` (`ExamRunner`) — memoize `onClose` with `useCallback`. Currently causes a real, live focus-thrash (dialog ↔ trigger, every second) while the mock-exam submit-confirmation dialog is open, because of the co-located 1s countdown re-render (`MockMode.tsx:1567-1578`). Pre-existing, not caused by this diff, but this is exactly the consumer-compat check the task asked for, and the honest answer for this one consumer is "no."
2. `UploadViewer.tsx` — port the same `preventDefault`(cancelable-guarded)/`touch-action: pan-y`/`overscroll-behavior-x: contain` fix to its hand-rolled duplicate swipe implementation; it explicitly claims to mirror `SwipeCarousel`'s model and currently doesn't get the fix.
3. Add a `<StrictMode>`-wrapped variant of the overlapping-modal test (`useModalA11y.test.tsx`) — the app runs StrictMode in dev (`main.tsx:1,15`) and the ref-count design's StrictMode-safety is currently established only by reasoning (see §a), not by an assertion.

**NIT:**
1. `Images.tsx:316-318` and `Uploads.tsx:293-295` pass inline (unmemoized) `onClose` callbacks into `useModalA11y` consumers, inconsistent with the `useCallback` pattern established (and explicitly documented) elsewhere in this codebase (`Tickets.tsx`, `MyVocabLists.tsx`, `Review.tsx`, `Chat.tsx`, `Shell.tsx`). Currently inert (no co-located re-render trigger found in either file), but one incidental future change away from reproducing the `MockMode` bug above.

**PRAISE:**
1. The ref-counted design is genuinely order-independent — it's robust to StrictMode's mount/cleanup/remount regardless of whether the double-invoke is per-component or whole-subtree-interleaved, *because* it's a symmetric-pair counter rather than a per-instance value snapshot. That's the correct fix for the actual bug class (overlap-order dependence), not incidental.
2. Choosing Pointer Events over Touch Events sidesteps React's passive-listener default for `touchmove`, which is precisely why `preventDefault()` inside `onPointerMove` reliably takes effect here — a subtle, correct design decision, not just an API preference.
3. The `if (e.cancelable) e.preventDefault()` guard is correctly reasoned against the real browser race between `touch-action`-driven native scroll commitment and the 8px JS axis lock, not defensive boilerplate.
4. Test comments throughout both new test blocks accurately describe *why* each assertion matters and what specifically would regress if it failed — genuinely useful for the next person touching this code, not filler.

---

## Explicit answers to the two required verdicts

**(a) Ref-count correctness under overlap + StrictMode:** Correct. Baseline capture/restore is gated exactly at the 0→1 / N→0 edges, clamped at 0, unreachable from outside the module (no exports), and structurally symmetric per effect instance — so it is safe under arbitrary overlap ordering and under StrictMode's double-invoke (verified by reasoning through both possible invocation orderings; not yet verified by a StrictMode-wrapped test — SHOULD-FIX #3 above).

**(b) Does the swipe fix preserve vertical scroll:** Yes. `preventDefault` is unreachable before the axis lock decides and unreachable whenever the axis is `'v'`; the only path to it requires `d.axis === 'h'`, which by construction excludes vertical gestures. The `cancelable` guard correctly handles the real-device race against `touch-action: pan-y`'s native scroll commitment without ever vetoing an already-native vertical pan.

## Coordination

- File a follow-up ticket for `UploadViewer.tsx` (same bug class, unpatched duplicate implementation — see scope-gap section above).
- Consider fixing `MockMode.tsx:1451-1453`'s `onClose` in the same PR or immediately after, given it's a one-line, well-precedented fix (`useCallback(() => setConfirming(false), [])`) and the bug is currently live (focus thrash in an open `alertdialog`, once a second, for the duration of every mock exam's submit-confirmation step).
