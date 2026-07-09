# Review: U3b literature loader (`load_literature.py`)

**Reviewer:** independent senior data-engineer pass (no authorship on this code)
**Scope:** loader surface only — `tools/ingest/loaders/load_literature.py`,
`tools/ingest/loaders/models.py` (Literature* models), `tools/ingest/tests/test_load_literature.py`,
`tools/ingest/tests/literature_mini.json`, `tools/ingest/docs/_literature_extraction_guide.md`.
Branch: `feat/u3b-chapter-reader`.

## Summary verdict

**PASS — no blockers.** This is a well-engineered loader that gets every hard invariant
right: `user_id` is structurally impossible to forge from the source JSON (model has no
field for it, resolution is a DB lookup, and a composite FK backstops it at the schema
level); the delete-then-insert replace is genuinely idempotent and runs entirely inside
one transaction, so a failed reload cannot destroy prior good data; and the classic
"status write gets rolled back with the failed transaction" bug is specifically avoided —
the `'failed'` write runs in its own fresh transaction after the load's transaction has
already rolled back, while the `'ready'` write is correctly folded into the same
transaction as the content it certifies. Pre-DB validation mirrors the DB CHECK
constraints exactly and fails loud with row-level context before any write.

The gaps found are all test-completeness SHOULD-FIXes, not correctness bugs: the
idempotency test proves REMOVE and no-op-reload but not ADD or in-place text CHANGE, the
`CountAssertionError` path is unreached by any test (and appears to be genuinely
unreachable dead code given the loader's delete-then-insert design, unlike the vocab
loader's sibling case), and the "empty-passages divider chapter" branch the design docs
explicitly allow is untested.

**Blocker count: 0. Should-fix count: 3. Nit count: 3. Praise count: 7.**

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
1. Idempotency test doesn't cover ADD or in-place CHANGE, only REMOVE + identical reload
   — `tools/ingest/tests/test_load_literature.py:316-384`.
2. `CountAssertionError` path has no test and looks unreachable given delete-then-insert
   (no `ON CONFLICT` to collapse rows) — `load_literature.py:85-96` vs. absence of any
   `pytest.raises(load_literature.CountAssertionError)` in the test file.
3. No test exercises a chapter with an empty `passages` list (the "divider-only chapter"
   case the migration comments and design doc explicitly allow) —
   `load_literature.py:349-350`.

### NIT
1. `_literature_extraction_guide.md`'s validation snippet (`:134-149`) doesn't check for
   the empty-`passages[]` divider-chapter case either.
2. No per-chapter progress log line inside `_replace_chapters` for a large book's
   operator visibility during the (necessarily long, single) transaction — acceptable
   given the documented single-transaction design, just a minor observability gap
   relative to ADR-019 §D7's "batch commit" log line, which doesn't apply here.
3. `LiteratureSourceModel.book_title` (`models.py:397`) is accepted but never persisted
   or cross-checked against `book_uploads.title` — documented as informational-only, so
   a curator typo there is silently lost rather than flagged. Low value to fix given how
   small the field is.

### PRAISE (fix-pass must not undo)
1. `user_id` cannot be forged from JSON at any layer: `LiteratureSourceModel` has no
   `user_id` field at all, so `StrictBase`'s `extra="ignore"` silently drops any injected
   key (`models.py:386-404`); the loader resolves ownership via
   `SELECT user_id ... FROM book_uploads WHERE id = %s` (`load_literature.py:275-303`);
   and the composite FK `fk_reading_chapters_upload_owner` makes a mismatched pair
   structurally impossible to insert (`044_reading_chapters.up.sql:100-103`). The spoof
   scenario is explicitly tested and proven ignored —
   `test_load_literature.py:279-313`.
2. The rollback/status-write interaction — the exact bug class this review was told to
   hunt for — is handled correctly: `'ready'` is written *inside* the same transaction as
   the chapter/passage inserts, so it's atomic with the content it certifies
   (`load_literature.py:156-158`); `'failed'` is written in a **new** connection +
   transaction *after* the load's transaction has already rolled back
   (`load_literature.py:180-188`), so the failure status reliably survives a content
   rollback instead of being reverted with it. Verified by
   `test_literature_loader_flips_upload_status_to_ready` and
   `test_literature_loader_rejects_non_literature_upload`'s `status == "failed"`
   assertion (`test_load_literature.py:263-276`, `:408-436`).
3. Delete-then-insert runs entirely inside one transaction
   (`load_literature.py:132-158`, `_replace_chapters` at `:306-362`), so a failure
   anywhere in the insert phase rolls back the `DELETE` too — the prior good book content
   is untouched on a failed reload, not just the point in time before the delete.
4. `_resolve_owner`'s `SELECT ... FOR UPDATE` (`load_literature.py:285-289`) both guards
   the ownership lookup against a concurrent delete of the upload and serializes any two
   concurrent reload attempts on the same book, since both must acquire the same row lock
   before touching `reading_chapters`.
5. `_validate_document` (`load_literature.py:192-272`) mirrors every relevant DB
   CHECK/UNIQUE constraint by name (`ck_reading_chapters_number_positive`,
   `uq_reading_chapters_upload_number`, `ck_reading_chapters_title_len`,
   `ck_reading_chapters_start_page_positive`/`end_page`, `ck_reading_chapters_page_span`,
   `ck_reading_passages_number_positive`, `uq_reading_passages_chapter_number`,
   `ck_reading_passages_body_len`, `ck_reading_passages_page_number_positive`) and runs
   *before* any DB connection is opened, giving an operator a message naming the
   offending chapter/passage instead of an opaque Postgres constraint violation. Directly
   mirrors `load_vocab_2000._insert_item_batch`'s pre-check pattern.
6. Deliberate, well-documented, and *verified correct* exclusion from
   `load_to_postgres.py`'s `ALL_CORPORA` dispatch (`load_literature.py:402-413`) —
   confirmed by grep that `load_literature` never appears in `ALL_CORPORA` or the
   dispatch table in `tools/ingest/load_to_postgres.py`. A deliberate architecture call
   (literature has no `corpus` enum concept), not an oversight the reviewer had to catch.
7. `--dry-run` (`load_literature.py:440-456`) needs no DB connection at all, matching the
   extraction guide's documented curator workflow (`_literature_extraction_guide.md:151-156`)
   of validating a freshly-OCR'd JSON before any Postgres access is configured.

## Detailed findings

### 1. `user_id` invariant — CONFIRMED SAFE
- `models.py:386-404` (`LiteratureSourceModel`): no `user_id` field anywhere in the
  Literature* models. `StrictBase` (`models.py:29-32`) sets `extra="ignore"`, so a
  `user_id` key injected into the JSON's `source` object is parsed and thrown away, never
  reaching the loader.
- `load_literature.py:275-303` (`_resolve_owner`): the *only* place `user_id` is
  determined — a `SELECT user_id, type::text FROM book_uploads WHERE id = %s FOR UPDATE`
  keyed on `source_upload_id`. Also enforces `type = 'literature'`
  (`:296-302`), raising `SourceUploadNotFoundError` for a missing row or a
  vocab/grammar/dialogue/both upload.
- `044_reading_chapters.up.sql:97-103`: composite FK
  `(source_upload_id, user_id) REFERENCES book_uploads(id, user_id)` is the DB-level
  backstop — even a hypothetical future bug in `_resolve_owner` couldn't insert a
  mismatched pair.
- Test proof: `test_load_literature.py:279-313` seeds two users, sets
  `doc["source"]["user_id"] = other_id` (an attempted spoof the Pydantic model doesn't
  even expose), loads, and asserts `result["user_id"] == owner_id` and the persisted
  `reading_chapters.user_id` is exactly `[(owner_id,)]`.
- Concurrency: `FOR UPDATE` at `load_literature.py:287` locks the `book_uploads` row for
  the duration of the load's transaction, so a concurrent `DELETE FROM book_uploads` (or
  a second concurrent reload of the same book) blocks/serializes rather than racing the
  chapter insert underneath.

