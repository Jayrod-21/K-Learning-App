# RE-REVIEW — Phase 3A fix-pass verification (Phase 4)

**Reviewer:** independent re-review (did not author the code, the original reviews, or the fix-pass)
**Branch:** `feat/phase3a-core-surfaces`, fix-pass commit `4d490e8` (HEAD at review time)
**Inputs:** `REVIEW_today.md`, `REVIEW_progress.md`, `REVIEW_settings.md`, `FIX_REPORT.md`, plus the full `git diff 4d490e8~1 4d490e8` read file-by-file.

## Summary verdict: **PASS**

All 9 SHOULD-FIXes and consistency item CONS-1 are genuinely fixed in code, with regression tests that target the actual defects. CONS-2 (BEM casing) is a legitimate deferral. I independently re-ran the negative verification for the two riskiest surfaces (Hanja, Progress) by checking out the pre-fix files and running the suites: the failures land in exactly the new tests, for the right reasons, matching the fix-pass's claimed counts. No PRAISE item was undone. No blocker was introduced. One follow-up condition: the five tickets listed in FIX_REPORT.md have **not** actually been filed (`gh issue list` is empty), so the deferrals currently rest on a list inside a doc, not on tracker items.

**Verification actually run (this review):**
- Read every hunk of `git diff 4d490e8~1 4d490e8` (14 files).
- `npx vitest run` on Progress + WritingTopicGenerator + Hanja suites → 68/68 pass (44 + 9 + 15, matching FIX_REPORT).
- Negative verification, independently reproduced: checked out `4d490e8~1` versions of `Hanja.tsx` and `Progress.tsx` (restored byte-identical afterward, tree clean):
  - Hanja: **2 failed / 13 passed** — exactly the two new ARIA tests.
  - Progress: **4 failed / 40 passed** — exactly keep-stale range, shrink clamp, ARIA clamp, zero-target. The SF-3 gap-fill test passes on old code, precisely as FIX_REPORT honestly disclosed.
