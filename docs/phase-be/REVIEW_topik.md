# Independent Review — TOPIK backend mini-phase (F-104 / F-118)

**Scope:** `server/src/routes/topik.ts` (new `GET /topik/attempts` F-104,
`GET /topik/tests` F-118), `server/tests/routes/topik.test.ts`,
`client/src/services/topik.ts`, `client/src/pages/Topik.tsx` +
`client/src/pages/topik/MockMode.tsx` (+ their tests). Diff base: `rebuild`,
branch `feat/phase-be-lightup` (commit `49d9b05` + surrounding merge). No
`types/domain.ts` additions exist for this pass — F-104/F-118's wire types
(`TopikAttemptHistoryEntry`, `AttemptHistoryResult`, `TopikTestSummary`,
`AvailableTestsResult`) are defined directly in `client/src/services/topik.ts`
rather than `domain.ts`; this is a reasonable placement choice, not a defect.

**Reviewer:** independent senior review, report-only, no code changes made.

## Verdict

**CONDITIONAL PASS — 0 security BLOCKERs, 1 significant correctness SHOULD-FIX
that undercuts the point of F-118.** Every read in this diff is user-scoped,
parameterized, and zod-validated at the boundary; the honest-empty-state and
honest-degradation discipline (no fabricated checkmarks, no fabricated scores)
is followed carefully on both routes and both client surfaces, and is
backed by real tests. The one finding that matters: `GET /topik/tests` (F-118)
lists TOPIK I and TOPIK II as two distinct, separately-clickable papers for the
same `test_number` (exactly the D-1 scenario this whole file is otherwise very
careful about) — but the client's pick-through path (`ExamChooser` →
`onPickExam` → `startSection` → `fetchMockTest`/`submitMockTest`) only ever
threads `test_number`, never `topikLevel`. When both levels have answerable
items for a `(test_number, section)`, clicking the TOPIK I row is
indistinguishable from clicking the TOPIK II row: both silently resolve to
TOPIK II server-side (`resolveMockTest`'s `ORDER BY topik_level DESC`
tie-break), and nothing in the Start page or exam UI discloses the mismatch.
This is not a security leak and it does not corrupt another user's data, but
it is a genuine "the app served something other than what the user picked"
defect, squarely in this pass's scope, and untested at the client level.

## Security checklist

