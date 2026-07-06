# Review: P1 — TOPIK passage + Diagnostic

**Reviewer:** Independent senior engineer (did not author the code)
**Branch:** `p1-bug-fixes`
**Scope:** B-008 (TOPIK passage rendering), B-006 (diagnostic grading no longer blocks on Claude), the integration 502 fix in `diagnostic.ts`, the shared `sharedPassageFor` extraction, and the client surfaces.
**Bar:** `/home/jared-williams/projects/SENIOR_ENGINEER_BAR.md` (§0 error handling / no swallowed errors, §2.8 / §3 answer-strip on the mock wire, §4.6 concurrency, §5.2 regression tests).

---

## Summary verdict

**APPROVE.** This is high-caliber work. All four evaluation targets are met correctly and the security property that matters most — the mock/diagnostic wire staying answer-stripped — is preserved *at the type level*, not by runtime deletion, so a leak cannot compile through. B-006 genuinely decouples grading from generation: `/answer` does pure DB work and never touches the Claude proxy; generation moved to `/next`. The 502 fix is surgically scoped (wraps only the proxy call, always throws, so `result`'s type is unchanged and no DB error is swallowed). Every fix ships with a regression test that fails on pre-fix code.

**Blockers: 0. Should-fix: 0. Nits: 3. Praise: 5.**

---

## Bar checklist

| Gate | Verdict | Evidence |
|---|---|---|
| Mock wire stays answer-stripped (no `correct`/`explanation`) | PASS | `toMockItemDTO` (topik.ts:300) omits both at the **type level** (`Omit<TopikItemDTO,'options'\|'explanation'>`); test asserts `JSON.stringify(item)` has no `correct` and choice keys are exactly `['en','id','kr']` (topik.test.ts:300-307, 379-388) |
| Passage is question content, safe on mock wire | PASS | `passage` survives the strip deliberately; rendered before choices in Study, Mock exam, and Mock review (Topik.tsx:447, MockMode.tsx:587, MockMode.tsx:942) |
| Passage joined + emitted (study + mock); graceful when absent | PASS | `ITEM_COLUMNS` joins `t.passages`; `mapRowToDTO` omits `passage` when none covers the item; listening/writing degrade to null |
| `sharedPassageFor` extraction behavior-identical | PASS | Helper is a byte-for-byte lift of the diagnostic inline logic; both `topik.ts` and `diagnostic.ts` call it; malformed keys/values skipped, never thrown (passages.ts:29-40) |
| B-006: `/answer` returns reveal with NO Claude call in path | PASS | `/answer` does grade + θ-bump + `explainFor` (all DB); generation lives only in `/next`; test proves `genCalls===0` across `/answer` even at a vocab ordinal (diagnostic.test.ts:390-438) |
| CAT/scoring + answer-tamper property preserved | PASS | `nextTheta` still computed under `FOR UPDATE` in `/answer`; `/next` only *reads* θ; `toClientItem`/`pendingClientItem` strip `correctAnswer`+`explain` |
| Concurrency preserved (double-answer, insert race) | PASS | single-shot `UPDATE … WHERE answered_at IS NULL` rowCount check (409); `/next` catches 23505 and re-serves winner |
| 502 fix wraps ANY generation failure, no over-catch, no mistype | PASS | `.catch` on the proxy call only, always `throw`s → returns `never` → `result` type intact; DB seed calls outside the catch still 500 (diagnostic.ts:407-422) |
| Regression tests fail on pre-fix code | PASS | see Test Adequacy below |
| No swallowed errors / fail loud | PASS | every route `catch`→`next(mapClaudeError(err))`; generation failure is a loud UpstreamError |

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT

- **N1 — `sharedPassageFor` guards `=== null`, not `== null`.** If a caller ever passes `undefined` (e.g. a future query that forgets the `t.passages` join), `Object.entries(undefined)` throws instead of degrading to null. Every current call site passes the joined, null-able column so this is latent, not live. A defensive `if (passages == null)` would fully close it. (passages.ts:28)
- **N2 — Range-key parsing tolerates degenerate keys via `Number('') === 0`.** A malformed key like `"-5"` parses to range `[0,5]` and `"19-"` to `[0,19]`. Corpus-controlled data, so no exploit, and the intent (skip garbage) is met for the realistic cases the test covers — but a stray key could over-match. (passages.ts:32-36)
- **N3 — Two small duplications remain across the item sources.** `answerToChoiceIndex` (topik.ts:179) and `topikCorrectChoice` (diagnostic.ts:245) re-implement the same 1-based→0-based coercion; the code comments acknowledge the mirror. Out of scope for this pass, but a candidate for the same extraction treatment `sharedPassageFor` just received.

### PRAISE

- **P1 — Type-level answer strip.** `TopikMockItemDTO`/`TopikMockChoiceDTO` are `Omit`-derived so `toMockItemDTO` *physically cannot* emit `correct`/`explanation` — a regression that copied them would fail to compile. This is the correct way to enforce a security invariant (SENIOR_ENGINEER_BAR §0 "fail closed"). Mirrored on the client (`TopikMockChoice`, domain.ts:248).
- **P2 — B-006 decoupling is real and proven.** The reveal path is pure DB; the decoupling test injects a hard-down proxy that counts invocations and asserts `genCalls===0` through the grade of the pre-vocab item, then `502` only on `/next`. That is exactly the pre-fix failure mode captured as a regression (diagnostic.test.ts:390-438).
- **P3 — The 502 `.catch` is scoped with a written rationale.** It wraps only `generateDiagnosticItem`, always throws (so `result` stays typed), and leaves the DB seed calls uncaught so a DB fault still 500s. The inline comment even explains the `never`-return typing. Textbook.
- **P4 — Concurrency invariants held under the split.** The `FOR UPDATE` single-shot in `/answer` and the 23505 re-serve in `/next` keep the CAT "one item in flight" invariant; both are covered by dedicated race tests (diagnostic.test.ts:323-380, 440-515).
- **P5 — XSS posture consistent end-to-end.** Passage renders as a React text node in `TopikPassage`, with a test asserting hostile markup stays literal (`document.querySelector('img')` is null). Matches the prompt/choice posture already in place.

---

## Detailed findings (file:line)

**B-008 — passage join + emit + strip**
- `server/src/services/topik/passages.ts:24-41` — `sharedPassageFor`: null-passages short-circuit, non-string/blank values skipped, non-numeric keys skipped, range-inclusive match. Correct and defensive (see N1/N2 for the two edges).
- `server/src/routes/topik.ts:341-347` — `ITEM_COLUMNS` adds `t.passages AS test_passages` and aliases `topik_items i`; the accompanying comment explains why every query must join `topik_tests` (ambiguous `id`, 42702). All five queries (items/mock/mock-submit/study/answer) use it consistently.
- `server/src/routes/topik.ts:236-253` — `mapRowToDTO`: `prompt` = prompt-else-stem; `passage` = shared-else-(stem when a prompt already occupies the prompt slot). Fixes the old `prompt ?? stem` masking (B-008 defect #1). Correct.
- `server/src/routes/topik.ts:300-313` — `toMockItemDTO`: enumerated field copy; `passage`/`passageRef`/`hasImage`/`imageText` retained, `correct`/`explanation` unreachable by type.
- `server/src/routes/diagnostic.ts:281-303` — `buildTopikItem`: own-stem-first, else `sharedPassageFor`; `kind` becomes `passage-mc` when a passage resolves; reading item spreads `passage`. Listening transcript fallback chain includes the shared passage (diagnostic.ts:313-316). Behavior identical to the pre-extraction inline version.
- Client render order (passage before choices): `client/src/pages/Topik.tsx:447`, `client/src/pages/topik/MockMode.tsx:587` (exam) and `:942` (review), `client/src/types/domain.ts:187-206, 259-274`.

**B-006 — grading decoupled from generation**
- `server/src/routes/diagnostic.ts:742-873` — `/answer`: `cheapLimiter`, grade + θ under `FOR UPDATE`, single-shot UPDATE (409 on rowCount≠1), `explainFor` is a DB read, response carries `result`+`done`+`progress` and **no** `next`. No proxy import reached on this path.
- `server/src/routes/diagnostic.ts:956-1044` — `/next`: `expensiveLimiter`, idempotent pending re-serve, advance-past-max-ordinal, 23505 race handling, `next:null` on exhaustion.
- `client/src/pages/Diagnostic.tsx:441-511` — `prefetchNext` fires as soon as a reveal lands; `advance` consumes the in-flight promise, so Claude latency overlaps the reveal dwell (the UX intent of B-006).

**Integration 502 fix**
- `server/src/routes/diagnostic.ts:401-422` — `.catch` on `proxy.generateDiagnosticItem(...)` re-throws `UpstreamError` (default 502 per errors.ts:67-79). Scoped to the proxy call only; `pickVocabSeed`/`pickGrammarSeed` (diagnostic.ts:398) are outside it and still surface DB faults as 500. `mapClaudeError` (diagnostic.ts:1302-1309) remains for structured proxy errors on other paths; generation failures now normalize to 502 before it.

**Test adequacy (would fail on pre-fix code)**
- B-008 mock passage + strip (topik.test.ts:269-308): pre-fix emitted no `passage`, so `expect(item.passage).toBe(PASSAGE)` fails; strip assertions guard against re-introduction.
- B-008 stem-masking (topik.test.ts:310-328): pre-fix `prompt ?? stem` dropped the stem → no `passage`; test asserts stem now rides in `passage`.
- B-008 malformed passages (topik.test.ts:330-351): asserts hostile `passages` degrade to no-passage without a 500.
- B-006 decoupling (diagnostic.test.ts:390-438): pre-fix `/answer` generated inline → `ans2` would 502 and `genCalls===1`; both assertions flip on old code. This same test is the **502-on-outage** assertion (`next3.status===502`) — pre-`.catch` the raw `Error` (no `httpStatus`) passed through `mapClaudeError` to a generic 500.
- Section↔kind (diagnostic.test.ts:712-753): independent 502 path preserved.
- Concurrency (diagnostic.test.ts:323-380): θ not double-bumped, no second item in flight after a replayed responseId.

---

## Coordination observations

- **Shared helper is the right seam.** Extracting `sharedPassageFor` into `services/topik/passages.ts` and consuming it from both `topik.ts` and `diagnostic.ts` removes the previously-duplicated inline logic (DRY, SENIOR_ENGINEER_BAR §0). The two callers wrap it with different prompt/stem resolution, which is correct — the surfaces have different DTO semantics, so only the range-matching primitive is shared.
- **Study vs Mock answer posture is intentional and documented.** Study DTOs carry inline `correct`+`explanation` by design (public reference data, contract §B); only Mock/Diagnostic strip. The header comments (topik.ts:11-30, 266-279) make this explicit so a future reader doesn't "fix" the study inline answers as a leak.
- **Client and server agree on the wire shape.** `TopikMockItem`/`TopikMockChoice` (domain.ts) mirror the server `Omit`s field-for-field; `ClientItem`/`pendingClientItem` produce identical shapes on both diagnostic serve paths, so `/next`'s re-serve and fresh-serve can't diverge.
- **N1 is the one thing worth a follow-up ticket** if any new query ever selects items without the `t.passages` join — cheap to preempt with `== null`.
