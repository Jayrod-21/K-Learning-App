# Review — F-UP-009 / B-012 durable loader fixes (commit 6e80f5f)

Reviewer: independent read-only pass. Scope: `git show HEAD` on
`fix/loader-durable-fixes` — `tools/ingest/parse_ttmik.py`,
`tools/ingest/loaders/load_vocab_2000.py`, and their two new test files.

## Verdict

**REJECT — 1 BLOCKER.** The `parse_ttmik` lesson-merge half of this commit
(F-UP-009) is correct, idempotent, and well-tested — approve as-is. The
`load_vocab_2000` empty-row filter (B-012) is built on a false premise: the
"empty" rows it drops are not OCR artifacts, they are the intentional
`theme_intro`/`subsection_intro`/`reference` navigational row shape (confirmed
against both real corpus files and the schema's own DDL comment), and —
reproduced directly below — re-running this loader against a database that
already has those rows loaded (the documented state of the live vocab_2000
corpora as of the retriage one day before this commit) makes **every future
re-ingest of `vocab_2000_beginner`/`vocab_2000_intermediate` raise
`CountAssertionError` and mark the source `failed`**, misdiagnosed as
"duplicate source_ids or a dropped batch." This is the exact opposite of
"durable" — it converts a currently-working idempotent re-ingest into a
permanent hard failure, and it does so without ever deleting the rows it
claims to be cleaning up.

## Findings

### BLOCKER

1. **The B-012 empty-row filter is not idempotent against the loader's own
   real data — it breaks every re-ingest of an already-loaded vocab_2000
   corpus.** `tools/ingest/loaders/load_vocab_2000.py:101-107`. Reproduced
   live (see "Reproduction" below): seed a test DB with the loader's existing
   invariant — 4 word rows + 2 non-word navigational rows under one
   `corpus_source_id` (exactly what `vocab_2000_beginner`/`_intermediate`
   look like today per `db/docs/BUG_RETRIAGE_2026-07-05.md`, which recorded
   the live counts 1706/1696 as a **100% exact match** to
   `tools/ingest/output/vocab_2000_{beginner,intermediate}.json`'s total item
   counts, i.e. navigational rows included and already loaded) — then force a
   re-ingest under the new code. Result: `CountAssertionError: expected 4
   rows, loaded 6`, load marked `failed`. Root cause: `corpus_sources` is
   upserted `ON CONFLICT (corpus) DO UPDATE` (`loaders/runtime.py:232`), so
   `corpus_source_id` is the same value forever; the loader never deletes
   rows; and the post-load assertion at `load_vocab_2000.py:198` compares the
   *loadable* count (`total_items`, now excluding non-word rows) against the
   *cumulative, all-time* physical row count for that `corpus_source_id`
   (`SELECT COUNT(*) ... WHERE corpus_source_id = %s`). Any non-word row ever
   loaded under the old (pre-fix) code — which is every real vocab_2000 file
   ingested to date — is still sitting in the table and now permanently
   inflates `actual` past the new, smaller `total_items`. The commit's own
   stated goal ("so a re-ingest won't reintroduce them") is not met for any
   database this loader has ever touched; it is only true for a from-empty
   first-time ingest. No migration/backfill/cleanup step accompanies this
   change to remove the legacy rows it now refuses to count.

2. **The rows being dropped are not OCR artifacts — they are the schema's
   documented, intentional navigational row shape**, so even setting aside
   finding #1, the filter's premise is wrong. `load_vocab_2000.py:91-95`
   ("These are OCR artifacts — blank lines the parser emitted as contentless
   non-`word` entries"). Checked against the actual bundled corpus:
   `tools/ingest/output/vocab_2000_beginner.json` has 1706 items — 1598
   `word` + 108 non-`word` (16 `theme_intro` + 73 `subsection_intro` + 19
   `reference`); `vocab_2000_intermediate.json` has 1696 — 1590 `word` + 106
   non-`word` (15+69+22). **100% of the non-`word` rows in both real files
   have `korean=null` and `english=null`** — not a subset, all of them —
   because their real content lives in `theme`/`subsection`/`hanja`/`notes`
   instead (e.g. `{"type": "reference", "theme": "01 사람 / People",
   "subsection": "Korean through Chinese Characters: 親", "hanja": "親",
   "notes": "Hanja 親 (친) means..."}`). This is exactly the schema's own
   documented design: `db/migrations/002_darakwon_corpora.up.sql:531-536`
   states outright that `proficiency` is nullable specifically *because*
   "navigational rows (theme_intro, subsection_intro, reference) don't carry
   one in the source JSON... this row has no proficiency, it's a divider."
   108+106 = **214** — the exact figure the commit message cites as "empty
   rows found + deleted live." That match is strong circumstantial evidence
   the earlier live "fix" and this loader change are both built on
   mis-classifying the entire navigational-row category as garbage, not on
   finding genuinely-blank OCR artifacts within it.
   - Mitigating factor found in-code: none of these row types are currently
     read by the app. Every `vocab_entries` query that matters is scoped
     `WHERE entry_type = 'word'` (`server/src/routes/vocab.ts:100,458,777`),
     and the two ID-based lookups (`/entries/:entryId`, `/bank`) are only
     ever reached with an id the client got from that word-only list. So
     *today* nothing user-facing breaks if these rows vanish. But that
     doesn't make them artifacts — it makes them currently-unused reference
     data — and finding #1 shows the code doesn't even succeed at removing
     them; it just breaks the loader on top of misclassifying them.

   **Fix direction for both findings:** either (a) don't drop
   `theme_intro`/`subsection_intro`/`reference` rows at all — if the actual
   bug is some *other*, narrower set of true blank-line artifacts, identify
   them by a tighter predicate than "any non-word row lacking korean+english"
   (e.g. a genuinely-empty `theme`/`subsection`/`notes` too), or (b) if the
   intent really is to stop loading these three types going forward, filter
   on `type not in {"theme_intro","subsection_intro","reference"}` (explicit
   and honest about what's being excluded, not a magic-shaped byproduct
   check) *and* ship an accompanying one-time cleanup (migration or
   documented runbook step) that deletes the legacy rows already resident
   under each corpus's stable `corpus_source_id`, so `total_items` and the
   live table agree again.

### SHOULD-FIX

3. **Test suite never exercises the loader against a DB that already has
   pre-existing rows outside the new filter's keep-set** — the exact gap
   that let finding #1 through. `tests/test_load_vocab_2000.py`'s new
   `test_vocab_loader_skips_completely_empty_rows` only proves empties are
   excluded from a *fresh* load; the existing
   `test_vocab_loader_idempotent_on_rerun`
   (`tests/test_load_vocab_2000_properties.py:144-171`) only re-runs with an
   *unchanged sha*, which short-circuits on the `skip_complete` fast path
   (`load_vocab_2000.py:124-126`) before ever reaching the count assertion —
   it never forces a real second pass. Per the project's own standing rule
   ("test with REAL corpus data, distrust schemas looser than the DB
   constraint behind them"), this is precisely the class of test that should
   have run the two real `tools/ingest/output/vocab_2000_*.json` files (or a
   fixture shaped like them, with `theme_intro`/`subsection_intro`/
   `reference` rows) through the loader twice with `force=True`, which would
   have caught this immediately.

4. **`corpus_sources.item_count` now silently understates the true item
   count of the source file** once/if the crash in finding #1 is fixed some
   other way — `total_items` (loadable count) is threaded into
   `upsert_corpus_source(..., item_count=total_items, ...)` at
   `load_vocab_2000.py:146`, so `item_count` no longer means "how many items
   are in the source JSON," it means "how many are word rows." Not a
   blocker on its own (it's an internal bookkeeping field, not
   constraint-checked), but worth an explicit naming/comment call-out so a
   future reader doesn't reconcile `corpus_sources.item_count` against
   `len(doc.items)` and see a permanent, unexplained gap of 108-106 rows.

### NIT

5. Full ingest suite run in this review showed `330 passed, 1 failed, 4
   skipped` (commit message claims "325 green"). The one failure —
   `tests/test_resolve_cross_references_integration.py::test_prerequisite_error_when_corpus_not_loaded`
   (`UndefinedObject: constraint "uq_topik_tests_number_section" ... does not
   exist`, a migration-ordering issue in migration 029 vs 005) — is in a file
   untouched by this diff and unrelated to either fix; flagged for
   awareness, not attributable to this commit.

### PRAISE

6. **`_merge_units_by_lesson` (parse_ttmik.py:205-234) is correct, safely
   idempotent, and appropriately tested.** Verified independently:
   - Order-preserving: Python dict insertion order means the merged list
     comes out in first-seen `(level, lesson)` order, and a merged lesson's
     sentences are `existing.sentences.extend(u.sentences)` — first block's
     sentences first, later block's appended — matching the docstring's
     "first-seen order" claim exactly.
   - Re-sequencing to `1..N` per lesson is applied *after* all extends
     complete, so ordinals are always unique per lesson post-merge — proven
     by the test's own `len(ords) == len(set(ords))` assertion
     (`tests/test_parse_ttmik.py:57-60`).
   - Confirmed harmless downstream: `_lesson_source_id()`
     (`loaders/load_ttmik.py:39-41`) derives the lesson's natural key purely
     from `(level, lesson)`, so both pre-merge Units *would* resolve to the
     same `ttmik_lessons` row regardless — the merge is what stops their
     sentences from colliding on ordinal (content_hash differs, so the
     `ON CONFLICT (lesson_id, content_hash) DO UPDATE ... SET ordinal =
     EXCLUDED.ordinal` upsert, `load_ttmik.py:246-247`, would otherwise
     silently let the second block's sentences overwrite the ordinals the
     first block already claimed).
   - Confirmed harmless that the discarded (second) unit's own `.ordinal`
     value is dropped, leaving a gap in the overall `ttmik_lessons.ordinal`
     sequence: the column has only `CHECK (ordinal >= 1)`
     (`db/migrations/005_lesson_podcast_topik.up.sql:91`), no uniqueness or
     contiguity constraint (uniqueness is on `(corpus, source_id)` and
     `(lesson_level, lesson_number)` instead, `:85-86`), and every
     consumer — `server/src/routes/ttmik.ts:201,208,293` — only ever does
     `ORDER BY ordinal`, never arithmetic on it. A sparse sequence sorts
     identically to a dense one.
   - Idempotent end-to-end: `parse()` is a pure function of the PDF's
     extracted text (no randomness, no external mutable state besides the
     static lesson-titles JSON), so re-running the full pipeline on the same
     PDF reproduces byte-identical Units and ordinals every time; combined
     with the sentence upsert's content-hash key, a full re-ingest is safe.
   - `test_merge_is_noop_for_already_unique_lessons` is an adequate normal-
     case regression guard: it asserts both unit-list order/identity and
     per-lesson ordinal/content preservation when no merge is needed.

7. The `word` row missing only its `korean` headword is correctly **not**
   filtered by the new `it.korean or it.english` check (its `english` is
   still set) and still reaches the pre-existing fail-loud guard —
   independently traced: `load_vocab_2000.py:101` keeps it →
   `_insert_item_batch` (`load_vocab_2000.py:316-325`) raises
   `MalformedEntryError` when `entry_type == "word" and not it.korean`.
   Verified this is unreachable-by-the-filter for any row with a non-empty
   `english`, so the "still fails loud" claim in the commit message holds.

8. `str_strip_whitespace=True` on `StrictBase` (`loaders/models.py:32`)
   correctly collapses `None`, `""`, and whitespace-only strings to the same
   falsy value before the filter runs, so all three shapes are handled
   uniformly — confirmed by reading the model config and by the appended
   test fixture rows (one blank-string pair, one omitted/`None` pair) both
   being dropped in `ruff`+`mypy`+pytest run (8/8 passed, see Detailed).

## Detailed

### Reproduction — B-012 CountAssertionError on re-ingest (BLOCKER #1)

Ran in a disposable `python:3.12-slim` container against a fresh
`postgres:16-alpine` testcontainer with all 74 migrations applied:

1. Seeded `corpus_sources` (upserted on `corpus`, per
   `loaders/runtime.py:204-232`) and 2 `vocab_entries` rows —
   `theme_intro`/`subsection_intro`, `korean=NULL`, `english=NULL` — under
   that `corpus_source_id`, alongside `load_state` marked `complete`
   (simulating a DB that already ran an ingest before this commit, matching
   the retriaged live-DB shape).
2. Called `load_vocab_2000.load(pool, FIXTURE, cfg)` with `force=True`
   against the 4-word-row `tests/fixtures/vocab_mini_beginner.json` fixture
   (the repo's own test fixture — no synthetic data of my own).
3. Output:
   ```
   rows present before re-ingest: 2
   {"error": "vocab-2000 vocab_2000_beginner vocab_mini_beginner.json:
     expected 4 rows, loaded 6 (duplicate source_ids or a dropped batch?)",
     "event": "loader_failed", ...}
   RAISED: CountAssertionError ...
   final load_state: ('failed', "CountAssertionError(...)")
   ```
   `total_items` (loadable, word-only) = 4; `actual` (all rows under
   `corpus_source_id`, including the 2 pre-existing navigational rows never
   touched by this run) = 6. Mismatch → fail loud, recorded `failed`. The
   error message is also actively misleading (points at "duplicate
   source_ids or a dropped batch," neither of which occurred).

### Real-corpus check (BLOCKER #2)

```
vocab_2000_beginner.json     total 1706 — word 1598, theme_intro 16,
                              subsection_intro 73, reference 19
vocab_2000_intermediate.json total 1696 — word 1590, theme_intro 15,
                              subsection_intro 69, reference 22
```
Every non-`word` row in both files has `korean=null` and `english=null` —
0 exceptions. `db/docs/BUG_RETRIAGE_2026-07-05.md` (dated the day before
this commit) recorded live DB counts of exactly 1706/1696 — a **100% match**
to these totals — and concluded there was "no loader/DB gap." That doc does
not mention 214 blank rows needing deletion; B-012 as filed in
`BUGS_AND_FEATURES.md:70,220` is about suspected *word*-count shortfall
(3,188 vs a nominal ~4,000), not about navigational-row cleanup. Whatever
live fix motivated this commit's "214 rows deleted" framing was not
reconciled against the project's own most recent B-012 retriage.

### Tooling

`ruff check` — all checks passed. `mypy` — no issues (2 files). Targeted
`pytest tests/test_parse_ttmik.py tests/test_load_vocab_2000.py -q` — 8
passed (2 `parse_ttmik` + 6 `load_vocab_2000`, matching the commit message).
Full `pytest tests/ -q` — 330 passed, 1 failed (unrelated, see NIT #5),
4 skipped, in 84.7s.

### Files/lines referenced
- `tools/ingest/loaders/load_vocab_2000.py:91-107, 146, 198-208, 316-325`
- `tools/ingest/loaders/runtime.py:204-232` (`upsert_corpus_source`)
- `tools/ingest/loaders/models.py:32, 291-317` (`StrictBase`, `VocabItemModel`)
- `tools/ingest/parse_ttmik.py:205-234, 237-271`
- `tools/ingest/loaders/load_ttmik.py:39-41, 133-153, 221-256`
- `db/migrations/002_darakwon_corpora.up.sql:174-199 (corpus_sources),
  486-537 (vocab_entries)`
- `db/migrations/005_lesson_podcast_topik.up.sql:60-193 (ttmik_lessons,
  ttmik_sentences)`
- `server/src/routes/vocab.ts:100,458,777` / `server/src/routes/ttmik.ts:201,208,293`
- `tools/ingest/output/vocab_2000_beginner.json`,
  `tools/ingest/output/vocab_2000_intermediate.json` (real corpus data used
  for the checks above)
- `db/docs/BUG_RETRIAGE_2026-07-05.md:20,36`, `BUGS_AND_FEATURES.md:70,220`
- `tools/ingest/tests/test_parse_ttmik.py` (full file, adequate)
- `tools/ingest/tests/test_load_vocab_2000.py:118-165`,
  `tools/ingest/tests/test_load_vocab_2000_properties.py:144-171`
