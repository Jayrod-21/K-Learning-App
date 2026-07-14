# REVIEW — Mobile-Hardening Capstone (`feat/mobile-hardening` @ 9a9389f)

**Reviewer role:** Independent senior design/mobile engineer. Did not author this code.
**Scope:** (1) SkillsCompare TOPIK-scale overflow fix, and (2) whole-batch **360px mobile-correctness capstone** across all four changes — SkillsCompare overflow, `useModalA11y` scroll-lock leak, `SwipeCarousel` touch swipe, Today three-carousel restructure (+ the MyVocabLists/ReviewVocab grammar-purge that rode along).
**Method:** static reasoning about real-device 360px behaviour (jsdom cannot exercise layout, touch, scroll-snap, or scroll-timeline). `client` `tsc --noEmit` passes clean.

---

## VERDICT: ✅ PASS — genuinely mobile-safe to redeploy. 0 BLOCKERS.

All four changes hold up under 360px reasoning. The single most important structural fact — and the reason I can sign this off with confidence rather than hope — is that **the page's horizontal axis is clipped at the shell** (`.km-shell__scroll { overflow-x: hidden }`, index.css:1019–1024). Nothing any page renders can produce a page-level horizontal scrollbar; only the two *intended* nested scroll rails (the SkillsCompare picker, the Today peek track) scroll on x, each self-contained. That is a real architectural guarantee, not a per-fix promise, and it is what the previous mobile-broken redesign lacked discipline around.

Findings: **0 BLOCKER · 1 SHOULD-FIX · 4 NIT · 6 PRAISE.** One residual watch-item (not a regression) called out for the user at the end.

---

## JOB 1 — SkillsCompare TOPIK-scale overflow checklist

| Check | Result | Evidence |
|---|---|---|
| All 7 pills (TOPIK 1–6 + Native) reachable at 360px | ✅ | `SkillsCompare.css:33` `overflow-x: auto` + `:56` `.km-skillscompare__pick { flex: 0 0 auto }` → internal scroll rail; pills keep natural width, nothing permanently clipped. `scroll-snap-type: x proximity` (:39) won't fight small scrolls. |
| New rules WIN over pre-existing same-name rules in index.css | ✅ | New selectors are ancestor-qualified `.km-skillscompare .km-skillscompare__picker` = specificity (0,2,0); index.css `.km-skillscompare__picker` (index.css:2023) = (0,1,0). New wins **regardless of source order**. |
| index.css didn't use `!important` on these rules | ✅ | Read index.css:2015–2089 — no `!important` anywhere in the SkillsCompare block. Specificity is decisive. |
| Picker is bounded so the rail (not the page) scrolls | ✅ | `min-width: 0` + `max-width: 100%` (:35–36) let the flex item shrink below its ~480–560px intrinsic content to the pickerrow's bounded width; excess becomes the internal rail. |
| Stack-below-480px works | ✅ | `@media (max-width: 480px)` sets pickerrow `flex-direction: column` (:69–72) → picker gets full card width before it ever needs to scroll. |
| Serves BOTH consumers | ✅ | `SkillsCompare` renders root `.km-skillscompare` for every non-empty state (SkillsCompare.tsx:109) and imports `./SkillsCompare.css` unconditionally (:36). Consumers: `Progress.tsx:858` and `Diagnostic.tsx:1153`. Both covered by one import. |
| No hardcoded hex | ✅ | Scrollbar thumb uses `var(--line-strong)` (:29); token exists. |

**JOB 1 verdict: correct and complete.** The fix is general (survives a 7th level / longer translation / wider font), matches the house colocate-don't-touch-index.css convention, and is honest about the dead index.css rules it now shadows (flagged as a follow-up in the file header — see NIT-1).

---

## JOB 2 — 360px mobile-correctness capstone (per-change reasoning)

