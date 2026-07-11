# FIX REPORT — Phase 3C-1 fix-pass (flashcards / grammar / hanja)

Fix-pass agent, 2026-07-10. Branch `feat/phase3c1-cards`, client-only (server/ and db/ untouched).
Inputs: `REVIEW_flashcards.md` (FAIL — 2 blockers, 6 should-fix), `REVIEW_grammar.md` (NOT SHIPPABLE — 2 blockers, 4 should-fix), `REVIEW_hanja.md` (PASS — 3 should-fix).

## Disposition — blockers (4/4 FIXED)

| Finding | Disposition | Fix |
|---|---|---|
| **Flashcards BLOCKER-1** — drawer toggle/close not keyboard-operable (WCAG 2.1.1) | **FIXED** | Shared-root fix in `client/src/components/Flashcard.tsx`: the flip key handler now ignores key events that did not originate on the card itself (`if (e.target !== e.currentTarget) return;`), so Enter/Space on the drawer toggle/close (and any interactive descendant) activates that control via its native click path instead of flipping the card. Test: `Review.test.tsx` "the drawer toggle and close button are keyboard-operable" + `Flashcard.test.tsx` "ignores Enter/Space that bubble up from interactive descendants". |
| **Flashcards BLOCKER-2** — Space on a rating button flips the card and drops the rating | **FIXED** | Second half of the shared root: the window-level space-to-reveal handler (Review.tsx) now bails whenever focus sits on/inside any interactive element, via the new shared guard `client/src/lib/interactiveElement.ts` (`button, a[href], input, textarea, select, [role="button"], [contenteditable]`). Space on a rating button now activates the button; the rating lands. Also fixes the double-flip no-op when the card itself is focused. Test: `Review.test.tsx` "Space on a focused rating button rates the card". |
| **Grammar B-1** — due-first ordering defeated by the persisted rotation cursor | **FIXED** | The persisted cursor no longer indexes the due partition. The pool is split into `{due, rest}`: the due queue is drained FIRST via a session-local `duePos` (exactly the vocab due-session semantic), then the persisted `idx` cursor resumes over the rest — so cursor progress through the rotation is preserved AND due cards are genuinely served first. The always-N이다 remount regression test stays green. Test: "serves the DUE pattern first even when the persisted rotation cursor is non-zero (B-1)" — seeds `km.grammar.drillCursor = '7'` and fails on the pre-fix code (verified by mutation, see below). |
| **Grammar B-2** — async score reveal never announced (WCAG 4.1.3) | **FIXED** | `DrillCard` now carries ONE persistent sr-only `role="status"` region whose text swaps to "Scoring your answer…" while in flight and to `Scored N of 100 — Verdict. Rated X · next review …` when the reveal mounts (persistent + text-swap because a live region inserted already-populated is unreliably announced). The factually wrong `aria-describedby` rationale comment was corrected. Test: "announces the reveal through a live status region (B-2 — WCAG 4.1.3)". |

**Shared keyboard fix covers all 3 sites:** Flashcard.tsx guard (bubbled Enter/Space from descendants — used by both Review and Hanja study cards) + `lib/interactiveElement.ts` guard applied to BOTH window space-handlers (Review.tsx and Hanja.tsx). Keyboard tests exist on Review (rating + drawer toggle + drawer close), Hanja (rating), and Flashcard (unit).

## Disposition — should-fixes (13)

