# Review: batch — FSRS / vocab scheduler + shared engine

**Reviewer:** Independent senior engineer (did not author this code)
**Branch:** `fixpass-batch-review`
**Scope:** `services/fsrs.ts` (new shared engine), `services/grammarScheduler.ts`,
`routes/vocab.ts` (review handler + due-query version fix), `routes/grammarDrill.ts`,
and the three test files. Compared against `SENIOR_ENGINEER_BAR.md`, `ADR-003`,
and the pre-refactor code (commit `7478697`).

---

## Summary verdict

**PASS.**

The core objective — making vocab review scheduling server-authoritative and
un-tamperable, on one shared engine — is met correctly and is genuinely well
tested. The extraction is behavior-preserving for grammar (verified against the
diff, not just asserted). No blockers. Zero client-controllable schedule paths
remain. The findings below are one SHOULD-FIX (a stated-invariant-vs-code gap
that is real but practically unreachable) and two NITs. None of them block
approval or ship risk; they are hardening to make the code honor its own
documented robustness claims.

---

## Bar checklist

| Gate (SENIOR_ENGINEER_BAR) | Result |
|---|---|
| §3.4 Deny-by-default / IDOR — every query user-scoped | PASS — SELECT/UPDATE/INSERT all carry `user_id = $2`; cross-user → 404 (test:706) |
| §3.4 Server assigns state, never accepts from client (mass-assignment) | PASS — client sends only `{rating, expected_version, duration_ms?}`; all `*_before`/`*_after` server-derived |
| §4.7 Parameterized queries only | PASS — every statement bound; no interpolation of values |
| §4.6 Explicit tx boundaries + `FOR UPDATE` on hot row | PASS — `withTransaction` + `SELECT … FOR UPDATE`; short tx, no I/O inside |
| §4.6 Optimistic version gate + retryable conflict split | PASS — 404 (existence) vs 409 (stale version) correctly split |
| §0/§3.1 Fail closed, fail loud, no swallowed errors | PASS — all handlers `catch → next(err)`; `withTransaction` rolls back + re-throws |
| §1.8/§3.10-A10 Exceptional conditions handled explicitly | PASS — 404/409/400/500 all reachable + tested; no SQL leak (test:901) |
| §5.2 Regression test that fails on the old stub | PASS — future-`due_at`, distinct intervals, and tamper tests all fail on `scheduled_days_after:0` stub |
| §5.2 Concurrency / double-submit tested | PARTIAL — version-mismatch 409 path tested; no injected-race test, but `FOR UPDATE`+version gate is correct by construction (see notes) |
| §0 Clean tree, comments explain *why* | PASS — comment quality is notably high (see PRAISE) |

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **Stability has no upper clamp; the module header's "No unbounded growth" /
   "even a corrupted row can never produce a value that fails the … CHECK
   constraints" claim is not fully honored.** `fsrs.ts:181` grows stability
   multiplicatively (`× up to 3.0`) with no ceiling. `stability` is
   `NUMERIC(10, 4)` (`001_core_schema.up.sql:674`) → max `999,999.9999`. A
   corrupted/near-max row plus one `easy` review (`999999 × 3`) overflows the
   column → Postgres `22003 numeric_field_overflow` → 500. The threat-model
   header explicitly scopes "corrupted row" as something the engine defends
   against; the CHECK-clamp claim holds (`stability >= 0` is satisfied), but the
   NUMERIC *precision* overflow is a distinct failure mode the narrative doesn't
   cover. See detailed findings for the fix.

### NIT
2. **`clamp()` does not guard NaN** (`fsrs.ts:128`). Acknowledged in-comment
   ("NaN-in would propagate, but inputs are bounded numerics"), and inputs come
   from `NUMERIC NOT NULL` columns via `Number()`, so unreachable in practice. A
   `Number.isFinite` guard (or clamping at the route boundary) would let the code
   match its own "no NaN" claim rather than rely on a circular-safety argument.
3. **`ReviewBodySchema` is intentionally non-`.strict()`** (`vocab.ts:235`) while
   the sibling `MineBodySchema` is `.strict()` (`vocab.ts:572`). The non-strict
   choice is correct and documented (strip unknown keys → graceful degradation of
   stale pre-cutover clients; it is *the* tamper defense). Worth a one-line
   cross-reference so a future reviewer doesn't "fix" it into `.strict()` and
   400 every legacy client.

### PRAISE
- **The tamper test is exactly the right test** (`vocab.test.ts:651`): it POSTs
  the literal pre-cutover stub payload *plus* hostile `*_after` values and asserts
  the server computes `scheduled_days: 3` anyway. This is the security property,
  proven end-to-end, and it fails on the old code.
- **`*_before` provably comes from the locked DB row, not the request**
  (`vocab.ts:281-303, 360-373`), and the append-only chain is tested
  (`vocab.test.ts:611` — row N's `*_before` == row N-1's `*_after`). ADR-003 D2's
  re-tuning log stays trustworthy against a hostile client.
- **404/409 split done correctly under a single tx with `FOR UPDATE`**
  (`vocab.ts:273-345`): existence lock first, versioned UPDATE second; the only
  remaining `rowCount = 0` cause after a confirmed+locked row is a true version
  conflict. Clean, and the 409-writes-nothing rollback is tested
  (`vocab.test.ts:720`).
- **The extraction is genuinely behavior-preserving for grammar**, not just
  claimed: the grammar `dueAt` computation changed from an inline
  `rating === 'again' ? RELEARN_DELAY_MS : next.scheduledDays * 86_400_000`
  to `dueDelayMs(next)`, which is byte-for-byte the same policy
  (`MS_PER_DAY === 86_400_000`, `next.rating === rating`). `ratingFromVerdict`
  and its exhaustiveness guard are untouched.

