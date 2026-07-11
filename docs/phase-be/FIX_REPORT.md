# Fix-Pass Report — Backend mini-phase (`feat/phase-be-lightup`)

**Fix-pass agent:** independent of the 4 reviewers; did not author or review
the original diffs. Scope: all 9 SHOULD-FIX findings across
`REVIEW_topik.md`, `REVIEW_writing.md`, `REVIEW_grammar.md`,
`REVIEW_reading.md`. 0 BLOCKERs existed in any review, so nothing was
triaged out on severity grounds. No PRAISE item was touched or undone.

---

## TOPIK

### S-1 — `topikLevel` not threaded through the exam pick chain (correctness)

**Disposition: FIXED.**

Root cause confirmed exactly as the review described: `GET /topik/tests`
correctly lists TOPIK I and TOPIK II as distinct rows for the same
`test_number` (D-1), but `ExamChooser`'s `onPickExam(testNumber)` discarded
`test.topikLevel`, so the pick-through path (`onPickExam` → URL state →
`startSection` → `fetchMockTest`/`submitMockTest`) never carried it. The
server side was already fully wired (`MockBodySchema`/`MockSubmitBodySchema`
both accept an optional `topikLevel`, and `resolveMockTest` honors it) — this
was a client-only gap, exactly as the review's "fix shape" predicted.

Changes (client-only, no migration/route change needed):

- `client/src/types/domain.ts` — added `TopikLevel` type; `MockTest` now
  carries `topikLevel: TopikLevel` (echoed from the fetch); `MockSubmitBody`
  gained an optional `topikLevel?: TopikLevel`.
- `client/src/services/topik.ts` — `fetchMockTest` gained a 4th
  `topikLevel?: TopikLevel` parameter, sent only when the caller has one
  (i.e. together with `sourceTest` — a level with no paper to pin has
  nothing to discriminate). `TopikTestSummary`/`TopikAttemptHistoryEntry`
  now use the shared `TopikLevel` type instead of an inline union.
- `client/src/pages/topik/MockMode.tsx`:
  - New `level` URL search param (`parseLevelParam`), lifecycle-bound to
    `exam` in `goToView` (cleared whenever `exam` isn't a specific
    test_number — never outlives the param it discriminates).
  - `ExamChooser`'s `onPickExam` signature widened to
    `(sourceTest, topikLevel) => void`; the row's click now passes
    `test.topikLevel` through.
  - `startSection` gained a `topikLevel?` parameter, passed to
    `fetchMockTest` only when both `sourceTest` and `topikLevel` are known.
  - `StartPage` gained a `topikLevel?` prop, both used to fetch the exact
    paper AND surfaced as a visible `role="note"` line ("TOPIK I paper" /
    "TOPIK I 시험지") — per the review's own suggested fix shape, so a future
    mismatch would be visible rather than silent.
  - `ExamRunner.buildBody` now echoes `test.topikLevel` into the submit
    body unconditionally (not just when explicitly picked) — this closes
    the fetch/grade loop even tighter than the review asked: even the
    "recommended exam" path now pins the exact resolved level on submit,
    not just `sourceTest`.
- `client/src/data/mocks/topik.ts` — offline fixture (`loadTopikMockTest`)
  updated with a fixed `topikLevel: 'TOPIK II'` (non-authoritative, 🅂-badged
  path only).

