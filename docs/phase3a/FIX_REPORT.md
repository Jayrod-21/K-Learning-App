# FIX-PASS REPORT — Phase 3 Group 3A (Today / Progress / Settings)

Branch: `feat/phase3a-core-surfaces`. Scope: all 9 SHOULD-FIXes across
`REVIEW_today.md`, `REVIEW_progress.md`, `REVIEW_settings.md` + the two
sanctioned consistency items. Zero blockers existed. No PRAISE item touched.

## Dispositions

| ID | Finding | Disposition | What was done |
|---|---|---|---|
| TODAY SF-1 | `disabled={busy}` drops keyboard focus to `<body>` mid-generation | **FIXED** | `WritingTopicGenerator.tsx`: `aria-disabled={busy \|\| undefined}` + busy guard in the click handler (aria-disabled does not block events). Busy paint mirrored via `.km-topicgen .km-btn[aria-disabled='true']` in the colocated `WritingTopicGenerator.css` — the shared `.km-btn:disabled` rule untouched. Abort/supersede discipline (P-1) untouched. Tests: busy test re-pinned on `aria-disabled` + `not.toHaveAttribute('disabled')`; new focus-retention + re-entry-guard test. Both fail on the un-fixed component (verified by running them against `HEAD`'s component: 2 failed / 7 passed). Note: happy-dom does not emulate the focus-drop of a mid-interaction `disabled`, so `toHaveFocus()` alone can't discriminate — the attribute assertions are the hard pin, the focus assertions document the real-browser behavior. |
| TODAY SF-2 | F-029 loop unpinned at Today level | **FIXED** | New `Today.test.tsx` test drives a real pointer-swipe (same gesture as `SwipeCarousel.test.tsx`'s helper) on the lead carousel: dot to page 2 of 2 → forward swipe → asserts page 1 selected. Verified it FAILS when `loop` is deleted from Today.tsx's lead carousel (ran with the prop removed: 1 failed) and passes with it. |
| TODAY SF-3 | Plan-failure Retry asserted to exist, never to fire | **FIXED** | Hook mock's `refetch` is now a per-key `vi.fn()` (cleared in `beforeEach`). The plan-failure test clicks Retry and asserts `hoisted.today.refetch` called exactly once AND `hoisted.attempt.refetch` not called (no collateral retry). |
| PROG SF-1 | Pager range text/buttons computed from the phantom requested offset on a failed Prev/Next (keep-stale) | **FIXED** | `Progress.tsx` WordMasteryPanel: page state is now `{ data: MasteryPage; offset: number }` — the offset the page was FETCHED at. Range text and Prev/Next disabled states derive from `page.offset` (shown), never the requested `offset`. Prev/Next also navigate relative to the shown offset (+ a nonce bump so re-requesting the same failed target refires the effect) — a failed Next re-requests offset 30, never compounds to 60. Regression test: failed Next keeps "1–15 of 50" (not "31–45 of 50"), Prev stays disabled, second Next re-requests offset 30. Fails on un-fixed code (verified). |
| PROG SF-2 | Encountered progressbar `aria-valuenow` can exceed `aria-valuemax`; `targetL4===0` → `aria-valuemax={0}` | **FIXED (both surfaces)** | Extracted `client/src/lib/encounteredBar.ts` (`encounteredBarAria`): clamps `aria-valuenow` to `targetL4`; when `targetL4 <= 0` drops progressbar semantics entirely (`aria-hidden`) since `valuemax=0` violates ARIA's valuemax > valuemin and the eyebrow already states the counts as text. Consumed by BOTH `Progress.tsx` (Hanja mastery tab) and `Hanja.tsx` (EncounteredBand) so the pair can't drift again. 2 tests in each of Progress.test.tsx and Hanja.test.tsx (clamp + zero-target); all 4 fail on un-fixed code (verified). |
| PROG SF-3 | F-031 test gaps: no range-text assertion, no Prev/Next window-reset test | **FIXED** | New test: 50-word fixture, asserts "1–15 of 50" initially, "1–30 of 50" after Show more (15), then Next → 15 items, 단어31–단어45 shown / 단어46 absent, "31–45 of 50". This is the SF-3 coverage-gap fill (the reset behavior already existed, per the review's "PASS (code) / GAP (test)"), so it passes on old code by design; the over-claims contract's failure mode is pinned by the SF-1 regression test above. |
| PROG SF-4 | Shrunken refetch (`offset=30`, `total=25`) strands an inescapable empty pager-less view | **FIXED** | In the fetch `.then`: when `offset > 0 && offset >= res.total`, the out-of-range page is not adopted — offset clamps to the last valid page (`(ceil(total/PAGE)-1)*PAGE`, floor 0) and the effect refetches (loading stays on; the clamp strictly decreases so it terminates, incl. `total=0`). Belt-and-braces: the pager also stays visible whenever the shown page's offset > 0. Test: Next hits a shrunken `{words: [], total: 25}` → asserts a third fetch at offset 0, real words rendered, no "No words in this group.", pager gone. Fails on un-fixed code (verified — un-fixed hangs on the stranded view). |
| SET SF-1 | `--placeholder { opacity: 0.75 }` dims the 11px hint text to ~3.1:1 (below AA) while the comment claims full contrast | **FIXED** | Removed the row-level opacity entirely (the now-empty ruleset deleted; the class stays on the row in Settings.tsx as the semantic hook). Disabled look = the existing per-control `:disabled` rule + the "Coming soon" badge; label/hint keep full-contrast tokens. Comment rewritten to describe what the code actually does. No test: happy-dom does not compute styles from external sheets, so a CSS-opacity contrast assertion is not exercisable in this stack — flagging for the re-reviewer to verify by inspection. |
| SET SF-2 | Six orphaned rule blocks in shared `index.css` after the F-039/F-040 removals | **FIXED** | Deleted `.km-settings__channels`, `.km-settings__chanchip`/`--active`/`--disabled`, `.km-settings__toggle-row`/`--last` (zero TSX consumers re-verified by grep before deletion; `__toggle-meta/label/hint` are still consumed by the schedule rows and were kept). Also deleted the dead `.km-today__queue`/`:hover`/`__queueCount`/`__queueMeta` rules and updated `Today.css`'s header comment that had deferred them. Short tombstone comments left where the blocks lived. `.km-progress__trendKr` left in place (pre-existing on `rebuild`, out of scope) — ticketed below. |
| CONS-1 | Today hand-rolls `<div className="km-eyebrow">` | **FIXED** | Both section eyebrows (`Today.tsx`) now use the `<Eyebrow>` primitive (style pass-through keeps the `marginBottom: 10` rhythm), matching Settings/Progress. |
| CONS-2 | BEM element-casing drift across pages | **DEFERRED (as instructed)** | High churn, low value — ticketed below instead of renamed. |

NITs: none were in files I was otherwise editing in a way that made them
trivially free (notifications.ts was not touched at all), so none were taken —
per the no-scope-creep instruction. `services/notifications.ts` N-3 (dead
export) rides the existing review record.

## Behavior notes for the re-reviewer

- **PROG SF-1 side effect (intended):** rapid double-Next while a fetch is in
  flight now re-requests the same target instead of the old
  `setOffset(o => o + 30)` compounding (which could skip past never-seen
  pages). Navigation is anchored to what the user can see.
- **PROG SF-2 degenerate choice:** for `targetL4 === 0` the bar hides from AT
  rather than faking a `valuemax=1` — the eyebrow line ("Encountered · N of
  ~0 at L4") remains the accessible text.
- **SET SF-1:** the `--placeholder` class is retained in the TSX (semantic
  hook), only its opacity rule is gone.

## Verification run (targeted — parent runs the full suite)

- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — clean.
- `npm run lint` (eslint .) — clean.
- Vitest, all five touched suites — **140/140 pass**:
  - `src/pages/Today.test.tsx` — 23/23 (was 22; +1 loop test, retry test upgraded in place)
  - `src/components/WritingTopicGenerator.test.tsx` — 9/9 (was 8; +1 focus/guard test)
  - `src/pages/Progress.test.tsx` — 44/44 (was 39; +5: range/reset, keep-stale regression, shrink clamp, ARIA clamp, zero-target)
  - `src/pages/Settings.test.tsx` — 49/49 (unchanged — CSS-only fixes)
  - `src/pages/Hanja.test.tsx` — 15/15 (was 13; +2 ARIA tests)
- Negative verification (bar: fix must ship with a test that fails un-fixed):
  ran the new/changed tests against the `HEAD` versions of
  `WritingTopicGenerator.tsx`, `Today.tsx` (loop prop removed),
  `Progress.tsx`, `Hanja.tsx` — 2, 1, 4, and 2 failures respectively, all in
  exactly the new tests. The single new test that passes on old code is the
  PROG SF-3 gap-fill (behavior pre-existed), as the review itself recorded.

## Self-assessment against the bar

- WCAG AA / ARIA: SF-1(T), SF-2(P), SF-1(S) close the three a11y findings; no
  new ARIA introduced beyond the shared helper. ✅
- Strict TS at I/O boundaries: no `any`; new helper fully typed; page-state
  shape change is compile-checked throughout. ✅
- No swallowed errors: keep-stale path preserved and now labeled honestly;
  clamp path never drops an error silently (it only runs on success). ✅
- Tests exercise real behavior: every code fix has a fails-on-unfixed test,
  verified by actually running against HEAD. ✅
- Co-located CSS: busy-button paint lives in WritingTopicGenerator.css, not
  the shared sheet; index.css was touched only for the sanctioned deletions. ✅
- No scope creep: Hanja.tsx and index.css edits were explicitly authorized;
  nothing else outside the three review scopes was modified. ✅
- No console.log / no ticket-less TODO in any touched file (grep clean). ✅
- PRAISE preservation: P-1 abort discipline (supersede + unmount abort +
  double aborted-guard) untouched; B-019 comment/target untouched; keep-stale
  behavior (PROG P-4) preserved and its test still passes; Settings sync code
  untouched entirely. ✅

## Tickets to file

1. **index.css dead-rule sweep — `.km-progress__trendKr`** (Progress.css:463
   orphan noted "left for the dead-rule sweep"; the sweep itself now has this
   as its only known remaining P3a item).
2. **BEM element-casing convention** — Settings kebab-case vs Today camelCase
   vs Progress mixed; pick one before P3b compounds it; rename as a dedicated
   mechanical PR.
3. **Grammar mastery read route (P4)** — `/grammar/mastery` mirror of
   `/vocab/mastery` over grammar production-card FSRS state; unblocks the
   GrammarMasteryPanel placeholder.
4. **F-075 follow-up — per-character Hanja FSRS list** — `/hanja/progress`
   currently aggregates only; the Progress Hanja tab and Hanja page defer the
   character list to this.
5. **nav.ts stale Uploads comment** (`client/src/lib/nav.ts:280-282`) — still
   says Uploads is "reached from Settings → Uploads"; F-039 removed that
   path. Fold into the F-057–F-059 uploads-retirement group.
