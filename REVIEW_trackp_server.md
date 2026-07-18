# REVIEW — Track P (comic upload) MIGRATION + SERVER slice

Branch `feat/track-p-comic-upload` (10932f5) vs `origin/rebuild`. Independent review; reviewer did not write this code.

## VERDICT: PASS

Blockers: 0. Should-fix: 0. Nits: 3. The slice is correct, safe, minimal, and the tests are real.

---

## Probe answers

### 1. Migration 072 correct + safe? — YES

- `db/migrations/072_book_upload_type_comic.up.sql:35` is exactly one statement: `ALTER TYPE book_upload_type ADD VALUE IF NOT EXISTS 'comic';`. Nothing else executes in the file — no use of the new value in the same transaction, so the PG can't-use-enum-value-in-adding-tx gotcha (runner wraps each migration in one tx per ADR-013) is avoided. Structure and comment block mirror the 021 template (`db/migrations/021_user_mined_corpus.up.sql:34`) line-for-line in posture.
- Numbering: correct next number. Latest on `rebuild` is `071_email_verification_tokens`; 072 is the chain head. Test chain constant `PRE_072 = "071"` (`db/tests/test_migration_072.py:55`) matches.
- Enum vs CHECK: verified `040_book_uploads.up.sql:49` defines a true `CREATE TYPE book_upload_type AS ENUM (...)` and the column (`:67`) is `type book_upload_type NOT NULL` with no CHECK on it — so ALTER TYPE alone is sufficient. (The old bookUploadIngest.ts comment claimed "CHECK (migration 040)"; the branch corrects that to "enum" — accurate.)
- DOWN (`072_book_upload_type_comic.down.sql:1-7`): documented no-op `SELECT 1;`, same posture and near-identical wording as `028_vocab_entry_type_add_values.down.sql`. Correct — PG cannot drop enum values without a type rewrite.
- Test file `db/tests/test_migration_072.py` is NOT tautological:
  - `test_072_up_adds_comic` (:119) runs the real runner (`migrate.main`) over a copy of every production migration file, then from a NEW autocommit connection both enumerates `enum_range(NULL::book_upload_type)` (:110) and performs the actual cast `SELECT %s::book_upload_type` (:136) — proving the value is present AND committed (a cast from a separate tx fails if the ADD VALUE never committed). This is exactly the runtime failure mode a missing 072 would produce.
  - `test_072_up_is_idempotent_on_reapply` (:140) hand-re-applies the ADD VALUE statement against the migrated DB — exercises the `IF NOT EXISTS` guard directly.
  - `test_072_down_is_noop_and_reup_clean` (:157) runs `down --target 071` through the runner, asserts rc==0 and the value survives, then re-runs full up — this re-executes 072's SQL against a DB where 'comic' already exists, which is the true runner-path IF NOT EXISTS exercise. Would fail if the down errored or tried to drop the value.
  - Revert check: delete the 072 files and the cast in :136 fails with `invalid input value for enum`. The tests catch a revert.

### 2. Server changes correct? — YES

- `server/src/services/bookUploadIngest.ts:109-118`: `BOOK_UPLOAD_TYPES` now `['vocab','grammar','both','dialogue','literature','comic'] as const` — mirrors the DB enum post-072 exactly (five original values order-preserved, 'comic' appended, matching enum append order).
- `server/src/routes/uploads.ts:140`: `type: z.enum(BOOK_UPLOAD_TYPES)` — the route file is untouched by the branch and picks up 'comic' automatically because the tuple IS the validation surface. Single source of truth held.
- `server/src/services/uploadExtract.ts:249`: `GRAMMAR_BEARING_TYPES` stays `{'grammar','both'}` — 'comic' is deliberately absent and documented (:245-248). `curateOcrWords` (:272-276) derives `grammarBearing = GRAMMAR_BEARING_TYPES.has(uploadType)` → false for 'comic'; untagged words go to vocab (:318 `grammar: grammarBearing && pos === null`). Genuinely non-grammar-bearing.
- Exhaustive-switch sweep: grepped `uploads.ts` / `uploadExtract.ts` / `bookUploadIngest.ts` / `reading.ts` for type comparisons and switches. No server-side code switches exhaustively on upload type; the only per-type branch is the GRAMMAR_BEARING set (membership test, safe for new values). `reading.ts` mentions `type = 'literature'` only in a doc comment (:72) — its queries key on `book_uploads.id + user_id` (:136), not type, so comic uploads are unaffected. No silent mishandling found.

