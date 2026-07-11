# Phase 3C-2 Review — Writing slice

**Reviewer scope:** `client/src/pages/Writing.{tsx,css,test.tsx}`, `client/src/components/WritingTopicGenerator.tsx` (new optional `onUseTopic` prop), `client/src/services/writing.ts` (additive `fetchRandomWritingPrompt`), F-101 handoff slice of `client/src/pages/Today.tsx`; `server/src/routes/writing.ts` + `server/src/routes/gradeWriting.ts` sampled for wiring context. Diff base: `rebuild`.

## Verdict

**PASS — 0 BLOCKERS, 2 SHOULD-FIX (both test-coverage gaps, not code defects), 4 NITs.**

B-027 is genuinely fixed and test-proven. The F-101 Today↔Writing contract is sound end-to-end: Today sends exactly the shape Writing narrows, and untrusted `location.state` is defended field-by-field with a graceful bank-flow fallback. The F-074 stub is honest. F-073 topics are writable and gradable, not display-only. The code quality is high — the draft-preservation and focus-management work in particular is careful, deliberate, and tested.

## Quality-bar checklist

| Bar | Status | Evidence |
|---|---|---|
| WCAG AA / correct ARIA | PASS | Rubric radiogroup with roving tabindex + wrapping arrows (Writing.tsx:527-541, 589-617); persistent `aria-live="polite"` wrapper for the grade reveal (Writing.tsx:670) and the generator result (WritingTopicGenerator.tsx:214); `role="status"` loading/busy rows; `role="alert"` errors; `aria-describedby` links grade panel to textarea (Writing.tsx:781) |
| Strict TS at I/O boundaries | PASS | `readGeneratedTopic` runtime-narrows opaque router state (Writing.tsx:240-258); DTOs mirror server field-for-field (services/writing.ts:64-75, 193-204); closed enums throughout; no `any`, no unchecked casts that escape a runtime guard |
| No swallowed errors | PASS | All three legs abortable with `canceled` distinguished from failure (Writing.tsx:385-396, 452-462; WritingTopicGenerator.tsx:121-128); fixed-copy errors, never echoed server prose (Writing.tsx:264-297); 429 renders structured `retryAfter` (Writing.tsx:266-268); real Retry paths |
| Tests exercise real behavior | PASS* | Outgoing grade bodies asserted with `toEqual` (exact wire contract incl. `promptId` presence/absence — Writing.test.tsx:297-302, 572-577); header-follows-payload disagreement test; negative assertions (`not.toHaveBeenCalled`, `not.toHaveProperty`). *Two coverage gaps below (SF-1, SF-2) |
| Co-located CSS | PASS | `Writing.css` new, tokenized, documented; only 3C-2 additions (grammar sheet rules deliberately reused) |
| No scope creep | PASS | Writing/Today diff carries only the ticketed work (Today also carries B-019 retarget — a phase ticket, noted for coordination) |
| No console.log / un-ticketed TODO | PASS | grep clean across all five scoped files |
| Honest-stub bar | PASS | See F-074 and F-117 below |

## Ticket verification

### B-027 — VERIFIED FIXED
- **Random selection:** the screen calls `fetchRandomWritingPrompt` (services/writing.ts:118-130 → `GET /writing/prompts/random?rubric=`), and the server pick is genuinely random (`ORDER BY random() LIMIT 1`, server/src/routes/writing.ts:176-182, empty pool → 404). Tests assert the random endpoint is the selection path on initial draw (Writing.test.tsx:176-179), rubric switch (442-444), and redraw (502-503 — "a second RANDOM draw — not a client-side rotation").
- **Header follows the served payload:** `headerMetaFor` derives eyebrow/target from the ACTIVE task's own rubric (Writing.tsx:208-227), never a hardcoded Q53. The dedicated test serves a Q54 payload under the default Q53 radio and asserts the header + textarea label follow the payload, with a negative assertion on the Q53 eyebrow (Writing.test.tsx:187-201). This is exactly the disagreement scenario the bug ticket describes.
- **Rubric-widen deferral is honest:** free-writes grade against `topik_ii_54` — the server's own `/grade-writing` default (gradeWriting.ts:46) — with a visible bilingual note (Writing.tsx:788-797), asserted in the F-101 test (Writing.test.tsx:597-599). Deferral carries a ticket ref (F-117) in both the constant doc (Writing.tsx:137-147) and the note comment.

