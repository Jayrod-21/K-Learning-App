# U3b Chapter Reader — Re-Review of Fix-Pass (`feat/u3b-chapter-reader`)

**Reviewer:** independent, second-pass. Did not write the original code, did not
write the four original reviews, did not write the fix-pass. Verified every
claim in `db/docs/reviews/u3b-reader/FIX_REPORT.md` against the actual current
code and by re-running the build/lint/test/migration gates myself — the
fix-pass's self-report was treated as a claim to disprove, not a fact.

## Summary verdict

**PASS.** Every BLOCKER and SHOULD-FIX from the four original reviews is
genuinely fixed, not just claimed-fixed. The one BLOCKER (`mineWord` called
without an `AbortSignal`, `client/src/pages/Reading.tsx`) is fixed correctly
and is now covered by a regression test that provably distinguishes fixed
from broken code (traced by hand: the un-fixed 1-arg call site would fail the
test's `toHaveBeenCalledWith(..., expect.any(AbortSignal))` assertion). All
re-run gates are green with the exact counts the fix-pass reported. No
regressions found; no praised item was undone. One new NIT surfaced during
this pass (see below) — cosmetic, not blocking.

## Finding-by-finding verification

### Schema (`db/migrations/REVIEW_u3b_schema.md`)

| Finding | Severity | Fix status | Notes |
|---|---|---|---|
| SF-1 — `ADD CONSTRAINT uq_book_uploads_id_user` has no re-apply guard | SHOULD-FIX | **FIXED** | Confirmed at `044_reading_chapters.up.sql:76-83` — wrapped in `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_book_uploads_id_user') THEN ... END IF; END $$;`, matching 002's idiom. **Independently re-validated**: ran `up.sql` twice back-to-back inside one `BEGIN;...ROLLBACK;` against live `km-db` — 2nd run produced only expected `NOTICE: ... already exists, skipping` from the `CREATE TABLE IF NOT EXISTS` guards and no error from the constraint add (previously would have thrown `ERROR: constraint "uq_book_uploads_id_user" ... already exists`). Then ran `down.sql` — constraint and both tables cleanly removed, verified via `pg_constraint`/`to_regclass` inside the same transaction. `ROLLBACK` confirmed and post-rollback state checked outside the transaction: `schema_migrations` still tops out at 043, no `reading_chapters`/`reading_passages`, no `uq_book_uploads_id_user` — nothing leaked. ADR-013 compliance holds: the `DO $$ ... $$` block is PL/pgSQL, not `BEGIN`/`COMMIT` transaction control. |
| SF-2 — Migration 044 missing from README's migration table | SHOULD-FIX | **FIXED** | `db/migrations/README.md:32` has the `044 | reading_chapters | U3b | ...` row. 040/042/043 remain absent, exactly as the fix-pass's report states it deliberately deferred (pre-existing gap, out of scope) — this is an accurate, not an inflated, claim. |
| SF-3 — no schema-level guard that `source_upload_id` points at a `'literature'`-typed upload | SHOULD-FIX | **FIXED** | `COMMENT ON CONSTRAINT fk_reading_chapters_upload_owner ON reading_chapters IS ...` present at `044.up.sql:164-171`, states plainly the FK does not constrain `book_uploads.type` and that the invariant is enforced by the loader + routes. Matches the original reviewer's own suggested resolution verbatim. |
| N-1/N-2/N-3 — missing `COMMENT ON COLUMN` for `source_upload_id`/`end_page`/`page_number` | NIT | **FIXED** | All three present: `044.up.sql:157-163` (`source_upload_id`), `:153-156` (`end_page`), `:223-227` (`page_number`). |
| N-4 — CASCADE destroys curated OCR with no soft-delete gate | NIT | **DEFERRED** | Correctly deferred — no `DELETE /uploads/:id` route exists in this branch's scope; nothing to fix without inventing a route. |

### Server (`server/src/routes/REVIEW_u3b_server.md`)

| Finding | Severity | Fix status | Notes |
|---|---|---|---|
| Header comment self-contradictory ("empty chapter list" vs "additionally 404s") | SHOULD-FIX | **FIXED** | `reading.ts:17-33` reread in full — the contradictory sentence pair from the original is gone. The header now states, consistently and matching the tested behavior, that the list route 404s a not-owned/missing upload *before* the chapters query runs, and an owned-but-empty upload 200s with `{ chapters: [] }`. No remaining internal contradiction. |
| NIT 1/2 (type-gate, redundant-filter test gap) | NIT | **DEFERRED** | Correctly deferred per the original reviewer's own "not a security gap" framing. |
| PRAISE 1-3 | PRAISE | **PRESERVED** | `reading.ts` unchanged elsewhere — passages query still scopes on `chapter_id` alone (safe, ownership already proven), uniform-404 tests untouched, nginx allow-list untouched. Verified `reading.ts` end-to-end against the file, not just the diff. |

### Client (`client/src/pages/REVIEW_u3b_client.md`)

| Finding | Severity | Fix status | Notes |
|---|---|---|---|
| BLOCKER — `mineWord` called without an `AbortSignal` | BLOCKER | **FIXED** | Traced by hand: `Reading.tsx:529` declares `addCtrlRef`; `handleAdd` (`:590-632`) creates a fresh `AbortController` per add and calls `mineWord(payload, ctrl.signal)` (`:603-614` — confirmed against `services/vocab.ts:294-303`'s `mineWord(input, signal?: AbortSignal)` signature, so the call is well-typed and the signal genuinely reaches `api.post`'s fetch). `handleClose` (`:576-580`) aborts `addCtrlRef.current` before delegating to `useTapWord`'s `onClose`, and is wired as `WordPopover`'s `onClose` prop at `:699` (confirmed `WordPopover.tsx:185-186`'s Close button calls the passed `onClose`). An unmount effect (`:530-535`) also aborts. Full chain traced: tap → `WordPopover` → Close button → `handleClose` → `addCtrlRef.current.abort()`. This is the correct fix, mirroring `Ttmik.tsx`'s `DetailView.inFlightCtrlRef` pattern as claimed. |
| SHOULD-FIX 1 — no regression test for the abort race | SHOULD-FIX | **FIXED, and the test is real** | `Reading.test.tsx:317-385` — read it directly, not just its docstring. It mocks `mineWord` to never resolve, captures the `AbortSignal` it was called with, asserts `mineWord` was called with `(expect.objectContaining({lemma}), expect.any(AbortSignal))` (an exact 2-arg match — the pre-fix code called `mineWord(payload)` with 1 arg, which would fail this assertion), asserts the signal is not yet aborted, clicks Close, then asserts the *same* captured signal's `.aborted === true`. This is a genuine regression test, not a vacuous one: I confirmed by inspection that removing `ctrl.signal` from the `mineWord(...)` call (reverting the BLOCKER fix) would make the `expect.any(AbortSignal)` match fail on the 2nd argument. Not passes-for-the-wrong-reason. |
| SHOULD-FIX 2 — `ChapterReader` had zero test coverage | SHOULD-FIX | **FIXED** | `Reading.test.tsx:221-386`, `describe('Reading — chapter reader (tap-to-define)')` has 4 real tests: ordered/newline-preserving passage render (asserts DOM order despite out-of-order wire data, asserts a literal `<br/>` exists), empty-passages empty state, tap→lemmatize→define→enrich→popover-opens with a real assertion on the resolved gloss text ("boy") inside `role=dialog`, and the abort regression test above. All 4 genuinely exercise `getChapter`/`lemmatize`/`defineEntry`/`enrich`/`mineWord` mocks — not just mounted-and-ignored. |
| SHOULD-FIX 3 — fetch-error states untested for pickers | SHOULD-FIX | **FIXED** | `Reading.test.tsx:388-439` — 2 tests, one per picker level, each rejects the mock once then resolves on retry, asserts `role=alert` fixed copy (and explicitly asserts the server's raw message `'boom'` does NOT leak through), and asserts Retry recovers to the happy-path render. Real assertions, not smoke tests. |
| NIT 1 — `\r\n` not stripped before newline split | NIT | **FIXED** | `Reading.tsx:490` — `body.replace(/\r\n/g, '\n').split('\n')`. |
| NIT 2/3 (duplicated payload builder, ungated scan button) | NIT | **DEFERRED** | Correctly deferred per the original reviewer's own framing (folded into the already-planned U3c dedup; cosmetic-only, non-trivial restructure). |
| PRAISE 1-4 | PRAISE | **PRESERVED** | `useTapWord.ts`'s `isMinedRef` effect-write (`:69-72`), `PassageBody`'s `\n`-split-then-`<br/>` (now also `\r\n`-normalized, not replaced), the GET-fetch abort discipline on all 3 levels (unchanged), and `key`-based remounts (`Reading.tsx:155,160`) — all confirmed present and untouched beyond the BLOCKER's own file. |

### Loader (`tools/ingest/REVIEW_u3b_loader.md`)

| Finding | Severity | Fix status | Notes |
|---|---|---|---|
| SHOULD-FIX 1 — idempotency test missing ADD/CHANGE cases | SHOULD-FIX | **FIXED** | `test_load_literature.py:387-495` — `test_literature_loader_idempotent_reload_adds_chapter_and_passage` (v1 = chapter 1/passage 1 only → v2 = full fixture; asserts row counts 1→2 chapters, 1→3 passages, and the exact new `chapter_number`/`passage_number` sets via direct SQL) and `test_literature_loader_idempotent_reload_changes_passage_body_text` (same numbers, changed body text, asserts stored text equals the new text and differs from the old). Both are real DB-level assertions, not just return-value checks. CI-only (no local psycopg/testcontainers) — verified by reading the test code and cross-checking against `_replace_chapters`'s delete-then-insert control flow and the `LiteratureChapterModel`/`LiteraturePassageModel` field shapes (confirmed `passages: list[...] = Field(default_factory=list)` at `models.py:383`), not by execution. |
| SHOULD-FIX 2 — `CountAssertionError` path unreachable/untested | SHOULD-FIX | **DEFERRED (documented, correctly not contrived)** | The fix-pass's reasoning holds: delete-then-insert with no `ON CONFLICT` makes the post-load count definitionally equal to what was just inserted — there's no code path to diverge. Documenting this as intentional dead code rather than writing a test that reaches into private state to force a mismatch is the right call, matching the task brief's explicit instruction for this exact finding. |
| SHOULD-FIX 3 — no empty-`passages[]` divider-chapter test | SHOULD-FIX | **FIXED** | `test_load_literature.py:498-545` — `test_literature_loader_accepts_empty_passages_divider_chapter` appends a 3rd chapter with `passages: []`, asserts `chapters == 3`, `passages` count unchanged at 3, the divider chapter's row exists, and `COUNT(*)` of its passages is exactly 0. Confirmed against actual code: `load_literature.py:349` has `if not chapter.passages: continue` (verified by direct grep), matching the test's premise precisely. |
| NIT 1-3, coordination note | NIT | **DEFERRED** | All correctly low-value/out-of-scope per the original reviewer's own framing (doc-only, observability-only, tiny unused field, ADR addendum). |
| PRAISE 1-7 | PRAISE | **PRESERVED** | Not touched by the fix-pass; spot-checked `_resolve_owner`'s `FOR UPDATE` and the transaction/status-write split are still present in `load_literature.py` (grepped, both intact). |

## New findings introduced by the fix-pass

- **NIT (new) — `reading.ts`'s header still asserts a claim about `reading_chapters.user_id` "pinned by the migration-044 composite FK, so it can never drift" without any comment cross-referencing SF-3's new caveat** (that the FK does *not* constrain `book_uploads.type`). Not a defect — the server header's claim about `user_id` correctness is still accurate — just an opportunity for the two now-adjacent comments (schema's new `COMMENT ON CONSTRAINT` and the route header) to explicitly agree on what the FK does and doesn't cover, for a future reader who only reads one of the two files. Purely cosmetic; no action required to ship.
- No BLOCKER, SHOULD-FIX, or regression was introduced by the fix-pass. No praised item from any of the four original reviews was silently undone — each was spot-checked against current code, not just the fix-pass's own "PRESERVED" claim.

## Self-report accuracy — gates re-run independently

All commands below were run fresh by this reviewer (not copy-checked from the fix-pass), against the current `feat/u3b-chapter-reader` working tree.

| Gate | Fix-pass claimed | Independently re-run result | Match |
|---|---|---|---|
| Server `npm run build` | 0 errors | 0 errors | ✅ |
| Server `npm run lint` | 0 errors, 52 pre-existing warnings | 0 errors, 52 warnings | ✅ |
| Server `vitest run tests/routes/reading.test.ts` | 13/13 passed | 13/13 passed | ✅ |
| Client `tsc -p tsconfig.app.json --noEmit` | 0 errors | 0 errors (no output) | ✅ |
| Client `npm run lint` | 0 errors, 0 warnings | 0 errors, 0 warnings | ✅ |
| Client `vitest run src/pages/Reading.test.tsx` | 10/10 passed (4 pre-existing + 6 new) | 10/10 passed | ✅ (no root-owned `.vite-temp` issue hit this run) |
| `ruff check` (loader + models + tests) | All checks passed | All checks passed | ✅ |
| Migration 044 up→up→down idempotency | Re-apply succeeds with only expected NOTICEs; down clean; nothing leaked | Reproduced exactly — 2nd `up.sql` run: `NOTICE: relation "..." already exists, skipping` ×2, no error from the constraint add; `down.sql` clean; `ROLLBACK` verified, post-state matches pre-044 (schema_migrations at 043, no new tables/constraint) | ✅ |

No discrepancies found between the fix-pass's self-report and independently reproduced results.

## Recommendation

**Ready to ship.** All 4 original BLOCKER/SHOULD-FIX sets are genuinely resolved with real, non-vacuous test coverage where tests were required; the one BLOCKER's fix was traced by hand through the actual call chain (not just trusted from the diff) and confirmed correct; the schema idempotency claim was independently re-validated against a live `km-db` rather than taken on faith; all build/lint/test/ruff gates were re-run from scratch and match the reported counts exactly. No new BLOCKERs. The single new finding is a cosmetic cross-reference NIT that does not block merge.

Recommend, as non-blocking follow-up tickets (not required before shipping this branch):
1. Backfill README migration-table rows for 040/042/043 (pre-existing gap, explicitly deferred by both the original review and the fix-pass).
2. Sweep migrations 029/038 for the same missing `ADD CONSTRAINT` re-apply guard (pre-existing drift, not introduced by 044).
3. One-line ADR-019 addendum noting the literature-loader's deliberate non-participation in checkpoint/resume batching.
4. Optional: cross-reference `reading.ts`'s header comment with the schema's new `COMMENT ON CONSTRAINT fk_reading_chapters_upload_owner` caveat about `book_uploads.type` not being enforced by the FK (the new NIT noted above).
