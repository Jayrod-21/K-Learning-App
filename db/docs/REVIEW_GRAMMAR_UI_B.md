# Review: grammar-ui — client

Independent senior review (I did not write this code). Scope: the client-side
grammar-tab bug-fix + feature set on branch `grammar-ui-fixes` vs `rebuild`.
Reviewed: `client/src/pages/Grammar.tsx`, `client/src/services/grammar.ts`,
`client/src/types/domain.ts`, `client/src/lib/grammarKey.ts`. Cross-checked
against the server contract in `server/src/routes/grammar.ts` and the
`useEndpointOrMock` hook. Tests are owned by a separate reviewer and were not
assessed here.

## Summary verdict

**PASS WITH CONDITIONS.**

The four changes are, on the whole, high-quality and defensively written. The
bank fix is genuinely robust — I could not construct a real corpus row that
still 400s. The drill cursor persistence is textbook (validated read, guarded
storage, effect-based write, StrictMode-safe). The graduation flow and its
optimistic overlays are correct and never let a graduated pattern into the drill
pool.

There are **0 BLOCKERs**. The one condition on approval is a real cross-tab
coupling defect (SHOULD-FIX #1): the List-tab **level filter** silently narrows
the **Banked tab** and the **drill pool**, because all three derive from the same
level-scoped `items` array. This produces confusing Active/Known counts and can
silently swap the drill pool from "your banked patterns" to "random corpus rows"
based on a filter set on a different tab. It only manifests once the user leaves
the default `all` level, so it is not broken-by-construction — but it should be
fixed before this ships.

## Bar checklist (relevant items)

| Bar rule | Verdict | Note |
|---|---|---|
| §0 Robust by default (I/O error handling, resume) | PASS | Abort controllers on generate/submit, inline `role="alert"` + Retry, mock fallback, optimistic rewind on failure. |
| §0 Clean tree (no console.log/TODO/dead code) | PASS | None found. |
| §0 Fail to safe | PASS | Drill never serves a graduated pattern even via the fallback pool (`drillableItems`). Storage failure degrades to in-memory rotation. |
| §2.1 Type safety at boundaries, no `any` | PASS | No `any`. External `location.state` narrowed via `readDrillTarget` runtime guard. JSONB typed `unknown`. |
| §2.1 Ban non-null `!` except commented invariant | PASS (minor) | One uncommented `pool[idx % pool.length]!` (NIT #1); invariant is provable from the guarding ternary. |
| §2.1 zod at the client boundary | N/A | Documented architecture (domain.ts header) validates server-side (Zod) and the client trusts TS types. `readDrillTarget` does hand-rolled runtime narrowing rather than zod — acceptable given the convention. |
| §2.2 Rules of Hooks / never disable exhaustive-deps | PASS (caveat) | Four `exhaustive-deps` disables; each is a justified sync-to-external effect with a written rationale. See SHOULD-FIX note on the generate effect's minimal deps. |
| §2.2 Stable keys, never array index | PASS | `key={row.patternKey}` throughout; TABS/filters keyed by id. Corrections list uses `span`-prefixed index (static, non-reorderable) — acceptable. |
| §2.2 useEffect only for external sync | PASS | Splits/derived state computed during render via `useMemo`; effects are network + storage + history-scrub only. |
| §2.4 Optimistic-update-with-rollback | PASS | Both `optimisticBanked` and `graduationOverrides` apply instantly, rewind on failure, and prune on server settle with identity preserved on no-op. |
| §2.8 No secrets/PII in localStorage | PASS | Only `km.grammar.drillCursor` = a non-negative integer. Matches the in-file threat model. |
| §2.8 No untrusted HTML / innerHTML | PASS | All corpus strings render as React text children. |

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. Level filter leaks into the Banked tab and drill pool (cross-tab desync).

### NIT
1. Uncommented non-null assertion `pool[idx % pool.length]!` (bar wants a comment on `!`).
2. `setKnown` catch does not distinguish a 404 (row deleted server-side) from a transient failure — "try again" would loop for a gone row.
3. Drill cursor `idx` grows unbounded and is persisted as an ever-increasing integer (harmless via modulo, but semantically a running counter, not a bounded cursor).
4. `bank` / `setKnown` `useCallback`s depend on `bankedState`, whose object identity changes every render, so the callbacks are re-created each render (perf-only).
5. Reused `km-review__tabs` tablist has no roving-tabindex / arrow-key navigation (pre-existing WCAG 2.2 tab-pattern gap now also worn by the Level and Active|Known toggles).

### PRAISE
- `buildBankBody` as a single sanitization choke point — every field clamped/defaulted, composite register dropped. Genuinely robust.
- `grammarKey` GR- derivation with empty-slug fallback — the correct root-cause fix for the bank-400 bug.
- Persisted drill cursor: validated read (`Number.isSafeInteger(n) && n >= 0`), try/catch on both accessors, effect-based write kept out of the `setIdx` updater (StrictMode-safe).
- Graduated patterns excluded from the drill even via the nothing-banked fallback pool.
- Optimistic overlays prune-on-settle with identity preserved on no-op settles (avoids memo thrash + unbounded growth).

## Detailed findings

### SHOULD-FIX #1 — Level filter silently narrows the Banked tab and drill pool

`Grammar.tsx:444` lifts `level` into the page component and threads it into the
fetch key at `Grammar.tsx:450-454` (`grammar:list:${level}`). The resulting
`listState.data` is the **level-scoped** corpus, and everything downstream is
derived from it:

- `items` = `listState.data ?? []` (`Grammar.tsx:688-691`)
- `bankedItems` = `items.filter(bankedKeys.has)` (`Grammar.tsx:692-695`)
- `activeBankedItems` / `knownItems` = `bankedItems` split by graduation (`Grammar.tsx:699-706`)
- `drillableItems` = `items.filter(!isGraduated)` (`Grammar.tsx:709-712`)

Because `bankedItems` is the **intersection** of the (level-filtered) list and
the user's banked keys, banking is cross-level but the display is not. Concrete
failure: the user banks several intermediate patterns, then sets the List filter
to **Beginner**. `items` now contains only beginner rows, so:

- The **Banked tab** loses every intermediate banked pattern — "Active (N)" and
  "Known (N)" counts (`Grammar.tsx:1044-1055`) drop, driven by a control on a
  *different* tab. This is a count/visibility desync the Active|Known criterion
  specifically calls out.
- The **drill pool** `activeBankedItems` collapses to the beginner subset. If
  *all* the user's banked patterns are non-beginner, `activeBankedItems` is
  empty and `DrillPanel`'s pool silently falls back to `items` — i.e. it drills
  **un-banked beginner corpus rows** instead of the patterns the user chose to
  study (`Grammar.tsx:1347`, `DrillPanelProps.bankedItems` doc at `1156-1161`).

The in-file docstring (`Grammar.tsx:440-443`) acknowledges this is intentional
("the whole screen … sees the level-scoped rows"), but intent does not make it
correct: a *List* filter should scope the List, not hide banked patterns or
repoint the drill. It defaults to `all` so it is latent, not broken-by-
construction — hence SHOULD-FIX, not BLOCKER. Recommended fix: fetch the Banked
subset and the drill pool from an unfiltered source (either a second `all`-level
fetch, or reconcile banked/drillable against a level-independent list) so the
level control only reshapes the List tab.

### NIT #2 — `setKnown` cannot recover from a server-side 404

`Grammar.tsx:665-677`: the graduate/re-admit failure path is a bare `catch {}`
that rewinds the optimistic override and shows "try again". It is not silent
(state + message are surfaced, satisfying §0), but it does not branch on the
`ApiError.status`. `graduatePattern`/`readmitPattern` 404 when the row was
deleted or belongs to another user (`server/src/routes/grammar.ts:233`). On a
404 the row is genuinely gone, so "try again" retries into the same 404 forever.
Consider treating 404 as terminal (drop the row / refetch) rather than
retryable. Same shape applies to `bank`'s non-409 branch (`Grammar.tsx:615-624`),
though there the retry is more defensible.

## Coordination observations

- **Bank body vs `BankBodySchema` — clean.** `buildBankBody` (`Grammar.tsx:324-339`)
  satisfies every constraint in `server/src/routes/grammar.ts:112-133`:
  `pattern_key` is always `^GR-[a-z0-9_-]{1,64}$` (grammarKey guarantees a
  non-empty slug via the `|| kgiu-${id}` fallback, `slice(0,64)`);
  `pattern_display` min1/max120 and `summary_en` min1/max240 and `category`
  min1/max40 all have non-empty fallbacks + `slice` clamps; `register` is
  emitted only on an exact enum match; `proficiency` is bucketed into the closed
  set by `toServerProficiency`. Worth noting the `/kgiu` list SELECT
  (`grammar.ts:59-60`) does **not** return the `register` column, so `row.register`
  is always `null` for list rows and the register sanitizer is currently moot on
  this path — correct and safe, just not exercised. No 400 path found.

- **Graduate/readmit id plumbing — correct.** The client keys the actions on
  `BankedMeta.id` = `grammar_entries.id` from `listBanked` (`Grammar.tsx:393-401`,
  `services/grammar.ts:90-114`), never the KGIU id, matching the server's
  `WHERE id = $1 AND user_id = $2` ownership check (`grammar.ts:228`). Rows not
  yet confirmed by the server (`actionableKeys`, `Grammar.tsx:715-718`) correctly
  disable the action until the id is known.

- **Idempotency alignment.** The client treats a 409 on bank as success
  (`Grammar.tsx:613-614`), matching the server's `ON CONFLICT (user_id,
  pattern_key)` upsert (`grammar.ts:144-152`, which returns 201 not 409 on a
  repeat — the 409 branch only fires on the `23505` race). Graduation is
  idempotent server-side via `COALESCE(graduated_at, now())` (`grammar.ts:226`);
  the client's optimistic override + refetch reconciles cleanly.

- **Page-file exports — lint-clean.** The only runtime export is
  `export default Grammar`; `export interface DrillTarget` (`Grammar.tsx:119`) is
  a type-only export that `react-refresh/only-export-components` ignores.
  `buildBankBody` and the other helpers are intentionally unexported
  (`Grammar.tsx:320-323`).

- **`limit: 400` covers the corpus.** `KGIU_LIST_LIMIT = 400` (`Grammar.tsx:183`)
  is exactly the server ceiling (`grammar.ts:40`, `.max(400)`), and 285 listable
  rows < 400, so the full set loads in one page. In-flight abort on a level
  change is handled by `useEndpointOrMock` keying on `level` (data/isMock reset
  eagerly, previous controller aborted — hook JSDoc + `useEndpointOrMock.ts:171-243`).
