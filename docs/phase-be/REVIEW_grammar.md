# Independent Review — Grammar backend mini-phase (F-110 / F-111)

**Scope:** `server/src/routes/grammarDrill.ts` (new `GET /grammar-drill/attempts`,
F-110), `server/src/routes/grammar.ts` (F-111 FSRS schedule folded into
`GET /grammar/bank`), their route tests, `client/src/services/grammarDrill.ts`,
`client/src/pages/Grammar.tsx` (+ test), and the `types/domain.ts`
`GrammarCardSchedule` / `DrillAttemptHistoryRow` / `DrillAttemptsPage`
additions. Diff base: `rebuild`, branch `feat/phase-be-lightup` (commits
`d00cdeb` + `cb2c11a`).

**Reviewer:** independent senior review, report-only, no code changes made.

## Verdict

**PASS — ship-quality, 0 BLOCKERS.** The join-safety property F-111 depends on
(one row per bank pattern out of `GET /grammar/bank`) is enforced by a DB-level
partial unique index, not just application logic, so it holds even under a
future refactor. The `scheduleStatusLine` sub-day-threshold fix is read as
correct. Two SHOULD-FIX items (both test-coverage gaps, not logic bugs) and a
handful of NITs below; several PRAISE-worthy design choices are also called out.

## Security checklist

| Concern | Status | Evidence |
|---|---|---|
| User-scoped reads (no cross-user leak) | PASS | `grammarDrill.ts:579` (`WHERE user_id = $1 AND scored_at IS NOT NULL`); `grammar.ts:287` (`WHERE g.user_id = $1`) + join carries `vc.user_id = g.user_id` as belt-and-suspenders. Both paths have a dedicated cross-user test (`grammarDrill.test.ts` "is user-scoped (no IDOR)"; `grammar.test.ts` "does not leak another user's production-card schedule"). |
| Parameterized SQL | PASS | Every query in both routes uses `$n` placeholders; no string concatenation of user input into SQL anywhere in the reviewed diff. |
| Zod validation at the boundary | PASS | `AttemptsQuerySchema` bounds `limit` (1–100, default 20) and `offset` (≥0, capped at `MAX_SAFE_INTEGER`) — pinned by a `400` boundary test (`grammarDrill.test.ts` `it.each(['limit=0','limit=101','offset=-1'])`). |
| IDOR | PASS | F-110 is scoped by `user_id` in the `WHERE`, not by a client-supplied id — there's no id to tamper with. F-111's join adds no new attack surface (read-only, same route). |
| Rate limiting | PASS | `GET /grammar-drill/attempts` uses `cheapLimiter()` (correct bucket — plain DB read, not Claude-backed). `GET /grammar/bank` already carried `cheapLimiter()` before this change. |
| Answer/model-answer leakage | N/A to this diff | Not touched by F-110/F-111 (pre-existing answer-strip on `/grammar-drill` generate is untouched and still correct on inspection). |
| Type-unsafe boundaries | PASS | `NUMERIC` stability is carried as `string` end-to-end (`CardRow.stability: string` server-side, `GrammarCardSchedule.stability: string` client-side) — no silent float coercion that could misrepresent precision. |
| Client abort/error handling | PASS | `HistoryPanel` uses a real `AbortController`, checks `ctrl.signal.aborted` before each `setState`, and distinguishes `ApiError.code === 'canceled'` (silent) from a genuine failure (surfaced). No swallowed errors. |

No blockers found in the security checklist.

## Findings by severity

### BLOCKER
None.

### SHOULD-FIX

**SF-1 — No regression test pins the `scheduleStatusLine` sub-day fix for the F-111 mastery row.**
`client/src/pages/Grammar.tsx:1101` (`if (dueMs < ONE_DAY_MS) return \`${label} · due later today\`;`)
is the exact line that fixes the bug described in the task brief (a 6-minute
hard-step misreported as "1 day" because the old code presumably checked
`days < 1` *after* `Math.ceil`, which can never be true). The fix reads as
correct by inspection: the sub-day branch is checked strictly before the
`Math.ceil` day-bucketing, so no positive `dueMs` less than 24h can fall
through to the days branch.

