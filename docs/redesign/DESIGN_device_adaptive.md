# Device-Adaptive Layout — Design + Architecture Plan

Status: proposal, not yet built. Companion mockup: `docs/redesign/mockups/device-adaptive-today-desktop.html`
(open directly in a browser — no build step, no external requests).

Scope: make Korean Master recognize device/viewport class and adapt layout + navigation per class, on top of the
existing "Seoul Day & Night" mobile design system — without discarding the mobile UI or the visual language.

---

## 1. Audit — current responsive infrastructure

Read: `client/src/components/Shell.tsx`, `client/src/components/BottomNav.tsx`, `client/src/components/LearnMenu.tsx`,
`client/src/styles/index.css`, `client/src/pages/Today.tsx` + `Today.css`, `client/src/pages/Progress.tsx`,
`client/src/pages/ReviewLibrary.tsx`, `client/src/pages/Settings.tsx`, `client/src/lib/nav.ts`,
`client/src/components/PageHubHeader.tsx`, `client/src/components/CityCard.tsx`, `DESIGN_SEOUL_DAY_NIGHT.md`.

### What exists

- **One hard width cap, everywhere.** `--shell-max-width: 480px` (`index.css:243`), applied at `.km-shell`
  (`index.css:1095-1109`): `max-width: var(--shell-max-width); margin: 0 auto;` plus a 1px hairline
  `border-left`/`border-right` that's removed only below 480px (`index.css:1107-1109`, the app's *only*
  `max-width` breakpoint). On any viewport ≥ 480px — tablet, laptop, 27" monitor — the entire app renders as a
  480px phone column centered in a sea of `--ink` background. This is the "stretched narrow column" behavior
  named in the brief, confirmed at the source.
- **A second, narrower breakpoint exists but is page-local, not app-wide:** `index.css:4648`,
  `@media (min-width: 640px) { .km-resources__week-cols { grid-template-columns: 1fr 1fr; } }` — a single
  2-column grid used only inside the Resources/library-week view. It never fires today because `.km-shell`'s
  480px cap means no descendant ever sees a 640px-wide viewport in the first place. It's a preview of the right
  idea (content-level breakpoint) with no app-shell support to make it reachable.
- **No JS-side device/viewport detection at all.** Grepped `hooks/`, `components/`, `lib/` for
  `useMediaQuery|useBreakpoint|useDeviceClass|matchMedia|innerWidth`: the only `matchMedia` usages are
  `ThemeProvider.tsx` (`prefers-color-scheme`), `Shell.tsx:87-92` (`prefers-reduced-motion`, read at
  close-request time, not cached), and `InstallPrompt.tsx` (`display-mode: standalone`). **Zero** viewport-width
  hooks exist. Every layout decision in the codebase today is theme- or motion-conditional, never
  viewport-conditional.
- **Nav chrome is a single fixed instance, unconditionally mounted.** `Shell.tsx:152-179` always renders exactly
  one `<BottomNav>` (`km-shell__nav`, `position: sticky; bottom: 0`) and conditionally mounts `<LearnMenu>` as a
  full-bleed upward overlay scaled off `--shell-max-width` (`index.css:1358-1360`,
  `--km-hex-w: clamp(..., calc((min(100vw, var(--shell-max-width)) - 56px) / 3), ...)`). There is no branch point
  in `Shell.tsx` where an alternate nav shell could be swapped in — `BottomNav` is hard-imported and
  unconditionally rendered.
- **Container discipline is good, just single-width.** Almost every "content column" in the app
  (`index.css:734-746` doc comment, `746`, `859`, `2627`, `2943`, `3289`, `3298`) explicitly caps at
  `var(--shell-max-width)` or a fraction of it, and the doc comments show this was a *deliberate, repeated*
  choice ("mirrors the shell's centered mobile column, same max-width") — meaning the codebase already has the
  *habit* of a shared max-width token, it's just one token pinned to phone width. That's actually good news: a
  `--content-max-width` (wide) token slotted in next to `--shell-max-width` (narrow) is additive, not a rewrite.
