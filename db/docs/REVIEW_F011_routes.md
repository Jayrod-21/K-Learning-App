# Review — F-011 Routes + Persistence Slice (commit 72e5f01)

**Reviewer:** independent senior review (routes/persistence slice only)
**Scope:** `server/src/routes/diagnostic.ts` (SCHEDULE/ITEMS_PER_DIMENSION, `SnapshotDimensionDTO`, `buildSnapshotDTO`, `evidence.dimensionStats` write, `dimensionStatsFromEvidence`, `/latest` + `/history` + `/finish` band rebuild, short-pool skip log) and `server/tests/routes/diagnostic.test.ts`.
**Test run:** `npx vitest run tests/routes/diagnostic.test.ts` (dockerized, per instructions) — **35 passed (35)**, 28.98s.

## Verdict

**PASS — approve.** 0 BLOCKER, 2 SHOULD-FIX (both test-coverage gaps, not code defects), 4 NIT, 4 PRAISE.

The two highest-risk questions posed to this review are both answered definitively in the code's favor:

1. **Legacy v1.0.0 snapshots load without throwing — confirmed.** Traced every read path; there is no input shape that can make `dimensionStatsFromEvidence` throw (detail below), and the degradation to `scoreLow = scoreHigh = score` is exact and route-tested for both `/latest` and `/history`.
2. **The defensive parser is genuinely defensive — confirmed**, with one soft edge (semantically-invalid finite numbers pass; see NIT-3) that cannot violate the client-facing invariant because of the `min`/`max` re-anchor.

## Probe results (per review charter)

### 1. Backward-compat: legacy `v1.0.0` evidence trace — SAFE

Traced a legacy row (`evidence = '{}'`, `rubric_version = 'v1.0.0'`, exactly what `seedDiagnosticSnapshot` at `server/tests/helpers/seed.ts:296-301` writes and what production pre-F-011 rows look like) through all three readers:

- `/latest` → `loadSnapshotDTO` (`diagnostic.ts:1363`) → `dimensionStatsFromEvidence(row.evidence)` (`:1386`). `{}` is an object, so the `:756` guard passes; `evidence['dimensionStats']` is `undefined`, caught by the `typeof block !== 'object'` guard at `:758` → returns `{}` → every dimension takes the `stat === undefined` branch in `buildSnapshotDTO` (`:799-800`) → `scoreLow = scoreHigh = score`. No throw possible.
- `/history` (`:1509`) uses the identical parser inline. Same trace.
- `/finish` idempotent path (`:1214`) goes through the same `loadSnapshotDTO`, so re-finishing a run completed under v1.0.0 also degrades cleanly (untested directly, but it is literally the `/latest` code path).

Guard-by-guard on `dimensionStatsFromEvidence` (`:752-778`) for hostile shapes:

| Input | Path |
|---|---|
| `evidence` non-object scalar / `null` | `:756` early return (belt-and-braces — DB CHECK `ck_diagnostic_snapshots_evidence_object` in `db/migrations/001_core_schema.up.sql:461-462` already forbids non-object JSONB at rest, including arrays) |
| `dimensionStats` missing / scalar / `null` | `:758` early return |
| `dimensionStats` an array | passes `:758` (`typeof [] === 'object'`), but named-key lookups at `:760` yield `undefined` → each dimension skipped at `:761` |
| per-dimension entry scalar / `null` / array | `:761` skip (array field-lookups yield `undefined` → fails `:763-766` anyway) |
| entry with missing / string / `NaN` / `Infinity` fields | `Number.isFinite` + `typeof` check `:763-766` → `:767` skip |

Only plain property reads and `typeof` checks — no `JSON.parse`, no method calls on unknown values. **There is no path where bad `evidence` JSONB crashes a read.**

### 2. No-migration claim — CONFIRMED

