# Review

Independent senior review of two features on `track-a-integration`:

- **F-001 (Writing):** `client/src/pages/Writing.tsx`, `client/src/services/writing.ts`,
  the `Writing` section of `client/src/types/domain.ts`, and the `Today.tsx` tile wiring
  to `POST /grade-writing` (`server/src/routes/gradeWriting.ts`).
- **F-008/F-009 (TOPIK results + explanations):** the shared `TopikResults` extraction in
  `client/src/pages/topik/MockMode.tsx` and its reuse in `client/src/pages/Topik.tsx`
  (Study mode).

Read in full: `gradeWriting.ts`, `writing.ts`, `Writing.tsx`, `writing.test.ts`,
`Writing.test.tsx`, the `TopikResults`/`ResultsSummary`/`ResultsReviewRow` block and
`buildMockResultsSummary` in `MockMode.tsx`, the `StudyMode` results wiring
(`bandForPercentage`, `buildStudySummary`, `buildReviewRow`, `effectiveExplanation`) in
`Topik.tsx`, plus the relevant slices of `MockMode.test.tsx` / `Topik.test.tsx`. Also
read the supporting server contract: `claudeProxy.ts` (`gradeWriting` method),
`claude/models.ts` (`GradeInputSchema`/`GradeResultSchema`), `claude/prompts/grade_writing.ts`
(tool schema + snake_case→camelCase remap), `claude/errors.ts` (`httpStatus` union),
`middleware/rateLimits.ts`, `middleware/errors.ts`, `services/api.ts`, and
`server/src/routes/topik.ts`'s `bandForPercentage`. Domain types for the mock wire
(`TopikMockItem`, `TopikMockChoice`, `MockReveal`, `MockResult`) and the Study wire
(`TopikItem`, `TopikChoice`) were read in full to verify the answer-strip claim.

## Verdict

**APPROVE.** Zero BLOCKERs. Both features are correct, the F-001 wire contract matches
the server byte-for-byte, the mock answer-strip is untouched by the `TopikResults`
extraction, and the F-009 gating is correct on both the "hide on correct" and
"don't render an empty paragraph" axes. Test coverage is unusually strong — several
tests are explicitly written to fail on the pre-fix behavior, and they do (verified by
reading the assertions against the described past behavior, not just the docstrings).
One SHOULD-FIX (a genuine, if narrow, gap in the 429 duplicate-submit path) and one
accepted-tradeoff duplication (`bandForPercentage`) are flagged below.

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **`expensiveLimiter()` 429 body never carries `retry_after`, so `Writing.tsx`'s
   "structured retryAfter" messaging is dead code in production today.**
   `server/src/middleware/rateLimits.ts` `buildExpensive()` sets
   `message: { error: { code: 'rate_limited', message: 'too many requests' } }` — no
   `retry_after` field. `client/src/services/api.ts`'s `normaliseError` only populates
   `ApiError.retryAfter` from `body.error.retry_after` (it does not read the
   `RateLimit-Reset` header `express-rate-limit` sets via `standardHeaders: 'draft-7'`).
   So every real 429 from `/grade-writing` hits `Writing.tsx`'s `messageFor()` fallback
   branch ("Grading is rate-limited right now. Wait a moment…") — the `retryAfter !==
   undefined` branch with the "try again in about N seconds" copy is only reachable in
   tests, which construct the `ApiError` directly with `retryAfter` set. This isn't a
   correctness bug in the new code (both branches are individually correct, and the
   fallback is a fine message), but the docstring at `writing.ts:16-19` ("a structured
   `retryAfter` when the server provides one") and the code's evident intent both
   assume a wired path that doesn't exist yet. Either wire `retry_after` (seconds until
   `RateLimit-Reset`) into the expensive-limiter's 429 body, or soften the comment so a
   future reader doesn't assume this path is live. Low severity — cosmetic UX only — but
   worth a ticket since it's pre-existing shared infra, not scoped to this PR's diff.

### NIT

