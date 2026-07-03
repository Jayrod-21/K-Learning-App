# Review: fix-pass for grammar-ui-fixes

**Re-reviewer:** Independent senior re-reviewer (did NOT author the code, did NOT
write the three originals, did NOT do the fix-pass). Fresh + skeptical read.
**Branch:** `grammar-ui-fixes`
**Inputs:** `REVIEW_GRAMMAR_UI_A/B/C.md` (the checklist), `FIX_REPORT_GRAMMAR_UI.md`
(treated as an unverified claim), `SENIOR_ENGINEER_BAR.md`, and the ACTUAL current
files.
**Date:** 2026-07-02

## Summary verdict

**PASS.**

Every BLOCKER and SHOULD-FIX the three originals raised was verified against the
live code — not the fix-report's word — and each is genuinely resolved (or
correctly deferred with a documented rationale). The two highest-risk items got
the most scrutiny:

- **B-SF-1** (the one flagged as re-applied after a git-checkout mishap) is
  **complete and coherent** in the actual `Grammar.tsx`. The Banked tab list and
  the drill's primary pool both source from the user's bank list
  (`GET /grammar/bank` → `listBanked` → `BankedMeta` → `bankedMetaToItem`),
  fully independent of the level-filtered KGIU `items`. No half-applied edit, no
  dangling reference, no type hole. The two new regression tests have real teeth
  (they fail on the pre-fix items-derived derivation).
- **C-BLOCKER** (toothless prune test) is rewritten to assert the one observable
  state ONLY the prune produces; I traced it by hand and it genuinely fails if the
  prune effect is deleted.

Both suites are green in the pinned `node:20-slim` toolchain: **client 56 files /
523 tests pass + build OK**; **server — see the Test-evidence section** (the new
drift-guard runs against a fresh Testcontainers Postgres). No PRAISE item was
undone. No new BLOCKER introduced.

## Finding-by-finding verification

| Finding ID | Source | Orig severity | Fix status | Notes |
|---|---|---|---|---|
| C-BLOCKER (B1) — prune test toothless | C | BLOCKER | **FIXED** | Rewritten test asserts row A reverts to "Bank" after a later settle omits it — a state ONLY the prune yields. Hand-traced: fails without the prune. |
| B-SF-1 — level filter ⇄ Banked/drill coupling | B | SHOULD-FIX | **FIXED** | Banked tab + drill primary pool now sourced from `bankedState` (bank list), level-independent. `BankedMeta` widened + `bankedMetaToItem` fallback. 2 regression tests with teeth. |
| A-SF-1 — 032 adds spurious `anon` | A | SHOULD-FIX | **FIXED** | 032 now adds ONLY `image_ocr` + `diagnostic_item`; header documents why `anon` is excluded + points at the drift guard. |
| C-SF-2 (S2) — no enum⇄RouteName drift guard | C (also A) | SHOULD-FIX | **FIXED** | New `claude_route_enum.test.ts` asserts set-equality BOTH directions vs a FRESH migrated PG; `ROUTE_NAMES` compile-pinned to the union both ways. |
| C-SF-1 (S1) — grammar.test.ts missing `resetLimiters()` | C | SHOULD-FIX | **FIXED** | Added to `beforeEach` after the TRUNCATE, mirroring vocab.test.ts, with a comment naming the coupling. |
| A-SF-2 (S… ) — 030 numbering gap | A | SHOULD-FIX | **DEFERRED-WITH-DOC** | Cross-branch coordination; no in-file code change is correct. Standing instruction recorded. Appropriate. |
| A-NIT-1 — SET-clause literal interpolation | A | NIT | REJECTED-WITH-RATIONALE | Fixed literal, no user input; cosmetic. Left as-is (defensible). |
| A-NIT-2/3 — destructive-gate / soft-deleted-due | A | NIT | REJECTED-WITH-RATIONALE | Pre-existing / inherent to the gate; out of scope. |
| B-NIT-1..5 — `!`, 404-vs-transient, cursor counter, useCallback churn, tablist a11y | B | NIT | DEFERRED | Perf-only / pre-existing WCAG gaps; not trivially in-file. Reasonable. |
| C-S3/S4 — client↔server contract test, migration-down harness | C | SHOULD-FIX(test backlog) | DEFERRED | New test surfaces, not corrections to shipped code. Scoped to backlog by C itself. |