### A. No page-level horizontal overflow anywhere ✅
- **Structural backstop:** `.km-shell__scroll` (the element wrapping `<Outlet/>`, Shell.tsx:153) is `overflow-x: hidden` (index.css:1022). No page can x-scroll. The document scroller is body (see B).
- **Today peek track (the one to trace):** `.km-today__peekOuter` uses `margin: 0 -2px` (Today.css) → it is 4px *wider* than its section, reclaiming the 2px `.km-today__tilePage` inset for edge alignment. At 360px that 4px is clipped by the shell's `overflow-x: hidden` — cosmetic only, no page scroll. The peek content itself lives in `.km-today__peekTrack { overflow-x: auto; overflow-y: hidden }` — a self-contained rail. Tiles `flex: 0 0 78%` + track `padding-inline: 11%` → 78 + 11 + 11 = 100% (center tile + two 11% peeks). Math is clean; the row scrolls internally, never the page.
- **SwipeCarousel (Carousels 1 & 3):** viewport `overflow: hidden`, pages `flex: 0 0 100%`, track translated by JS — a fixed-width paging model that cannot push page width regardless of child count (3 looped pages in C1, 1 in C3).
- **SkillsCompare picker:** own `overflow-x: auto` rail (Job 1).
- **Conclusion:** only the two intended rails scroll-x. Nothing pushes the body sideways.

### B. Scroll-lock genuinely restores global scroll ✅
- **Is body the scroller?** Yes. `html, body, #root { min-height: 100vh }` with no `height`/`overflow` (index.css:457–463); `.km-shell { min-height: 100dvh }` flex column (index.css:1004). `.km-shell__scroll { flex: 1; overflow-y: auto }` never bounds its own height (the min-height chain grows with content), so its `overflow-y: auto` is inert and the **document/body** is the real vertical scroller. Therefore `document.body.style.overflow = 'hidden'` genuinely locks page scroll — and this is the *pre-existing, unchanged* lock mechanism; the diff only fixes the bookkeeping.
- **Ref-count correctness:** `acquireScrollLock` captures `baselineOverflow` exactly once at count 0→1; `releaseScrollLock` restores exactly once at count→0, with `Math.max(0, …)` guarding underflow (useModalA11y.ts:73–92).
- **Any path where count stays >0 after all modals close?** No.
  - Effect gated `if (!open) return` *before* acquire (useModalA11y.ts:149,154); cleanup (release) is only registered on the open path, so acquire/release are always paired (useModalA11y.ts:165–167).
  - React guarantees the cleanup for every effect that ran, including on unmount-while-open → release fires.
  - `onClose` identity churn (dep array `[open, onClose]`) re-runs cleanup→setup = release-then-acquire; count nets unchanged, and the re-capture reads the just-restored true baseline `''` — no corruption.
  - StrictMode dev double-invoke (setup→cleanup→setup) nets to count=1 while open, 0 after close — balanced.
- **Restored value is the true baseline.** First-open captures `document.body.style.overflow` before writing `'hidden'`; with no other code touching it, that is `''` → last-close restores `''` → body scrolls. This is exactly the leak the old per-instance capture had (second modal capturing `'hidden'` as its baseline and writing it back permanently). Fix is correct and well-reasoned.

### C. Swipe preserves vertical scroll while enabling horizontal swipe ✅
- Axis lock at the 8px threshold (SwipeCarousel.tsx:178–201): vertical-dominant → `endDrag(); return` **before any `preventDefault`** → native page scroll proceeds; `touch-action: pan-y` (SwipeCarousel.css) already lets the browser own vertical during the sub-8px ambiguous phase.
- `preventDefault()` is reached **only** after `d.axis === 'h'` (guard at :202, call at :221) and only when `e.cancelable`. A real **diagonal drag** resolves to whichever axis dominates at 8px: dy>dx surrenders to the page; dx>dy captures the carousel. Vertical scroll is never suppressed for a gesture the user meant as scroll.
- The added per-move `preventDefault` on 'h' is a genuine fix, not a regression: it suppresses the trailing synthetic click so a short h-drag that springs back can't "activate" the button under a carousel page. On browsers where pointermove `preventDefault` doesn't stop scroll (Safari), `touch-action: pan-y` + `overscroll-behavior-x: contain` still cover it.