- **Carousels are native CSS scroll-snap, not a JS slider library.** `Today.css` "peek slider"
  (`.km-today__peekOuter/Track/Item`, `Today.css:296-385`) is `overflow-x:auto` + `scroll-snap-type:x mandatory`
  with `flex: 0 0 78%` items — the browser owns momentum/drag, there's no gesture JS to fight when converting a
  carousel to a static grid at wider widths (a CSS-only swap: change `display:flex/overflow-x:auto` to
  `display:grid` under a wide-viewport media query, no JS or markup change required).
- **Component reuse ceiling:** `PageHubHeader` (skyline + h1 + rail), `CityCard`, `SubwayProgress`, `SealStamp`,
  `Bilingual`, `Icon`, `cn()` are all pure, token-driven, prop-configured, and carry zero viewport assumptions in
  their own code — they render correctly at any container width today. The width problem is 100% in the shell
  chrome (`Shell.tsx`/`BottomNav.tsx`/`index.css`'s shell rules), not in the page-level or primitive components.

### What's missing

1. A viewport→device-class mapping (breakpoint values) doesn't exist anywhere — CSS or JS.
2. No `useBreakpoint`/`useDeviceClass` hook — anything needing to branch React tree shape (not just CSS) has
   nothing to call.
3. No alternate nav shell (sidebar/top-bar) and no seam in `Shell.tsx` to mount one conditionally.
4. No wide-content-width token (`--content-max-width` or similar) — only the narrow `--shell-max-width`.
5. No per-page "wide-viewport" variants of the carousel-heavy pages (Today, Progress, ReviewLibrary) — they're
   single-column, single-carousel-width, full stop.
6. `LearnMenu`'s honeycomb geometry (`--km-hex-w`) is explicitly derived from `--shell-max-width`
   (`index.css:1358-1360`) — if the shell cap is lifted or a second wide cap is introduced, this formula needs a
   companion clamp or it will make hexagons enormous on desktop widths. Flagged for Phase D0.

---

## 2. Breakpoint strategy

### Values

Match the codebase's existing single numeric convention (raw px in `@media`, not `em`) and its two existing
reference points (480px shell edge, 640px content grid) rather than inventing a third numbering scheme:

| Class | Range | Rationale |
|---|---|---|
| **mobile** | `< 768px` | Covers the existing 480px phone target *and* the untouched "phablet/small-tablet-portrait" zone up to 768px — below 768px there still isn't reliably room for a persistent side rail (44px touch targets + labels) alongside real content width, so mobile chrome (bottom nav + hexagon) stays the right call through this whole band, not just under 480px. |
| **tablet** | `768px – 1099px` | Enough width for a persistent nav rail *or* a 2-column content grid, not both comfortably at once (a 768px iPad-portrait minus a 240px sidebar leaves ~530px — workable for one content column, tight for two). Nav shell changes; page bodies mostly stay single/near-single-column with widened components (bigger cards, side-by-side stat pairs), not full multi-column grids. |
| **desktop** | `≥ 1100px` | Room for persistent sidebar (~240–260px) + a genuinely multi-column content area (carousels → grids, 2–3 columns) without the sidebar eating the reading measure. 1100 (not the more common 1024) because the existing hexagon/carousel geometry has real minimum comfortable widths (`--km-hex-w` clamp, 78%-width peek tiles) that need headroom once a sidebar is subtracted — verified against the mockup at 1440px and a 1100px pinned-half-screen check. |

CSS custom properties, defined once in `index.css` next to the existing tokens:

```css
:root {
  --bp-tablet: 768px;
  --bp-desktop: 1100px;
}
```

(Custom properties can't be used inside `@media` conditions directly — CSS has no `@media (min-width: var(...))`
— so these exist as the single documented source of truth for the *numbers*, and every `@media` rule below must
use the literal px value with a comment pointing back to this block, the same discipline already used for
`--shell-max-width` vs. its one `@media (max-width: 480px)` consumer.)

### Detection approach

- **CSS is primary and does 90% of the work** — most of what needs to change (card widths, grid columns, gaps,
  carousel→grid swaps, hiding/showing the bottom nav vs. sidebar via CSS `display`) is pure layout and can ship as
  media queries against the two breakpoints above, no JS involved, no hydration mismatch risk, no extra render.
- **A `useDeviceClass()` hook for the ~10% that's structural, not stylistic** — cases where the *React tree
  itself* must differ, not just its CSS: which nav shell mounts (`BottomNav` and its `LearnMenu` overlay vs. a
  `SideNav` rail — you cannot "just CSS-hide" a fixed bottom-nav-with-portal-overlay component into a sidebar,
  the DOM structure, the honeycomb-vs.-flyout interaction model, and the a11y roles differ), and any page that
  restructures its component tree rather than just its widths (e.g. Progress's three `CollapsibleTile` sections
  becoming three permanently-open side-by-side panels on desktop — different components, not different CSS on
  the same one).

  ```ts
  // hooks/useDeviceClass.ts (proposed)
  export type DeviceClass = 'mobile' | 'tablet' | 'desktop';

  const QUERIES: Record<Exclude<DeviceClass, 'mobile'>, string> = {
    tablet: '(min-width: 768px)',
    desktop: '(min-width: 1100px)',
  };

  export function useDeviceClass(): DeviceClass {
    // matchMedia-driven, same pattern as ThemeProvider's system-theme listener
    // (index.css tokens use the raw px; keep this file's literals synced to them
    // by comment, same convention as --shell-max-width's one @media consumer).
    // SSR/no-window guard mirrors Shell.tsx's prefersReducedMotion() pattern —
    // this is a CSR-only app (Vite SPA) but the guard costs nothing and matches
    // house style.
  }
  ```

  Implementation mirrors `ThemeProvider.tsx`'s existing live-`matchMedia`-listener pattern exactly (two
  `MediaQueryList`s, `change` listeners, `useSyncExternalStore` or a plain `useState`+`useEffect` pair) — no new
  pattern introduced, just the same one applied to width instead of color-scheme.

