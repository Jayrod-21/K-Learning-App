# Re-review of the B2a fix-pass

Independent re-review of the B2a fix-pass (`4563c03`) over the two PASS reviews
(`REVIEW_b2a-migrations.md` = R1, `REVIEW_b2a-appcode.md` = R2) and the fix report
(`FIX_REPORT_b2a.md`). Branch `feat/beta-phaseB2a-dbhardening`, base `rebuild`.
Re-reviewer did NOT write the code, the reviews, or the fix-pass. Verified against
the actual diff (`git diff fe73c0c..4563c03`) and by running the full gate.

## Verdict

**PASS.**

Both SHOULD-FIX and both NITs are resolved as claimed. The BIGINT `deliveryId`
fix is genuinely end-to-end. No production migration DDL changed, so R1's
live-DB-safety verdict stands. The full gate is green (one client test flaked on
a pollution race in an untouched file — passed in isolation and on a clean full
re-run; not a B2a regression). One new non-blocking NIT surfaced (an input-side
BIGINT sibling of the fixed finding) — recommended as a follow-up, not a blocker.

Scope of the fix-pass diff (verified via `git diff fe73c0c..4563c03 --name-only`):
`064...down.sql` (comment only), `db/tests/test_migration_064.py` (+64 lines),
`server/src/services/notificationDelivery.ts`, `server/tests/services/notificationDelivery.test.ts`,
`BUGS_AND_FEATURES.md`, and the three `docs/redesign/*` reports. **No `.up.sql`
migration body changed** (062/063/064 up untouched) — confirmed by name-only diff.

## Finding-by-finding

### R1 SHOULD-FIX #2 — 064 lacked an up→down→up round-trip test — **FIXED**
`db/tests/test_migration_064.py::test_064_round_trip_up_down_up_rederives_cleanly`
(new, lines 385–441). It is a genuine, non-tautological round-trip:
1. Seeds a user with a `daily/reviews_due/weekly`-enabled blob, applies through
   064 (first backfill), captures the three derived rows.
2. Runs `migrate down --target 063 --allow-destructive` and **asserts the user's
   schedules are now `== []`** (proves the down actually removed the backfill —
   not a no-op that would make step 3 vacuous).
3. Re-applies `up` and asserts the re-derived set is identical in shape
   (`{daily_reminder, reviews_due, weekly_report}`), field-for-field equal
   (`time_of_day`, `tz`, `weekday`, `channel='email'`, `enabled=true`), **and**
   `count(*) == 3` (no duplicate landing from `ON CONFLICT DO NOTHING`).

Would it catch a broken re-derivation? Yes — if the re-up produced a different
kind set, dropped a row, mutated a default, or double-inserted, one of the
`set(second) == …`, per-field, or `count == 3` asserts fails. The step-2 empties
assertion prevents a false pass where `down` silently left rows in place. Matches
the round-trip bar 062/063 already meet. **FIXED.**

### R2 NIT — BIGINT `deliveryId` typed `number` (real latent bug) — **FIXED, end-to-end**
`notification_deliveries.id` and `notification_schedules.id` are both
`BIGINT GENERATED ALWAYS AS IDENTITY` (052:156, 052:68); node-postgres returns
BIGINT as a **string** and there is no global type-parser override
(`server/src/db/pool.ts`). Verified the `string` type flows end-to-end with **no
remaining `number` coercion** on the returned id:
- `ClaimDeliveryResult.deliveryId: string | null` (was `number | null`) — `notificationDelivery.ts:52`.
- Query generic `query<{ id: string }>` (was `{ id: number }`) — `:72`.
- `return { claimed: true, deliveryId: row.id }` — `row.id` is `string`, no cast — `:87`.
- `settleDelivery(deliveryId: string, …)` (was `number`) — `:108`; bound as `$4` — `:118`.
- Test pins it: `expect(typeof result.deliveryId).toBe('string')`
  (`notificationDelivery.test.ts:77`), and the no-op settle test passes the
  BIGINT-shaped string `'999999999999'` (`:223`).
- Repo-wide grep confirms **zero callers outside this module + its test**, so
  there is no downstream `number` coercion to leak — consistent with R1/R2
  "no sender wired yet."

**FIXED, and a test pins the string type.** (New NIT below on the sibling input param.)

### R1 SHOULD-FIX #1 — 064 down-imprecision — **DEFERRED as F-194 (correct)**
- `064...down.sql:26–35`: the comment now states the imprecision is ACCEPTED +
  ROLLBACK-ONLY (`--allow-destructive`, never the forward path), sketches the
  precise fix (tag inserted rows / side-table log), and **references F-194**.
  Diff shows **only the comment block changed** — no DELETE predicate, no DDL,
  no logic redesign smuggled in.