However, `client/src/pages/Grammar.test.tsx`'s F-111 describe block
(`Grammar — F-111 mastery rows show the real FSRS schedule`, lines 779–840)
only exercises three cases: a 2.2-day-out `review` card (→ "3 days"), a
never-drilled pattern (→ "Not yet practiced"), and an overdue card (→ "due
now"). No case sets `dueAt` a few minutes in the future (the exact scenario
that was bugged) and asserts `"... · due later today"`. I grepped the whole
test file for `"due later today"` — zero occurrences. The *other* sub-day test
that exists (`renders the engine-true "~6 minutes" copy for a 0-day HARD
step`, line 1474) exercises a structurally different code path —
`scheduleLine(DrillSchedule)`, the post-submit reveal line, which takes
`scheduledDays` (an integer day-count with 0 as its own sentinel) rather than
a raw `dueAt` timestamp — so it does not cover `scheduleStatusLine`'s
timestamp-diff arithmetic at all. Recommend adding one case: `dueAt = now +
6min` on a `GrammarCardSchedule`, asserting the mastery row renders `"... ·
due later today"` (not a day count). Cheap to add, and it is precisely the
regression the task brief says was caught once already — without a test it
can silently regress again on the next refactor of this function.

**SF-2 — F-111 join-safety has no test that seeds a plausible *would-be*
duplicating row.** The row-multiplication safety is real and DB-enforced
(`uq_vocab_cards_user_grammar_production`, migration 020, a partial unique
index on `(user_id, grammar_entry_id) WHERE face = 'production' AND
grammar_entry_id IS NOT NULL AND deleted_at IS NULL` — see detailed analysis
below), so this is not a correctness gap. But the three F-111 route tests
(`grammar.test.ts:417-496`) only cover "never drilled" and "one drilled
pattern, one user" and "two different users, two different entries." None
seeds a *second* card for the same `(user, grammar_entry)` under conditions
the unique index would otherwise still block (e.g., a soft-deleted stale
production card via `deleted_at`, or a `recognition`-face card on the same
entry) to positively demonstrate the join can't fan out even at the boundary
of the partial index's own predicate. Not required for correctness (the index
makes it structurally impossible), but a test exercising "entry has both a
`recognition` card and a `production` card" would document, in the test
suite itself, that the `face = 'production'` filter is what keeps a
multi-face entry from returning two rows — right now that guarantee lives
only in the SQL comment.

### NIT

**N-1** — `grammar.ts:291-303`, the `card_state !== null && card_due_at !== null` guard destructures `card_stability!` with a non-null assertion justified by a same-row comment. Correct (all three columns come from one JOINed row, so they're null together), but worth a lint-suppression-free alternative for future readers: a small local type guard function would make the invariant checker-verifiable instead of comment-verifiable. Not blocking — the comment is accurate and the invariant is simple enough to eyeball.

**N-2** — `grammarDrill.ts:562-570`, the comment justifying the `scored_at IS NOT NULL` exclusion cross-references `GET /grammar/series`' "same exclusion" comment. Confirmed consistent: `grammar.ts:491` (`AND scored_at IS NOT NULL AND score IS NOT NULL`) applies the same rule for the averaging route. Good cross-consistency; no code change needed, just noting the cross-check passed.

**N-3** — Client `HistoryPanel`'s `formatHistoryDate` (`Grammar.tsx:1200`) falls back to the raw ISO string on an unparseable date rather than throwing — consistent with the "honest, never fabricate" posture elsewhere in this file. No issue.

**N-4** — `AttemptsQuerySchema` (`grammarDrill.ts:531-538`) caps `limit` at 100 vs. the KGIU browse's 400; the comment explains the reasoning (personal history feed vs. corpus browse) — reasonable, consistent with the smaller expected row count for one user's practice history.

### PRAISE

**P-1** — The `GET /grammar/bank` F-111 join is genuinely safe from row multiplication, and safe for two independent reasons, not just one: (a) `vc.face = 'production'` in the `ON` clause excludes every non-production card outright (a user could hold a `recognition` card for the same `grammar_entry_id` and it would never enter the join), and (b) even restricted to production cards, `uq_vocab_cards_user_grammar_production` (migration 020: `UNIQUE INDEX ... ON vocab_cards (user_id, grammar_entry_id) WHERE face = 'production' AND grammar_entry_id IS NOT NULL AND deleted_at IS NULL`) makes a second live production card for the same `(user, grammar_entry_id)` physically impossible to insert. The route comment (`grammar.ts:249-255`) correctly cites this index by name. This is a case where the safety property is enforced at the schema layer, which is stronger than an application-level "we always upsert" convention — a future code path that INSERTs a second production card directly would get a `23505` rather than silently duplicating the bank row.

**P-2** — `scheduleStatusLine`'s ordering (sub-day check before `Math.ceil`) is exactly right, and the in-code comment explains *why* the naive order is wrong ("`Math.ceil` of any positive value is already >= 1, so a post-ceiling `< 1` check can never fire") — this is the kind of comment that prevents the bug from being reintroduced by someone who "simplifies" the function later, even without SF-1's missing test.

**P-3** — F-110's exclusion of unscored (Skip) attempts is correct and intentionally mirrors an existing, independently-arrived-at exclusion in `GET /grammar/series` (`grammar.ts:491`, "unscored attempts never count"). Consistency across two independently-implemented endpoints reading the same table is exactly what avoids a "history shows N attempts but the average was computed over M" discrepancy. Verified both routes use the identical predicate (`scored_at IS NOT NULL`).

**P-4** — The `no-unsafe-finally` fix in `HistoryPanel.load` (`Grammar.tsx:1237-1245`) is behaviorally correct: it replaces what was presumably a `return` inside `finally` with a guard (`if (!ctrl.signal.aborted) { setLoading(false); setLoadingMore(false); }`). This is the right fix, not just a lint-satisfying one — a `return` in `finally` would have swallowed the try/catch's own control flow (masking whether the block completed normally, via `catch`, or via an uncaught throw), whereas the guard only skips two `setState` calls when a newer request has already superseded this one (aborted-current-tracks-latest is exactly right: an in-flight fetch that got superseded by a newer `load()` call must not flip `loading`/`loadingMore` back to false and let a stale render override the newer request's own loading state). Confirmed via `ctrlRef.current?.abort()` at the top of `load()` — every call aborts its predecessor before issuing a new `AbortController`, so "aborted" here always means "superseded," never "the only in-flight request got cancelled with no successor."