- **UA-hint edge cases to note, not solve exhaustively:**
  - **Foldables / split-screen / resizable desktop windows** — `matchMedia` + `resize` handles this correctly by
    construction (it's live, not a one-time UA sniff); a UA-string approach would not. This is the strongest
    argument for viewport-width detection over device/UA detection generally.
  - **Touch-capable laptops (Surface, touchscreen Chromebooks) at desktop width** — should get the desktop *layout*
    (sidebar, grids) but must keep touch-friendly hit targets. Since the existing 44px minimum
    (`index.css:962-971`, WCAG 2.5.8) is already unconditional across the app, this falls out for free — don't
    shrink touch targets in the desktop nav rail just because there's mouse-pointer room.
  - **`(pointer: coarse)` vs `(hover: hover)`** — worth a light touch for hover-only affordances (e.g. showing a
    keyboard-shortcut hint on hover in Phase D2+), but should never gate the core nav-shell decision — a
    mouse+keyboard desktop user with a touchscreen still wants the desktop nav shell at desktop width. Keep
    `pointer`/`hover` queries scoped to *interaction polish*, never to *device class*.
  - **PWA standalone mode** (`InstallPrompt.tsx` already checks `display-mode: standalone`) — orthogonal to
    device class; a standalone-installed instance can be mobile or desktop width. No interaction expected, but
    flagging since it's the one other `matchMedia` consumer in the codebase.
  - **`--km-hex-w`'s dependency on `--shell-max-width`** (see Audit §1.6) — once `--shell-max-width` is either
    lifted or joined by a wide-content token, the hexagon clamp formula (`index.css:1358-1360`) must be re-derived
    against whichever width the *mobile nav shell* renders at (it stays phone-shaped even inside a tablet/desktop
    body, per the recommended nav model below) — not against full desktop width. Concretely: the mobile nav shell
    and its `LearnMenu` overlay keep sizing off `--shell-max-width` unchanged; they simply mount inside a
    differently-laid-out desktop page rather than being asked to scale themselves.

---

## 3. Desktop/tablet nav models

All three keep `lib/nav.ts` (the single nav manifest) and `Icon`/`Bilingual` as-is — only the *chrome* that reads
the manifest changes, never the manifest itself. The 4 primary tabs are Today/Progress/Library(review)/Settings;
LEARN is a launcher over 7 sub-pages, not a 5th tab (see `nav.ts:1-27`, `BottomNav.tsx:1-25`).

### Option A — Persistent left sidebar (nav rail), RECOMMENDED

A fixed-width (~240px tablet-narrow / ~260px desktop) left rail, `position: sticky; top:0; height:100dvh`,
replacing `BottomNav` entirely at ≥768px. Contents top-to-bottom: app wordmark/logo, the 4 primary tabs as
full-width rows (icon + bilingual label, not icon-only — there's a whole rail's worth of horizontal room, no
reason to make the desktop user relearn icon-only nav), a visually distinct **LEARN section** — either (a) the
honeycomb's 7 items flattened into a labeled sub-list permanently visible under a "Learn" heading (no
toggle/overlay needed — desktop has vertical room a phone doesn't), or (b) the hexagon itself rendered inline as a
rail header that expands its 7 children below it, keeping the "launcher" mental model but losing the overlay
mechanic. Recommend (a) for D0 (simpler, no LearnMenu-lifecycle porting) with (b) as a stretch/Phase-D2 polish once
the rail's basic plumbing is proven.

- **Tabs/hexagon/FAB translation:** 4 tabs → rail rows (still real nav links, same `matchActiveId` longest-prefix
  logic from `BottomNav.tsx:147-166`, reused verbatim). LEARN hexagon → rail's flattened/expandable Learn section
  (no scrim, no exit-cascade state machine — `LearnPhase` in `Shell.tsx` becomes conditional/mobile-only). Chat
  FAB → unchanged, still floats independent of the rail (it's positioned relative to the shell edge today,
  `index.css:1544`, `right: max(14px, calc((100vw - var(--shell-max-width))/2 + 14px))` — this formula must be
  re-derived once the shell isn't the only width in play, but the *component* needs no redesign).
- **A11y:** Rail is a `<nav aria-label="Primary navigation">` (same landmark BottomNav already uses,
  `BottomNav.tsx:131`) with real `<a>`/`<button>` rows — better keyboard nav than mobile today, not worse:
  natural Tab order top-to-bottom, no focus-trap/modal machinery needed at all since nothing overlays (the
  biggest single a11y-complexity *reduction* of the three options — mobile's `useModalA11y` focus-trap/Esc/restore
  plumbing in `LearnMenu.tsx:210-216` simply doesn't apply to a permanently-visible list). `aria-current="page"`
  carries over unchanged.
- **Reuse vs. rebuild:** `BottomNav`'s active-match logic (`matchActiveId`, `isLearnPath`) reuses 1:1 — extract
  into a shared `lib/nav-active.ts` (or leave in `BottomNav.tsx` and import) so both shells call the identical
  function, guaranteeing the two nav UIs never disagree about "what's active." `Shell.tsx`'s `LearnPhase` state
  machine (lines 71-150) stays exactly as-is for mobile and is simply **not instantiated** in the desktop branch —
  it's the single largest rebuild-vs.-reuse decision: keep it 100% intact and behind a `deviceClass === 'mobile'`
  gate in `Shell.tsx`, don't try to make one state machine serve both shells (they have genuinely different
  interaction models — overlay-with-exit-animation vs. permanently-rendered list — forcing one abstraction over
  both would be the over-engineering trap). New code: `components/SideNav.tsx` (new component, ~1 render
  branch's worth of work) + `Shell.tsx` gains one conditional around which nav renders.
- **Tradeoffs:** Best use of desktop width (content gets the full remaining area, not squeezed by a top bar that
  also has to hold branding). Familiar "app with a rail" pattern (Notion/Linear/Slack) users already know.
  Downside: LEARN's honeycomb — the app's single most distinctive, most-invested-in interaction (see
  `LearnMenu.tsx`'s multi-hundred-line lifecycle comment, F-128 reskin, F-189 color fix-pass rounds) — either
  loses its "hero launcher" moment on desktop (flattened to a plain list) or needs real new design work to earn a
  desktop-native equivalent (b) that still feels special. This is the recommendation's one honest cost, and it's
  a design-time cost, not an engineering-risk one.

### Option B — Top nav bar (horizontal, app-bar style)

A full-width sticky header replacing the bottom bar: logo/wordmark left, 4 primary tabs as horizontal
text+icon links center/right, LEARN as either a dropdown-on-hover/click menu or its own nav-bar entry that opens
the 7-item flyout below the bar.

- **Tabs/hexagon/FAB translation:** 4 tabs → horizontal links (same active-match reuse as Option A). LEARN →
  a dropdown panel anchored under a "Learn" bar item — structurally the *closest* cousin to the existing mobile
  `LearnMenu` overlay (it's still a toggled panel, just anchored top instead of bottom, and can reuse more of
  `Shell.tsx`'s existing `LearnPhase` state machine and `LearnMenu`'s open/close choreography than Option A can,
  just re-skinned to drop from the top instead of rise from the bottom). Chat FAB unchanged.
- **A11y:** Standard nav-bar + disclosure-menu pattern (`aria-haspopup`, `aria-expanded` — already exactly what
  `BottomNav.tsx:114-116` does for the hexagon today, so the ARIA contract genuinely ports over almost unchanged).
  Keyboard: Tab through bar items, Enter/Space opens the Learn dropdown, Esc closes (same `useModalA11y` hook,
  reused, not rebuilt) — this is the option that reuses the MOST existing a11y code as-is.
- **Reuse vs. rebuild:** Highest reuse of `LearnMenu`'s existing lifecycle/animation/`useModalA11y` machinery of
  the three options (same open/closing/closed phases, just re-anchored). `BottomNav`'s active-match logic reuses
  identically. New code is smaller than Option A's: mostly a `TopNav.tsx` wrapper + CSS re-anchoring of the
  existing honeycomb drop direction.
- **Tradeoffs:** Cheapest to build (most reuse), and lowest risk to the LEARN interaction's identity (it's still
  a "tap to reveal a comb of options" launcher, just relocated). Downside: eats vertical space at the very top of
  every page on top of whatever page-level `PageHubHeader`/`SkylineHeader` banner already renders there (Today,
  Progress, and every Library page all currently open with a skyline-strip header, `PageHubHeader.tsx`) — two
  stacked horizontal bars (app nav + page skyline header) reads busier and eats more of the above-the-fold area
  than a rail does, especially on shorter desktop viewports (laptop screens, not just external monitors).

### Option C — Hybrid: top bar (branding + Settings + Chat entry) + collapsible left rail (4 tabs + LEARN)

Splits the two concerns instead of picking one: a thin top strip carries global chrome (logo, current-page title,
account/Settings, search if it ever gets one) while the primary 4-tab-plus-LEARN navigation lives in a
narrower/icon-first left rail beneath it (collapsible to icon-only, expandable on hover/pin — the "IDE sidebar"
pattern).

- **Tabs/hexagon/FAB translation:** Similar to Option A for the rail portion; LEARN can go either the flattened-
  list route (A) or a flyout-from-rail-icon route (a middle ground: icon-only rail, LEARN's hexagon icon opens a
  flyout panel anchored beside the rail rather than a full-page overlay).
  Chat FAB unchanged; Settings moves out of the rail into the top strip (freeing a rail row) — a real content
  change, not just a translation, and one more moving piece to design and test.
- **A11y:** Two landmarks instead of one (`<header>` + `<nav>`), which is *fine* but is one more region for a
  screen-reader user to orient across than either single-shell option — not a defect, just a slightly larger
  surface.
- **Reuse vs. rebuild:** Lowest reuse of the three — it's a genuinely new composite shell (new top-strip
  component AND new rail component AND a collapse/expand interaction state that doesn't exist in the mobile app
  at all today), plus the "what moves to the top strip vs. stays in the rail" decision is itself a fresh design
  call, not a mechanical translation of the existing 4-tabs-plus-hexagon model.
- **Tradeoffs:** Most scalable long-term (room to grow: search, notifications, breadcrumbs, account switcher all
  have a natural home in the top strip without touching the rail) — but for THIS epic's actual ask (adapt the
  existing 4-tab-plus-LEARN model to wider screens, not add new global-chrome features) it's the most
  over-built option relative to the problem stated. Better fit for a "we're also adding account/org switching /
  global search soon" roadmap than for a pure responsive-layout pass.

### Recommendation: Option A (persistent left sidebar)

Best fit for the stated goal (adapt existing nav to device class, don't add new global-chrome scope), gives
content the most usable width of the three (no horizontal bar competing with the page's own skyline header), has
a clean, low-risk seam in `Shell.tsx` (mobile's `LearnPhase` state machine is left completely untouched and
simply gated off on desktop, rather than needing to be reshaped to serve two nav shells at once), and matches the
"real responsive site" mental model the brief asks for (rail-style apps are the dominant desktop pattern for
exactly this shape of app: 4-5 top-level sections + a launcher). Its one honest cost — LEARN's hero-launcher
moment needs fresh desktop-native design work to not read as a demotion — is called out above and belongs in
Phase D2 (per-page/nav polish), not D0 (foundation); D0 ships the flattened-list version, which is correct and
undiminished, just not yet as delightful as the mobile hexagon.

---

## 4. Per-page adaptation strategy

| Page | Mobile (unchanged) | Tablet (768–1099px) | Desktop (≥1100px) | Value |
|---|---|---|---|---|
| **Today** | 3 peek-slider carousels (drills / suggested / TOPIK), single column | Peek sliders widen (fewer offscreen tiles peeking, tiles grow) but stay carousels — not enough width yet for 3-wide + rail | Carousels → **static 3-column grids** (each carousel's tiles all visible, no scroll-snap needed — see mockup); TOPIK card + subway progress get a dedicated wide panel beside the drills grid, not stacked below it | **High** — daily landing page, highest traffic, best demo of "uses the width" |
| **Progress** | 3 `CollapsibleTile` sections, stacked, mostly collapsed | Sections widen; TOPIK-compare's attempt-history carousel gets more room per slide | Sections render as a **2–3 column dashboard** (TOPIK-compare panel + skill-trend panel side by side; Mastery tabs become a persistent 3-up view instead of a tabbed single-panel) — charts (`LineChart`) get real horizontal room instead of a squeezed phone width | **High** — stats/charts are the single best desktop-width payoff in the whole app (line charts on a 480px cap are the most visibly "wasted" mobile-stretched UI today) |
| **LEARN (honeycomb)** | Overlay honeycomb launcher over BottomNav | Same overlay (rail not adopted yet at this width per Option A's 768px cut-in — see note) OR early rail adoption, TBD by D0 pilot | Flattened into the sidebar's Learn section (D0) → **Phase D2 stretch:** a dedicated `/learn` landing panel replacing the overlay entirely, rendering the 7 sub-pages as a real content grid (cards, not hexagons forced onto a rail) | **High** for the nav translation (blocking for the whole epic); **Medium** for a bespoke desktop honeycomb redesign (nice-to-have, not required for D0) |
| **Review (Library)** | 4-row directory (Vocab/Grammar/TOPIK-exams/Uploads) | Rows widen, maybe 2-up | **2×2 or 4-across grid** of the same 4 entries as cards, not rows — a directory page is the easiest, lowest-risk grid conversion in the app | **Medium** — low interaction depth, but cheap and visible |
| **Settings** | 4 `CollapsibleTile` groups, all default-collapsed | Same tiles, wider | Groups render **side-by-side or as a two-column form layout** (Profile+2FA left, Notifications+Appearance right) — genuinely useful once a mouse+keyboard user doesn't have to scroll a stack | **Medium** — infrequent visits, but a bad one-column-stretched settings page is a classic "obviously not adapted" tell |
| **Reading / Listening(TTMIK) / Writing** | Single-column content + audio/text blocks | Wider text measure only (typographic measure cap, e.g. `max-width: 68ch`, NOT full-width text — reading measure is a *content* concern independent of device class) | Same widened measure, PLUS a **secondary rail** becomes viable (e.g. a table-of-contents/chapter list beside the reading pane, vocabulary lookup panel beside a Writing draft) | **Medium-High** for Reading (long-form text genuinely benefits from a capped measure + side rail); **Low-Medium** for Writing/Listening (mostly measure-capping, not restructuring) |
| **TOPIK / MockMode** | Full-screen timed exam UI, single question | Same, wider margins | Exam body stays **intentionally narrow/centered** even on desktop (timed-test UIs should not stretch full-width — reduces eye travel, matches real exam-taking UX) — but the surrounding chrome (timer, question nav, subway progress) can use the freed side space for a persistent question-jump rail | **Low** — deliberately NOT adapting this one is itself the correct call; flag so nobody "fixes" it into a bad wide layout later |
| **Hanja** | Grid of `HanjaCell`s, already grid-based (`.km-hanjacell`, mastery-tinted top border) | Grid gains columns naturally (CSS grid `auto-fill`/`minmax` — verify it's not hard-coded to a fixed column count) | More columns still, same component, zero new component work if the existing grid isn't already width-capped by the shell | **High value, near-zero cost** — if `HanjaCell`'s grid uses `repeat(auto-fill, minmax(...))` today it may already "just work" once the shell cap is lifted; verify first before writing any new CSS |
| **Vocab (flashcards / My Lists)** | Single-card flashcard flow, single-column list | Wider card, list gains a 2nd column for list rows | Flashcard study session stays **single-focus** (studying one card at a time is correct at any width — don't grid-ify an SRS review queue); My Lists browse view can grid up | **Medium** — same "don't force multi-column onto an inherently single-task flow" caution as MockMode |

**Cross-cutting flag:** any flow that is fundamentally *sequential/single-focus* (MockMode exam, flashcard study,
a single reading passage) should widen its margins/typography on desktop but explicitly should **not** be
grid-ified just because there's width available — matching real responsive-design practice (a Kindle app doesn't
turn into a 3-column grid on a monitor). Directory/dashboard/browse pages (Today, Progress, Review-library,
Settings, Hanja grid, Vocab-list-browse) are the ones that gain from multi-column use of the width.

---

## 5. Phasing for a ~60-hour window

Foundation first because it's the only non-breaking, highest-leverage slice: every other phase depends on the
breakpoint tokens + chosen nav shell existing, and shipping it standalone means it can land, get fixpass'd, and
merge WITHOUT waiting on or blocking any in-flight feature batch (F-1xx work) — it only touches `Shell.tsx`,
`BottomNav.tsx`, and `index.css`'s shell rules, none of which per-page feature batches are actively editing.

| Phase | Scope | Est. hours | Fit |
|---|---|---|---|
| **D0 — Foundation** | `--bp-tablet`/`--bp-desktop` tokens; `useDeviceClass()` hook (mirrors `ThemeProvider`'s matchMedia pattern); `--content-max-width` (wide) token alongside existing `--shell-max-width`; build `SideNav.tsx` (Option A) gated on `deviceClass !== 'mobile'` in `Shell.tsx`, mobile `BottomNav`/`LearnMenu`/`LearnPhase` machine untouched and unconditionally kept for mobile; flatten LEARN's 7 items into the rail's Learn section (no new overlay/animation work — plain list); re-derive the Chat FAB's position formula (`index.css:1544`) against whichever width is active; **fixpass gate** before merge (per house workflow — 4-phase, not shortcut). | **16–20h** | **Fits comfortably.** This is the entire "must-ship" core of the epic — everything else is additive polish on top of a working, adaptive shell. |
| **D1 — High-value page adaptation** | Today (carousels → grids) + Progress (dashboard columns + real chart width) — the two pages flagged **High** value above and the two that most visibly justify the whole epic in a demo. Includes verifying/fixing Hanja's grid if it's not already `auto-fill` (near-zero-cost win, check first). | **16–20h** | **Fits, tightly.** Today's 3-carousel→3-grid conversion is mostly CSS (scroll-snap flex → CSS grid, per Audit §1's native-scroll-snap note) plus the TOPIK-panel re-layout; Progress's chart-width win is the highest "wow per hour" item in the whole plan. |
| **D2 — Medium-value pages + nav polish** | Review-library grid, Settings two-column, Reading measure-cap + optional side rail, and (**stretch**) a real desktop-native LEARN experience beyond the flattened list (either the rail-hexagon-hover variant from Option A, or a dedicated `/learn` landing panel per the LEARN row's Phase-D2 note in §4). | **remaining budget / stretch** | **Honest stretch.** Given ~60h total and D0+D1 alone costing 32–40h, D2 gets whatever's left (roughly 10–20h) — realistically enough for Review-library's grid (cheap) and Settings' two-column (cheap-medium), NOT enough for a bespoke desktop LEARN redesign, which should be scoped as its own follow-up ticket rather than squeezed in. |

**Explicitly out of scope for this 60h window (do not attempt):** MockMode/flashcard-study "adaptation" beyond
margin/typography widening (per §4's cross-cutting flag — these should NOT be grid-ified, so there's little real
work here anyway, but don't let it balloon into a redesign); Writing/TTMIK page restructuring beyond measure-cap;
any account/global-chrome additions Option C would have implied (search, breadcrumbs) — not asked for by this
epic.

### Interleaving with in-flight feature batches

D0 is deliberately scoped to files (`Shell.tsx`, `BottomNav.tsx`, shell-only rules in `index.css`, one new
`SideNav.tsx`) that the currently-active feature batches (F-1xx work referenced throughout `BUGS_AND_FEATURES.md`
and the fix-pass trail in `docs/redesign/`) are not touching — those batches work inside individual page
files/page-scoped CSS (Today.css, Progress.css, per-page components), not the shell chrome. That's why D0 can
land first and in parallel with feature work rather than blocking it.

D1/D2 (Today, Progress, Review-library, Settings, Reading) DO touch files active feature batches also touch —
this is why the plan sequences per-page adaptation AFTER D0 lands, not concurrently with whatever page-level
feature batch is in flight on that same page at the same time: two agents editing `Today.css`'s carousel markup
simultaneously (one for a feature, one for the responsive grid conversion) is the exact rework/merge-conflict
risk the brief warns against. Practical sequencing rule: before starting D1 on a given page, confirm no feature
batch has that page's files checked out/in-progress; if one does, either wait for it to land first or coordinate
so the responsive CSS changes ride the same PR as that batch's other changes rather than a separate concurrent
one.

---

## 6. Mockup

`docs/redesign/mockups/device-adaptive-today-desktop.html` — Today page at desktop width (~1440px reference,
fluid), Night ("Seoul, Day & Night" dark/neon world) theme, Option A sidebar. Self-contained single file, inline
CSS, no external requests, no build step — open directly in a browser. Uses realistic corpus-shaped content
(pulled from `data/mocks/today.ts`'s actual fixture strings: "도시화와 환경" reading title, "KBS — 재택근무 확산"
listening title, "Paragraph in 합쇼체 — defend remote work" writing prompt, 24 cards due) rather than lorem-ipsum
placeholders, and reuses the real design-system devices: neon-signboard cards (device #1), a dancheong/neon rail
accent, a Namsan-skyline-style header band, subway-line progress (device #5), a seal-stamp milestone mark
(device #7), and a rain-sheen ambient overlay (device #8) — the same devices `CityCard`/`PageHubHeader`/
`SubwayProgress`/`SealStamp` already implement in React, redrawn in plain HTML/CSS for the mockup.
