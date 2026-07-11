# Phase 3B Re-Review — Fix-Pass Verification

- **Reviewer:** independent re-review (did not author the code, did not write the original reviews, did not perform the fix-pass; the fix report was treated as a map, every claim verified against the tree)
- **Date:** 2026-07-10
- **Branch:** `feat/phase3b-library` · fix-pass commit `0952897`
- **Inputs:** the four original reviews (`REVIEW_landing.md`, `REVIEW_mistakes.md`, `REVIEW_vocab.md`, `REVIEW_grammar_uploads.md`), `FIX_REPORT.md`, `git diff 0952897~1 0952897`, targeted vitest + greps run fresh
- **Suite state:** parent gate reports full client suite green (lint clean, tsc 0, vitest 1353/1353). Independently re-ran the 7 touched page/component test files here: **101/101 pass** (+ UploadViewer 35 untouched-behavior = the 136 the fix report claims).

---

## Summary verdict

**PASS WITH CONDITIONS.**

All 14 SHOULD-FIX findings were genuinely addressed in code: **12 FIXED, 2 PARTIALLY-FIXED, 0 NOT-FIXED, 0 REGRESSION-INTRODUCED**. The two partials are one-line documentation residues (a `KM-3B-M3` straggler in a CSS comment that the fix report wrongly claims is gone, and the F-058 backlog entry still lacking its disposition note). No code defects, no a11y regressions, no praise items undone, no scope creep. The conditions are the two doc one-liners — neither warrants another fix-pass cycle; they can ride the next commit.

---

## Finding-by-finding verification

