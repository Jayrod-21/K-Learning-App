# Review — F-099 grammar-mastery read route + Progress Grammar tab

Reviewer: independent (did not write this code). Branch `worktree-agent-ac141d99b94bbd0a3` @ 8aaa590, diffed against `rebuild`.

Scope: `GET /grammar/mastery` (server/src/routes/grammar.ts), `fetchGrammarMastery` + types (client/src/services/grammar.ts, client/src/types/domain.ts), `GrammarMasteryPanel` replacing the Grammar-tab placeholder (client/src/pages/Progress.tsx, Progress.css), and the three test files.

## Verdict

**PASS** — 0 BLOCKER, 0 SHOULD-FIX, 3 NIT, 4 PRAISE.

## Gates (run from the worktree)

| Gate | Command | Result |
|---|---|---|
| Server typecheck | `cd server && npm run typecheck` | 0 errors |
| Server route tests | `cd server && npx vitest run tests/routes/grammar.test.ts` | **75 passed** (1 file) |
| Client tests | `cd client && npx vitest run src/pages/Progress.test.tsx src/services/grammar.test.ts` | **83 passed** (2 files) |

(Only a pre-existing `pg` deprecation warning in the server run; unrelated to this diff.)

## Probe results (the things I was told to actively attack)

### 1. Ownership scope — CLEAN
- The shared derived table pins `WHERE g.user_id = $1 AND g.deleted_at IS NULL` (`server/src/routes/grammar.ts:502`) with `$1` always `getUserId(req)` (grammar.ts:527) — never a client-supplied id. Both the summary query (grammar.ts:546) and the list query (grammar.ts:574) select from that same fragment, so neither can drop the scope independently.
- The card join carries the belt-and-suspenders `vc.user_id = g.user_id` guard (grammar.ts:500), identical to `GET /grammar/bank`'s F-111 join (grammar.ts:287).
- Isolation is regression-tested with two real registered users: user B sees `total: 0` and `[]` after user A banks + drills (server/tests/routes/grammar.test.ts:1163-1174). This test would fail if the `$1` scope or the join guard were removed.

### 2. Fan-out / row multiplication — CLEAN
- Join conditions (grammar.ts:497-501): `grammar_entry_id = g.id AND face = 'production' AND user_id = g.user_id AND deleted_at IS NULL` — this is exactly the coverage of the partial unique index `uq_vocab_cards_user_grammar_production` (`db/migrations/020_grammar_production_card_uniq.up.sql:50-52`: `ON vocab_cards (user_id, grammar_entry_id) WHERE face = 'production' AND grammar_entry_id IS NOT NULL AND deleted_at IS NULL`), so at most one card row can match per pattern. No-card patterns survive via LEFT JOIN.
- Tested for real: a recognition-face card in `review` state (stability 99) on the same entry neither buckets the pattern nor duplicates the row — `patterns` stays length 1, bucket `'new'`, stability `null` (grammar.test.ts:1176-1195). A pattern with zero cards is also covered (grammar.test.ts:1050 `neverDrilled`).

### 3. Bucketing rules vs the rest of the app — CONSISTENT, divergences deliberate and correct
- `GRAMMAR_BUCKET_CASE` (grammar.ts:484-490) vs vocab's `BUCKET_CASE` (server/src/routes/vocab.ts:825-830): identical `new` / `learning`+`relearning` / `review && stability >= 21 → mastered` / else `reviewing` ladder, same `MASTERY_MATURE_DAYS = 21` constant (grammar.ts:458, vocab.ts:814). No drift on the shared semantics.
- Two additions, both spec'd for F-099 and defensible: `graduated_at IS NOT NULL → 'mastered'` first (the user explicitly marked the pattern known — migration 033), and `vc.id IS NULL → 'new'` (banked-but-never-drilled; FU-NF-42 creates the production card lazily). Both are documented at the CASE (grammar.ts:475-483) and both are tested (graduated-with-no-card → mastered: grammar.test.ts:1093-1109; no-card → new: grammar.test.ts:1050,1064).
- The 21-day boundary is pinned exactly: `stability 20.9999 → 'reviewing'`, `21 → 'mastered'` (grammar.test.ts:1055-1057). This test fails if the threshold or the `>=` drifts.
- Summary counts and list buckets come from the ONE shared SQL fragment (`GRAMMAR_MASTERY_SOURCE`, grammar.ts:493) so they cannot disagree — structurally stronger than vocab's separate `BUCKET_PREDICATE` map, and the summary-vs-filtered-count agreement is asserted (grammar.test.ts:1111-1131).

