# REVIEW — Progress page (Phase 3 Group 3A: F-030 / F-031 / F-032 / F-041)

Independent senior review. Branch `feat/phase3a-core-surfaces` vs `rebuild`. Scope: `client/src/pages/Progress.tsx`, `Progress.css`, `Progress.test.tsx`. Neighbors sampled: `SwipeCarousel.tsx`, `Tabs.tsx`, `ShowMore.tsx`, `usePagination.ts`, `server/src/routes/hanja.ts`, `client/src/services/hanja.ts`, `client/src/pages/Hanja.tsx`.

Gates run by reviewer: `npx vitest run src/pages/Progress.test.tsx` → 39/39 PASS. `npx tsc --noEmit` → clean. `npx eslint src/pages/Progress.tsx src/pages/Progress.test.tsx` → clean.

## Verdict

**APPROVE — 0 BLOCKER, 4 SHOULD-FIX, 5 NIT.** All four ticket contracts (F-030/F-031/F-032/F-041) implemented correctly on the happy path + the named degenerate paths, with genuinely behavioral tests. SHOULD-FIXes = one stale-error pager mislabel, one ARIA boundary condition (inherited pattern from Hanja.tsx), two test gaps on ticket-named behaviors.

## Bar checklist

| Bar item | Status | Evidence |
|---|---|---|
| WCAG AA | PASS w/ caveat | Badge/chip contrast fix documented Progress.css:327-333; direction never color-alone (DeltaCell arrows Progress.tsx:826-839); legend names every series. Caveat = SF-2 (aria-valuenow can exceed aria-valuemax) |
| Tabs ARIA (W3C tablist, roving tabindex, aria-controls, only active panel mounts) | PASS | Tabs.tsx:125-168 — roving tabindex :144, aria-controls only on selected tab :143 (render-one design, avoids dangling idref), single re-keyed tabpanel :156-168. Progress consumes it stock (Progress.tsx:1617-1627) |
| Strict TS at I/O boundary, no `any` | PASS | No `any`; `fetchHanjaProgress` typed `Promise<HanjaProgress>` (services/hanja.ts:130-137), noUncheckedIndexedAccess guards Progress.tsx:619-624, 720-724. Compile-time-only narrowing = project-wide service convention (NIT-4) |
| No swallowed errors; Hanja fetch abortable, real error + working retry, real-data-only | PASS | AbortController + cleanup Progress.tsx:1476-1497; abort/canceled early-returns :1483-1490; fixed copy via `errorMessageFor` :1491; retry via nonce :1472-1474; no mock fallback by design :1461-1464. Test pins error copy + recovery (Progress.test.tsx:1093-1113) |
| Tests exercise real behavior | PASS | Loop test drives real pointer gesture through the axis-lock machine and asserts page1→last wrap (Progress.test.tsx:414-434 — would fail if loop clamped); window math asserted 15/20 + "Show more (5)" + unmount-when-exhausted (:951-972). Gaps = SF-3 |
| Backward compat — existing SwipeCarousel consumer unaffected | PASS | `git diff rebuild...HEAD` on SwipeCarousel/Tabs/ShowMore/usePagination = EMPTY (primitives untouched this branch). "Progress by skill" usage unchanged: no `loop` (Progress.tsx:359), default false keeps hard edges (SwipeCarousel.tsx:74). Still covered by 6 tests incl. dot nav + all-metric render paths (Progress.test.tsx:521-725) |
| Co-located CSS | PASS | Progress.css imported from Progress.tsx:113; new F-030/F-041 rules all consumed |
| No scope creep | PASS | Diff = the four tickets + doc-comment updates only |
| No console.log | PASS | grep clean across all three files |
| No TODO w/o ticket ref | PASS w/ caveat | No TODO literal; "left for the dead-rule sweep" soft-TODO = NIT-1 (pre-existing) |
| No dead CSS left behind | PASS w/ caveat | Dead rules whose markup died were removed (`.km-progress__attemptcompare`, `.km-progress__soonhead .km-progress__card-title`); pre-existing orphan `.km-progress__trendKr` retained = NIT-1 |

## Ticket-specific checks

