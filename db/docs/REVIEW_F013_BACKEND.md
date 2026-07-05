# Review

**Scope:** `GET /vocab/mastery` — `server/src/routes/vocab.ts:803-919` (route, `MASTERY_MATURE_DAYS`, `MasteryQuerySchema`, `BUCKET_CASE`, `BUCKET_PREDICATE`) and its test coverage in `server/tests/routes/vocab.test.ts:1055-1108`.

**Reviewer:** independent read, no code changed. Cross-checked against the live `km-db` data and ran the new test block.

## Verdict

**APPROVE.** No blockers. The bucketing logic is provably consistent across the summary FILTER clauses, `BUCKET_CASE`, and `BUCKET_PREDICATE`; there is no SQL-injection surface; user isolation is enforced on every query; and the live-data cross-check matches the stated real-user numbers exactly (195/43/4/0/242). The only issues found are test-coverage gaps (SHOULD-FIX) and minor nits — nothing that would make a senior engineer refuse this PR.

**Findings:** 0 BLOCKER · 2 SHOULD-FIX · 2 NIT · 2 PRAISE.

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **No test exercises the `stability` mature boundary at exactly `MASTERY_MATURE_DAYS` (21).** The implementation is correct (summary FILTER, `BUCKET_CASE`, and `BUCKET_PREDICATE` all use the identical `>= 21` / `< 21` split — see Detailed §1), but nothing in `vocab.test.ts` pins a card at `stability = 21` and asserts it lands in `mastered` (not `reviewing`). This is exactly the kind of edge value a future refactor could silently flip (e.g. someone "fixing" one of the three call sites to `>` instead of `>=`) without a test catching it. Add a case: seed a review-state card at `stability = 21` and assert `bucket === 'mastered'` in both the word row and the summary count.

2. **No test exercises a non-vocab card (grammar/topik, `vocab_entry_id IS NULL`) being excluded from `/vocab/mastery`.** The exclusion is correctly implemented in both queries (the summary via an explicit `vocab_entry_id IS NOT NULL` predicate, the word list implicitly via the `INNER JOIN vocab_entries`), and the task brief specifically calls this edge out as something to verify — but no regression test seeds a grammar production card (which every other test file in this route, e.g. `vocab.test.ts:366-392`, already knows how to construct) alongside a vocab card and asserts the grammar card is invisible to both the summary total and the word list. Without this test, a future change that widens the word-list join (e.g. to also surface grammar mastery) could silently double-count in the summary without any test failing.

### NIT

3. **`server/src/routes/vocab.ts:1103-1107`** — the "rejects an invalid bucket with 400" test only asserts `res.status === 400`; every sibling validation-rejection test elsewhere in this file (e.g. `vocab.test.ts:311-318`) also asserts `res.body.error.code === 'validation_error'`. Cheap to add for consistency and it guards against the error envelope silently changing shape.

4. **`server/src/routes/vocab.ts:887`** — the word-row type declares `due_at: Date | null`, but `vocab_cards.due_at` is `NOT NULL DEFAULT now()` (confirmed live: `db\d vocab_cards`). The nullable type and the `r.due_at ? … : null` guard at line 910 are dead defensiveness — harmless, but slightly overstates the actual nullability of the column. Not worth a fix on its own, just noted since every other nullable-looking field in this route (`stability`, `english`) genuinely can be null/zero while this one cannot.

### PRAISE

5. **`server/src/routes/vocab.ts:814-829`** — `BUCKET_CASE` and `BUCKET_PREDICATE` are defined once, as the single source of truth, and the summary query's `FILTER` clauses are hand-written to match rather than sharing a third string — but all three were verified byte-for-byte identical on the state/stability predicates (`fsrs_state = 'new'`, `IN ('learning','relearning')`, `= 'review' AND stability {<,>=} 21`), and `fsrs_state` is a closed 4-value Postgres enum (`001_core_schema.up.sql:140`), so the `CASE`'s `ELSE` branch is provably exhaustive for exactly the `'review' AND stability < 21` case — there is no reachable state where the three bucketing expressions could diverge. Good defense against enum drift is already in place (a 5th enum value added later would need a code change to reach the `CASE` at all, since Postgres enums require an explicit `ALTER TYPE`).

6. **`stability NUMERIC(10,4) NOT NULL DEFAULT 0`** (`001_core_schema.up.sql:674`) closes off the NULL-stability edge case the task brief asks about — there is no code path where a card can reach `/mastery` with `stability IS NULL`, so the `>= / <` comparisons never degrade to SQL `UNKNOWN`. Confirmed live against `km-db`'s `\d vocab_cards`.

