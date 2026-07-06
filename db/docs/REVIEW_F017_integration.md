# F-017 Integration Slice Review — stats service / contract wiring / Today card

Reviewer: independent senior review (integration slice only).
Commit: `ca1cc09` — feat(today): swipeable per-skill stats carousel (F-017).
Scope: `client/src/services/stats.ts` + `stats.test.ts`, `client/src/types/domain.ts` (SeriesPoint/SkillSeries/AllSkillSeries), `client/src/data/mocks/stats.ts`, `client/src/pages/Today.tsx` + `Today.css` + `Today.test.tsx`.
Out of scope: LineChart/SwipeCarousel internals, server routes (read only to verify contract behavior).

## Verdict

**PASS with SHOULD-FIXes. 0 BLOCKERs, 4 SHOULD-FIX, 4 NIT.**

Both suites pass in the pinned Docker run: `src/pages/Today.test.tsx` + `src/services/stats.test.ts` → **2 files, 16 tests, all green** (1.13s). The two highest-risk paths named for this review were traced end-to-end:

- **Fresh-user empty-data path: SAFE.** Every panel degrades gracefully — traced below, no NaN/undefined anywhere. But it is untested at the Today level (SHOULD-FIX 3).
- **All-or-nothing fan-out: the `Promise.all` choice itself is defensible, but its interaction with the mock-fallback hook produces the worst possible prod failure mode for a stats widget — fabricated data presented as real (SHOULD-FIX 2).**

The dominant real defect in the slice is fixture infidelity: the mock and every client test model grammar as `accuracy`/`%`, but the real wire is `score`/`pts` — the `score` rendering path ships with zero client-side exercise (SHOULD-FIX 1). This is exactly the "tests used a whitelisted category + mocked API" failure class this project has been burned by before.

---

## Trace 1 — Fresh user (all series empty): GRACEFUL, verified by code reading

Server behavior confirmed: with zero rows, all three routes still return well-formed envelopes (`metric` + `unit` set, `points: []`) — e.g. `server/src/routes/topik.ts` builds `reading`/`listening` from filtered rows, empty in, empty out.

Per panel:

1. `latestValue()` (`client/src/pages/Today.tsx:161-167`): `series.points[length-1]` is `undefined` → early-returns `'—'`. No `NaN%`, no `undefined`.
2. `LineChart` (`client/src/components/LineChart.tsx`): filters non-finite values, then `n === 0` → renders the `"No data yet"` placeholder div. Single point → centered dot. All-zero series → `niceCeil` returns 1 (no divide-by-zero).
3. Writing: `metric === 'none'` guard (`Today.tsx:191`) short-circuits to the "Start writing to see your progress here." panel before `LineChart` is ever reached; headline is `'—'` via the same empty-points guard.

So a brand-new user sees five panels, each with an em-dash headline and either "No data yet" or the writing invitation. Correct and honest. The gap is purely test coverage (see SHOULD-FIX 3).

## Trace 2 — Fan-out failure (e.g. grammar 500): all-or-nothing × mock fallback

`stats.ts:69` `Promise.all` rejects on first failure → `useEndpointOrMock` (`client/src/hooks/useEndpointOrMock.ts:205-231`) catches, records the real `ApiError`, then **resolves the mock** → `data = SKILL_SERIES_FIXTURE`, `isMock = true`. The `MockBadge` is dev-only, and nothing on Today surfaces `series.error` visibly in prod. Net prod behavior when one of three routes 500s: **all five panels paint hardcoded June-2026 fixture numbers (74% reading, 35 cards, …) as the user's real progress, with no indication.** The `ErrorCard` branch (`Today.tsx:355`) is only reachable if the mock loader itself throws — which it cannot in practice — so the error/retry UI is effectively dead code in prod.

Judgment in SHOULD-FIX 2 below.

