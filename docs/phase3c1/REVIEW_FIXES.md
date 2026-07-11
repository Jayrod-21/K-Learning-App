# RE-REVIEW — Phase 3C-1 fix-pass verification (flashcards / grammar / hanja)

Independent re-reviewer (Phase 4), 2026-07-10. Fresh eyes: did not write the code, did not author the original reviews, did not run the fix-pass. Report-only; every temporary mutation used for verification was reverted (`git status` clean, suites re-run green after restoration).

Basis: `REVIEW_flashcards.md` (2 blockers), `REVIEW_grammar.md` (2 blockers), `REVIEW_hanja.md` (0 blockers), `FIX_REPORT.md` (treated as claims, not facts), fix commit `8d70170` (full diff read), targeted suites re-run (Flashcard 6 + Review 39 + Grammar 41 + Hanja 43 = 129/129), and **four independent mutation reproductions** (below).

## Verdict

**PASS WITH CONDITIONS.**

All 4 original blockers are dead — each fix verified at code level AND by independently reproducing the fix-pass's mutation checks (numbers matched the report exactly). 11 of 13 should-fixes are genuinely fixed, 1 is deferred with a documented decision the original reviewer sanctioned, and 2 are **partially** fixed with documentation-level residue (no runtime defect). No praised item was undone. No new blockers were introduced. The two conditions are five-minute doc edits (see Recommendation).

## Blocker verification (mutation-reproduced, not trusted)

Each mutation was applied in isolation, the targeted suites run, and the file restored via `git checkout` — results matched the FIX_REPORT's claims exactly:

| Mutation | Expected (per FIX_REPORT) | Observed |
|---|---|---|
| Remove the `Flashcard.tsx` target guard (`e.target !== e.currentTarget`) | Flashcard descendant test + Review BLOCKER-1 test fail (2/43) | **2 failed / 43 passed** — exact match |
| Degrade `lib/interactiveElement.ts` to the old INPUT/TEXTAREA-only check | Review BLOCKER-2 + Hanja space + BLOCKER-1 Space-on-close leg fail (3/79) | **3 failed / 79 passed** — exact match |
| Restore Grammar's old combined-pool `idx` indexing (faithful pre-fix code) | New nonzero-cursor test fails while the ORIGINAL cursor-0 due-first test still passes | **Exactly that** — direct proof the old test masked B-1 |
| Empty the B-2 `revealAnnouncement` text | Announcement test fails | **1 failed** |

### BLOCKER-1 (flashcards) — drawer toggle/close not keyboard-operable — **FIXED**
The guard in `client/src/components/Flashcard.tsx:64` (`if (e.target !== e.currentTarget) return;`) is correct: key events bubbling from any interactive descendant no longer `preventDefault()` the control's activation or flip the card. Verified the three interaction contracts by code + test:
- **Enter/Space on the drawer toggle/close** activates the control; both buttons' click handlers `stopPropagation()` (Review.tsx:1681, 1706), so the synthesized click cannot leak into the container's `onClick` and flip anyway. The new SF-2 retry button also stop-propagates (Review.tsx:1729).
- **Space on the card itself** still flips: `target === currentTarget` passes the guard, and the window handler correctly bails (the card matches `[role="button"]`), so exactly ONE flip fires — this also fixes the double-flip no-op (Hanja SF-1 consequence 2).
- **The front "Reveal" button** keeps working via its click path bubbling to the container `onClick`, as the guard comment documents.

### BLOCKER-2 (flashcards) — Space on a rating button drops the rating — **FIXED**
`client/src/lib/interactiveElement.ts` (`button, a[href], input, textarea, select, [role="button"], [contenteditable="true"]`) is applied to BOTH window space-handlers (Review.tsx:1441, Hanja.tsx StudyView). Predicate breadth checked: uses `closest()` so focus INSIDE an interactive element also bails; `[role="button"]` covers the Flashcard container (prevents double-flip); no `contenteditable` exists anywhere in `client/src` so the `="true"` form is not under-broad in practice; a focused `a[href]` on Space now gets native scroll instead of a card flip, which is correct browser behavior. The Review test asserts `defaultPrevented === false` on the keydown AND that the rating actually lands (`submitReview` called with the right payload) — a real behavioral pin, failed under mutation.

### Grammar B-1 — due-first defeated by the persisted cursor — **FIXED**
`Grammar.tsx` now partitions the pool into `{due, rest}` (`partitionPool`), drains the due queue via a session-local `duePos` FIRST, and only then serves `rest[idx % rest.length]` from the persisted cursor. `advance()` correctly increments `duePos` (not `idx`) while serving due, so the persisted cursor never skips rotation patterns it never served. Edge cases checked: all-due pools wrap (`servingDue` stays true when `rest` is empty, so practice never dead-ends); the generate effect adds `duePos` to its deps to cover the single-due-pattern wrap. **The new test seeds `km.grammar.drillCursor = '7'`** — the whole point the original review demanded — and my faithful old-code mutation confirmed the pre-fix code passes the old cursor-0 test while failing this one. The cards-view copy "Practice serves it/them first" (Grammar.tsx:933-934) is now TRUE. The always-N이다 cursor-survives-remount regression test is still present and green (P-4 preserved).