| Finding | Disposition | Fix |
|---|---|---|
| Flashcards SF-1 — concurrent removals corrupt rollback | **FIXED** | All remove buttons disable while `removingId !== null` (a second removal's failure rollback would restore a stale snapshot and resurrect the first row). Test added. |
| Flashcards SF-2 — drawer fetch failure shown as "No additional examples" | **FIXED** | Real error state: `role="alert"` "Couldn't load examples." + a Try-again button that re-runs `openDrawer` (stop-propagated against the card flip). Test covers error, absence of the false copy, and retry success. |
| Flashcards SF-3 — lists >100 entries silently truncate | **FIXED** (honest-disclosure option) | When `entry_count > entries.length`, the detail view renders "Showing the first N of M words — a study session covers these N." The misleading "fully reachable" comment was corrected. Entry paging deferred — the server page is 100, the app is single-user, and the note removes the lie. Test added. |
| Flashcards SF-4 — progressbar unnamed | **FIXED** | `aria-label="Session progress"` moved onto the `role="progressbar"` element. Test added. |
| Flashcards SF-5 — no recourse for failed rating saves | **FIXED** | Failed saves are kept as (card, rating) pairs; the completion page's failure alert now carries a "Retry saving" button that re-persists them (entry cards re-resolve a fresh version via the idempotent bank call; a genuine version conflict re-fails honestly). Test added. |
| Flashcards SF-6 / Grammar SF-2 / B-034 — cross-surface interval copy | **FIXED** | Grammar `scheduleLine` branches on `schedule.rating` for 0-day steps: again → "in under a minute" (RELEARN_DELAY_MS = 50s), hard → "in ~6 minutes" (HARD_STEP_DELAY_MS = 6min); the pinned "~10 minutes" test was replaced with engine-true pins for BOTH ratings. Hanja restores interval subs `<1m / 6m / 1d / 4d` mirroring vocab's `RATINGS` exactly (same retuned engine → same truth); the now-false "would be a lie" comment removed and replaced with an engine-pinned rationale; per-button DOM pin test added (identical shape to Review's B-021 test). Vocab untouched. |
| Grammar SF-1 — late bank/due settle regenerates mid-answer | **FIXED** | Two halves: (1) the practice gate now waits for ALL three pool inputs (`listState`, `bankedState`, `dueState`) to settle before generating; (2) the pool is snapshotted once per session (write-once ref) so a later settle/refetch can't reshape it under the generate effect. Deep-link targets still bypass the gate. Test pins the gate + that the settled due-ness is honoured. |
| Grammar SF-3 — dangling ticket ids | **FIXED** | `F-065-B` → **F-110** (grammar drill-attempts read, GET /grammar-drill/attempts) and `F-063-B` → **F-111** (per-pattern grammar card schedule read) across all code comments, the HistoryPanel copy, and the test that pins the ticket reference. |
| Grammar SF-4 — `<ul>` list semantics | **FIXED** | `role="list"` on `.km-grammar__list` with a documented local disable of `jsx-a11y/no-redundant-roles` (the `list-style:none` Safari/VoiceOver quirk is the canonical exception; the page-level convention uses role="list" on divs, this is a real `<ul>`). |
| Hanja SF-1 — Space-key conflicts | **FIXED** | Same shared fix as the blockers (window handler uses `isInteractiveElement`; Flashcard guard covers the back-face draw CTA). Keyboard test added on Hanja. |
| Hanja SF-2 — misleading partial-failure copy in "Create & add" | **FIXED** | `createAndAdd` is split into phases: only a create failure says "Couldn't create that list"; a seed/membership failure says "Created "name", but 學 couldn't be added — it's selected above, press Add to retry" (the fresh list is pre-selected, so the retry path can't mint a duplicate). Test added. |
| Hanja SF-3 — 409 "Refresh deck" resets the session position | **KEPT-AS-IS (documented decision)** | Reviewer offered "keep as-is knowingly / downgrade to NIT if the copy is judged sufficient." Judged sufficient: already-rated cards are no longer due (no double-rating), preserving mid-deck position against a known-stale snapshot isn't worth the machinery, and the copy states what will happen. The trade-off is now documented at the 409 branch in `Hanja.tsx` so it reads as a decision, not an accident. |

## Verification

- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — clean.
- `npm run lint` — clean.
- Targeted vitest (all touched suites): **159/159 pass** — Review 39, Grammar 41, Hanja 43, ReviewVocab 30, Flashcard 6. (Pre-fix: 33 / 37 / 40 / 30 / 5 = 145; +14 new tests, 0 removed; 2 stale-copy pins rewritten to engine-true expectations.)
- **Mutation checks** (each blocker fix reverted in isolation, expecting its new test to fail; all reverts restored):
  - Flashcard target guard removed → `Flashcard` descendant test + Review BLOCKER-1 test FAIL (2 fail / 43 pass).
  - Window-handler guards reverted to the old tag checks → Review BLOCKER-2 test + Hanja space test (+ BLOCKER-1's Space-on-close leg) FAIL (3 fail / 79 pass).
  - Grammar B-1 reverted to combined-pool `idx` indexing → the new nonzero-cursor test FAILS while the original cursor-0 due-first test still passes — direct proof the old test masked the bug.
  - Grammar B-2 live region removed → announcement test FAILS.

## Self-assessment against the bar

- **WCAG AA / ARIA**: both keyboard blockers and the 4.1.3 gap closed with real key-event tests (asserting `defaultPrevented === false`, i.e. the browser would deliver the control's activation); progressbar named; list semantics restored.
- **Strict TS at boundaries / no swallowed errors**: no `any` introduced; the drawer failure and the create-and-add partial failure now surface real, author-controlled errors with retries; failed rating saves gained recourse.
- **Tests exercise real behavior**: every blocker fix ships with a test verified (by mutation) to fail on the un-fixed code; the two rewritten copy pins assert engine-true strings sourced from `server/src/services/fsrs.ts` constants.
- **No scope creep**: client-only; the one new module (`lib/interactiveElement.ts`) exists because the reviewers of two pages independently asked for the fix to be hoisted rather than duplicated. Backend gaps remain honest stubs, now pointing at registered tickets F-110/F-111.
- **PRAISE preservation**: nothing praised was undone — URL-driven view state, `useListDetail`, optimistic-count snapshotting, B-022/B-023 scoped CSS, PROD honest-error posture, no-fabricated-FSRS invariants, the F-076 honest stub, additive `services/hanja.ts`, and the B-014 back-face gating are all intact (the full pre-existing suites still pass unmodified except the two stale-copy pins the reviews themselves flagged as wrong).
- **Known residual risk**: the grammar practice pool freeze means a bank/due change mid-session (e.g. another tab) isn't reflected until the panel remounts — deliberate, and strictly better than the answer-wiping alternative it replaces.