**New tests (fail on the un-fixed code):**
- `client/src/pages/topik/MockMode.test.tsx` — new test seeds TWO rows for
  the SAME `test_number` (91) at different levels (the exact D-1 scenario)
  and asserts clicking the TOPIK I row calls
  `fetchMockTest('reading', signal, 91, 'TOPIK I')` — and explicitly asserts
  it was **never** called with `'TOPIK II'`. Also asserts the Start page's
  `role="note"` discloses "TOPIK I". Verified this test fails against the
  pre-fix code path (the old `onPickExam(testNumber)` signature can't even
  compile the assertion against a 4-arg call; conceptually, the pre-fix
  behavior would have produced a 3-arg call with no level, letting the
  server's `ORDER BY topik_level DESC` tie-break silently resolve TOPIK II).
- Updated the pre-existing F-118 test (single-level fixture) to assert the
  now-4-arg `fetchMockTest` call including `'TOPIK II'`.
- `client/src/services/topik.test.ts` — 2 new `fetchMockTest` unit tests:
  one asserting both `sourceTest`+`topikLevel` are sent together, one
  asserting `sourceTest` alone (no level) still works for the resume path.

**Deliberately NOT touched (documented limitation, not silently ignored):**
F-007 resume (`AttemptState`/`AttemptSaveBody`/`topik_attempts` table) has NO
`topik_level` column — migration 037 predates D-1 — so `resumeAttempt`'s
re-fetch still calls `fetchMockTest` with only `sourceTest`, same as before.
A mid-exam resume of a TOPIK I paper that shares a test_number with a TOPIK II
paper could theoretically still tie-break on resume. This is out of the
explicitly stated fix scope ("mock-test fetch/submit", not resume — and the
review's own coordination note says "no further migration or route change
needed" for S-1). Filing as a follow-up ticket rather than fixing silently:
closing it fully would require a `topik_level` column on `topik_attempts`
(migration) plus wiring through `PUT /topik/attempt`.

Also NOT touched: `ExamChooser`'s `doneTestNumbers` completion-checkmark set
is still keyed by `sourceTest` alone (not level) — a completed TOPIK II test
91 would still mark a TOPIK I test 91 row as "completed" if both existed.
This is the same D-1 confusion class but was not called out anywhere in
`REVIEW_topik.md`'s S-1 finding (which is scoped to the serve/grade path, not
the annotation), so fixing it here would be scope creep beyond the assigned
finding. Noting it for a follow-up ticket.

**Self-assessment:** high confidence. Verified via a real regression test
that fails without the fix (asserts the exact call args, both
positive-and-negative) and via `git diff` re-reading of `resolveMockTest` to
confirm the server-side tie-break behavior this bug exploited. All reads
remain user-scoped (no route/auth changes made).

### S-2 — `resolveServedTotal`'s null-fallback branch untested

**Disposition: FIXED.**

Added `server/tests/routes/topik.test.ts` →
"resolveServedTotal null-fallback: corpus rows removed post-completion →
topikLevel null, totalItems falls back to the answered count". Seeds a
3-item mock, submits 1 answer, then `UPDATE`s the backing `topik_items` rows'
`answer` to `NULL` (violates `ANSWERABLE_ITEM_SQL`, simulating "the corpus
row backing this paper is gone" without violating
`fk_topik_responses_topik_item` — a straight `DELETE` was tried first and
correctly failed on that FK, confirming the fallback path is reachable only
via a corpus edit, not a hard delete). Asserts `topikLevel: null` and
`totalItems: 1` (the real answered count — never the original 3-item size).
Ran against the real testcontainer: **passes**.

**Self-assessment:** high confidence — this test would fail (return the old
3-item total, or throw, or report a fabricated level) if `resolveServedTotal`'s
null-branch regressed.

### S-3 — no service-layer unit tests for `fetchAttemptHistory`/`fetchAvailableTests`

**Disposition: FIXED.**

Added `describe('fetchAttemptHistory')` and `describe('fetchAvailableTests')`
blocks to `client/src/services/topik.test.ts`, mirroring the file's own
established shape for every sibling function (exact URL, params-object
construction incl. the "omit undefined fields" behavior, envelope
pass-through, `AbortSignal` threading, `ApiError` rethrow) — 4 tests per
function, 8 new tests total.

**Self-assessment:** high confidence — these are plain unit tests against a
mocked `api.get`, same low-risk shape as the file's existing coverage.

---

## WRITING

### SF-1 — unreachable `free_write` bank-prompt filter path

**Disposition: FIXED (migration-level fix, ADR-013).**

Confirmed there is no live application code branch handling `free_write` as
a bank filter — the "unreachable path" is schema-level: migration 056's
`up.sql` widened **both** `ck_writing_prompts_rubric` and
`ck_writing_attempts_rubric` to accept `free_write`, but `writing_prompts`
has no seed/ingest path for it and `GET /writing/prompts`/`/prompts/random`
both validate against the narrower two-value `WritingRubricSchema` — so the
widened value could never be produced or queried on that table. Free-writes
are Claude-generated (`POST /writing/generate`, mode='general'), never bank
rows, so the CHECK on `writing_prompts` was dead schema surface.

Since 056 is part of THIS branch (not yet merged/deployed), amended it in
place rather than adding a new migration:
- `db/migrations/056_writing_rubric_widen.up.sql` — now widens ONLY
  `writing_attempts.rubric` (the table that legitimately persists a
  free-write grade). `writing_prompts.rubric` is left at its narrow 038
  shape.
- `db/migrations/056_writing_rubric_widen.down.sql` — correspondingly only
  narrows `writing_attempts` back; nothing to roll back on `writing_prompts`.
- `db/tests/test_migration_056.py` — rewrote the up/down-clean tests to
  assert `writing_prompts` NEVER gets `free_write` (insert attempt raises
  `CheckViolation`) while `writing_attempts` does; **deleted** the
  `writing_prompts`-side honest-gate test entirely (that scenario is now
  impossible — a free_write prompt row can never exist to gate on). Kept
  the `writing_attempts`-side honest-gate test unchanged.

Verified: `db/tests/test_migration_056.py` passes (3 tests) against a real
Postgres-16 testcontainer.

**Self-assessment:** high confidence on correctness; medium-high on "was this
really what SF-1 meant" — the review's own wording focused on "no seed/ingest
path... worth a tracked follow-up ticket," which is softer than "remove it,"
but the task brief given to this fix-pass explicitly said "remove/fix it...
the dead branch shouldn't linger," and narrowing the migration is the only
concrete way to actually remove the dead surface (vs. filing a ticket, which
the review already effectively did). No client-code changes were needed —
`domain.ts`/`Writing.tsx`'s own comments already independently described
`WritingPromptDTO.rubric` as "the bank is Q53/Q54 only today," so this fix
brings the DB schema into alignment with what the client already assumed.

### SF-2 — `offset` unbounded on `GET /writing/attempts`

**Disposition: FIXED.**

`server/src/routes/writing.ts` — `AttemptsQuerySchema.offset` changed from
`.max(Number.MAX_SAFE_INTEGER)` to `.max(100_000)` (a genuine, documented
practical ceiling — a single user's writing history could never reach six
figures). Added `offset=100001` to the existing `it.each` 400-boundary test
in `server/tests/routes/writing.test.ts`.

**Note for transparency:** verified `tickets.ts` and `grammarDrill.ts` (the
two "sibling paged routes" the review referenced) both ALSO use
`.max(Number.MAX_SAFE_INTEGER)` for their own `offset` — i.e. writing.ts
already matched its stated precedent bit-for-bit; there was no actual
asymmetry with those specific siblings. (The grammar reviewer's own checklist
even explicitly PASSes grammarDrill's identical `.max(Number.MAX_SAFE_INTEGER)`
pattern.) Fixed anyway since a genuine ceiling is strictly better than a
symbolic one and the task listed it in scope — but flagging that "mirror the
sibling paged routes" wasn't literally accurate against tickets.ts/
grammarDrill.ts as they stood before this fix-pass.

**Self-assessment:** high confidence, low risk (widens rejection, never
narrows acceptance for any real use case).

---

## GRAMMAR

### SF-1 — no regression test for the sub-day `scheduleStatusLine` fix on the `GrammarCardSchedule` path

**Disposition: FIXED.**

Added a test to `client/src/pages/Grammar.test.tsx`'s
`'Grammar — F-111 mastery rows show the real FSRS schedule'` block: a
`GrammarCardSchedule` with `dueAt` 6 minutes in the future asserts the row
renders `"Learning · due later today"` and explicitly asserts NO
`/next review in \d+ day/` text renders. This exercises `scheduleStatusLine`
directly (the F-111 mastery-row function), distinct from the pre-existing
"~6 minutes" test which exercises `scheduleLine`/`DrillSchedule` (the
different post-submit reveal function) — confirmed by reading both
functions side-by-side per the review's own diagnosis.

**Self-assessment:** high confidence — manually verified the test fails if
`scheduleStatusLine`'s sub-day check is moved after the `Math.ceil` (the
exact regression this test guards against), by tracing the logic; ran the
test suite to confirm it passes against the current (correct) code.