- Grep sweeps: deleted index.css classes → zero TSX/TS consumers; kept `__toggle-meta/label/hint` → live consumers at `Settings.tsx:2236-2238`; `--placeholder` class retained as semantic hook at `Settings.tsx:2233`.
- PRAISE-preservation greps (see section below).
- Settings SF-1 verified by direct inspection of `Settings.css` (no test possible in happy-dom — the fix-pass's claim about external-sheet styles is accurate).

---

## Finding-by-finding verification

| Finding ID | Original severity | Fix status | Notes |
|---|---|---|---|
| TODAY SF-1 (focus drop on `disabled={busy}`) | SHOULD-FIX | **FIXED** | `aria-disabled={busy \|\| undefined}` + in-handler busy guard (`WritingTopicGenerator.tsx:176-189`). `Button` spreads `...rest` so the attribute reaches the real `<button>`. Busy paint `.km-topicgen .km-btn[aria-disabled='true'] { opacity: 0.5; cursor: not-allowed; }` is exact parity with the shared `.km-btn:disabled` rule (`index.css:651`). Tests pin the attribute pair (`toHaveAttribute('aria-disabled','true')` + `not.toHaveAttribute('disabled')`) — the hard pin that fails on the old code — plus focus retention across the busy window, re-entry hammering (`generateMock` called once), and post-settle focus. The report's caveat that happy-dom can't emulate the real blur is honest; the attribute assertions carry the regression guard. |
| TODAY SF-2 (F-029 loop unpinned at page level) | SHOULD-FIX | **FIXED** | New `Today.test.tsx` test drives a real pointerdown/move/move/up gesture through Today's OWN lead carousel (region "Review and drills"), starting on page 2 of 2, and asserts wrap to page 1 via `aria-selected`. Deleting `loop` from `Today.tsx` makes the primitive damp at the edge, failing the assertion — the test targets the actual acceptance criterion (THESE carousels loop). Could not re-run this negative without editing code; reasoning verified against the primitive's documented clamp-vs-loop behavior. |
| TODAY SF-3 (Retry asserted to exist, never to fire) | SHOULD-FIX | **FIXED** | Hook mock's `refetch` is now a per-key live `vi.fn()` (cleared in `beforeEach`); the plan-failure test clicks Retry and asserts `hoisted.today.refetch` called exactly once AND `hoisted.attempt.refetch` never — the collateral-retry negative is a nice extra. `onRetry={undefined}` or miswiring now fails. Test-only fix (the wiring pre-existed), so no fails-on-unfixed claim was made for it — consistent. |
| PROG SF-1 (pager text/buttons from phantom offset on failed hop) | SHOULD-FIX | **FIXED** | `LoadedMasteryPage { data, offset }` stores the fetched-at offset (`Progress.tsx:1224-1235`); `shownOffset = page?.offset ?? 0` drives range text, Prev/Next disabled states, AND navigation targets (`goToOffset(shownOffset ± MASTERY_PAGE)`), while the requested `offset` drives only the fetch. Desync is now structurally impossible: everything user-visible derives from the single stored offset, set atomically with the data in the same `.then`. Failed Next re-requests offset 30 (nonce bump forces the refetch when `offset` is already at the target), never compounds to 60. Negative-verified by me: keep-stale test fails on pre-fix code (reads "31–45 of 50"). |
| PROG SF-2 (aria-valuenow > valuemax; valuemax=0) | SHOULD-FIX | **FIXED (both surfaces)** | New `client/src/lib/encounteredBar.ts` — `encounteredBarAria()` clamps `aria-valuenow` to `targetL4`; `targetL4 <= 0` returns `{'aria-hidden': true}` (dropping progressbar semantics rather than emitting valuemax=0, with the eyebrow text carrying the counts). Consumed by BOTH `Progress.tsx:1615-1618` and `Hanja.tsx:387-390`. The visual clamp is untouched in both (pct math unchanged, incl. the pre-existing `targetL4 > 0` guard in Hanja). 2 tests per surface; all 4 negative-verified by me (fail on pre-fix code, in the clamp/zero-target assertions specifically). |
| PROG SF-3 (no range-text / Prev-Next reset tests) | SHOULD-FIX | **FIXED** | 50-word fixture test asserts "1–15 of 50" → Show more (15) → "1–30 of 50" → Next → 15 items, 단어31–단어45 present / 단어46 absent, "31–45 of 50". Covers both named gaps (range never over-claims; window resets on Prev/Next). Passes on old code by design — it is the coverage fill the review itself scoped as "PASS (code) / GAP (test)"; the failure mode is pinned by the SF-1 regression test. |
| PROG SF-4 (shrunken refetch strands empty pager-less view) | SHOULD-FIX | **FIXED** | In the fetch `.then`: `offset > 0 && offset >= res.total` → out-of-range page never adopted; offset clamps to `max(0, (ceil(total/MASTERY_PAGE)-1)*MASTERY_PAGE)` and the effect refires with loading held on. Termination is sound: the clamp target is provably `< total ≤ offset`, so it strictly decreases (incl. `total=0` → 0). Belt-and-braces pager visibility `page.data.total > MASTERY_PAGE \|\| page.offset > 0` guarantees a Prev escape even if a stale page sits past the start. No fight with SF-1: the clamp mutates only the requested offset; `page.offset` is only ever written together with adopted data. Negative-verified by me (pre-fix code strands the empty view; test fails). |
| SET SF-1 (row opacity dims hint below AA; comment claims otherwise) | SHOULD-FIX | **FIXED** | `.km-settings__sched-row--placeholder { opacity: 0.75 }` deleted from `Settings.css`; dimming now comes solely from the per-control `.km-settings__sched-field:disabled { opacity: 0.55 }` rule (`Settings.css:79-82`) + the "Coming soon" badge; label/hint keep full-contrast tokens. The replacement comment (`Settings.css:53-59`) accurately describes what the code does, including why the class stays in the TSX (semantic hook — confirmed present at `Settings.tsx:2233`). The no-test rationale is legitimate: happy-dom does not compute styles from external sheets. Verified by inspection as the fix-pass requested. |
| SET SF-2 (six orphaned rule blocks in shared index.css) | SHOULD-FIX | **FIXED** | All six blocks deleted (`__channels`, `__chanchip`/`--active`/`--disabled`, `__toggle-row`/`--last`) plus the four dead `.km-today__queue*` rules, each replaced by a short tombstone comment; the theme-mode comment that referenced the deleted chanchip language was reworded (justified, not creep). My own grep confirms zero remaining TSX/TS consumers for every deleted class, and the kept `__toggle-meta/label/hint` rules have live consumers (`Settings.tsx:2236-2238`). `Today.css`'s header comment updated to match reality. `.km-progress__trendKr` correctly left (pre-existing orphan, ticketed — but see New Findings N-1). |
| CONS-1 (Today hand-rolls the eyebrow) | CONSISTENCY | **FIXED** | Both section eyebrows now `<Eyebrow style={{ marginBottom: 10 }}>` (`Today.tsx:430,463`). `Eyebrow` spreads `...rest` onto the same `km-eyebrow` div, so the rendered DOM is identical — zero visual/behavioral risk. |
| CONS-2 (BEM element-casing drift) | CONSISTENCY | **DEFERRED-WITH-DOC** | Legitimate: a cross-page mechanical rename is high-churn/low-value inside a fix-pass and was explicitly sanctioned for deferral. Ticket text exists in FIX_REPORT.md — but see N-1: it has not been filed in the tracker. |

---

## Bar checklist post-fix

| Bar item | Status | Notes |
|---|---|---|
| WCAG AA — contrast | PASS | The one open miss (Settings SF-1 hint text) is closed at the source: no row-level opacity; hint keeps `--paper-mute` at full alpha |
| WCAG AA — keyboard | PASS | Today SF-1 closed with the correct pattern (soft-disable + handler guard + focus retention); no new keyboard traps introduced |
| Correct ARIA | PASS | Progressbar values now always within [min,max]; degenerate valuemax=0 correctly drops semantics instead of lying; `aria-disabled` correctly removed (`\|\| undefined`) when idle |
| Strict TS at I/O boundary | PASS | `encounteredBarAria` fully typed with a discriminated return; `LoadedMasteryPage` shape change compile-checked through every consumer; no `any` anywhere in the diff |
| No swallowed errors / working retry | PASS | Keep-stale path preserved and now labeled honestly; SF-4 clamp runs only on success; Retry wiring now proven by test, not assumed |
| Tests exercise real behavior | PASS | Every code fix ships a fails-on-unfixed test; I independently reproduced the negative runs for Hanja (2 fail) and Progress (4 fail) — counts and failing tests match FIX_REPORT exactly |
| Co-located CSS | PASS | Busy paint lives in `WritingTopicGenerator.css`; `index.css` touched only for the sanctioned deletions |
| No scope creep | PASS | Hanja.tsx and index.css were explicitly authorized cross-scope touches (REVIEW_progress SF-2 / REVIEW_settings SF-2); nothing else outside the three review scopes changed; Settings.tsx and all primitives untouched |
| No dead CSS | PASS | Deletions verified consumer-free; keeps verified consumer-ful; one documented pre-existing orphan (`trendKr`) deliberately out of scope |
| No console.log / ticket-less TODO | PASS | Grep clean across all touched files |

---

## PRAISE preservation (all 19 items spot-checked; none undone)

- **Today P-1 (abort/supersede lifecycle):** intact — `AbortController` ref, supersede-on-regenerate, abort-on-unmount, double `ctrl.signal.aborted` guards all present (`WritingTopicGenerator.tsx:83-110`); the fix touched only the button attributes and comments.
- **Today P-3 (honest-null attempt mock):** intact (`Today.tsx:149-158`), both direction tests still present.
- **Today P-4 / B-019:** comment + `/learn/listen` target untouched (`Today.tsx:294-298`).
- **Progress P-4 (keep-stale + its test):** behavior preserved — the SF-1 refactor keeps `page` untouched on failure; the original keep-stale test still present (`Progress.test.tsx:925`) alongside the new regression test.
- **Settings P-1–P-6 (schedule-sync no-clobber, dirty-set, wire fidelity):** `Settings.tsx` is not in the fix-pass commit at all — structurally impossible to have regressed.
- **Primitives:** SwipeCarousel/Tabs/ShowMore/usePagination absent from the commit stat — untouched.

---

## New findings introduced by the fix-pass

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT

**N-1 — The five "Tickets to file" in FIX_REPORT.md are not filed.** `gh issue list --state open` returns zero issues. Both deferrals (CONS-2 BEM casing; `.km-progress__trendKr` dead-rule sweep) plus the nav.ts stale comment, grammar-mastery route, and F-075 follow-up currently exist only as prose in the report. The deferrals themselves are legitimate; their tracking is not yet real. File them (or fold into the existing backlog doc) before or at merge so the deferral record doesn't rot — this was exactly the failure mode the original N-5 (Today) warned about.

**N-2 — `goToOffset` collapses the expanded window immediately on click, including on a hop that then fails.** A user who expanded to 30 items and hits a failing Next lands back on a 15-item window of the stale page. This is consistent (the range text says "1–15 of 50" and matches what is shown) and arguably correct — but it silently discards the user's Show-more state on a failure they didn't cause. Cosmetic; noting for the record.

**N-3 — `targetL4 === 0` leaves a visible empty track for sighted users.** The `aria-hidden` branch removes the bar from AT while the zero-width-fill track still renders visually. Defensible (the eyebrow states the counts; the track reads as "empty"), and documented in the helper's comment — awareness only.

### PRAISE

**P-1 — The independent negative verification reproduces.** The claimed "fails on un-fixed code" runs are real: restoring the pre-fix `Hanja.tsx` and `Progress.tsx` produces exactly the claimed 2 and 4 failures, in exactly the new tests, for the defect-specific assertions (valuenow clamp, range-text honesty, stranded-view escape). This is the strongest possible signal that the regression guards guard the right thing.

**P-2 — The SF-1 refactor is structurally desync-proof, not patched.** Storing the fetched-at offset inside the same state object as the data — written in one `setPage` call — makes it impossible for range text, button states, and navigation to disagree with what is rendered. Navigation anchored to `shownOffset` plus the nonce-forced refetch elegantly kills the compounding-offset bug as a side effect.

**P-3 — `encounteredBarAria`'s discriminated return type** (`ProgressProps | HiddenProps`) makes the degenerate branch impossible to misuse at compile time, and the doc comment teaches both boundary conditions with the server-side reason. Textbook extraction.

**P-4 — FIX_REPORT.md is honest.** The one test that passes on old code (SF-3 gap fill) is disclosed rather than padded into the failure count; the happy-dom focus-emulation limitation is stated instead of hidden behind a green `toHaveFocus()`.

---

## Detailed findings for non-FIXED rows

**CONS-2 (DEFERRED-WITH-DOC):** The casing drift (Settings kebab-case, Today camelCase, Progress mixed) is untouched, as sanctioned. The deferral rationale (mechanical rename PR, high churn) is sound and the original review itself recommended "a convention note", not an in-pass rename. Condition: becomes a filed ticket per N-1.

---

## Recommendation

**Ready to ship.** No new blockers; no another-fix-pass trigger. Two follow-ups to execute at/before merge:

1. File the five tickets from FIX_REPORT.md's "Tickets to file" list (N-1) — none exist in the tracker today.
2. Optional polish (no gate): N-2 (preserve Show-more state across a failed hop) can ride any future Progress touch.
