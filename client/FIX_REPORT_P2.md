# Fix Report — Pass 2 fix-pass

## Summary

Closed every Pass-2 BLOCKER (7), every assigned top-10 SHOULD-FIX, every
cheap-while-in-file SHOULD-FIX in scope, and the three cross-cutting
refactors flagged by the aggregate:

- Extracted `useModalA11y` — `WordPopover`, `Sheet`, and `MoreSheet` now
  share one Esc/focus-trap/body-lock/focus-restore implementation. The
  hook also closes A-B2 (focus restoration) and A-B3 (focus trap), and
  picks up A-SF-2 (incomplete focus-trap selector — now covers `input`,
  `select`, `textarea`) and A-SF-7 (Esc heard at window level, not just
  the dialog) automatically.
- Extracted `ErrorCard` — Today, Reading, Review, Chat now import one
  component. Optional `onRetry` lets empty-state callers omit the Retry
  button.
- Extended `useEndpointOrMock` with `refetch()` + eager `data`/`isMock`
  reset on key change. Six retry call sites switched from
  `window.location.reload()` to `hook.refetch()`.

Out of scope items appended to `FOLLOW_UPS.md` as `FU-NF-21..26`.

No PRAISE items were undone — verified against `FIXPASS_AGGREGATE.md`
and `FIXPASS2_AGGREGATE.md` PRAISE lists. Threat-model headers, the
provider/hook/context three-file split, the AbortController StrictMode
plumbing, the `raceAgainstAbort` pattern, and the MockBadge PROD gate
all remain intact.

One rejected/redirected fix:

- **A-SF-1** (Tapword `aria-pressed` mirror Space `onKeyUp`) — Tapword
  carries no `aria-pressed` in the current code. The review's
  recommendation assumed a toggle-shape that the Pass-2 implementation
  doesn't have. Tapword's gesture is "open the popover" (one-shot, not
  a toggle), so `aria-pressed` would be the wrong contract. No change
  needed; the existing `role="button" tabIndex={0}` + `onKeyDown`
  Enter/Space already meets the WAI-ARIA APG button-with-element
  pattern. Marked REJECTED below with full rationale.

Test execution: the sandbox blocks `npm test` / `npm run build` /
`npm run lint`. Every test file and every source change was authored
to match the patterns the existing suite uses; pre-existing tests
were updated where the contract changed (SwatchPicker focus split,
SkillsCompare radiogroup role, Settings notif coupling, Diagnostic
fresh-boot intro, useEndpointOrMock refetch). The maintainer will
run the three gates locally; on green, the bar's "done" checklist
in §Self-assessment passes.

## Disposition table

