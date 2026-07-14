# RE-REVIEW — Batch 2 (Library) fix-pass verification

**Reviewer:** independent re-reviewer (did not write the batch-2 code, the 4 original reviews, or the fix-pass)
**Branch:** `feat/redesign-library` @ `c15ade3` (fix-pass) on top of `2c2d4ad` (batch), off `rebuild`
**Method:** read all 4 original reviews + `FIX_REPORT_batch2.md`, then independently verified every claimed fix against current source (grep + full-file reads, file:line cited below), re-ran the full client gate myself, and diffed `2c2d4ad..c15ade3` to confirm the touched-file set matches the report and nothing outside it moved.

## Verdict: **PASS**

Both BLOCKERs are genuinely fixed, not relabeled. The F-152 wording lands exactly on the orchestrator's specified terms. All required SHOULD-FIX items are fixed with real, non-tautological tests, and every "left alone" item has an honest, checkable disposition. My independent full-suite run reproduces the fix-pass's exact numbers (116/1673, 0/0, exit 0). No regressions found; no praised item was undone.

---

## Finding-by-finding table

| ID | Orig. severity | Fix status | Test catches bug? | Notes |
|---|---|---|---|---|
| BLOCKER-1 (F-144, grammar picker on Vocab) | BLOCKER | **FIXED** | **Yes, real** | `MyVocabLists.tsx:90` adds `kinds` prop; `CreateListSheet` (`:392-414`) renders the `role="radiogroup"` kind picker only `if (kinds.length > 1)`. `ReviewVocab.tsx:285` mounts `<MyVocabLists kinds={['vocab']} />` — single production consumer, confirmed via `grep -rn "MyVocabLists" --include="*.tsx"`. Negative test `ReviewVocab.test.tsx:272-295` opens the actual create Sheet and asserts no `radiogroup`, no `radio`, no text "문법"/"Grammar" anywhere in the dialog or the page. `MyVocabLists.test.tsx:195-221` separately proves the narrowed mount skips the picker. |
| F-147 (create-list popup, vocab-only) | (closed w/ BLOCKER-1) | **FIXED** | Yes | Same code/tests as above; `CreateListSheet` is a real `Sheet` behind a trigger button (`MyVocabLists.test.tsx:120-135` proves it's absent until the trigger is tapped). |
| BLOCKER-2 (header split, ReviewGrammar+Mistakes on flat `Topbar`) | BLOCKER | **FIXED** | Yes | Grepped all 7 pages (`ReviewLibrary`, `ReviewVocab`, `ReviewDictionary`, `ReviewGrammar`, `Mistakes`, `Uploads`, `UploadViewer`): every one renders `<PageHubHeader`; the string `Topbar` now appears **only inside comments** in all 7 (verified line-by-line — no `<Topbar` component usage remains). `PageHubHeader.tsx:83` renders a real `<h1 id={titleId}>`, not a decorative node. `PageHubHeader.test.tsx` has 7 real unit tests (heading, eyebrow, rail, actions-slot, glyph, className). `BackButton` sits above `PageHubHeader` on both ReviewGrammar (`:298-311`) and Mistakes (`:429-442`), matching the other 5 pages. `Today.tsx`/`Progress.tsx` confirmed still on direct `SkylineHeader` (not migrated) — deliberate, with a filed follow-up (`FIX_REPORT_batch2.md` ticket #3), not an oversight. |
| F-152 (honest Mastered) | BLOCKER (semantic) | **FIXED** | **Yes, real, paired** | See dedicated wording row below. |
| Character-dropping input bug (Sheet `onClose` re-render race) | (found during fix-pass, not in the 4 reviews) | **FIXED** | **Yes, real** | `MyVocabLists.tsx:133` uses `useCallback` for `closeCreate` (stable identity); form state now lives in extracted `CreateListSheet` sub-component. `MyVocabLists.test.tsx:137-146` types a 4-character Korean string (`'새 단어장'`) via `user.type` (per-keystroke) and asserts `createList` was called with the **full** string — a regression of the focus-stealing bug would truncate this to one character and fail the assertion. |
| S1 — `km-rain-sheen` missing on ReviewLibrary + UploadViewer | SHOULD-FIX | **FIXED** | Yes (existing page tests assert the class) | `ReviewLibrary.tsx:117` and `UploadViewer.tsx:762` both carry `km-rain-sheen` on the root `<section>`. |
| S2 — Mistakes hand-rolled its own Sheet-header CSS | SHOULD-FIX | **FIXED** | Yes | `Mistakes.tsx:245-246` now renders `className="km-review__sheetBody km-mistakes__sheetBody"` / `"km-review__sheetHead km-mistakes__sheetHead"` — shared classes drive layout, page-specific class rides alongside for the one genuine per-page need. `Mistakes.css:110-112` confirms the duplicate `__sheetHead` rule was deleted (comment explains why). |
| Uploads S-1 — no `pointerleave`/`lostpointercapture` test | SHOULD-FIX | **FIXED** | **Yes, real** | `UploadViewer.test.tsx:765` (pointerleave-while-undecided) and `:787` (lostpointercapture mid-gesture) are new, dedicated tests, each also proving a fresh swipe with a new `pointerId` still works afterward — matches the reviewer's own suggested repro shape. |
| Grammar-Mistakes #3 — no second-tile Sheet-content test | SHOULD-FIX | **FIXED** | **Yes, real** | `Mistakes.test.tsx:299-328` opens `questionTile(20)` (the second tile in a multi-tile group) and asserts the Sheet shows `MISTAKE_SAME_SESSION`'s own distinguishing prompt (`'빈칸에 알맞은 말을 고르십시오.'`), not the first tile's — exactly the index-regression repro the original review asked for. |
| F-150 pager exactness | SHOULD-FIX (S-2) | **DEFERRED, honest** | N/A (disclosed, not silently dropped) | `ReviewDictionary.tsx:80-91` still carries the exact, unchanged doc comment (504+157 of 53,978 rows, ~1.2%, correct server-side fix named). Acceptable per the task's own option-2 framing — a follow-up ticket exists (`FIX_REPORT_batch2.md` ticket #1), and this was never asked to become a P1 fix. |
| Grammar-Mistakes NIT 5 — dead `rowItem` className | NIT | **FIXED** | N/A (cosmetic) | `ReviewGrammar.tsx:422` — className removed from the `<li>`; comment explains why it's safe. |
| Fidelity N2 — BackButton placement | NIT | **FIXED (side effect)** | N/A | Confirmed above under BLOCKER-2. |
| Grammar-Mistakes NIT 6/7, Fidelity N1/N3, Uploads S-2/N-1/N-2 | NIT | **NOT ADDRESSED (by design)** | N/A | All match their original reviewers' own "not a defect / out of scope" framing; the fix-pass report's dispositions are consistent with that, not a new dodge. |

## F-152 wording verification (verbatim check)

- **Add-to-bank action label:** ✅ reads **"Add"** (`ReviewGrammar.tsx:477`, `추가`), pending state **"Adding…"** (`:475`, `추가하는 중…`), post-add state **"Added"** (`:473`, `추가됨`). No "Bank"/"Save"/"Save to review" copy anywhere.
- **"Mastered" + milestone SealStamp gating:** ✅ strictly `graduated.has(key)` (`ReviewGrammar.tsx:415`, `graduated` set populated only where `e.graduated_at !== null`, `:204`) — never on mere bank presence. `aria-label` is `"Already mastered"` only when `isGraduated` (`:454-459`); `SealStamp` (`:461-471`) is inside the same branch.
- **No "Bank"/"Banked" user-facing remnants:** ✅ grep-confirmed — only internal, non-rendering identifiers remain (`bankPattern`, `listBanked`, `kgiuBankBody`); no visible string, `aria-label`, or class describes the action as "Bank."
- **Test coverage:** ✅ real, paired, same-fixture-shape tests: `ReviewGrammar.test.tsx:418-446` (added, `graduated_at: null` → button named exactly `'Added'`, no `'Mastered'`) and `:447-470` (`graduated_at` set → `'Mastered'` + seal, `'Added'` absent). A regression that stopped checking `graduated_at` would fail one of these immediately. Detail-Sheet path separately covered (`:508-524`).
- **Server contract:** ✅ untouched — `bankPattern`/`listBanked` called identically to before (confirmed by reading the diff hunk; no changes to `server/src/routes/grammar.ts`).

**Result: F-152 wording verification PASSES on all four checks.**

## Praise-intact / no-regression check

- **Zero hardcoded hex** still holds across all 7 touched pages + `PageHubHeader.css` + `MyVocabLists.tsx` — re-ran `grep -nE "#[0-9a-fA-F]{3,8}"` myself, no matches.
- **F-155 swipe gesture logic untouched** — `git diff 2c2d4ad..c15ade3 -- client/src/pages/UploadViewer.tsx` shows only header-integration changes (49 lines, matching the reskin); `SwipeCarousel.tsx`/`.css`/`.test.tsx` do not appear in the diff at all.
- **Reduced-motion gating intact** — `seoul-devices.css` is not in the changed-file list.
- **No regression from the shared-component changes** — full suite (below) is green at the exact count the fix-pass reported; touched-file diff (`git diff 2c2d4ad..c15ade3 --stat`, 30 files) matches the fix report's claimed scope exactly, no surprise files (Today.tsx, Progress.tsx, SwipeCarousel.tsx confirmed absent from the diff).

## Independently-run gate (from `client/`)

| Gate | Result |
|---|---|
| `npm run lint` | **0 problems** |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| `npx vitest run` | **116 test files passed, 1673 tests passed, 0 failed** |
| `npx vite build --outDir /tmp/km-rr-batch2` | **exit 0** (same pre-existing chunk-size-warning notice, not an error) |

All four numbers match the fix-pass's self-reported gate exactly.

## New findings

None. No new bugs, no undone praise, no silently-abandoned disposition found during independent verification.

## Recommendation

**Ready to PR into `rebuild`.** No further fix-pass needed for this batch. Working tree left clean (read-only verification; no scratch edits made). Pre-existing untracked files `.claude/` and `REDESIGN_SEOUL_NEON_BRIEF.md` were present before this review began and are unrelated to it.