1. **`bandForPercentage` is duplicated verbatim** between
   `server/src/routes/topik.ts:327-332` and `client/src/pages/Topik.tsx:220-225`.
   Compared line-for-line, the thresholds (`80/60/40`) and labels match exactly today.
   The duplication is deliberate and documented (`Topik.tsx:211-219`) — client and
   server are separate deployables with no shared package in this repo (`Deploy/` only
   has `docker-compose.shared.yml`, not a code package), so avoiding it would mean
   introducing shared-package infrastructure for one 4-line pure function. Given the
   blast radius of a silent drift is purely cosmetic (a mismatched readiness-band
   *label* between Mock's server-computed band and Study's client-tallied band — the
   underlying `percentage`/`correct`/`totalItems` numbers are computed independently
   and correctly either way), this is an acceptable tradeoff, not a SHOULD-FIX. If it
   ever needs to be enforced, the cheapest fix is a golden-value unit test asserting
   both functions agree at the three boundaries (79/80, 59/60, 39/40), rather than
   extracting a shared module.

2. **`Writing.tsx`'s in-flight-abort guard is double-covered.** `submit()` checks
   `if (ctrl.signal.aborted) return;` immediately after every await, and separately
   checks `err instanceof ApiError && err.code === 'canceled'` in the catch block
   (`Writing.tsx:192-198`). The second check is unreachable in practice once the first
   guard exists (an aborted call always throws through the `catch`, hits the aborted
   check, and returns before the `code === 'canceled'` check runs) — but it's cheap,
   correct-either-way defensive redundancy in a pattern this codebase clearly uses
   elsewhere (comment says "mirrors the Grammar drill"), not a real defect.

### PRAISE

1. **F-001 contract fidelity is exact and independently verifiable end-to-end.**
   Traced the full chain: `Writing.tsx` sends `{ prompt, sample, rubric }` →
   `writing.ts` POSTs it unmodified with a 65s timeout → `gradeWriting.ts`'s
   `.strict()` Zod schema (`prompt` 1..2000, `sample` 1..5000, `rubric` enum
   defaulting to `topik_ii_54`) accepts it and forwards exactly `{ prompt, sample,
   rubric }` to the proxy (deliberately dropping the edge-only `targetLevel` hint) →
   `claudeProxy.gradeWriting` validates against `GradeInputSchema` (a looser superset:
   `sample` max 16000, `prompt` optional max 2000, `rubric` required) → the tool-forced
   Claude response is remapped from snake_case (`max_score`, `total_score`,
   `language_use`, `estimated_level`, `overall_comment`) to the camelCase
   `GradeResultSchema` shape (`claude/index.ts:1037-1063`) → the route returns
   `{ result, metadata }` verbatim, and `domain.ts`'s `GradeWritingResponse` /
   `WritingGradeResult` / `WritingDimensionScore` mirror that shape field-for-field
   (`domain.ts:1660-1732`). No `any`, no silent cast, no drift anywhere in the chain.

2. **The 65s vs 60s timeout relationship is correctly reasoned, not just picked.**
   `writing.ts:46-59` documents that the client timeout must sit *past* the server's
   `CLAUDE_TIMEOUT_MS` (confirmed default 60s in `claude/config.ts:32`), so a genuine
   slow-grade surfaces as the server's own 502/504 `upstream_error` (with real context)
   rather than a client-side `ECONNABORTED` that can't distinguish "Claude never
   answered" from "the server crashed." This is exactly the right call for a proxy
   client and is a pattern other Claude-wrapping routes in this codebase should copy.

3. **The mock answer-strip is provably untouched by the F-008 refactor.** The
   `TopikResults`/`ResultsSummary` extraction operates entirely on a post-hoc,
   already-graded shape (`ResultsReviewRow`) built by each mode's own normalizer
   (`buildMockResultsSummary` in `MockMode.tsx`, `buildStudySummary`/`buildReviewRow`
   in `Topik.tsx`). It never touches `TopikMockItem`/`TopikMockChoice` (still
   correct/explanation-free by type, `domain.ts:248-276`) or the exam-phase fetch/pick
   flow. The only way this refactor could have reintroduced an answer leak is if it had
   modified the wire types or the exam-phase rendering — it did neither. Confirmed
   `MockReveal`/`MockResult` (the only place the answer key exists client-side) are
   populated exclusively post-submit.