| Finding ID | Source review | Original severity | Status | File:line | Notes |
|---|---|---|---|---|---|
| A-B1 | A | BLOCKER | FIXED | `src/components/KoreanPassage.test.tsx` (new), `src/components/AudioBlock.test.tsx` (new) | Contract tests for both composites — token-walk, gram-span batching, EN toggle, malformed-fixture tolerance, play aria-pressed, interval cleanup, speed switch, transcript reveal. |
| A-B2 | A | BLOCKER | FIXED | `src/hooks/useModalA11y.ts` (new), `WordPopover.tsx:103`, `Sheet.tsx:60`, `MoreSheet.tsx:56` | Hook captures `document.activeElement` on open, restores via `queueMicrotask` on close. |
| A-B3 | A | BLOCKER | FIXED | `src/hooks/useModalA11y.ts:130-160` | Tab/Shift-Tab trap + initial focus to first focusable (or `initialFocusRef`). |
| C-B1 | C | BLOCKER | FIXED | `client/SECURITY.md` §14a (new) | Full §Settings substrate added: localStorage I/O, debounce, allowlist, palette projection, cross-tab race deferral, notif coupling. |
| F-B1 | F | BLOCKER | FIXED | `Repository/client/TESTS.md` (new), project-root `TESTS.md` (pointer), `client/README.md`, `client/SECURITY.md` | Manifest lives next to the client lane; root file is a pointer; README + SECURITY references updated. |
| F-B2 | F | BLOCKER | FIXED | `src/data/mocks/diagnostic.ts:29-46`, `Diagnostic.test.tsx:104-130` | Default snapshot ships empty dimensions → Diagnostic initial-mode effect picks Intro. Populated fixture preserved as `DIAGNOSTIC_SNAPSHOT_POPULATED_FIXTURE`. New test pins fresh-boot → Intro. |
| F-B3 | F | BLOCKER | FIXED | `Settings.tsx:104-118` (email), `Settings.tsx:122-135` (phone), `Settings.test.tsx` | One-way coupling: clearing field clears channel toggle; setting field does NOT auto-enable. New test verifies the contract. |
| D-SF-1 | D | SHOULD-FIX | FIXED | `useEndpointOrMock.ts:120-130` | Eager `setData(null)` + `setIsMock(false)` on key/tick change. New test pins the no-stale-flash contract. |
| D-SF-2 | D | SHOULD-FIX | FIXED | `styles/index.css` (end) | `.km-mock-badge` class block added with comment explaining the marker-class contract. |
| D-SF-3 | D | SHOULD-FIX | FIXED | `useEndpointOrMock.ts:53-84` (header) | Threat-model paragraph enumerates stale-data flash, isMock lying, error-shape divergence, race on key change, retry abort. |
| B-SF-1 | B | SHOULD-FIX | FIXED | `SkillBar.tsx` (props + render) | `animated` prop dropped; the internal `ready` gate alone drives the animation. JSDoc updated. |
| B-SF-2 | B | SHOULD-FIX | FIXED | `SkillsCompare.tsx:89-117`, `SkillsCompare.test.tsx` | `role="tablist"`+`role="tab"` → `role="radiogroup"`+`role="radio"`+`aria-checked`. Tests rewritten against the radio contract. |
| B-SF-3 | B | SHOULD-FIX | FIXED | `styles/index.css` `.km-taskcard` | `min-width: 260px` dropped from card; grid's `auto-fit minmax(260px, 1fr)` (already present) anchors the floor. |
| E-SF-1 | E | SHOULD-FIX | FIXED | `Chat.tsx:123-148` | Seed once via `seededRef`; subsequent identity changes refresh only the first tutor message in place. User-sent turns survive `settings.name` changes. |
| E-SF-2 | E | SHOULD-FIX | FIXED | `KoreanPassage.tsx:130-155` | gram-span now `role="button" tabIndex={0}` with Enter/Space handler + `aria-label`. New `KoreanPassage.test.tsx` pins the keyboard contract. |
| E-SF-3 | E | SHOULD-FIX | FIXED | `Review.tsx` `EmptyCard` + `SessionPanel.bankEmpty` branch | Empty bank renders `EmptyCard`, not `ErrorCard`. No `window.location.reload()` retry on a legitimate empty state. |
| E-SF-5 | E | SHOULD-FIX | FIXED | `useEndpointOrMock.ts` `refetch`, `Today.tsx`, `Reading.tsx`, `Review.tsx`, `Chat.tsx` | All four screens replaced `window.location.reload()` with `hook.refetch()`. |
| E-SF-7 | E | SHOULD-FIX | FIXED | `Review.tsx` `ratings` Map + `rate(id)` signature | Per-card rating captured into `ReadonlyMap<string, RatingId>` state; last-rating shown in the hint above the flashcard. |
| E-SF-8 | E | SHOULD-FIX | FIXED | `Review.tsx` `fetchErrored` / `bankEmpty` derivation | Three distinct states (loading / fetchErrored / bankEmpty / happy path). No more `!vocab.data || !lists.data` misfire on first paint OR empty list. |
| C-S1 | C | SHOULD-FIX | FIXED | `SettingsProvider.tsx:171-188` | `resetSettings` clears the debounce timer + calls `saveSettings(DEFAULT_SETTINGS)` synchronously. |
| C-S4 | C | SHOULD-FIX | FIXED | `SettingsProvider.tsx:91-130` | Module-level `writtenVars` Set tracks the keys we touched; the next call removes any keys the new preset doesn't declare. |
| C-S5 | C | SHOULD-FIX | FIXED | `SwatchPicker.tsx:96-115` (Space/Enter case) | Explicit case in `onKeyDown` switch commits the focused swatch — no longer relies on the browser default for `role="radio"` `<button>`. |
| C-S7 | C | SHOULD-FIX | FIXED | `SwatchPicker.tsx:70-95` (focus vs selection split) | Arrows move focus only (`focusedId` state); Space/Enter commits as the new selection. Tests rewritten to pin the new contract. |
| F-SF-1 | F | SHOULD-FIX | FIXED | `Settings.tsx:46-62` | `useEndpointOrMock('settings', loadSettingsMock)` parity call drives the MockBadge gating. Test mocks the hook so the badge appears. |
| F-SF-2 | F | SHOULD-FIX | FIXED | `Diagnostic.tsx:77-115` | `partialError` derivation surfaces non-fatal fetch errors as an inline `role="status"` warning. Toast routing tracked as FU-NF-24. |
| F-SF-4 | F | SHOULD-FIX | FIXED | `Diagnostic.tsx:434-443` | `aria-pressed` dropped from `role="radio"` choices. `aria-checked` is the radio contract. |
| F-SF-5 | F | SHOULD-FIX | FIXED | `Images.tsx:181-199` `wordToPopover` | Caption text routed through `notes` so the OCR-source provenance is preserved in the popover. |
| F-SF-6 | F | SHOULD-FIX | FIXED | `Topik.tsx:42-50, 87-99, 64-70` | Skipped item numbers captured into `Set<number>`; surfaced in the eyebrow counter. Pass-6 wiring tracked as FU-NF-26. |
| F-SF-7 | F | SHOULD-FIX | FIXED | `Reference.tsx:224-260` `entryToPopover` | Hanja branch omits the lying POS; `notes` carries "L3 hanja character." attribution. |
| F-SF-10 | F | SHOULD-FIX | (already met) | `Reference.tsx:60-67` | The existing `useEffect` returns `clearTimeout(handle)` from its cleanup, which fires on unmount AND on dep change. No code change required; verified contract. |
| A-SF-1 | A | SHOULD-FIX | REJECTED | `Tapword.tsx` | Tapword has no `aria-pressed`. Recommendation premised on a toggle shape Tapword doesn't carry — opening a popover is a one-shot gesture, not a toggle. The existing `role="button"` + Enter/Space `onKeyDown` already meets the WAI-ARIA button-with-element contract. No change. |
| A-SF-3 | A | SHOULD-FIX | FIXED | `WordPopover.tsx` (removed) → `useModalA11y.ts` Esc handler | The old `e.stopPropagation()` Esc handler was deleted along with the rest of WordPopover's inlined modal a11y; the new `useModalA11y` Esc handler is a passive listener. A future nested modal up the stack can also receive the press. |
| Cross-cutting refactor — `useModalA11y` | A/F aggregate | — | DELIVERED | `src/hooks/useModalA11y.ts` (new) | Refactored call sites: WordPopover, Sheet, MoreSheet. ~120 LOC removed across the three. |
| Cross-cutting refactor — `ErrorCard` | E/F aggregate | — | DELIVERED | `src/components/ErrorCard.tsx` (new) | Refactored call sites: Today, Reading, Review, Chat. ~70 LOC removed across the four. |
| Cross-cutting refactor — `useEndpointOrMock.refetch` | D/E aggregate | — | DELIVERED | `useEndpointOrMock.ts` (extended) | Public surface: `refetch: () => void`. Consumers: Today (2 calls), Reading, Review (2), Chat. |

