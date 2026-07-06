# Fix report — loader durable fixes review (`REVIEW_LOADER_FIXES.md`)

Independent fixpass verdict was **REJECT — 1 BLOCKER**. Disposition below.

| Change | Finding | Disposition |
|---|---|---|
| `parse_ttmik` lesson merge (F-UP-009) | Correct: first-seen order, unique 1..N ordinals, idempotent, harmless `ttmik_lessons.ordinal` gaps | **KEPT** (approved) |
| `load_vocab_2000` skip-empty-rows (B-012) | BLOCKER — drops legitimate rows + breaks re-ingest | **REVERTED** |

## BLOCKER — vocab skip-empties reverted

The reviewer showed, against the **real** corpus, that the "214 empty rows" are
NOT OCR artifacts — they are **legitimate navigational rows** (`theme_intro`,
`subsection_intro`, `reference`) whose content lives in `theme`/`subsection`/`notes`,
with `korean`/`english` NULL by design. I re-verified directly:

```
vocab_2000_beginner.json:      108 rows (no korean & no english) — theme_intro 16 / subsection_intro 73 / reference 19 — 108/108 carry theme/subsection content
vocab_2000_intermediate.json:  106 rows — theme_intro 15 / subsection_intro 69 / reference 22 — 106/106 carry content
```

214 total, exactly the count I earlier (wrongly) deleted from the live DB. The
filter `if it.korean or it.english` would drop all 214 on every ingest, AND —
because `corpus_source_id` is stable (`ON CONFLICT (corpus)`) and nothing deletes
old rows — the post-load `actual == total_items` assertion would compare the
smaller new `total_items` against the larger all-time row count and raise
`CountAssertionError`, converting a working re-ingest into a permanent hard
failure. Both the loader change and its test were reverted (`git diff` vs the
parent is now empty for `load_vocab_2000.py`).

**Root of my error:** I classified the rows as artifacts from "NULL korean + 0 FK
references" — but a `theme_intro` legitimately has both. The fixpass caught it by
checking the real corpus + migration 002's DDL semantics, not a synthetic fixture.
This is the project's standing "test with REAL corpus data" rule in action.

## KEPT — parse_ttmik lesson merge (F-UP-009)

Reviewer confirmed correct + idempotent, ordinal gaps provably harmless (every
consumer does `ORDER BY ordinal`, no uniqueness/contiguity constraint). No change.

## Follow-ups filed

- **Live data:** restore the 214 wrongly-deleted navigational rows to km-db via a
  force re-ingest of the two vocab JSONs (no functional impact today — app vocab
  queries filter `entry_type='word'`). Tracked in the B-012 entry.
- **F-UP-011** (`FOLLOW_UPS.md`): pre-existing `test_strategy_a` order-dependence
  (surfaced by the F-UP-010 re-review, not caused by it).

## Verification (post-revert)

`ruff` + `mypy` clean; `pytest tests/test_parse_ttmik.py tests/test_load_vocab_2000.py`
→ **7 passed** (2 merge + 5 original vocab); full ingest suite green.
