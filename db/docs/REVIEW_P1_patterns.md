# REVIEW — Overhaul P1.1, NAV-PATTERNS + HOOKS + CONTEXT slice

Reviewer: independent senior (React/a11y). Commit `891a001`, branch `feat/overhaul-p1-skeleton`.
Scope: `LearnMenu.tsx`, `ChatFab.tsx`, `exam-active-context.ts` + `ExamActiveProvider.tsx` + `useExamActive.ts`, `useKeyboardOpen.ts`, `Shell.tsx` mounts, `MockMode.tsx` exam-active wiring, `Icon.tsx` additions.
Spec: `db/docs/OVERHAUL_P1_BUILD.md`; mockup ref approved.

## Verdict: **PASS** — 0 blockers, 1 should-fix, 4 nits

Machine checks (node:20-slim, docker): `tsc --noEmit` = 0, `eslint` = 0, slice vitest = 25/25
(ChatFab 13, LearnMenu 5, useKeyboardOpen 5, ExamActiveProvider 2).

## Probe answers (the four asked questions)

**(a) ChatFab wrong-route show/hide?** No. `isHiddenPath` (ChatFab.tsx:29-33) matches
`pathname === p || pathname.startsWith(p + '/')` — a true segment-boundary match. `/chatter`
and `/settings-ish` stay visible (test ChatFab.test.tsx:92 covers `/chatter`); `/chat/123`,
`/settings/security` inherit the hide (tests :67). All four conditions compose as a single OR
(ChatFab.tsx:41) returning `null` — hidden state renders nothing. Only theoretical miss:
React Router matches paths case-insensitively, so a hand-typed `/Chat` would render the chat
screen with the FAB visible (NIT-3; unreachable via in-app navigation).

**(b) Can examActive stick true (FAB hidden forever)?** No. MockMode.tsx:198-204 is a pure
mirror effect: `setExamActive(phase === 'exam')` with unconditional cleanup-to-false. Exit
paths all covered: submit→`setPhase('results')` (MockMode.tsx:366, 394) flips effect false;
new-mock→`'select'` (:426); navigate-away/unmount → cleanup fires false. Start-error paths
never reach `phase='exam'` (fetch failures keep `'select'`, :279-288, :313-343). Submit-error
keeps `phase='exam'` → flag stays true — CORRECT, the exam genuinely is still running
(timer live, retry offered). Timer code untouched: the MockMode diff is import + effect only;
deadline/wall-clock logic not modified. Default context setter is a stable module-level no-op
(exam-active-context.ts:25-30) — pages outside the provider read `false`, never throw
(ExamActiveProvider.test.tsx:49 covers it). StrictMode double-invoke is idempotent.

**(c) useKeyboardOpen SSR-safe + leak-free?** Yes. No `window` access at module load —
`window.visualViewport` is only read inside `subscribe`/`getSnapshot`, both client-only;
`getServerSnapshot` returns `false`. Missing API degrades to constant `false` (FAB stays
visible — right default). Both `resize` + `scroll` listeners removed in the unsubscribe
(useKeyboardOpen.ts:38-41); `subscribe`/`getSnapshot` are module-level so
`useSyncExternalStore` never resubscribes per render; boolean snapshot → `Object.is` stable,
no flap/infinite loop. Unmount-inertness tested (useKeyboardOpen.test.tsx:95-108). One
heuristic gap: pinch-zoom (SF-1 below).

**(d) LearnMenu a11y/close-behavior fully correct?** Yes. `useModalA11y` supplies focus trap
(container-scoped Tab wrap), Esc, body scroll-lock w/ exact overflow restore, and
focus-restore to the captured opener (the hexagon) via `queueMicrotask` on unmount. Closes on:
scrim tap (LearnMenu.tsx:78), Esc, row activation (navigate + `onClose`, :56-64), hexagon
re-tap (scrim `bottom` stops at nav height — index.css:625-631 — so the bar stays tappable;
Shell's toggle flips it), and route change via the derive-during-render pattern in
Shell.tsx:45-49 (`setState` during own render — the sanctioned React pattern, no effect, no
one-frame flash; also catches browser back/forward). Reduced motion: global block
(index.css:165-174) zeroes `animation-duration` AND `animation-delay` with `!important`, so
both the 240ms rise and the inline per-row stagger delays collapse — instant complete list.
Keyboard: 7 rows are `<button>`s inside the trap, Tab/Shift-Tab cycles with wraparound; scrim
is `tabIndex={-1}` (out of tab order, correct). Arrow-key navigation is not implemented, but
the surface is `role="dialog"` (not `role="menu"`), so Tab-only is spec-conformant. Minor
polish item NIT-1.

## Findings

### BLOCKER — none

### SHOULD-FIX

**SF-1 · useKeyboardOpen.ts:44-48 — pinch-zoom false positive (missing `vv.scale`).**
`visualViewport.height` is in visual-viewport CSS px, so it also shrinks when the user
pinch-zooms IN: at zoom ≳1.33× the ratio drops below 0.75 and the hook reports "keyboard
open" with no keyboard — the ChatFab silently disappears while zoomed (plausible on a
language app: zooming into hanja/passages). Benign direction (hide, not overlap) and it
recovers on zoom-out, but it's a behavior deviation from the spec's "keyboard open" contract.
One-line fix normalizes to layout px:
```ts
return vv.height * vv.scale < window.innerHeight * KEYBOARD_HEIGHT_RATIO;
```
Add a test with a fake viewport carrying `scale` (height 500, scale 1.6 → closed).