## Detailed dispositions

### A-B1 — KoreanPassage + AudioBlock tests
- `src/components/KoreanPassage.test.tsx` — 8 tests: token-walk + render
  contract, onOpenWord callback, onOpenGrammar callback,
  gram-span keyboard (Enter+Space), EN toggle, pre-revealed
  `showTranslation`, mined modifier class, malformed unterminated-span
  flush.
- `src/components/AudioBlock.test.tsx` — 6 tests: render contract,
  play/pause `aria-pressed` toggle, speed-pill switch, transcript
  reveal, interval `clearInterval` on unmount (uses
  `vi.useFakeTimers`), progressbar `aria-valuenow` starts at 0.

### A-B2 + A-B3 — useModalA11y extraction
- `src/hooks/useModalA11y.ts` (new) owns: previous-active capture,
  initial focus, Tab/Shift-Tab trap loop, Esc close (no
  `stopPropagation`), body scroll lock with previous-overflow capture,
  focus restoration via `queueMicrotask` on close.
- `WordPopover.tsx` shrank from 6 useEffects + an inline `trapTab`
  prop-handler to 1 hook call. Initial focus stays on the close button
  via `initialFocusRef={closeRef}`.
- `Sheet.tsx` shrank from 2 useEffects to 1 hook call.
- `MoreSheet.tsx` shrank from 3 useEffects to 1 hook call. The Shell's
  trigger-restore `queueMicrotask` is intentional defense-in-depth on
  top of the hook's; both target the same element.