- `evidence` is the existing JSONB column from migration 001; the `/finish` INSERT (`diagnostic.ts:1321-1337`) targets the same column list as before — no schema change, and the four estimate columns are still written (`:1330-1333`).
- `evidence.dimensionStats` is **additive**: the evidence object at `:1286-1300` still carries `items[]`, `theta_trajectory`, and `schedule` alongside the new block.
- Written on **every** snapshot insert: `dimensionStats` is built unconditionally at `:1255-1269` before the transaction. The concurrent-finish race loser (`:1318-1320`) reuses the winner's snapshot, which the winner wrote with stats — no gap. A run finished pre-F-011 is correctly *not* backfilled on re-finish (it stays a v1.0.0 row and degrades) — the right call, since its rubric genuinely lacked a band.
- Zero-item dimensions are omitted from `dimensionStats` (`:1258-1259`), mirroring the NULL estimate columns — the two representations cannot disagree on which dimensions exist.

### 3. DTO invariant — HOLDS

`buildSnapshotDTO` (`:789-820`): `score` is always freshly computed from the estimate column (`:797`); with a stat present, `scoreLow = Math.min(stat.scoreLow, score)` and `scoreHigh = Math.max(stat.scoreHigh, score)` (`:799-800`). Traced the worst case — inverted stored pair (`scoreLow=80, scoreHigh=20`, score=50) → emits `(50, 50)`; a stale pair that no longer straddles the recomputed score is pulled to it. `scoreLow ≤ score ≤ scoreHigh` is unconditionally true. Missing stat → `low = high = score`, exactly the documented fallback. (Range 0–100 is *not* re-enforced here — see NIT-3.)

### 4. Schedule change — CORRECT

- `DIMENSION_ORDER = ['reading','listening','vocab','grammar']` (`scoring.ts:21`) matches the old hardcoded 8-element order, so `Array.from({length: ITEMS_PER_DIMENSION}, () => DIMENSION_ORDER).flat()` (`diagnostic.ts:86-89`) reproduces the same interleaving at 16 items. Order preserved (test pins `schedule[1] === 'listening'` at `diagnostic.test.ts:218`).
- `TARGET_ITEM_COUNT = SCHEDULE.length` (`:91`); all three consumers (`:644` serve loop bound, `:852` start query, `:866` progress) derive from it — grep found no residual hardcoded 8.
- Short pool: `serveNextItem` (`:644-662`) skips a null-returning section and continues to the next ordinal; `/finish` scores whatever was answered; `resultsByDimension` returns `null` only for a 0-item dimension, which both the estimate columns and `dimensionStats` omit. The skip is now logged at `warn` with `runId`/`ordinal`/`section`/`correlationId` (`:653-656`) — observable, as the brief demanded.

### 5. Reader consistency — CONSISTENT

`/latest` and `/finish` share `loadSnapshotDTO`; `/history` selects `evidence` (`:1492`) and calls the same `dimensionStatsFromEvidence` + `buildSnapshotDTO` pair (`:1502-1510`). No SnapshotDTO producer builds from estimate columns alone. `/trajectory` (`:1421-1458`) still reads only estimate columns, but it emits a different, deliberately band-less shape (`{points}` of scores) — not a SnapshotDTO reader, so no inconsistency. (Observation: if the F-010 progress chart later wants uncertainty, it should consume `/history`, which has the band.)

### 6. Test adequacy — GOOD on the critical paths, two gaps

Covered well: item count 16 (`diagnostic.test.ts:117,214,220,576`); exact band math end-to-end (`reading 66 [63,70]`, `:643-650`); persisted `evidence.dimensionStats` exact shape + `rubric_version = 'v1.1.0'` (`:658-689`); `/latest` rebuilding the same band from evidence (`:692-699`); **the v1.0.0 zero-width degradation for both `/latest` and `/history`** (`:862-905`) — the acceptance-critical case is directly asserted. Regression check: deleting the `:758` `block` guard makes `(undefined)[key]` throw at `:760`, 500-ing the legacy tests — the load-bearing legacy guard IS pinned by tests.

Gaps → SHOULD-FIX-1 and SHOULD-FIX-2 below.