Counts: **FIXED 5 · DEFERRED-WITH-DOC 1 · (NITs) REJECTED/DEFERRED · NOT-FIXED 0 ·
REGRESSION-INTRODUCED 0.**

## Bar checklist (post-fix state)

| Bar item | Verdict | Note |
|---|---|---|
| §5.2 [P0] every fix ships a test that fails on old code | PASS | C-BLOCKER, B-SF-1 ×2, C-SF-2 all have verified teeth (traced below). |
| §5.2 [P0] assert observable behavior not internals | PASS | Prune test now asserts a user-visible button label transition, not an internal set. |
| §5.3 [P0] deterministic + isolated, any order | PASS | `resetLimiters()` now in grammar.test.ts beforeEach; drift guard uses Testcontainers, no clock/sleep. |
| §4.1 / §4.5 enum == RouteName; no edit-in-place on shared migration | PASS | 8-value enum equals the 8 RouteNames; 032 not applied to shared/prod (only local km-db, re-synced). |
| §2.1 type safety end-to-end | PASS | `ROUTE_NAMES … as const satisfies readonly RouteName[]` + exhaustiveness assertion; widened `BankedMeta` fully typed; no `any`. Client tsc + server typecheck pass. |
| §3.4 [P0] BOLA on graduate/readmit | PASS (unchanged) | Ownership still enforced in the UPDATE `WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`. |
| §0 idempotency | PASS (unchanged) | `COALESCE(graduated_at, now())` intact. |
| §0 fail-to-safe (drill never serves graduated) | PASS | `drillableItems` still filters `!isGraduated`; primary pool = active banked. |
| §0 clean tree | PASS | No TODO/console/dead code; negative-verification edits reverted (grepped — see below). |

## New findings introduced by the fix-pass

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
- **N1 (pre-existing, now slightly wider surface).** `bankedMetaToItem` sets
  `isReal: false`, so a banked pattern whose level is NOT currently loaded opens a
  detail Sheet that renders the "Mock pattern — detail loads when the real KGIU
  corpus is wired" copy instead of a real detail fetch (the bank row carries no
  KGIU id, so `getPattern` genuinely can't run). This is the documented, correct
  trade-off of decoupling from the level filter — the detail is unavailable only
  for cross-level banked rows, and the common case (`all` filter) still fetches
  full detail via `itemsByKey`. Not a regression in behavior the reviews targeted;
  flagged only so a future reader doesn't mistake the mock-copy for a bug. A
  follow-up could fetch detail by `pattern_key` if the corpus grows a lookup.

### PRAISE
- **The prune test rewrite is exemplary.** It drives two banks whose second settle
  omits the first key and asserts the first row reverts to "Bank" — the precise,
  minimal observable that distinguishes pruned from unpruned overlay. The docblock
  now states the teeth instead of conceding their absence. This is how a
  regression guard for a subtle overlay invariant should read.
- **B-SF-1 fixed at the data source, not the symptom.** The Banked tab and drill
  pool now read from the authority (the bank list), and the widened `BankedMeta`
  preserves the full detail-fetch for the loaded level while degrading gracefully
  cross-level — the correct/standard path, and the inline comments name exactly
  why (B-SF-1) at each site.
- **The drift guard is the highest-leverage addition.** `ROUTE_NAMES` is pinned to
  `RouteName` from both compile directions AND checked against a freshly-migrated
  DB both runtime directions, with failure messages that name the offending value
  (e.g. `anon`). This closes the entire recurring enum-drift bug family, not one
  instance — precisely what reviewers A and C asked for.

## Detailed findings (non-FIXED rows)

### A-SF-2 — 030 numbering gap (DEFERRED-WITH-DOC) — verified appropriate