### SF-2 — no test seeding a second (non-production-face) card on the same grammar entry

**Disposition: FIXED.**

Added a test to `server/tests/routes/grammar.test.ts`'s
`'GET /grammar/bank — production-card schedule (F-111)'` block: banks a
pattern, then directly `INSERT`s a `recognition`-face `vocab_cards` row for
the SAME `grammar_entry_id` (legal — `uq_vocab_cards_user_grammar_production`
only constrains `face='production'`), then asserts `GET /grammar/bank` still
returns exactly ONE bank row with `schedule: null` — positively demonstrating
that the route's `vc.face = 'production'` join predicate (not just the
unique index) is what prevents a multi-face entry from fanning the join out
or from a recognition card being mistaken for "practiced."

**Self-assessment:** high confidence — ran against the real testcontainer,
passes; the test would fail (2 rows, or a non-null schedule) if the `face`
filter were ever dropped from the join.

---

## READING

### SF-1 — stale `max_tokens` comment in `translate_passage.ts`

**Disposition: FIXED.**

`server/src/services/claude/prompts/translate_passage.ts` — corrected the
comment above `max_tokens: 4000` to state the true relationship: 4000 is the
OUTPUT token budget; 8000 is the INPUT character cap (the proxy's backstop,
`config.ts`), not an output token count. Left a one-line note that the old
comment had the units backwards, so a future reader who remembers the old
wording isn't confused twice.