---

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — The malformed-entry guard and the min/max re-anchor have no failing test.**
`server/src/routes/diagnostic.ts:763-767` (field validation) and `:799-800` (re-anchor); `server/tests/routes/diagnostic.test.ts:862-905` only exercises the `'{}'` legacy shape. Deleting the `Number.isFinite`/`typeof` validation, or replacing `Math.min/Math.max` with direct passthrough, leaves the entire 35-test suite green — precisely the "regression in the defensive parser" the feature exists to prevent. Add one route-level test seeding a snapshot whose `evidence` contains a malformed `dimensionStats` (e.g. `{"dimensionStats": {"reading": {"n": "x"}, "listening": [1], "vocab": null, "grammar": {"n":4,"correct":4,"estimate":4.75,"score":66,"scoreLow":90,"scoreHigh":10}}}`) and assert: reading/listening/vocab degrade to zero-width, and grammar's inverted pair is re-anchored to `low ≤ score ≤ high`. (`dimensionStatsFromEvidence` is unexported, so route-level via a raw INSERT is the natural vehicle; alternatively export it for a unit test.)

**SF-2 — Partial short pool (1–3 items in a dimension) is untested.**
The acceptance criterion "a dimension whose pool is exhausted still scores from the items it got (≥1)" is only tested at the extremes: full pool (4/4) and fully-empty pool (0 items, dimension omitted — `diagnostic.test.ts:824-860`). Seed e.g. 2 reading rows and assert the finished snapshot still contains `reading`, with `evidence.dimensionStats.reading.n === 2`. This also pins that `pickTopikItem`'s already-served exclusion and the skip-and-continue loop compose correctly mid-run.

### NIT

**N-1 — Stale docstring in the seed helper, now actively misleading.**
`server/tests/helpers/seed.ts:281-283`: "`evidence` and `rubric_version` are minimal valid values (**the route never reads them**)". False as of this commit — `/latest`, `/history`, and `/finish` all read `evidence`. The helper's `'{}'::jsonb, 'v1.0.0'` values are now load-bearing (they ARE the legacy fixture the compat tests rely on); the comment should say so.

**N-2 — Stale count in a test comment.**
`server/tests/routes/diagnostic.test.ts:837`: "before the full 8-slot schedule is used" — schedule is 16 now.

**N-3 — Parser admits semantically-invalid finite values; server doesn't own its documented 0–100 range.**
A corrupt stored stat like `scoreLow: -9999` (finite number) passes `:763-766` and, via `Math.min` at `:799`, reaches the wire even though `SnapshotDimensionDTO` (`:675-680`) documents 0–100. The ordering invariant still holds, and the client independently clamps (`client/src/lib/skillBand.ts:15-21` `clampScore`), so nothing breaks visually — but the server should enforce its own contract. A one-line clamp of `scoreLow`/`scoreHigh` to [0,100] in `buildSnapshotDTO` closes it. Low urgency: the only writer is the finish handler, whose values are `estimateToScore` outputs, so this requires direct DB corruption.

**N-4 — `correct` recomputed instead of exposed.**
`diagnostic.ts:1260` refilters `scored` for the correct-count that `dimensionResult` already computed internally as `k`. Harmless duplication today (same input array), but exposing `correct` on `DimensionResult` would remove a place for the two to drift if scoring semantics (e.g. skip handling) ever change.

### PRAISE

**P-1 — The min/max re-anchor is the right design.** Rather than trusting the stored band or adding brittle cross-field validation, `buildSnapshotDTO` re-derives `score` from the column of record and forces the band around it. A whole class of corrupt-JSONB bugs becomes geometrically impossible.

**P-2 — Layered defense on the evidence read.** DB CHECK (`jsonb_typeof(evidence) = 'object'`) at rest, plus a parser that survives every shape including the ones the CHECK forbids. Neither layer assumes the other.

**P-3 — One parser, three readers.** `/latest` and `/finish` converge on `loadSnapshotDTO`; `/history` reuses the identical helper pair. No fork of the degradation logic to drift.

**P-4 — The skip log is actionable.** `runId`/`ordinal`/`section`/`correlationId` at `warn` (`:653-656`) turns a silently-shrinking run into a diagnosable corpus-data signal, exactly what the brief asked for.

---

## Test run evidence

```
Tests  35 passed (35)
Duration  28.98s
```

(dockerized `npx vitest run tests/routes/diagnostic.test.ts`, node:20-slim, per review instructions)