4. **F-009 gating handles the "empty explanation" edge case correctly in both
   directions.** `TopikResults`'s render guard is
   `{!row.isCorrect && row.explanation.trim().length > 0 ? <p>...</p> : null}`
   (`MockMode.tsx:995-997`) — this correctly suppresses the paragraph both when the
   pick was correct (per F-009) *and* when the pick was wrong but the corpus has no
   explanation for that item (today's real-world case, per the 0/2088 coverage note),
   so no empty `<p>` ever renders. Verified against
   `Topik.test.tsx:279-300` ("omits the explanation paragraph when BOTH inline and
   server explanations are empty").

5. **Test suite genuinely targets pre-fix behavior, not just present behavior.**
   `MockMode.test.tsx:274` and `Topik.test.tsx:440` are both explicitly framed as
   regression tests against the old "always show explanation" behavior (their own
   comments say so), and the assertions (`queryByText(...).not.toBeInTheDocument()`)
   would in fact fail against a naive un-gated render. `Topik.test.tsx:302`'s stale-
   response guard test and `Writing.test.tsx`'s abort/timeout/429/502 coverage are
   similarly real regression tests, not tautologies.

## Detailed (file:line)

- `server/src/routes/gradeWriting.ts:32-39` — `GradeSchema`: `prompt` 1..2000,
  `sample` 1..5000, `rubric` enum default `topik_ii_54`, `.strict()`. `targetLevel`
  accepted but not forwarded (`:50-58`).
- `client/src/services/writing.ts:59,72-80` — `WRITING_CLAUDE_TIMEOUT_MS = 65_000`;
  `gradeWriting()` posts `{ prompt, sample, rubric }` with `{ timeout, signal }`.
- `client/src/pages/Writing.tsx:130-146` — `messageFor()`: fixed-string copy per
  `ApiError.status`/`.code`; only `retryAfter` (a number) is interpolated, never
  `err.message`.
- `client/src/pages/Writing.tsx:171-206` — `ctrlRef` abort-on-unmount effect +
  abort-before-resubmit in `submit()`; `ctrl.signal.aborted` guard before both the
  success and error state writes.
- `client/src/types/domain.ts:1712-1732` — `GradeWritingBody`/`GradeWritingResponse`
  documented as the sole shape, cross-referencing the server's `.strict()` schema.
- `server/src/services/claude/index.ts:1037-1063` — `parseGradeToolResult`/
  `mapGradeDimension`: snake_case tool output → camelCase `GradeResultSchema`.
- `server/src/services/claude/config.ts:32` — `CLAUDE_TIMEOUT_MS` default `60_000`.
- `server/src/middleware/rateLimits.ts:45-56` — `buildExpensive()` 429 body has no
  `retry_after` (SHOULD-FIX #1).
- `client/src/services/api.ts:104-119` — `retryAfter` only populated from
  `body.error.retry_after`.
- `client/src/types/domain.ts:248-252,259-276,308-314` — `TopikMockChoice` (no
  `correct`), `TopikMockItem` (no `explanation`), `MockReveal` (answer key, post-submit
  only).
- `client/src/pages/topik/MockMode.tsx:872-1015` — `ResultsReviewRow`/`ResultsSummary`/
  `TopikResults`; explanation gate at `:995-997`.
- `client/src/pages/topik/MockMode.tsx:1023-1064` — `buildMockResultsSummary`: maps
  server `MockResult`+answer-stripped items into `ResultsReviewRow[]`.
- `client/src/pages/Topik.tsx:211-248` — `bandForPercentage` (duplicated, NIT #1) and
  `buildStudySummary`.
- `client/src/pages/Topik.tsx:316-359` — `effectiveExplanation`/`buildReviewRow`:
  inline-explanation-first, server-reveal-fallback, keyed by item id against a stale
  response.
- `server/src/routes/topik.ts:327-332` — server `bandForPercentage`, verified identical
  thresholds/labels to the client copy.
- `client/src/pages/topik/MockMode.test.tsx:274-323` — F-009 regression test (mock).
- `client/src/pages/Topik.test.tsx:279-300,409-457` — empty-explanation, skip-as-miss,
  and F-009 regression tests (study).