### NIT

**NIT-1 · LearnMenu.tsx:49-54 + index.css:669 — initial focus lands on a still-invisible
row.** First row (TOPIK) gets focus at mount, but its stagger delay is the LONGEST
((7-1)×30 = 180ms) plus 240ms rise with `both` fill (opacity 0 until delay expires) — so for
~0.4s keyboard focus sits on an invisible element. Cosmetic (reduced-motion users see it
instantly; pointer users unaffected). Options: focus the bottom row (delay 0), or stagger
top-down.

**NIT-2 · useKeyboardOpen.test.tsx — the `scroll` listener path is untested.** The hook
binds `scroll` specifically for iOS keyboard transitions (comment :19-21) but tests only
dispatch `resize`. A mutant deleting the `scroll` binding survives. Add one dispatch of
`new Event('scroll')` after a silent height mutation.

**NIT-3 · ChatFab.tsx:29-33 — case-sensitivity mismatch with the router.** React Router
matches `/Chat` to the chat route case-insensitively, but `isHiddenPath` compares
case-sensitively → FAB shows on a hand-typed `/Chat`. Unreachable via any in-app navigation;
single-user app. Record-only.

**NIT-4 · ChatFab.test.tsx hidden-state assertions are absence-only** (`queryByRole …
not.toBeInTheDocument()`) — individually vacuous if the accessible name ever changed. Not a
real gap here because the visible-state tests pin the same `FAB_NAME` constant, so a rename
breaks those first. No action needed; noting the reasoning for future editors.

### PRAISE

- **exam-active-context.ts:10-14** — the deliberate no-op-default (vs the codebase's
  null+throw convention) is the right call for advisory UI state, and the rationale is
  written down where the next person will look.
- **ChatFab.tsx:15-17 + test :92** — the segment-boundary claim isn't just asserted in a
  comment, it's pinned by a test (`/chatter`).
- **MockMode.tsx:191-197** — mirror-the-phase-machine with cleanup is the minimal correct
  lifting; explicitly independent of the freshly-landed wall-clock timer, and the diff proves
  it (import + effect only).
- **Shell.tsx:41-49** — route-change close via derive-during-render instead of an effect:
  no stranded-menu frame over the new page, and the comment explains why.
- **useKeyboardOpen.ts** — module-level `subscribe`/`getSnapshot` (no churn), `scroll` +
  `resize` for iOS, degrade-to-visible on missing API: textbook `useSyncExternalStore`.
- **index.css:625-631** — scrim stopping above the nav to keep the hexagon a functional
  toggle matches the approved mockup interaction exactly.
- **BottomNav.tsx:94** — `aria-controls` wired only while the target id exists.

## Test adequacy (slice)

ChatFab 13: visible ×5 (incl. `/learn/vocab`, `/review/mistakes`), hidden ×4 (both prefixes
+ sub-paths), exam-active, keyboard-open, `/chatter` non-false-positive, tap→`/chat`→
self-removal. All four hide conditions individually asserted; mutation-sensible (dropping any
one condition or widening the prefix match fails a named test). MockMode wiring tests are
non-vacuous: enter-exam→true, submit→results→false, unmount-mid-exam→false
(MockMode.test.tsx:1001+). Provider round-trip + outside-provider degradation covered.
Icons compile-time-safe: `NavItem.icon: IconName`, new `learn`/`search-fab` entries render
inside the shared 24×24 viewBox wrapper (Icon.tsx:220-242).
