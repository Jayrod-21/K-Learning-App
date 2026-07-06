# Independent Review — F-014 DB + Persistence Slice (commit a8ff23b)

Reviewer: independent senior reviewer (did not author this change).
Scope: migration 038, `server/src/routes/writing.ts`, the persistence side-effect in
`server/src/routes/gradeWriting.ts`, and the server tests
(`writing.test.ts`, `gradeWriting.test.ts`, `plan.test.ts` writing bits, `helpers/seed.ts`).
Suites executed: `tests/routes/{writing,gradeWriting,plan}.test.ts` in the Dockerized
node:20 + testcontainers harness — **42/42 passed** (101.96s).

## Verdict

**APPROVE — no blockers.** 0 BLOCKER, 2 SHOULD-FIX, 4 NIT, 5 PRAISE.

The two highest-risk areas named for this review are both sound:

1. **New-FK blast radius: CLEAN.** A repo-wide grep (excluding `.claude/worktrees`)
   for `TRUNCATE`/`DELETE` touching `writing_prompts` finds exactly two TRUNCATE
   sites, both in `server/tests/routes/plan.test.ts` (lines 326, 347), and both were
   converted to `... CASCADE` in this commit. The only `DELETE FROM writing_prompts`
   anywhere is 038's own down migration. No Deploy script, loader, or other test
   touches the table; `plan.ts` and `writing.ts` only SELECT; the only FK referrer to
   `writing_prompts` in any migration is 038's own `fk_writing_attempts_prompt`.
   `helpers/seed.ts:314-330` doc updated to mandate CASCADE. Nothing else breaks.