### Grammar B-2 — reveal never announced — **FIXED**
One **persistent** sr-only `role="status"` region in `DrillCard` (Grammar.tsx:1745-1751, `km-sr-only` verified present in `styles/index.css:2340`) swaps its text: "Scoring your answer…" in flight → `Scored N of 100 — Verdict. Rated X · next review …` on reveal. The visual "Scoring…" div correctly LOST its `role="status"` so there is exactly one announcement per state change (the test's `getByRole('status')` would throw on duplicates — it passes). The factually wrong `aria-describedby` rationale comment in `DrillReveal` was corrected to state why describedby alone never surfaces (disabled textarea never refocused). Failure path stays on ErrorCard's `role="alert"` — asymmetry resolved.

## Finding-by-finding table

| ID | Original severity | Status | Notes |
|---|---|---|---|
| FC BLOCKER-1 — drawer toggle/close keyboard | BLOCKER | **FIXED** | Mutation-reproduced (2 fail / 43 pass). stopPropagation on both buttons prevents click-bubble flips |
| FC BLOCKER-2 — Space eats the rating | BLOCKER | **FIXED** | Mutation-reproduced (3 fail / 79 pass, shared guard). Rating lands; `defaultPrevented === false` pinned |
| GR B-1 — due-first vs persisted cursor | BLOCKER | **FIXED** | Mutation-reproduced with the faithful old code: old test passes, new seeded-cursor test fails — masking proven. "Serves them first" copy now true |
| GR B-2 — reveal not announced | BLOCKER | **FIXED** | Persistent single live region; wrong comment corrected; one announcement |
| FC SF-1 — concurrent removal rollback corruption | SHOULD-FIX | **FIXED** | `disabled={removingId !== null}` on ALL rows; in-flight test with released promise |
| FC SF-2 — drawer failure as "No additional examples" | SHOULD-FIX | **FIXED** | `examplesFailed` state, `role="alert"` fixed copy + stop-propagated retry; test covers error, absence of false copy, retry success, no server prose |
| FC SF-3 — >100-entry silent truncation | SHOULD-FIX | **FIXED** (disclosure option) | Honest note when `entry_count > entries.length`; misleading comment corrected; test added. Paging legitimately deferred (single-user, server page = 100) |
| FC SF-4 — unnamed progressbar | SHOULD-FIX | **FIXED** | `aria-label` moved onto the `role="progressbar"` element; test added |
| FC SF-5 — no recourse for failed saves | SHOULD-FIX | **FIXED** | `failedSaves` upgraded from counter to (card, rating) pairs; completion-page "Retry saving" drains-then-re-persists (double-click safe); entry cards re-resolve fresh versions via idempotent `bankEntry`; due cards honestly re-fail on true conflicts. Test pins the re-submitted payload + alert clearing + bucket update |
| FC SF-6 / GR SF-2 / B-034 — interval copy | SHOULD-FIX | **PARTIALLY-FIXED** | The substance is done: grammar's `scheduleLine` branches on rating (again → "in under a minute" = 50s, hard → "in ~6 minutes" = 6min, defensive "later today" arm), both stale test pins replaced with engine-true pins; hanja restores `<1m/6m/1d/4d` exactly matching vocab's `RATINGS` with the false "would be a lie" comment replaced; vocab verified untouched. **Residue:** B-034's fix hint explicitly lists three `client/src/types/domain.ts` doc comments (~1014, ~1379, ~1395) still claiming "~10 minutes" — not touched by the fix commit, and the commit message says "closes B-034" while the ticket (BUGS_AND_FEATURES.md:1167) is still 🔴 open. Doc-only; no runtime effect |
| GR SF-1 — mid-answer regeneration | SHOULD-FIX | **FIXED** | Gate now waits for all three pool inputs; pool frozen once per session via write-once ref; deep-link target bypass preserved; test proves no generate before settle + settled due-ness honoured. Residual (documented): mid-session bank/due changes invisible until remount — strictly better than answer loss |
| GR SF-3 — dangling ticket ids | SHOULD-FIX | **PARTIALLY-FIXED** | `F-065-B`/`F-063-B` renamed to `F-110`/`F-111` in all code comments, HistoryPanel copy, and the pinning test — but **F-110/F-111 appear in NO backlog file** (`BUGS_AND_FEATURES.md`, `FOLLOW_UPS.md` both clean of them; verified by grep). The original complaint — ticket ids that exist only in code comments — persists under new names. FIX_REPORT's "registered tickets F-110/F-111" claim is inaccurate |
| GR SF-4 — `<ul>` list semantics | SHOULD-FIX | **FIXED** | `role="list"` with a documented, narrowly-scoped `jsx-a11y/no-redundant-roles` disable citing the Safari/VoiceOver quirk |
| HJ SF-1 — Space-key conflicts | SHOULD-FIX | **FIXED** | Same shared guard on Hanja's window handler; keyboard test added and failed under mutation 2 |
| HJ SF-2 — misleading "Create & add" partial-failure copy | SHOULD-FIX | **FIXED** | Two-phase try/catch; create-failure copy only for phase 1; phase-2 failure names the real state and points at the safe retry (fresh list pre-selected — test asserts combobox value '7'); duplicate-list mint impossible via the stated path |
| HJ SF-3 — 409 refresh resets position | SHOULD-FIX | **DEFERRED-WITH-DOC** | Reviewer explicitly offered "keep as-is knowingly"; the trade-off is now a code comment at the 409 branch. Legitimate disposition |

Nits from the original reviews were not in the fix-pass mandate; none were made worse (spot-checked N-5 flashcards — drawer content clicks still flip, unchanged scope).

## Bar checklist post-fix

| Bar | Result |
|---|---|
| WCAG AA | **PASS** — 2.1.1 keyboard operability restored on all three surfaces (mutation-verified); 4.1.3 status announcement added; progressbar named; list semantics restored |
| Correct ARIA | PASS — interactive-descendant hijack removed; one live region, one announcement; role=list load-bearing exception documented |
| Strict TS at I/O boundaries | PASS — no `any` introduced; `DrillPool`/`partitionPool` typed; failed-save pairs typed |
| No swallowed errors | PASS — drawer failure and create-and-add phase-2 failure surface fixed-copy errors with retries; failed rating saves gained recourse |
| Tests exercise real behavior | **PASS** — every blocker test independently confirmed to fail on the un-fixed code; interval pins are engine-true; new tests assert wire payloads and `defaultPrevented` |
| Co-located CSS | PASS — `km-hanja__rating-sub`, `km-review__entriesNote` in the pages' own sheets, tokenized |
| No scope creep | PASS — client-only; `lib/interactiveElement.ts` is the hoisting two reviews independently requested; `services/`, `ReviewVocab.tsx`, vocab `RATINGS` all verified untouched |
| No console.log / unticketed TODO | PASS in code — but see condition 1 (F-110/F-111 unregistered) |

## PRAISE preservation (spot-checked, all intact)

- Flashcards: URL-driven view state, `useListDetail`, optimistic count snapshot, scoped B-022/B-023 CSS, B-014 back-face gating (test present), fixed-copy discipline — the new SF-2/SF-5 paths also assert server prose absent.
- Grammar: PROD honest-error posture (`vi.stubEnv` block present, 3 refs), no-fabricated-FSRS invariants, cursor-survives-remount test green alongside the new nonzero-cursor test (the coordination constraint the original review set), retry wiring untouched.
- Hanja: `services/hanja.ts` byte-untouched by the fix commit (empty diff), F-076 honest-stub disclosures still pinned (2 test refs), await-then-advance review flow intact, two-step delete confirms untouched.

## New findings introduced by the fix-pass

1. **FIX_REPORT inaccuracy (process, not code):** claims F-110/F-111 are "registered tickets" — they exist only in Grammar.tsx comments and one test assertion. Same document describes the selector as `[contenteditable]` where the code reads `[contenteditable="true"]` (the code's stricter form is fine for this codebase — zero contenteditable usage — but the report should match the code). The commit message's "closes B-034" also overstates (see table row).
2. **NIT — render-phase ref write** (`poolRef` in `PracticePanel`): the freeze is written during render. It is pure/idempotent (safe under StrictMode double-render), but under concurrent rendering an abandoned render could theoretically freeze the pool from props that never committed — the data would be same-or-fresher than the last commit, so practical risk is negligible. Idiomatic alternative: freeze in an effect or lazy state initializer keyed on the settle.
3. **NIT — loading-gate widening:** practice now shows "Loading practice…" until list AND bank AND due settle (previously list-only when items were empty). A brief flash on cached remounts is possible. Deliberate, documented, and the right trade against answer loss — noting for completeness.
4. **Accepted residual (documented in FIX_REPORT):** frozen session pool means cross-tab bank/due changes don't reshape an open practice session. Reasonable.

No regressions found: the target guard does not block legitimate card flips (card-focused Space/Enter and click-anywhere both verified), the shared component change is minimal (9 lines + comment), and 129/129 targeted tests pass on the restored tree (parent confirmed 1415/1415 full-suite).

## Recommendation

**Ready to ship after two doc-level touch-ups** (no code changes, no further fix-pass round required for these):

1. **Register F-110 and F-111 in `BUGS_AND_FEATURES.md`** (grammar drill-attempts read; per-pattern grammar card schedule read) — or re-point the code comments at F-065/F-063 per the original SF-3's alternative. As it stands, the exact defect SF-3 named persists under new ids.
2. **Update the three stale `client/src/types/domain.ts` "~10 minutes" doc comments** (lines ~1014, ~1379, ~1395) and mark B-034 🟢 done — B-034's own fix hint lists both steps, and the commit message already claims the close.

No new blockers. All 4 original blockers are dead, each independently mutation-verified.
