# Review: grammar-ui — test adequacy

Independent senior review (test adequacy only). Branch `grammar-ui-fixes` vs `rebuild`.
Scope: `client/src/pages/Grammar.test.tsx`, `server/tests/routes/grammar.test.ts`,
`server/tests/routes/vocab.test.ts`. Code-under-test sampled only to judge whether the tests
have teeth. I did not write this code.

## Summary verdict

**PASS WITH CONDITIONS.**

The four shipped fixes each ship a regression test that genuinely fails on the pre-fix code —
this is the important result and it holds. The Bank-400 sanitizer test and the drill-remount-resume
test are excellent: they reproduce the *actual* live bug, not a proxy of it. Isolation is mostly
disciplined (localStorage cleared between drill tests; shared reference tables truncated per block).

Conditions to clear before merge:

1. `server/tests/routes/grammar.test.ts` never calls `resetLimiters()` (its sibling
   `vocab.test.ts` does). Combined with `TRUNCATE … RESTART IDENTITY` reusing `user_id = 1`
   every test and module-singleton limiters, the `/grammar/identify` expensive-limiter tests are
   order-coupled — they pass only because the 429 burst runs *last*. Violates §5.3 [P0]
   "passes … any order." **SHOULD-FIX (isolation).**
2. The whole bug class fixed by migrations 031/032 is `claude_route` enum ⇄ `RouteName` union
   *drift*, and migration 032 itself writes "FOLLOW-UP … add a server test asserting the
   `claude_route` enum equals the `RouteName` union so this drift can't silently recur." That
   guard test does **not** exist. **SHOULD-FIX (missing drift guard for the exact defect class).**
3. The E-SF-1 optimistic-overlay-prune test (`Grammar.test.tsx:381`) passes for the wrong reason:
   its assertions ("Already banked" chip + `listBanked` called ≥ 2) are true whether or not the
   prune effect exists. It cannot catch a prune regression. The author's own comment concedes this.
   **BLOCKER by definition** (test that cannot catch its bug), though low blast-radius and *not*
   one of the four target fixes.

## Bar checklist (§5 testing)

