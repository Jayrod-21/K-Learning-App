# QA audit — untouched pages + nav patterns after the overhaul (P1.1/P1.2)

Read-only regression audit on branch `feat/overhaul-p1.2` (HEAD `2b57ee5`), 2026-07-07.
Scope: the pages the overhaul re-homed but did NOT edit, the two new nav patterns
(hexagon LearnMenu + ChatFab), and the global routing/refresh behavior. References:
`db/docs/OVERHAUL_DESIGN.md`, `db/docs/OVERHAUL_P1_BUILD.md`.

Verification basis: full file review of every in-scope page/component, grep sweeps for
stale path literals, live spot-checks against the running stack on `:1840`, client
`tsc -b` (0 errors), and the full client vitest suite (84 files / 887 tests, all pass —
includes the ChatFab visibility matrix, LearnMenu a11y, BottomNav, redirects, nav
exhaustiveness, useKeyboardOpen, ExamActiveProvider, MockMode, and Mistakes suites).

Verdict: **1 real regression (Images page orphaned), 2 low risks, everything else OK.**

---

## BROKEN

### B-1. Images page (`/images`) is unreachable from the UI — orphaned by the MoreSheet retirement

- **What**: Pre-overhaul, Images was listed in `MORE_TAB_IDS` and reachable via the
  "More" sheet (verified in git: `891a001~1:client/src/lib/nav.ts:185-192` includes
  `'images'`). P1.1 retired MoreSheet; Images was reclassified as a SECONDARY routed
  screen ("reachable from tabs/pages, not in the bar" — `OVERHAUL_P1_BUILD.md:12`),
  but **no page, menu, or button links to it anymore**.
- **Evidence**: `/images` appears only in the route registration
  (`client/src/App.tsx:127`) and the nav manifest (`client/src/lib/nav.ts:228-234`,
  `SECONDARY_IDS` at `:279`). A repo-wide grep of `pages/`, `components/`, `lib/` finds
  zero `navigate('/images')` / link call sites. LearnMenu (7 items), BottomNav (4 tabs +
  hexagon), ReviewLibrary rows, Today, Settings, Chat — none reference it.
- **Impact**: the OCR/mining feature still works (route renders, direct URL / old
  bookmark fine — spot-checked as a live route), but a user navigating the app can
  never find it. This is a regression vs. the pre-overhaul nav.
- **Note**: `OVERHAUL_DESIGN.md:79` marks Images' final disposition "TBD … open
  sub-task" (fold into `/review/uploads` or chat image, P4), so the orphaning may
  resolve itself in P4 — but P1.x shipped with the page silently unreachable and no
  interim entry point (e.g. a ReviewLibrary row) was added.
- **Repro**: open the app, try to reach the Images/OCR screen using only visible UI.
- **Suggested fix**: add an Images row to `ReviewLibrary.tsx` `ROWS` (one line —
  `rowFor('images')`) as an interim home until the P4 decision lands.

## RISK

### R-1. ChatFab can overlap the BottomNav on very short (landscape-phone) viewports

- **Where**: `client/src/styles/index.css` — `.km-chatfab { position: fixed;
  bottom: 22%; }` vs. `--shell-bottomnav-h: 64px` (`index.css:54`).
- **What**: the FAB's offset is proportional, the nav's is fixed. At viewport heights
  below ~290px (landscape phone with browser chrome), `22% < 64px + safe-area` and the
  46px dot sits on top of the nav bar (both are tappable; FAB z-40 covers nav z-10).
  At normal portrait heights there is comfortable clearance.
- **Impact**: cosmetic/tap-target overlap in an unusual orientation for this app.
  Not a stuck state. (FAB under the LearnMenu scrim when the menu is open — z-40 vs
  z-60 — is per spec, as is FAB above page content.)
- **Suggested fix** (later): `bottom: max(22%, calc(var(--shell-bottomnav-h) + 24px))`.

### R-2. `/chat` is 2 taps away from Settings and from an open LearnMenu — by design, but worth confirming intent

- The FAB is hidden on `/settings` ("quiet zone", `ChatFab.tsx:27`) and sits under the
  scrim while the LearnMenu is open. Neither is a defect against the spec
  (`OVERHAUL_P1_BUILD.md:28` lists exactly these hide states); flagged only because
  Settings has no other chat affordance, so the chat becomes unreachable *from that
  screen* without first switching tabs. Accepted design per the build spec.

## OK — verified in detail

### Scope A: untouched pages at their new homes

