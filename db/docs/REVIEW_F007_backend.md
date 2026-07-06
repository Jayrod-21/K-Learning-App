# Independent Review — F-007 (resume in-progress TOPIK mock), DB + backend slice

**Reviewer:** Independent senior engineer (did not author this code)
**Commit:** `983fa09` — feat(topik): resume an in-progress TOPIK mock test (F-007)
**Scope reviewed (this slice only):**
- `db/migrations/037_topik_attempts.up.sql` / `.down.sql`
- `server/src/routes/topik.ts` — new GET/PUT/DELETE `/topik/attempt`, plus the `/mock/submit` attempt-clear
- `server/tests/routes/topik.test.ts` — the new `describe('TOPIK mock-attempt persistence — resume (F-007)')` block

---

## Summary verdict: **PASS WITH CONDITIONS**

Zero BLOCKERs. The feature's correctness foundation — the determinism of `POST /topik/mock`
for a fixed `(section, sourceTest)` — **holds** and is backed by a real total-order
guarantee in the schema (verified below). Atomicity of the submit-clear is correct, the
attempt routes are genuinely user-scoped (no IDOR vector by construction), and the migration
reverses cleanly. Two SHOULD-FIX items keep this from a clean PASS: an input-validation gap
that turns oversized integers into a 500 instead of a 400 (the exact "API schema looser than
the DB constraint" failure mode already burned this project), and a test gap around the
`picks` key-regex — the one validation control with **zero** coverage.

**Note:** `SENIOR_ENGINEER_BAR.md` (named in the review brief as "the contract") does not
exist in the repo tree. The bar is referenced only in inline `// Bar §…` code comments.
Review conducted against the ADRs (esp. ADR-001, ADR-013) and those inline references.

---

## Bar / ADR checklist

| Criterion | Status | Notes |
|---|---|---|
| Migration reversibility (down truly reverses) | PASS | `DROP TABLE` returns to pre-migration state; trigger + index drop with the table; shared `set_updated_at()` and `topik_section` enum correctly left intact. |
| Audit columns (ADR-001 §D6) | PASS | `created_at`/`updated_at`/`version` present; `updated_at` trigger wired; `created_at` preserved across upsert. |
| `updated_at` trigger fires on upsert path | PASS | `ON CONFLICT DO UPDATE` is a real UPDATE → `BEFORE UPDATE` trigger fires. |
| Enum reuse + CHECK to exclude `writing` | PASS | `section topik_section` + `CHECK (section IN ('reading','listening'))` — defense in depth. |
| CHECK constraints sound | PASS | non-neg idx/remaining, positive source_test, positive version, `jsonb_typeof(picks)='object'`. |
| FK policy explicit (ADR-001 §D9) | PASS | `fk_...user` with explicit `ON DELETE CASCADE ON UPDATE RESTRICT`; CASCADE is right (an attempt has no meaning without its user). |
| Naming conventions (ADR-001 §D10) | PASS | `uq_`, `fk_`, `ck_`, `trg_` prefixes all correct. |
| No top-level tx control in migration (ADR-013) | PASS | No `BEGIN/COMMIT`; runner owns the tx. |
| Submit-clear atomic with score write | PASS | `DELETE FROM topik_attempts` runs on the same `withTransaction` client, after the inserts. |
| Auth / IDOR — every route user-scoped | PASS | `router.use(requireAuth)` (line 41); every attempt route derives `user_id` from `getUserId(req)` (session), never from the body. No client-supplied id anywhere. |
| Upsert replaces all columns + bumps version | PASS | all five mutable cols in `DO UPDATE SET` + `version = topik_attempts.version + 1`; `created_at` intentionally untouched. |
| Determinism of `/mock` for fixed (section, sourceTest) | PASS | `ORDER BY i.item_number` is a **total** order (see detail); LIMIT 50 truncation deterministic. |
| Validation: bad section / choice / oversized picks → 400 | PASS | `AttemptSectionSchema` enum, choice enum `a–d`, `.refine(len<=60)`; `ValidationError`→400 confirmed. |
| `z.record` key validation (`/^\d+$/`) correct | PASS (untested) | zod 3.25.76 enforces the key schema; a non-numeric key is rejected — but **no test exercises it** (SF-2). |
| Upper-bound validation matches DB column width | **SHOULD-FIX** | `currentIdx`/`sourceTest`/`remainingMs` have no `.max()`; a value > INT4 max passes zod then overflows INT4 → 500, not 400 (SF-1). |
| SQL injection | PASS | Every query parameterized (`$1..$6`); only interpolated tokens are the numeric const `OFFICIAL_MOCK_SECTION_SIZE` and const SQL fragments — no user input concatenated. |
| Rate limiting present | PASS | `cheapLimiter()` on all three attempt routes and on `/mock/submit`. |
| Error handling | PASS | Every handler `try/catch → next(err)`; central handler maps AppError→status, unknown→500. |
| Test adequacy (would fail on regression) | PARTIAL | 6 tests cover CRUD, upsert, IDOR isolation, submit-clear, and 3 validation cases; gaps noted in SF-2. |

---

## Determinism verification (the feature's correctness foundation)

**Claim:** resume does not snapshot items; it re-fetches `/topik/mock` with the stored
`source_test` and restores `picks`/`current_idx`, relying on `/mock` being deterministic.

**Verified — the claim holds, and the total-order guarantee is real:**

- The `/mock` assembly query (`topik.ts:732-742`) is
  `WHERE t.test_number = $1 AND i.section = $2 AND <ANSWERABLE> ORDER BY i.item_number LIMIT 50`.
- `db/migrations/005_lesson_podcast_topik.up.sql:421` declares
  `CONSTRAINT uq_topik_items_test_number UNIQUE (topik_test_id, item_number)`. A given
  `test_number` maps to one `topik_test_id`, so `item_number` is **unique within a test** →
  `ORDER BY i.item_number` is a **total** order (the `section` filter only narrows to a
  subset, which stays totally ordered). There are no ties, so `LIMIT 50` truncates the same
  50 rows every time. Determinism is not "probably stable" — it is guaranteed by a unique index.
- On resume the client sends the stored `source_test` explicitly, so
  `resolveMockSourceTest` (`topik.ts:689-705`) returns it verbatim (the `ORDER BY test_number
  DESC LIMIT 1` server-pick path is only hit on a *fresh* start, and its result is echoed and
  persisted immediately). Good.
- Extra robustness: `picks` is keyed by **itemId**, not by array index (`topik.ts:544`,
  `842-845`), so answers restore correctly independent of ordering. Only `current_idx` is
  positional, and it is restored against the identical ordered set. This is a genuinely
  well-chosen design — see PRAISE.

**Residual (documented) risk, not a blocker:** the served set also depends on
`ANSWERABLE_ITEM_SQL` (`>=2 options AND answer NOT NULL AND options[0] NOT IN ①..④`). If the
corpus rows for that test were mutated between save and resume (an item flipping
answerable/unanswerable, or rows added/removed), the set/order would shift and `current_idx`
could land on a different question. The corpus is static past-paper reference data and the
migration header documents this dependency explicitly, so this is an accepted assumption — but
worth a one-line note in F-021/ops runbooks if the corpus ever becomes editable at runtime.

---

## Findings by severity

### SHOULD-FIX

**SF-1 — Integer inputs lack an upper bound; > INT4 → 500, not 400.**
`server/src/routes/topik.ts:542-547` (`AttemptBodySchema`).
`sourceTest`, `currentIdx`, and `remainingMs` are validated as `z.number().int().positive()` /
`.nonnegative()` with **no `.max()`**. The DB columns are `INTEGER` (INT4, max 2147483647). A
client (buggy or hostile) sending e.g. `sourceTest: 9999999999` passes zod, then the
`INSERT`/upsert throws Postgres `22003 integer out of range`, which the generic handler maps to
**500**. This is precisely the "distrust API schemas looser than the DB constraint behind them"
failure this project already recorded (the grammar-Bank 500). A boundary that should reject bad
input with 400 instead leaks a 500. Fix: add `.max(2_147_483_647)` to all three (and, sensibly,
`currentIdx` could be `.max(OFFICIAL_MOCK_SECTION_SIZE)` and `remainingMs` a mock-duration
ceiling). Low effort, and it keeps the contract honest.

**SF-2 — The `picks` key-regex — the only validation control with no test.**
`server/tests/routes/topik.test.ts` (the F-007 `describe` block) exercises bad `section`
(`'writing'`), bad choice (`'e'`), and oversized picks (61 keys), but never a **malformed key**.
The `z.record(z.string().regex(/^\d+$/), …)` key validation (`topik.ts:544`) is the guard that
keeps non-numeric junk out of the JSONB keyspace, and it is asserted to be correct in the review
brief — yet a regression that dropped the key schema (e.g. widening to `z.string()`) would pass
the entire suite. Add: `bad({ …, picks: { abc: 'a' } })` → 400. While there, cover the untested
negative-int paths (`currentIdx: -1`, `remainingMs: -1` → 400) so the `nonnegative()` constraints
have teeth. These are cheap and close the coverage holes on the parts most likely to silently
regress.

### NIT

**N-1 — `version` is bumped but never read for optimistic concurrency.**
`topik.ts:623`. ADR-001 §D6 frames `version` as optimistic-lock support (`WHERE version = ?`),
but the upsert is unconditional last-write-wins and no reader checks it. Correct and safe for the
one-row-per-user, single-device flow — just note that the column is currently audit-only here, so
nobody later assumes it provides lost-update protection it isn't wired to give.

**N-2 — `PUT /attempt` accepts a `sourceTest` for a nonexistent test.**
No existence check against `topik_tests`. A stored attempt for an unknown test resolves to an
empty exam on resume (`items: []`) — graceful, but silent. Acceptable given the transient,
self-clearing nature of the row; flagging only so it's a known behavior, not a surprise.

**N-3 — `picks` per-key length is unbounded by the schema.**
The `.refine` caps key *count* at 60 but not per-key length; the migration comment ("cannot stuff
an unbounded JSONB blob") is only true because the global `express.json({ limit: '256kb' })`
(`app.ts:53`) backstops total payload size. Fine in practice; the comment slightly overstates what
the schema alone guarantees.

**N-4 — Mixed idempotency in the migration.**
`CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` but a plain `CREATE TRIGGER`
(no `IF NOT EXISTS`, which Postgres doesn't support pre-`CREATE OR REPLACE TRIGGER`). Re-running
the up would fail on the trigger. Harmless — migrations run once via `schema_migrations` — and it
matches existing house style (`005_*.up.sql` uses the same plain `CREATE TRIGGER`), so it's a
consistency nit only.

### PRAISE

**P-1 — Submit-clear is genuinely atomic.** `topik.ts:878-892`: the
`DELETE FROM topik_attempts` runs on the same `withTransaction` client, after the response
inserts. A graded section and a cleared attempt commit or abort together — exactly the invariant
claimed. It also correctly clears even on a zero-answer (timed-out) submit, since the DELETE is
outside the insert loop.

**P-2 — `picks` keyed by itemId, not array index.** This makes stored answers immune to any
future weakening of the ordering assumption — a deliberate, defensive schema choice, not an
accident. The determinism argument only needs to carry `current_idx`, not the answers.

**P-3 — Correct audit semantics across upsert.** `created_at` is left out of `DO UPDATE SET` so it
preserves the original start time, while `updated_at` refreshes via the trigger. Easy to get wrong
(many implementations clobber `created_at` on upsert); this one is right.

**P-4 — DB-level `CHECK (section IN ('reading','listening'))` even though the `topik_section` enum
permits `writing`.** Defense in depth: the writing-mock exclusion is enforced at both the zod
boundary and the column, so a future code path can't quietly persist a writing attempt.

**P-5 — Honest, load-bearing migration comments.** The header documents the no-snapshot
dependency on `/mock` determinism and calls the down migration "lossy by design" while noting no
graded data is lost (it lives in `topik_responses`). This is the kind of comment that saves the
next engineer an hour.

---

## Test-by-test regression check

| Test | Catches a real regression? |
|---|---|
| GET returns null when none | Yes — basic contract. |
| PUT saves / GET returns / 2nd PUT upserts (one row) | Yes — would fail if `ON CONFLICT (user_id)` were dropped or replaced wrong columns. |
| DELETE idempotent | Yes — delete + idempotency. |
| user-scoped (A vs B isolation) | Yes — would fail if `WHERE user_id = $1` were removed from GET or upsert. Proves isolation; the stronger no-clobber guarantee is structural (`user_id` never client-supplied), which this correctly exercises via two independent sessions. |
| malformed body (section / choice / 61 picks) → 400 | Yes for those three; **misses** malformed key + negative ints (SF-2). |
| submit clears the in-progress attempt | Yes — would fail if the in-tx DELETE were removed. |

---

## Bottom line

Approve once SF-1 (`.max()` bounds so oversized ints 400 instead of 500) and SF-2 (test the
`picks` key-regex + negative-int rejection) are addressed. Everything else — migration
correctness/reversibility, atomicity, IDOR-safety, and the determinism foundation — is sound and,
in several places (P-1..P-5), notably well done. Nothing here is broken-by-construction.
