# Review — Guided tutorial: integration, surface anchors, Settings UI, test-harness fixes

Reviewer: independent senior review (integration slice). Branch `feat/tutorial-tour` vs `origin/rebuild`, worktree `.claude/worktrees/tutorial-tour`. Report only — no code changed.

## Summary verdict

**PASS — no blockers.** 0 BLOCKER / 2 SHOULD-FIX / 4 NIT / 6 PRAISE.

The test-harness fixes are sound and do **not** weaken the suites: every pre-existing assertion survives verbatim (assertion counts identical before/after — see the Bar checklist), the verified-user AuthContext stub is honest, and the inert-TourProvider stubbing is a genuinely hermetic gate, not an assertion bypass. Anchors are inert `data-tour` attributes on the correct stable controls; the full client suite (2,211 tests, 127 files) passes, `tsc --noEmit` is clean, and eslint reports nothing on the touched files. The two SHOULD-FIXes are a duplicate `chat-fab` anchor on desktop chrome and zero direct test coverage of the new Settings "Help & tours" UI.

## Bar checklist

| Bar item | Verdict | Evidence |
|---|---|---|
| Shell harness fix drops/weakens no LearnMenu/FeedbackFab assertion | **PASS** | `Shell.test.tsx`: 14 `it()` / 48 `expect()` on both `origin/rebuild` and branch; `Shell.deviceAdaptive.test.tsx`: 8 / 16 on both. Diff bodies are wrapper-only: `AuthContext.Provider` around the render (Shell.test.tsx:113-124), a `vi.mock('../services/settings')` (Shell.test.tsx:66-75), and a `beforeEach`/`afterEach` localStorage seed/cleanup (Shell.test.tsx:170-181). One inline render in deviceAdaptive was replaced by the shared `renderShellAt` helper (Shell.deviceAdaptive.test.tsx:178) — same routes, same assertions. |
| Verified-user stub is honest — tests still catch real Shell regressions | **PASS** | `UnverifiedBanner.tsx:25` renders null unless `user.email_verified !== false` — a verified user (`Shell.test.tsx:79-92`) makes the banner genuinely inert via its real code path, not a mock of the banner. The LearnMenu phase machine, timers, and FeedbackFab all run their real implementations. |
| Inert TourProvider is a legitimate gate, not a skip | **PASS** | `TourProvider.tsx:275` — auto-fire returns early unless `hydrated`; `hydrated` is set only in the boot fetch's `finally` (TourProvider.tsx:198-200). The never-settling `fetchPrefs` mock therefore keeps the provider permanently un-hydrated through its **real** contract. The `km.toursSeen` all-seen localStorage seed (Shell.test.tsx:170-176) is a real second gate (TourProvider.tsx:278-283 checks `seen`). Neither stub touches Shell's own logic. |
| D2 grid test 4→5 still meaningfully asserts the layout | **PASS** (and strengthened) | `origin/rebuild`'s component already ships 5 shelves (F-102 `sectionFor('images', …)` last — rebuild ReviewLibrary.tsx:132) while rebuild's D2 block still pinned 4 (rebuild ReviewLibrary.test.tsx:229,249) — i.e. the branch repairs a stale pin left by the F-102 merge, it does not relax anything. The branch keeps the exact-class mobile pin (ReviewLibrary.test.tsx:228), keeps the order assertions and **adds** `rowText[4]` "Images" (ReviewLibrary.test.tsx:255-256), keeps the pinned `grid-template-columns` CSS test, and correctly reframes the orphan-guard test as ACTIVE at five shelves (ReviewLibrary.test.tsx:299; guard at ReviewLibrary.css:162-163). |
| `data-tour` anchors on correct, stable elements; no DOM/className shift; inert | **PASS** (one duplicate — SF-1) | All anchors are bare attributes on existing elements; none wraps or reorders DOM. `Button` (Button.tsx:56 `...rest` → :69) and `CityCard` (CityCard.tsx:66/76 `...rest`) both spread onto the real DOM node, so anchors placed via those components land. Route↔anchor mapping verified against App.tsx:120-172 (e.g. `flashcards` tour path `/learn/vocab` → `Review.tsx` anchors `vocab-lists`/`vocab-study`; `library` → `ReviewLibrary.tsx` `library-sections`). No test pins `outerHTML` or snapshots that the attributes could break; the one exact-attribute pin (`class` — ReviewLibrary.test.tsx:228) is untouched by `data-tour`. |
| Settings Replay/Skip actually work, accessible, on-convention | **PASS** (coverage gap — SF-2) | Replay: `tour.replay(id)` ignores seen state and navigates first for exact-path tours (TourProvider.tsx:245-264). Skip all: `markAllSeen` → in-memory + `storeSeenTours` localStorage + best-effort server read-merge-write (TourProvider.tsx:160-174, 110-145) — auto-fire checks `seen.has(...)` so suppression is real and persisted both tiers. Select has an `aria-label` (Settings.tsx:2503), Replay is disabled until a pick, DOM value is narrowed via `isTourId` before use (Settings.tsx:2523), skip-all disables at all-seen with an honest label swap (Settings.tsx:2536-2545) and reuses the existing raw reset-button class recipe (matches Settings.tsx:1313). |
| tour.css: themes, accent, reduced-motion, scoped | **PASS** | Every rule lives under `.driver-popover.km-tour` (tour.css:21-104) — cannot leak into app styles or restyle other driver consumers (there are none). Colors are theme-scoped tokens (`--ink-3`/`--paper*`) correct in both `data-theme`s; the accent rides `--vermilion`, which the `data-accent` Seoul-neon presets remap. Reduced motion is handled at the engine level (`animate: !prefersReducedMotion()`, tourDriver.ts:93). The two `!important`s are justified per-side arrow overrides (tour.css:93-104). One dead-token nit (N-1). |
| Shell mount order safe for real users | **PASS** | `TourProvider` renders only a context provider — zero DOM wrapper (TourProvider.tsx:315) — so `.km-appframe`/`.km-shell`/LearnMenu sibling shape is byte-identical; the deviceAdaptive sibling-relationship test passes unchanged. It sits inside `ExamActiveProvider` (it reads `useExamActive`, TourProvider.tsx:96) and above the `Outlet` (Shell.tsx:190-231), and Shell is always under `BrowserRouter` (App.tsx) so its `useLocation`/`useNavigate` are safe. Boot-fetch failure is caught and falls back to localStorage (TourProvider.tsx:194-200) — no render dependency on the network. |