No filename/version collision exists on this branch (031/032/033 are distinct from
the unmerged PR's 030). The only hazard is out-of-order apply if 030 lands after
031–033, and `db/migrate.py`'s pending filter has no contiguity check. This is
genuinely cross-branch coordination — no edit to any file on THIS branch fixes it,
and inventing a runner-level contiguity check is out of scope. The fix-report
records the standing instruction (land 030 first, or renumber the incoming PR to
034+). Correct call; nothing to action here.

## B-SF-1 deep verification (extra scrutiny per the git-mishap flag)

I traced the full data path in the ACTUAL `Grammar.tsx` for signs of a partial
re-apply. It is complete:

1. `BankedMeta` (lines 382-399) carries `patternDisplay/summaryEn/proficiency/
   category/register` in addition to `id/patternKey/graduatedAt`. ✔
2. `loadRealBankedMeta` (433-450) populates all of them from the `listBanked`
   response — and the server `GET /grammar/bank` (grammar.ts:184-190) actually
   SELECTs `pattern_display, summary_en, proficiency, category, register,
   graduated_at`, and `BankedGrammarRow` (domain.ts:1093-1109) types them. The
   whole contract lines up end-to-end; no missing field. ✔
3. `bankedMetaToItem` (411-425) synthesizes a `PatternListItem` with `isReal:
   false` and a negative synthetic id. ✔
4. `bankedItems` (760-767) is `Array.from(bankedState.data.values(), meta =>
   itemsByKey.get(meta.patternKey) ?? bankedMetaToItem(meta))` — sourced from the
   bank map, NOT `items.filter`. Prefers the richer KGIU row when the level is
   loaded, else the bank-row fallback. ✔
5. `activeBankedItems`/`knownItems` (771-778) derive from `bankedItems`. ✔
6. DrillPanel receives `bankedItems={activeBankedItems}` (line 910); its `pool =
   bankedItems.length > 0 ? bankedItems : items` makes the PRIMARY pool
   level-independent. The `items` fallback (level-scoped `drillableItems`) fires
   only when nothing is banked — documented as intentional (786-789), and safe
   because there are then no banked patterns to hide. ✔

**Mental model confirmed:** filter to Beginner → a banked *intermediate* pattern
still shows in Banked (via `bankedMetaToItem`) and the drill still pools it
(`activeBankedItems` doesn't pass through the level filter). The Active count is
driven by `activeBankedItems.length`, also level-independent.

**Regression tests have teeth (hand-traced against pre-fix `items.filter`):**
- Test 1 (`keeps a banked intermediate … when List filtered to Beginner`):
  pre-fix, after filtering, `items = [BEGINNER_ROW]`, so
  `items.filter(bankedKeys.has)` drops `GR-kgiu-int-007` → "Graduate -더라도"
  button absent and Active count `(0)` → the `findByRole('button',{name:'Graduate
  -더라도'})` and `/^Active \(1\)/` assertions fail. Post-fix they pass. ✔
- Test 2 (`drills the banked pattern even when List excludes it`): pre-fix
  `activeBankedItems` collapses to empty under the Beginner filter → pool falls
  back to `[BEGINNER_ROW]` → generate fires for `-이다`, not `GR-kgiu-int-007` →
  the `toMatchObject({patternKey:'GR-kgiu-int-007'})` assertion fails. Post-fix it
  passes. ✔

## C-BLOCKER deep verification (does the prune test now bite?)

Hand-traced `Grammar.test.tsx:497-558` against `Grammar.tsx:534-552` (the prune
effect) and `567-571` (`bankedKeys = server ∪ optimistic`):

- Bank A → optimistic `{A}`; refetch #2 returns server `{A}`. **With prune:** A is
  in `settled`, so the effect drops A from the overlay → overlay `{}`. `bankedKeys
  = {A}`.
- Bank B → optimistic `{B}`; refetch #3 returns server `{B}` (A omitted).
  **With prune:** B dropped from overlay → overlay `{}`. `bankedKeys = {B}`. Row A
  is in neither set → renders "Bank -더라도". Assertion passes.
- **Without the prune effect:** after Bank A the overlay stays `{A}`; after Bank B
  it is `{A,B}`. `bankedKeys = server{B} ∪ {A,B} = {A,B}`. Row A still reads
  "Already banked" → the `getByRole('button',{name:'Bank -더라도'})` assertion
  throws. **Test fails.** ✔ Teeth confirmed.

This matches the fix-report's negative-verification claim (`3 failed | 24 passed`
with prune + level-coupling reverted). I did not need to modify code to confirm it;
the state machine is unambiguous.

## A-SF-1 verification

`032_claude_route_complete.up.sql` now contains exactly two statements:
`ADD VALUE … 'image_ocr'` and `… 'diagnostic_item'` (lines 30-31). No `anon`. The
header (lines 16-20) explicitly documents that `anon` is the rate-limit bucket-key
fallback, never a route written to the DB, and that adding it would break the
enum==RouteName invariant and is irreversible. Base enum (004) = 4 values; +031 = 2;
+032 = 2 → 8 total, exactly equal to the 8 `RouteName`s / `ROUTE_NAMES`. ✔

## C-SF-2 verification

`server/tests/db/claude_route_enum.test.ts` boots a fresh Testcontainers Postgres
via `startPostgres()` (helpers/pg.ts applies `db/migrations/*.up.sql` in numeric
order, each in its own tx — reflects the migration FILES, not the mutated local
km-db), reads `enum_range(NULL::claude_route)`, and asserts both `missingFromEnum`
and `extraInEnum` are empty PLUS an exact-set `toEqual`. It fails if a RouteName is
missing OR an extra value (e.g. `anon`) is present, with a message naming the
offender. `ROUTE_NAMES` (config.ts:145-164) is compile-pinned to the union in both
directions (`satisfies readonly RouteName[]` + the `_routeNamesExhaustive`
`[Exclude<…>] extends [never]` assertion). ✔

## C-SF-1 verification

`grammar.test.ts:18` imports `resetLimiters`; `:43` calls it in `beforeEach` after
the `TRUNCATE … RESTART IDENTITY`, with a comment (:38-42) naming the u:1 bucket
coupling and citing C-SF-1 / §5.3 P0. Mirrors `vocab.test.ts:17,36`. ✔

## PRAISE-preservation audit (no regressions)

- Ownership-in-UPDATE — intact (grammar.ts:226-232, `WHERE id=$1 AND user_id=$2
  AND deleted_at IS NULL`). ✔
- Idempotent graduate — intact (`COALESCE(graduated_at, now())`, grammar.ts:226). ✔
- Due-exclusion in the WHERE (not the JOIN) with the `grammar_entry_id IS NULL OR …`
  guard — intact (vocab.ts:188). ✔
- `buildBankBody` sanitization choke point — intact (Grammar.tsx:324-339). ✔
- Persisted drill cursor (validated read, guarded write, effect-based) — intact
  (Grammar.tsx:1384-1405, 1418, 1534-1536). ✔
- drill-remount-resume test + bank-body sanitizer test — both still present and
  green (Grammar.test.tsx:916, :243). ✔
- Clean tree — grepped the branch for `NEGATIVE-CHECK` / `console.log` / `TODO` in
  the touched files: none. ✔

## Test evidence (pinned node:20-slim per Deploy/local-test.sh)

**Client** — `npm ci && npm run lint && npx tsc --noEmit && npm run test && npm run build`:
```
Test Files  56 passed (56)
     Tests  523 passed (523)
✓ built in 430ms
(exit 0)
```

**Server** — `--network host` + Docker socket (Testcontainers),
`npm ci && npm run lint && npm run typecheck && npm test`:
```
✓ tests/db/claude_route_enum.test.ts (1 test) 3031ms   ← new drift guard, green
Test Files  41 passed | 1 skipped (42)
     Tests  603 passed | 4 skipped (607)
(exit 0)
```
The drift guard ran against a fresh Testcontainers Postgres and passed, confirming
the migrated `claude_route` enum equals the 8 `RouteName`s (no `anon`).

## Recommendation

**Ready to ship.** All five actioned findings are verified fixed against the live
code (not merely the fix-report's claims), the one deferral is the correct call,
no PRAISE was undone, and no new BLOCKER or SHOULD-FIX was introduced. The two
highest-risk items (B-SF-1 post-mishap, and the toothless-prune BLOCKER) were
hand-traced and both hold. File the deferred items (A-SF-2 coordination, C-S3/S4
test-backlog, the NITs, and N1 cross-level detail) as follow-ups; none blocks
merge.

**New BLOCKERs:** none.