| Concern | Status | Evidence |
|---|---|---|
| User-scoped reads (no cross-user leak) | PASS | `GET /topik/attempts` — `topik.ts:1171-1174` (`WHERE user_id = $1 AND status = 'completed'`) and the `LEFT JOIN LATERAL` at `topik.ts:1189-1195` correlates on `attempt_id = a.id`, where `a` is already filtered to the caller's own rows — a response can only ever carry an `attempt_id` its own `/mock/submit` transaction stamped (never client-supplied), so the lateral needs no separate `user_id` filter to stay safe (see NIT below for defense-in-depth). Direct cross-user test: `topik.test.ts:2173` "is user-scoped (no IDOR) — another user never sees these attempts". `GET /topik/tests` is reference data (topik_tests/topik_items, no per-user rows) — correctly NOT user-scoped, but still sits behind `requireAuth` (route-level `router.use(requireAuth)` at `topik.ts:41`). |
| Parameterized SQL | PASS | Every query in both new routes binds via `$n` placeholders. The one string-interpolated SQL fragment, `ANSWERABLE_ITEM_SQL` (`topik.ts:425-428`), splices in `NO_TRANSCRIPT_STEM_PREFIX` — a hardcoded module-level constant, never request-derived — so this is not an injection vector. |
| Input validation (zod at the boundary) | PASS | `AttemptsQuerySchema` (`topik.ts:1059-1062`, limit 1–100 default 20 / offset ≥0 default 0) and `TestsQuerySchema` (`topik.ts:543-548`, limit 1–100 default 50 / offset ≥0 default 0) both reject out-of-range paging with 400, pinned by `it.each(['limit=0'],['limit=101'],['offset=-1'])` tests on both routes (`topik.test.ts:2260`, and the `GET /topik/tests` paging test at `2354`). `section`/`topik_level` filters are closed zod enums; an unknown value 400s (tested at `2372`). |
| IDOR | PASS | No client-supplied id reaches either route's `WHERE user_id = ...` clause; `getUserId(req)` is the only source. |
| Rate limiting | PASS | Both routes carry `cheapLimiter()` (`topik.ts:1159`, `586`) — the correct bucket for a plain indexed DB read. |
| Fabricated data (honest empty/degraded states) | PASS | Server: an attempt whose backing corpus paper vanished (`resolveServedTotal` → null) reports `topikLevel: null` and falls back `totalItems` to the attempt's own answered-count — documented as "a safe, non-fabricated LOWER BOUND, never a guess above what is actually known" (`topik.ts:1102-1106`). Client: `ExamChooser`'s completion checkmark degrades silently to "no checkmark" on a failed `fetchAttemptHistory` (never a fake checkmark) — tested at `MockMode.test.tsx:1117`; `AttemptsReview`/`SessionTally` render explicit loading/error+retry/honest-empty states, never a synthesized score — tested at `Topik.test.tsx:744, 785, 908, 944`. |
| Type-unsafe boundaries | PASS | `topik_attempts.id`/`topik_items.id` (BIGINT) are carried as `string` end-to-end on the wire (`attemptId: string`, `TopikMockItem.itemId: string`), avoiding silent float-precision loss; INTEGER-bound inputs (`sourceTest`, paging) are capped at `INT4_MAX` before they can overflow Postgres into a 500. |
| Client abort/error handling | PASS | `ExamChooser` and `StartPage` both use a real `AbortController`, check `ctrl.signal.aborted` before each `setState`, and distinguish a genuine failure (retryable error card) from an aborted/superseded fetch (silently dropped). `fetchAttemptHistory`/`fetchAvailableTests` both thread an optional `AbortSignal` through to `api.get`. |

No security blockers found in the checklist above.

## Findings by severity

### BLOCKER

None. (See the SHOULD-FIX below — it's a correctness/UX defect, not a
security or data-integrity-across-users issue.)

### SHOULD-FIX

**S-1. F-118's "past papers" list offers TOPIK I vs TOPIK II as distinct
choices, but the pick-through path can't actually honor the choice.**

