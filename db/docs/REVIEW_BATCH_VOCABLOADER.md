# Review: batch — vocab loader + FSRS client

Reviewer: independent senior engineer (did not author this code).
Branch: `fixpass-batch-review`. Date: 2026-07-02.
Scope: `load_vocab_2000.py` count-assertion hardening + constraint pre-validation;
`reviewSubmission.ts` / `.test.ts`; `Review.tsx` delegation. Compared against the
fixed reference loaders (`load_kgiu.py`, `load_topik.py`), `ADR-019`,
migration `002_darakwon_corpora.up.sql`, and `SENIOR_ENGINEER_BAR.md`.

---

## Summary verdict

**APPROVE.** Both changes meet the bar. The count-mismatch path now fails loud
(raises `CountAssertionError` → `mark_failed` → non-zero exit) exactly like the
topik/kgiu fix, and the vocab loader's constraint pre-validation is *more*
thorough than either reference loader — it defends every realistic `vocab_entries`
CHECK/enum path with a per-row `MalformedEntryError` naming the offending
`source_id`. The FSRS client now sends only `{ rating, expected_version }`, the
stub interval is gone from both the builder and `Review.tsx`, and `expected_version`
is threaded from the due card (the fix for the every-second-rating 409). Tests pin
both contracts and would fail on the pre-fix code.

**0 BLOCKERS · 1 SHOULD-FIX · 2 NIT.**

Top finding (SHOULD-FIX): the level-aware *terminal* proficiency fallback
(`_LEVEL_TO_FALLBACK_PROFICIENCY`, the branch the author specifically added to stop
a beginner→L3 mis-tag) is never exercised by a test — only the source-default path
is.

---

## Bar checklist

| Gate | Verdict | Note |
|------|---------|------|
| Count mismatch RAISES (not warn+complete) | PASS | `load_vocab_2000.py:181-191` raises `CountAssertionError`; routes to `except` → `mark_failed` (203-225). |
| Failure-recording `try` spans validation + first tx + batches | PASS | `try` at :86 covers `read_bytes`/validate, the checkpoint+corpus_sources tx, batch inserts, and the count check. Mirrors kgiu. |
| `ck_vocab_entries_proficiency_required` guarded | PASS | `:314-318` — word rows backfill; fallback is **level-aware** (beginner→basic, intermediate→L3), not flat. |
| `ck_vocab_entries_korean_required` guarded | PASS | `:299-308` — empty/whitespace headword treated as missing. |
| `vocab_entry_type` enum guarded | PASS | `:268-278` — unknown type → `MalformedEntryError` + `source_id`. |
| `content_domain` enum guarded | PASS | `:281-291` — off-enum domain → `MalformedEntryError` + `source_id`. |
| `ck_vocab_entries_jsonb_arrays` (notes shape) | PASS | `:321-326` — list→json array, str→json string; both satisfy `jsonb_typeof IN ('array','string')`. |
| Per-row errors name the source_id (not opaque batch CHECK) | PASS | Every guard logs a structured event + raises with `it.id`. |
| Any constraint still unguarded | NONE | corpus-only / level-matches-corpus are correct by construction; `source_book NOT NULL` enforced by the Pydantic model. |
| Regression test reproduces a real mismatch, fails on old code | PASS | `test_vocab_count_mismatch_marks_failed_not_complete` — dup `source_id` collapse, asserts raise + `failed` + 2 rows. |
| Client sends ONLY `{rating, expected_version}` | PASS | `reviewSubmission.ts:18-26`; no `scheduled_days_after`/`*_after`. |
| `expected_version` wired from the due card | PASS | `card.version` (`:24`). |
| Test pins the exact payload | PASS | `reviewSubmission.test.ts:30-36` exhaustive key check. |
| `Review.tsx` delegates + no dead stub | PASS | `:514` `buildReviewSubmission(snapshot, id)`; no interval computed anywhere. |

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **SF-1 — Level-aware terminal proficiency fallback is untested.**
  `load_vocab_2000.py:315-318` chooses `default_proficiency or
  _LEVEL_TO_FALLBACK_PROFICIENCY.get(book_level, "L3")`. The unit test
  `test_vocab_word_missing_proficiency_gets_source_default` (`:131-147`) exercises
  only the **first** operand: the beginner fixture's `default_proficiency: "basic"`
  normalizes fine, so the `or` short-circuits and the level-aware branch never
  runs. The branch the author explicitly added to prevent a *beginner→L3
  mis-tag* (`_LEVEL_TO_FALLBACK_PROFICIENCY`, comment at :46-55) is therefore dead
  under test. Per `SENIOR_ENGINEER_BAR.md §5.2` (test unhappy/boundary paths as
  first-class), add a fixture whose `source.default_proficiency` is absent or
  unnormalizable **and** a word row missing `proficiency`, then assert the row
  lands `basic` for beginner / `L3` for intermediate. Code is correct; coverage is
  the gap.

### NIT
- **N-1 — No structured pre-raise event on the count mismatch.** `load_topik.py`
  logs `count_assertion_mismatch` (expected/actual) *before* raising
  (`load_topik.py:285-289`); `load_vocab_2000.py:181` raises straight to the
  generic `except`'s `loader_failed` log, losing the expected/actual pair as
  discrete fields. kgiu has the same omission, so vocab is consistent with one
  reference but not the other. Low value; the message string carries the numbers.
