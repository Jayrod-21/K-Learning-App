# Review — F-014 Frontend Slice (Writing rework)

**Commit:** `a8ff23b` · **Scope:** `client/src/pages/Writing.tsx(+test)`, `client/src/services/writing.ts(+test)`, `client/src/services/stats.ts(+test)`, `client/src/pages/Today.tsx(+test)`, `client/src/data/mocks/stats.ts`, `client/src/types/domain.ts`
**Reviewer:** independent senior React review (did not author this code)
**Test run:** `vitest run` in `node:20-slim` docker — **4 files, 45 tests, all passing** (1.47s)

## Verdict: **PASS — approve for merge.** 0 BLOCKER, 0 SHOULD-FIX, 6 NIT, 4 PRAISE.

The two highest-risk properties named for this review both hold, and both are proven by tests rather than asserted in comments. The slice matches the locked contract in `DESIGN_F014.md` §Client changes exactly.

---

## The two highest-risk judgments

### 1. Outage-vs-empty distinction on the Today Writing panel — CORRECT

`Today.tsx:203-215` implements a true three-way branch, in the right precedence order:

1. `series.metric === 'none'` → **"No data yet"** — this is only ever the client-side degraded placeholder (`stats.ts` `unavailableSeries()`), i.e. `/writing/series` *failed*. A failed route can no longer masquerade as the encouraging invitation.
2. `skillKey === 'writing' && series.points.length === 0` → **"Start writing to see your progress here."** — reachable only when the route *answered* with a real `metric:'score'` series that has zero points (new user, no graded attempts).
3. else → the real `LineChart`.

Because branch 1 is checked first, a failed route cannot fall into branch 2, and an empty-real series cannot render a degenerate chart. All three states are covered by dedicated tests (`Today.test.tsx:310-334` chart + headline `72%` + no invitation; `:336-353` empty-real → invitation, no chart; `:355-372` `metric:'none'` → "No data yet", explicitly asserting the invitation is absent). The failure-path test's comment even states the requirement ("must NOT invite the user as if they had never written").

Headline safety: `latestValue` (`Today.tsx:173-179`) returns `'—'` when `points` is empty (`last === undefined` guard) — no `NaN`/`undefined` for the empty or degraded writing series. Keying the `%` formatting on `unit === '%'` instead of `metric === 'accuracy'` is the right generalization: writing is `metric:'score', unit:'%'`, and grammar (`'pts'`) keeps its old path. No other series carries `unit:'%'` except TOPIK accuracy, whose behavior is unchanged.

### 2. No fabricated promptId — HOLDS

Verified along every path:

- **No mock module exists.** `client/src/data/mocks/` has no `writing.ts`; `Writing.tsx` calls `fetchWritingPrompts` directly (not through `useEndpointOrMock`), so there is no mock-fallback layer that could inject a synthetic prompt. `fetchWritingPrompts` (`writing.ts:88-98`) rejects on failure — the test `writing.test.ts` "surfaces a failed load as ApiError (no swallow, no fallback)" pins this.
- **`promptId` originates only from a fetched DTO.** The single `gradeWriting` call site is `Writing.tsx:241-246`, and `task.id` is only ever an element of the fetched `prompts` array (`Writing.tsx:215-220`; `task` is `null` while loading, on fetch failure, and on an empty pool).
- **Submit is unreachable without a real prompt — twice over.** UI level: the entire compose surface (textarea + both buttons) renders only in the `task !== null` branch (`Writing.tsx:343-424`); loading/error/empty states have no submit affordance at all. Logic level: `canSubmit` requires `task !== null` (`:295`) and `submit()` early-returns on `task === null` (`:233`) — belt and suspenders against any future render reshuffle.
- **Tests pin the exact wire body.** `Writing.test.tsx` "submits the served prompt + promptId…" uses `toEqual` (not `toMatchObject`) on `{ prompt, sample, rubric, promptId: 101 }` — with the server schema `.strict()`, this genuinely is the wire contract. The rubric-switch test additionally asserts `promptId: 201` from the other pool.

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT

1. **`Writing.tsx:174,181-182` — `promptsCtrlRef` is dead weight.** React guarantees the effect cleanup (`:202-204`, which aborts) runs before the effect re-executes and on unmount, so `promptsCtrlRef.current?.abort()` at the top of the effect body is always a no-op (the previous controller is already aborted), and the ref is never read anywhere else (`retryPrompts` only bumps the tick). Harmless, but it implies the cleanup alone were insufficient. Ttmik carries the same idiom, so fixing it is an idiom-wide cleanup, not a one-file patch.
2. **`Writing.tsx:171,185-189` — `promptsLoading` is fully derivable** (`prompts === null && promptsError === null` is exactly the loading condition through every transition), which would shrink the `set-state-in-effect` disabled block from three calls to two. See the lint-exception judgment below — the disable as written is acceptable, but the derivation would make it smaller.
3. **`Writing.tsx:337-342` — the empty-pool state has no in-place recovery affordance.** An empty pool is an honest server answer (not an error), and toggling the rubric tab away and back does refetch, but a "Check again" button would match the screen's own "never a dead end" doctrine. With migration 038 seeding 3 prompts per rubric this is theoretical today.
4. **`Writing.tsx:271-278` — "New prompt" on a pool of size 1** silently clears the learner's draft and re-shows the same prompt (cursor increments, modulo wraps to the same element). Pool sizes are now server-controlled, so a 1-prompt rubric is possible. Not out-of-bounds, not a crash — just a mildly destructive no-op. (Bounds safety itself is correct: `taskIdx[rubric] % prompts.length` on a guarded non-empty array is always valid, including when a refetch changes the pool size; size 0 routes to the `task === null` empty state before indexing.)
5. **`Today.test.tsx:336-372` — the invitation and outage tests assert via `getByText` across all (aria-hidden) panels** without navigating to page 5, unlike the chart test. Unambiguous with these fixtures (only writing is empty/degraded), but navigating would make the assertions panel-scoped and future-proof against another skill legitimately showing "No data yet".
6. **No test for the prompts-fetch stale-response race** (rapid rubric switching / unmount while in flight). The implementation is safe — cleanup aborts, and both `.then`/`.catch` guard on `ctrl.signal.aborted` plus the `canceled` code (`Writing.tsx:192,197-198`) — and the identical pattern is test-proven in Ttmik, but this file's own suite doesn't exercise it.