- `GET /topik/tests` (`topik.ts:586-645`) correctly groups by
  `(test_number, topik_level, section)` — the D-1 natural key — so a sitting
  with answerable items in both levels for a section produces **two separate
  rows** (verified by the server-side test `topik.test.ts:2321`, "filters by
  section and by topik_level (D-1: one test_number, two papers)").
- The client's `ExamChooser` (`MockMode.tsx:908-945`) renders both rows,
  each labelled with `test.topikLevel` (e.g. "TOPIK I test 91" vs
  "TOPIK II test 91"), and wires `onClick` to
  `onPickExam(test.testNumber)` (`MockMode.tsx:919`) — **`test.topikLevel` is
  read for display only and is discarded, never passed to `onPickExam`.**
- `onPickExam`'s type is `(sourceTest: number) => void`
  (`MockMode.tsx:791`); the value flows into the `exam` URL param, then
  `StartPage`'s `sourceTest` prop, then `startSection(section, sourceTest)`
  (`MockMode.tsx:425`), then `fetchMockTest(section, signal, sourceTest)`
  (`services/topik.ts:138-152`) — whose signature has **no `topikLevel`
  parameter at all**. Same story for submit: `MockSubmitBody`
  (`domain.ts:278-284`) has no `topikLevel` field, and `handleSaveProgress`
  (`MockMode.tsx:353-372`) only persists `{ section, sourceTest, ... }`.
- Server-side, `resolveMockTest` (`topik.ts:1285-1311`) — the single resolver
  both `/mock` and `/mock/submit` share — picks
  `ORDER BY t.test_number DESC, t.topik_level DESC LIMIT 1` when `topikLevel`
  is `undefined`. `'TOPIK II' > 'TOPIK I'` lexically, so **whenever both
  levels have an answerable item for that `(test_number, section)`, the
  resolver always lands on TOPIK II — regardless of which row the user
  clicked.**
- Net effect: in any sitting where both papers are answerable in a section
  (which, per this file's own D-1 documentation, is the *normal* case — "TOPIK
  I and TOPIK II sittings SHARE every test_number"), the TOPIK I row in the
  chooser is dead: clicking it produces the exact same served exam, same
  grading, and same recorded `topikLevel` (`'TOPIK II'`, echoed identically by
  `resolveServedTotal` on the history read) as clicking the TOPIK II row.
  Nothing in `StartPage`'s meta line (`MockMode.tsx:1013-1041`) or the exam UI
  discloses that the level actually served differs from the level the user
  selected — there is no `topikLevel` display anywhere in `StartPage` at all.
- This is not a security or cross-user issue (grading is still internally
  self-consistent: the server resolves the *same* paper for both the fetch and
  the later submit, so no wrong score is computed against the wrong content —
  the paper *served* and the paper *graded* always agree with each other).
  It's a "the app silently ignored your selection" correctness/honesty bug
  that defeats the specific purpose the F-118 paper list + D-1 groundwork were
  built for.
- **Untested at the client layer.** `MockMode.test.tsx`'s F-118 tests
  (`:1064`, `:1117`, `:1138`) only ever seed a single-level scenario
  (`topikLevel: 'TOPIK II'` for every row); none seeds two same-`test_number`
  rows at different levels and asserts the TOPIK I row actually reaches
  `fetchMockTest`/`submitMockTest` with the matching level. The server-side
  D-1 tests (`topik.test.ts:1430-1550`) exercise `resolveMockTest`'s explicit-
  `topikLevel` support thoroughly and pass — but nothing calls that code path
  from the client today, so those passing tests don't actually prove the
  end-to-end (chooser click → correct paper served) property holds.
- **Fix shape:** thread `test.topikLevel` through `onPickExam` (widen its
  signature to `(sourceTest: number, topikLevel: TopikLevel) => void`), carry
  it in the URL/state alongside `exam`, add it as a 4th arg to
  `fetchMockTest`/an optional field on `MockSubmitBody`/`AttemptSaveBody`, and
  surface it in `StartPage`'s meta line so a mismatch — if one ever slips
  through — is at least visible.

**S-2. `resolveServedTotal`'s corpus-edit fallback path is unexercised.**

`resolveServedTotal` (`topik.ts:1108-1133`) is documented to fall back
`totalItems` to the attempt's own answered-count, and `topikLevel` to `null`,
when the backing corpus paper is fully gone by the time `GET /topik/attempts`
runs (`resolveMockTest` → `null`). This fallback is honest (a real lower
bound, never a guess above what's known — matches the CLAUDE.md "no fabricated
completions/scores" bar), and the client (`services/topik.ts:270-276`,
`Topik.tsx:337`) correctly treats a `null` `topikLevel` as "omit the level
prefix" rather than rendering `null`/`undefined` as text. However, **no test
in `topik.test.ts`'s `GET /topik/attempts` describe block (`:2111-2268`)
exercises the null-resolution path** — every test there seeds items that stay
resolvable through to the assertion. Given this is the exact scenario the
review brief called out the builder for flagging, it deserves a regression
test (seed a completed attempt, then delete/mutate its backing `topik_items`
rows so `ANSWERABLE_ITEM_SQL` no longer matches any of them, then assert
`topikLevel: null` and `totalItems` equal to the answered count) so a future
refactor of `resolveMockTest`/`ANSWERABLE_ITEM_SQL` can't silently regress this
into a thrown 500 or a fabricated total without a test noticing.

**S-3. `services/topik.test.ts` has no direct unit tests for
`fetchAttemptHistory` / `fetchAvailableTests`.**

Both F-104 and F-118 client service functions (`services/topik.ts:304-358`)
are exercised only indirectly, through `Topik.test.tsx`/`MockMode.test.tsx`
mocking the service module wholesale (`vi.mock('../services/topik')`-style).
Every other function in this file (`fetchStudyDraw`, `recordTopikAnswer`,
`fetchMockTest`, `submitMockTest`) has a dedicated `describe` block asserting
the exact URL, query-param construction, envelope unwrap, and `AbortSignal`
threading (`services/topik.test.ts:46-296`) — these two new functions do not.
This isn't a logic bug (the code is simple and the params/envelope shapes are
straightforward), but it's an inconsistency with this file's own established
coverage bar and the CLAUDE.md test-with-real-behavior standard; a
transposition of `params.section`/`params.limit`, or a broken envelope
unwrap, would slip through unless a component test happened to catch it via a
mocked service.

### NIT

**N-1.** The `GET /topik/attempts` lateral join
(`topik.ts:1189-1195`) doesn't repeat `WHERE user_id = $1` inside the
correlated subquery — it's provably safe today (an `attempt_id` can only ever
be stamped by that same user's own `/mock/submit` transaction, and the outer
query already filters `a.user_id = $1`), but an explicit
`AND topik_responses.user_id = $1` inside the lateral would be a cheap
belt-and-suspenders against a future schema change (e.g. if `attempt_id`
were ever made updatable) without changing today's behavior or cost.

