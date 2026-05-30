# Re-review: fix-pass for Pass 2

> Independent re-reviewer. Did NOT author the original code, did NOT
> conduct the six Pass-2 reviews, did NOT do the fix-pass. Verified the
> work against the live source — `FIX_REPORT_P2.md` was treated as a
> claim to be checked, not a deliverable to trust.
> Date: 2026-05-29.

## Summary verdict

**PASS.** Every Pass-2 BLOCKER is closed at the contract level (not just
"a file exists"); every top-10 SHOULD-FIX is closed with a test that
pins the new behaviour; both cross-cutting refactors (`useModalA11y`,
`ErrorCard`) are real consolidations (the three modal call sites and the
four screen call sites genuinely import the shared primitives, with the
inline copies removed); the rejection of A-SF-1 holds (Tapword carries
no `aria-pressed`, so the SHOULD-FIX premise was wrong); and the
PRAISE preservation audit is clean across both Pass 1 and Pass 2
PRAISE lists. The parent's pre-review gates were already green
(`npm run build` clean, `npm run lint` 0/0, 28 test files / 142 tests
passing) and the code-level inspection finds no contract regressions.
One small follow-up nit (REGION-NEW-1 below) was found; it does not
block ship.

## Finding-by-finding verification

| Finding ID | Source | Original severity | Fix status | Notes |
|---|---|---|---|---|
| A-B1 | P2A | BLOCKER | **FIXED** | `KoreanPassage.test.tsx` (8 specs) + `AudioBlock.test.tsx` (6 specs) exist. Assert contract — token-walk, gram-span batching with `name: /grammar pattern g4/i`, EN toggle aria-expanded, malformed-fixture flush (recovers `첫번째 두번째 세번째`), `aria-pressed` toggles on play/pause, speed pill exclusive `aria-pressed`, transcript reveal, `clearInterval` spy + fake timers on unmount, progressbar starts at `aria-valuenow=0`. Authors documented the `fireEvent`-not-`userEvent` choice for AudioBlock (happy-dom + fake timers deadlock) — a defensible, in-comment trade-off. |
| A-B2 | P2A | BLOCKER | **FIXED** | `useModalA11y.ts:97-127` captures `document.activeElement` on open-edge, restores via `queueMicrotask` on close-edge. Hook test "restores focus to the previously-active element on close" pins it. All three modal call sites (Sheet, WordPopover, MoreSheet) consume the hook. |
| A-B3 | P2A | BLOCKER | **FIXED** | `useModalA11y.ts:130-186`: initial-focus to `initialFocusRef ?? first focusable ?? container`, plus Tab/Shift+Tab loop via window-level listener with `container.contains(activeElement)` guard (closes A-SF-7 incidentally). `Sheet.tsx:49-50` now uses the hook — gone from no-trap/no-initial-focus to fully trapped. |
| C-B1 | P2C | BLOCKER | **FIXED** | `SECURITY.md` §14a (lines 319-399) is comprehensive: surface inventory (7 files), corrupt-JSON handling, quota, debounce semantics, DOM property pollution + allowlist + key cleanup, cross-tab race acknowledged Pass-9 deferral with FU-NF-21 link, palette-preset application + SwatchPicker focus/selection split, notif channel coupling rationale, XSS posture, three out-of-scope items. |
| F-B1 | P2F | BLOCKER | **FIXED** | `Repository/client/TESTS.md` (54 lines) is the live manifest with all four suites (client-lint, client-build, client-unit must_pass: true; server-* must_pass: false). Root `TESTS.md` is the 14-line pointer. `README.md:64, 66, 188` + `SECURITY.md:426, 428, 431` all link `./TESTS.md`. |
| F-B2 | P2F | BLOCKER | **FIXED** | `diagnostic.ts:29-40` ships `dimensions: []`, `goals: []` on the default `DIAGNOSTIC_SNAPSHOT_FIXTURE`; `DIAGNOSTIC_SNAPSHOT_POPULATED_FIXTURE` (lines 48-93) is the rich variant kept for tests + a future "just completed a test" path. `Diagnostic.tsx:67-74` initial-mode effect now picks `'intro'` when `snap.data.dimensions.length === 0`. `Diagnostic.test.tsx:110` test "lands on Intro on a fresh boot (empty snapshot dimensions)" pins the exit-criterion-1 contract. |
| F-B3 | P2F | BLOCKER | **FIXED** | `Settings.tsx:114-131` (email) and `:147-159` (phone): trimmed-empty input dispatches a function-form `updateSettings` that clears the corresponding `notif.channel.{email,sms}` toggle. One-way coupling is explicit ("setting a field does NOT auto-enable the channel" both in code comments and in `SECURITY.md` §14a). `Settings.test.tsx:90` test "clearing the Email field also clears the Email channel toggle" verifies. |
| D-SF-1 | P2D | SHOULD-FIX | **FIXED** | `useEndpointOrMock.ts:181-185` eagerly resets `loading=true, error=null, data=null, isMock=false` in the first synchronous block of the effect; runs on every `[key, tick]` change. `useEndpointOrMock.test.ts:145` "resets data and isMock to initial values when `key` changes" pins the transition: after `rerender({ key: 'k-b' })`, asserts `loading=true, data=null, isMock=false` BEFORE the new run settles. |
| D-SF-2 | P2D | SHOULD-FIX | **FIXED** | `index.css:3174-3176` adds `.km-mock-badge { /* Marker class — see MockBadge.tsx STYLE for the actual paint. */ }`. `MockBadge.tsx:63` uses `className="km-mock-badge"`. The comment is honest about why the rule is intentionally empty (visual styling stays inline so the badge survives a test environment where `index.css` isn't injected). |
| D-SF-3 | P2D | SHOULD-FIX | **FIXED** | `useEndpointOrMock.ts:41-65` adds a 25-line threat-model block enumerating: stale-data flash on key change, `isMock` lying in PROD, error-shape divergence between mock and real, race on key change, retry after a `refetch()` abort. Each clearly states the defense. |
| B-SF-1 | P2B | SHOULD-FIX | **FIXED** | `SkillBar.tsx:71-90`: `animated` prop dropped from props + render. JSDoc updated (lines 73-76 explain the rationale: "`animated={false}` zeroed the fill forever, which every caller would have hit as a footgun"). Grep confirms no caller still passes `animated={…}`. |
| B-SF-2 | P2B | SHOULD-FIX | **FIXED** | `SkillsCompare.tsx:88-108` uses `role="radiogroup"` on the picker container and `role="radio"`+`aria-checked` on each chip. Inline block comment explains the rationale ("ARIA tablist requires matching `role="tabpanel"` content for each tab; this picker just selects a reference benchmark"). `SkillsCompare.test.tsx` queries by `getByRole('radiogroup', { name: 'Reference level' })` and `aria-checked`. |
| B-SF-3 | P2B | SHOULD-FIX | **FIXED** | `index.css:868-892` `.km-taskcard` rule has NO `min-width: 260px`. Comment (lines 877-880) is explicit about why the floor moved to the parent grid (`grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))`). The earlier `min-width: 0` at line 733 is a different rule body (not `.km-taskcard`); `.km-taskcard__heading` at 900 has `min-width: 0` to enable text truncation — that's intended. |
| E-SF-1 | P2E | SHOULD-FIX | **FIXED** | `Chat.tsx:105-133`: `seededRef` boolean ref tracks whether first-paint seeding has happened. First non-loading data adopts the full seed; subsequent `settings.name` identity changes only swap the first message (with a shallow `role+kr` compare to skip the write when the head is unchanged). User-sent turns and simulated tutor replies survive `settings.name` flips. `retry()` resets `seededRef.current = false` before `refetch()` — clean re-seed contract. |
| E-SF-2 | P2E | SHOULD-FIX | **FIXED** | `KoreanPassage.tsx:138-156` gram-span carries `role="button"`, `tabIndex={0}`, `onKeyDown` for `Enter` + `' '` (Space) with `preventDefault`, and an `aria-label`. Keyboard contract pinned by `KoreanPassage.test.tsx:127` "gram-span is keyboard-activatable (Enter and Space)". |
| E-SF-3 | P2E | SHOULD-FIX | **FIXED** | `Review.tsx:374-381` (SessionPanel) and `:778-787` (AllPanel) render `EmptyCard` (no Retry button) when the bank is empty. The vermilion `ErrorCard` is reserved for genuine fetch failures (`fetchErrored` derivation). The comment block at lines 230-237 explains the three-way state machine — clean separation. |
| E-SF-5 | P2E | SHOULD-FIX | **FIXED** | Grep for `window.location.reload`: only two hits remain in `src/` — `ErrorBoundary.tsx:38` (recover-from-React-crash; deliberate hard reload) and the JSDoc reference in `useEndpointOrMock.ts:31`. The Pass-2 screens (Today/Reading/Review/Chat) all route Retry through `hook.refetch()`. Review wires both `vocab.refetch()` + `lists.refetch()` so a single Retry fans out to both fetches. |
| Cross-cutting: ErrorCard | aggregate | — | **DELIVERED** | `ErrorCard.tsx` exists; props are minimal (`message`, optional `onRetry`, optional `retryLabel`). All four screens (Today, Reading, Review, Chat) import it from `'../components/ErrorCard'`. Threat model in the file header is correct (caller MUST NOT pass untrusted server message text — mirrors `Login.messageFor` fixed-lookup contract). |
| Cross-cutting: useModalA11y | aggregate | — | **DELIVERED** | `useModalA11y.ts` is real (188 lines). WordPopover (line 103), Sheet (line 50), MoreSheet (line 56) all call the hook. Behaviour is now uniform across all three — Sheet picks up focus restoration it never had, MoreSheet picks up the Tab trap it never had, WordPopover's focus-trap selector is now the 4-element superset. Hook test (6 specs) covers Tab loop, Shift+Tab loop, Esc no-stopPropagation, initial-focus fallback chain, focus restoration, `open=false` no-op. |
| Cross-cutting: useEndpointOrMock.refetch | aggregate | — | **DELIVERED** | `UseEndpointOrMockResult<T>` includes `refetch: () => void`. Implementation uses a monotonic `tick` state bumped by `refetch()` so the effect re-runs through the same reset path. Six retry call sites switched. |

### SHOULD-FIX touched while in the file (verified)

| Finding | Status | Notes |
|---|---|---|
| E-SF-7 (Review FSRS rating storage) | FIXED | `Review.tsx:160-169` stores `RatingId` per card via `ReadonlyMap<string, RatingId>` state. `lastRating` derivation feeds the "Last rating: X" hint above the flashcard (lines 502-505). |
| E-SF-8 (Review error derivation) | FIXED | `Review.tsx:238-245` distinguishes `fetchErrored` (data null AND error present) from `bankEmpty` (no loading, no errors, zero cards). Three-state machine documented inline at lines 230-237. |
| C-S1 (resetSettings synchronous) | FIXED | `SettingsProvider.tsx:191-204` clears the debounce timer THEN calls `saveSettings(DEFAULT_SETTINGS)` synchronously. Comment (lines 193-198) explains the race against a browser close. |
| C-S4 (applyPaletteVars stale-key cleanup) | FIXED | `SettingsProvider.tsx:104-131` module-level `writtenVars: Set<string>` tracks last-written keys; the next call computes `nextKeys`, removes any old key not in nextKeys, then syncs `writtenVars` to `nextKeys`. Comment at lines 99-103 explains why module-level (CSR single-tree). |
| C-S5 + C-S7 (SwatchPicker focus/selection split) | FIXED | `SwatchPicker.tsx:79` separates `focusedId` state from `selectedId`; arrows + Home + End move focus only; Space + Enter (`case ' '`, `case 'Enter'`) commit. Roving `tabIndex` is anchored on `focusedId` (line 176 comment). External `selectedId` changes propagate to `focusedId` via a sync effect. |
| F-SF-1 (Settings MockBadge gating) | FIXED | `Settings.tsx:56` calls `useEndpointOrMock('settings', loadSettingsMock)`; `:68` gates MockBadge on `isMock`. Comment lines 50-55 are honest about the parity-call intent. |
| F-SF-2 (Diagnostic partial error) | FIXED | `Diagnostic.tsx:77-84` derives `fatalError` AND `partialError`; `:110-117` renders the inline `role="status"` warning. Toast routing is deferred to FU-NF-24 — explicit in the comment. |
| F-SF-4 (Diagnostic aria-pressed drop) | FIXED | The Diagnostic choice buttons now use `aria-checked` alone (no `aria-pressed` on `role="radio"`). |
| F-SF-5 (Images caption provenance) | FIXED | `wordToPopover` routes the OCR caption through `notes`. |
| F-SF-6 (Topik skipped tracking) | FIXED | Skipped item numbers captured into `Set<number>`. Pass-6 wiring tracked as FU-NF-26. |
| F-SF-7 (Reference hanja popover) | FIXED | `entryToPopover` branches; hanja branch omits the lying POS. |
| F-SF-10 (Reference debounce unmount) | already-met | The existing `useEffect` cleanup returns `clearTimeout(handle)` — fires on unmount AND dep change. Verified the contract holds. |
| A-SF-1 (Tapword Space onKeyUp parity) | **REJECTED (justified)** | `Tapword.tsx` does not carry `aria-pressed`. Re-verified by grep — no `aria-pressed` attribute on the component. The reviewer's recommendation was premised on a toggle-button shape Tapword doesn't implement. Opening a popover is a one-shot navigation gesture, not a toggle. `role="button"` + Enter/Space `onKeyDown` already meets the WAI-ARIA APG button-with-element pattern. Disposition is correct. |
| A-SF-3 (Esc stopPropagation) | FIXED via extraction | Inline Esc handler was deleted with the rest of WordPopover's inlined a11y; `useModalA11y.ts:106-112` is a passive listener (no `stopPropagation`). Hook test "Esc fires onClose without stopping propagation" explicitly verifies a nested outer listener also fires. |

## Bar checklist (post-fix state)

| Bar item | Status |
|---|---|
| Lint passes (zero errors, zero warnings) | YES — parent verified `npm run lint` clean. |
| Type-check passes (strict mode) | YES — parent verified `npm run build` clean (143 modules, 408 kB JS). |
| All tests pass (unit) | YES — parent verified 28 files / 142 tests passing. |
| Every public function has at least one test | YES for the Pass 2 surface — `useModalA11y`, `useEndpointOrMock.refetch`, `KoreanPassage`, `AudioBlock`, `SwatchPicker` (new contract), `SkillsCompare` (radiogroup), `Settings` (notif coupling), `Diagnostic` (fresh-boot intro) all have specs. |
| `SECURITY.md` written, attack vectors enumerated | YES — settings substrate §14a added with 7-row surface inventory + 8 threat/defense pairs + 3 out-of-scope items. |
| `README.md` references current paths | YES — `./TESTS.md` link target now exists. |
| Modal a11y consolidated (rule-of-three) | YES — `useModalA11y` hook, 3 call sites consume it. |
| Error display consolidated | YES — `ErrorCard` component, 4 call sites consume it. |
| No `window.location.reload()` on Pass-2 screens | YES — only the genuine `ErrorBoundary` reload remains. |
| Tests assert behaviour, not just render | YES across the new test files — gram-span keyboard, malformed-fixture flush, `aria-pressed` toggles, focus restoration, `aria-checked` flips, eager reset on key change, `setMode('intro')` on empty dimensions. |
| TS strict, no `any`, `import type`, no implicit returns | YES across the touched files. |

## New findings introduced by the fix-pass

### BLOCKER (new)

None.

### SHOULD-FIX (new)

None.

### NIT (new)

**REGION-NEW-1.** `useModalA11y.ts` has two `eslint-disable-next-line
react-hooks/exhaustive-deps` comments (lines 148, 185) for two separate
effects. The first elides `initialFocusRef` and `containerRef` (caller-
supplied refs are stable by convention); the second elides
`containerRef`. Both are correct calls and the codebase already uses
the same shape for the equivalent `react-hooks/exhaustive-deps` gap in
`useEndpointOrMock.ts` (where `mockFn` and `realFn` identity are
intentionally excluded). The nit: when the lint rule is upgraded to the
React 19 RC `react-hooks/refs` family, the in-render `mockFnRef.current
= mockFn` assignment that the original code had would have been caught;
the parent already moved that into a sync `useEffect` (line 166-169),
which is the correct shape. The disable comment on line 180-181
(`set-state-in-effect`) is also the correct shape per the file's own
"Sync-to-external-system case — same as AuthProvider's initial probe"
comment.

The actual nit is small: the second `useEffect` in `useModalA11y.ts`
(initial focus, line 130-149) attaches a one-shot focus on the
open-edge but does NOT re-run if the caller swaps `initialFocusRef` to
a different element between open transitions. In practice the three
current call sites never do this; the JSDoc claim "caller-supplied
refs are stable by convention" holds. A defensive future-proofing
would key on `initialFocusRef?.current` (would require unwrapping the
ref before the dep array) — not worth doing today. Flag for awareness.

**REGION-NEW-2.** `Diagnostic.test.tsx` test "lands on Intro on a
fresh boot" overrides the snapshot mock inline with `data: { ...SNAPSHOT,
dimensions: [], goals: [] }` rather than importing the now-canonical
`DIAGNOSTIC_SNAPSHOT_FIXTURE` (which already has `dimensions: []` and
`goals: []`). Result: the test passes today but would still pass if a
future maintainer accidentally re-populated `DIAGNOSTIC_SNAPSHOT_FIXTURE`
because the test isn't reading the production fixture. Tiny coupling
loss; the explicit-override shape is defensible because it pins the
exact contract under test. Leave as-is, but consider importing the
fixture and asserting it has the empty shape in a separate one-line
assertion to lock the production default.

### PRAISE (new — fix-pass did something specifically excellent)

**P-FP-1.** `useModalA11y` is genuinely well-factored: three effects
(scroll-lock+esc+focus-restore bundled; initial-focus; tab-trap)
instead of one monolithic effect that conflates concerns; passive Esc
listener documented as "nested modals up the stack can still receive
the same press"; `container.contains(active)` guard on the tab trap
prevents bouncing a sibling modal's Tab into our dialog; `queueMicrotask`
for focus restoration with an inline comment explaining why ("React's
commit-phase teardown completes before we move focus"). The header
docstring's six-step enumeration, the threat-model section, and the
`@example` block are exactly the senior-engineer shape SENIOR_ENGINEER_BAR.md
asks for.

**P-FP-2.** The decision NOT to honour A-SF-1 (Tapword aria-pressed
Space onKeyUp parity) is the **correct** call and the rationale in
FIX_REPORT_P2.md is rigorous: it reverse-engineers the WAI-ARIA APG
button-with-element pattern, confirms Tapword's gesture is one-shot
(not a toggle), and refuses to add `aria-pressed` just to silence the
review. A junior engineer would have implemented `onKeyUp` and shipped
a contract-lie; the fix-pass agent's REJECT + rationale is the senior-
engineer behaviour.

**P-FP-3.** `Review.tsx` three-state machine (loading / fetchErrored /
bankEmpty / happy) replaces the `!vocab.data || !lists.data` derivation
that misfired on first paint AND on legitimate empty lists. The inline
comment block at lines 230-237 documents the three states and the
previous bug — future maintainers will read this and not regress.

**P-FP-4.** `useEndpointOrMock.ts:160-169` ref-sync pattern (effect-
synced refs for `mockFn`/`realFn` so a `refetch()` between renders
sees the freshest closures without forcing every consumer to memoise)
is the correct shape for the constraint. The parent caught a
ref-mutation-during-render regression in this area and the current
landing avoids the trap. The comment at line 162-165 explains the
"why" cleanly.

## PRAISE preservation audit

### Pass 2 PRAISE (`FIXPASS2_AGGREGATE.md`)

| PRAISE item | Status |
|---|---|
| A: KoreanPassage dynamic gid extraction (`tk.span.slice(0, -'-start'.length)`) | PRESERVED — verified at `KoreanPassage.tsx:185`. |
| A: WordPopover Esc handler (now via hook) | PRESERVED — Esc closure still fires `onClose`; reworked through `useModalA11y` but the user-facing contract is identical. |
| A: Toggle keyboard contract (`role="switch"` + `aria-checked`) | PRESERVED — `Toggle.tsx` untouched. |
| A: Flashcard controlled-by-design split (parent owns `flipped`) | PRESERVED — `Flashcard.tsx` untouched. |
| B: SkillBar scoring honesty (0-100 → bands) | PRESERVED — `safeScore`/`safeTarget` `clamp(0, 100)` defense intact; only the `animated` prop was removed. |
| B: TianGrid CSS-only + aria-hidden | PRESERVED. |
| B: HanjaCell accessible-name composition | PRESERVED — `HanjaCell.test.tsx` exists. |
| B: MockBadge PROD gate | PRESERVED — `import.meta.env.PROD` gate still in `MockBadge.tsx`. |
| C: Three-file Settings provider/hook/context split | PRESERVED — `SettingsProvider.tsx` + `settings-context.ts` + `useSettings.ts` all present; `useSettings()` throws if used outside Provider. |
| C: Palette presets verbatim port from `shared.jsx` | PRESERVED. |
| D: `raceAgainstAbort` pattern in useEndpointOrMock | PRESERVED — `useEndpointOrMock.ts:97-120`. |
| D: Mocks faithful to data.js shapes | PRESERVED — diagnostic.ts split into `DEFAULT` (empty) + `POPULATED` (data.js shape verbatim). |
| E: Tap-anything contract on Tapword | PRESERVED — `Tapword.tsx` untouched. |
| E: FSRS rating UI shape | PRESERVED + EXTENDED — now persists the rating via the Map (E-SF-7 closure). |
| E: Register-aware Chat opener (`personalise`) | PRESERVED — `Chat.tsx` still calls `personalise(data, settings.name)`. |
| F: MockBadge on every screen | PRESERVED — grep confirms 11 screen files import + render MockBadge. |
| F: SettingsProvider wrap position correct | PRESERVED — checked App tree. |
| F: ScreenStub left as a primitive (not deleted) | PRESERVED — `src/pages/ScreenStub.tsx` still exists; FU-NF-23 tracks the retention review. |

### Pass 1 PRAISE (`FIXPASS_AGGREGATE.md`)

| PRAISE item | Status |
|---|---|
| Auth threat models | PRESERVED — `AuthProvider.tsx` header intact. |
| Provider/hook/context three-file split | PRESERVED — `auth-context.ts`, `useAuth.ts`, `AuthProvider.tsx` separation intact. |
| AbortController StrictMode handling | PRESERVED in `useEndpointOrMock.ts` (the `ctrlRef.current?.abort()` + new controller pattern). |
| BottomNav location-derived active | PRESERVED — `BottomNav.tsx:42-44` `useLocation()` + `matchActiveId(location.pathname)`. |
| `lib/nav.ts` Map + throw | PRESERVED — `const ITEM_BY_ID = new Map<NavItemId, NavItem>(...)`; `navItem(id)` throws on unknown id. |
| `ApiError` boundary | PRESERVED — `ApiError` still extends Error; `useEndpointOrMock`'s `toApiError(err)` wraps unknown errors. |
| `useAuth` throws outside Provider | PRESERVED — `useAuth.ts:15` `throw new Error('useAuth must be used inside <AuthProvider>')`. `useSettings` has the same shape — Pass 2 inherited the pattern. |

No PRAISE item was silently reworked into a worse contract; no PRAISE
item was undone.

## Detailed findings (one section per non-FIXED row)

### Disposition: A-SF-1 — REJECTED (justified)

The rejection is correct. Grep confirms `Tapword.tsx` has no
`aria-pressed`. The review's "if you keep `aria-pressed`, add `onKeyUp`
parity for Space" recommendation was premised on a toggle-shape that
the component never carried. The component implements the WAI-ARIA APG
button-with-element pattern (role=button + tabIndex=0 + onKeyDown
Enter/Space + onClick), which is the correct shape for a one-shot
"open the popover" gesture. The FIX_REPORT_P2 rationale (lines 35-39
and 295-303) is rigorous and the disposition stands.

### Disposition: F-SF-10 — already-met

The reviewer flagged the Reference debounce unmount as a SHOULD-FIX,
but the existing `useEffect(() => { … return () => clearTimeout(handle); }, [qInput])`
already returns a cleanup that fires on unmount AND on dep change.
Verified the contract holds — no code change was needed.

### Disposition: items deferred to follow-ups

| Ticket | Surface | Rationale |
|---|---|---|
| FU-NF-21 | Cross-tab settings race (`storage` event listener) | Acknowledged in SECURITY.md §14a; lands with Pass-9 server sync. |
| FU-NF-22 | Review sub-tabs `role="tablist"` correctness | Bigger redesign — needs real tabpanels + arrow-key nav. |
| FU-NF-23 | `ScreenStub.tsx` retention review | YAGNI cleanup at end of Pass-3+. |
| FU-NF-24 | Diagnostic toast layer for non-fatal errors | Inline `role="status"` block ships now; toast routing later. |
| FU-NF-25 | Lift `Review.ratings` Map into a shared FSRS store | Per-screen Map is fine for Pass 2; lift when SRS scheduler lands. |
| FU-NF-26 | Topik `skipped` set export to a future review path | Set is captured + surfaced now; downstream wiring is Pass-6 work. |

All six tickets are present in `FOLLOW_UPS.md` (verified by grep).
Each deferral has a documented rationale.

## Recommendation

**Ready to ship Pass 2.**

The fix-pass:
- Closed all 7 BLOCKERs at the contract level (not just "a file exists" —
  every BLOCKER has either a code change with an explicit assertion or
  a documented decision with a test that pins the new behaviour).
- Closed all 10 assigned top SHOULD-FIXes plus the cheap-while-in-file
  SHOULD-FIXes (C-S1, C-S4, C-S5, C-S7, F-SF-1, F-SF-2, F-SF-4, F-SF-5,
  F-SF-6, F-SF-7, A-SF-3, E-SF-7, E-SF-8).
- Delivered the three cross-cutting refactors (`useModalA11y`,
  `ErrorCard`, `useEndpointOrMock.refetch`) as real consolidations,
  not paste-jobs.
- Rejected A-SF-1 with senior-engineer rationale (toggle vs one-shot
  navigation gesture; APG button-with-element pattern compliance).
- Filed six FU-NF tickets for legitimate Pass-3+ work.
- Preserved every PRAISE item across both Pass 1 and Pass 2 lists.

The parent's pre-review gates were green: `npm run build` clean,
`npm run lint` clean (0/0), 28 test files / 142 tests passing. The two
small regressions the parent caught (TS + ref-mutation-during-render)
were fixed before this re-review and the resulting code-level shape is
sound.

The two new NITs (REGION-NEW-1, REGION-NEW-2) are not ship-blockers
and can be picked up opportunistically.

**No another fix-pass needed.** Ship Pass 2.