### 4. Injection / pagination — CLEAN
- Query params validated by a closed zod schema: `bucket` is `z.enum([...])`, `limit` int 1..100 default 30, `offset` nonnegative ≤ `MAX_SAFE_INTEGER` (grammar.ts:460-464) — an out-of-vocabulary bucket 400s before SQL (tested: grammar.test.ts:1133-1138).
- The bucket filter is a **bind parameter** compared against the derived column — `WHERE ($2::text IS NULL OR p.bucket = $2)` (grammar.ts:575) — no SQL fragment selection at all; strictly safer than vocab's (also safe) constant-map interpolation at vocab.ts:886. `MASTERY_MATURE_DAYS` is the only interpolated value and it is a server-side numeric const.
- Ordering is a total order (`stability DESC NULLS LAST, pattern_display COLLATE "C", id`, grammar.ts:576-577) so limit/offset pages are deterministic; verified with a 3-row/limit-2 walk (grammar.test.ts:1140-1161). `count(*) OVER ()` totals the *filtered* set, matching what the pager needs; the empty-page-past-the-end → `total: 0` quirk is byte-identical to vocab's and the client clamp handles it (below).

### 5. Progress tab wiring — CLEAN
- `GrammarMasteryPanel` (client/src/pages/Progress.tsx:1715-1889) is a faithful sibling of `WordMasteryPanel` (Progress.tsx:1480): same `LoadedGrammarMasteryPage {data, offset}` keep-stale contract (Progress.tsx:1700), same abortable direct fetch (deliberately not `useEndpointOrMock` — a mock fallback would fabricate progress), same stale-offset clamp that strictly decreases and refires the effect (Progress.tsx:1755-1760), same shown-offset-vs-requested-offset discipline for the pager text and disabled states.
- States all handled: first-load spinner; first-load failure → `ErrorCard` with retry; loaded-then-refetch-failure → `role="alert"` stale banner + inline Retry with the last page still rendered (no flicker — `page` is only replaced on success); `summary.total === 0` → bilingual invitation, never a zero bar; filtered-empty → "No patterns in this group." with the `MasteryBar` still present to escape the filter.
- Never-drilled rows render `—` (guarding `stability === null` explicitly, Progress.tsx: the `km-mastery__stab` span) — the server's honest `null` is never coerced to `0d`.
- a11y rides on the shared family: `MasteryBar` exposes the `role="img"` summary label (asserted in Progress.test.tsx:1300-1304), bucket chips are real buttons, the list is a semantic `ul`/`li`, the stale banner is `role="alert"`, pager uses real `Button`s with disabled states.
- Placeholder fully gone: `.km-progress__soonhead/soonbody/soonicon` deleted from Progress.css (only an explanatory comment remains, Progress.css:634-637); no `soon*` class referenced anywhere in `client/src`; the unused `Pill` import was removed; `Icon` stays imported because it is still used 3 times elsewhere on the page. The old "coming soon" test was replaced, and the new test asserts the placeholder strings are absent (Progress.test.tsx:1312-1316).

### 6. Tests real? — YES
- Server tests run against the real app + real Postgres (testcontainer), create patterns via the real `POST /grammar/bank`, and inject production cards with controlled FSRS states. The ownership, fan-out, threshold-boundary, filter-vs-summary, pagination, graduated, 401, and invalid-bucket tests each pin exactly the property they name — removing the user scope, the face condition, or the 21-day comparison makes a specific test fail.
- Client: service tests pin URL/params/signal passthrough (including params-omission); page tests cover render, filter refetch params, empty state, and error→retry recovery through the real component tree.

## Findings

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
1. **Two sequential queries per request** — `server/src/routes/grammar.ts:539-583`: the summary and list queries are awaited back-to-back; `Promise.all` would halve latency. Vocab's `/mastery` has the identical shape, so this is a pre-existing family convention, not a regression — fix both together or not at all.
2. **Soft-deleted card path untested** — the join's `vc.deleted_at IS NULL` (grammar.ts:501) has no dedicated test (a pattern whose production card was soft-deleted should bucket `'new'`). The recognition-face test covers the join-selectivity idea, but this specific predicate could be dropped without a red test. Low risk (same predicate is exercised elsewhere), worth one test whenever this file is next touched.
3. **Graduated-with-live-card display quirk** — a graduated pattern that still has a learning-state card shows a `Mastered` badge with its raw stability (e.g. `2d`) in the list (Progress.tsx stab span; server sends the card's real stability). Honest data, mildly incongruous visually; also such rows sort by that low stability rather than with other mastered rows. Cosmetic; matches the "report the real card" philosophy.

### PRAISE
1. The one-shared-SQL-fragment design (`GRAMMAR_MASTERY_SOURCE`, grammar.ts:493) structurally prevents summary/list bucket disagreement — an improvement over the vocab route it mirrors.
2. Bucket filter as a bind parameter against the derived column (grammar.ts:575) instead of predicate-string selection — the strictly safer idiom.
3. The 20.9999/21 boundary test (grammar.test.ts:1055-1057) and the recognition-face fan-out test (grammar.test.ts:1176) are precisely the tests a reviewer would demand; both would catch real regressions.
4. `stability: null` (never `0`) for never-drilled patterns is carried honestly through the whole stack — SQL → DTO → type comment (client/src/types/domain.ts:906-908) → the `—` render.

## Route reachability note

`/grammar/mastery` lives under the existing `/grammar` top-level prefix, which is already in the km-lb nginx allow-list — no `nginx-{blue,green}-active.conf` change needed (the F-012 new-prefix trap does not apply).
