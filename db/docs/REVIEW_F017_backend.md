# Independent Review — F-017 Backend Slice (per-skill stats time-series)

- **Commit:** `ca1cc09` — feat(today): swipeable per-skill stats carousel (F-017)
- **Scope:** the 3 new `/series` routes + their tests ONLY
  - `server/src/routes/topik.ts` (GET `/topik/series`, lines 533–620)
  - `server/src/routes/vocab.ts` (GET `/vocab/series`, lines 921–974)
  - `server/src/routes/grammar.ts` (GET `/grammar/series`, lines 355–414)
  - `server/tests/routes/{topik,vocab,grammar}.test.ts` (new `/series` describe blocks)
- **Reviewer stance:** independent senior review; standard senior bar (parameterized SQL,
  auth/IDOR, boundary validation, correctness, test adequacy). Frontend slice out of scope.
- **Tests executed live:** yes — all three suites, in the project's Docker harness:
  `192 passed (192)`, duration 116.69s.

---

## VERDICT: **PASS WITH CONDITIONS**

The route code itself is correct on every axis I probed — including the two
highest-risk items (integer-division accuracy math and UTC day-bucketing),
on which I give a definitive clean judgment below. No blockers. The
conditions are two test-adequacy gaps that sit *exactly* on those two
highest-risk regressions: the current tests would keep passing if either
one were later broken. Fix the tests; the production code needs no change.

---

## Definitive judgment on the two highest-risk items

### 1. Integer-division accuracy math — **CODE CORRECT; TESTS CANNOT DETECT A REGRESSION**

`server/src/routes/topik.ts:595`:

```sql
round(100.0 * count(*) FILTER (WHERE r.is_correct) / count(*))::int AS value
```

The `100.0` literal is a `numeric` constant, so the whole expression is
promoted: `numeric * bigint → numeric`, `numeric / bigint → numeric`
(true division, no truncation), `round(numeric)` → nearest integer,
`::int` → JS `number` (not a pg string). Division by zero is impossible —
every GROUP BY bucket has `count(*) >= 1` by construction. **The classic
`100 * a / b` integer-truncation trap is definitively avoided.**

Grammar's `round(avg(score))::int` (`server/src/routes/grammar.ts:392`) is
likewise safe by construction: Postgres `avg(int)` always returns `numeric`,
so integer division cannot occur there, and the test's 70+75 → 72.5 → 73
case genuinely proves round-half-up over truncation (72). Verified passing live.

**BUT** — the topik tests use only accuracy fractions where rounding and
truncation coincide: 1/3 → 33 (trunc 33 = round 33), 3/4 → 75 (exact),
1/1 → 100, 0/1 → 0. If someone later "simplified" the SQL to
`round(100 * c / n)` (integer division: 100*2/3 = 66, not 67), **every
current test would still pass.** See SF-1.

### 2. UTC day-bucketing — **CODE CORRECT; TESTS ARE TZ-NEUTRAL, NOT TZ-PROVING**

All three routes bucket, group, and order on the identical expression
(`topik.ts:594,601,602`; `vocab.ts:954,959,960`; `grammar.ts:391,398,399`):

```sql
to_char((col AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')
GROUP BY (col AT TIME ZONE 'UTC')::date
ORDER BY (col AT TIME ZONE 'UTC')::date
```

