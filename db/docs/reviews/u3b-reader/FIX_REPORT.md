# U3b Chapter Reader — Fix-Pass Report

Branch: `feat/u3b-chapter-reader`. Scope: every BLOCKER + SHOULD-FIX across the
four independent reviews below. NITs fixed only where trivial in a file
already being edited for another reason. No PRAISE items were undone.

Source reviews:
- `db/migrations/REVIEW_u3b_schema.md`
- `server/src/routes/REVIEW_u3b_server.md`
- `client/src/pages/REVIEW_u3b_client.md`
- `tools/ingest/REVIEW_u3b_loader.md`

## Schema (`db/migrations/REVIEW_u3b_schema.md`)

| Finding | Severity | Disposition | Notes |
|---|---|---|---|
| SF-1 — `ADD CONSTRAINT uq_book_uploads_id_user` has no re-apply guard | SHOULD-FIX | **FIXED** | Wrapped in the `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...) THEN ... END IF; END $$;` idiom, matching `002_darakwon_corpora.up.sql:950-960`'s guard for `fk_vocab_cards_vocab_entry`. Re-validated: applying `044.up.sql` twice in the same rolled-back transaction now succeeds (previously errored on the 2nd `ADD CONSTRAINT`). No transaction-control statements added — the `DO $$ BEGIN...END $$` is PL/pgSQL block syntax, not a `BEGIN`/`COMMIT`, so ADR-013 compliance is unaffected (mirrors 002's own use of the same idiom). |
| SF-2 — Migration 044 missing from `README.md`'s migration table | SHOULD-FIX | **FIXED** | Added the `044 \| reading_chapters \| U3b \| ...` row. Per the task's explicit instruction, did **not** backfill 040/042/043's missing rows — that's flagged as a separate pre-existing gap the reviewer's own "Coordination observations" section recommends as a follow-up sweep, not part of this fix-pass's scope. |
| SF-3 — No schema-level guard that `source_upload_id` points at a `'literature'`-typed upload | SHOULD-FIX | **FIXED** | Reviewer's own suggested resolution ("a one-line `COMMENT ON CONSTRAINT` ... flagging that the invariant is enforced by the loader/route layer, not the DB") implemented verbatim: added `COMMENT ON CONSTRAINT fk_reading_chapters_upload_owner ON reading_chapters IS ...` documenting that the FK does not constrain `book_uploads.type` and that the invariant is enforced by construction in `load_literature.py` + the `/reading` routes. No trigger added (reviewer explicitly called a cross-table trigger not worth the maintenance cost). |
| N-1 — no `COMMENT ON COLUMN` for `reading_chapters.source_upload_id` | NIT | **FIXED** | Trivial, same file already being edited for SF-1/SF-3. Added, porting the "why NOT NULL + CASCADE" rationale from the file header. |
| N-2 — no `COMMENT ON COLUMN` for `reading_chapters.end_page` | NIT | **FIXED** | Trivial, same file. Added, symmetric with `start_page`'s existing comment. |
| N-3 — no `COMMENT ON COLUMN` for `reading_passages.page_number` | NIT | **FIXED** | Trivial, same file. Added, cross-referencing the `start_page`/`end_page` advisory-pointer rationale. |
| N-4 — `CASCADE` destroys curated OCR text with no soft-delete/confirmation gate | NIT | **DEFERRED** | Reviewer explicitly frames this as "not a schema defect... a product-risk note for whoever builds the `DELETE /uploads/:id` route in U3b/U3c" — no such route exists yet in this branch's scope. Nothing to fix here without inventing a route. |
| Coordination note — sweep 029/038 for the same `ADD CONSTRAINT` guard gap | (observation) | **DEFERRED** | Reviewer frames this as "worth a follow-up ticket," not a 044-scoped defect. Out of this fix-pass's blast radius per the task brief. |

## Server (`server/src/routes/REVIEW_u3b_server.md`)