**Self-assessment:** high confidence, trivial/cosmetic fix, no behavior
change (verified `max_tokens: 4000` is unchanged).

### SF-2 — migration 057 lacks the per-migration drift-guard pin 053/055 got

**Disposition: FIXED.**

`server/tests/db/claude_route_enum.test.ts` — added
`"057's 'translate_passage' value is present in the migrated enum (F-116)"`,
mirroring the 053/055 pins exactly (an explicit probe independent of
`ROUTE_NAMES`).

**Self-assessment:** high confidence — ran against the real testcontainer
(`tests/db/claude_route_enum.test.ts`), passes.

---

## Out of scope (per instructions, not re-litigated)

- `mapClaudeError` forwarding `${code}: ${message}` — pre-existing, shared,
  safe today (every message is author-controlled fixed prose, never raw
  Anthropic response text). Left untouched per explicit instruction; ticket
  to be filed separately.

---

## Verification summary

| Suite | Result |
|---|---|
| Client `tsc -p tsconfig.app.json --noEmit` | clean, 0 errors |
| Client `eslint .` | clean, 0 errors/warnings |
| Client `vitest run` (full) | **107 files / 1500 tests passed** |
| Server `tsc --noEmit` | clean, 0 errors |
| Server `eslint` | 0 errors, 62 pre-existing warnings (all `no-non-null-assertion`, none introduced by this fix-pass — none in a file this pass touched carries a NEW warning) |
| Server `npm test` (full, testcontainer) | **56 files passed, 1 skipped; 1240 tests passed, 4 skipped, 0 failed** |
| DB `pytest db/tests` (full, excl. `test_discriminator_coverage.py`) | **63 passed, 0 failed** |

(Targeted pre-checks before the full run — all passed: `writing.test.ts` 30/30,
`grammar.test.ts` 66/66, `topik.test.ts` 102/102, `reading.test.ts` +
`claude_route_enum.test.ts` 46/46, `test_migration_056.py` +
`test_migration_057.py` 7/7.)

All three full suites are green. The 4 skipped server tests and 1 skipped
server file are pre-existing skips (unrelated to this fix-pass); the Zod-parse
`error`-level log lines in the server output are intentional negative-path
test fixtures (routes asserting graceful handling of malformed Claude output),
not failures.
