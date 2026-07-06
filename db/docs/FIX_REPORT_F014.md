# FIX REPORT — F-014 fix-pass (post-review, commit base a8ff23b)

Fixer = independent (did not author or review F-014). Reader = re-review agent.
3 SHOULD-FIX + 1 trivial nit dispatched. PRAISE'd behavior untouched (verified below).

---

## SF-1 (R1, backend) — plan.ts writing SELECT lacked `rubric IS NOT NULL` → **FIXED**

- `server/src/routes/plan.ts` writing SELECT (~line 307): `WHERE is_active` → `WHERE is_active AND rubric IS NOT NULL`. Now structurally mirrors `GET /writing/prompts` (`server/src/routes/writing.ts:92-93`) — operator re-activating a legacy rubric-NULL row can no longer reopen tile-vs-screen mismatch. Comment block above the query documents the invariant + why both queries enforce it.
- Test-fixture tail (reviewer's N-4, required by SF-1): `server/tests/helpers/seed.ts` `seedWritingPrompt` grew `rubric?: 'topik_ii_53' | 'topik_ii_54' | null` option (default null = legacy shape; doc comment explains visibility consequence). INSERT now includes rubric column.
- Band-preference test (`server/tests/routes/plan.test.ts` "prefers a writing prompt whose band matches") now seeds rubric-tagged rows ('topik_ii_53'/'topik_ii_54') — would otherwise be filtered out by the fix.
- NEW test: `plan.test.ts` describe "rubric-NULL prompts are structurally excluded" — TRUNCATE bank CASCADE, seed ONE active rubric-NULL row, assert `/plan/today` writing === null while reading still resolves. Fails if `AND rubric IS NOT NULL` is ever dropped. Placed inside the must-run-LAST truncating section (it truncates the shared bank).
- Pre-existing invariants confirmed green: F-014 reconciliation test (plan.test.ts:284 area), band tests, empty-bank test — all pass (see verify).

## SF-2 (R1, backend) — out-of-contract grader score silently dropped attempt row → **FIXED (clamp at persist site + structured warn)**

- `server/src/routes/gradeWriting.ts` persist block: before INSERT, `totalScore = Math.min(Math.max(round(grade.totalScore), 0), round(grade.maxTotal))`. If clamped ≠ raw → `getLogger().warn({ correlationId, rawTotalScore, rawMaxTotal, persistedTotalScore }, 'grade-writing: grader returned an out-of-contract totalScore — clamped to [0, maxTotal] for persist')`. Grade RESPONSE untouched (raw grader output still returned); JSONB `result` snapshot keeps raw values (audit trail).
- Chose clamp-at-persist, NOT zod refine — per instruction + reviewer's own alternative: a `GradeResultSchema.refine(totalScore <= maxTotal)` would fail the whole paid grade. Route header comment updated to say clamp (not CHECK-trip) handles this arm.
- Best-effort try/catch retained unchanged for genuinely transient failures (DB down, FK on stale promptId) — FK-trip test still passes.
- NEW test: `server/tests/routes/gradeWriting.test.ts` "an out-of-contract totalScore (> maxTotal) is clamped + warned and STILL persists a row" — ephemeral app with claudeProxy override returning 31/30; swaps in a capture pino logger via `setLoggerForTesting` (restored in finally, symmetric with `teardownTestApp`). Asserts: 200 + response totalScore 31 (untouched); exactly 1 row, total_score=30, max_total=30; result JSONB totalScore=31; warn fired with rawTotalScore=31 / rawMaxTotal=30 / persistedTotalScore=30. CHECK-trip arm no longer untested.

## SF-3 (R2, ratelimit) — 429 retry_after test blind to ms-vs-s regression → **FIXED**

- `server/tests/routes/gradeWriting.test.ts` (429 test): added `expect(retryAfter).toBeLessThanOrEqual(60)` + comment. 60 = actual limiter window (`tests/helpers/app.ts` sets `RATE_LIMIT_WINDOW_MS='60000'`). A dropped `/1000` now yields ~59_000 → fails.
- Also applied reviewer's parenthetical: same one-line bound at `server/tests/auth.test.ts` (~line 159) auth-limiter 429 test (same 60s window). auth.test.ts re-run: 22/22 pass.

## Nit (R3, frontend) — dead `promptsCtrlRef` in Writing.tsx → **FIXED (verified dead first)**

- Verified before removing: ref appeared ONLY at declaration + top-of-effect abort/assign (3 lines, grep-confirmed); effect cleanup `() => ctrl.abort()` runs before every re-run and on unmount (React guarantee), so the top-of-effect `promptsCtrlRef.current?.abort()` always hit an already-aborted controller; `retryPrompts` only bumps `promptsTick`. Genuinely load-bearing-free → removed ref + both lines; left a 2-line comment stating why no ref is needed. `useRef` import stays (grade-submit `ctrlRef` still uses it). Ttmik's copy of the idiom deliberately NOT touched (out of F-014 scope, per reviewer's own note it's an idiom-wide cleanup).
- Other R3 nits: **DEFERRED** per fix-pass scope instruction (out of scope).

## PRAISE'd behavior — untouched
- Outage-vs-empty ordering (Today.tsx): no client file touched except Writing.tsx dead-ref removal.
- No-fabricated-promptId: Writing.tsx fetch/submit logic unchanged; full Writing.test.tsx suite passes.
- retry_after single-source-of-truth: `rateLimits.ts` untouched; only test assertions strengthened.
- FK failure isolation: try/catch + FK-trip test unchanged, still passing.

---

## VERIFY (all green)

Server (dockerized node:20-slim + testcontainers Postgres, prescribed command):
```
STC=0
Test Files  3 passed (3)    # plan.test.ts + gradeWriting.test.ts + writing.test.ts
Tests       44 passed (44)  # was 42 pre-fix → +2 new tests (SF-1 exclusion, SF-2 clamp)
Duration    40.71s
```

Server auth.test.ts (touched by SF-3 parenthetical), same harness:
```
Test Files  1 passed (1)
Tests       22 passed (22)
```

Client (prescribed command):
```
TC=0
LINT=0   # eslint: 0 errors / 0 warnings
vitest run src/pages/Writing.test.tsx → pass (exit 0), 1.36s
```

## Files changed
- `server/src/routes/plan.ts` — SF-1 query + comment
- `server/src/routes/gradeWriting.ts` — SF-2 clamp + warn + comment
- `server/tests/helpers/seed.ts` — `seedWritingPrompt` rubric option (SF-1 tail / N-4)
- `server/tests/routes/plan.test.ts` — band test rubric-tagged; NEW structural-exclusion test
- `server/tests/routes/gradeWriting.test.ts` — NEW clamp/warn test; SF-3 upper bound; imports (pino, randomUUID, logging hooks)
- `server/tests/auth.test.ts` — SF-3 upper bound (one assertion)
- `client/src/pages/Writing.tsx` — dead `promptsCtrlRef` removed