### 2. Idempotency — CONFIRMED SAFE, test coverage incomplete
- `_replace_chapters` (`load_literature.py:306-362`): `DELETE FROM reading_chapters
  WHERE source_upload_id = %s` (cascades to `reading_passages` via
  `fk_reading_passages_chapter`), then re-`INSERT`s every chapter/passage from the
  source document. No `ON CONFLICT`; the JSON document is the sole source of truth for
  what should exist, so anything dropped from the JSON is dropped from the DB.
- Entire replace runs inside the single transaction opened at
  `load_literature.py:132-133` (`async with pool.connection() as conn: async with
  conn.transaction():`), so it's atomic with the owner lookup and the final status write.
- Test `test_literature_loader_idempotent_reload_replaces_cleanly`
  (`test_load_literature.py:316-384`) proves:
  - Identical reload converges (2 chapters / 3 passages both times) — no duplication.
  - A reload with a *smaller* document (drop chapter 2, trim chapter 1 to 1 passage)
    leaves exactly 1 chapter / 1 passage — old chapter 2's row count explicitly checked
    at `:364-369` to be `0`, proving no stale rows survive a shrink.
  - **Gap:** no case starts small and reloads *larger* (ADD a chapter/passage that wasn't
    there before), and no case keeps the same `chapter_number`/`passage_number` but
    changes the `body` text and asserts the stored text actually changed. Both are listed
    verbatim in the review's evaluation criteria. Given the delete-then-insert
    architecture (not an upsert), these cases are very likely to pass, but they are
    currently *asserted by design reasoning*, not exercised by a test — worth adding
    for a future refactor's regression safety.