| ID | Original severity | Status | Notes (verified against code, not the report) |
|---|---|---|---|
| Landing SF-1 — `/images` orphaned, ticket missing | SHOULD-FIX (high) | **FIXED** | F-102 exists (`BUGS_AND_FEATURES.md:1230`) with the re-entry options the review asked for; `ReviewLibrary.tsx:16-21` header now cites F-102 explicitly ("leaving `/images` with no in-app entry point — its re-entry home is ticket F-102"). |
| Landing SF-2 — stale eyebrows on 3 browse sub-pages | SHOULD-FIX | **FIXED** | `ReviewVocab.tsx`, `ReviewDictionary.tsx`, `ReviewGrammar.tsx` all replace the hand-written pair with `<Bilingual en={LIBRARY_NAV.label} kr={LIBRARY_NAV.kr} />` where `LIBRARY_NAV = navItem('review')` (label `Library`, kr `자료실` — verified in `nav.ts:103-111`). Rename-proof, same pattern as the landing (P-1 extended, not replaced). ReviewVocab.test.tsx re-pins the new pair AND negatively guards both stale strings. |
| Landing SF-3 — BackButton labels stale/inconsistent | SHOULD-FIX | **FIXED** | All five (`Mistakes.tsx`, `Uploads.tsx`, `ReviewVocab.tsx`, `ReviewDictionary.tsx`, `ReviewGrammar.tsx`) now `label={LIBRARY_NAV.label}`; all five pinned test expectations updated to "Back to Library" and pass. `UploadViewer.tsx` bare "Back" correctly untouched (its diff is comment-only). |
| Landing SF-4 — past-exams ticket missing | SHOULD-FIX | **FIXED** | F-103 exists (`BUGS_AND_FEATURES.md:1234`, depends-on-F-104 noted, pinning-test update instruction included); cited in `ReviewLibrary.tsx` header + the SECTIONS `exams` comment + the stub-pinning test comment. |
| Landing SF-5 — LibrarySubnav landmark name | SHOULD-FIX | **FIXED** | `LibrarySubnav.tsx:36` → `aria-label="Library sections"`. New pinning test (`LibrarySubnav.test.tsx:41-47`) fails on old code by construction. Bonus: ReviewGrammar's F-054 negative guard now asserts BOTH vintages absent (`ReviewGrammar.test.tsx:171-180`). |
| Mistakes SF-1 — silent limit=100 truncation | SHOULD-FIX | **FIXED** | `fetchMistakes({ limit: MISTAKES_FETCH_LIMIT })` with a documented `= 200` constant (server max); `atFetchLimit` softens the all-sessions stat to "Your most recent N missed / 최근에 틀린 N문제". Both new tests are real: the wire-contract test captures the actual `realFn` closure from the hook options and asserts `{ limit: 200 }` — on un-fixed code `fetchMistakes()` is called argless and the assertion fails; the 200-row test asserts the softened copy present AND `/missed in the last 30 days/` absent — fails on un-fixed code. Mutation claim credible. |
| Mistakes SF-2 — grouping aggregation untested | SHOULD-FIX | **FIXED** | Exactly the two tests the review prescribed: (a) two same-day same-mode misses + one other-session miss → one "2 missed" option, both tiles in insertion order (`compareDocumentPosition`), other session excluded; (b) rerender with reshaped data under a selected session → selector value `''`, full list + total stat rendered. Fixture timestamps 5 min apart (TZ-safe). Asserts real behavior, not implementation. |
| Mistakes SF-3 — KM-3B-M1/M2/M3 comment-only tickets | SHOULD-FIX | **PARTIALLY-FIXED** | F-104/F-105/F-106 all exist with substantive bodies (`BUGS_AND_FEATURES.md:1238-1248`) and every `Mistakes.tsx`/`Mistakes.test.tsx` reference was converted. **But one straggler remains: `client/src/pages/Mistakes.css:132` still reads "stubbed — ticket KM-3B-M3"** — the fix report's claim "Repo-wide grep: zero `KM-3B` refs remain" is **false**. Comment-only, one-line fix. |
| Vocab SF-1 — ReviewDictionary no retry | SHOULD-FIX | **FIXED** | Real `reloadTick` monotonic state + fetch-effect dep + `onRetry={retry}` on the ErrorCard (`ReviewDictionary.tsx:137-141, 224-231, 287-292`), mirroring ReviewVocab as asked; 503 path retry-capable with rationale. Verified `ErrorCard` renders no Retry button without `onRetry` (`ErrorCard.tsx:58`), so both new recovery tests genuinely fail on un-fixed code. |
| Vocab SF-2 — F-053 backend follow-up not filed | SHOULD-FIX | **FIXED** | F-107 exists (`BUGS_AND_FEATURES.md:1250`) covering provenance on save paths + `GET /vocab/saved-from-uploads`, explicitly distinguished from F-108; `ReviewVocab.tsx` SavedFromUploads comment now cites F-107 concretely. The honest `return null` stub is untouched. |
| Vocab SF-3 — ReviewDictionary coverage thin | SHOULD-FIX | **FIXED** | All four asked-for behaviors covered (file 4 → 13 tests): 초성-supersede asserts `initial` absent from EVERY call while `q` rides, plus the no-resurface-on-clear pin with "전체" pressed; 503 and 500 paths assert fixed copy, server prose absent, and Retry recovery; pager asserts `offset: 30`/`offset: 0` on the wire plus "1–30 of 90"/"31–60 of 90" range copy and Prev disabled-state; 초성 survives a genre pivot (bar hides on vocab backend, reapplies pressed + `initial` param on clear). None tautological. |
| Grammar SF-1 — hand-rolled `role="tablist"` | SHOULD-FIX | **FIXED** | The hand-rolled strip is deleted; shared `Tabs` (F-032) mounted in controlled mode (`active={view}`, `onChange` narrowed onto the closed `View` vocabulary — no cast). Verified `Tabs.tsx` itself delivers the full APG contract: roving tabindex (exactly one `tabIndex=0`), ArrowLeft/ArrowRight with wrap + Home/End, automatic activation, real `role="tabpanel"` + `aria-labelledby`, `aria-controls` on the selected tab only (documented axe `aria-valid-attr-value` rationale — APG-conformant for a render-one-panel design). The keyboard test is genuine: `user.keyboard('{ArrowRight}')` then asserts focus moved, `aria-selected` flipped, tabindexes swapped, AND the Uploads panel content rendered; `{Home}` returns with panel content re-asserted. It fails structurally on the old strip (`getByRole('tabpanel')` had nothing to resolve). F-054 removal tests strengthened, bank/detail-sheet tests unchanged and passing (20/20). The bank-error card moved above the tabbed area — a justified, documented consequence (re-keyed panel must not unmount the message), not creep. |
| Grammar SF-2 — F-058 respec undocumented at the ticket; phantom phase report | SHOULD-FIX | **PARTIALLY-FIXED** | Three of four legs done: F-109 filed (`BUGS_AND_FEATURES.md:1258`) carrying the full disposition ("F-058 is done-as-respecced"); `Uploads.tsx:18-23` header re-pointed from the phantom phase report to F-109; the phase reports now actually exist in `docs/phase3b/`. **Residue: the F-058 entry itself (`BUGS_AND_FEATURES.md:889-891`) still reads 🔴 open with the literal "shows only PDF versions" text and no disposition note or F-109 cross-ref** — the review's exact ask. A reader landing on F-058 still can't tell it shipped-as-respecced without stumbling onto F-109. One-line doc fix. |
| Grammar SF-3 — delete confirm fails open | SHOULD-FIX | **FIXED** | `Uploads.tsx:146` → `: false` with a fail-CLOSED comment. The no-new-test rationale in the fix report is sound: the branch is unreachable under jsdom, and existing tests fully cover cancel/accept/failure via the `confirm` stub. |

Cluster C cross-checks: all eight tickets (F-102 through F-109) verified present in `BUGS_AND_FEATURES.md:1230-1260` with substantive, accurate bodies (F-104 correctly cites migration 046 and its unblocks; F-107/F-108 correctly disambiguated; F-108 cited at every U2 mention in `UploadViewer.tsx` and `ReviewGrammar.tsx`).

---

## Stale-copy sweep (Cluster A) — independent re-grep