### F-073 — VERIFIED (writable + gradable, not display-only)
`WritingTopicGenerator` mounts on the Writing page with `onUseTopic={adoptTopic}` (Writing.tsx:677); adopting makes the topic the active task, clears the sheet, and moves focus into the textarea (Writing.tsx:513-523, 404-409). The end-to-end test generates → adopts → types → grades, and asserts the exact grade body with `promptId` ABSENT (correct: generated topics have no `writing_prompts` row and the server schema is `.strict()` — gradeWriting.ts:53) (Writing.test.tsx:531-579).

### F-101 — VERIFIED (contract sound, state defended)
- **Shape contract:** Today sends `navigate('/learn/writing', { state: { generatedTopic: topic } })` where `topic` is the `GeneratedWritingPrompt` handed up by the generator (Today.tsx:453-459). Writing narrows precisely that key and shape: `readGeneratedTopic` checks `promptKr` non-empty string, `promptEn` string, `mode` ∈ {topik, general}, `lengthHint` null|string, `rubric` null|Q53|Q54 (Writing.tsx:240-258) — a field-for-field match with `GeneratedWritingPrompt` (services/writing.ts:193-204). No mismatch.
- **Untrusted-state defense:** router state is treated as attacker-shapeable; a malformed payload falls back to the bank draw (tested with `{ promptKr: 123, mode: 'nonsense' }` — Writing.test.tsx:620-629). All topic text renders through React text children only; no `dangerouslySetInnerHTML` anywhere in the slice.
- **Replay defense:** the seed is snapshotted once via lazy `useState` initializer, then the history entry is scrubbed with `navigate(..., { replace: true, state: null })` so Back/refresh cannot replay the deep link (Writing.tsx:306-308, 351-358).
- **Gradable:** the carried topic grades with the correct body and no `promptId` (Writing.test.tsx:581-618).

### F-074 — VERIFIED (honest stub)
`ResponsesStub` (Writing.tsx:860-874) states plainly that browsing is coming, fabricates nothing, and the docstring carries the F-106 ticket ref for the missing `GET /writing/attempts`. The test asserts the honest copy AND that nothing pretends to be a past attempt (Writing.test.tsx:650-663). Meets the honest-stub bar; not a finding.

### F-024 — VERIFIED
`BackButton` pinned above the Topbar (Writing.tsx:569-571) with a rationale comment; rendered-control test at Writing.test.tsx:685-688.

## Findings

### BLOCKER — none.

### SHOULD-FIX

**SF-1: The Today side of the F-101 handoff has zero test coverage, and its failure mode is silent.**
`client/src/pages/Today.test.tsx` gained only the B-019 reading-tile test this phase; no test clicks "Write this topic" on the Today tile and asserts navigation to `/learn/writing` with `state.generatedTopic`. Writing.test.tsx exercises the receiving side with hand-built state (Writing.test.tsx:587), so the two halves of the contract are never tested against each other. Because `readGeneratedTopic` degrades gracefully, a future typo/rename of the state key on either side (e.g. `generatedPrompt`) would pass the entire 1454-test suite while silently reducing F-101 to a plain navigation — the learner lands on Writing with a random bank prompt and no error anywhere. Recommend: a Today.test.tsx integration test that mocks `generateWritingPrompt`, generates on the writing tile, clicks "Write this topic", and asserts the Writing route received `{ generatedTopic: <the topic> }` (a route-stub that renders `JSON.stringify(location.state)` is enough; rendering the real Writing page is better). File: Today.tsx:453-459.

**SF-2: WritingTopicGenerator backward-compat is asserted only implicitly.**
The prop docstring promises the prop-less Today tile "renders byte-identically to the pre-prop component" (WritingTopicGenerator.tsx:79-88), and the code trivially satisfies it (`onUseTopic !== undefined ? <Button/> : null`, line 230). The 9 pre-existing component tests all render `<WritingTopicGenerator />` prop-less and pass unchanged — good regression signal — but none asserts the "Write this topic" action is ABSENT without the prop, so a future default (`onUseTopic = someFallback`) would not fail a test. One `queryByRole('button', { name: /Write this topic/ })).not.toBeInTheDocument()` in WritingTopicGenerator.test.tsx locks the Today display-only contract. File: client/src/components/WritingTopicGenerator.test.tsx (unchanged this phase).

### NIT

**N-1: Character counter is invisible to screen readers.** The live `{sample.length}자` counter (Writing.tsx:786) is not associated with the textarea (no `aria-describedby`, no polite region), so non-visual users get no progress signal toward the 200–300자 / 600–700자 band — the one number that matters most on a length-graded task. Not an AA failure (the target band is in the accessible label), but a cheap, high-value add. Beware announce-spam: a debounced/milestone live region, not per-keystroke.