- **N-2 — `ReviewSubmission.duration_ms?` remains in the type but is never set by
  the builder.** `types/domain.ts:927` still declares optional `duration_ms`.
  Harmless (not scheduling-related, server owns the interval), but a reader
  reconciling "client sends ONLY rating + version" against the interface will
  wonder. Either wire it or drop it in a later pass.

### PRAISE
- **Constraint pre-validation is exemplary and exceeds the reference loaders.**
  Every enum cast and CHECK that OCR drift could trip (`vocab_entry_type`,
  `content_domain`, `korean_required`, `proficiency_required`) is turned into a
  loud, row-scoped `MalformedEntryError` *plus* a structured log carrying the
  `source_id` and the valid set — so an operator triages in seconds instead of
  staring at an opaque batch-level Postgres CHECK failure. This is exactly the
  "fail loud, name the offender" posture `ADR-019 §D10` and the bar ask for.
- **The level-aware proficiency fallback is a genuinely subtle correctness call
  most engineers would get wrong.** A flat `"L3"` default would silently shove
  Beginner words into the intermediate SRS queue; the `beginner→basic /
  intermediate→L3` map (with a documented tie to the extraction guide) is the
  right nuance.
- **The regression test reproduces the actual failure mechanism, not a mock of
  it.** `vocab_mini_dup_ids.json` ships two rows sharing a real `source_id` so the
  live `ON CONFLICT (corpus, source_id)` upsert collapses 3→2 against a
  Testcontainers Postgres, and the test asserts raise **and** `load_state=failed`
  **and** the surviving row count. It would fail on the warn-and-`mark_complete`
  pre-fix code (`pytest.raises` gets no exception). Corpus-scoped assertions keep
  it order-independent under `pytest-randomly` in the module-scoped container.
- **`reviewSubmission.test.ts` pins the contract exhaustively.** The
  `Object.keys(sub).sort()` check means any reintroduced client-side scheduling
  field breaks the build — the strongest possible guard against the stub coming
  back.
- **`Review.tsx` threat-model docstring is thorough and honest** about the
  optimistic-advance / 409 double-tap race and now correctly documents
  server-owned scheduling (`:33-35`).

---

## Detailed findings (file:line)

- `load_vocab_2000.py:181-191` — count assertion raises `CountAssertionError`;
  identical semantics to `load_kgiu.py:164-174` and `load_topik.py:277-294`. ✔
- `load_vocab_2000.py:203-225` — `except` records `failed` under
  `(corpus, source_path)`, guarded so a secondary failure while recording can't
  mask the original; `corpus is None` short-circuits to log+reraise when the
  failure preceded level resolution. Mirrors kgiu. ✔
- `load_vocab_2000.py:268-291` — entry_type + domain enum pre-checks. ✔
- `load_vocab_2000.py:299-308` — korean-required guard; `not it.korean` catches
  `None` and whitespace-collapsed `""` (model uses `str_strip_whitespace=True`,
  `models.py:32`). ✔
- `load_vocab_2000.py:314-318` — proficiency backfill; verified all
  `normalize_proficiency` outputs and both fallbacks (`basic`, `L3`) are members of
  `proficiency_level` (`001_core_schema.up.sql:82` = `{basic, L3, L4, L5+}`). No
  path can emit an off-enum proficiency for a word row. ✔
- `load_vocab_2000.py:176` — count query scopes on `corpus_source_id`, which is
  1:1 with the vocab corpus (one `corpus_sources` row per enum), so it correctly
  counts the whole corpus. (See coordination note on cross-reload drift.) ✔
- `test_load_vocab_2000.py:150-184` — the count-mismatch regression; strong. ✔
- `test_load_vocab_2000.py:131-147` — proficiency-default guard; see SF-1. ◑
- `reviewSubmission.ts:18-26` — payload `{ rating, expected_version: card.version }`
  only. ✔
- `reviewSubmission.test.ts:30-44` — exact-payload + negative field assertions. ✔
- `Review.tsx:514` — delegates to `buildReviewSubmission`; `services/vocab.ts:145-153`
  passes the payload straight through with no injected fields. ✔

---

## Coordination observations

- **Three near-identical `load()` bodies now exist** (`load_vocab_2000`,
  `load_kgiu`, `load_topik`) sharing the same try/except/count-assert/resume
  skeleton verbatim. This batch correctly *mirrors* the reference rather than
  diverging (good — consistency over cleverness), but the trio is now a clear
  candidate for a shared `run_corpus_load(...)` helper in `runtime.py` so the next
  ADR-019 tweak lands in one place instead of three. Out of scope for this fix;
  worth a follow-up ticket.
- **Count-by-`corpus_source_id` will false-positive on a legitimate corpus
  *shrink* across re-loads.** Because the upsert never deletes, if a future
  extraction drops a previously-loaded `source_id`, the stale row inflates the
  count and the assertion fails even though the new file loaded perfectly. This is
  inherited from `load_kgiu.py` (same predicate), not introduced here, and is
  unlikely for a fixed textbook corpus — but if corpora ever become editable it
  needs a reconcile/delete step. Noted for the orchestration owner.
- **N-1's structured-event inconsistency** (topik logs, vocab/kgiu don't) is a
  small opportunity to standardize the count-mismatch telemetry across all three
  loaders when the shared helper above is extracted.