### PRAISE

1. **The prompt-fetch effect is textbook** (`Writing.tsx:179-205`): fresh `AbortController` per run, abort-on-cleanup covering both rubric change and unmount, settle guards on `signal.aborted` *and* the `canceled` error code (double protection against late-settle state clobber), and a `promptsTick` monotonic-retry trigger identical to the codebase's established Ttmik idiom. Loading, error, and empty states are all first-class renders (`:331-342`) — no crash, no blank, no eternal spinner on `[]`.
2. **`stats.ts` degradation semantics are exactly right** (`stats.ts:87-111`): the 4th leg joins `Promise.allSettled`; a failed `/writing/series` degrades to a *fresh* `metric:'none'` placeholder (never fabricated points, never a shared mutable object — re-pinned by the total-outage test), while an aborted fan-out still **rethrows** `canceled` (`:95-99`) so cancellation is never mistaken for "no data" — and the pre-existing "still rejects on cancellation" test survives the rewire. The happy path, per-skill failure, writing-only failure, topik-pair failure, and total outage are each independently tested.
3. **Test adequacy is genuinely strong, with no vacuous tests.** All 9 pre-existing Writing behaviors survive the rewire (title/compose, disabled-until-typed, submit body, pending state, 429+retryAfter, generic failure preserving text, rubric switch, revise, prompt rotation), plus new coverage for: loading state (compose surface absent), fetch failure with a Retry that provably refetches (`toHaveBeenCalledTimes(2)`), honest empty-pool state, **both** B-016 429 branches (with `retryAfter: 42` asserting `/42 seconds/`, and without asserting the fallback copy and explicitly `not.toHaveTextContent(/seconds/)`), and no-refetch rotation (`toHaveBeenCalledTimes(1)` after "New prompt"). The stats stub refactor (`stubApiGet(failing)`) removed three ad-hoc mock implementations without losing any assertion.
4. **Boundary type discipline.** Zero `any` in the slice; errors typed `unknown` and narrowed via `instanceof ApiError`; `WritingPromptDTO` mirrors the server DTO field-for-field including the nullable `promptEn`/`estMinutes` (and the render guards `promptEn !== null` rather than truthiness); `GradeWritingBody.promptId?: number` under `strict` mode with the value always supplied at the sole call site.

---

## Specific probes requested

- **`set-state-in-effect` disable (`Writing.tsx:183-189`) — justified, with a caveat.** It *is* a genuine sync-to-external-system kickoff (reset + fetch keyed on `rubric`/`promptsTick`), the disable is narrowly scoped with an accurate comment, and it matches three identical documented instances in `Ttmik.tsx` (:296-301, :414-419, :571-576) and `Reference.tsx:180` — deviating here would fragment the codebase idiom. It is technically *maskable* (derive `promptsLoading`, move the error/prompts reset into `switchRubric`/`retryPrompts` — the only two triggers), but that trades an honest, precedented exception for reset logic duplicated across two handlers. Acceptable as shipped; NIT #2 notes the partial shrink. No `react-hooks/refs` concerns: both refs are touched only inside effects/callbacks, never during render.
- **B-016 retry countdown — live and correct, both ways.** The server 429 body is `{ error: { code, message, retry_after } }` (`server/src/middleware/rateLimits.ts:54`), which is precisely the shape `ApiError` parses (`services/api.ts:106-111`, finite-positive-number guarded), surfacing as `err.retryAfter` for `messageFor` (`Writing.tsx:118-123`). With `retryAfter`: fixed copy interpolating only the number (`Math.ceil`, no server prose). Without: graceful fixed wait copy. Both branches tested. Note it renders a static "in about N seconds" message, not a ticking countdown — consistent with the pre-existing design ("renders the structured retryAfter seconds"), not a regression.
- **`mocks/stats.ts` writing fixture** now carries a realistic `score`/`%` shape — correct: the fixture is the explicit mock-mode fallback and must mirror the wire; since `fetchSkillSeries` never rejects (except abort), it cannot leak into real-mode failure handling, which the degradation tests confirm.

## Verification performed

- Read `DESIGN_F014.md` §Client changes and the full `a8ff23b` diff for every in-scope file; read post-commit `Writing.tsx`, `Today.tsx`, `stats.ts` in full.
- Cross-checked contracts outside the slice where the slice depends on them: `ErrorCard` (`onRetry` renders a real Retry `<button>`, `role="alert"`), `ApiError.retryAfter` parsing, the server 429 body shape, and the Ttmik/Reference lint-exception precedents.
- Confirmed absence of any writing-prompts mock module (`client/src/data/mocks/` listing + grep).
- Ran the four test files in the prescribed docker sandbox: **45/45 passing**.