---

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1. Mock fixture + all client test fixtures mis-model the real grammar and vocab series — the `score` metric path ships unexercised.**
- `client/src/data/mocks/stats.ts:59` — grammar mocked as `metric: 'accuracy'`, `unit: '%'`. Real wire (`server/src/routes/grammar.ts`) is `metric: 'score'`, `unit: 'pts'`.
- `client/src/data/mocks/stats.ts:45` — vocab mocked as `unit: 'cards'`. Real wire (`server/src/routes/vocab.ts`) is `unit: 'reviews'`.
- The same wrong shapes are copied into `client/src/services/stats.test.ts:34` (GRAMMAR = accuracy) and `client/src/pages/Today.test.tsx:120` (grammar accuracy) / `:113` (cards).

Consequence: nowhere on the client — not the mock path, not stats.test, not Today.test — does a `metric: 'score'` series ever render. I verified by reading that the path is safe (`METRIC_LABELS.score = 'Score'` at `Today.tsx:152`, `latestValue` non-accuracy branch → `"52 pts"`, LineChart auto-scales non-`%` units, server `round(avg(score))::int` keeps values integral), so this is not a live bug today — but the fixture's stated purpose ("Shapes mirror the wire contract exactly", `mocks/stats.ts:5`) is false, and any future regression in the score branch is invisible to the entire client suite. This project has an explicit standing lesson about exactly this pattern (tests passing on a whitelisted category while prod used a different one). Fix: make the mock grammar `score`/`pts` and vocab `reviews`, and let at least one test fixture carry each of the three wire metrics.

**SF-2. All-or-nothing fan-out: acceptable in isolation, but the composed prod failure mode is fabricated data — degrade per-skill or surface the error.**
`client/src/services/stats.ts:16-20` documents the rationale ("painting three real charts next to one silently-missing skill would lie"). As a pure service decision that reasoning is sound, and I would not demand `allSettled` on principle. But trace 2 shows what actually happens through `useEndpointOrMock`: one grammar 500 doesn't produce an error state — it replaces *all five* skills with fictional fixture numbers in prod, which lies far harder than one placeholder panel would. The comment's own justification is inverted by the hook it hands the rejection to. Recommend one of:
  (a) `Promise.allSettled`, mapping each rejected skill to the existing `metric: 'none'` placeholder (the panel machinery for "no chart here" already exists and is tested via writing); or
  (b) keep all-or-nothing but opt this key out of mock fallback so the already-written `ErrorCard` + `retrySeries` (`Today.tsx:355-358`) actually fires.
Option (a) is the better user outcome (4 real + 1 "unavailable"); either resolves the fabricated-data mode. Noting honestly: the mock-fallback-swallows-errors semantics are app-wide and pre-date this commit — but a *progress-stats* widget is where fixture-as-real-data does the most damage, so this feature is where the pattern should first be broken.

**SF-3. No fresh-user (all-empty-series) test at the Today level — the most common real state for this app's actual audience.**
`Today.test.tsx`'s `SERIES` fixture (`:93-127`) gives every non-writing skill populated points; `stats.test.ts` includes exactly one empty series (GRAMMAR, `:34-38`) but only asserts service passthrough. Nothing renders a panel with `metric: 'accuracy', points: []` and asserts the `'—'` headline + "No data yet" body. The path is safe today (Trace 1), but it is one refactor of `latestValue` away from `"NaN%"` with no test to catch it. Add one Today test with all five series empty.

**SF-4. Series error → ErrorCard/retry branch untestable and untested.**
The hook mock in `Today.test.tsx:29-30` supports only `{ kind: 'loading' } | { kind: 'data' }` — there is no error kind, so the `seriesData === null` → `ErrorCard` branch (`Today.tsx:353-358`) has zero coverage (true of the sibling widgets too; this commit extends the pre-existing gap rather than creating it). Combined with SF-2 (the branch is unreachable in prod anyway), this is code that has never executed anywhere. Whichever way SF-2 lands, add an error-kind arm to the hook mock and one assertion that the card + retry wire up.

### NIT