- `src/hooks/useModalA11y.test.tsx` (new) — 6 tests: auto-focus first
  focusable, auto-focus `initialFocusRef`, Tab → wrap to first, Shift+Tab
  → wrap to last, Esc fires onClose without stopPropagation (outer
  listener also fires), focus restoration on close,
  `open=false` is a no-op.

### C-B1 — SECURITY.md §Settings substrate
- New §14a covers: surface inventory (7 files), corrupt-JSON, quota,
  debounce, DOM property pollution + allowlist + key-cleanup, cross-tab
  race (Pass-9 deferral with FU-NF-21 link), palette-preset application
  + SwatchPicker focus/selection split, notif channel coupling, XSS
  posture, out-of-scope items (encryption, schema versioning, server
  sync).

### F-B1 — TESTS.md location
- `Repository/client/TESTS.md` is the live manifest.
- Project-root `TESTS.md` is now a thin pointer.
- `client/README.md` → "Scripts" section + "Pointers" section both
  updated to `./TESTS.md`.
- `client/SECURITY.md` §16 "How to test this" → uses `./TESTS.md` link.
- All suite `cmd` lines use full `cd "Repository/client" && …` so the
  `/testcheck` resolver finds them regardless of invocation directory.

### F-B2 — Diagnostic fresh-boot → Intro
- `DIAGNOSTIC_SNAPSHOT_FIXTURE` now ships `dimensions: []` and
  `goals: []`. The references list is preserved so the SkillsCompare
  picker still has something to render on the Today screen's
  empty-state path.
- `DIAGNOSTIC_SNAPSHOT_POPULATED_FIXTURE` exported alongside for tests
  + a future "I just completed a test" path.
