# REVIEW — Mobile-Correctness Capstone (Round 3)

**Branch:** `feat/mobile-hardening` @ `5621256`
**Diff reviewed:** `5ffbc7c..5621256` (Today.tsx/.css, UploadViewer.tsx/.css, Shell.tsx, styles/index.css)
**Reviewer:** independent senior mobile engineer (did not write this code)
**Method:** static reasoning at 360px + real-touch semantics; the suite is happy-dom (no layout, no compositor), so every mobile-only claim below is reasoned from spec/CSS, not observed.

---

## VERDICT: MOBILE-SAFE TO DEPLOY — 0 blockers.

All four fixes are mobile-correct by rigorous reasoning. The PDF swipe is, for the first time, built on the spec-sanctioned mechanism rather than a re-tweak of the broken approach. The safe-area fix is correct *specifically because* of this app's `apple-mobile-web-app-status-bar-style: default` config, and no page-level horizontal overflow is reachable (`.km-shell__scroll { overflow-x: hidden }` is a hard clip). Findings are all SHOULD-FIX-or-below.

- **BLOCKERS: 0**
- **SHOULD-FIX: 1** (documented residual on the PDF swipe — a design limit, not a defect)
- **NIT: 2**
- **PDF-swipe on-device confidence: 88%**

---

## Fix 1 — PDF swipe (the one that failed twice)

### Does the mechanism now actually turn pages on a real phone?

**Yes, the wiring is correct and spec-backed.** This is a *materially different* fix from rounds 1–2, not another tweak of the same path.

1. **Non-passive native `touchmove` gives JS first-refusal — wired right.**
   `el.addEventListener('touchmove', onTouchMove, { passive: false })` (`UploadViewer.tsx:892`). Per the UI Events / CSSOM-view spec, a **non-passive** `touchmove` listener obligates the engine to dispatch to the main thread and honor `preventDefault()` *before* the compositor may commit a scroll. This is the exact guarantee that Pointer Events could not provide on a genuinely-scrollable box (the round-2 root cause), and it is the mechanism every production touch carousel (Swiper, Embla) relies on. The listener is attached to the real scroll box (`pageBoxEl`), touchmove is the only one forced non-passive, and the other three (`touchstart`/`touchend`/`touchcancel`) stay passive — correct, since only touchmove ever calls `preventDefault`.

2. **`preventDefault` fires ONLY on locked-horizontal → vertical scroll survives.**
   The touch handler (`UploadViewer.tsx:832-860`) returns before any `preventDefault` while the axis is `'none'` (<8px, line 839) and calls `endSwipe()` + returns on `'v'` (lines 840-845) — `preventDefault` is reached only at line 853, after the axis has locked `'h'`. So a vertical-dominant thumb drag is surrendered untouched and native `pan-y` scroll of a tall scan proceeds. This is the single most important correctness property and it is right. Verified by the regression test `leaves a vertical-dominant touch drag alone` (`UploadViewer.test.tsx:790`, asserts `dispatchEvent` returns `true` = not prevented) and its twin `calls preventDefault on every touchmove once the axis locks horizontal, not before` (`:765`).

3. **No touch/pointer double-fire.**
   Every pointer handler opens with `if (e.pointerType === 'touch') return;` (`:690,707,751,767,774,785`). On a phone the engine synthesizes pointer events from touches, but those synthetic pointerdowns bail before touching `swipeRef`, so on-device `swipeRef` is driven *exclusively* by the native touch handlers. One shared ref, one writer per device class — no corruption path.

4. **Listener-attach bug fixed correctly.**
   The effect is keyed `[swipeEligible, pageBoxEl]` and reads `pageBoxEl` — the state mirror set by the `attachPageBox` callback ref (`:548-555`). A ref's `.current` is invisible to React's dep diffing, so keying on the *state* node is the standard "DOM-node-as-dependency" pattern and guarantees the listeners attach the moment the box mounts under `canView`. The `swipeLatestRef` (`:802-811`, synced in a commit-phase effect) keeps `pageNum`/`goPrev`/`goNext` fresh without re-churning listeners every page turn — sound; the effect commits before any user touch can read it, so there's no real staleness window.

5. **iOS-specific round-1 fixes still in place** and independent of this: `draggable={false}` + `onDragStart` veto + `-webkit-touch-callout: none` / `-webkit-user-drag: none` neutralize the `<img>` native drag-source and long-press callout, which are a separate subsystem from scroll arbitration.

### Honest confidence it finally works on-device: **88%**

The mechanism is now correct where it was fundamentally broken before, and it is the industry-standard solution — that is why my confidence is high, not merely hopeful.