### D. Touch-target + tap-vs-swipe on the Today peek tiles ✅
- The peek tiles are **native CSS scroll-snap**, not `SwipeCarousel` — so the hand-rolled tap-vs-swipe machinery doesn't apply, and the browser's native "suppress click after a scroll-drag" behaviour handles it. A horizontal swipe scrolls the rail and fires no button; a stationary tap fires the button. `scroll-snap-stop: always` (Today.css) enforces one-tile-per-fling.
- `.km-today__peekTrack` has default `touch-action: auto` + `overflow-y: hidden`, so a **vertical** drag starting on a tile bubbles to page scroll (no vertical trap). `overscroll-behavior-x: contain` keeps an end-of-rail fling out of the browser's edge-swipe-back.
- Carousel 3 (TOPIK, single page): `onPointerDown` early-returns on `count < 2` (SwipeCarousel.tsx:156) → no drag armed, taps work, dots/drag no-op. Correct.

### E. Reduced-motion / AA / safe-area ✅ (one NIT)
- **Reduced-motion:** peek "pop" disabled via `@media (prefers-reduced-motion: reduce) { animation: none }` (Today.css); `.km-today__tileBtn` hover-lift already gated (Today.css:91–98); SwipeCarousel track transitions gated (SwipeCarousel.css:46). Honored.
- **AA:** new text surfaces use `--paper-dim` (peekEmpty) — in Day theme `#40492F` (dark, high contrast on light paper) and Night `#CBD2ED` (light on dark); both comfortably AA. No hardcoded hex in either new/changed CSS file (grep clean). See NIT-2 for the peek-neighbor opacity edge.
- **Safe-area:** untouched and intact — statusbar `env(safe-area-inset-top)` (index.css:1017), bottom nav `env(safe-area-inset-bottom)`. Nothing in this batch touches insets.

### F. Grammar-purge rider (MyVocabLists / ReviewVocab) — mobile-neutral ✅
- `visibleLists = lists.filter(l => kinds.includes(l.kind))` (MyVocabLists.tsx:184) is a pure render-time display filter; empty/error/loading branches all switched to `visibleLists` consistently. No layout or overflow impact. Kept out of `load`'s `useCallback` deps deliberately (correct — preserves stable `load` identity for the Sheet focus effect). Root-cause reasoning in the header is sound.

---

## FINDINGS

### BLOCKER — none.

### SHOULD-FIX
- **SF-1 (latent, cross-repo) — the scroll-lock's correctness depends on body remaining the document scroller.** Today that holds (min-height chain, §B). But `.km-shell__scroll` is declared `overflow-y: auto`; if any future ancestor ever gains a fixed/`100dvh` *height* (not min-height), that element becomes the scroller and `document.body.style.overflow='hidden'` would silently stop locking the modal backdrop. This is **not a regression** (pre-existing mechanism) and **not a 360px blocker**, but the lock and the scroll owner are coupled implicitly. Recommend a one-line comment in `useModalA11y` acquire noting "assumes body is the document scroller (shell uses min-height, not height)" so the coupling is discoverable. Filing as SHOULD-FIX because it's the one place the batch's safety rests on an unstated invariant.