### 3. Transaction safety — CONFIRMED SAFE, this is the standout finding
- Single transaction for the whole load: `load_literature.py:132-158`. Owner resolution,
  delete+insert, the count assertion, and the `'ready'` status write are all inside it.
- On any exception, `load_literature.py:172-189`: the `except` block is *outside* that
  transaction (which has already rolled back by the time Python reaches the `except`,
  per `async with conn.transaction()` semantics), and opens a **brand-new**
  `pool.connection()` / `conn.transaction()` to write `status = 'failed'`
  (`:181-186`, delegating to `_mark_upload_status` at `:390-399`). This means:
  - The `'ready'` write is atomic *with* the content — you never observe `ready` with
    stale or partial chapters, because it's the last statement before commit
    (`:156-158`).
  - The `'failed'` write survives independently of the rollback that produced it — this
    is exactly the "status write reverted by rollback" bug class the review was told to
    watch for, and it is *not present here*.
  - Verified by test: `test_literature_loader_rejects_non_literature_upload`
    (`test_load_literature.py:408-436`) loads onto a `type='vocab'` upload, asserts
    `SourceUploadNotFoundError` is raised, asserts zero `reading_chapters` rows were
    written, *and* asserts `book_uploads.status == 'failed'` — proving the failure
    transaction committed independently of the (rolled back) main transaction.
  - Secondary-failure guard: the `except`'s own `_mark_upload_status` call is wrapped in
    its own `try/except` (`:181-188`) so a failure while *recording* the failure (e.g.
    the upload row vanished mid-run) logs but doesn't mask the original error via
    `raise` outside the inner guard.
- One asymmetry worth noting but not a defect: if `source_upload_id` never resolves (bad
  JSON, failed Pydantic parse — `source_upload_id` stays `None`,
  `load_literature.py:112`), the `except` block skips the status write entirely
  (`:180`, `if source_upload_id is not None:`) because there is no upload id to write
  under. This mirrors `load_vocab_2000`'s `corpus is None` sentinel pattern exactly
  (`load_vocab_2000.py:82-90, 229`) and is the correct behavior, not a gap.

### 4. Validation — CONFIRMED SAFE
- `_validate_document` (`load_literature.py:192-272`) runs immediately after
  `LiteratureDocumentModel.model_validate_json` and *before* `pool.connection()` is ever
  called (`:124` vs. `:132`) — a malformed document never touches the DB.
- Checks, one-to-one against the migration's constraints: chapter number > 0 and unique
  per document (`:199-211`), title length 1..500 (`:213-218`), page positivity and span
  ordering (`:219-240`), passage number > 0 and unique per chapter (`:244-257`), body
  length 1..20000 (`:259-265`), page_number positivity (`:266-272`). Every message names
  the offending chapter/passage number and cites the CHECK/UNIQUE constraint name.
- `StrictBase.str_strip_whitespace=True` (`models.py:32`) strips a whitespace-only
  `body`/`title` down to `""` before `_validate_document` sees it, so a
  whitespace-only body correctly fails the `1 <= body_len` floor rather than silently
  passing an effectively-empty passage into the DB.
- Test `test_literature_loader_rejects_duplicate_chapter_number`
  (`test_load_literature.py:439-464`) proves the duplicate-chapter-number path fails
  loud with a message containing `"chapter_number"` and `"duplicated"`, and that zero
  rows are written — the pre-check genuinely runs before any write, not just before
  commit.

### 5. Models — CONFIRMED SAFE
- `LiteratureSourceModel.source_upload_id: int` (`models.py:394`) is required (no
  default), matching `reading_chapters.source_upload_id NOT NULL`
  (`044_reading_chapters.up.sql:78`).
