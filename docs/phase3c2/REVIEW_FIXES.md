# RE-REVIEW — Phase 3C-2 fix-pass verification

Independent re-reviewer, Phase 4. Did not write the original code, the four
original reviews, or the fix-pass. Verified every FIX_REPORT.md claim against
the actual diff (`git diff e781f6a~1 e781f6a`) and by re-running tests/typecheck/
lint locally — not by trusting the self-report.

## Summary verdict

**PASS.** All 11 SHOULD-FIX findings from the four original reviews are
genuinely fixed, each verified by reading the actual code change (not just the
report) and by independently re-running the relevant test files. No PRAISE
item was undone. One residual, sub-should-fix a11y nuance in the ShowMore fix
is noted below as a new NIT-level finding — it does not undercut the PASS.

## Independent verification performed

- Read all four original reviews end-to-end and the FIX_REPORT.md disposition table.
- Read `git show e781f6a --stat` and the full `git diff e781f6a~1 e781f6a` for every
  changed file (not excerpts from the report).
- Re-ran targeted suites myself (not reusing the fix-pass's numbers):
  `ShowMore.test.tsx` + `Progress.test.tsx` + `ReviewVocab.test.tsx` → 81/81 passed.
  `Ttmik.test.tsx` → 24/24 passed.
  `Reading.test.tsx` + `Today.test.tsx` + `Writing.test.tsx` + `Topik.test.tsx` +
  `MockMode.test.tsx` + `WritingTopicGenerator.test.tsx` + `topikStudyDraw.test.ts`
  → 152/152 passed. (Combined: 257/257, matching FIX_REPORT's total exactly.)
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → 0 errors.
- `npx eslint` on all 14 touched source/test files → 0 errors, 0 warnings.
- Read `components/Tabs.tsx` in full to confirm the APG contract (roving
  tabindex, Arrow/Home/End, real tabpanel) is real, not just claimed.
- Read `selectionKey()` in `Ttmik.tsx` to confirm the SF-4 primitive-key dep
  is injective (no corpus/number collision) and that `DetailView` is remounted
  wholesale on genuine selection change (so depping the effect on the stable
  key inside one mounted instance is correct, not a silent behavior change).
- Confirmed `.km-sr-only` (styles/index.css:2340) is the standard
  absolute+clip-rect visually-hidden-but-focusable pattern, not
  `display:none`/`visibility:hidden` — required for the ShowMore focus
  handoff to actually work, not just compile.
- Grepped for stale "proposed ticket" wording and cross-checked F-116–F-120
  against `BUGS_AND_FEATURES.md` line numbers directly.
- Confirmed the incidental changes described in FIX_REPORT.md (removed stale
  `eslint-disable` pair in Ttmik.tsx; reverted `role="list"` attempt) actually
  match the diff — no undisclosed extra changes found.

## Finding-by-finding table

| ID | Orig. severity | Status | Notes |
|---|---|---|---|
| Reading SF-1 (F-068 abort untested) | SHOULD-FIX | **FIXED** | New test mirrors the mineWord abort pattern exactly, captures the real signal via a never-resolving mock, drives a real tab switch, asserts `signal.aborted === true`. Fails on the pre-fix code by construction. |
| Reading SF-2 (Books `max: 30` cap) | SHOULD-FIX | **FIXED** | `max` raised to 200 in `Reading.tsx`'s `BookSection`, matching the sibling Stories window, with a code comment correctly explaining `GET /uploads` has no server `LIMIT` to mirror (so 200 is a deliberate generous ceiling, not a false claim of parity). Reasoning is sound and matches the review's ask. |
| Listen SF-1 (ShowMore focus-to-`<body>`) | SHOULD-FIX, cross-cutting | **FIXED** (see residual nit below) | Fixed once in `components/ShowMore.tsx`, not per-consumer. Renders a visually-hidden, `tabIndex={-1}` stand-in instead of `null` on the final reveal; an effect hands focus to it only on the actual button→hidden transition (verified via a dedicated "does not steal focus on already-exhausted mount" test). Verified `.km-sr-only` is genuinely focusable (absolute+clip, not `display:none`). Re-ran `Progress.test.tsx` (44/44) and `ReviewVocab.test.tsx` (30/30) myself — both consumers pass unchanged, their own window/reset assertions intact. |
| Listen SF-2 (aria-label hides AudioPill state) | SHOULD-FIX | **FIXED** | Both row `aria-label`s in `Ttmik.tsx` now fold in `(audio)`/`(no audio)`; test assertions updated to the exact new accessible names for both audio and no-audio fixtures (lesson 1/21, episode 1/143) — a real accessible-name check, not a cosmetic string change. |
| Listen SF-3 (hand-rolled tablist vs shared `Tabs`) | SHOULD-FIX | **FIXED** | Migrated to the shared `Tabs` primitive. Read `Tabs.tsx` in full: real roving tabindex, ArrowLeft/Right/Home/End, `role="tabpanel"` with `aria-labelledby`. Confirmed the persistent `<audio>` element is a sibling rendered unconditionally ABOVE the `Tabs` subtree (untouched by the swap); the pre-existing DOM-identity test (`toBe` on the audio node across Highlights↔Transcript, using the same `role: 'tab'` queries before and after) passes unchanged — 24/24. This is the highest-risk change in the fix-pass and it holds. |
| Listen SF-4 (DetailView effect keyed on fresh object) | SHOULD-FIX | **FIXED** | Depped on `selectionKey(selection)`, a stable primitive string, with a justified `eslint-disable-next-line`. Verified `selectionKey` is injective across corpora (prefixed `ttmik:`/`iyagi:`, no collision) and that `DetailView` is remounted wholesale via `key={selectionKey(...)}` in the parent whenever the selection genuinely changes — so within one mounted instance the key is constant and only `reloadTick` should re-trigger the effect. The fix is correct, not just plausible. No new regression test was added (review itself called this "latent, not live" and scoped the ask as "stabilize the deps"); this is an honest, correctly-scoped disposition, not corner-cutting. |
| Writing SF-1 (Today↔Writing handoff untested) | SHOULD-FIX | **FIXED** | New `Today.test.tsx` integration test renders the real `Today` page, drives the real `WritingTopicGenerator`, mounts a real route stub reading `useLocation().state`, and asserts the exact object `{ generatedTopic: GENERATED }` at the real route. This is a genuine end-to-end pin of both halves of the contract (state key AND route), not a hand-built-state unit test — exactly what the review asked for. |
| Writing SF-2 (backward-compat absence unasserted) | SHOULD-FIX | **FIXED** | New `WritingTopicGenerator.test.tsx` test asserts `queryByRole('button', { name: /Write this topic/ })` is absent when `onUseTopic` is omitted, after a real generation. Locks the exact contract named in the review. |
| TOPIK SF-1 (B-029 limit-forwarding untested) | SHOULD-FIX | **FIXED** | `buildStudyDrawOptions` extracted to `lib/topikStudyDraw.ts` and directly unit-tested (`'' → {}`, `'20'/'30'/'50' → { limit: N }`). `Topik.tsx`'s `realFn` now calls the extracted function. This is a real boundary test that would fail on a dropped/NaN `limit` — exactly the gap the review named, and correctly worked around the `react-refresh/only-export-components` constraint by extracting rather than exporting from the page file. |
| TOPIK SF-2 (session tally reset on unmount) | SHOULD-FIX | **FIXED** | `tally`/`setTally` lifted from `StudyMode` to the `Topik` root (which never unmounts across a mode switch or the `view==='attempts'` early return) and passed as props. Two new regression tests drive the actual unmount paths named in the review (Study→Mock→Study via the real `Tabs` re-key, and a real trip to "Previous attempts" and back) and assert the tally value survives both. `setTally` correctly added to `commitReview`'s dep array since it's now a prop, not a local state setter — a real, not cosmetic, correctness detail. |
| TOPIK SF-3 (unregistered "proposed" tickets, uncited image stub) | SHOULD-FIX | **FIXED** | Grepped both files: zero occurrences of "proposed" remain anywhere in the code. F-116–F-120 all confirmed present in `BUGS_AND_FEATURES.md` (lines 1310–1330ish) with matching descriptions. `TopikImageNote.tsx` docblock now cites F-120. Pure docs/wording fix as the review characterized it — no behavior change, none needed. |

**Counts: 11 FIXED / 0 PARTIALLY / 0 NOT-FIXED / 0 REGRESSION.**

## Bar checklist (post-fix)

| Bar | Status |
|---|---|
| WCAG AA / correct ARIA | PASS — SF-1/SF-2/SF-3 a11y gaps closed; see one residual nit below |
| Strict TS at I/O boundaries | PASS — tsc clean, `buildStudyDrawOptions` typed narrowly |
| No swallowed errors / abortable fetch | PASS — unaffected by this fix-pass, spot-checked SF-4's abort path still correct |
| Tests exercise real behavior | PASS — every new test independently re-read; none are tautological; each targets the exact unmount/transition path the originating review named |
| Co-located CSS | PASS — no new CSS files, no cross-page leakage introduced |
| No scope creep / console.log / ticketless TODO | PASS — grep clean; the two "incidental" changes (removed stale eslint-disable, reverted N-1 attempt) are both correctly disclosed and necessary/honest, not smuggled scope |
| Shared-primitive risk (`ShowMore`, `Tabs`) | PASS — both verified structurally sound; all three `ShowMore` consumers and all `Tabs`-dependent Ttmik behavior (incl. the persistent-audio identity invariant) re-run green |

## New findings introduced by the fix-pass

**N-new-1 (NIT, residual a11y gap in the SF-1 fix) — the ShowMore focus handoff lands on an off-screen node, so a sighted keyboard-only user's visible focus indicator disappears on the final reveal, even though focus is no longer lost to `<body>`.** The stand-in (`<span className="km-sr-only" tabIndex={-1}>`) is visually clipped off-screen via `position:absolute; clip:rect(0,0,0,0)`. This correctly fixes the specific WCAG 2.4.3 defect named in the original review (no more full-document re-traversal, and the existing `aria-live` region still announces the outcome to screen-reader users) — but it does not fully satisfy WCAG 2.4.7 (Focus Visible) for a keyboard-only *sighted* user, who will see the focus ring vanish with nothing to replace it, one Tab-press worth of disorientation. The original review's suggested alternative — moving focus to the first newly-revealed list item — would have closed this gap too. This is a smaller, narrower residual than the original finding (a subset of keyboard users vs. all of them) and does not warrant blocking the fix-pass; it is a legitimate follow-up nit, not a regression (nothing got worse — the primitive went from "focus lost to body" to "focus present but invisible," a strict improvement).

No other new findings, no regressions, and no PRAISE item was undone: re-ran the governing tests for the ShowMore final-reveal contract, the persistent-`<audio>` identity invariant, the F-070 honest-stub, the stale-resume guard, the draft-preservation logic, and the wall-clock timer discipline — all still green and unchanged in behavior.

## Recommendation

Ship this fix-pass as-is. Optionally file a lightweight follow-up nit for
N-new-1 (move `ShowMore`'s focus target to the first newly-revealed item
rather than an off-screen stand-in) — low priority, not a gate.