**N-1.** `Today.tsx:201` — `ariaLabel={`${label} trend over the last 30 days`}` hardcodes the window while `fetchSkillSeries(days)` is parameterized. True today (Today uses the default 30); becomes a silent lie the day anyone passes a different window. Derive the label from the same constant the fetch uses.

**N-2.** `Today.tsx:166` — `String(last.value)` prints raw float precision if the server ever sends a non-integral count/score (today all three routes round to `::int`, so no live effect). LineChart already has `formatTick` for exactly this; the headline should use the same discipline.

**N-3.** `Today.test.tsx:164` — test title "renders loading skeletons while **both** fetches are pending" — there are three now.

**N-4.** `client/src/data/mocks/stats.ts:19-69` — fixture dates hardcoded to June 2026 will read as visibly stale mock data within weeks (dev-only, cosmetic).

### PRAISE

**P-1.** The empty/degenerate handling is genuinely defense-in-depth: `latestValue`'s `undefined` guard, LineChart's non-finite filter + `n===0` placeholder, `niceCeil(0)→1`, and the hand-parsed `formatDay` that echoes malformed dates instead of rendering "undefined NaN". The fresh-user path survives every input I could construct.

**P-2.** `stats.ts:80-82` synthesizes a *fresh* writing sentinel per call, and `stats.test.ts` has a regression test that two calls don't share the object — a subtle shared-mutable-state bug pre-empted before it existed.

**P-3.** Signal/params wiring is correct and correctly tested: one config with `params: { days }` and conditional signal spread (so no stray `signal: undefined` key), one `AbortSignal` fanned to all three requests, `days` forwarding verified for default and non-default values, and an explicit all-or-nothing rejection test carrying the `ApiError` status through.

**P-4.** Today integration is clean: key `'today.series'` is unique across the codebase; loading skeleton / data / error branches mirror the sibling snapshot widget exactly; `isMock` correctly OR-ed across all three sources; SkillsCompare is untouched by the diff (no changes to its files) and the coexistence test (`Today.test.tsx:289-303`) proves the snapshot card and carousel render together. New CSS is page-scoped in `Today.css` rather than dumped into the global sheet, with per-skill accents consistent with the Progress palette.

**P-5.** Domain types (`domain.ts:1803-1844`) document the contract precisely — ascending order, gaps-absent-not-zero-filled, the client-only `'none'` sentinel explicitly marked "Never on the wire" — and `metric: 'none'` is handled at every consumption site (`METRIC_LABELS` exhaustive record, the `Today.tsx:191` guard before LineChart, `latestValue`'s empty-points path).

---

## Direct answers to the probe questions

- **All-or-nothing acceptable?** As a service-layer decision, yes-defensible; as shipped behavior through the mock-fallback hook, no — SHOULD-FIX (SF-2). Fabricated fixture stats in prod on a single-route failure is the worst outcome available.
- **Signal/params threaded?** Yes, correctly, and tested (P-3).
- **Runtime guard at the boundary?** None — `api.get<T>` (`client/src/services/api.ts:227-238`) returns the body as a trusted cast. This is the uniform codebase convention against its own same-origin server, and the downstream defensive rendering (finite filter, date regex, empty guards) contains the blast radius; accepted, no finding.
- **`metric: 'none'` safe everywhere?** Yes (P-5).
- **SkillsCompare untouched?** Confirmed — no SkillsCompare file in the commit; card renders above the new section (`Today.tsx:292` vs `:333`).
- **Latest-value reads last point / survives empty?** Yes and yes (Trace 1); writing shows `'—'` + placeholder, not a broken chart.
- **Existing Today tests still pass?** Yes — full run green (16/16), including the pre-existing plan/snapshot/interaction tests against the extended hook mock.
- **Mock fixture faithful to the wire?** No — grammar metric/unit and vocab unit diverge from the real routes (SF-1). Structure (ascending dates, gaps absent, 0–100 accuracy) is otherwise faithful.