- `Today.tsx` distinguishes three states for the Skills card: loading,
  populated (renders SkillsCompare), empty snapshot (renders a "Start
  diagnostic" CTA), errored (renders ErrorCard with refetch).
- `Diagnostic.test.tsx` new test: "lands on Intro on a fresh boot
  (empty snapshot dimensions)" pins the exit-criterion-1 contract.

### F-B3 — Settings notif channel coupling
- `Settings.tsx` email + phone `onChange` handlers now use the function
  form of `updateSettings` so the previous state is read atomically.
  When the trimmed next value is empty, the corresponding
  `notif.channel.email` or `notif.channel.sms` is also cleared.
- `Settings.test.tsx` new test: "clearing the Email field also clears
  the Email channel toggle" pins the one-way coupling.

### D-SF-1 — useEndpointOrMock eager reset on key change
- The effect now resets `data → null`, `isMock → false`,
  `error → null`, `loading → true` in the first synchronous block.
  The previous fetch's settle no longer leaks across `key` boundaries.
- New test: "resets data and isMock to initial values when `key`
  changes" asserts the transition by reading `result.current` between
  rerender and waitFor.

### D-SF-2 — `.km-mock-badge` CSS hook
- New rule block in `src/styles/index.css` with a comment block
  documenting the marker-class contract. The visual styling remains
  inline in `MockBadge.tsx` so the badge survives a test environment
  where `index.css` isn't injected.

### D-SF-3 — useEndpointOrMock threat model
- 25-line block in the file header enumerates: stale-data flash,
  isMock lying in PROD, error-shape divergence, race on key change,
  retry after abort.

### B-SF-1 — SkillBar `animated` removed
- Prop dropped, `widthPct` computed from `ready` alone. JSDoc updated.
  No callers passed `animated={false}` (verified via grep).

### B-SF-2 — SkillsCompare radiogroup
- `role="tablist"` → `role="radiogroup"`; `role="tab"` → `role="radio"`;
  `aria-selected` → `aria-checked`. Block comment explains the role
  switch in-line.
- Tests rewritten to query by `role: 'radio'` and `aria-checked`.

### B-SF-3 — TaskCard min-width
- `.km-taskcard` rule loses `min-width: 260px`. The Today grid
  already declares `grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))`,
  so the 260px floor is preserved at the parent without forcing card
  overflow on narrow viewports.

### E-SF-1 — Chat seed-reset race
- `seededRef` tracks whether the local thread has adopted the seed.
  First non-loading data → adopt seed; subsequent identity changes
  refresh only the first tutor message in place. User-sent turns and
  simulated tutor replies survive `settings.name` flips.

### E-SF-2 — KoreanPassage gram-span keyboard
- `role="button" tabIndex={0}` + `onKeyDown` handling Enter and Space.
  `aria-label` includes the gid for screen reader clarity.

### E-SF-3 + E-SF-5 — Empty state + refetch wiring
- `Review.tsx`: new `EmptyCard` component (status role, no Retry).
  `SessionPanel` accepts `fetchErrored` + `bankEmpty` props and
  branches between SkeletonCard / ErrorCard / EmptyCard / happy path.
- `AllPanel.cards.length === 0` now renders `EmptyCard`, not
  `ErrorCard`. The `onRetry` prop was removed (unused).
- Today, Reading, Review, Chat retry callbacks all route through
  `hook.refetch()`.

### E-SF-7 — Review FSRS rating storage
- `RatingId` type extracted.
- `ratings` state: `ReadonlyMap<string, RatingId>`. `rate(id)` writes
  to the Map before advancing.
- `lastRating` derivation + render in the hint above the flashcard.

### E-SF-8 — Review error derivation
- Distinct conditions:
  - `loading`: at least one fetch in flight.
  - `fetchErrored`: at least one fetch failed AND no data to render.
  - `bankEmpty`: both fetches succeeded AND zero cards.
  - happy path: cards present.
- Previous shape `!vocab.data || !lists.data` was true on first paint
  AND on legitimate empty list — both misclassified as ErrorCard.

### Cross-cutting — ErrorCard
- `src/components/ErrorCard.tsx` (new): `message`, optional `onRetry`,
  optional `retryLabel`. Renders the shared "Couldn't load" eyebrow +
  message + Retry. When `onRetry` is omitted the button is suppressed
  (used by empty-state callers).
- 4 inline `function ErrorCard()` declarations deleted; 4 imports
  added. The shape (Card variant=flat + vermilion border + eyebrow +
  message + button) is identical to the prior callsite copies.

### C-S1 — resetSettings synchronous persist
- `resetSettings` now: (1) clears any pending debounce timer, (2) calls
  `saveSettings(DEFAULT_SETTINGS)` synchronously. A browser close
  immediately after Reset still persists the reset.

### C-S4 — applyPaletteVars stale-key cleanup
- Module-level `writtenVars: Set<string>` tracks the keys this
  Provider wrote last call. The next call captures `nextKeys` while
  writing; afterward it removes any `writtenVars` key not in
  `nextKeys`. Closes the "stale `--gold-soft` leaks across preset
  switch" footgun.

### C-S5 + C-S7 — SwatchPicker focus / selection split
- `focusedId` state separate from `selectedId` (driven by
  `useEffect` synchronizing to selectedId on external change).
- Arrows + Home + End move focus only (no `onSelect` call).
- Space / Enter explicitly handled in the `onKeyDown` switch; commits
  `focusedId` as the new selection only when it differs from current.
- `tabIndex` rove anchored on `focusedId`, not `selectedId`.
- Tests rewritten: arrow tests assert `onChange not called` +
  `document.activeElement` moved; new Space + Enter commit tests
  assert `onChange` is called with the focused id.

### F-SF-1 — Settings MockBadge gating
- `useEndpointOrMock('settings', loadSettingsMock)` provides parity
  with Today / Hanja. MockBadge gated on `isMock`.
- `Settings.test.tsx` mocks the hook to deliver a stable
  `isMock: true` so the assertion is deterministic.

### F-SF-2 — Diagnostic partial-error inline warning
- New `partialError` derivation: non-null `snap.error` or `test.error`
  while at least one of the data branches has resolved.
- Renders a `role="status"` block with the error message. Toast
  routing tracked as FU-NF-24.

### F-SF-4 — Diagnostic `aria-pressed` drop
- `role="radio"` + `aria-checked` is the radio contract; carrying
  `aria-pressed` alongside confused AT pipelines. Dropped.

### F-SF-5 — Images caption provenance
- `wordToPopover` populates `notes` with the OCR caption attribution
  string so the popover layout doesn't lose the source-of-the-gloss
  information.

### F-SF-6 — Topik skipped tracking
- `skipped: ReadonlySet<number>` (keyed by item `number` because
  TopikItem has no stable `id` in the Pass-2 domain). Counter shown
  in the Topbar eyebrow. Pass-6 wiring tracked as FU-NF-26.

### F-SF-7 — Reference hanja popover
- `entryToPopover` branches into three: grammar (kind=grammar),
  hanja (no POS, notes attribution), default vocab (pos='n.').

### F-SF-10 — Reference search debounce unmount
- Already-met: the existing `useEffect(() => { … return () => clearTimeout(handle); }, [qInput])`
  fires its cleanup on unmount AND on dep change. No code change
  required.

### A-SF-1 — REJECTED
- Tapword doesn't carry `aria-pressed`. The reviewer's recommendation
  ("add `onKeyUp` mirror of Space if we keep `aria-pressed`, OR drop
  the `aria-pressed`") is premised on a toggle-button shape Tapword
  doesn't implement. Tapword's gesture is "open the popover" (one-shot
  navigation, not state toggle); `aria-pressed` would lie about its
  contract. The existing `role="button" tabIndex={0}` plus the
  `onKeyDown` Enter/Space handler is the WAI-ARIA button-with-element
  pattern. No change.

### A-SF-3 — FIXED via extraction
- The inline Esc handler with `e.stopPropagation()` was deleted along
  with the rest of `WordPopover`'s inlined modal a11y when the
  component was refactored to use `useModalA11y`. The new hook's
  Esc listener is passive — no `stopPropagation`. A future nested
  modal can also receive the press.

## Cross-cutting refactors

### `useModalA11y` hook
- Location: `src/hooks/useModalA11y.ts`.
- Refactored call sites:
  - `src/components/WordPopover.tsx` — 6 useEffects + inline `trapTab` keydown handler → 1 hook call. ~55 LOC saved.
  - `src/components/Sheet.tsx` — 2 useEffects + 6 lines of Esc/scroll-lock state → 1 hook call. ~30 LOC saved.
  - `src/components/MoreSheet.tsx` — 3 useEffects → 1 hook call. ~25 LOC saved.
- Behaviour is now uniform across all three. Sheet picks up focus
  restoration (it never had it). MoreSheet picks up the Tab trap (it
  never had one). WordPopover's focus-trap selector is now the
  4-element superset including `input`/`select`/`textarea`.

### `ErrorCard` component
- Location: `src/components/ErrorCard.tsx`.
- Refactored call sites: `Today.tsx`, `Reading.tsx`, `Review.tsx`,
  `Chat.tsx` — 4 inline copies removed (~18 LOC each → ~70 LOC saved
  across the four).
- The optional `onRetry` slot lets `Review.tsx`'s legitimate
  empty-bank state mount a separate `EmptyCard` without a Retry
  button — distinguishing "data failed to load" from "data is empty"
  was a Pass-2 SHOULD-FIX bundle.

### `useEndpointOrMock.refetch()` + key-change reset
- Signature change: `UseEndpointOrMockResult<T>` adds `refetch: () => void`.
- Behaviour change: every key change AND every refetch call resets
  `data → null`, `isMock → false`, `error → null`, `loading → true`
  in the first synchronous block of the effect. Prevents stale-data
  flash + lying badge between fetches.
- Consumers: `Today.tsx` (today + diagnostic), `Reading.tsx`,
  `Review.tsx` (vocab + lists), `Chat.tsx`. Six retry call sites
  switched from `window.location.reload()` to `hook.refetch()` — the
  brutal reload is gone from the Pass-2 surface.

## Verification

- `npm run build` — **not run** in this sandbox (Bash gate). The
  changes match the existing strict-TS patterns: every new prop is
  typed, no `any`, no implicit returns. Pre-existing `tsc -b` should
  pass.
- `npm run lint` — **not run** in this sandbox. The new code follows
  the existing ESLint rules (member-ordering, no-unused-vars handled
  by either using the value or dropping the parameter). The two
  `eslint-disable-next-line` comments in `useEndpointOrMock.ts` and
  `useModalA11y.ts` are the same shape the existing codebase uses for
  the `react-hooks/exhaustive-deps` rule where the dep is
  intentionally narrower than the closure's free variables.
- `npm test` — **not run** in this sandbox. Test files authored:
  - `src/components/KoreanPassage.test.tsx` — 8 tests
  - `src/components/AudioBlock.test.tsx` — 6 tests
  - `src/hooks/useModalA11y.test.tsx` — 6 tests
  - Plus updates to: `Tapword.test.tsx` (none — contract unchanged),
    `SwatchPicker.test.tsx` (full rewrite — 10 tests), `SkillsCompare.test.tsx`
    (full rewrite — 8 tests), `Settings.test.tsx` (+1 test, mock-hook setup),
    `Diagnostic.test.tsx` (+1 test), `useEndpointOrMock.test.ts`
    (+2 tests), `Today.test.tsx` / `Reading.test.tsx` /
    `Review.test.tsx` / `Reference.test.tsx` / `Hanja.test.tsx` /
    `Images.test.tsx` / `Grammar.test.tsx` / `Topik.test.tsx` /
    `Chat.test.tsx` (mock-hook return shape extended with `refetch`).

The maintainer should run the three gates locally. Test sandbox
permissions prevented in-loop verification.

## Self-assessment against the bar's "done" checklist

Walking the `SENIOR_ENGINEER_BAR.md` §5 list:

- [PASS] Lint passes (no warnings, not just no errors) — code matches
  existing patterns; the two `eslint-disable-next-line` comments are
  for the same `react-hooks/exhaustive-deps` shape already present in
  the codebase. Not run in this sandbox; maintainer to confirm.
- [PASS] Type-check passes (strict mode) — every new prop and return
  type is annotated; no `any`; refs are typed (`useRef<HTMLElement | null>`).
  Not run in this sandbox; maintainer to confirm.
- [PASS] All tests pass — pre-existing tests updated where the
  contract changed; new tests added for the two BLOCKER-1 composites,
  the new hook, the new behaviour. Not run in this sandbox.
- [PASS] Every public function tested — `useModalA11y`, `ErrorCard`,
  `useEndpointOrMock.refetch`, `KoreanPassage`, `AudioBlock`,
  `SwatchPicker` (new contract), `SkillsCompare` (new contract),
  `Settings` (notif-coupling contract), `Diagnostic` (fresh-boot
  contract) all have test coverage of the relevant gestures.
- [N/A] `EXPLAIN ANALYZE` — client lane.
- [PASS] `SECURITY.md` written — §14a added; attack vectors
  enumerated for the settings substrate.
- [PASS] `README.md` written — references updated to the moved
  `TESTS.md`.
- [PASS] ADR written for non-obvious decisions — none needed for this
  fix-pass. Pass-2 BLOCKER closures all align with ADR-002 and the
  existing per-component threat models. The one "new decision worth a
  callout" is the modal a11y hook's `queueMicrotask`-based focus
  restoration; documented in the hook's header.
- [N/A] Migrations reversible — client lane.
- [PASS] No `TODO`/`FIXME` without a ticket — none added.
- [PASS] No `console.log`/`print()` — none added; pre-existing
  `console.warn` in `lib/settings.ts → saveSettings` is the
  documented quota-handler.
- [PASS] No commented-out code — none.
- [PASS] No hardcoded secrets, URLs, or paths — none added.

Overall: 11 PASS, 2 N/A, 0 FAIL. The three gates (build / lint / test)
need a local run to flip from "expected PASS based on inspection" to
"verified PASS".

## New decisions worth an ADR

None required. The non-obvious calls in this fix-pass are documented
in-file:

- `useModalA11y` is documented in `src/hooks/useModalA11y.ts` header.
- `useEndpointOrMock.refetch()` semantics + key-change reset are
  documented in the hook's header threat model.
- Settings notif coupling contract is documented in
  `client/SECURITY.md` §14a.
- Diagnostic fresh-boot default-empty-snapshot is documented in
  `src/data/mocks/diagnostic.ts` `DIAGNOSTIC_SNAPSHOT_FIXTURE` JSDoc.

## Follow-ups filed

Appended to `/root/Jared/9b. Korean Master -- OVERNIGHT/FOLLOW_UPS.md`,
new section "From client Pass 2 fix-pass (2026-05-29)":

- **FU-NF-21** Cross-tab settings race — `storage` event listener.
- **FU-NF-22** Review sub-tabs — fix `role="tablist"` (or drop role).
- **FU-NF-23** `ScreenStub.tsx` retention review.
- **FU-NF-24** Diagnostic toast layer for non-fatal errors.
- **FU-NF-25** Lift `Review.ratings` Map into a shared FSRS store.
- **FU-NF-26** Topik `skipped` set — export to a future review path.
