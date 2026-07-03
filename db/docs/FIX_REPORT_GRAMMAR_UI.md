# Fix Report — grammar-ui review pass

**Branch:** `grammar-ui-fixes`
**Fix-pass engineer:** independent senior engineer (did not author or review the code)
**Date:** 2026-07-02
**Inputs:** `REVIEW_GRAMMAR_UI_A.md`, `REVIEW_GRAMMAR_UI_B.md`, `REVIEW_GRAMMAR_UI_C.md`;
`SENIOR_ENGINEER_BAR.md`; ADR-013 (migration tx ownership), ADR-002 (auth/sessions).

Every fix ships code **and** an atomic test. Nothing in the reviewers' PRAISE was
undone — the ownership-in-UPDATE + idempotent graduate, the `buildBankBody`
sanitization choke point, the optimistic-overlay prune, the persisted drill
cursor, the drill-remount-resume test, and the bank-body sanitizer test are all
intact and still pass.

## Disposition table

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| C-BLOCKER (B1) | BLOCKER | Optimistic-overlay-prune test (`Grammar.test.tsx`) asserted state that holds with or without the prune effect — cannot catch a prune regression. | **FIXED** — rewrote with teeth; verified it fails without the prune. |
| B-SF-1 | SHOULD-FIX | List-tab level filter coupled the Banked tab + drill pool (both derived from the level-filtered `items`), hiding banked patterns of other levels and repointing the drill to corpus rows. | **FIXED** — Banked tab + drill pool now source from the user's bank list, independent of the filter; two regression tests added. |
| A-SF-1 | SHOULD-FIX | Migration 032 permanently added `anon` to `claude_route`, which is not a `RouteName` — defeats 032's own goal; irreversible. | **FIXED** — removed the `anon` `ADD VALUE`; km-db checksum re-synced. |
| C-SF-2 | SHOULD-FIX | No enum⇄`RouteName` drift guard, despite that being the exact defect class 031/032 fix. | **FIXED** — added a drift-guard test against a freshly-migrated Postgres + a compile-time-pinned `ROUTE_NAMES`. |
| C-SF-1 (S1) | SHOULD-FIX | `grammar.test.ts` never called `resetLimiters()` → order-coupled expensive-limiter tests (bar §5.3 [P0]). | **FIXED** — added `resetLimiters()` to the `beforeEach`, mirroring `vocab.test.ts`. |
| A-SF-2 | SHOULD-FIX | 030 numbering gap (PR #8 holds 030) → linear-apply hazard if merged out of order. | **DEFERRED** — cross-branch coordination; no code change is correct here. |

NITs (A-NIT-1..3, B-NIT-1..5, C-S3/S4) were left as-is: none is trivially
in-file without expanding scope, and each reviewer explicitly rated them low
priority or pre-existing/out-of-scope. See "NITs — rationale for deferral" below.

---

## C-BLOCKER — overlay-prune test given teeth

**File:** `client/src/pages/Grammar.test.tsx` (`describe('optimisticBanked overlay prune (E-SF-1)')`).

**Why the old test was toothless.** The prune effect removes an optimistic key
*only once the server bank list already contains it*, so pruning never changes
the merged `bankedKeys` view (`server ∪ optimistic`) in the happy path — the row
reads "Already banked" whether or not the prune runs. The old assertions
("Already banked" + `listBanked` called ≥ 2) therefore held with the prune
deleted. The author's own comment conceded this.

**The fix.** Rewrote the test to drive the one observable state only the prune
produces: after row A is optimistically banked and *reconciled* (its key enters
the server bank list, so the prune drops it from the overlay), a **later** server
settle that no longer reports A as banked must revert row A's button to "Bank".
Without the prune, the stale overlay entry for A survives forever and the row
stays "Already banked" — the exact unbounded-overlay bug the prune exists to
prevent. Concretely: bank A → settle `{A}`; bank B → settle `{B}` (A omitted);
assert row A reads "Bank -더라도" again and row B reads "Already banked".

**Verified fails without the prune.** With the prune effect disabled in a
throwaway edit, this test failed (and passed with it restored) — see "Negative
verification" below.

## B-SF-1 — Banked tab + drill pool decoupled from the level filter

**Files:** `client/src/pages/Grammar.tsx`, `client/src/pages/Grammar.test.tsx`.

**Root cause.** `bankedItems` was `items.filter(bankedKeys.has)`, and `items` is
the *level-filtered* KGIU list. So selecting a level dropped the user's banked
patterns of other levels from the Banked tab, skewed the Active/Known counts,
and could repoint the drill's primary pool (`activeBankedItems`) — and, when it
emptied, silently fall the drill back to un-banked corpus rows.

**The fix (correct path, not the easiest).** The Banked tab and drill pool now
source from the user's **actual bank list** (`GET /grammar/bank`, already fetched
via `bankedState`), which is level-independent. To do this without losing the
detail-fetch, `BankedMeta` was widened to carry the bank row's display fields
(`pattern_display`, `summary_en`, `proficiency`, `category`, `register`), and a
new `bankedMetaToItem` synthesizes a render row from them. `bankedItems` now maps
each banked entry to its richer KGIU list row **when that level is loaded**
(preserving the full `getPattern` detail fetch — the common case, since the
filter defaults to `all`), else to the bank-row fallback (`isReal: false`, detail
renders from stored fields — the bank row carries no KGIU id).