### NIT
- **NIT-1 — dead index.css rules.** The old `.km-skillscompare__pickerrow/__picker/__pick` rules in index.css:2015–2043 are now fully shadowed by SkillsCompare.css and serve no purpose. Already self-flagged as a follow-up migration in the CSS header. Harmless (specificity keeps them inert), just cruft.
- **NIT-2 — peek-neighbor text at `opacity: 0.72`.** In scroll-timeline-capable browsers (Chrome/Edge 115+) the off-center peek tiles animate down to `opacity: 0.72`, which can pull their text under AA *while partially off-screen*. It animates to full opacity at center, is purely a preview affordance, and is disabled under reduced-motion and on non-supporting browsers (flat full-opacity). Acceptable as a decorative peek, but worth knowing it's technically a sub-AA transient for the neighbor labels.
- **NIT-3 — picker doesn't auto-scroll the selected pill into view.** If a user selects a high TOPIK level whose pill sits off the right edge of the rail, it's reachable by scroll but not auto-revealed. Minor; a `scrollIntoView` on selection change would polish it.
- **NIT-4 — Writing tile drops the `generatedTopic` handoff.** The old inline tile passed `state: { generatedTopic }` into `/learn/writing`; the new tile does `navigate('/learn/writing')` with no state. That's correct for this restructure (the generator lives on the Writing page now), but the one-tap-to-a-pre-filled-topic shortcut is gone. Intended per the brief — noting only so it's a conscious trade, not a silent drop.

### PRAISE
- **P-1** — `.km-shell__scroll { overflow-x: hidden }` as a page-wide horizontal backstop is exactly the missing discipline from the prior mobile-broken redesign; every overflow claim in this batch reduces to it.
- **P-2** — The ref-counted lock is the *right* fix (not a band-aid): it correctly identifies that overlapping/auto-opening Sheets don't close LIFO, and the `Math.max(0, …)` underflow guard + capture-once/consume-once discipline are textbook.
- **P-3** — Native CSS scroll-snap for the peek slider instead of extending `SwipeCarousel` is the correct engineering call: the browser owns drag/fling/momentum, so there is *no JS gesture code to get wrong* — the single biggest source of mobile bugs is simply absent.
- **P-4** — `overscroll-behavior-x: contain` on **both** new rails (peek track and SwipeCarousel viewport) + `scroll-snap-stop: always` shows real attention to edge-swipe-back and fling-through, the exact things that only surface on a physical phone.
- **P-5** — `preventDefault` gated strictly on `axis==='h'` + `cancelable` preserves vertical scroll and kills the synthetic-tap-through-the-button bug in one move; the reasoning in the inline comment is correct and complete.
- **P-6** — Progressive enhancement done honestly: `@supports (animation-timeline: view())` degrades to a flat-but-functional peek row, and every failure state (plan-unavailable) degrades to an `ErrorCard` with retry rather than a silently-shrunk carousel.

---

## RESIDUAL MOBILE RISK — what to actually watch on the phone

1. **The batch is safe to ship.** The horizontal axis is clipped at the shell and the two intended rails are self-contained; the scroll-lock leak is genuinely fixed; vertical scroll is preserved through the swipe change. I would redeploy this.
2. **Watch item (not a blocker):** the modal scroll-lock silently assumes body stays the document scroller (SF-1). It's true today and unchanged by this diff — but it's the one implicit invariant the batch's correctness leans on. If a future layout change ever makes an inner element the scroller, modal-backdrop scroll-lock would regress with no test catching it (jsdom can't see it either). Worth the one-line comment.
3. **Verify-on-device suggestion (belt-and-braces, since jsdom proves none of this):** on a real 360px phone, confirm (a) the SkillsCompare picker rail scrolls to reveal Native, (b) the Today peek row flings one tile at a time and a vertical drag on it still scrolls the page, (c) opening then closing the auto-opening TOPIK Study/Mock chooser leaves the page scrollable, and (d) a short horizontal flick on a Today carousel tile does not navigate.

---

## COORDINATION
- No code changes made (review-only, per mandate).
- `client` `tsc --noEmit` = clean at 9a9389f.
- `tone="ochre"` (Hanja tile) and icons `cards`/`hanja` confirmed valid (CityCard.tsx:16/38, Icon.tsx:19/31). Routes `/learn/{vocab,writing,hanja}` confirmed present (App.tsx:133–136); `Writing.tsx` mounts `WritingTopicGenerator` + accepts `location.state.generatedTopic` (Writing.tsx:120/300/745).
- Open follow-ups for the backlog: NIT-1 (delete dead index.css SkillsCompare rules), SF-1 (document the body-scroller invariant in `useModalA11y`), optionally NIT-3 (scroll selected pill into view).
