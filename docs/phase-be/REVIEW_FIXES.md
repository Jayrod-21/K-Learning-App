# Phase 4 Re-Review — Fix-Pass Verification (Backend mini-phase, `feat/phase-be-lightup`)

**Reviewer:** independent re-reviewer (report-only, no code modified). Did not
author the original diffs, did not write the four original reviews, did not
perform the fix-pass. Verified the fix-pass commit `aabb454` against the 9
SHOULD-FIX findings in `REVIEW_topik.md`, `REVIEW_writing.md`,
`REVIEW_grammar.md`, `REVIEW_reading.md`, reading code directly and re-running
the relevant tests against real backends (Postgres-16 testcontainer via
Docker, real client vitest), not trusting `FIX_REPORT.md`'s claims at face
value.

## Verdict: **PASS**

All 9 SHOULD-FIX findings are genuinely fixed, with real (non-tautological)
regression coverage, verified by direct code read plus live test execution.
No regressions found. No security regression. The migration 056 amendment is
sound and correctly scoped. One new, very-low-severity gap is noted below
(not a blocker, not something the fix-pass introduced as a defect — a residual
edge the fix-pass's own report already disclosed honestly).

## Finding-by-finding table

| ID | Orig. severity | Status | Notes |
|---|---|---|---|
| TOPIK S-1 | SHOULD-FIX (correctness, the headline finding) | **FIXED** | `topikLevel` now threads end-to-end: `TopikTestSummary`/`ExamChooser.onPickExam(sourceTest, topikLevel)` → `goToView`'s new `level` URL param (correctly cleared whenever `exam` isn't a specific test_number) → `startSection(section, sourceTest, topikLevel)` → `fetchMockTest`'s new 4th arg → `POST /topik/mock` body → `resolveMockTest` (server-side, pre-existing, unchanged) → echoed back as `MockTest.topikLevel` (now a required field, not optional) → `ExamRunner.buildBody` echoes it unconditionally into `MockSubmitBody.topikLevel` on submit. `StartPage` now renders a visible `role="note"` disclosing the level. Verified genuinely fixed, not just plausible: built a throwaway git worktree at the pre-fix commit (`cb2c11a`), dropped in the new `MockMode.test.tsx`, and confirmed the new regression test **fails** against the un-fixed component (fails at the `role="note"` assertion — the disclosure element doesn't exist pre-fix), then confirmed it **passes** against the actual fixed code in this worktree. This is real evidence the test is not a tautology. |
| TOPIK S-2 | SHOULD-FIX (test-coverage gap) | **FIXED** | New test seeds a completed attempt, nulls the backing `topik_items.answer` (not a hard delete — avoids the `topik_responses` FK, exactly the "corpus edit" scenario the review described) so `resolveMockTest`/`resolveServedTotal` can no longer resolve a paper, and asserts `topikLevel: null` + `totalItems` falls back to the real answered count (1), never a fabricated total. Ran for real against the Postgres testcontainer: passes. |
| TOPIK S-3 | SHOULD-FIX (test-coverage gap) | **FIXED** | `fetchAttemptHistory`/`fetchAvailableTests` each get 4 unit tests mirroring the file's established shape (exact URL, params-object "omit undefined fields" behavior, envelope pass-through, per-opt forwarding). Ran for real: pass. |
| WRITING SF-1 | SHOULD-FIX (dead schema surface) | **FIXED (via migration 056 amendment)** | Migration 056 amended to widen **only** `ck_writing_attempts_rubric`; `ck_writing_prompts_rubric` is left at its narrow 038 two-value shape. Confirmed 056 does not exist anywhere on `origin/rebuild` (deploy target) — `git log origin/rebuild -- db/migrations/056_writing_rubric_widen.up.sql` returns nothing, and the file is absent from that tree entirely — so amending it in place is ADR-013-safe (never deployed, not even merged). Confirmed the amendment genuinely narrows surface, not widens it: `writing_prompts` can no longer accept `free_write` (correct — free-writes are Claude-generated via `POST /writing/generate`, never bank-drawn; grepped the whole server tree and confirmed `free_write` only ever reaches `writing_attempts` via `gradeWriting.ts`'s `INSERT INTO writing_attempts ... rubric = body.rubric`, never `writing_prompts`). `test_migration_056.py` was rewritten correctly: the up-test now asserts `writing_prompts` explicitly REJECTS `free_write` (`CheckViolation`, constraint name asserted), the down-clean test still round-trips both tables, and the `writing_prompts`-side honest-gate test was correctly **deleted** (that scenario is now structurally impossible — nothing can ever insert a `free_write` prompt row to gate on) while the `writing_attempts`-side honest-gate test is unchanged. Ran the full `test_migration_056.py` + `test_migration_057.py` for real against a fresh `python:3.12` container + Postgres-16 testcontainer (mirroring `Deploy/local-test.sh`'s own `db_suite()` invocation exactly): **7/7 passed**. |
| WRITING SF-2 | SHOULD-FIX (test-coverage/consistency) | **FIXED** | `offset` capped at a genuine `100_000` ceiling instead of `Number.MAX_SAFE_INTEGER`; `offset=100001` added to the existing `it.each` 400-boundary table. Ran for real: passes (9/9 in `writing.test.ts`'s targeted run). Fix-pass report honestly flags that its own "mirror tickets.ts/grammarDrill.ts" framing wasn't literally accurate (both siblings still use the symbolic cap) — this is disclosed, not hidden, and the fix itself is strictly better (a real ceiling instead of a symbolic one) and doesn't regress anything. |
| GRAMMAR SF-1 | SHOULD-FIX (test-coverage gap) | **FIXED** | New test sets `dueAt` to `Date.now() + 6*60_000` (6 minutes out) on a `GrammarCardSchedule` and asserts the mastery row renders `"Learning · due later today"`, plus explicitly asserts no `/next review in \d+ day/` text is present. This is the exact `scheduleStatusLine` function/path the original review said was untested (distinct from the pre-existing `scheduleLine`/`DrillSchedule` "~6 minutes" test, which takes a pre-computed day-count, not a raw timestamp). Ran for real: passes. |
| GRAMMAR SF-2 | SHOULD-FIX (test-coverage gap) | **FIXED** | New test banks a pattern, then directly `INSERT`s a `recognition`-face `vocab_cards` row for the SAME `grammar_entry_id` (legal — the partial unique index only constrains `face='production'`), then asserts `GET /grammar/bank` still returns exactly one row with `schedule: null` — positively demonstrating the route's `vc.face = 'production'` join predicate (not just the unique index) is what prevents fan-out/misattribution. Ran for real against the testcontainer: passes. |
| READING SF-1 | SHOULD-FIX (stale comment) | **FIXED** | Comment above `max_tokens: 4000` in `translate_passage.ts` now correctly states 4000 is the OUTPUT token budget and 8000 is the INPUT character cap (the proxy backstop), and explicitly flags that the old comment had the units backwards. No behavior change — `max_tokens: 4000` is unchanged, confirmed by diff. Purely cosmetic, correctly scoped. |
| READING SF-2 | SHOULD-FIX (test-coverage-uniformity gap) | **FIXED** | Added a dedicated drift-guard pin for 057's `translate_passage` value in `claude_route_enum.test.ts`, mirroring the existing 053/055 pins exactly (independent probe against the live enum, not just the general set-equality assertion). Ran for real: passes (4/4 in that file). |

**Totals: 9 FIXED, 0 PARTIALLY, 0 NOT-FIXED, 0 REGRESSION.**

## Security re-verification

No security regression found. Every read touched or added by this fix-pass
remains user-scoped via `getUserId(req)`-bound `WHERE user_id = $1` clauses
(no change to auth/scoping logic in any of the 9 fixes — TOPIK S-1/S-2/S-3
and GRAMMAR SF-1/SF-2 are read-path test additions and client-side plumbing
only, no new routes or scoping changes). The migration 056 amendment
*narrows* schema surface (removes an unreachable widened CHECK value from
`writing_prompts`) rather than loosening anything — this is a strict
reduction in attack/misuse surface, not an expansion. `WritingRubricSchema`
(`writing.ts:63`, still the closed two-value enum gating `GET
/writing/prompts` and `/prompts/random`) was not touched by this fix-pass and
still correctly rejects a `free_write` filter at the boundary. No new
string-interpolated SQL was introduced (the new topik.ts test's `UPDATE
topik_items SET answer = NULL WHERE topik_test_id IN (...)` and the new
grammar.ts test's `INSERT INTO vocab_cards (...) VALUES ($1, 'recognition'::card_face, $2)`
are both parameterized, and both are test-only code, not shipped routes).
`GET /writing/attempts`'s new `100_000` offset ceiling is a strict tightening
of an existing bound, not a new one — no new IDOR or injection surface.

## New findings introduced by the fix-pass

None rising to SHOULD-FIX or higher. Two things worth flagging for
completeness, both already honestly self-disclosed in `FIX_REPORT.md` rather
than hidden, and neither is a regression:

1. **F-007 resume still can't pin a TOPIK level** (documented deferral). A
   mid-exam resume of a paper that shares a `test_number` with the other
   level could theoretically still hit the D-1 tie-break, since
   `topik_attempts` has no `topik_level` column (predates migration 029/D-1).
   Correctly out of the stated S-1 fix scope (fetch/submit, not resume); the
   fix-pass filed it as a follow-up rather than silently leaving it
   undocumented. Confirmed by code read: `resumeAttempt`'s re-fetch path in
   `MockMode.tsx` still calls `fetchMockTest` with only `sourceTest`.
2. **`ExamChooser`'s completion-checkmark set (`doneTestNumbers`) is still
   keyed by `sourceTest` alone, not level`** — a completed TOPIK II test 91
   would still mark a TOPIK I test 91 row as "completed" in the chooser UI.
   This is the same D-1 confusion class as S-1 but was never called out in
   `REVIEW_topik.md`'s S-1 finding (scoped to the serve/grade path, not the
   annotation), so leaving it is correctly not scope creep — it's an honest,
   disclosed residual gap, not something the fix-pass broke or introduced.

Neither of these was present in the original reviews' SHOULD-FIX list, so
neither counts against the fix-pass's completion of its assigned scope; both
are pre-existing gaps the fix-pass's own report flagged rather than papered
over. No PRAISE item from any of the 4 original reviews was found undone —
spot-checked the survivor-guard (`ANSWERABLE_ITEM_SQL`), the F-111 join
schema-enforced safety (migration 020's partial unique index, untouched),
the `LEFT JOIN LATERAL` history-read pattern (untouched), and the 4-layer
`free_write` enum lockstep (`gradeWriting.ts`/`models.ts`/DB CHECK/
`domain.ts` all still agree on `topik_ii_53 | topik_ii_54 | free_write` for
the *attempts*/grading path — `writing_prompts` was never part of that
lockstep to begin with, since it never carried `free_write` on the wire).

## Recommendation

**Ship it.** All 9 SHOULD-FIX findings are genuinely resolved with real
regression coverage that was independently confirmed to fail on the
pre-fix code (for S-1, the highest-value fix) and pass against real
Postgres testcontainers (for every DB-backed test touched or added). The
migration 056 amendment is the right call, is provably safe (056 was never
merged into `origin/rebuild`, so no deployed schema exists to reconcile),
and correctly narrows rather than widens surface. No security regression.
The two residual gaps noted above (F-007 resume, checkmark-set keying) are
honest, correctly-scoped-out follow-ups, not silent omissions — recommend
filing them as tracked tickets before this phase is considered fully closed,
but they do not block merging this fix-pass.