The nothing-banked drill **fallback** (`drillableItems`) intentionally still
reflects the browsed corpus: in that state there are no banked patterns to hide,
so drilling the level the user is browsing is acceptable and avoids a redundant
second all-level fetch (YAGNI). This is documented inline. The drill's *primary*
pool (active banked) is now fully level-independent — which is what the review
and the added test target.

**Tests.** Two regression tests in a new `describe` (`banked tab + drill pool
independent of level filter (B-SF-1)`): (1) a banked *intermediate* pattern stays
visible in the Banked tab (and Active count stays `(1)`) after the List is
filtered to *Beginner*; (2) the drill generates for the banked intermediate
pattern even while the List filter excludes it. Both verified to fail on the
pre-fix (level-coupled) derivation — see "Negative verification".

## A-SF-1 — `anon` removed from migration 032

**File:** `db/migrations/032_claude_route_complete.up.sql`.

Removed `ALTER TYPE claude_route ADD VALUE IF NOT EXISTS 'anon';` and rewrote the
header: `anon` is the rate-limit bucket-key fallback
(`rate_limit.ts`; `index.ts` uses `String(userId) ?? 'anon'`), never a
`RouteName` written to `claude_cache.route` / `claude_usage.route`. `image_ocr`
and `diagnostic_item` are kept (they *are* real `RouteName`s that were missing).
The header now documents *why* `anon` is deliberately excluded and points at the
drift-guard test.

**Local km-db reconciliation (per the brief).** `ALTER TYPE … ADD VALUE` is
irreversible, so the already-applied `anon` value physically remains in the local
km-db enum (9 values) — harmless, nothing writes `route = 'anon'`; a fresh
environment built from the corrected file will not have it. To re-sync the
recorded checksum after editing the file:

```
docker exec -i km-db psql -U korean_master -d korean_master \
  -c "DELETE FROM schema_migrations WHERE version='032';"
DEPLOY_TAG=local bash -c 'source Deploy/deployment-utils.sh; load_environment; \
  export DEPLOY_TAG=local; run_migrate up'
```

Result: 032 re-applied cleanly (`image_ocr`/`diagnostic_item` are
`IF NOT EXISTS` no-ops), `apply.commit` logged, and `schema_migrations` version
`032` now records the **new** checksum `42293c55f041` (was `5c11c0ac59b0`),
`applied_at 2026-07-03 00:23:26+00`. Rows 031 and 033 are untouched.

## C-SF-2 — enum⇄RouteName drift guard added

**Files:** `server/src/services/claude/config.ts`,
`server/tests/db/claude_route_enum.test.ts` (new).

Added an exported `ROUTE_NAMES` runtime array **pinned to the `RouteName` union
at compile time from both directions** (`satisfies readonly RouteName[]` rejects
extras; a `[Exclude<RouteName, …>] extends [never]` assertion rejects a missing
route). The new test boots a fresh Testcontainers Postgres with
`db/migrations/*.up.sql` applied (via `startPostgres`, so it reflects the
migration *files*, not the mutated local km-db), reads
`enum_range(NULL::claude_route)`, and asserts set-equality with `ROUTE_NAMES` in
both directions (naming any missing/extra value, e.g. `anon`, in the failure
message). It fails if the enum and `RouteName` diverge either way. Passing today:
after the corrected 031/032, the enum is exactly the 8 `RouteName`s.

## C-SF-1 — `resetLimiters()` in grammar.test.ts

**File:** `server/tests/routes/grammar.test.ts`.

Added the `rateLimits` import and a `resetLimiters()` call in `beforeEach`
(after the `TRUNCATE … RESTART IDENTITY`), mirroring `vocab.test.ts`. Rate
limiters are module singletons that rebuilding the app does not reset; the
`RESTART IDENTITY` reuses `user_id = 1` every test, so without this the
`/grammar/identify` 429-burst block leaves the `u:1` expensive bucket saturated
for any test that runs after it in a shuffled order (§5.3 [P0] "passes … any
order"). A comment explains the coupling.

## A-SF-2 — 030 numbering gap (DEFERRED)

No code change — and no code change is the correct call. There is no filename or
version *collision*: 030 lives in the unmerged PR #8; this branch has 031/032/033.
The only hazard is ordering — `db/migrate.py`'s pending filter has no contiguity
check, so if 031–033 are applied now and PR #8's 030 merges later, 030 would
apply *after* 033 (non-linear history). This is cross-branch coordination:
resolves when PR #8 lands **before** this branch anywhere they co-exist (or by
renumbering the incoming PR to 034+). A contiguity/linearity check in the runner
would turn this whole class of gap into a loud failure, but that is out of this
branch's scope. **Deferred with the above as the standing instruction.**

