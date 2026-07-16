# REVIEW — batch2 server/db (F-122 migration 066, F-105 attemptId)

Reviewer: independent backend + DB review (server/migration side only). Did not write this code.

Branch: `worktree-agent-ace5c3eb73f48dcb9` @ `bc62eb7`, diffed against `rebuild` (`server/`, `db/`).

## Verdict: PASS

0 BLOCKERS, 2 SHOULD-FIX, 2 NIT, several PRAISE-worthy items. This is careful, senior-level work — the migration correctly handles a populated live table, the level-resolution design is genuinely authoritative (server-verified against real corpus rows, not a client echo trusted blindly), and the F-105 join is a plain column read with no join-multiplication risk. The two SHOULD-FIX items are both about `PUT /topik/attempt`'s optional `topikLevel` having no server-side cross-check against `(sourceTest, section)` — low blast radius (self-corrects at `/mock/submit`, no privilege/authorization implication) but worth tightening or at least covering with a test.

## Gate results

- `cd server && npm run typecheck` — clean, no errors.
- `npx vitest run tests/routes/topik.test.ts` — **111 passed** (1 test file).
- DB suite (dockerized, run once): `pytest db/tests/test_migration_066.py db/tests/test_migrations.py --ignore=db/tests/test_discriminator_coverage.py` — **35 passed**.

## BLOCKER

None.

## SHOULD-FIX

**SF-1. `PUT /topik/attempt`'s optional `topikLevel` is persisted with no server-side verification that it actually pairs with the given `(sourceTest, section)` in the corpus.** `server/src/routes/topik.ts:1103` (`b.topikLevel ?? null`) writes straight into the upsert's `$8` → `topik_level` column. Contrast with `/mock/submit`, where `resolved.topikLevel` always comes back from `resolveMockTest` — a real DB row (`t.topik_level` selected from `topik_tests`), never a value merely echoed from the request body (`topik.ts:1578`, `:1424-1436`). `PUT /topik/attempt` has no equivalent: a client could send `sourceTest: 4100, section: 'reading', topikLevel: 'TOPIK I'` even if `4100`'s reading section is actually only `'TOPIK II'`. The migration/route doc comments (066 up.sql lines 61-76, `topik.ts:1051-1063`) call this out explicitly and argue it's benign ("not a new IDOR/tamper surface... only affects which paper a later re-fetch resolves to") — and functionally that's correct: a mismatched level just makes `resolveTotalItemsForLevel` find 0 matching rows for `GET /topik/attempt`, which then falls back to `Math.max(0, answered) = answered` (graceful degradation, not a crash or a false authorization), and it's fully overwritten by the authoritative `/mock/submit` stamp at completion regardless. So this is not a security bug, but it does mean the migration's own "authoritative, not a guess" framing is only true for the `/mock/submit` writer — the `PUT` writer's value is unverified input, and the docs should be a little more careful not to blur that line (they mostly are, but "the client only ever echoes back a level the SERVER resolved" is a client-behavior assumption, not something this endpoint enforces). Consider either (a) a cheap server-side cross-check (`resolveMockTest(section, sourceTest, topikLevel)` returns non-null) before accepting the client value, or (b) leaving as-is but tightening the doc to say "unverified but low-risk" rather than implying enforcement.

**SF-2. No test exercises the "client sends a topikLevel that doesn't actually match sourceTest/section" case on `PUT /topik/attempt`.** The three new F-122 tests in `server/tests/routes/topik.test.ts:931-1052` cover (a) explicit-and-correct level, (b) omitted level, (c) submit always overwrites — but not a client-supplied *wrong* level on the PUT path, which is exactly the scenario SF-1 is about. Given the design explicitly accepts this input with no re-validation, a test asserting the documented graceful-degradation behavior (mismatched level → `GET /topik/attempt` still returns something sane, e.g. `totalItems === answered`) would lock in the intended behavior and make future refactors safer.

## NIT

**N-1. Redundant `IS NULL OR` in the CHECK constraint.** `066_topik_attempts_level.up.sql:108`: `CHECK (topik_level IS NULL OR topik_level IN ('TOPIK I', 'TOPIK II'))`. Postgres already treats a `NULL` result from a CHECK expression as passing (three-valued logic — `NULL IN (...)` evaluates to `UNKNOWN`, which does not violate the constraint), so the bare `CHECK (topik_level IN ('TOPIK I','TOPIK II'))` would have been equivalent. Not a bug — arguably better for readability/self-documentation — just flagging that the explicit `IS NULL OR` isn't structurally necessary, unlike e.g. a `NOT NULL`-adjacent column where it would matter.

**N-2. `GET /topik/attempts`' sequential-await loop (`topik.ts:1321-1345`) calls `resolveTotalItemsForLevel`/`resolveServedTotal` once per row**, same pattern as before this change (already called out in the file's own comment as an accepted personal-single-user-app tradeoff). No new concern introduced by this diff — restating only because the diff grew the branching inside that loop; still bounded (`limit` max 100) and already documented as intentional.

## PRAISE

**P-1. Migration 066 is genuinely safe against the live populated table.** `ADD COLUMN IF NOT EXISTS topik_level TEXT NULL` (no default, no `NOT NULL`) plus a `CHECK` that explicitly permits `NULL` means every existing row in the live `topik_attempts` passes the constraint automatically — confirmed both by reading the SQL and by the DB test suite (`test_066_re_up_is_clean_even_with_existing_rows`, `test_066_topik_level_accepts_null_and_both_real_levels`), which is exactly the right thing to assert given this table has real production rows. The `DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint ...) $$` guard around `ADD CONSTRAINT` makes the up-migration idempotent against a partial-apply retry, matching the `IF NOT EXISTS` on the column add.