**Residual risk (the 12%), named:**

- **Diagonal-onset swipe under `touch-action: pan-y`** *(SHOULD-FIX — a design limit, not a bug).* While the axis is `'none'` (first <8px) the handler does not `preventDefault`. If the *very first cancelable* `touchmove` of a gesture is vertical-dominant, `pan-y` permits the compositor to begin a native vertical pan and mark subsequent moves `cancelable === false`; a later `'h'` lock's `preventDefault` is then correctly guarded by `if (e.cancelable)` (`:853`) and no-ops, so that one gesture won't turn the page. **For a deliberate horizontal page-turn this is unlikely** — the intended gesture's opening vector is horizontal, `pan-y` forbids native horizontal pan, so JS wins the arbitration cleanly — and it self-corrects on the next swipe. It cannot break vertical scroll. The only way to fully close it is `touch-action: none` while eligible, which would forfeit native vertical scroll of a tall scan (unacceptable) — so `pan-y` + non-passive touchmove is the correct trade, and this residual is inherent to it. Worth a one-line known-limitation note; not worth a code change.
- **Not yet verified on Jared's device.** happy-dom exercises the handler logic and even proves the native (non-synthetic) path is wired (the tests dispatch real `touchstart/move/end`), but it cannot reproduce the compositor race — the only thing that ever mattered here. The confidence rests on spec correctness, which is sound, but this class of bug has slipped twice, so I will not claim >90% without one on-device pass.

**Recommended 30-second on-device check before calling it done:** open a multi-page scan, (a) swipe left/right slowly and fast → page turns; (b) drag straight up on a tall page → it scrolls, no page turn; (c) diagonal drag → lands on one axis, never both.

---

## Fix 2 — Today peek active-scaling

**Correct at 360px.**

