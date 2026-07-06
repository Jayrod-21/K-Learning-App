# Fix report — tester-sweep Batch B (TOPIK)

Review: `REVIEW_SWEEP_BATCH_B.md` — **APPROVE, 0 blockers.** Reviewer verified mock
assembly + grading queries are byte-identical (scores can't break), all 60 excluded
rows are genuine picture items, no placeholder shift, no injection, no starvation.

| Finding | Disposition |
|---|---|
| SHOULD-FIX — the new test never called `/mock/submit`, so the assembly↔grading agreement (the highest-risk property) was inspection-verified, not CI-guarded; a future edit touching only one query wouldn't be caught. | **FIXED** — added a `/mock/submit` grading test: seeds a listening test with 2 normal + 1 picture item, submits, and asserts `totalItems === 2` and the graded `itemId`s are exactly the 2 normal items. This fails on pre-fix code (grading would include the picture item, `totalItems === 3`) and directly guards that grading excludes picture items in lockstep with assembly. |
| SHOULD-FIX — the `tooFew` (<2-option) study assertion is weak (mapRowToDTO already drops such rows post-fetch). | **KEPT (documented)** — left as intent documentation; the real P3-3 value (the SQL guard makes `LIMIT n` sample from gradeable-only) resists a non-flaky unit assertion. Not worth a random-draw count test. |

## Verification
- Server `topik.test.ts`: **43 passed** (was 41; +2 = the exclusion test and the new grading-consistency test).
- The added test is additive coverage only — no production code changed since APPROVE, so no regression surface.
