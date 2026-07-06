# FIX REPORT — F-017 fix-pass (post-review)

Fix-pass agent, independent of author + reviewers. Inputs: `REVIEW_F017_components.md`, `REVIEW_F017_integration.md`, `REVIEW_F017_backend.md`. Every BLOCKER + SHOULD-FIX addressed below; NITs out of scope except two trivial in-file ones (noted).

---

## Components (REVIEW_F017_components.md)

### B1 BLOCKER — stuck mouse drag swallows all future swipes — **FIXED**
`client/src/components/SwipeCarousel.tsx`
1. Axis-lock `'v'` branch in `onPointerMove` now calls `endDrag()` (surrender = stop tracking) instead of keeping the ref alive with `axis:'v'`.
2. New `onPointerLeave` on the viewport: ends the gesture when `axis !== 'h'` (during `'h'` the pointer is captured, leave is not a concern). Same-pointerId guard kept.
3. `onLostPointerCapture={endDrag}` on the viewport — belt-and-braces for an externally revoked capture mid-`'h'`-drag.
4. Header doc updated ("Stuck-drag safety" paragraph).

Regression tests (`SwipeCarousel.test.tsx`):
- `still swipes after a press whose pointer left the viewport and was released off-element` — pointerdown → pointerOut(relatedTarget=body) → `fireEvent.pointerUp(document.body, …)` → a valid 120px swipe with a fresh pointerId MUST snap. NOTE: React synthesizes `onPointerLeave` from native `pointerout` + outside relatedTarget (leave itself doesn't bubble to the root listener), so the test fires `pointerOut` — that is what a real off-viewport leave delivers.
- `still swipes after a vertical drag released off-element` — vertical move (axis `'v'`) → pointerUp on body → valid swipe still snaps.
Both fail on the pre-fix code (ref immortal → `onPointerDown` guard rejects the follow-up swipe). EMPIRICALLY VERIFIED: with only `SwipeCarousel.tsx` reverted to `ca1cc09` (new tests kept), the suite fails 3/15 — the two stuck-drag recoveries plus the S1 non-primary/right-button test; with the fix restored, 15/15 pass.

### S1 — non-primary / non-left pointers arm gestures — **FIXED**
`SwipeCarousel.tsx onPointerDown`: `if (!e.isPrimary || e.button !== 0) return;` before the live-gesture guard. Existing drag tests updated to carry `isPrimary: true` (real gestures do; happy-dom's default is false, which is exactly what the guard rejects). Test `ignores non-primary and non-left-button presses entirely` covers right-button drag, non-primary press, and that neither blocks a later real swipe.

### S2 — mouse drag smears text selection — **FIXED**
`SwipeCarousel.css` `.km-carousel__viewport`: `user-select: none` + `-webkit-user-select: none` (always on, not `--dragging`-gated — the viewport is a drag surface; page content is charts/labels with no selection use-case, and gating on the class would still allow the selection to START before the axis lock).

### S3 — LineChart hit layer floods tab order (up to 30/90 stops) — **FIXED**
`client/src/components/LineChart.tsx`: hit buttons converted to roving tabindex — exactly one tab stop per chart (`tabIndex={i === rovingIdx ? 0 : -1}`, rovingIdx = readout point = `hoverIdx ?? n-1`), Left/Right move `hoverIdx` + focus via callback `hitRefs`, Home/End jump to first/last. DELIBERATE DEVIATION from "match the dots' pattern": arrows CLAMP at the ends instead of wrapping. The dots wrap because they are APG tabs; the hit layer is a time axis, where Left at the oldest point wrapping to the newest is disorienting. The roving mechanics (one stop, arrows, Home/End) match the dots exactly. Documented in the component header. No effects, no render-time ref writes (callback refs only — same discipline as the dots).

### S4 — component test gaps — **FIXED**
`SwipeCarousel.test.tsx` added: pointercancel cleanup (cancel mid-`'h'`-drag → no snap, next gesture works), edge overscroll both ends (rightward on page 1 stays; leftward on last page stays — via drag, not initialIndex), multi-touch (second pointerId's down/move/up inert during a live gesture; first finger still snaps exactly one page).
`LineChart.test.tsx` added: all-zero series (niceCeil(0)→1 scale, ticks 1/0.5, line renders, readout "0 reviews"), all-equal flat line (40s → ceiling 50, half-tick 25), mouse hover readout (`mouseOver`/`mouseOut` — React's onMouseEnter/Leave delegation events), plus roving-tabindex tests (exactly one tabIndex=0 on the latest point; arrows move focus+reading, clamp at ends; Home/End jump).

---

## Integration (REVIEW_F017_integration.md)

### SF-1 — fixture infidelity (grammar accuracy/% + vocab cards vs real wire score/pts + reviews) — **FIXED**
- `client/src/data/mocks/stats.ts`: grammar → `metric:'score', unit:'pts'`; vocab → `unit:'reviews'`. Header comment corrected (it claimed wire fidelity while diverging).
- `client/src/services/stats.test.ts`: GRAMMAR fixture → score/pts (still empty points, preserving the empty-passthrough case); VOCAB → reviews.
- `client/src/pages/Today.test.tsx`: SERIES fixture → grammar score/pts, vocab reviews; the vocab dot-nav test now asserts `35 reviews`. NEW test `renders the Grammar page with the score metric` navigates to page 4 and asserts the `52 pts` headline + rendered chart — so all three real wire metrics (accuracy via Reading, count via Vocab, score via Grammar) are now exercised in rendered tests.
- `client/src/types/domain.ts`: SkillSeries doc updated (count→reviews, score→pts examples).

### SF-2 — Promise.all × mock-fallback ⇒ fabricated data in prod — **FIXED (option a, allSettled)**
`client/src/services/stats.ts`: `Promise.all` → `Promise.allSettled`. A rejected route degrades its skill(s) to a fresh `{metric:'none', unit:'', points:[]}` placeholder (`unavailableSeries()`; topik failure degrades BOTH reading and listening); fulfilled routes keep real data. `fetchSkillSeries` now NEVER rejects on route failure — including total outage (five honest placeholder panels), so the mock fallback can never paint fixture numbers as real progress. Cancellation preserved: same `config` (signal spread unchanged) + after settling, `if (signal?.aborted) throw new ApiError('request canceled', {status:0, code:'canceled'})` — an abort stays a rejection, matching the hook's abort semantics.
- `client/src/pages/Today.tsx` `SkillTrendPanel`: `metric:'none'` now renders per-skill copy — writing keeps its invitation, any other skill shows `No data yet` (the placeholder previously would have shown "Start writing…" on a failed grammar panel).
- **Dead-code decision:** the series `ErrorCard` branch + `retrySeries` REMOVED from `Today.tsx` (unreachable: realFn never rejects, mock loader can't fail ⇒ post-loading data always present). The else-branch is `null` with a comment — kept only for type narrowing. Review SF-4 (error-arm test for that branch) is therefore moot for the series source; the today/diag ErrorCards are untouched (pre-existing gap, out of this pass's scope).
- `client/src/services/stats.test.ts`: all-or-nothing test replaced by 4 tests — single-route failure degrades only that skill; topik failure degrades both topik skills; total outage resolves with all placeholders (never rejects); aborted signal still rejects with `code:'canceled'`.
- NIT N-1 fixed while in file (trivial): `TREND_WINDOW_DAYS = 30` constant now feeds BOTH `fetchSkillSeries(TREND_WINDOW_DAYS)` and the chart aria-labels — the "last 30 days" label can no longer drift from the fetch window.

### SF-3 — no fresh-user (all-empty) Today test — **FIXED**
`Today.test.tsx`: new `EMPTY_SERIES` fixture (all five skills, real metrics, zero points) + test `renders every panel honestly for a fresh user (all series empty)` — asserts five `—` headlines, four `No data yet`, the writing invitation, zero trend charts, and no `NaN`/`undefined` anywhere in the rendered body.
- NIT N-3 fixed while in file (trivial): loading-test title "both fetches" → "the three fetches".

---

## Backend tests (REVIEW_F017_backend.md)

### SF-1 — no accuracy case where round ≠ trunc — **FIXED**
`server/tests/routes/topik.test.ts` (per-day math test): added a yesterday bucket with 2-of-3 correct asserting **67** (`round(100.0*2/3)`; integer division would give 66). Expected points now `[d-2: 33, d-1: 67, d-0: 75]`. A regression to `round(100 * c / n)` (bigint division) is now detectable.

### SF-2 — UTC day-bucket pin unproven (tests tz-neutral) — **FIXED (real test, all three files)**
`server/tests/routes/{topik,vocab,grammar}.test.ts`: each series suite gains `pins day buckets to UTC even under a non-UTC DB session TimeZone`:
- Ephemeral `buildTestApp` (established pattern, try/finally `teardownTestApp`) whose pool pins EVERY connection to `America/Anchorage` via `pool.on('connect', client => client.query("SET TimeZone …"))` — the documented node-postgres per-connection setup hook; queries on a client are pipelined in order, so the SET lands before any route query on that connection.
- The pin is PROVEN applied (`SHOW TimeZone` asserted = `America/Anchorage`) so the test can't silently degrade back into tz-neutral. The connect-hook's promise carries a `.catch` only to avoid an unhandled-rejection crash — a failed SET is still caught loudly by the SHOW assertion.
- Row inserted at exactly 00:30 UTC today (`($N::date + time '00:30') AT TIME ZONE 'UTC'`), which is YESTERDAY afternoon in Anchorage (UTC-9/-8). Route response asserted to bucket it on TODAY's UTC date. A regression dropping `AT TIME ZONE 'UTC'` (bare `col::date` follows the session zone) now fails all three tests.
- The expected day is captured BEFORE the insert (also used as the insert's date param), closing the reviewer's N-2 midnight-straddle flake for these tests.
- Deviation from the suggested `SET LOCAL`: `SET LOCAL` is transaction-scoped on the TEST's connection and can't reach the route's pooled connection; the per-connection pool pin is the reviewer's own alternative ("a pool whose connection sets a non-UTC zone") and is deterministic.

---

## Out of scope / not done (deliberate)

- Component NITs N1–N5, integration N-2/N-4, backend N-1/N-3/N-5: untouched per instructions (NITs only documented/fixed when trivial + already in the file — that applied to integration N-1 and N-3 only, both fixed above; backend N-2 fixed only within the new tz tests).
- PRAISE'd behavior preserved: LineChart NaN-safety untouched; zero `useEffect` / zero render-time ref writes in both components (new refs are callback refs / handler-mutated only); server `100.0` numeric division + `AT TIME ZONE 'UTC'` route SQL untouched (production code needed no change, per the backend review).

---

## Verification (pinned Docker harness, run after all changes)

Client (`node:20-slim`, `npm ci` fresh):
- `npx tsc --noEmit` → **TC=0**
- `npm run lint` (full output shown, not tailed) → **LINT=0, zero errors, zero warnings**
- `npx vitest run` → **65 files, 641 tests, all passed**
- `npm run build` → **BUILD=0**

Server (`node:20-slim`, `npm ci` fresh, testcontainers Postgres 16):
- `npx tsc --noEmit` → **STC=0**
- `npx vitest run tests/routes/topik.test.ts tests/routes/vocab.test.ts tests/routes/grammar.test.ts` → **3 files, 195 tests, all passed** (192 pre-existing + 3 new tz tests; the round≠trunc case extends an existing test)