**P-2. Down migration is correctly marked destructive despite the legacy keyword-sniff not being able to catch it.** `066_topik_attempts_level.down.sql:7,13-17` explicitly documents that `DROP COLUMN` has no `DROP TABLE`/`TRUNCATE` keyword for the sniff to catch, and marks it destructive anyway via the explicit `-- migrate: destructive` marker (F-088). Verified by `test_066_marker_classification` and `test_066_down_requires_allow_destructive_then_drops_column`, which assert the gate actually refuses without `--allow-destructive`.

**P-3. The 065 numbering gap is genuinely harmless.** Confirmed by reading `db/migrate.py`: migration discovery (`discover_migrations`, `sorted(migrations_dir.iterdir())`) operates only over files that exist on disk in the target `--migrations-dir`; there's no sequential-numbering assertion. 066 depends only on 037 (`topik_attempts`) and 029 (the natural-key widening referenced in the doc comment), neither of which is 065. The `test_migration_066.py` fixture copies exactly `{001, 037, 066}` into an isolated tmp dir and the chain applies cleanly — no cross-migration coupling to the reserved-but-absent 065.

**P-4. `resolveMockTest`'s resolution is authoritative, not a client-trusted guess.** `topik.ts:1424-1436` resolves against real `topik_tests`/`topik_items` rows filtered by `requestedLevel` (when supplied) and `requestedTest`; the returned `{sourceTest, topikLevel}` is always a value read back off the matched DB row (`t.test_number`, `t.topik_level`), never the raw request-body value passed through. `/mock/submit` stamps `resolved.topikLevel` unconditionally on both the close-active-UPDATE and fresh-INSERT branches (`topik.ts:1663-1686`), overwriting whatever the in-progress row said — this is the crux of F-122 and it holds up under inspection: a completed attempt's level can never be a fabricated guess.

**P-5. F-105's `attemptId` addition is a plain column select, no join risk.** `topik.ts:709-719`: `r.attempt_id::text AS attempt_id` is read directly off `topik_responses` (already `JOIN`ed on `topik_items`/`topik_tests`, unrelated to `attempt_id`) — there's no join to `topik_attempts` at all, so no row-multiplication concern exists for this DTO field. `NULL` correctly falls out for study-mode misses (`attempt_id` is nullable on `topik_responses` since migration 046, confirmed at `db/migrations/046_*.up.sql:138`) with no special-casing needed in the route. New test `topik.test.ts:879-923` asserts study→null, mock→real id.

**P-6. `Math.max(resolved, answered)` is correctly applied in every branch (both `GET /topik/attempt` and `GET /topik/attempts`), preserving the pre-existing "never report fewer items than were actually answered" invariant** even in the new real-persisted-level branch, not just the legacy-guess branch. Verified this holds symmetrically at `topik.ts:1002-1007` and `topik.ts:1330-1336`.

**P-7. The NOT-backfilled decision is well-reasoned and documented, not just asserted.** The up.sql header and column `COMMENT` both explain concretely *why* backfilling would misrepresent a guess as fact (indistinguishable from a real value to a future reader) rather than just stating the policy — this is the right call: the only candidate backfill value is the same tie-break the route already runs at read time, so writing it in would add nothing but false confidence.

## Detailed notes

- Migration numbering table (`db/migrations/README.md:134-135`) correctly documents 065 as reserved by a concurrent (Vocab) batch and describes 066 accurately including the authoritative-writer/optional-echo distinction.
- Parameter binding in the `PUT /topik/attempt` upsert (`topik.ts:1074-1104`) is correct: the `SELECT $1, $2::topik_section, $3, $4, $5::jsonb, $6, $8` column list matches the 7 target columns using params 1-6 and 8 (param 7 is used only in the `WHERE NOT EXISTS` grace-window clause) — verified the array position math lines up (`[userId, section, sourceTest, currentIdx, JSON.stringify(picks), remainingMs, GRACE_SECONDS, topikLevel ?? null]`).
- `topik_level = EXCLUDED.topik_level` (unconditional, no `COALESCE`-preserve) is deliberate and correctly documented: preserving a stale level across a same-row repurposing (the pre-existing "KNOWN DATA GAP" where starting a new mock reuses the active row for a different `(source_test, section)`) would be actively wrong, since the old level belongs to the displaced paper, not the new one.
- All new/changed queries are parameterized (`$1`/`$2`/... placeholders); no string-interpolated user input anywhere in this diff. The only string-interpolated SQL fragments (`LIMIT ${OFFICIAL_MOCK_SECTION_SIZE}`, `${ANSWERABLE_ITEM_SQL}`) are server-side constants, not request-derived.
- No swallowed errors observed — both routes route to `next(err)` on catch, migration failures propagate `rc != 0` and are asserted in tests.
- Tests exercise real behavior: the F-122 route tests seed genuinely colliding papers (same `test_number`, both levels) to prove the tie-break-guess bug the column fixes would otherwise misreport — not a toy fixture. The DB tests use a real Postgres testcontainer and the actual migration files (not fixtures reimplementing the SQL), consistent with the existing `test_migration_063.py` pattern.
