# U3a Fix-Pass Verification — Independent Re-Review

**Reviewer:** independent, fresh eyes (did not write the code, did not perform
either original review). Verified against actual code and a live re-run, not
against the fix-pass self-report.

## Summary verdict: **PASS**

All three items the fix-pass claimed to close are genuinely closed, verified
by reading the actual diff/tests (not the report) and by re-running build,
lint, and the full test suite from scratch. No regressions found: the
IDOR-guard shape, `$6`..`$9` parameter numbering, and the Zod
`.positive().max(MAX_ID)` bounds remain byte-identical between
`vocab.ts`/`grammar.ts`. Re-run results match the self-report's numbers
exactly (build 0 errors, lint 0 errors/51 warnings, 149/149 tests).

---

## Finding-by-finding verification table

| Finding | Original severity | Fix status | Notes |
|---|---|---|---|
| SF-3 (tests review): no test proves the `source_upload_id = $6` equality predicate, not just the ownership `EXISTS`, gates the row | SHOULD-FIX | **FIXED** | New test in both files (`vocab.test.ts:187-199`, `grammar.test.ts:228-239`) seeds two uploads owned by the *same* user, tags one row to each, filters by upload A, asserts only A's row returns. Traced the logic myself: if the outer `source_upload_id = $6` equality were dropped (leaving only `EXISTS (... bu.id = source_upload_id AND bu.user_id = $7)`), both rows satisfy the EXISTS (both belong to uploads owned by the requester), so both would be returned and `total`/`entries.length` would be 2, not 1 — the assertion `total`/`entries.length === 1` would fail. This is a genuine, non-vacuous regression trip-wire. |
| SF-1 (tests review): `grammar.test.ts` U3a block missing "omitted filter → all rows" | SHOULD-FIX | **FIXED** | `grammar.test.ts:243-252` — present, passes, mirrors `vocab.test.ts:201-210`. |
| SF-2 (tests review): `grammar.test.ts` U3a block missing "non-existent id → 200 empty" | SHOULD-FIX | **FIXED** | `grammar.test.ts:271-277` — present, passes, mirrors `vocab.test.ts:235-241`. Grammar U3a block is now 6 tests (was 3), matching vocab's 6 (was 5) — full parity, same case order in both files. |
| NIT-1 (SQL review): `vocab.ts` comment claims "soft/hard-deleted" but `book_uploads` has no soft-delete column | NIT | **FIXED** | `vocab.ts:132-134` now reads "a hard-deleted upload's id likewise matches nothing (book_uploads has no soft-delete column — migration 040 is hard-delete only)". Cross-checked against `db/migrations/040_book_uploads.up.sql:19` which literally states `book_uploads` is HARD-deleted (no `deleted_at`) — the new comment is accurate. `grammar.ts:92-95` ("unowned/deleted upload") correctly left untouched, as the brief specified (it never had the soft/hard phrasing problem). |
| NIT-2 (SQL review): uncorrelated `EXISTS` could be rewritten as a single correlated form | NIT | **DEFERRED** (correctly) | Fix-pass explicitly declined this per the reviewer's own "not blocking" framing, and to avoid introducing re-review risk to a byte-identical-across-routes construct. Reasonable call — not a regression, not a suppressed BLOCKER. |
| N-1 (tests review): garbage-id boundary value inconsistency (`-1` vocab vs `0` grammar) | NIT | **DEFERRED** (correctly) | Left as-is, both still 400 (`vocab.ts` test line 246 uses `-1`, `grammar.ts` test line 282 uses `0`). Cosmetic, out of scope per brief. |
| N-2 (tests review): no test drives `source_upload_id` above `Number.MAX_SAFE_INTEGER` | NIT | **DEFERRED** (correctly) | Consistent with rest of codebase's ID-param tests; not requested in this pass. |

**BLOCKER count: 0. SHOULD-FIX count: 3, all FIXED. NIT count: 4, 2 FIXED (comment accuracy) + 2 correctly DEFERRED (explicitly out of scope, non-blocking per originating reviewers).**