| Item | Rule | Status | Note |
|------|------|--------|------|
| Bug fix ships test that fails on old code | §5.2 [P0] | **PASS** | All 4 fixes; see per-fix trace. |
| Assert behavior / observable output, not internals | §5.2 [P0] | **PASS** | Bodies via mock call args, DOM via roles, server via HTTP+DB reads. E-SF-1 is the one exception (asserts an unobservable-to-user internal → weak). |
| Unhappy paths first-class | §5.2 [P0] | **PASS** | 401/400/404/409/429/500-no-leak, submit-fail, generate-unreachable, optimistic rewind. |
| Boundary/edge values | §5.2 [P0] | **PASS** | limit 400/401, 200/201, empty pattern, scheduledDays 0, empty list deep-link. |
| Ownership / BOLA on mutations | §3.4 [P0] | **PASS** | graduate/readmit cross-user → 404 + victim row untouched. |
| Idempotency where partial run doubles effect | §5.2 [P0] | **PASS** | graduate keeps original ts; bank upsert; mine dedup. |
| Deterministic (no wall-clock/sleep/unseeded rand) | §5.3 [P0] | **PASS\*** | \*`/vocab/mine` uses `Date.now()`+`Math.random()` for lemma uniqueness only (collision-avoidance, not an assertion) — acceptable. |
| Isolated — passes alone, any order, in parallel | §5.3 [P0] | **FAIL** | grammar.test.ts missing `resetLimiters()` → expensive-limiter identify tests order-coupled (finding #1). |
| RTL query priority getByRole → … → testId last | §5.6 [P0] | **PASS** | Roles/labels/text throughout; single `getByTestId('mock-badge')` justified. |
| `user-event` over `fireEvent` | §5.6 [P0] | **PASS** | `userEvent.setup()` everywhere. |
| Real owned infra in integration (Testcontainers) | §5.4 [P1] | **PASS** | Real Postgres via `startPostgres`; migrations applied in order. |
| Every migration has a tested downgrade (both directions) | §4.5 [P0] | **FAIL (pre-existing)** | Harness applies only `*.up.sql`; no `*.down.sql` test. Not introduced by this branch, but 031/032/033 inherit the gap. |

## Per-fix regression-guard trace

| Fix | Guard test | Fails on old code? | Why |
|-----|-----------|--------------------|-----|
| (1) Bank 400 — client sent non-GR `pattern_key` | `Grammar.test.tsx:228` (sanitize, real-corpus row) + `:198` | **YES** | Old fallback (`source_id ?? pattern`) yields `pattern_key='kgiu-beginner-002'` → fails `expect(...).toMatch(/^GR-[a-z0-9_-]{1,64}$/)` and `=== 'GR-kgiu-beginner-002'`; composite register would be present, failing `expect('register' in body).toBe(false)`. Server side independently pins the schema (`grammar.test.ts:151` wrong-shape→400, `:167` bad register→400). |
| (2) Drill always re-drilled pattern #1 (ephemeral idx) | `Grammar.test.tsx:792` (resume across remount) | **YES** | Old `useState(0)` resets `idx→0` on DrillPanel unmount/remount → 3rd generate would be `GR-kgiu-int-007`; test asserts `GR-kgiu-int-008` (persisted cursor). Proves the localStorage cursor resumes. |
| (3) Level filter + load-all-285 | `Grammar.test.tsx:313` (default limit 400) + `:332` (per-level refetch); server `grammar.test.ts:72/80` | **YES** | Old bare `listPatterns()` sends no opts → `calls[0][0]` undefined → `opts.limit` ≠ 400 (throws/fails). Level change asserts `corpus: kgiu_intermediate` etc. + refetch count. |
| (4) Graduate/known + re-admit exclusion | server `grammar.test.ts:231–311`; `vocab.test.ts:333` (due-queue exclusion + re-admit restore) + `:376` (others untouched); weekly `grammar.test.ts:374`; client `Grammar.test.tsx:886–1039` | **YES** | Pre-feature the graduate/readmit routes 404 and `graduated_at` doesn't exist → setup `.expect(200)` and column-existence assert both fail. `vocab.test.ts:333` proves the card drops from `/vocab/cards/due` then resurfaces with FSRS state intact. |
| Migrations 031/032 (enum drift) | none dedicated; applied by harness at container boot | **partial** | Suite boots against 031/032/033 (a failed `ADD VALUE` would red the whole file at `beforeAll`), and `033` has an explicit column test (`grammar.test.ts:217`). But **no test asserts the enum now contains the values** or that enum == `RouteName`. See finding #2. |

Note on the drill tests: `Grammar.test.tsx:729` ("Skip advances to a DIFFERENT pattern") and `:757`
("prefers banked pool") are correct behavior tests but are **not** regression guards for this bug —
within a single mount, old code's `idx++` already advanced, so `:729` passes on the pre-fix code.
`:792` (remount) is the one with teeth. Fine as-is, just don't mistake `:729` for the guard.

## Detailed findings

### BLOCKER

**B1 — E-SF-1 overlay-prune test cannot catch its bug (`Grammar.test.tsx:381–433`).**
The test banks a row, lets the refetch return the reconciled server row, then asserts only:
(a) the button reads "Already banked" (`:425`) and (b) `listBanked` was called ≥ 2 times (`:432`).
Both are true regardless of whether the prune `useEffect` (`Grammar.tsx:484`) exists — the server
settle alone includes the row, so `bankedKeys` renders "Already banked" from server truth, and the
post-bank refetch fires the second `listBanked` independent of pruning. Delete the prune effect and
this test stays green. The inline comment (`:416–424`) openly admits it asserts a state the user
can't distinguish. Per the category definition ("a test that … cannot catch its bug") this is a
BLOCKER, but note: E-SF-1 is a pre-existing overlay concern, not one of the four target fixes, the
overlay is defensively capped at 50, and no user-facing regression rides on it — so treat it as the
lowest-priority blocker. To give it teeth, drive two banks whose second settle omits the first key
and assert the overlay set shrank (e.g. expose a count via `data-testid`, or bank >50 and assert the
oldest is evicted). If that's not worth it, downgrade the test's docblock claim so it doesn't purport
to guard the prune.

### SHOULD-FIX

**S1 — grammar.test.ts omits `resetLimiters()` → order-coupled expensive-limiter tests
(`server/tests/routes/grammar.test.ts:32`, contrast `vocab.test.ts:36`).**
Limiters are module singletons reset only via `resetLimiters()` (`rateLimits.ts:30–33, 120`).
`vocab.test.ts` calls it in `beforeEach`; `grammar.test.ts` does not. `expensiveLimiter` keys on
`u:<user.id>` (`rateLimits.ts:25,55`) and the `beforeEach` `TRUNCATE … RESTART IDENTITY` resets the
users sequence so every test's user is `id = 1`. `RATE_LIMIT_EXPENSIVE_MAX = 20` (`app.ts:276`).
The `/grammar/identify` block (`:428–480`) fires a 40-request burst on `u:1` to prove 429; because
the bucket is never reset, in a shuffled run that burst can execute before the `200`/`400`/`500`
identify tests (also `u:1`), which would then see `429` instead of their expected codes. Passes today
only because default order runs the burst last — a §5.3 [P0] "any order" violation and a latent flake.
Fix: add `resetLimiters()` to the `grammar.test.ts` `beforeEach` (mirror `vocab.test.ts`). The cheap
bucket (IP-keyed, max 120/60s) is unlikely to trip given ~30–40 cheap requests file-wide, but the same
one-line fix removes that risk too.

**S2 — no enum ⇄ RouteName drift guard, despite that being the exact defect class 031/032 fixed.**
Migrations 031 and 032 exist *because* `claude_route` silently lost sync with the `RouteName` union
(`config.ts:118`), so every grammar-drill / image-OCR call failed the cache+usage write. Migration
032's own text mandates the follow-up test. The only test referencing `RouteName`
(`server/tests/services/claude/real_smoke.test.ts`) is a live-API smoke test (uses a `noopLimiter`,
requires a real key), not an offline guard. Add a cheap unit/integration test that reads
`enum_range(NULL::claude_route)` from the migrated DB and asserts set-equality with the `RouteName`
union (the union is a TS literal type, so enumerate it as a runtime `const` array and compare both
directions). This is the highest-leverage missing test: it prevents the whole recurring bug family,
not one instance.

**S3 — client bank body ⇄ server schema bound only by a duplicated regex (drift risk).**
`Grammar.test.tsx:259` hard-codes `/^GR-[a-z0-9_-]{1,64}$/` to mirror `BankBodySchema`
(`grammar.ts:112`). No test feeds `buildBankBody()`'s actual output to the real server route, so if
the server regex/enum tightens, the client sanitizer test stays green while production 400s again —
the same client/server-contract drift that caused the original bug. Consider one integration test
that posts a `buildBankBody`-shaped body (composite register, empty category) to the real
`/grammar/bank` and asserts 201, closing the loop the two unit layers leave open.

**S4 — migration downgrades untested (`server/tests/helpers/pg.ts:41`), pre-existing.**
`applyMigrations` filters to `*.up.sql` only; nothing exercises `*.down.sql`. §4.5 [P0] requires a
tested downgrade in both directions. 031/032 downs are documented no-ops and 033's down is a plain
`DROP COLUMN`, so risk is low, but the gate is absent. Out of scope to fully fix here; noting for the
migration-test backlog.

## Coordination observations

- **Client and server tests agree on the contract** the fixes hinge on: the client emits
  `pattern_key = 'GR-…'` (`Grammar.test.tsx:215/259`) and the server's `BankBodySchema` requires
  exactly that shape and rejects otherwise (`grammar.test.ts:151`). The graduation id-source is
  pinned on both sides — client asserts `graduatePattern(501)` uses the *bank-row* id not the KGIU id
  (`Grammar.test.tsx:935`), server keys graduate on `grammar_entries.id` with ownership
  (`grammar.test.ts:279`). Good cross-layer coverage.
- **The three-surface graduation contract** from migration 033 is covered across files: drill-pool
  exclusion (client `Grammar.test.tsx:953`), `/vocab/cards/due` exclusion + FSRS-intact re-admit
  (`vocab.test.ts:333`), weekly-suggestion exclusion (`grammar.test.ts:374`). All three surfaces the
  migration promised are independently asserted — strong.
- **Isolation discipline is otherwise good**: `window.localStorage.clear()` in the client
  `resetMocks` (`Grammar.test.tsx:175`) directly prevents the drill-cursor from bleeding between the
  very tests that assert cursor persistence — exactly the trap this feature could have fallen into.
  Server blocks that assert exact counts truncate the shared reference tables in a nested `beforeEach`
  (`grammar.test.ts:318`, `vocab.test.ts:79/147`). The single lapse is S1.

## PRAISE

- **`Grammar.test.tsx:792` (drill remount resume)** — reproduces the *actual* live "always-N이다"
  bug: advance, unmount via a real tab switch, remount, and assert the 3rd generate is pattern #2.
  A lesser test would have asserted `idx++` within one mount (which old code passes). This one has
  real teeth and directly encodes the root cause.
- **`Grammar.test.tsx:228` (bank-body sanitize on a real-corpus-shaped row)** — uses a genuinely
  messy row (non-GR `source_id`, composite `해요체/합쇼체` register, empty category/title) and asserts
  every coercion the 400 fix performs. This is the schema-validity-for-real-data test the fix needed.
- **`vocab.test.ts:333`** — drives graduation through the *real* route and observes the production
  card leave and re-enter the due queue, proving the FSRS state is never touched. Behavior over
  implementation, exactly right.