| Finding | Severity | Disposition | Notes |
|---|---|---|---|
| `reading.ts:20-26` header comment self-contradictory ("empty chapter list" vs "additionally 404s") | SHOULD-FIX | **FIXED** | Reworded so the header states only the actual/tested behavior: the chapter-list route 404s a not-owned/missing upload before ever running the chapters query; an owned upload with zero chapters 200s with `{ chapters: [] }`. Removed the sentence that described the untested/superseded "empty list for another user's upload" behavior. |
| NIT 1 — list route doesn't gate on `book_uploads.type = 'literature'` | NIT | **DEFERRED** | Reviewer: "Harmless today ... worth a thought if a future loader bug ever attaches chapters to the wrong upload type" — not a defect, and adding the gate would change the query/response contract, which is out of a NIT's trivial-fix bar. |
| NIT 2 — redundant `user_id` filter on the list route's chapters query is untested in isolation | NIT | **DEFERRED** | Reviewer: "Not a security gap ... just noting for completeness." Contriving a test to catch removal of a defense-in-depth line that's already covered end-to-end by the IDOR tests isn't a root-cause fix. |
| PRAISE 1-3 (IDOR passage-query trust chain, uniform-404 tests, nginx allow-list) | PRAISE | **PRESERVED** | Not touched. |

## Client (`client/src/pages/REVIEW_u3b_client.md`)