**P-5** — `DrillAttemptHistoryRow`/`DrillAttemptsPage` (`types/domain.ts:1437-1456`) are documented as intentionally snake_case to mirror `BankedGrammarRow`'s convention for direct DB-row reads, as opposed to the Claude-JSON-contract types (`DrillItemPublic`/`DrillScore`) which are camelCase. This is a real, stated convention (not an accidental inconsistency) and it is followed correctly throughout this diff.

## Coordination observations

- **`/grammar/bank` join safety (headline question): SAFE.** Confirmed via migration 020's partial unique index text (`db/migrations/020_grammar_production_card_uniq.up.sql:50-52`) plus the route's own `ON` clause (`face = 'production' AND vc.deleted_at IS NULL AND vc.user_id = g.user_id`, `grammar.ts:283-286`). The join can return at most one `vocab_cards` row per `grammar_entries` row: the `face` filter excludes non-production cards structurally, and the partial unique index makes a second *live* production card for the same `(user_id, grammar_entry_id)` un-insertable at the DB layer. This is not merely "the current code happens to upsert correctly" — it is schema-enforced, which is the stronger guarantee the task asked me to verify.
- **FSRS field mapping matches ADR-003 / `fsrs.ts` semantics.** `card_state`/`card_stability`/`card_due_at` map 1:1 onto `GrammarCardSchedule.state/stability/dueAt`; `stability` stays a `string` end-to-end (never `Number()`-coerced before the wire), consistent with `DueCard.stability`'s existing precision-safe convention. `schedule: null` for a never-drilled pattern is an honest "not started," not a synthesized new-card default — matches the file's stated design intent and ADR-003's "no fabricated data" posture used elsewhere in this codebase.
- **`scheduleStatusLine` fix is correct but under-tested (SF-1).** The logic itself is sound (sub-day check strictly precedes the day-ceiling), but as detailed above no test in `Grammar.test.tsx` exercises the specific sub-day (`dueMs` a few minutes out) case for the F-111 `GrammarCardSchedule` path — the existing sub-day tests (lines 1445-1499) cover a different function (`scheduleLine` for `DrillSchedule`, the post-submit reveal) that takes a pre-computed day-count rather than a raw timestamp, so they don't exercise the same arithmetic at all.
- **F-110 exclusion-of-Skips is consistent with F-017's `GET /grammar/series`.** Both use `scored_at IS NOT NULL` as the "counts as practice" predicate; verified by reading both route bodies side by side (not just trusting the comment's cross-reference).
- **No scope creep observed.** The diff stays inside the stated F-110/F-111 surface; the only adjacent touch (`server/tests/helpers/app.ts`'s `translatePassage` stub) belongs to a sibling feature (Reading `/translate`) merged into the same integration branch, not to this review's scope, and does not interact with the grammar routes.