### 3. Tests real, not tautologies? — YES

- Accepts-comic test (`server/tests/routes/uploads.test.ts:497-516`): POSTs a real multipart zip (`.field('type','comic').attach(...)`), asserts 201 + DTO echo, then independently `SELECT type::text FROM book_uploads WHERE id = $1` (:510-514) — proves Zod admission, ingest, AND DB-enum persistence in one path. Revert of `BOOK_UPLOAD_TYPES` → Zod 400 → fail. Revert of migration 072 → insert raises enum error → 500 → fail. Yes, catches a revert.
- The companion `toContain('comic')` assertion (:487-494) is a source-level tuple guard — near-tautological alone, but it is explicitly supplementary to the e2e test above, and its comment explains why the tuple is the validation surface. Acceptable.
- Non-grammar-bearing test (`server/tests/routes/uploadExtract.test.ts:318-345`): seeds a real 'comic' upload with pages, stubs only the OCR proxy (appropriate — the Claude API is not under test), includes an UNTAGGED word (`'-잖아'`, no `pos`) that WOULD be a grammar candidate on a 'grammar'/'both' upload, then asserts `grammar_inserted === 0`, `kgiuRows(uploadId).length === 0`, and both words present in vocab rows read from the DB. If 'comic' were added to GRAMMAR_BEARING_TYPES this fails (grammar_inserted would be 1). If the type were reverted, `seedUploadWithPages(userId, 1, 'comic')` fails at the DB. Real behavior, catches a revert.
- Pure-boundary test (:347-363) additionally pins `curateOcrWords('comic')` at the unit level — grammar bucket empty, both words in vocab, skipped 0. Complements, not duplicates, the route test.

### 4. Backward-compat / fences / scope? — YES, clean

- Existing 5 types: untouched — the tuple change is append-only; `GRAMMAR_BEARING_TYPES` unchanged; no extraction-path logic modified beyond a comment.
- `server/src/db/corpusFences.ts`: zero diff vs rebuild. No fence/security regression.
- `server/tests/helpers/seed.ts:673`: type union widened to include 'comic' — the only helper change, exactly what the tests need.
- Scope: branch also touches 7 client files (UploadTypeModal, Reading, Uploads, domain.ts + tests) — outside this review's slice, not evaluated here. Within the migration+server slice there is no scope creep: 8 files, all directly serving Track P.

**Would the tests catch a revert? YES** — every new test fails under a revert of the migration, the tuple, or the classification behavior (mechanisms cited per-test above).

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
1. `db/tests/test_migration_072.py:146-148` — f-string interpolation of `NEW_VALUE` into SQL. It is a module constant in a test, so no injection risk, but psycopg's `sql.Literal` would match the parameterized style used two lines below and elsewhere in the suite.
2. `db/tests/test_migration_072.py:141-143` — the docstring of `test_072_up_is_idempotent_on_reapply` claims "running the chain up when everything is already applied is a no-op," but the test body never re-runs `migrate.main(... "up")` a second time; it only hand-re-applies the statement. The runner-path re-apply IS covered (by test 3's down→re-up), so this is a docstring accuracy nit, not a coverage gap.
3. `server/src/services/uploadExtract.ts:249` — `GRAMMAR_BEARING_TYPES: ReadonlySet<string>` (pre-existing, not a regression): typing it `ReadonlySet<BookUploadType>` would make a typo'd member a compile error. Optional hardening for a future pass.

### PRAISE
1. `db/migrations/072_book_upload_type_comic.up.sql:13-25` — the PG enum-gotcha explanation is the best-documented instance of this pattern in the chain: it names the runner, ADR-013, the 021/016 precedent, and states precisely why nothing else may ride along in the file.
2. `db/tests/test_migration_072.py:135-137` — casting the value from a fresh connection to prove the migration COMMITTED (not merely executed) is exactly the right assertion for this class of migration, and most codebases miss it.
3. `server/tests/routes/uploadExtract.test.ts:322-325` — choosing an untagged suffix-shaped word (`'-잖아'`) that would classify as grammar on a grammar-bearing upload makes the test a genuine discriminator, not a fixture that passes either way.
4. `server/src/services/bookUploadIngest.ts:109-111` — the comment fix (040 defines an enum, not a CHECK) quietly corrects a pre-existing inaccuracy while touching the line anyway.
