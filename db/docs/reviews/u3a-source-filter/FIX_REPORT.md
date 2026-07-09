# U3a Fix-Pass Report — server-side `source_upload_id` filter

Fix-pass against `REVIEW_u3a_sql.md` (SQL/IDOR reviewer — PASS, 2 NITs) and
`REVIEW_u3a_tests.md` (tests reviewer — APPROVE WITH SHOULD-FIX). Scope: the
three items called out in the fix-pass brief. No other changes made.

## Findings and dispositions

| # | Finding | Source | Disposition |
|---|---|---|---|
| 1 | Missing test: same user owns TWO uploads, seeds a row tagged to EACH, filters by one → only that row returns (closes the "EXISTS guard present but `source_upload_id = $6` equality dropped" bug class) | REVIEW_u3a_tests SF-3 (both reviewers flagged this as the key gap) | **FIXED** — added `excludes a row tagged to a different upload the same user owns (equality predicate, not just ownership)` to both `vocab.test.ts` (after the "narrows to entries tagged with the given owned upload" test, U3a block) and `grammar.test.ts` (same position). |
| 2 | `grammar.test.ts` U3a block missing 2 boundary cases present in `vocab.test.ts`: "omitting the filter returns both tagged and untagged" and "a non-existent upload id → 200 empty" | REVIEW_u3a_tests SF-1, SF-2 | **FIXED** — ported both tests into `grammar.test.ts`'s U3a block, symbol-for-symbol mirrors of the vocab versions (KGIU wire shape: `entries.length` / `entries[0].pattern` instead of `total` / `entries[].korean`). |
| 3 | `vocab.ts` WHERE-clause comment references "soft/hard-deleted" uploads; `book_uploads` has no soft-delete column (migration 040 = hard-delete only, per migration 040's own doc comment) | REVIEW_u3a_sql NIT-1 | **FIXED** — reworded to "a hard-deleted upload's id likewise matches nothing (book_uploads has no soft-delete column — migration 040 is hard-delete only)". Checked `grammar.ts:92-95` for the same wording per the brief's instruction — it already says "unowned/deleted upload" (no "soft/hard" phrasing), which the SQL reviewer explicitly called "more careful" and free of this problem, so it was left untouched. |

## Items explicitly NOT touched (PRAISE / out of scope, per brief)

- NIT-2 (SQL reviewer): the uncorrelated `EXISTS` subquery style — reviewer called it "purely stylistic… not blocking" and did not ask for a rewrite. Left as-is (also avoids risking the byte-identical-between-routes property PRAISE-1 calls out).
- N-1 (tests reviewer): garbage-id boundary value inconsistency (`-1` in vocab vs `0` in grammar) — explicitly a NIT, not a SHOULD-FIX, and reviewer called it harmless. Left as-is; both files still correctly 400 on their respective garbage values, and changing this wasn't in the brief's scope list.
- N-2 (tests reviewer): no test drives `source_upload_id` above `Number.MAX_SAFE_INTEGER` — reviewer noted this is consistent with the rest of the codebase's existing ID-param tests (not a regression) and didn't ask for it in this pass. Left as-is, out of scope.
- The uncorrelated-EXISTS→correlated-EXISTS rewrite the SQL reviewer sketched in NIT-2 was considered and rejected: it's a no-op behavior change to code three independent reviewers have already verified byte-identical and IDOR-safe between the two routes; rewriting it here would only add re-review risk for zero functional gain, which the reviewer themselves said was "not blocking."

No recommended fix was judged wrong — all three assigned items were applied as specified in the brief.

## Rigor check on the new equality-predicate tests (SF-3)

Per the brief's requirement that the new tests "MUST genuinely fail if the
guard/equality predicate were wrong," both new tests were verified against a
mutated SQL clause that keeps the `EXISTS` ownership check but drops the outer
`source_upload_id = $6` equality (the exact bug class SF-3 describes):

```sql
-- mutated (temporary, reverted after the check):
AND ($6::bigint IS NULL
     OR (EXISTS (SELECT 1 FROM book_uploads bu
                  WHERE bu.id = source_upload_id
                    AND bu.user_id = $7)))
```

Against this mutation, `excludes a row tagged to a different upload the same
user owns` failed in **both** files (`expected 2 to be 1`, i.e. both upload
A's and upload B's rows came back), confirming the test is load-bearing, not
vacuous. Both files were then restored to the fixed/correct SQL and re-verified
passing (see Verification below). This mutation was never committed — applied
and reverted in-place during the fix-pass, confirmed via `git diff` showing
only the intended changes remain.

## Verification

- **Build**: `cd server && npm run build` → exit 0 (tsc, no errors).
- **Lint**: `cd server && npm run lint` → **0 errors**, 51 warnings (all
  pre-existing `@typescript-eslint/no-non-null-assertion` warnings, unrelated
  to this change — confirmed present before this fix-pass touched any file).
- **U3a tests** (`npx vitest run tests/routes/vocab.test.ts
  tests/routes/grammar.test.ts -t "U3a" --reporter=verbose`, real
  testcontainers Postgres via Docker): **12/12 passed** (6 per file, up from
  5 in vocab.test.ts / 3 in grammar.test.ts before this pass — the 2 new
  vocab tests and 3 new grammar tests account for the delta).
- **Full regression check** (`npx vitest run tests/routes/vocab.test.ts
  tests/routes/grammar.test.ts` — both entire files, not just the U3a
  filter): **149/149 passed**, 0 failures. Confirms the comment-only route
  change and the additive tests introduced no regressions anywhere else in
  either route file.

## Self-assessment

All three assigned findings closed at root cause, not band-aided:
- The SF-3 test gap is closed with a test that seeds two owned uploads and is
  proven (via the mutation check above) to fail if the equality predicate
  is ever dropped from either route's SQL — this is the actual gap both
  reviewers converged on as the most important one.
- The grammar/vocab test-coverage asymmetry (SF-1, SF-2) is closed by porting
  the exact missing cases, keeping both files' U3a blocks symmetric going
  forward (narrows → different-upload-same-owner → omit-filter → IDOR →
  non-existent-id → garbage-id, same order in both files now).
- The comment NIT is fixed with accurate, specific wording (cites migration
  040 directly) rather than just deleting the inaccurate clause.

No PRAISE items were undone: the EXISTS-guard shape, parameter numbering, and
Zod bounds are byte-for-byte unchanged in both routes (confirmed via
`git diff` inspection during the rigor check above — only the two intended
edits, comment + LIMIT/OFFSET-adjacent additions from the original U3a
implementation, remain).