**N-2.** `bandForPercentage` is duplicated verbatim between
`server/src/routes/topik.ts:388-393` and `client/src/pages/Topik.tsx:476-481`.
The duplication is deliberately documented and justified (client-tallied
Study-mode grading vs. server-computed Mock grading are independent scoring
paths), and the two copies currently agree exactly on all four thresholds —
but nothing enforces that agreement going forward; a future threshold tweak
on one side alone would silently desync the "L4 range" language between Study
and Mock results screens. Not worth a shared import given the documented
rationale, but a shared constants file (thresholds only, not the whole
function) would remove the risk cheaply if this bites in practice.

### PRAISE (fix-pass must not undo)

- **Survivor-guard consistency across every surface.** `ANSWERABLE_ITEM_SQL`
  is the single shared predicate behind `/items`, `/study`, `/mock`,
  `/mock/submit`, `resolveMockTest`, and now `GET /topik/tests`'s `itemCount` —
  so F-118's advertised per-paper count provably matches what `/mock` would
  actually serve for that paper (tested explicitly:
  `topik.test.ts:2290`, "caps itemCount at the official 50-item mock size").
- **Honest degradation is real, not just documented.** Both
  `ExamChooser`'s checkmark annotation and `AttemptsReview`'s primary list
  have dedicated tests proving the failure path renders no fabricated data
  (no checkmark / honest error card, respectively) rather than merely
  asserting the happy path.
- **`GET /topik/attempts`'s `LEFT JOIN LATERAL`, not `GROUP BY`, is the right
  call** — it correctly returns exactly one row per completed attempt even
  when that attempt has zero `topik_responses` (an all-skipped submit),
  avoiding the classic "history entry silently disappears because it has no
  child rows" bug; backed by a direct test
  (`topik.test.ts:2213`, "an all-skipped submit still records history").
- **The 046 migration's design** (partial-unique `active` index,
  `ON DELETE SET NULL` for `topik_responses.attempt_id`, disabling the
  `updated_at` trigger during the tombstone-row backfill so historic
  `completedAt` timestamps stay meaningful) is careful, correctly documented,
  and matches what F-104/F-118 actually need.

## Coordination observations

- This pass sits on top of `037_topik_attempts` + `046_topik_attempts_history`
  and the pre-existing D-1 (`029`) natural-key widening; the SHOULD-FIX above
  (S-1) is a consequence of D-1's server-side fix landing without a matching
  client-side follow-through when F-118 was wired — worth flagging to whoever
  owns the client Mock-mode UI work next, since the fix is client-only (no
  further migration or route change needed; `MockBodySchema`/
  `MockSubmitBodySchema` already accept an optional `topikLevel`).
- No conflicts observed with the sibling Grammar/Writing/Reading route
  reviews in this same `docs/phase-be/` directory — the TOPIK routes don't
  share tables or helpers with those surfaces beyond the common
  `middleware/auth.ts`, `middleware/validate.ts`, and `db/pool.ts` primitives.
