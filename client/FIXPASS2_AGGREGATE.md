# /fixpass — Pass 2 aggregate

> Aggregator: parent session. Sources: `REVIEW_P2A_interactive.md`,
> `REVIEW_P2B_visual.md`, `REVIEW_P2C_settings.md`, `REVIEW_P2D_mocks.md`,
> `REVIEW_P2E_screens_A.md`, `REVIEW_P2F_screens_BC_plan.md`.
> Date: 2026-05-29.

## Reviewer roll-up

| Reviewer | Surface | Verdict | BLOCKER | SHOULD-FIX |
|---|---|---|---:|---:|
| A — interactive composites | Tapword, KoreanPassage, WordPopover, AudioBlock, Flashcard, Sheet, Topbar, Toggle | PASS WITH CONDITIONS | **3** | 8 |
| B — visual composites | SkillBar, SkillsCompare, TaskCard, TianGrid, HanjaCell, GoldRule, CornerMark, MockBadge | PASS WITH CONDITIONS | 0 | 3 |
| C — settings infra | palette-presets, settings.ts, Provider trio, SwatchPicker, SECURITY.md gap | PASS WITH CONDITIONS | **1** | 7 |
| D — mocks + types + hook | 12 mock fixtures, domain.ts, useEndpointOrMock, MockBadge CSS | PASS WITH CONDITIONS | 0 | 5 |
| E — screens A | Today, Reading, Review, Chat | PASS WITH CONDITIONS | 0 | 9 |
| F — screens B+C + plan | Topik, Diagnostic, Grammar, Hanja, Images, Reference, Settings, App.tsx | PASS WITH CONDITIONS | **3** | 10 |
| **Total** | — | **PASS WITH CONDITIONS** | **7** | **42** |

## BLOCKERs — every one, explicitly

