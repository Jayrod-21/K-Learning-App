# Fix report — TTMIK lesson titles (F-UP-006)

Review: `REVIEW_TTMIK_TITLES.md` — **PASS, 0 BLOCKERs**, 3 SHOULD-FIX. All 20
sampled titles verified accurate against DB content; invariants held (232, exact
coverage, globally unique, DB matches file).

| Finding | Disposition |
|---|---|
| L1L25 "Level 1 Review: Vocabulary and Phrases" — accurate but generic | **FIXED** — content teaches the from/to/until particles → "From A to B: 에서/부터 and 까지". |
| L5L11 "Sentence Building Drill 2: Review and Practice" — doesn't name forms | **FIXED** — content combines 중에서 / 아무거나 / -자마자 → "Sentence Drill: 중에서, 아무거나, -자마자". |
| L5L20 "Sentence Building Drill 3: Review and Practice" — doesn't name forms | **FIXED** — content combines 다고 하다 / -(이)라도 / -(으)려고 하다 → "Sentence Drill: 다고 하다, -(이)라도, -(으)려고 하다". |

Each new title verified against the lesson's actual `ttmik_sentences`/`ttmik_transcript_lines`.
Re-verified after the edits: 232 entries, all globally unique, max 52 chars, 4–8
words. Applied to the live DB (3 UPDATEs) + the data file.