- All Literature* models use `StrictBase` (`extra="ignore"`, `models.py:29-32`), same
  tolerant-boundary design as every other model family in the file (documented rationale
  at `models.py:8-12`: Claude-vision OCR output is imperfect). This is a deliberate,
  consistent design choice across the codebase, not an oversight — flagged here only so
  a future reviewer doesn't mistake it for "should be strict."
- Field types line up with the DB columns: `chapter_number: int`, `title: str | None`,
  `start_page`/`end_page: int | None`, `passage_number: int`, `body: str` (required —
  Pydantic itself rejects a `null` body before `_validate_document` even runs),
  `page_number: int | None`.

### 6. Test completeness
- Mirrors `test_load_vocab_2000.py`'s structure closely: same `PostgresContainer`
  module-scoped fixture, same `_apply_migrations` glob-and-run pattern, same
  connect-per-helper style (`_count`/`_scalar`/`_rows`), same `LoaderConfig` +
  `AsyncConnectionPool` direct-construction pattern in `_load`/`_load` helpers. Will run
  the same way in CI testcontainers as the sibling suite — confirmed no divergent
  fixture/connection wiring that would only work locally.
- Covers, and covers well: correct row counts (`:176-213`), exact ordering + verbatim
  Korean text preservation including no-mojibake, no-truncation (`:216-260`), status flip
  to `ready` (`:263-276`), the user_id-spoof-is-ignored invariant (`:279-313`), missing
  upload rejection (`:387-405`), wrong-type upload rejection incl. `status == 'failed'`
  (`:408-436`), duplicate chapter_number pre-DB rejection (`:439-464`).
- Gaps (restated from Should-Fix): idempotent-reload-ADDS case, idempotent-reload
  in-place-body-CHANGE case, `CountAssertionError` reachability, empty-`passages[]`
  divider chapter.

### 7. Logging/observability — CONSISTENT with sibling + ADR-019, with one documented departure
- `structlog.get_logger(__name__)` bound with `source_path`/`source_upload_id`/`sha256`
  context (`load_literature.py:107, 118-122`), same pattern as
  `load_vocab_2000.py:79-80, 100`.
- Logs `literature_load_start` (`:128-130`), `literature_load_complete` (`:160-164`),
  `loader_failed` (`:173`), `failed_to_record_failure` (`:188`) — covers ADR-019 §D7's
  "loader start" / "loader complete" / error logging bullets.
- No "batch commit" log line, because this loader is deliberately NOT batch-oriented
  (ADR-019 §D5 batching doesn't apply — the module docstring at `load_literature.py:10-24`
  explicitly explains why the whole load is one transaction rather than
  checkpoint/resume via `load_state`). This is a documented, reasoned departure from
  ADR-019's batching model, not an unexplained gap — the ADR itself is scoped to the 8
  corpus-family loaders it enumerates (ADR-019 §Context) and literature is architecturally
  different (one book per invocation, addressed by `source_upload_id`, not a `corpus`
  enum value).

## Coordination observations

- The design doc (`U3_READER_DESIGN.md:92-97`) explicitly defers real literature content
  + confirms "no throwaway fixture" for the schema/routes/UI phases, but separately
  expects `load_literature.py` to exist and be "mirroring `load_vocab_2000.py`" with
  "automated tests still cover[ing] the routes/loaders with inline test data
  (CI/testcontainers), as U2 did" — this loader and its test suite satisfy that bar; the
  `literature_mini.json` fixture (2 chapters, 3 passages) is exactly the kind of small
  inline CI fixture the design doc calls for, not a "real corpus" substitute, and its
  header note (`literature_mini.json:7`) correctly flags itself as a fixture whose
  `source_upload_id` is a placeholder overwritten by every test.
- `load_literature.py`'s deliberate non-participation in `load_to_postgres.py`'s
  `ALL_CORPORA` dispatch (module docstring `:402-413`) is consistent with there being no
  `literature` value in the `corpus` Postgres enum anywhere in the migrations tree
  (grepped; none) — this is architecturally coherent, not a coordination gap.
- ADR-019 (`ADR-019-loader-orchestration.md`) predates this loader (dated 2026-05-28,
  scoped to 8 named corpus files) and does not mention literature/U3b at all — the
  module docstring's justification for departing from checkpoint/resume is
  self-contained and sound, but ADR-019 itself has not been amended with an addendum
  noting the literature-family exception. Not a defect in the loader; worth a one-line
  ADR-019 addendum for a future reader who greps ADR-019 expecting it to cover every
  loader in the tree.