| Check | Status | Evidence |
|---|---|---|
| F-030 order TREND → attempt-vs-attempt → all-attempts, loop on | PASS | Pages array Progress.tsx:628-668, `<SwipeCarousel ariaLabel="Attempt history" loop>` :699. Order test Progress.test.tsx:395-412; wrap test :414-434 |
| F-030 single attempt → 2-page carousel, no broken/empty state | PASS | Compare page conditionally spread `n >= 2` (Progress.tsx:646-658); n===1 note :637-644; TrendChart n===1 centers marker (xFor guard :398-402). Tests :436-447, :743-765. Loop-with-2-pages wrap math sound (SwipeCarousel.tsx:132-135) |
| F-031 usePagination + ShowMore, 15/+15/max 30 | PASS | Hook defaults ARE the spec (usePagination.ts:48-50); consumed Progress.tsx:1233; max 30 == MASTERY_PAGE so full server page reachable (comment :1229-1232 correct) |
| F-031 window resets on bucket change AND Prev/Next | PASS (code) / GAP (test) | `selectBucket` → `pager.reset()` :1238-1242; Prev :1365-1368, Next :1388-1391 both reset. No test covers Prev/Next reset → SF-3 |
| F-031 pager range never over-claims shown count | PASS happy path / FAIL stale path | Upper bound = `offset + pager.visible.length` :1376-1381 (correct: "1–15 of 50" under the 15-window). Stale-refetch-failure path mislabels → SF-1 |
| F-032 Word+Grammar+Hanja as Tabs, one shared area | PASS | MasterySection Progress.tsx:1611-1630; single card title, tabs carry section names; only active panel in DOM (tested Progress.test.tsx:996-1043) |
| F-041 reads GET /hanja/progress, graceful all-zero empty | PASS | Empty test = `banked + practicing + encountered === 0` :1518 — `new` deliberately excluded, matching server semantics (encountered counts ANY progress row; server/src/routes/hanja.ts:346-350). HANJA_EMPTY fixture `new: 150` would catch a naive all-zero check (Progress.test.tsx:201-220, 1077-1091) |
| F-041 fixed error copy + working retry | PASS | Progress.tsx:1506-1513, test :1093-1113 asserts "boom" never surfaces |
| Grammar placeholder honest (no /grammar/mastery route exists) | PASS | Coming-soon pill + one line, zero fabricated numbers (Progress.tsx:1413-1435); route confirmed absent server-side (P4 per comment) |

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — Pager range text mislabels the shown window when a Prev/Next refetch fails (keep-stale path).**
`Progress.tsx:1385-1391` (Next) sets `offset` to 30 before the fetch; on fetch failure the stale `page` (offset-0 words) is kept (:1268-1275 leaves `page` untouched) and the stale banner shows (:1301-1315) — but the pageinfo (:1372-1384) computes from the NEW offset: reads "31–45 of 50" while words 1–15 are displayed. Count matches but the claimed window is wrong; Prev/Next disabled states also derive from the phantom offset. Fix direction: carry the fetched-at offset inside the page state (set it in the `.then` alongside `setPage`) and drive pageinfo + button disabling from that, or suppress the numeric range while `error !== null`. Mitigation credit: the role="alert" banner explicitly says "showing the last loaded mastery", so the user is warned — this is why it is not a BLOCKER.

**SF-2 — Encountered progressbar: `aria-valuenow` can exceed `aria-valuemax`.**
`Progress.tsx:1574-1580`: `aria-valuemax={progress.targetL4}` but `aria-valuenow={progress.encountered}`, and `encountered` counts progress rows across ALL levels while `targetL4` counts only L4 characters (server/src/routes/hanja.ts:355-373) — a long-run user exceeds the max. Visual width is already clamped (:1533-1536); the ARIA value is not. ARIA 1.2 requires valuenow within [min,max]. Also degenerate `targetL4 === 0` → `aria-valuemax={0}`. Fix: `aria-valuenow={Math.min(progress.encountered, progress.targetL4)}` + skip/adjust the bar when targetL4 is 0. NOTE: this duplicates the pre-existing pattern at `client/src/pages/Hanja.tsx:384-390` (EncounteredBand) — fix both together or extract (see NIT-2); do not fix Progress alone and leave the pair inconsistent.

**SF-3 — Test gaps on two ticket-named F-031 behaviors.**
(a) No test asserts the pager range text at all (the "never over-claims" contract, incl. the SF-1 regression once fixed). (b) No test asserts the window resets to 15 on Prev/Next (only the bucket-change reset is covered, Progress.test.tsx:974-993). The paging test (:879-909) only asserts the fetch was called with `offset: 30`. Add: fixture with `total > 30`, expand to 30 via Show more, click Next, assert 15 items + range text "31–45 of 50".

**SF-4 — Stale-offset trap: shrunken refetch can strand an empty, pager-less view.**
If `offset=30` and a retry/refetch returns `{ words: [], total: 25 }` (data shrank server-side), `page.total > MASTERY_PAGE` (:1360) hides the whole pager, leaving "No words in this group." (:1321-1327) with no Prev to escape; only a bucket-chip tap (which resets offset) recovers. Low likelihood (requires concurrent data shrink) but a one-line guard — clamp offset when `offset >= page.total` on response, or keep the pager visible whenever `offset > 0` — removes the trap.