All three source columns are `TIMESTAMPTZ` (migrations 015 `answered_at`,
001 `reviewed_at`, 019 `scored_at` — verified). `timestamptz AT TIME ZONE
'UTC'` yields a plain timestamp in UTC wall time, so `::date` is the UTC
calendar day **regardless of the DB session `TimeZone` GUC** — a bare
`col::date` would silently shift day boundaries if a connection string or
server default set a non-UTC zone. Formatting to `'YYYY-MM-DD'` in SQL
means the client receives an opaque string and never re-interprets it
through a local `Date`. GROUP BY, SELECT, and ORDER BY use the same
expression, so ascending order is guaranteed by the ORDER BY (topik orders
by date only, but the per-section JS filter preserves relative order, so
each section's `points` array is ascending). **Definitively correct.**

**BUT** — the tests insert rows at `now() - make_interval(...)` and compute
the expected date with the same UTC construct. Since the test DB session
runs in UTC, dropping `AT TIME ZONE 'UTC'` from the route SQL would change
nothing in CI: the tests are timezone-neutral, not timezone-proving. See SF-2.

---

## Findings by severity

### BLOCKER — none

### SHOULD-FIX

**SF-1 — Add an accuracy case where round ≠ trunc.**
`server/tests/routes/topik.test.ts:384–415` (the per-day math test). No
asserted value discriminates `round(100.0 * c / n)` from integer
`100 * c / n` (1/3→33, 3/4→75, 1/1→100, 0/1→0 are all trunc==round).
One extra day with 2-of-3 correct asserting **67** (trunc would give 66)
makes the integer-division regression detectable. One-line-of-data fix.

**SF-2 — Prove the UTC pin, or accept it's untested and say so.**
`server/tests/routes/{topik,vocab,grammar}.test.ts` (all three `/series`
blocks). A regression that removes `AT TIME ZONE 'UTC'` passes all current
tests because the test session's TimeZone is UTC. Cheapest real proof:
insert one row at an explicit near-midnight instant (e.g.
`((now() AT TIME ZONE 'UTC')::date::timestamp + time '00:30') AT TIME ZONE 'UTC'`,
i.e. 00:30 UTC today — which is *yesterday* in any TZ west of UTC-1) and
assert it lands on today's bucket after `SET LOCAL TimeZone` — or run one
targeted test on a pool whose connection sets a non-UTC zone. If that's
judged not worth the harness plumbing for a single-user app, a comment in
the test acknowledging the gap is the minimum.

### NIT

**N-1 — Partial oldest-day bucket.** All three routes filter
`col > now() - make_interval(days => $2)` (`topik.ts:599`, `vocab.ts:958`,
`grammar.ts:397`) — a rolling instant cutoff, then bucket by UTC day. The
oldest day in the window can therefore be a *partial* day (only rows after
the cutoff hour count), which for topik can show a misleading accuracy
point. Consistent with `/topik/mistakes` (same window idiom,
`topik.ts:508`) and fine as a design choice, but the docstrings say "over
the last `days`" without noting the truncated first bucket. Either document
it or align the cutoff to a UTC day start
(`date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $2 - 1)`).

**N-2 — Midnight-straddle flake window.** Tests insert "today" rows via
`now()` and later compute the expected date via a second `now()` call
(`utcDay(0)` — e.g. `topik.test.ts:408`, `grammar.test.ts:653`,
`vocab.test.ts:1204`). If UTC midnight falls between insert and assertion,
the test fails spuriously. Probability is tiny (ms-scale window, but the
suite runs ~2 min), and the failure mode is an obvious re-run. Capturing
the expected dates once, before the inserts, closes it.

**N-3 — `grammar_drill_attempts` has no (user_id, scored_at) index.**
The only index is `idx_gda_user_pattern_created (user_id, pattern_key,
created_at DESC)` (migration 019:85). The series query still gets
`user_id`-prefix index access (no full-table scan risk), then filters
`scored_at` — fine at this app's single-user scale, worth an index only if
the table ever grows large. `topik_responses` and `card_reviews` are
properly covered (`ix_topik_responses_user_answered_at` 015:136,
`ix_card_reviews_user_time` 001:856).

**N-4 — Triplicated boilerplate.** `SeriesQuerySchema` is declared
identically three times (`topik.ts:537`, `vocab.ts:923`, `grammar.ts:357`)
and the `utcDay` test helper three times. Locality per route file is a
defensible style in this codebase (MistakesQuerySchema is also local), so
this is a nit, not a demand.

**N-5 — Exact window boundary untested.** The window tests use daysAgo=40
vs windows 30/90 — a comfortable margin. A row exactly at `now() - 30 days`
is deterministically excluded by `>` (the query's `now()` is later than the
insert's), but no test pins the `>`-vs-`>=` semantics. Marginal value; noted
for completeness.

### PRAISE

**P-1 — The `100.0` numeric literal** (`topik.ts:595`) is exactly the right
minimal fix for the integer-division trap, and the `::int` casts on every
aggregate (`count(*)::int`, `round(...)::int`) prevent pg's string-typed
`bigint`/`numeric` from leaking `"3"` instead of `3` into the JSON contract
— proven by the strict `toEqual` number assertions passing live.

**P-2 — The `score IS NOT NULL` guard is genuinely load-bearing, not
cargo-cult** (`grammar.ts:395`). Migration 019's `chk_gda_score` permits
`score NULL` even with `scored_at` set — nothing at the DB level prevents a
scored-without-score row, and without the guard such a row on an
otherwise-empty day would emit `value: null`, violating the
`value: number` contract. The docstring even explains why it's there.

**P-3 — Auth/IDOR is airtight and tested in both directions.**
`router.use(requireAuth)` at the top of all three routers covers the new
routes (`topik.ts:41`, `vocab.ts:23`, `grammar.ts:15`); every handler scopes
by `getUserId(req)` (which throws `UnauthorizedError` rather than reading
undefined) and never accepts a client-supplied id; all three routes were
added to the 401 `it.each` auth tables; and the IDOR tests assert both that
user B sees nothing of A's *and* that A's aggregate is unpolluted by B's
rows (e.g. `topik.test.ts:424–432` — which also happens to cover the
all-wrong → 0% edge). `cheapLimiter()` present on all three.

**P-4 — Boundary validation matches the house pattern exactly.**
`z.coerce.number().int().min(1).max(90).default(30)` is byte-identical to
`MistakesQuerySchema.days` (`topik.ts:455`); `validateQuery` runs before
the handler and the handler reads only `validatedQuery`, so no unvalidated
`days` can reach SQL — garbage (`days=abc`), floats, negatives, and
repeated params (`days=5&days=7` → array → NaN) all 400 at the boundary.
Both 400 edges (0 and 91) are tested per route.

**P-5 — No injection surface.** Every dynamic value is a bound parameter
(`[userId, q.days]`); the reading/listening split is done with hardcoded
enum-cast literals (`'reading'::topik_section`) in SQL plus a typed JS-side
partition — no string interpolation anywhere.

---

## Detailed verification notes

- **Routing safety:** no GET param-route shadows `/series` in any router
  (`topik` has only `POST /:itemId/answer`; `vocab`'s param routes are under
  `/entries/` and `/cards/`; `grammar`'s under `/kgiu/` and `/bank/`).
  Mount order in `app.ts` (`/vocab/lists` before `/vocab`, `/grammar-drill`
  before `/grammar`) is unaffected. All three paths live under existing
  nginx-allow-listed top-level prefixes, so the km-lb SPA-shadowing trap
  (the F-012 lesson) does not apply.
- **Contract conformance:** `/topik/series` → `{reading, listening}`;
  `/vocab/series` and `/grammar/series` → `{series}`; each
  `SkillSeries = {metric, unit, points:[{date:'YYYY-MM-DD', value:number}]}`
  ascending, one point per active day, no zero-fill; empty → `points: []`
  with metric/unit intact (asserted per route). Matches the locked contract.
- **`make_interval(days => $n)`** with a Zod-guaranteed int 1..90 is the
  correct parameterized way to build the interval (no `'$n days'` string
  concat), same as `/mistakes`.
- **Two-sections-same-day** and section exclusion are covered: the first
  topik test has reading (75) + listening (100) on the same day and a
  writing response that must not appear anywhere.
- **Test count/state:** the three suites currently pass 192/192 in the
  Docker harness (run during this review, 2026-07-06).

## Conditions for full PASS

1. SF-1: add one topik accuracy day where rounding differs from truncation
   (2-of-3 → 67).
2. SF-2: add a timezone-discriminating case for the UTC day-bucket pin, or
   explicitly document the gap in the tests.