- **Transform is visual-only → cannot widen scroll content / cause page x-overflow.** The emphasis is a `scale()` keyframe (`Today.css:312-329`) driven by `animation-timeline: view(inline)`. `transform: scale()` never alters the layout/flex box, so the track's scroll extent is unchanged and nothing propagates to the page. Belt-and-braces: `.km-shell__scroll { overflow-x: hidden }` (`index.css:1032`) hard-clips any stray horizontal bleed regardless.
- **Center never clips.** `scale()` maxes at `1` (the tile's natural flex-basis box) at the 50% keyframe = centered snap position; it only ever *returns* to natural size, never grows past it, and neighbors *shrink* to 0.88. `overflow-y: hidden` on the track therefore never clips the emphasized tile (nothing exceeds natural height). The comment's reasoning here (`:301-310`) is accurate.
- **Reduced-motion → equal size.** `@media (prefers-reduced-motion: reduce) { .km-today__peekItem { animation: none } }` (`:331-335`) → every tile renders at its flat 1.0/1.0 rest state, fully legible. Honored.
- **Both carousels consistent.** Carousel 1 (Vocab/Grammar/Hanja) and Carousel 2 (Reading/Listening/Writing) share the identical `.km-today__peekItem` class, so the one `@supports`/reduced-motion block governs both. Confirmed.
- Unsupported engines (no `animation-timeline: view()`) fall through the `@supports` gate to a flat, equal-weight, fully-functional peek row — graceful.

---

## Fix 3 — Today layout (tighter spacing + centered `<h2>`)

**No 360px issue.**

- `.km-today__sectionTitle` (`Today.css:57-65`): 16px/700, centered, `margin: 12px 0 8px`, `color: var(--paper)`, `font-family: var(--font-display)`. The three labels ("Review & drills", "Suggested learning", "TOPIK") are short; even the longest wraps nowhere near 360px, and the bilingual kr sub ("추천 학습" etc.) is shorter still. Reads clearly as a section header — 16px bold sits deliberately below the 20px page `<h1>` (`.km-today__title`), so the hierarchy is right, not cramped.
- Inter-section spacing: `.km-today__section { margin-bottom: 0 }` (`:73-75`) hands the entire gap to the next title's 12px `margin-top` — visibly separated, not touching. Correct de-doubling of the old 6px+18px stack.
- Contrast/AA: reuses the exact `--paper` / `--font-display` pair already validated for `.km-today__tileHeadline`; no new contrast surface. Token-driven, **no hardcoded hex** anywhere in the changed CSS.

---

## Fix 4 — Flush skyline (safe-area)

**Correct for this app's configuration — no content tuck. Confidence high.**

`height: env(safe-area-inset-top, 0px)` (`index.css`, replacing `max(54px, env(...))`).

- **Non-notch (Android, notchless iPhone, desktop): flush, correct.** `env(safe-area-inset-top)` resolves to `0` → header sits at the very top; the old `max(54px, …)` floor forced a permanent ~54px blank bar there, which this correctly removes.
- **Notched iOS: clears the notch, content not hidden.** With `apple-mobile-web-app-status-bar-style: default` (`index.html:16`) the standalone status bar is **opaque** and the web viewport begins **below** it, so `env(safe-area-inset-top)` reports `0` and the skyline sits flush under the (already-cleared) opaque bar — never drawn under the Dynamic Island / status bar.

**PWA/standalone caveat — checked, and it is NOT insufficient here:**
- This is a `display: standalone` PWA with `viewport-fit=cover` (`vite.config.ts:69`, `index.html:12`). The only standalone mode where `0px` would tuck content under a *real* status bar is iOS `black-translucent` (content extends under a transparent status bar) or `display: fullscreen` — **this app uses neither.** With `status-bar-style: default`, the OS reserves the status-bar strip and reports inset `0`, which is exactly the flush behavior wanted.
- **Robustness bonus:** because the spacer now honors the *real* `env()` inset rather than a fixed floor, if the status-bar style were ever changed to `black-translucent`, `env(safe-area-inset-top)` would then report ~44–59px and this spacer would grow to match automatically — so the fix is correct across *all* status-bar styles, not just the current one. The old `max(54px,…)` was the fragile one.
- **Only residual is cosmetic:** on notched iOS standalone the opaque status bar renders in the manifest `theme_color`/`background_color`, which may not match the SkylineHeader's illustration edge — a possible color seam, never hidden content. Out of scope for a mobile-correctness blocker.

---

## Overall — new overflow / touch regressions this round?

- **No new page-level horizontal overflow.** The only new negative margin is `.km-today__peekOuter { margin: 0 -2px }` (`Today.css:248-253`), and it is doubly safe: (a) the peek track is its own `overflow-x: auto` scroll container so its content width never reaches the page, and (b) `.km-shell__scroll { overflow-x: hidden }` clips anything that tries. Verified no other fixed-px widths were introduced.
- **No touch regression.** The pointer path is now touch-excluded but still fully drives mouse/pen (every existing mouse-drag test still exercises it); touch is a clean, separately-tested native path. The Today carousels remain pure native scroll-snap (no JS gesture code to regress).
- **Reduced-motion honored everywhere new:** peek scale (`:331`), page-drag snap-back (`UploadViewer.css:142-146`), tile hover lift (`Today.css:118-125`). Skyline parallax remains gated by `no-preference`.
- **AA / hex:** all changed CSS is token-driven; the only hex literals in the diff are `theme-color` meta tags and the PWA manifest, which are platform config, not app styling.

---

## Findings ledger

**SHOULD-FIX**
- S1 — `UploadViewer.tsx:853` (+ `touch-action: pan-y`): diagonal-onset swipe can lose the first-cancelable window and no-op one page-turn. Inherent to the correct `pan-y` design; recommend a one-line known-limitation comment, **no code change** (the alternative forfeits vertical scroll).

**NIT**
- N1 — `Today.tsx:719` / `seoul-devices.css:80`: the `.km-hangul-watermark::before` 7em glyph (`right: -0.1em`, `white-space: nowrap`) on the now-centered "Suggested learning" `<h2>` can extend past the element edge; harmless (opacity 0.05, `z-index: -1`, clipped by `.km-shell__scroll` overflow-x hidden), but confirm visually it doesn't ghost behind the centered label oddly.
- N2 — `Today.css:114-116`: `.km-today__tileBtn:hover { transform: translateY(-2px) }` inside the `overflow-y: hidden` peek track — desktop-hover only, absorbed by the track's 4px top padding, so no real clip; noting for completeness.

**PRAISE**
- The round-2→round-3 diagnosis is genuinely correct: identifying that Pointer Events don't carry the non-passive main-thread guarantee on a real scroll container, and moving touch to a dedicated non-passive native `touchmove`, is the right root-cause fix — and the accompanying regression test (`:765`) is the exact test that would catch a silent relapse to passive JSX `onTouchMove`.
- Safe-area fix reasoning is airtight and, as a side effect, more robust than the code it replaced.
- Peek scaling proven visual-only (scale ≤ 1) so it cannot reintroduce x-overflow — a real trap avoided by construction.

---

## Deploy call: **SHIP IT.** Mobile-safe, 0 blockers. Do the 30-second on-device swipe check above to convert the PDF-swipe 88% → certainty, since happy-dom structurally cannot.