## Detailed (file:line)

### Correctness

- **`server/src/routes/vocab.ts:817-829`** — `BUCKET_CASE` and `BUCKET_PREDICATE` compared clause-by-clause against the summary `count(*) FILTER` expressions at `vocab.ts:860-864`:
  | bucket | summary FILTER | BUCKET_PREDICATE | BUCKET_CASE branch |
  |---|---|---|---|
  | new | `fsrs_state = 'new'` | `c.fsrs_state = 'new'` | `WHEN c.fsrs_state = 'new'` |
  | learning | `fsrs_state IN ('learning','relearning')` | same | `WHEN c.fsrs_state IN (...)` |
  | reviewing | `fsrs_state = 'review' AND stability < $2` | `c.fsrs_state = 'review' AND c.stability < 21` | falls to `ELSE` (only reachable when state='review' and stability<21, since `fsrs_state` is a closed enum) |
  | mastered | `fsrs_state = 'review' AND stability >= $2` | `c.stability >= 21` | `WHEN ... stability >= 21 THEN 'mastered'` |
  All four agree. `$2` in the summary query is `MASTERY_MATURE_DAYS` (a bound parameter, not interpolated) — the *only* place the constant is passed as a real bind parameter rather than a string-interpolated literal, which is a nice touch (defense in depth even though the interpolated form is also provably safe, see Security below).

- **`server/src/routes/vocab.ts:865-866` vs `:895-896`** — the summary explicitly filters `vocab_entry_id IS NOT NULL`; the word list relies on `JOIN vocab_entries v ON v.id = c.vocab_entry_id` (an INNER JOIN — a NULL FK can never match, so the row is silently dropped). Both paths correctly exclude grammar/sentence/topik cards from "word mastery." Verified live: the real user (`user_id=1`) has `non_vocab_cards = 0` (all 243 of their cards are vocab cards), so this exclusion is untested against **real** data — see SHOULD-FIX #2 for the missing synthetic regression test.

- **`server/src/routes/vocab.ts:866` vs `:896`** — `deleted_at IS NULL` is applied identically in both queries. Verified live: `user_id=1` has exactly 1 soft-deleted card, and `242 = 243 - 1`, matching the endpoint's live summary total exactly (see Live verification below).

- **Total split (`vocab.ts:912`)** — `words` `total` is a filtered `COUNT(*) OVER()` (reflects `?bucket=` if given), while `summary.total` is always the full unfiltered count. This exactly matches the test's own assertion at `vocab.test.ts:1089-1090` (`only.body.total === 1` under `?bucket=mastered` vs `only.body.summary.total === 3`) and is the only sane contract for a client rendering "3 of 242 total, showing 1 filtered."

- **Stability boundary (`= 21` exactly)** — logically verified consistent (all three expressions use `>= 21` for mastered / `< 21` for reviewing, so `21` itself always lands in `mastered`), but **not covered by any test** — see SHOULD-FIX #1.

- **NULL stability** — not reachable; `vocab_cards.stability` is `NUMERIC(10,4) NOT NULL DEFAULT 0` (`001_core_schema.up.sql:674`, confirmed live via `\d vocab_cards` on `km-db`). No dead code was written to defend against it, correctly, since the DB constraint already rules it out.

- **`vocab_entry_id IS NULL` card (grammar/topik)** — correctly excluded from both the summary (explicit predicate) and the word list (INNER JOIN). Not covered by any test — see SHOULD-FIX #2.

### Security

