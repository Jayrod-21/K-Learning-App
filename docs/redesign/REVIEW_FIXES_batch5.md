# Re-Review — Batch 5 Fix-Pass Verification

**Re-reviewer:** independent senior review (fresh — did not write the code, the three original reviews, or the fix-pass)
**Branch:** `feat/redesign-cleanup` @ `6c6749e` (fix-pass), on `9243489` (batch), off `rebuild`
**Method:** read all three original reviews + `FIX_REPORT_batch5.md` + `DESIGN_SEOUL_DAY_NIGHT.md`; then independently re-derived every claim against the actual code (not the report's prose) via direct file reads and targeted greps; then re-ran the full gate from `client/` myself.

## Verdict: **PASS**

All four SHOULD-FIX findings from the three batch-5 reviews are genuinely fixed, with no regressions and nothing previously praised undone. My independently-run gate matches the fix report's claimed numbers exactly. Ready to PR into `rebuild`.

---

## Finding-by-finding table

| # | Finding | Source | Status | Test catches bug? | Notes |
|---|---|---|---|---|---|
| 1 | `SubwayProgress` 50-dot mobile overflow | fidelity S1 | **FIXED** | Yes | `DOT_RENDER_CAP = 24` at `SubwayProgress.tsx:51`; condensed path drops only the station-dot render, ARIA/fill math untouched. 3 new tests (`SubwayProgress.test.tsx:165-190`) cover boundary (24, dots present), one-past (25, condensed), and the real 50-item mock case with exact `fillPct` assertion. |
| 2a | MockMode `ResumeBanner` hardcoded `rgba()` border | mock-images M-1 | **FIXED** | Indirectly (grep-verifiable, no dedicated unit test for the literal string, acceptable for a style-only token swap) | `MockMode.tsx:1345` now `border: '1px solid var(--line)'`. Repo-wide grep for `rgba(`/hex in `MockMode.tsx`/`.css` → zero hits outside the explanatory comment. |
| 2b | MockMode submit-confirm dialog not reskinned | mock-images M-1 | **FIXED** | Yes | `MockMode.tsx:1873-1906`: outer `<div ref={confirmRef} role="alertdialog" aria-label="Confirm submit">` (the `useModalA11y`-wired focus-trap container) is **unchanged**; only the inner `Card` was swapped for `<CityCard tone={sectionTone(test.section)} rail>`. `MockMode.test.tsx:548` (`getByRole('alertdialog')`) still passes. |
| 2c | MockMode duplicate `.km-rain-sheen` | mock-images M-2 | **FIXED** | Yes | `MockMode.tsx:647-654` root no longer carries `km-rain-sheen` (comment explains why); `Topik.tsx:264`/`:526` remains the sole applier. New regression test `MockMode.test.tsx:1607-1609` asserts absence on `.km-mock`. Exactly one instance applies now — confirmed by grep, only one file (`Topik.tsx`) sets the class. |
| 3 | Delete dead `Topbar.tsx`/`.test.tsx`/CSS | mock-images coord #2, fidelity capstone | **FIXED** | N/A (deletion) | `components/Topbar.tsx` and `Topbar.test.tsx` are gone from disk. Full repo grep for `import.*Topbar`, `from '.*Topbar'`, and `<Topbar` → **zero hits anywhere**. All remaining `Topbar` string matches (~50 hits) are doc-comments/test-descriptions referencing the historical flat header, not code. `.km-topbar` class in `index.css` → zero rule definitions remain, one surviving hit is itself a comment (`index.css:532`, describing a font choice, not a selector). |
| 4 | Surgical dead-CSS cleanup | diagnostic S1, fidelity N1 | **FIXED** | N/A (CSS-only) | Independently grepped every selector named in the fix report as removed (`.km-diagnostic__display`, exact `.km-diagnostic__progress`/`-fill`, `.km-diagnostic__results-title`, `.km-diagnostic__goals*`, `.km-mock__section` bare + `:hover`/`--disabled`) — **all confirmed absent**. Independently grepped every selector claimed preserved (`.km-diagnostic__progress-label`, `.km-mock__sections`, `.km-mock__section-en/-kr/-go/-soon`, and the non-named-but-adjacent `-results-sub`/`-skills-card`/`-skills-title`) — **all present in `index.css` AND referenced by a live `.tsx` file**. No live rule was collaterally removed. |

**Counts: 4 FIXED, 0 PARTIAL, 0 NOT-FIXED, 0 REGRESSION.**

---

## SubwayProgress ARIA + small-N identical — dedicated verification

Read `SubwayProgress.tsx` in full (`client/src/components/SubwayProgress.tsx:53-100`). The `condensed = total > DOT_RENDER_CAP` boolean gates **only** the `<div className="km-subway__stations">` JSX block (line 84-96). Everything above it — `role="progressbar"`, `aria-label`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-valuetext`, and the `km-subway__fill` width — is computed identically regardless of `condensed` and lives outside the conditional. This means:

- **Small-N (≤24) identical claim: CONFIRMED.** For any `steps ≤ 24` the render path is byte-identical to pre-fix (the `condensed` branch is `false`, dots render exactly as before). Verified by test `SubwayProgress.test.tsx:178-183` (steps=24, boundary, dots present) plus the seven pre-existing tests (steps 3-8) that were unmodified by the diff and still pass. Consumers at Diagnostic (16), Progress (small attempt counts), Topik study drill (small draws), Hanja draw drill (≤20), and Review (deck length, normally small) are all comfortably at/under 24 and thus unaffected.
- **50-item MockMode no-overflow: CONFIRMED.** `steps=50` → `condensed=true` → zero `.km-subway__station` elements render (test `SubwayProgress.test.tsx:165-176`), leaving only the fill line — matches the design doc's own documented "plain bars fill with the accent" fallback (§6).
- **ARIA unchanged across both paths: CONFIRMED.** Test at line 170-172 asserts `aria-valuemax=50`/`aria-valuenow=25` in the condensed case using the identical attribute names/derivation as the non-condensed tests — a screen-reader user gets the same value information either way, only the decorative (`aria-hidden`) dot visualization is affected.
- **Consumer sweep:** grepped all 7 real call sites (`Diagnostic.tsx:770`, `Review.tsx:1718`, `Topik.tsx:958`, `Hanja.tsx:1450`, `Hanja.tsx:2694`, `MockMode.tsx:1772`, `Progress.tsx:842`) — matches the fix report's consumer table (one line-number drift: report says `MockMode.tsx:1759`, actual is `1772`, immaterial — same call site, no behavior difference). None regressed; full suite confirms.

## Topbar fully gone — dedicated verification

Independently ran (not trusting the report's own grep output):
```
grep -rn "import.*Topbar\|from '.*Topbar'" client/src   -> 0 hits
grep -rn "<Topbar" client/src                            -> 0 hits
ls client/src/components/Topbar.tsx client/src/components/Topbar.test.tsx  -> both "No such file"
grep -n "km-topbar" client/src/styles/index.css          -> 1 hit, a doc-comment (line 532), not a CSS rule
```
**Confirmed: Topbar is completely gone** — component, test, and CSS rules. All ~50 remaining textual mentions of "Topbar" repo-wide are historical documentation/test-name references to the flat header this redesign replaced, not dangling code.

## Praise-intact check

- **F-143 removal still intact.** `Diagnostic.tsx` has no `useNavigate`/`navigate(` calls, no "Begin today's plan" or goals-card JSX — only the explanatory removal comments (lines 56, 1162) mention the old strings. Not re-added.
- **MockMode exam flow untouched.** Timer/palette/submit/scoring code paths were not touched by this fix-pass diff — only `ResumeBanner`'s inline style, the confirm dialog's inner surface, and the root class list changed, exactly as scoped.
- **Diagnostic scoring untouched** — no changes to `Diagnostic.tsx` in this fix-pass commit beyond what was already reviewed pre-fix-pass (this batch's diff only touched `SubwayProgress.tsx/.test.tsx`, `MockMode.tsx/.test.tsx`, `Topbar.*` deletion, and `index.css`).
- No new regressions found in any of the above.

## New findings

None. One immaterial documentation drift noted above (fix report cites `MockMode.tsx:1759` for the `SubwayProgress` call site; actual current line is `1772` — cosmetic, not a code issue).

## Independently-run gate (from `client/`)

| Check | Result |
|---|---|
| `npm run lint` | **0 errors, 0 warnings** (clean output) |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** (clean output) |
| `npx vitest run` | **115 test files passed, 1760 tests passed**, 0 failed |
| `npx vite build --outDir /tmp/km-rr-batch5-v2` | **exit 0** — built in 587ms, PWA precache 15 entries; pre-existing >500kB main-chunk warning, unrelated to this change |

All four numbers match the fix report's claims exactly.

## Recommendation

**Ready to PR into `rebuild`.** All four SHOULD-FIX findings across the three original reviews are genuinely closed, verified against code (not the self-report), with no regressions and no undone praise. The one deferred item (`WordPopover` → `Sheet` promotion) was correctly left out of scope per all three reviews' own ruling and is filed as a follow-up, not a gap in this batch.