---

## Detailed findings

### FSRS algorithm correctness — `fsrs.ts` (correct)
- **State machine** (`fsrs.ts:169-183`): `again → relearning`; first success
  (`reps===0` or prior stability 0) → `learning` when `reps===0` else `review`;
  subsequent success → `review`. The `reps>0 && stability===0` re-seed guard
  (`fsrs.ts:164`) correctly avoids `0 × multiplier` never-recovering after a
  lapse — and it is tested (`fsrs.test.ts:91`). Correct.
- **Interval policy** (`fsrs.ts:188, 210-212`): `scheduledDays = again ? 0 :
  ceil(max(0, stability))`; `dueDelayMs` maps `again`'s 0 → `RELEARN_DELAY_MS`
  (~10 min), every other rating → `scheduledDays × MS_PER_DAY`. No off-by-one
  (ceil, so `hard`-on-new = 1 day, never 0), no negative interval (floored),
  `scheduledDays === 0 ⇔ again` invariant holds and is tested
  (`fsrs.test.ts:154`). This is the exact fix for the original stub bug
  (now+0 → strictly-future).
- **Never-reviewed sentinel** (`vocab.ts:367`, `grammarDrill.ts:480`):
  `elapsed_days_before = reps===0 ? -1 : 0`, matching
  `ck_card_reviews_elapsed_before_min CHECK (… >= -1)`
  (`001_core_schema.up.sql:837`). Both paths identical. Tested
  (`vocab.test.ts:602`).
- **Difficulty** clamped to `[1,10]` (`fsrs.ts:158`) matching
  `ck_vocab_cards_difficulty_range` / `ck_card_reviews_difficulty_*_range`.
  Boundary clamps tested (`fsrs.test.ts:120-128`).

### Server-authoritative security — `vocab.ts` (correct)
- Client cannot influence `due_at`: it is `new Date(Date.now() + dueDelayMs(next))`
  (`vocab.ts:309`) where `next` is `schedule(current, body.rating)` and `current`
  is built solely from the locked DB row (`vocab.ts:297-303`). A tampered
  `scheduled_days_after` is stripped by the default (non-strict) zod object
  before it ever reaches the handler. Verified by test.
- **Concurrency:** `SELECT … FOR UPDATE` serializes concurrent reviewers of the
  same card; under READ COMMITTED the second reviewer blocks, then re-reads the
  now-committed (bumped) version and its stale `expected_version` fails the
  `version = $9` gate → 409. So the double-submit / lost-update case resolves to
  a clean conflict, not a double-advance. Correct by construction. (A future
  injected-race test would make this explicit per §5.2, but the logic is sound.)
- **IDOR:** SELECT, UPDATE, and the `card_reviews` INSERT are all user-scoped;
  `card_reviews.user_id` comes from the session (`getUserId`), never the row or
  request. Cross-user review → 404 (no existence leak), tested (`vocab.test.ts:706`).

### GET /cards/due version fix (correct)
- `c.version` is now in the SELECT list (`vocab.ts:183`) and flows through the DTO
  spread (`vocab.ts:205-213`, `...c` retains `version`). Test `vocab.test.ts:679`
  ("a reviewed card carries its version on the due queue") pins it, closing the
  bug where `expected_version` was `undefined` and every real rating 400ed.

### Grammar not regressed (verified)
- `grammarScheduler.ts` now re-exports the shared engine surface and keeps only
  `ratingFromVerdict` (+ the `usesPattern===false → again` override), unchanged
  and still tested (`grammarScheduler.test.ts`). `grammarDrill.ts` scheduling
  (`grammarDrill.ts:414-489`) is line-for-line the vocab write, now sharing
  `dueDelayMs`. Diff review confirms the only functional change is
  inline-policy → shared-function with identical arithmetic.

### The SHOULD-FIX in code terms
`fsrs.ts` already imports the notion of bounds (`DIFFICULTY_MIN/MAX`). The
symmetric fix is a `STABILITY_MAX` clamp on the computed stability, e.g. a
value comfortably inside `NUMERIC(10,4)` (< `999_999.9999`), applied where
`safeStability` is formed (`fsrs.ts:187`). That makes the header's "even a
corrupted row can never produce a value that fails the constraints" literally
true (precision overflow included) and costs nothing at the reachable end of the
range. Alternatively, soften the header claim to "monotonic and bounded *per
step*" and note the NUMERIC(10,4) ceiling. Practical reachability via normal use
is ~12 consecutive `easy` presses (card already due ~1,000 years out), so this
is hardening, not an operational bug.

---

## Coordination observations
- The ADR-003 amendment (2026-07-02) accurately describes the shipped code: both
  paths call one pure engine; `*_before` from the DB row; storage shape unchanged.
  Docs and code agree — good discipline.
- FU-NF-45 is correctly reduced to "swap `services/fsrs.ts` for a real `ts-fsrs`
  port"; because both routes already funnel through `schedule` + `dueDelayMs`,
  that upgrade is now a single-module change with the test contract
  (`fsrs.test.ts`) pinning behavior for both card families at once. The
  extraction paid for itself.
- One forward note for the `ts-fsrs` swap: the interim engine ignores
  `elapsed_days` entirely. When the real port lands, the `elapsed_days = 0`
  write and the `-1` sentinel semantics will need revisiting together — worth a
  line in the FU-NF-45 ticket so it isn't lost.