2. **Save-on-grade failure isolation: SOUND.** `gradeWriting.ts:80-108` wraps ONLY
   the INSERT in its own try/catch — the `res.status(200).json(result)` sits outside
   it, and the catch logs (with correlation id) and falls through. A persist failure
   of any kind (FK violation on a stale `promptId`, CHECK trip, DB down) cannot fail
   the paid grade response. This is not just claimed — it is proven by a test that
   trips the real FK (`gradeWriting.test.ts` "persist failure does NOT fail the
   grade", promptId 987_654_321 → 200 + valid grade + zero rows persisted).

---

## Findings

### SHOULD-FIX

**SF-1. `/plan/today`'s writing SELECT does not enforce the reconciliation invariant
— `plan.ts` can advertise a prompt `/writing/prompts` will never serve.**
`server/src/routes/plan.ts:299-306` — the Writing-branch query filters only
`WHERE is_active`. The F-014 goal ("tile and screen draw from the same pool") holds
today purely by DATA state: migration 038 deactivated every rubric-NULL row. But
migration 013's own design notes frame `is_active` flips as the normal operator
lifecycle for this reference table ("retirement is a non-destructive
`is_active = FALSE` flip"). The moment anyone re-activates one of the 8 legacy
register-drill rows, `/plan/today` can advertise it while `GET /writing/prompts`
(which correctly filters `rubric IS NOT NULL`, `writing.ts:106-110`) never serves it
— the exact tile-vs-screen mismatch F-014 was built to close, silently reopened.
The asymmetry is even acknowledged on the writing.ts side ("even if an operator
re-activated a legacy row, it could never surface here") without closing the plan.ts
side. Fix is one line: add `AND rubric IS NOT NULL` to the plan.ts writing SELECT.
Note the two plan.test band-preference tests seed via `seedWritingPrompt`, which
inserts rubric-NULL rows (`helpers/seed.ts:328-353`) — those tests would need the
helper to grow a `rubric` option (see NIT-4), which is why I rate this SHOULD-FIX
rather than a trivial follow-up: the fix has a small test-fixture tail.

**SF-2. `writing_attempts` rows are silently dropped when the grader emits an
out-of-contract score — logged, but invisible to the user and untested.**
`gradeWriting.ts:80-108` + `038_writing_attempts.up.sql` CHECKs. `GradeResultSchema`
(`services/claude/models.ts:172-189`) constrains `totalScore` only to
`nonnegative()` — there is no cross-field `totalScore <= maxTotal` refinement. A
grader response of e.g. 31/30 passes the zod output parse, gets returned to the user
as a valid grade, but trips `ck_writing_attempts_total_in_range` and the attempt
vanishes from history/series with only a server log line. That is the designed
best-effort posture and I accept it for DB failures — but for a *grader contract*
violation the row loss is systematic (every such grade, not a transient), and
nothing tests the CHECK-trip path (the failure-isolation test only exercises the FK
arm). Either add `.refine(r => r.totalScore <= r.maxTotal)` to `GradeResultSchema`
so the contract is enforced where the number is minted (turning it into an upstream
error), or clamp at the persist site — and add a test for whichever is chosen.
Low likelihood, but it is the one place the persistence can silently and repeatedly
lose data while everything looks green.

### NIT

**N-1. Down migration re-activates ALL rubric-NULL rows, not the rows the up
deactivated.** `038_writing_attempts.down.sql:31` — `UPDATE writing_prompts SET
is_active = TRUE WHERE rubric IS NULL` restores prior state faithfully for the
shipped data (013 seeds all 8 rows with the `is_active DEFAULT TRUE`; no later
migration touches them — verified), but an operator-deactivated legacy row would be
wrongly resurrected by a rollback. The up's UPDATE doesn't record prior state, so
this is a known-lossy reversal. Acceptable for a single-user app; worth the one-line
comment it doesn't currently have (the header documents attempt-loss but not this).
Otherwise the down is notably well-constructed: DROP TABLE first (frees the FK),
DELETE the six 038-owned seed rows by exact `source_id` list with a correct
round-trip rationale (surviving rows would be re-retired by a re-up and dead-ended
by `ON CONFLICT DO NOTHING`), re-activation BEFORE the column drop, then constraint
+ column drop. Down→up is a true round trip.

**N-2. Idempotency posture inside 038 up is mixed.** `038_writing_attempts.up.sql:29-34`
— `ADD COLUMN IF NOT EXISTS` next to an unguarded `ADD CONSTRAINT
ck_writing_prompts_rubric`. If the guarded form ever mattered (partial re-run), the
constraint line would abort anyway. Moot under ADR-013 (runner wraps the body +
bookkeeping in one transaction, so partial application is impossible), but pick one
posture; the mixed form implies a tolerance the file doesn't actually have.

**N-3. `TRUNCATE writing_prompts ... CASCADE` in plan.test also truncates
`writing_attempts`.** `plan.test.ts:326,347` — CASCADE on TRUNCATE cascades to
*referencing tables*, so these calls now also empty `writing_attempts`. Harmless
today (no attempts exist in plan.test) and the tests correctly stay last-in-file,
but the comment explains only why CASCADE is *needed*, not what it *takes with it*.
One clause would prevent a future author from being surprised.

**N-4. `seedWritingPrompt` cannot seed a rubric-tagged row.** `helpers/seed.ts:328-353`
— rows it creates are rubric-NULL, hence permanently invisible to
`GET /writing/prompts`. Fine for its current plan.test callers, but a future
writing.test author reaching for the obvious helper gets a silent empty list. Add a
`rubric?` option (also unblocks SF-1's test tail) or a doc sentence.

### Judged and accepted (explicitly probed, not defects)

- **Cache-hit re-grade persisting another attempt row: INTENDED, accept.** B4 caches
  `grade_writing` (key = route + model + normalized system/user text,
  `services/claude/cache.ts:61-75`; TTL `CLAUDE_CACHE_TTL_GRADE_WRITING_S`). A user
  re-submitting the identical essay within TTL gets a cached grade and a second
  `writing_attempts` row. Each row corresponds to a real user submission with a real
  response — that is what an attempts log should record. Series impact is nil-to-benign:
  the identical essay yields the identical %, so a same-day duplicate cannot move the
  daily average; a later-day resubmit adds a truthful "practiced today" point. Not a
  defect. (The cache key is not user-scoped, but the persist is stamped from
  `getUserId(req)`, so a cross-user cache hit still lands in the right account.)
- **Rolling window vs calendar window.** `graded_at > now() - make_interval(days => $2)`
  means `days=30` can span 31 partial UTC dates and truncates the oldest day's average
  to in-window attempts. Identical to `/topik/series` (`topik.ts:592-599`) —
  consistency across the two charts is worth more than day-alignment. Accept.
- **Persist awaited before the response.** One indexed single-row INSERT appended to
  a multi-second Claude call — latency is noise; awaiting keeps the tested guarantee
  ("nothing persisted on failure") deterministic. Accept.

### PRAISE

**P-1. The series math test is genuinely discriminating.** `writing.test.ts`
("normalizes Q53 (/30) and Q54 (/50)...") — 21/30 + 40/50 same day must yield 75:
a raw-score average (61/80) gives 76, so per-attempt-normalization is pinned, not
assumed. 20/30 must yield 67: integer division or `trunc` gives 66, so the
`* 100.0` numeric path is pinned too. The route itself (`writing.ts:150-160`) gets
the classic trap right: `total_score * 100.0 / max_total` forces numeric division,
`round(...)::int`, `AT TIME ZONE 'UTC'` pinned in SELECT, GROUP BY *and* ORDER BY,
`to_char(..., 'YYYY-MM-DD')`. Q53/Q54 comparability is real because normalization
happens per-attempt before the daily avg, and `max_total` is *stored* per row rather
than derived from rubric — the series survives a future denominator change.

**P-2. Failure isolation is tested with a real constraint, not a mock.** The FK-trip
test (`gradeWriting.test.ts`) exercises the actual `fk_writing_attempts_prompt`
violation end-to-end and asserts both the intact 200 grade AND the zero-row state;
the upstream-error test asserts the negative (failed grade persists nothing). This
is exactly the "real corpus data, distrust looser schemas" lesson applied.

**P-3. Security posture is uniform and complete.** Every query in the slice is
parameterized through the pool wrapper (which enforces `$n` placeholders);
`requireAuth` at router level + both new GETs in the `routes.auth-required` matrix;
`/series` and the persist both derive the user exclusively from `getUserId(req)`,
with a cross-user IDOR test (100% vs 0% users cannot see each other); `promptId` is
edge-validated (`int/positive/MAX_SAFE_INTEGER`, non-integer/zero/string → 400
tested) and a well-formed-but-nonexistent id leaks nothing (persist-only failure,
logged — no enumeration oracle). `rubric` is a zod enum mirrored by DB CHECKs at
both tables; invalid rubric is a 400, never a silent empty list.

**P-4. Migration 038 is exemplary reference-data work.** CHECKs deliberately mirror
the `/grade-writing` zod bounds (prompt 1..2000, sample 1..5000) so DB and edge
cannot drift into the 500-on-valid-input failure mode; audit columns + trigger +
`(user_id, graded_at DESC)` index match the 037 conventions; `ON DELETE CASCADE`
(user) vs `ON DELETE SET NULL` + `prompt_kr` snapshot (prompt) are the right
lifetime semantics; seeds are idempotent via the 013 `uq_writing_prompts_source_id`;
levels/est_minutes fit 013's enum and 1..120 CHECK.

**P-5. Second-order effects were hunted, not stumbled into.** The plan.test CASCADE
fix, the seed.ts doc update, the auth-matrix additions, the nginx allow-list
(`/writing` in both color confs, per the km-lb allow-list rule), and the
plan.test reconciliation test (active pool entirely rubric-tagged + /plan/today
title drawn from it) all shipped in the same commit as the FK that made them
necessary.

---

## Test-adequacy summary (probe checklist)

| Probe | Covered? | Where |
|---|---|---|
| Persistence writes the right row (all contract fields, real seed prompt) | Yes | gradeWriting.test "successful grade with promptId..." |
| Q53+Q54 same-day blend → correct % (and rounding, and ascending order) | Yes | writing.test series normalization test |
| User-scoping / IDOR on new routes | Yes (series cross-user; prompts is shared reference data — nothing to scope) | writing.test IDOR test; auth-required matrix |
| days window (default 30, widen 90, 0/91 → 400) | Yes | writing.test window + boundary tests |
| Migration legacy-retirement (active pool all-tagged, tile draws from it) | Yes (data-level) | plan.test F-014 reconciliation test — but see SF-1: the query-level invariant in plan.ts is not pinned |
| Empty series → `[]`, invalid rubric → 400, deactivation, stable order, verbatim seed content | Yes | writing.test |
| Persist CHECK-trip arm | **No** | see SF-2 |
| Down migration executed | No (up-only harness; standard for this repo, down is well-reasoned on paper) | — |

Regression sensitivity is high: the tests assert exact point arrays, exact seed text
character-for-character, exact counts against the real 038 seed (no mocked
reference data), and both arms of the failure-isolation guarantee. A regression in
the series SQL, the persist wiring, the migration's retirement UPDATE, or the FK
blast radius would fail loudly.

## Suite run

```
docker run --rm --network host ... node:20-slim npx vitest run \
  tests/routes/writing.test.ts tests/routes/gradeWriting.test.ts tests/routes/plan.test.ts
Tests  42 passed (42)   Duration 101.96s
```