## Findings by category

- **BLOCKER** — none.
- **SHOULD-FIX** — SF-1 (duplicate `chat-fab` anchor on desktop), SF-2 (Settings "Help & tours" UI untested).
- **NIT** — N-1 (`--hairline` token undefined), N-2 (replay can silently show only connective copy), N-3 (first-run tour copy/side hints tuned for mobile chrome), N-4 (Reading anchor on an unclassed `div`).
- **PRAISE** — P-1…P-6 below.

## Detailed findings

### SF-1 — Duplicate `[data-tour="chat-fab"]` in sidebar (tablet/desktop) chrome; resolution depends on DOM order and the step copy names the wrong element

- `Sidebar.tsx:194` puts `data-tour="chat-fab"` on the sidebar's Chat link, and `ChatFab.tsx:65` puts the same key on the floating dot. The floating `ChatFab` is mounted unconditionally in both chromes (Shell.tsx:206) and has no desktop hide (`.km-chatfab`, styles/index.css:1711-1737 — `position: fixed` at every width; its hide conditions are route/exam/keyboard only, ChatFab.tsx:57-59). So on ≥768px **both** elements match.
- The comment at Sidebar.tsx:127-130 argues "the two chromes are mutually exclusive, so a selector only ever resolves one" — true for the `tab-*` keys (BottomNav is unmounted in sidebar layout, Shell.tsx:208-217), **false for `chat-fab`**.
- Effect: `document.querySelector` (missing-target guard, tourDriver.ts:71) and driver.js's own element resolution both take the first match in DOM order — the Sidebar precedes `.km-shell` (Shell.tsx:197-198), so the sidebar link wins. Deterministic today, but it silently inverts if the Sidebar ever moves after the shell column, and the step copy — "This **dot** opens the AI tutor chat" (tours.ts:117-118) — describes the floating dot while the spotlight lands on a sidebar row.
- Suggested fix: give the sidebar link its own key (e.g. `chat-link`) and either add a chrome-neutral copy line or an alternate step target list; or hide the floating dot under sidebar layout if that is the intended chrome. At minimum, correct the copy and document the DOM-order dependency.

### SF-2 — The Settings "Help & tours" section has zero direct test coverage

- `ToursSection` reads the context leniently and renders `null` without a provider (Settings.tsx:2478-2480 via `useTour.ts:23-25`). Every one of the 65 existing `Settings.test.tsx` tests renders provider-free, so **none of them ever renders the new section** — the picker, the `isTourId` narrowing, the Replay disabled state, the skip-all disabled/label-swap logic, and the `tour.replay`/`tour.markAllSeen` wiring are all unexercised. `TourProvider.test.tsx:307-338` covers the provider functions, not the Settings wiring to them.
- The harness cost is small: one describe block wrapping `<Settings/>` in a stub `TourContext.Provider` (the context value is a plain object) asserting: section renders; picking "Hanja" + Replay calls `replay('hanja')`; Replay disabled at empty pick; skip-all calls `markAllSeen` and reads disabled + "All tours are off" when `seen` ⊇ `TOUR_IDS`.
- Note: the two changes that *were* made to Settings.test.tsx (DEFAULT_PREFS `toursSeen: []` at :204, and the PUT-body expectation at :949) are correct and consistent with the live-`loadSeenTours()` sourcing in Settings.tsx:916-920.