| Page | New path | Entry path(s) verified | Stale-path grep | Notes |
|---|---|---|---|---|
| `Ttmik.tsx` | `/learn/listen` | LearnMenu row; Today reading+listening tiles (`Today.tsx:281-282`) | clean — zero client-route literals | Audio fetches hit API paths (`/ttmik`, `/iyagi`), not client routes; unaffected by the re-home. nginx allow-list still carries both prefixes. |
| `Hanja.tsx` | `/learn/hanja` | LearnMenu row | clean | No internal nav at all. |
| `Writing.tsx` | `/learn/writing` | LearnMenu row; Today writing tile (`Today.tsx:283`) | clean | No internal nav. |
| `Topik.tsx` | `/learn/topik` | LearnMenu row; Today "Resume exam" CTA (`Today.tsx:397`) | clean | Study-reveal `AskAboutThisButton` (`Topik.tsx:635`) → `/chat` contract intact. |
| `topik/MockMode.tsx` | (inside `/learn/topik`) | via Topik | clean | See ExamActiveContext analysis below. Reveal-phase AskAbout (`MockMode.tsx:1419`) intact. |
| `Diagnostic.tsx` | `/diagnostic` (unchanged) | Progress empty-state CTA (`Progress.tsx:486`) AND populated-state "Retake diagnostic" (`Progress.tsx:565`) | clean — only `navigate('/')` at `:1100` (valid) | Reveal AskAbout (`Diagnostic.tsx:791`) intact. |
| `Settings.tsx` | `/settings` (unchanged) | bottom-nav tab | clean — `/settings/prefs` refs are API paths | Theme control present (Appearance group, `Settings.tsx:819-826`) — satisfies the "theme reachable after MoreSheet retirement" requirement. |
| `Chat.tsx` | `/chat` (hard contract, unchanged) | ChatFab from every non-hidden route; AskAboutThisButton × 4 surfaces | clean | Seed consumed once at mount (`Chat.tsx:236-238`), then cleared with `navigate(..., { replace: true, state: null })` preserving search+hash (`Chat.tsx:326-334`) — no back-button trap, no re-seed on back/refresh. |
| `Images.tsx` | `/images` (unchanged) | **NONE — see B-1** | clean (`history` at `:466` is local state, not router) | Page itself fine. |
| `Mistakes.tsx` | `/review/mistakes` | ReviewLibrary row (`ReviewLibrary.tsx` `rowFor('mistakes')`); Today review shortcut (`Today.tsx:415`) | clean | AskAbout per card (`Mistakes.tsx:97-103`) intact. |

No untouched page hardcodes an old path (`/review`-as-flashcards, `/reference`,
`/topik`, `/ttmik`, `/grammar`, `/writing`, `/hanja`, `/mistakes`, `/reading`) —
grep across all ten pages returned only comments and API-path strings.

**MockMode ↔ ExamActiveContext wiring** (`MockMode.tsx:198-204`): publishes
`phase === 'exam'` via an effect keyed on `[phase, setExamActive]`; cleanup forces
`false` on unmount (covers navigate-away, browser back, Topik unmount, StrictMode
double-mount). The provider mounts in `Shell` (`Shell.tsx:59`), so writer (MockMode,
deep in the outlet) and reader (ChatFab) share one instance; `useExamActive` has a
safe no-op default outside the provider (`exam-active-context.ts`) so standalone page
tests can't crash. **Timer undisturbed**: the countdown is a wall-clock deadline
(`deadlineRef` stamped once on mount, `MockMode.tsx:728-737`; remaining derived from
`deadline − Date.now()`, never interval ticks), and the exam-active effect neither
remounts `ExamRunner` nor touches the deadline. Context flips only re-render context
consumers (provider passes a stable `children` element). No stuck-true path found:
every phase exit (submit → results, restart → select, unmount) writes `false`.

### Scope B: hexagon LearnMenu

- **Open/close**: scrim tap (`LearnMenu.tsx:80`), Esc (`useModalA11y`), row activation
  (`goto` navigates then closes; same-path tap skips the navigate and still closes,
  `LearnMenu.tsx:58-66`), hexagon re-tap (scrim stops above the nav —
  `index.css .km-learnmenu__scrim { bottom: calc(var(--shell-bottomnav-h) + …) }` — so
  the bar stays tappable), and route change (Shell derive-during-render close,
  `Shell.tsx:45-49`, covers browser back/forward with the menu open, without a
  one-frame flash). No stuck-open path found.
- **All 7 items → real routes**: `LEARN_SUBPAGE_IDS` (`nav.ts:262-270`) =
  topik/ttmik/flashcards/grammar/writing/hanja/reading; every path has a matching
  `<Route>` in `App.tsx:118-124`. The compile-time bucket exhaustiveness checks
  (`nav.ts:295-318`) are intact and `tsc` is green.