- **User isolation** — every query is scoped: summary at `vocab.ts:866` (`WHERE user_id = $1 …`), word list at `vocab.ts:896` (`WHERE c.user_id = $1 …`). `userId` comes from `getUserId(req)` (the authenticated session), never client-supplied. Confirmed via test `"never counts another user's cards"` (`vocab.test.ts:1093-1101`), which passed.
- **SQL injection via `BUCKET_PREDICATE[q.bucket]`** — `q.bucket` is typed `z.enum(['new','learning','reviewing','mastered']).optional()` (`vocab.ts:809`) and passed through `validateQuery` (`middleware/validate.ts:26-35`), which 400s on `safeParse` failure before the handler runs. `BUCKET_PREDICATE` is a `Record` whose keys are exactly the four enum values, each mapped to a **fixed string literal** (`vocab.ts:823-829`) — there is no path from `q.bucket`'s *value* into the SQL string, only its use as an object key to select one of four pre-written, hardcoded fragments. Confirmed with a dedicated test: `?bucket=nope` → 400 (`vocab.test.ts:1103-1107`, passed).
- **`MASTERY_MATURE_DAYS` interpolation** — a `const` numeric literal (`21`) declared once at module scope (`vocab.ts:806`), interpolated into `BUCKET_CASE`/`BUCKET_PREDICATE` at build time (not per-request), and passed as a genuine bound parameter (`$2`) in the summary query. No request data ever reaches this constant.
- **Auth** — `router.use(requireAuth)` at `vocab.ts:23` applies to every route in the file including `/mastery`; confirmed by the parametrized 401 test at `vocab.test.ts:44-57` (includes `['GET', '/vocab/mastery']`) and by the live test run below.
- **Rate limiting** — `cheapLimiter()` at `vocab.ts:841` matches the convention used by every other read route in this file (`entries`, `cards/due`, `suggestions/weekly`); it lazily resolves a shared per-IP limiter instance (`middleware/rateLimits.ts:123-129`), consistent with the rest of the router.

### Pagination / ordering

- `MasteryQuerySchema` (`vocab.ts:808-812`): `limit` 1–100 default 30, `offset` nonnegative default 0 — sane bounds, coerced via `z.coerce.number()`.
- `ORDER BY c.stability DESC NULLS LAST, v.korean COLLATE "C", c.id` (`vocab.ts:897`) — deterministic and stable: the `stability`/`korean` tiebreak is broken by `c.id` (a unique key), so repeated identical-filter requests can never reorder rows across a page boundary. `COLLATE "C"` pins byte-order regardless of DB locale — good practice for reproducible pagination.

### Tests

- Ran the new block directly against a real (testcontainer) Postgres: `npx vitest run tests/routes/vocab.test.ts -t "mastery"` → **4/4 passed** (`GET /vocab/mastery unauthenticated → 401`, `summarises buckets, lists words, and filters by bucket`, `never counts another user's cards`, `rejects an invalid bucket with 400`).
- The bucketing test (`vocab.test.ts:1056-1091`) is well-constructed: it seeds one card of each of `new` (via default), `learning` (`stability=6`, under the boundary — correctly distinguishing "learning" from "reviewing/mastered" which are stability-gated only for `review` state), and `mastered` (`stability=30`, well clear of the 21-day boundary) and asserts both the summary breakdown and the sort order. It would fail on a broken implementation, e.g. swapping `>=`/`>` in one of the three call sites, or breaking the summary/list split — I hand-verified this by reasoning through each site's logic (see Correctness table above); a mutation there would flip either the `learning` or `mastered` count and fail the `toMatchObject` assertion.
- Gaps: stability boundary at exactly 21 (SHOULD-FIX #1), non-vocab (`vocab_entry_id IS NULL`) card exclusion (SHOULD-FIX #2), pagination of the word list itself (`limit`/`offset` beyond the default page — not exercised for `/mastery` specifically, though the pattern is well-tested elsewhere in this file for `/entries`), and the invalid-bucket test not asserting `error.code` (NIT #3).

### Live-data verification (SELECT-only, against `km-db`)

Ran the exact summary-query logic directly against `km-db`:

```sql
SELECT
  count(*) FILTER (WHERE fsrs_state = 'new') AS new,
  count(*) FILTER (WHERE fsrs_state IN ('learning','relearning')) AS learning,
  count(*) FILTER (WHERE fsrs_state = 'review' AND stability < 21) AS reviewing,
  count(*) FILTER (WHERE fsrs_state = 'review' AND stability >= 21) AS mastered,
  count(*) AS total
FROM vocab_cards
WHERE deleted_at IS NULL AND vocab_entry_id IS NOT NULL
GROUP BY user_id;
```

Result: `195 | 43 | 4 | 0 | 242` — an exact match to the numbers given in the review brief. Also confirmed for that user: `non_vocab_cards = 0` (so the `vocab_entry_id IS NULL` exclusion path is untested against real data — reinforces SHOULD-FIX #2), `soft_deleted = 1` (consistent with `243 total_all_cards - 1 deleted = 242`), and `suspended_count = 0` for their vocab cards (the endpoint does not filter on `suspended_at`, which appears to be an intentional design choice — a suspended card's mastery state shouldn't disappear just because review is paused — but this is unverified against a suspended real card since none exist for this user).