| Finding | Severity | Disposition | Notes |
|---|---|---|---|
| BLOCKER — `ChapterReader.handleAdd` calls `mineWord(...)` with no `AbortSignal` | BLOCKER | **FIXED** | Added a dedicated `addCtrlRef` (`Reading.tsx`), mirroring `Ttmik.tsx`'s `DetailView.inFlightCtrlRef` since `useTapWord` deliberately doesn't expose its internal controller. `handleAdd` now creates a fresh `AbortController` per add and passes `ctrl.signal` to `mineWord`; a new `handleClose` wrapper aborts it (and clears the ref) before delegating to `useTapWord`'s `onClose`, and is now what's wired into `WordPopover`'s `onClose` prop. An unmount effect also aborts it. Module header's parity claim with `Ttmik.tsx`'s contract is now accurate (previously false as written) and was reworded to spell out the abort wiring explicitly. |
| SHOULD-FIX 1 — no test for the abort/rollback race | SHOULD-FIX | **FIXED** | Added `'closing the popover aborts an in-flight "Add to bank" request (BLOCKER regression)'` in `Reading.test.tsx`. Verified by temporarily reverting the fix locally and re-running: the test fails against the pre-fix code with the expected diff (`mineWord` called with 1 arg instead of `(payload, AbortSignal)`), then re-confirmed green after restoring the fix — genuine regression coverage, not a vacuous assertion. |
| SHOULD-FIX 2 — `ChapterReader` (level 3) has zero test coverage | SHOULD-FIX | **FIXED** | Added 4 tests under a new `describe('Reading — chapter reader (tap-to-define)')`: (1) passages render ordered + tappable + newline-preserving (`<br/>` present, defensive `passageNumber` sort verified against out-of-order wire data), (2) empty-`passages: []` chapter shows "No passages yet for this chapter.", (3) tapping a word runs `lemmatize→defineEntry→enrich` and opens `WordPopover` with the resolved gloss, (4) the abort regression test above. `services/lemmatize`, `services/define`, `services/enrich`, `services/vocab` are now mocked the same way `Ttmik.test.tsx`/`Images.test.tsx` mock them. |
| SHOULD-FIX 3 — `BookPicker`/`ChapterPicker` fetch-error states untested | SHOULD-FIX | **FIXED** | Added `describe('Reading — fetch error states')` with 2 tests: book-list fetch rejection → `ErrorCard` (role=alert) with fixed copy (asserts the server's message text does NOT leak through) → Retry recovers; chapter-list fetch rejection → same pattern, scoped to the chapter picker. |
| NIT 1 — `PassageBody` splits on `'\n'` only, leaves a trailing `\r` on Windows-line-ended OCR text | NIT | **FIXED** | Trivial, same file already being edited for the BLOCKER. `body.replace(/\r\n/g, '\n').split('\n')` before the line-split. |
| NIT 2 — duplicated mine-payload construction between `Reading.tsx` and `Ttmik.tsx` | NIT | **DEFERRED** | Reviewer explicitly defers this to the U3c tap-handler dedup follow-up (already noted in both files' headers) — folding it in now would expand this fix-pass beyond the reviewed surface. |
| NIT 3 — "View original scan" button not gated on chapter-list load state | NIT | **DEFERRED** | Reviewer: "Not a bug ... just a minor inconsistency." Fixing it means restructuring `ChapterPicker`'s render branches (not a one-line change) for a cosmetic-only, non-functional gap — outside the "trivial in a file already being edited" bar. |
| PRAISE 1-4 (`isMinedRef` effect-write, `PassageBody`'s `\n`-split-then-`<br/>`, GET-fetch abort discipline, `key`-based remount) | PRAISE | **PRESERVED** | Not touched. The GET-fetch abort discipline (Praise 3) is now joined by the same discipline on the Add-to-bank POST, not replaced. |

## Loader (`tools/ingest/REVIEW_u3b_loader.md`)

| Finding | Severity | Disposition | Notes |
|---|---|---|---|
| SHOULD-FIX 1 — idempotency test proves REMOVE + no-op reload but not ADD or in-place body CHANGE | SHOULD-FIX | **FIXED** | Added `test_literature_loader_idempotent_reload_adds_chapter_and_passage` (v1 = chapter 1/passage 1 only → v2 = full fixture, asserts the new chapter 2 and chapter 1's second passage both land, with exact row/id verification) and `test_literature_loader_idempotent_reload_changes_passage_body_text` (same chapter/passage numbers across reloads, asserts the stored `body` text reflects the corrected text, not the stale one). Both in `tools/ingest/tests/test_load_literature.py`. |
| SHOULD-FIX 2 — `CountAssertionError` path (`load_literature.py:85-96`) has no test and looks unreachable | SHOULD-FIX | **DEFERRED (documented, not contrived)** | Confirmed by re-reading `_replace_chapters`: it is DELETE-then-INSERT with no `ON CONFLICT`, so the post-load `_count_loaded` result is definitionally equal to what was just inserted from `doc.chapters`/`doc.chapters[].passages` — there is no code path in this loader where those two counts can diverge post-insert. This matches the reviewer's own conclusion ("appears to be genuinely unreachable... unlike the vocab loader's sibling case"). Per the task brief's explicit instruction for this exact finding, this is documented here as intentional defense-in-depth dead code rather than covered by a contrived test that would have to reach into private state to force a mismatch. |
| SHOULD-FIX 3 — no test for a chapter with an empty `passages: []` list (the design-sanctioned "divider" chapter) | SHOULD-FIX | **FIXED** | Confirmed against `_literature_extraction_guide.md:94` ("may be empty for a divider-only chapter"), `LiteratureChapterModel.passages: list[...] = Field(default_factory=list)` (optional), and `_replace_chapters`'s `if not chapter.passages: continue` short-circuit. Added `test_literature_loader_accepts_empty_passages_divider_chapter`: appends a 3rd chapter with `passages: []` to the base fixture, asserts the load succeeds, the chapter row exists, and it contributes zero passage rows. |
| NIT 1 — extraction guide's validation snippet doesn't flag the divider case | NIT | **DEFERRED** | Doc-only, cosmetic (the snippet already doesn't false-positive on an empty `passages[]` — it just doesn't print a confirming line for it). Reviewer rates this low value; not a file otherwise being edited for this pass. |
| NIT 2 — no per-chapter progress log line in `_replace_chapters` | NIT | **DEFERRED** | Reviewer: "acceptable given the documented single-transaction design ... minor observability gap." Not a defect. |
| NIT 3 — `book_title` accepted but never persisted/cross-checked | NIT | **DEFERRED** | Reviewer: "Low value to fix given how small the field is." |
| Coordination note — ADR-019 has no addendum for the literature-family exception | (observation) | **DEFERRED** | Reviewer frames this as "worth a one-line ADR-019 addendum for a future reader," not a defect in the loader itself; the loader's own module docstring already carries the full justification. Out of this fix-pass's file scope. |
| PRAISE 1-7 (unforgeable `user_id`, rollback/status-write ordering, single-transaction delete-then-insert, `FOR UPDATE` lock, pre-DB validation, `ALL_CORPORA` exclusion, `--dry-run`) | PRAISE | **PRESERVED** | Not touched. |

## Self-assessment — build / lint / test results

### Migration (`db/migrations/044_reading_chapters.{up,down}.sql`)

Ran against the live `km-db` container (`docker exec km-db psql -U korean_master -d korean_master`), migrations 001-043 already applied, 044 not yet applied. **All runs wrapped in explicit `BEGIN;`/`ROLLBACK;` — nothing persisted.**

- ⚠️ Process note: the first validation attempt used `psql -1` (auto-commits on success) instead of an explicit `BEGIN;...ROLLBACK;`, which applied 044 to the live DB outside the tracked migration runner (`schema_migrations` was never updated, since that bookkeeping write is owned by `db/migrate.py`, not raw `psql`). Caught immediately by re-checking `schema_migrations`, reverted with `044.down.sql`, and re-verified `\dt` / `pg_constraint` showed a clean pre-044 state before re-running the intended `BEGIN;...ROLLBACK;`-wrapped validation. Confirmed at the end: `schema_migrations` still tops out at `043`, no `reading_chapters`/`reading_passages` tables, no `uq_book_uploads_id_user` constraint.
- `up.sql` applied cleanly inside a transaction: `DO`, `CREATE TABLE` ×2, 9 `COMMENT`s, `CREATE TRIGGER` ×2 — no errors.
- **Re-apply idempotency (the SF-1 fix)**: ran `up.sql` a 2nd time inside the same transaction — succeeded with only expected `NOTICE: relation "..." already exists, skipping` (the `CREATE TABLE IF NOT EXISTS` guards) and no error from `ADD CONSTRAINT` (previously would have raised `ERROR: constraint "uq_book_uploads_id_user" ... already exists`).
- `down.sql` applied cleanly after `up.sql`: 2× `DROP TABLE`, 1× `ALTER TABLE ... DROP CONSTRAINT` — no errors.
- Final live-DB sanity check (outside any transaction): `reading_chapters`/`reading_passages` absent, `uq_book_uploads_id_user` absent, `schema_migrations` unchanged at `043`. Confirmed nothing leaked from the validation.

### Server

- `npm run build` (tsc): **0 errors**.
- `npm run lint`: **0 errors**, 52 pre-existing `@typescript-eslint/no-non-null-assertion` warnings unrelated to this fix-pass (spread across `diagnostic.ts`, `grammar.ts`, `vocab.ts`, etc. — none in files touched here beyond one pre-existing warning at `reading.ts:151` that predates this pass).
- `npx vitest run tests/routes/reading.test.ts`: **13/13 passed**.

### Client

- `npx tsc -p tsconfig.app.json --noEmit`: **0 errors**.
- `npm run lint` (eslint .): **0 errors, 0 warnings**.
- `npx vitest run src/pages/Reading.test.tsx`: **10/10 passed** (4 pre-existing + 6 new: 4 chapter-reader tests + 2 fetch-error-state tests).
  - Regression-proof: manually reverted the BLOCKER fix in a scratch copy, re-ran the suite — the new abort-regression test failed with the exact expected diff (`mineWord` called with `(payload)` instead of `(payload, AbortSignal)`); restored the fix, re-ran — all 10 green again.
  - Node/Vite process note: `client/node_modules/.vite-temp/` was root-owned (0 perms for this user), which made `vitest` fail at config-load time with `EACCES`. Recreated it as a normal writable directory (`rm -rf` + `mkdir`, allowed because the parent `node_modules/` is user-owned and not sticky) rather than using a scratch outDir, since this was a config-load-time failure, not a build-output-path one.

### Loader

- `ruff check tools/ingest/loaders/load_literature.py tools/ingest/loaders/models.py tools/ingest/tests/test_load_literature.py`: **All checks passed** (used a scratch `--cache-dir` since `tools/ingest/.ruff_cache` was also unwritable).
- `python3 -c "ast.parse(...)"` syntax check on both edited Python files: **OK**.
- mypy: **not run** — no `mypy.ini`/`pyproject.toml`/`mypy` config exists anywhere in this repo (confirmed by search), so there is no configured mypy target for this project; ruff is the project's actual static-check gate for `tools/ingest`.
- DB-backed loader tests (`test_load_literature.py`, testcontainers): **not run locally** — no local `psycopg`/testcontainers runtime per the task brief; CI-only. The 3 new tests (`..._adds_chapter_and_passage`, `..._changes_passage_body_text`, `..._accepts_empty_passages_divider_chapter`) were checked against the actual `LiteratureChapterModel`/`LiteraturePassageModel` Pydantic field shapes (`start_page`/`end_page` optional, `passages` defaults to `[]`) and `_replace_chapters`'s control flow to confirm they exercise the intended code paths without relying on execution.

## Files changed

- `db/migrations/044_reading_chapters.up.sql` — SF-1 guard, SF-3 comment, N-1/N-2/N-3 column comments.
- `db/migrations/README.md` — SF-2 migration-list row.
- `server/src/routes/reading.ts` — header-comment reword.
- `client/src/pages/Reading.tsx` — BLOCKER fix (`addCtrlRef` + `handleClose`), NIT-1 `\r\n` fix, header-comment updates.
- `client/src/pages/Reading.test.tsx` — 6 new tests (chapter-reader coverage + abort regression + fetch-error states), mocks for the tap-chain + vocab services, `beforeEach` reset.
- `tools/ingest/tests/test_load_literature.py` — 3 new tests (idempotent ADD, idempotent body CHANGE, empty-passages divider chapter).