**N-2: `readGeneratedTopic` doesn't bound `promptKr` length.** The grade route bounds `prompt` at 1..2000 server-side; an in-app-crafted oversize topic passes the narrowing, renders safely (text children), but guarantees a 400 at grade time surfaced as generic error copy. A length cap in the narrowing would degrade earlier and cleaner (fall back to bank flow). Purely defensive; server topics are well within bounds. Writing.tsx:243-254.

**N-3: Rubric radios stay interactive while a grade is in flight.** `selectRubric` aborts the in-flight grade without confirmation (Writing.tsx:494-506). Deliberate and draft-safe (phase resets to composing), but the abort is client-side only — the server call may still complete and persist an attempt the learner never sees, and the learner silently abandons a slow, expensive grade with one mis-click. Consider `aria-disabled`-style gating on the radios during `grading`, symmetric with the Grade button.

**N-4: Cross-page CSS class dependency.** The rubric radiogroup reuses `.km-review__tabs` / `.km-review__tab` classes (Writing.tsx:590, 607) owned by another page's stylesheet, relying on global CSS load order. Works today, but a Review-page reskin re-skins Writing's radios silently. Promoting the segmented-control rules to a shared file (or `km-writing__`-scoped copies) removes the hidden coupling. Same note applies to the heavy `.km-grammar__*` reuse, though that one is documented as deliberate in Writing.css's header.

### PRAISE (fix-pass must not undo)

- **P-1: Same-prompt redraw preserves the draft.** Uniform random over a single-digit pool WILL repeat; `lastBankIdRef` + `clearOnArrivalRef` clear the sheet only when a genuinely different task lands after an explicit redraw (Writing.tsx:341-344, 373-383), and a failed redraw resets the flag (line 388). Tested both ways (Writing.test.tsx:488-529). This is the subtle correctness most implementations miss.
- **P-2: Focus-preserving busy states.** `aria-disabled` + click-guard instead of `disabled` on Grade (Writing.tsx:823-828) and `readOnly` instead of `disabled` on the textarea (line 780), each with a WCAG 2.4.3 rationale comment; the busy-button test asserts focusability AND re-entry blocking (Writing.test.tsx:325-355).
- **P-3: The grade-body tests pin the `.strict()` wire contract exactly** — `toEqual` on the full body plus `not.toHaveProperty('promptId')` for generated topics (Writing.test.tsx:297-302, 572-577), matching the server schema (gradeWriting.ts:42-53). These tests would catch a real 400-class regression, not just "a function was called".
- **P-4: Honest 404 empty state distinct from retryable error** (Writing.tsx:389-394; asserted including the no-alert negative, Writing.test.tsx:232-246).
- **P-5: Timeout engineering in services/writing.ts** — the 65s grade ceiling deliberately outlasts the server's 60s upstream ceiling so slow grades surface as the server's structured 502/504 instead of an ambiguous client abort, with the reasoning written down (services/writing.ts:132-145).
- **P-6: Deep-link replay scrub** — snapshot-then-scrub with `replace: true, state: null` (Writing.tsx:306-308, 351-358); Back/refresh cannot re-trigger F-101.

## Coordination observations

- **WritingTopicGenerator backward-compat (Today consumer):** the prop is optional with a `= {}` default destructure (WritingTopicGenerator.tsx:90-92); the diff vs `rebuild` touches only the props interface and the conditionally-rendered button inside the existing polite live region — no behavioral change on any prop-less render path. All 9 pre-existing component tests pass unchanged against the prop-less form, which is the Today tile's exact usage. Compat confirmed; SF-2 asks only for it to be locked by assertion. Note the "Write this topic" button renders inside the `aria-live="polite"` region alongside the topic it acts on — correct placement (announced with its context).
- **F-101 Today↔Writing contract:** shape verified sound by inspection (see ticket section) — the callback parameter is typed `(topic: GeneratedWritingPrompt) => void` on both ends, so tsc enforces the payload type; only the state KEY (`generatedTopic`) and route string are convention-held, which is precisely what SF-1's integration test should pin.
- **Today.tsx also carries the B-019 retarget** (Reading tile `/learn/listen` → `/learn/reading`, Today.tsx:295-301, tested in Today.test.tsx). Outside this review's ticket list; whoever reviews the Reading slice should confirm `/learn/reading` is a registered real route in the app router, not just the test stub.
- **Server sampling confirms client claims:** `/writing/prompts/random` requires `rubric`, 404s on empty pool (writing.ts:147-186); `/writing/generate` body `.strict()` with closed enums (writing.ts:264-275); grade rubric defaults to Q54 server-side (gradeWriting.ts:46) — the client's `DEFAULT_GENERATED_RUBRIC` and the F-117 note are accurate, not aspirational.