- **"Review library"** — zero user-visible or AT-visible occurrences remain. Every hit is either a historical code comment (the class the original review explicitly sanctioned: `ReferenceRedirect.tsx`, `MyVocabLists.tsx`, `grammarBank.ts`, `Grammar.tsx`, `Review.tsx`, module-header prose in `ReviewVocab/ReviewDictionary/ReviewGrammar/Mistakes/Uploads`) or a *negative* test guard asserting the string is absent.
- **"복습 자료실"** — one hit, and it is the negative guard (`ReviewVocab.test.tsx:207`).
- **`label="Review"`** — zero on BackButtons. The single grep hit is `Review.tsx:700` `aria-label="Review section"`, which is the legacy review-history page's own internal strip — out of P3B scope and correctly named for that page.
- **`UploadViewer.tsx` bare "Back"** — confirmed untouched (its entire diff is comment re-pointing).
- All five BackButtons and all three eyebrows source from `navItem('review')`, so the copy can no longer drift from the manifest.

## Praise-preservation check (19 items)

Verified by reading the full diff, not the report: the manifest-driven landing pattern was **extended to** the sub-pages, not replaced; the Mistakes stat line still only ever shows missed counts (the softened copy is still a missed count — F-045 honesty intact); the `aria-live` container is the persistent `<p>` with the new conditional **inside** it, so announcements still fire; the derived stale-key fallback is untouched and now test-pinned; the pagination-honesty contract, F-053 `null` stub, `showGrammar` default, `ResultPage` union, and select-boundary guards are all untouched; the rotation/zoom/cache-bust geometry is untouched (`UploadViewer.tsx` diff is comment-only); the F-054 removal-regression tests were strengthened (both landmark vintages guarded), not weakened; fixed-copy discipline extended into every new error test (server prose asserted absent). **No praise item undone.**

## Bar checklist post-fix

| Bar | Verdict |
|---|---|
| WCAG AA / correct ARIA | PASS — improved: real APG tabs on ReviewGrammar (verified in the primitive, not just the mount), honest landmark name on LibrarySubnav, retry affordance on every ReviewDictionary error path |
| Strict TS at boundaries | PASS — `onChange` string narrowed onto the closed `View` vocabulary by guard, not cast; no new `any`; tsc 0 per parent gate |
| No swallowed errors | PASS — ReviewDictionary gains recovery; no catch loosened anywhere in the diff |
| Tests exercise real behavior | PASS — every behavioral fix ships a test that demonstrably fails on un-fixed code (wire-contract capture, missing Retry button, missing tabpanel); keyboard test drives real key events and asserts focus + selection + panel |
| Co-located CSS | PASS — Tabs brings its own `Tabs.css`; no new CSS written |
| No scope creep | PASS — diff maps 1:1 onto the 14 findings + their pinned tests + the docs landing; the one behavior change beyond the letter of a finding (bank-error card above the tabs) is a necessary consequence of the Tabs mount, documented inline |
| No console.log / unticketed TODO | PASS in code — one stale ticket ref survives in a CSS comment (NEW-1) |
| No dead imports / dead CSS | PASS with the one recorded, F-097-deferred orphan (NEW-3) |

## New findings introduced by the fix-pass

- **NEW-1 (NIT, fix-report accuracy):** `client/src/pages/Mistakes.css:132` still cites "ticket KM-3B-M3". The fix report's Cluster-C claim "Repo-wide grep: zero `KM-3B` refs remain" is factually wrong — the grep evidently covered `.tsx`/`.ts` only. Comment-only; change to F-106.
- **NEW-2 (NIT, doc residue of Grammar SF-2):** `BUGS_AND_FEATURES.md:889` F-058 entry still 🔴 open, no disposition note, no F-109 cross-ref. Add one line: "Done-as-respecced to the viewable-rendition filter (see F-109 for the literal source-format follow-up)."
- **NEW-3 (recorded, no action):** `.km-resources__tabs` (`styles/index.css:4610`) — confirmed by independent grep to be the **only** class newly orphaned by the Tabs mount (zero `.tsx` consumers; `km-review__tabs`/`km-review__tab` remain heavily consumed by LibrarySubnav, LibraryControls, Writing, Grammar, Ttmik, Review). Genuinely dead; the F-097 deferral per the documented parallel-build policy is appropriate and the fix report is accurate here.
- **NEW-4 (observation, not a defect):** ReviewGrammar's tab strip now renders with `km-tabs__*` styling instead of the `km-review__tab` pills, a deliberate visual divergence from LibrarySubnav's pill row. Consistent with the other `Tabs` consumer (`Progress.tsx`); the phase-wide strip-consolidation observation from the grammar review already covers the long-term convergence.

No functional, a11y, or test regressions found. Nothing in the diff weakens an existing guarantee.

## Recommendation

**Ready to ship** once the two one-line doc residues (NEW-1, NEW-2) are applied — they are comment/backlog edits with zero runtime surface and do not warrant another fix-pass cycle; fold them into the next commit on this branch (e.g., alongside this report landing). **No new blockers. No further re-review required** provided the two lines land as described.