---

## Post-fix bar state (re-run from scratch, not trusted from the report)

- **Build** — `npm run build` (tsc): **exit 0**, no errors. Matches self-report.
- **Lint** — `npm run lint`: **0 errors, 51 warnings**, all pre-existing
  `@typescript-eslint/no-non-null-assertion` warnings unrelated to this change.
  Matches self-report exactly.
- **U3a-only tests**: manually counted — `vocab.test.ts` U3a `describe` block
  (`152-248`) has 6 `it(...)` blocks; `grammar.test.ts` U3a `describe` block
  (`198-284`) has 6 `it(...)` blocks. **12/12**, matches the claimed
  "up from 5/3 to 6/6."
- **Full regression** — `npx vitest run tests/routes/vocab.test.ts
  tests/routes/grammar.test.ts --reporter=verbose`, real testcontainers
  Postgres via Docker, run independently in this review (not reusing any
  fix-pass artifact):

  ```
  Test Files  2 passed (2)
       Tests  149 passed (149)
    Duration  122.75s
  ```

  Matches the self-report's "149/149" claim exactly. All 12 U3a tests
  (6 vocab + 6 grammar) are present in this run and pass, including the new
  equality-predicate test in both files.

## Regression check on PRAISE items (must not have been undone)

`git diff` on `server/src/routes/vocab.ts` / `grammar.ts` against the
pre-U3a base confirms, read directly (not from the report):

- **EXISTS-guard shape** — structurally identical in both routes:
  `AND ($N::bigint IS NULL OR (source_upload_id = $N::bigint AND EXISTS (SELECT 1 FROM book_uploads bu WHERE bu.id = $N::bigint AND bu.user_id = $M)))`.
- **Parameter numbering** — `source_upload_id`/`userId` at `$6`/`$7`,
  `LIMIT`/`OFFSET` bumped to `$8`/`$9` in both files' SQL text and JS params
  array, in the same order.
- **Zod bounds** — `source_upload_id: z.coerce.number().int().positive().max(MAX_ID).optional()`
  byte-identical in `vocab.ts:79` and `grammar.ts:55`.

No drift. Also checked `server/tests/helpers/seed.ts`: the `sourceUploadId`
param addition to `seedVocabEntry`/`seedKgiuEntry` is purely additive
(new optional field, defaults to `null`, appended as the last column/param;
no reordering of existing positional params), matching the original tests
reviewer's P-2 finding.

## New findings introduced by the fix-pass

None found. Specifically checked for:
- Silent scope creep beyond the 3 assigned items — confirmed none (diff of
  the route files contains only the two intended edits: the comment reword
  in `vocab.ts`, and the additive filter/tests that were already present
  before this fix-pass — i.e. nothing extra was touched).
- Any weakening of the ownership guard, param binding, or bounds — none;
  confirmed byte-identical as above.
- Test flakiness/vacuity in the new equality-predicate test — not vacuous;
  independently reasoned through the failure mode above without relying on
  the fix-pass's own mutation-testing narrative (though that narrative,
  independently checked by inspection, is consistent with what the test
  actually asserts).

**BLOCKER: 0. SHOULD-FIX: 0. NIT: 0. PRAISE:** the fix-pass's execution
discipline itself is praiseworthy — closed exactly the 3 assigned items,
left explicitly-deferred items alone rather than scope-creeping, and the new
tests are genuinely load-bearing rather than coverage theater.

## Recommendation

**Ready to ship.** No BLOCKER or unresolved SHOULD-FIX remains; the two
outstanding NITs (uncorrelated EXISTS style, boundary-value inconsistency)
are cosmetic and explicitly non-blocking per both original reviewers. No
further fix-pass needed for U3a. Proceed to `/fixpass`'s next step (CI green
+ blue/green deploy) per `U3_READER_DESIGN.md`'s per-phase workflow.