- **Focus trap / restore**: `useModalA11y` container is the **panel** ref
  (`LearnMenu.tsx:51-56,83`), so the scrim (a `tabIndex={-1}` button *outside* the
  panel) is excluded from the trap's focusable set — Tab/Shift-Tab wrap strictly
  across the 7 rows and never land on the invisible scrim. Focus restores to the
  hexagon on close (captured `document.activeElement`, restored via `queueMicrotask`,
  `useModalA11y.ts:100-125`).
- **Invisible-focus foot-gun**: addressed — the first row (initial focus target) gets
  `animationDelay: 0` while the rest stagger bottom-up (`LearnMenu.tsx:109-113`), so
  keyboard focus never sits on a not-yet-revealed row.
- **Reduced motion**: the global `prefers-reduced-motion` block zeroes animation
  duration AND delay (`index.css:165-173`) — instant complete list.
- Tests: `LearnMenu.test.tsx` + `BottomNav.test.tsx` suites pass.

### Scope B: ChatFab visibility matrix

- **Hidden**: `/chat`, `/settings` (segment-boundary prefix match, lowercased first so
  it agrees with React Router's case-insensitive matching — `ChatFab.tsx:29-38`;
  `/chatter`-style siblings correctly NOT hidden); `examActive === true`;
  `keyboardOpen === true`. **Visible** on every other authenticated route; `/login`
  has no Shell so no FAB by construction.
- **Stuck-hidden analysis**: `examActive` cannot stick (see MockMode analysis);
  `keyboardOpen` derives per-read from `visualViewport` via `useSyncExternalStore`
  (no cached stale state); path check is pure. No stuck state found.
- **`useKeyboardOpen` pinch-zoom fix confirmed in code** (`useKeyboardOpen.ts:52-61`):
  `vv.height * vv.scale < innerHeight * 0.75` normalizes visual→layout px so
  pinch-zoom-in no longer reads as a keyboard, with a defensive non-finite/≤0 scale
  fallback to 1; missing `visualViewport` degrades to `false` (FAB stays visible —
  correct failure mode). Listeners: `resize` + `scroll` on the vv object, removed in
  the unsubscribe cleanup. Test suite covers the matrix; passes.

### Scope B: Shell mount / stacking

- LearnMenu + ChatFab both mount in `Shell.tsx` (`:65,73-75`), outside
  `.km-shell__scroll` — the FAB is `position: fixed` (stagnant per 8bef52f) with a
  column-aware right offset so it hugs the 480px shell on desktop.
- Z-order (`index.css`): nav sticky wrapper z-10 < ChatFab z-40 < LearnMenu overlay
  z-60 < toasts z-80. FAB under the scrim when the menu is open (spec-OK), FAB above
  page content, menu panel above everything but toasts. No conflict found besides R-1.

### Scope C: global

- **Back button after redirects**: every shim renders `<Navigate … replace>`
  (`lib/redirects.tsx:65`), including the tab-aware `/reference` shim
  (`ReferenceRedirect.tsx:18` — maps `?tab=dictionary|grammar|lists` onto
  `/review/dictionary`, `/review/grammar`, `/review/vocab?tab=lists`; unknown tab →
  `/review/vocab`). The `*` catch-all (`App.tsx:133`), the auth redirects
  (`App.tsx:164,183`), and Chat's seed-clear (`Chat.tsx:332`) are all `replace` too.
  No history trap: back from a shimmed landing returns to the page before the old
  link, never bounces.
- **nginx refresh-safety (P1.1)**: the km-lb API location matches by Accept header —
  navigations carrying `text/html` are steered to the client container even on paths
  that collide with API prefixes (`Deploy/nginx.conf:82-92`, mirrored in
  `nginx-blue-active.conf`/`nginx-green-active.conf`). **Live-verified on :1840**:
  `GET` with `Accept: text/html` on `/learn/listen`, `/learn/hanja`,
  `/review/mistakes`, `/progress` (API-colliding), `/settings` (API-colliding), and
  legacy `/ttmik` all return `200 text/html` (SPA shell); the same `/progress` with
  `Accept: application/json` returns `401 application/json` from the API — real
  XHR/SSE traffic unaffected. Caveat (informational): any API URL opened as a browser
  navigation (e.g. an audio URL in a new tab) would now get the SPA shell instead of
  the resource; no in-app link does this today.

---

## Tally

- BROKEN: 1 (B-1 — Images orphaned)
- RISK: 2 (R-1 FAB/nav overlap on short landscape viewports; R-2 accepted-design note)
- OK: everything else in scope, backed by 887 passing client tests + tsc 0 + live checks.