| ID | Source | File:line | Headline | Recommended fix |
|---|---|---|---|---|
| **A-B1** | A | `components/KoreanPassage.tsx`, `components/AudioBlock.tsx` (no `.test.tsx`) | The two most complex interactive composites have no tests. Bar §2 Testing: every public function has at least one test. | Add `KoreanPassage.test.tsx` (token-walk, gram-span batching, EN toggle, malformed-fixture tolerance) + `AudioBlock.test.tsx` (play `aria-pressed`, interval cleanup on unmount, speed pill, transcript toggle). |
| **A-B2** | A | `Sheet.tsx`, `WordPopover.tsx` (close paths) | No focus restoration on close. Every word-tap and list-sheet drops keyboard focus to `<body>`. Same flaw filed in Pass 1 against MoreSheet — now hits the learning gesture itself. | Capture `document.activeElement` on open, restore via `queueMicrotask` on close. Extract `useModalA11y` hook (rule-of-three with MoreSheet). |
| **A-B3** | A | `Sheet.tsx` | `role="dialog" aria-modal="true"` is a false promise — no focus trap, no initial focus. Tab escapes the sheet. | Add focus-trap (loop Tab through focusable descendants) + initial focus to first focusable on mount. Folded into `useModalA11y` hook. |
| **C-B1** | C | `client/SECURITY.md` (missing settings section) | SECURITY.md has no §Settings substrate section despite Pass 2 adding `localStorage["km.settings"]`, debounced DOM `setProperty` writes, palette preset application. Bar §2+§5 require per-component security docs. | Add §Settings substrate to SECURITY.md: localStorage I/O, cross-tab race (acknowledged Pass-9 deferral), allowlisted CSS-var writes, palette preset injection. |
| **F-B1** | F | `Repository/client/TESTS.md` (missing) | Client `README.md` + `SECURITY.md` cite `Repository/client/TESTS.md` but the file is at the **project root** (`/root/Jared/9b. Korean Master -- OVERNIGHT/TESTS.md`). README link target doesn't exist. | Either (a) move/symlink TESTS.md into `Repository/client/`, or (b) update README + SECURITY references to point at the project-root path. (a) is cleaner — TESTS lives next to what it tests. |
| **F-B2** | F | `pages/Diagnostic.tsx:64-71` | Diagnostic defaults to `results` mode because the snapshot mock ships dimensions. Fresh boot never sees the design-spec Intro layout. QA can't verify Intro side-by-side with `Korean Master.html`. Plan exit criterion 1 fails because of this. | Either (a) make the mock snapshot empty by default (dimensions = []), or (b) gate mode initialization on a "first-visit" flag from localStorage instead of presence of dimensions. (a) matches the design's intent. |
| **F-B3** | F | `pages/Settings.tsx` (notif channel logic) | Settings keeps `notif.channel.email`/`sms` = true after the email/phone fields are cleared. Stale opt-in persists into the saved settings + future server sync (Pass 9). | When email/phone is set to empty string, also set the corresponding channel toggle to false (one-way: clearing field clears channel; setting field doesn't auto-enable channel). |

## Top SHOULD-FIX (highest impact)

| ID | Source | Headline |
|---|---|---|
| **D-SF-1** | D | `useEndpointOrMock` doesn't reset `data`/`isMock` on `key` change — stale data + lying badge during Pass-3 refetch. |
| **D-SF-2** | D | `MockBadge` references `km-mock-badge` CSS class that doesn't exist in `styles/index.css`. |
| **D-SF-3** | D | `useEndpointOrMock` header has no threat-model paragraph despite being the Pass 3+ network substrate. |
| **B-SF-1** | B | `SkillBar` `animated={false}` silently zeroes the bar forever; the prop is redundant given the internal `ready` gate. |
| **B-SF-2** | B | `SkillsCompare` picker uses `role="tablist"` without `tabpanel`s and without arrow-key nav — confused-deputy ARIA. Switch to `radiogroup` + `radio` + `aria-checked`. |
| **B-SF-3** | B | `TaskCard` `min-width: 260px` on the card itself can cause horizontal overflow. Move the floor to the parent grid (matches prototype). |
| **E-SF-1** | E | `Chat.tsx` wipes user-sent turns on any `seed` identity change — race against `settings.name` triggers reset. |
| **E-SF-2** | E | `KoreanPassage` `gram-span` has `onClick` but no `role`, `tabIndex`, or key handler — gesture is mouse-only despite Tapword being keyboard-accessible. |
| **E-SF-3** | E | `Review.tsx:699-706` renders legitimate empty bank ("0 banked cards") as a vermilion `ErrorCard` with `window.location.reload()` retry. |
| **E-SF-5** | E | `retry = () => window.location.reload()` is the wrong abstraction on **4 screens** (Today, Reading, Review, Chat). `useEndpointOrMock` already supports key-driven refetch — expose it. |
| **E-SF-7** | E | `Review.rate()` discards the rating and always advances — FSRS contract broken. |
| **E-SF-8** | E | `Review.tsx` `error` prop derived from `!vocab.data || !lists.data` mis-fires on first paint AND on legitimate empty list. |
| **C-S1** | C | `resetSettings` leans on debounce instead of persisting immediately. Rapid close-and-quit can lose the reset. |
| **C-S4** | C | `applyPaletteVars` never clears old keys → stale tokens stick when the user picks a preset with fewer overrides. |
| **C-S5** | C | `SwatchPicker` arrow keys move selection; Space/Enter activation isn't separately implemented. |
| **C-S7** | C | `SwatchPicker` arrow-key behaviour conflates focus and selection (every arrow press writes settings). |
| **F-SF-1** | F | `Settings.tsx` renders MockBadge unconditionally; should gate on `isMock` like Today / Hanja. |
| **F-SF-2** | F | `Diagnostic.fatalError` swallows non-fatal errors silently. |
| **F-SF-4** | F | `Diagnostic` choice buttons have BOTH `aria-pressed` AND `aria-checked` on `role="radio"` — pick one. |
| **F-SF-5** | F | `Images.wordToPopover` flattens `ex_kr` to gloss; loses provenance. |
| **F-SF-6** | F | `Topik.Skip` increments `idx` but doesn't track skipped IDs. |
| **F-SF-7** | F | `Reference.entryToPopover` lies about POS for hanja entries. |
| **F-SF-10** | F | `Reference` search debounce never flushes on unmount — leaks `setTimeout`. |
| **A-SF-1** | A | `Tapword` Space handler swallows the key without the role-contract `onKeyUp` shape. |
| **A-SF-2** | A | `WordPopover` focus-trap selector is incomplete (misses `input`, `select`, `textarea`). |
| **A-SF-3** | A | `WordPopover` keydown Esc handler stops propagation — breaks nested-modal cleanup if a future screen mounts one above it. |
| **A-SF-7** | A | `WordPopover.tsx:171` `onKeyDown` is attached to the dialog, not the document — misses Esc when focus is in the drawer. |

## Cross-cutting observations (multiple reviewers)

1. **Modal a11y duplicated 3×** (`WordPopover`, `Sheet`, `MoreSheet`). Same Esc + backdrop + body-scroll-lock + missing-focus-restore pattern. Rule-of-three triggered. **Extract `useModalA11y` hook** that handles open/close, Esc, focus trap, focus restore, scroll lock.
2. **`ErrorCard` duplicated 4×** in screen files (Today, Reading, Review, Chat). Extract to `components/ErrorCard.tsx`.
3. **`window.location.reload()` as retry primitive** on 4 screens. Wrong — `useEndpointOrMock` already has the substrate. Expose a `refetch()` from the hook and wire `retry` to it.
4. **ARIA tablist misuse** on both `SkillsCompare` (picker — should be radiogroup) and `Review` sub-tabs (`role="tablist"` without `tabpanel`s + no arrow-key nav). Either fix the contract (real tabpanels + keyboard) or drop the role.
5. **`ScreenStub.tsx` still in `src/pages/`** but no Pass 2 screen renders one. Plan says it's a primitive for future passes — fine; flag in FOLLOW_UPS so a future cleanup doesn't silently delete it.

## PRAISE — fix-pass must not undo

- A: `KoreanPassage` dynamic gid extraction (improvement on prototype's hard-coded `'g4'`); WordPopover Esc handler; Toggle keyboard contract; Flashcard controlled-by-design split.
- B: SkillBar scoring honesty (0–100 → bands, no L3.4); SkillBar `clamp(0,100)` defense; SkillsCompare empty-refs guard + missing-refId fallback; TianGrid CSS-only + aria-hidden; HanjaCell accessible-name composition; MockBadge PROD gate.
- C: Three-file Settings provider/hook/context split (matches Pass 1 PRAISE). Palette presets verbatim port from `shared.jsx`.
- D: `raceAgainstAbort` pattern in useEndpointOrMock; mocks faithful to data.js shapes.
- E: Tap-anything contract honoured on Tapword; FSRS rating UI shape; register-aware Chat opener.
- F: MockBadge on every screen (plan exit criterion 3 PASS); SettingsProvider wrap position correct; ScreenStub left as a primitive (not deleted).
- **Pass 1 PRAISE confirmed intact by all reviewers**: auth threat models, provider/hook/context split, BottomNav location-derived active, `lib/nav.ts` Map+throw, AbortController StrictMode handling.

## Recommendation

Dispatch a single fix-pass agent against:

- **Every BLOCKER (7)**: A-B1, A-B2, A-B3, C-B1, F-B1, F-B2, F-B3.
- **Top 10 SHOULD-FIX**: D-SF-1, D-SF-2, D-SF-3, B-SF-1, B-SF-2, B-SF-3, E-SF-1, E-SF-2, E-SF-3, E-SF-5.
- **Cross-cutting refactor**: extract `useModalA11y` (closes A-B2, A-B3, A-SF-2, A-SF-7); extract `ErrorCard` (closes 4× duplication); expose `refetch` from `useEndpointOrMock` (closes E-SF-5 + supports D-SF-1).
- **Settings refinements**: C-S1, C-S4, C-S5, C-S7.
- **Cheap while in file**: E-SF-7 (FSRS), E-SF-8 (Review error derivation), F-SF-1 (Settings MockBadge gating), F-SF-4 (Diagnostic ARIA dedup), F-SF-10 (Reference debounce unmount), A-SF-1, A-SF-3, F-SF-5..7.

Out of scope: NITs unless trivially fixable while in the same file; the `ScreenStub` retention question (flag in FOLLOW_UPS); ARIA tablist correctness on Review tabs is a SHOULD-FIX but maps to a bigger redesign — defer to FU.
