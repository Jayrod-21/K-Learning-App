# RE-REVIEW — F-014 fix-pass verification (base a8ff23b + uncommitted fixes)

Re-reviewer: independent (did not author the feature, the three reviews, or the fixes).
Inputs: `REVIEW_F014_{backend,ratelimit,frontend}.md`, `FIX_REPORT_F014.md` (treated as
claims to verify, not facts), the uncommitted working-tree diff (7 files, +172/−14),
and the code itself. All suites re-run independently in the prescribed Docker harness,
and — beyond re-running — **each of the three SHOULD-FIX tests was mutation-verified**:
I reverted the corresponding fix in source, confirmed the new test fails with the
exact regression signature, and restored the tree (md5-verified byte-identical after).

## VERDICT: **PASS** — ship (commit as-is)

All 3 SHOULD-FIX: **FIXED**. R3 nit: **FIXED**. Regressions: **none found**.
Praised behavior: **all intact**. Fix report claims: accurate on every point I checked,
including the test counts.

| Finding | Status | Regression-catching proven? |
|---|---|---|
| SF-1 (plan.ts rubric filter) | FIXED | Yes — mutation run |
| SF-2 (persist clamp) | FIXED | Yes — mutation run |
| SF-3 (429 ≤60 bound) | FIXED | Yes — mutation run |
| R3 nit (dead `promptsCtrlRef`) | FIXED | Traced + lint/tests clean |

---

## Finding-by-finding

### SF-1 — `/plan/today` writing SELECT missing `rubric IS NOT NULL` → **FIXED**

- **Filter present**: `server/src/routes/plan.ts:307` — `WHERE is_active AND rubric
  IS NOT NULL`, with a comment block (lines 292–297) documenting the invariant and
  why BOTH queries (plan.ts + writing.ts) enforce it structurally. Mirrors
  `GET /writing/prompts` exactly as the reviewer prescribed.
- **New test is genuinely discriminating — mutation-proven.** I removed the
  `AND rubric IS NOT NULL` line from plan.ts and re-ran `plan.test.ts`: exactly the
  new test fails (`AssertionError: expected { …(4) } to be null`), the other 13 pass.
  So the test pins the QUERY SHAPE, not the data state — an operator re-activating a
  legacy row can no longer silently reopen the tile-vs-screen mismatch without a red
  test.
- **Placement is correct.** The new describe (`plan.test.ts:344`) sits inside the
  documented must-stay-LAST truncating section (comment at lines 313–319), after the
  band-preference test and before the empty-corpus test. The only test that runs
  after it (empty corpus, line 371) truncates the bank itself, so the new test's
  TRUNCATE cannot corrupt anything. The non-truncating F-014 reconciliation test
  (line 284) runs before the section and still passes.
- **The test also asserts `body.reading` is non-null**, proving the exclusion is
  writing-scoped rather than the route erroring out wholesale — a nice touch.
- **`seedWritingPrompt` ripple: none.** Repo-wide grep finds callers only in
  `plan.test.ts` (lines 329, 330, 354). The two band-preference callers were updated
  to pass explicit rubrics — REQUIRED, not cosmetic: with the default `rubric: null`
  they would now be filtered out and that test would fail (the green run confirms
  the update is correct and sufficient). The helper's new doc comment
  (`server/tests/helpers/seed.ts:328–332`) states the visibility consequence of the
  NULL default plainly. No production code references the helper.

### SF-2 — out-of-contract grader score silently drops the attempt row → **FIXED**

- **Clamp at persist site**: `server/src/routes/gradeWriting.ts:87–108` —
  `totalScore = Math.min(Math.max(round(totalScore), 0), round(maxTotal))` computed
  BEFORE the INSERT, with a structured `warn` (correlationId, rawTotalScore,
  rawMaxTotal, persistedTotalScore) when clamping occurred. The reviewer offered
  refine-or-clamp; clamp was the right pick (a zod refine would fail the whole paid
  grade), and the comment explains that trade-off in place.
- **The response is still the raw grader output** — `res.status(200).json(result)`
  serializes the untouched proxy result; the test asserts `result.totalScore === 31`
  in the body. **The JSONB snapshot is raw** — `JSON.stringify(grade)` of the
  unmodified object; the test asserts `result.totalScore === 31` in the persisted
  row's JSONB. Only the CHECK-constrained integer columns are normalized. Audit
  trail intact.
- **The new test DEFINITIVELY mutation-catches the silent drop.** I replaced the
  clamp with `const totalScore = rawTotalScore;` and re-ran: the new test fails with
  `AssertionError: expected [] to have a length of 1 but got +0` — i.e. it observed
  precisely the pre-fix behavior (CHECK trip → best-effort catch → row vanishes) and
  rejected it. The remaining 15 gradeWriting tests (FK-trip isolation included)
  stayed green under the mutation, confirming the test isolates this exact arm.
- **Test hygiene**: ephemeral app (`overGrader`) + `teardownTestApp` in `finally`;
  the process-global logger swap (`setLoggerForTesting`) is restored in the same
  `finally`. Safe under vitest's sequential in-file execution. (See NOTE-2.)