---

## NITs — rationale for deferral

- **A-NIT-1** (`setGraduation` interpolates a fixed literal into the SET clause):
  safe (no user input; the `${…}` is a constant chosen by a boolean), reviewer
  rated it a cosmetic smell, not a correctness issue. Left as-is.
- **A-NIT-2/3** (destructive-gate coverage of `DROP COLUMN`; soft-deleted grammar
  card still surfacing as due): both flagged by the reviewer as *inherent to the
  gate's design* / *pre-existing, unchanged by this branch*. Out of scope.
- **B-NIT-1..5** (uncommented `!`, 404-vs-transient in `setKnown`, cursor as
  running counter, `useCallback` identity churn, tablist roving-tabindex): all
  perf-only or pre-existing WCAG gaps the reviewer explicitly rated non-blocking;
  fixing them is not trivially in-file without touching shared components.
- **C-S3/S4** (client↔server contract integration test; migration-downgrade test
  harness gap): both are *new test surfaces*, not corrections to shipped code; C
  itself scoped them to the test backlog. Deferred.

None of these blocks merge; each would expand scope beyond the reviewed defects.

---

## Self-assessment against the bar's done-checklist

- **§0 Correct/standard/robust path, root cause.** B-SF-1 fixed at the data
  source (bank list is the authority), not by patching symptoms. A-SF-1 fixed the
  migration file *and* reconciled the drifted local DB.
- **§0 Robust by default / fail-safe.** The graduated-pattern exclusion and the
  drill's failure-safe fallback are preserved; the B-SF-1 change keeps the drill
  from ever silently drilling un-chosen corpus rows.
- **§5.2 [P0] Every fix ships a regression test that fails on the old code.**
  C-BLOCKER, B-SF-1 (×2) verified to fail with the fix reverted; C-SF-2 fails if
  the enum diverges; C-SF-1 removes an order-coupling.
- **§5.3 [P0] Deterministic + isolated, any order.** C-SF-1 removes the last
  order-coupling in `grammar.test.ts`; the new tests use no wall-clock/sleep and
  real infra (Testcontainers) for the drift guard.
- **§4.5 [P0] No edit-in-place on a shared migration.** 032 was **not** applied to
  any shared/prod env; the only applied copy is the local km-db, which was
  explicitly re-synced. `ADD VALUE` irreversibility is documented.
- **§2.1 Type safety.** `ROUTE_NAMES` is compile-time-pinned to the union; no
  `any`; the synthesized banked row is fully typed. Client `tsc --noEmit` and
  server `typecheck` both pass.
- **Clean tree.** No TODO/console/dead code introduced; the throwaway
  negative-verification edits were reverted (0 markers remain).
- **PRAISE preserved.** All six praised items still pass in the green suites.

## Test evidence (all in the pinned `node:20-slim` toolchain per `Deploy/local-test.sh`)

**Client** — `npm ci && npm run lint && npx tsc --noEmit && npm run test && npm run build`:

```
Test Files  56 passed (56)
     Tests  523 passed (523)
✓ built in 358ms   (build runs only after test passes)
```

**Server** — `--network host` + Docker socket (Testcontainers),
`npm ci && npm run lint && npm run typecheck && npm test`:

```
Test Files  41 passed | 1 skipped (42)
     Tests  603 passed | 4 skipped (607)
✓ tests/db/claude_route_enum.test.ts (1 test) 3016ms   ← new drift guard
```

**Negative verification (teeth).** With the prune effect disabled AND `bankedItems`
reverted to the level-coupled derivation, `Grammar.test.tsx` ran
`3 failed | 24 passed` — the three failures being exactly the rewritten
overlay-prune test and the two new B-SF-1 tests. Both temporary edits were then
reverted (confirmed: 0 `NEGATIVE-CHECK` markers, fix + tests restored, final
client suite re-run green).

**Migration re-sync (km-db).** `schema_migrations` version `032` present with new
checksum `42293c55f041`; enum re-applied via the runner (not a hand DDL).
```
 version |   checksum   |          applied_at
---------+--------------+-------------------------------
 031     | c78a790cab1f | 2026-07-02 19:57:27+00
 032     | 42293c55f041 | 2026-07-03 00:23:26+00   (re-applied, new checksum)
 033     | 18a0c0c3a546 | 2026-07-02 21:31:31+00
```

The running blue/green stack was **not** redeployed.
