# FIX — sweep batch: `server/src/routes/topik.ts`

**Scope:** `server/src/routes/topik.ts` + `server/tests/routes/topik.test.ts` only (coordinated multi-agent sweep; strict file scope).
**Findings source:** `SWEEP_data_corpus.md` (D-1, D-2, D-5, D-7/D-8 assessed), `SWEEP_server_routes.md` (#3 INT4/BIGINT), `SWEEP_server_services.md` (#4 level key), `FOLLOW_UPS.md` (F-UP-014).
**Verify:** `npx tsc --noEmit` — 0 errors in the scoped files (a concurrent agent's in-flight `gradeWriting.test.ts` edit broke project-wide tsc mid-session; the pre-edit full run was STC=0 with these same changes). `npx vitest run tests/routes/topik.test.ts` — **77/77 pass** (59 pre-existing + 18 new). Every new regression test was additionally run against the **pre-fix** route (HEAD version restored temporarily): all 5 fix classes fail without the fix.

---

## D-1 / services #4 — HIGH: mock merges TOPIK I + TOPIK II — **FIXED**

TOPIK I and TOPIK II sittings share every `test_number` (migration 029 widened the tests natural key to `(test_number, topik_level, section)` for exactly this state), but every mock surface selected by `test_number` alone — merging two exams, duplicating item numbers, and truncating the interleaved stream at `LIMIT 50`.

**Fix — resolve ONE exam paper before touching items:**
- New `resolveMockTest(section, requestedTest?, requestedLevel?)` replaces `resolveMockSourceTest`: returns a single `{ sourceTest, topikLevel }` pair. Deterministic when under-specified: highest `test_number` with a gradeable item in the section, and within a sitting **TOPIK II over TOPIK I** (`ORDER BY t.test_number DESC, t.topik_level DESC`).
- `POST /topik/mock` and `POST /topik/mock/submit` **share this resolver** and both filter items with `t.topik_level = $n` — so a client that never sends a level still grades exactly the paper it was served, and F-007 resume (which replays `POST /topik/mock {sourceTest, section}`) re-fetches the identical paper. No `topik_attempts` schema change needed.
- Wire (backward-compatible, additive): optional `topikLevel: 'TOPIK I'|'TOPIK II'` on the mock + submit bodies; both responses echo the resolved `topikLevel`. `GET /topik/items` gains an optional `topik_level` filter (browse without it deliberately spans the sitting's papers) and a deterministic `ORDER BY t.test_number, t.topik_level, i.item_number`.

**Tests (6, all fail pre-fix):** two-paper seeding via a new level-aware raw-SQL seeder in the test file (the shared `seedTopikItem` helper hardcodes TOPIK II and is out of scope); explicit-sourceTest mock serves 2 items not 4 with no duplicate numbers; explicit `topikLevel` selects the other paper; submit without level grades exactly the served TOPIK II set; submit with `topikLevel:'TOPIK I'` grades the TOPIK I set; server-picked default resolves deterministically; `/items` `topik_level` filter narrows (and browse-spans-both asserted).

## Routes #3 — MEDIUM: INT4/BIGINT overflow → 500 — **FIXED**

`INT4_MAX` moved up to the domain-constants block (its old definition sat *below* the first schema that now needs it). Bounds added:
- `ItemsQuerySchema.source_test`, `MockBodySchema.sourceTest`, `MockSubmitBodySchema.sourceTest` → `.max(INT4_MAX)` (INTEGER `test_number`).
- `AnswerParamsSchema.itemId`, `MockSubmitAnswerSchema.itemId` → `.max(Number.MAX_SAFE_INTEGER)` (BIGINT ids — the gradeWriting pattern; ids past 2^53 can't round-trip a JS number and MAX_SAFE_INTEGER < int8 max).
- `AttemptBodySchema` was already bounded (unchanged).

**Tests (5, all 500 pre-fix → 400 now):** `GET /items?source_test=1e20`, `POST /mock sourceTest=3000000000`, `POST /mock/submit sourceTest=3000000000`, submit answer `itemId=1e20`, `POST /topik/<1e20>/answer`.

## D-2 + D-5 — served-but-unanswerable items — **FIXED**

- **D-2 (28 no-transcript listening items, stem `[듣기 지문 없음 …]`):** excluded in SQL — `ANSWERABLE_ITEM_SQL` now also requires `coalesce(i.stem,'') NOT LIKE '[듣기 지문 없음%'` (coalesce keeps NULL stems from being NULL-propagated out). Also guarded at render time in `mapRowToDTO` (`stem.startsWith`) so fetch-by-id surfaces (`/:itemId/answer` → 404, `/mistakes` → skipped) agree.
- **D-5 (8 comprehension items whose shared passage is the `[저작권 …]` withholding notice):** excluded in `mapRowToDTO` — when the resolved shared passage starts with the withholding marker the item is dropped like a structurally ungradeable row. SQL cannot resolve passage-range keys, so this is render-time only; because `/mock` and `/mock/submit` both map through `mapRows`, serve and grading universes stay identical. **Documented residual:** `GET /topik/items` `total` (a pure SQL count) still counts these 8 rows while the page excludes them — the pre-existing residual class for guards SQL cannot express (already acknowledged in the route doc); asserted explicitly in the test.

**Tests (2, both fail pre-fix):** D-2 item excluded from study/mock/browse (page AND total) and 404s on direct answer with nothing logged; D-5 items excluded from mock/study/browse page, submit `totalItems` matches the served set, residual total asserted.

## F-UP-014 — topik_attempts resurrect race — **FIXED** (server-side tombstone, no schema change)

A `PUT /topik/attempt` the server processes after both the `/mock/submit` DELETE and the client's `clearAttempt()` mop-up DELETE could re-INSERT the row and resurface a resume banner for a graded test.

**Fix:** submit no longer deletes the attempt — it upserts a **tombstone** (`picks = {"__closed__": true}`, zeros, the submitted `source_test`/`section` kept) in the same transaction as the score write. Then:
- `GET /attempt` reports a tombstone as `attempt: null`;
- `PUT /attempt`'s upsert carries a `WHERE NOT (…)` that refuses (silent 204 no-op) to overwrite a **fresh** tombstone for the **same** `(source_test, section)` — the exact shape of the racing save. A different paper always wins; after a 15 s grace window the same paper saves normally again (retakes never permanently blocked);
- `DELETE /attempt` preserves a fresh tombstone (the mop-up must not evict the guard) but still deletes live attempts (abandon semantics unchanged) and stale tombstones.
The `__closed__` key cannot be forged from the wire — `AttemptBodySchema` picks keys are regex-bound to `^\d+$`.

**Tests (4; the race test fails pre-fix):** full race sequence (save → submit → mop-up DELETE → delayed same-paper PUT → still null); different-paper save right after submit wins; stale tombstone yields (trigger disabled to backdate `updated_at`); tombstone key unforgeable (400).

## Other findings assessed — no code change

- **D-7 (U+FFFD in 3 explanations), D-3 (wrong-answer explanations):** corpus data, not topik.ts — out of scope for this batch.
- **D-8 (40 option-less test-35 rows):** already inert behind `jsonb_array_length >= 2`; no route change needed.
- **D-6 / D-9 (loader `extra` wipe, linkage staleness):** `tools/ingest/load_topik.py`, not topik.ts.
- **Routes-sweep IDOR/SQLi/division items:** all "no issue" confirmations in the sweep; nothing to fix.