### NIT

**N-1** — `Progress.css:463-467` `.km-progress__trendKr` remains orphaned with a "left for the dead-rule sweep" note (:471-472) — a soft TODO without a ticket ref. Pre-existing on `rebuild` (this diff only re-touched the comment), so out of strict diff scope, but the branch was in the file: sweep it or ticket it.

**N-2** — The F-041 encountered band (Progress.tsx:1567-1589) duplicates `Hanja.tsx` EncounteredBand (:357-395) near-verbatim: same bilingual eyebrow copy, same pct clamp, same progressbar attributes. Extraction candidate — becomes load-bearing if SF-2 is fixed in both places.

**N-3** — `HistoryPage` titles (Progress.tsx:595-597) are styled `div`s, not headings — consistent with the page's existing card-title pattern, but carousel pages get no heading-nav landmark for AT. Fine to leave for the overhaul's IA pass.

**N-4** — `fetchHanjaProgress` (services/hanja.ts:130-137) is a compile-time-typed pass-through with no runtime narrowing of the server body. Consistent with every other service in the codebase (documented "typed pass-through" convention), so noted for the record only — do NOT "fix" this one call site in isolation.

**N-5** — Test `panels[0]`/`panels[1]` indexing without non-null assertions (Progress.test.tsx:405-411 vs `rows[1]!` style elsewhere :344-346) — inconsistent but harmless (matchers accept undefined and would fail loudly).

### PRAISE (fix-pass must not undo)

**P-1** — The loop test (Progress.test.tsx:414-434) is the real thing: it drives an actual pointerdown/move/move/up sequence through SwipeCarousel's axis-lock state machine and asserts the page-1→page-3 wrap. A clamping (non-loop) carousel fails it. Exactly the non-tautological test the bar demanded.

**P-2** — `HANJA_EMPTY` fixture with `new: 150` (Progress.test.tsx:201-220) + the `banked + practicing + encountered === 0` predicate (Progress.tsx:1515-1518): the test would catch the naive "all fields zero" implementation, and the predicate encodes the server's actual semantics (encountered = ANY progress row). This is the F-041 requirement done precisely.

**P-3** — `'Show more (5)'` assertion (Progress.test.tsx:965) pins the honest reveal count from `usePagination().remaining` rather than the naive step of 15 — the exact over-promise failure `ShowMore`'s docs warn about (ShowMore.tsx:27-32).

**P-4** — WordMasteryPanel's documented decision to bypass `useEndpointOrMock` (Progress.tsx:1247-1252): keep-stale-on-refetch-failure with an inline retry, abortable, real-data-only. The keep-stale behavior is itself tested (Progress.test.tsx:911-928).

**P-5** — Diff hygiene in Progress.css: rules whose markup died were removed with it (`.km-progress__attemptcompare`, the soonhead title-margin rule), and the F-041 additions reuse the existing `.km-mastery__*` family instead of a parallel system.

**P-6** — The total-outage vs fresh-account distinction tests (Progress.test.tsx:640-709) assert both directions of the honesty contract (failure never reads as "No data yet"; all-empty never reads as an outage) with region-scoped queries that can't false-pass off other page copy.

## Coordination observations

- **Primitives untouched.** `git diff rebuild...HEAD` on SwipeCarousel/Tabs/ShowMore/usePagination is empty — Group 3A consumed Phase-1 primitives as-is. The pre-existing "Progress by skill" carousel usage is byte-identical (still no `loop`) and retains full test coverage, so the backward-compat requirement is proven, not just asserted.
- **Cross-file pairing for SF-2:** the same progressbar pattern lives at `client/src/pages/Hanja.tsx:384-390`. If the fix-pass clamps `aria-valuenow` in Progress.tsx, it must clamp Hanja.tsx too (or extract per N-2) — Hanja.tsx is outside this ticket's diff, so that's a deliberate cross-scope touch to flag to the coordinator, not silent creep.
- **Server contract confirmed:** GET /hanja/progress returns aggregate counts only (`server/src/routes/hanja.ts:328-397`); the panel correctly renders it as a summary, not a character list, and its comment correctly defers per-character FSRS to F-075.
- **Grammar tab:** no `/grammar/mastery` read route exists on the branch; the placeholder is honest and the P4 deferral is documented in both code and tests.
- Gates at review time: 39/39 vitest, tsc clean, eslint clean.
