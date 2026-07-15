# RE-REVIEW — post-beta polish fix-pass (feat/post-beta-polish @ 516d960)

Independent re-reviewer. Did not write the original code, did not perform
either original review, did not perform the fix-pass. Verified the
`FIX_REPORT_polish.md` claims against actual code/tests, not the report's
prose. `git diff 77e076d 516d960 --stat` confirms the fix-pass touched
exactly 4 non-doc files: `Today.tsx`, `Today.css`, `Today.test.tsx`,
`ThemeProvider.test.tsx` (plus 3 new docs) — no other source file changed,
so no other ticket's surface area could have regressed.

## Verdict: PASS

Both findings are genuinely fixed, and I confirmed both new tests are real
guards — not cosmetic — by temporarily breaking each half of each fix
in-place, re-running the specific test, watching it fail with the expected
diff, then restoring the file and confirming its checksum matched the
original byte-for-byte. No regression, no walked-back praise item.

## Finding-by-finding

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | BLOCKER — Today lost 14px hub-header gap | **FIXED** | `Today.tsx:711` now passes `className="km-today__hub"` to `PageHubHeader`, which forwards it via `cn(...)` onto the `.km-hubheader` root (`PageHubHeader.tsx`'s `className` prop, confirmed in source) — same mechanism Progress.tsx already used. `Today.css:31-33` adds `.km-today__hub .km-hubheader__title { margin-bottom: 14px; }`, structurally identical to `Progress.css:43-49`'s `.km-progress__hub .km-hubheader__title { margin-bottom: 14px; }` (only the page-scope class name differs, as expected). `PageHubHeader.css`'s own base rule (`margin: 4px 0 0`) is untouched, so the 7 Library pages that never had the extra 14px are unaffected. |
| 2 | SHOULD-FIX — theme boundary dual-copy sync | **FIXED** | New test in `ThemeProvider.test.tsx:333-342` reads `client/index.html` via `readFileSync`, applies `/hour >= (\d+) && hour < (\d+)/` against the live source, and asserts both captured numbers equal `AUTO_DAY_START_HOUR`/`AUTO_DAY_END_HOUR` imported from `theme-context.ts`. `index.html` contains exactly one `hour >=`/`hour <` occurrence (grepped), so the regex is unambiguous, not loose. |

## Regression-proof (not just re-reading source)

For finding 1, I edited the live files, ran the specific test, observed the failure, then restored and re-verified via `md5sum`:

- Removed `className="km-today__hub"` from `Today.tsx` → test failed:
  `expect(hub).toHaveClass('km-today__hub')` — received `km-hubheader` only.
  This proves the test pins the **DOM half** and would catch a regression
  there.
- Restored `Today.tsx` (md5 `ff1f81fab...` matches pre-edit), then changed
  `Today.css`'s override from `margin-bottom: 14px` to `margin-bottom: 4px`
  → test failed: `expected '...' to contain 'margin-bottom: 14px;'`,
  diff showed `4px` received. Proves the test pins the **CSS half**
  independently of the DOM half — a fix-pass that restored the className
  but silently changed/dropped the margin value would still be caught.
- Restored `Today.css` (md5 `048df808...` matches pre-edit).

For finding 2, same procedure on `index.html`:

- Changed the bootstrap script's literal boundary from `hour >= 6 && hour <
  18` to `hour >= 7 && hour < 19` (simulating someone drifting the inline
  script without touching the TS constants) → test failed:
  `expected 7 to be 6`. This is the exact drift scenario SHOULD-FIX-1
  worried about, and it is caught.
- Restored `index.html` (md5 `78eae3489...` matches pre-edit).

Repo state after all of the above: `git status --short` shows only a
pre-existing, unrelated uncommitted change to `BUGS_AND_FEATURES.md` (dated
before this review started, not touched by me) and untracked
`.claude/`/`REDESIGN_SEOUL_NEON_BRIEF.md` — nothing from my verification
edits survived, all mutated files matched their original checksums before I
moved on.

## No visual regression elsewhere on Today

`git diff 77e076d 516d960 -- client/src/pages/Today.tsx client/src/pages/Today.css`
is a 3-line functional diff (one `className` prop line) + one new CSS rule +
comment updates — no other hunk touches carousel markup, section spacing,
or any other selector. The new `Today.test.tsx` F-177 test
(`Today.test.tsx:499-526`) additionally re-confirms the shared component's
skyline/rail-divider classes render, the old page-local classes
(`.km-today__skyline`, `.km-today__rail-divider`) are gone, and the
`<h1>`/`aria-labelledby` wiring is unchanged — all still true.

## Praised items — none walked back

Confirmed via `git diff --stat 77e076d 516d960`: `WordPopover.tsx`,
`Sheet.tsx`, `useModalA11y.ts`, `LineChart.tsx`, `LineChart.css`,
`Hanja.tsx`, `Hanja.css` are **not present** in the fix-pass diff at all —
zero hunks. F-186 (WordPopover→Sheet), F-174 (default-off byte-identical
trend line), F-132 (injectable-clock tests) are structurally untouched by
this fix-pass; nothing to regress.

## New findings

None. No new BLOCKER/SHOULD-FIX surfaced. Two minor observations, neither
blocking:

- **Asymmetry note (informational only):** `Progress.test.tsx`'s F-177
  describe block (`Progress.test.tsx:331-368`) does not have an equivalent
  "DOM class + CSS margin-bottom" pinning test the way `Today.test.tsx` now
  does — Progress's own 14px override is currently unpinned by a dedicated
  test (it was true before this fix-pass too; the fix-pass only added
  coverage to Today, matching its narrower scope). Not a regression and not
  in scope for this fix-pass, but worth a follow-up ticket so Progress gets
  the same regression guard Today just got, for symmetry.
- Fix-pass correctly scoped itself to exactly the 2 items in scope and made
  no speculative changes to `PageHubHeader.tsx`/`.css`, matching both
  original reviewers' explicit coordination notes that the shared
  component's default should stay untouched.

## Gate re-run (from `client/`, fresh numbers)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 0 warnings |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | 0 errors |
| `npx vitest run` | **115 test files passed / 1872 tests passed** (0 failed) |
| `npx vite build --outDir /tmp/km-rereview-pb` | exit 0 (311 modules transformed; pre-existing >500kB chunk-size advisory only, not an error) |

Numbers match `FIX_REPORT_polish.md`'s claimed gate results exactly.

## Bar checklist

- [x] Both findings independently re-verified against real code, not the report's prose.
- [x] Both new tests proven to actually fail on regression (live break/restore, not just read).
- [x] Diff scope confirmed minimal (4 non-doc files) — no collateral changes.
- [x] No praised item's underlying files touched by the fix-pass.
- [x] Full gate re-run from a clean re-reviewer session; numbers match the fix report.
- [x] All temporary verification edits reverted; checksums confirmed identical to pre-edit state.

## Recommendation

**Ready to ship.** Both the BLOCKER and the SHOULD-FIX are genuinely fixed
with real regression coverage, the fix-pass's diff footprint is exactly as
narrow as claimed, gate numbers reproduce cleanly, and nothing else in the
batch (F-132/174/178/180/181/182/186) shows any sign of being touched or
weakened. Only optional follow-up: file a low-priority ticket to add the
same DOM+CSS pinning test to `Progress.test.tsx` for symmetry with what
`Today.test.tsx` now has — not a blocker.