- `BUGS_AND_FEATURES.md`: **F-194** filed (P3, 🔴 open, Category DATABASE) under a
  new "Phase B2a follow-up tickets" section, with What / Fix-hint / Notes that
  match R1's finding verbatim in substance. **Correctly deferred + tracked.**

### R2 NIT — redundant `status: 'pending'` in the claim INSERT — **INTENTIONALLY KEPT (no behavior change)**
Not removed; kept with an explaining comment (`notificationDelivery.ts:73–76`)
documenting it as the "keep + comment why" branch — the value equals the column
default (052:161), so the row's initial state is self-documenting at the call
site. Inert either way; no behavior change. Acceptable disposition (R2 itself
said "No action needed").

### No regression + migration safety still holds — **CONFIRMED**
- **No migration DDL changed.** `git diff fe73c0c..4563c03 -- 'db/migrations/*.up.sql'`
  is empty; the only migration-file change is the 064 **down** comment. So R1's
  live-DB-safety verdict is untouched: 063 remains empty-table-safe / fails
  atomically on a populated table, and 064 remains idempotent + `jsonb_typeof`-guarded.
- **PRAISE items intact.** F-088 explicit destructive marker (`migrate.py`) —
  unchanged in this fix-pass. F-092 atomic `INSERT … ON CONFLICT DO NOTHING`
  claim — SQL body unchanged (only the surrounding TS types + a comment moved).
  064's `jsonb_typeof` guards — untouched. The 8-way concurrency test, the
  settle "unclaimed" guard test, and the F-192 diagnostic pins — all unchanged
  and still pass in the full server run.

## New findings (this re-review)

### NIT (new, non-blocking) — `claimDelivery`'s input `scheduleId` is still typed `number`, but `notification_schedules.id` is BIGINT
`claimDelivery(scheduleId: number, …)` (`notificationDelivery.ts:69`). The
schedule id it references is `BIGINT` (052:68); a future sender that reads due
rows from `notification_schedules` will receive `id` as a **string** from
node-postgres, then be forced to `Number(id)` to satisfy this param — the exact
precision-loss coercion the fix-pass just eliminated on the `deliveryId` output
side, reintroduced on the input side. **Non-blocking:** there are zero callers
today (primitives-only PR), it is a caller-supplied bind param (not a
DB-returned value), and values are well within safe-integer range for the
foreseeable future. Recommend typing `scheduleId: string` for symmetry before a
sender is wired, or filing it alongside F-194. Not a reason to hold this batch.

## Full gate (all run to completion)

| Gate | Command | Result |
|------|---------|--------|
| server typecheck | `npm run typecheck` (`tsc --noEmit`) | **0 errors** |
| server lint | `npm run lint` | **0 errors**, 73 pre-existing warnings (all `no-non-null-assertion`; none in `notificationDelivery.ts`) |
| server tests | `npx vitest run` (full testcontainer suite) | **1346 passed, 4 skipped** / 58 files passed, 1 skipped; exit 0; 1635s. (Zod-parse `error` log lines are expected negative-path assertions.) |
| DB migrations | dockerized `python:3.12` testcontainers: `pytest db/tests --ignore=…test_discriminator_coverage.py -p no:cacheprovider -q` (up+down) | **110 passed** in 520.16s (was 109 at R1 baseline; +1 = the new 064 round-trip test) |
| client typecheck | `tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| client lint | `npm run lint` (`eslint .`) | **0 errors** |
| client tests | `npx vitest run` | **1962 passed** / 117 files (see flake note) |
| client build | `npx vite build --outDir /tmp/km-b2a-rr` | **built OK** (604ms, PWA precache 15 entries); exit 0 |

**Client flake note (not a regression):** the first full client run reported
`1 failed | 1961 passed` at `ReviewDictionary.test.tsx:250` (an
`aria-pressed` query). `ReviewDictionary.test.tsx` is **not touched by B2a**
(B2a's only client files are `Settings.tsx` + `Settings.test.tsx`). Re-running
that file in isolation → **18/18 pass**; a clean full-suite re-run → **1962/1962
pass, 0 failures**. Classic parallel test-pollution flake in an unrelated file,
pre-existing to this branch — not introduced by the fix-pass.

## Recommendation

**Ready to ship.** Both SHOULD-FIX resolved (one code+doc fix with a genuine
round-trip test, one correctly-scoped deferral tracked as F-194), both NITs
handled, BIGINT `deliveryId` fixed end-to-end with a pinning test, no migration
DDL changed (R1 safety verdict stands), all PRAISE intact, and the full server +
DB + client gate is green. **Follow-up (non-blocking):** type `scheduleId` as
`string` for BIGINT symmetry before a sender consumes these primitives — fold
into F-194 or a sibling ticket. No further fix-pass required.