- **New failure modes probed — none material.** `GradeResultSchema.maxTotal` is
  `z.number().positive()`, so a negative max is impossible at this code; a
  pathological fractional `maxTotal < 0.5` would round to 0 and trip
  `ck_writing_attempts_max_total_positive` → best-effort catch drops the row — the
  same posture as pre-fix, and unreachable for real rubrics (30/50). The series
  division (`total_score * 100.0 / max_total`) reads the stored `max_total`, which
  the CHECK guarantees > 0 — no divide-by-zero introduced. Clamp of a negative
  rounded raw (schema forbids it anyway) floors at 0, inside the range CHECK.

### SF-3 — 429 test blind to a ms-vs-s regression → **FIXED**

- **Assertion present in both places**: `server/tests/routes/gradeWriting.test.ts:329`
  and `server/tests/auth.test.ts:157–161` (the reviewer's parenthetical extra) —
  `expect(retryAfter).toBeLessThanOrEqual(60)` with accurate comments.
- **60 IS the actual window.** `server/tests/helpers/app.ts:274` sets
  `RATE_LIMIT_WINDOW_MS='60000'`, and all four limiters (verified in
  `rateLimits.ts`) build from `cfg.RATE_LIMIT_WINDOW_MS` and pass the same value as
  the handler's fallback — so the bound applies identically to the expensive and
  auth limiters the two tests exercise.
- **The assertion DEFINITIVELY catches the units regression.** I dropped the
  `/ 1000` from `rateLimitedHandler` and re-ran: the 429 test fails with
  `AssertionError: expected 59882 to be less than or equal to 60`. Not vacuous.
- **No flake risk from the bound**: with MemoryStore's fixed window,
  `resetTime − now ≤ windowMs` by construction, so correct code yields ≤ 60 always
  (the missing-resetTime fallback yields exactly 60, still passing).

### R3 nit — dead `promptsCtrlRef` in Writing.tsx → **FIXED, genuinely dead**

- Traced the effect (`client/src/pages/Writing.tsx:178–204`): the controller is a
  local `const ctrl`, and the cleanup `() => ctrl.abort()` is returned from the
  effect — React runs it before every re-run (rubric change, `promptsTick` bump)
  and on unmount. The removed ref was written at declaration and
  top-of-effect only, read nowhere else (`retryPrompts` just bumps the tick), so
  its `?.abort()` always hit an already-aborted controller. Removal cannot weaken
  abort-on-rubric-change or abort-on-unmount — the cleanup alone owns both, and a
  2-line comment now says so.
- `useRef` import retained and still needed (`ctrlRef` for grade submit, line 223).
- The Ttmik copy of the idiom was correctly left alone (out of F-014 scope, per the
  reviewer's own note).
- No new `react-hooks/set-state-in-effect` or `react-hooks/refs` issues: the
  pre-existing, reviewer-accepted disable block is unchanged (still exactly the 3
  kickoff setState calls), both remaining refs are touched only in effects/
  callbacks, and `eslint .` reports 0 errors / 0 warnings.

---

## Praised behavior — verified intact

- **Outage-vs-empty ordering (Today.tsx)**: file untouched by the diff; only
  client change is the Writing.tsx ref removal.
- **No fabricated promptId**: Writing.tsx fetch/submit/task-derivation logic
  unchanged; the wire-body test still pins `{ prompt, sample, rubric, promptId }`
  via `toEqual`; Writing.test.tsx 13/13 green.
- **retry_after single source of truth**: `rateLimits.ts` untouched (test-only
  strengthening); header==body assertion still present alongside the new bound.
- **FK failure isolation**: try/catch structure unchanged (clamp lives inside the
  same try); the FK-trip test is untouched and passed in every run, including under
  the SF-2 mutation.

## Independent suite runs (prescribed Docker harness)

- Server: `tsc --noEmit` → `STC=0`; `plan + gradeWriting + writing + auth` →
  **66/66 passed** (14 + 17 + 13 + 22; matches the fix report's 44 + 22, +2 new
  tests over the original reviews' 42).
- Client: `tsc --noEmit` → `TC=0`; `eslint .` → 0 errors / 0 warnings;
  `Writing.test.tsx` → **13/13 passed**.
- Mutation runs (all restored afterward; final tree md5-verified identical to the
  fix-pass diff): SF-1 → 1 targeted failure; SF-2+SF-3 combined → exactly the 2
  targeted failures, 15/17 others green.

## New findings (non-blocking)

- **NOTE-1 (informational)**: a grader `maxTotal` in (0, 0.5) would round to 0 and
  trip `ck_writing_attempts_max_total_positive`, dropping the row via the
  best-effort catch — the one residual systematic-drop arm. Schema already forbids
  non-positive values and real rubrics are 30/50; not worth code. Mention only so a
  future rubric change keeps `maxTotal ≥ 1`.
- **NOTE-2 (informational)**: the SF-2 test's `setLoggerForTesting` swap is
  process-global. Correct today (vitest runs tests within a file sequentially;
  restore is in `finally`), but if this file ever opts into concurrent tests the
  capture logger could observe unrelated warns. No action needed now.

## Recommendation

**SHIP.** Commit the working-tree fixes as they stand. No further fix-pass needed.
The three fixes are exactly what the reviews prescribed, each new test is
mutation-proven to catch its regression (none are vacuous), the fixture change has
no ripple beyond the two intentionally updated callers, and nothing the original
reviews praised was disturbed.