### N-1 — `--hairline` is referenced but defined nowhere

- tour.css:27 — `0 0 0 1px var(--hairline, rgba(0, 0, 0, 0.08))`. Zero definitions of `--hairline:` anywhere in `client/src` (both themes), so the literal fallback always applies; on the Night theme a 8%-black ring on a dark `--ink-3` surface is effectively invisible. Use an existing token (`--line` / `--line-strong`, which `.km-chatfab` itself uses) or define the token; as-is it is dead weight that implies a theming hook that doesn't exist.

### N-2 — Replay can silently degrade to copy-only

- Replay navigates and fires after a fixed 600 ms (`TourProvider.tsx:255-258`, `START_DELAY_MS` :79). If the destination page's data hasn't painted its anchored controls by then (e.g. Writing's prompt card behind an API call), those steps are dropped (tourDriver.ts:71) and the user sees only the un-anchored connective popovers with no hint the spotlights were skipped. Every registered tour has at least one un-anchored step, so it never hard-fails — acceptable, but worth a follow-up (retry-resolve per step, or a longer replay delay).

### N-3 — First-run tour copy/side hints are mobile-tuned on desktop

- The tab steps hint `side: 'top'` (tours.ts:84-107 — right for a bottom bar; driver flips them beside the left sidebar, so this is cosmetic), and "Tap any card in today's plan" (tours.ts:112) reads slightly off with a pointer. Low priority; the `learn-launcher` fallback anchor on the sidebar section (Sidebar.tsx:169-171) is a nice chrome-aware touch.

### N-4 — `reading-shelf` anchor sits on an anonymous `div`

- Reading.tsx:408 — the anchor went on a previously bare `<div>` (no className, no role). It works and changes nothing visually, but it is the one anchor in the set with no semantic identity of its own; if `BookShelf`'s wrapper is ever refactored away the anchor disappears without any test or type noticing. Consider anchoring the section list element instead. (All other anchors sit on labeled controls/sections: e.g. `role="tablist"` Hanja.tsx:881-885, `role="radiogroup"` Writing.tsx:806, `aria-label`ed lists Ttmik.tsx:517-521, ReviewLibrary.tsx:168.)

### PRAISE

- **P-1** — The harness repair is a model of how to fix a coupled suite without weakening it: assertion bodies untouched (verified by count and by diff), the stubs go through the components' *real* gating contracts (banner's `email_verified !== false`; provider's `hydrated` latch), and the module doc comments (Shell.test.tsx:29-44) state the posture and its rationale precisely.
- **P-2** — Defence-in-depth in the harness is real, not decorative: the localStorage all-seen seed would keep the tests green even against a future TourProvider that fired pre-hydration, exactly as claimed (TourProvider.tsx:278-283 reads `seen` before firing).
- **P-3** — The D2 fix *strengthens* the grid contract (adds the Images order pin; reframes the orphan-guard test from "inert" to "ACTIVE" with the correct five-shelf arithmetic) while repairing a stale 4-count that rebuild's F-102 merge left broken.
- **P-4** — The anchoring contract (`data-tour` on real controls, never CSS classes — tours.ts:11-17) plus the missing-target drop and the 'unavailable'-not-seen retry semantics make the tour system unable to wedge the UI or burn a first-run on a half-loaded page.
- **P-5** — `tour.css` is exemplary third-party re-skinning: single scoping class, tokens only, cascade-order override documented, the two unavoidable `!important`s isolated and explained.
- **P-6** — The Settings two-writer story for `toursSeen` (live `loadSeenTours()` at PUT-compose time, field deliberately outside the change-diff — Settings.tsx:718-730, 916-920) closes the clobber race between Settings and TourProvider cleanly, and is documented at every touch point.

## Test evidence

Run in the worktree (`client/`, vitest 4.1.7):

- Targeted (the 7 touched/adjacent files: Shell, Shell.deviceAdaptive, ReviewLibrary, Settings, TourProvider, tours, services/settings): **7 files, 149 tests — all pass.**
- Full client suite: **127 files, 2,211 tests — all pass** (~21 s).
- `npx tsc --noEmit`: clean. `npx eslint` on Shell/Shell tests/Settings/ReviewLibrary.test/Sidebar/BottomNav: no findings.
