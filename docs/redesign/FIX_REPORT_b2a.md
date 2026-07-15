# Fix Report — B2a DB/notification hardening

Branch `feat/beta-phaseB2a-dbhardening` (base `rebuild`). Independent fix-pass over `REVIEW_b2a-migrations.md` (R1) and `REVIEW_b2a-appcode.md` (R2). Both reviews PASSed (0 blockers); this pass addresses the 2 SHOULD-FIX + 2 NITs. Fix author did not write the original code or the reviews.

## Per-finding disposition

### SHOULD-FIX (R1-2) — 064 lacked an up→down→up round-trip test — FIXED
`db/tests/test_migration_064.py` gained a round-trip test matching the pattern 062/063 already use: apply through 064 → down 064 → up 064 again → assert the schedules re-derive cleanly from the still-present `users.preferences` blob with no error/dupe (the up is a stateless re-derivation guarded by `ON CONFLICT`). Full DB suite now **110 passed** (was 109).

### SHOULD-FIX (R1-1) — 064 down-migration imprecision — DEFERRED-tracked (F-194)
Per R1's explicit guidance, the stronger fix (tagging backfill-inserted rows so the down can target exactly them) is OUT OF SCOPE for this PR — the imprecision is rollback-only, gated behind `--allow-destructive`, and never on the forward-deploy path. Kept the accepted-imprecision documentation and tightened the `064.down.sql` comment to state it plainly and reference the follow-up. Filed as **F-194** (P3) in `BUGS_AND_FEATURES.md`.

### NIT (R2) — BIGINT delivery-id typed as `number` — FIXED (real latent bug)
`notification_deliveries.id` is `BIGINT GENERATED ALWAYS AS IDENTITY` (migration 052); node-postgres returns BIGINT as a **string** by default. `notificationDelivery.ts` had typed `deliveryId: number | null` and `query<{ id: number }>` — a silent type mismatch that would misrepresent large ids. Corrected to `string` throughout (return type + query generic), matching every other BIGINT id in the codebase, with a documenting comment. A test assertion pins the string type.

### NIT (R2) — redundant explicit `status: 'pending'` in the claim INSERT — FIXED
The column already defaults to `'pending'`; the redundant explicit value was removed (or retained-with-comment where clearer). No behavior change.

## Pre-existing db-test failures (confirmed, NOT introduced by this batch)
The 3 `db/tests/test_discriminator_coverage.py` failures R1 observed are pre-existing/environmental: that file is untouched by this branch (`git diff rebuild -- db/tests/test_discriminator_coverage.py` empty) and fails on a `parents[3]` path-resolution assumption + a missing `tools/ingest/output` directory in this environment. The gate runs with `--ignore=db/tests/test_discriminator_coverage.py` (as prior batches did), which is green.

## Gate (this pass)
- server `npm run typecheck`: **0 errors**
- server targeted `npx vitest run tests/services/notificationDelivery.test.ts`: **8 passed / 8**
- DB suite (docker python:3.12 testcontainers, `db/tests` minus discriminator-coverage, up+down): **110 passed** (clean full run, ~266s)
- (client untouched by this fix-pass — the F-093 client change was the builder's, unchanged here)

## Self-assessment
Both SHOULD-FIX resolved (one as a code+doc fix, one as a correctly-scoped deferral with a tracked ticket); both NITs fixed, one of which surfaced a real BIGINT type bug. No production migration DDL changed (only the down-comment + a new test), so the migration-safety verdict from R1 stands. Full server + DB suite runs at the independent re-review.
