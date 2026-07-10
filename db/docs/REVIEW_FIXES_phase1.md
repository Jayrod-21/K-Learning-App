# RE-REVIEW — Phase 1 UI primitives fix-pass verification

Branch `feat/phase1-ui-primitives`, 2026-07-09. Independent re-review of the fix-pass
(`FIX_REPORT_phase1.md`) against the three original reviews (`REVIEW_phase1_nav.md`,
`REVIEW_phase1_textsize.md`, `REVIEW_phase1_formlist.md`). Fresh eyes; no code modified.
Every claim below was verified against the actual working tree and by re-running gates —
nothing was taken from the fix report on trust.

## Summary verdict: **PASS**

All 8 SHOULD-FIXes across the three reviews are genuinely fixed in code, not just claimed.
The 12 new tests are honest — I independently repeated the stash-and-rerun (fixes out,
tests in) and got **12 failed / 22 passed** on the original code, exactly matching the
report; the working tree was restored byte-identical (md5-verified). Gates re-run clean:
typecheck 0 + 0, lint 0, primitives 100/100, Settings + TextSizeProvider 45/45. The
working-tree diff vs HEAD touches exactly the 16 files in fix scope — no SwipeCarousel
source, no CollapsibleTile.tsx logic, no praised mechanism altered, no scope creep. Every
numeric claim in the fix report (mint 2.99:1, coral 3.01:1, mint-ink 5.20:1, deepened ring
3.58:1) reproduced under my own WCAG luminance computation (2.994 / 3.011 / 5.204 / 3.582).

## Gates (re-run, real counts)

| Gate | Result |
|---|---|
| `npx tsc -p tsconfig.app.json --noEmit` | **0 errors** (exit 0) |
| `npx tsc -p tsconfig.node.json --noEmit` | **0 errors** (exit 0) |
| `npm run lint` | **0 errors, 0 warnings** (exit 0) |
| Touched primitives (`Tabs BackButton ShowMore CollapsibleTile FilterSelect SwipeCarousel usePagination tokensContrast`) | **8 files, 100/100 passed** (971ms) |
| `Settings` + `TextSizeProvider` | **2 files, 45/45 passed** (4.95s) |
| Honesty check (stash `Tabs.tsx`/`BackButton.tsx`/`usePagination.ts`, rerun 3 suites) | **12 failed / 22 passed** on original code — matches report; tree restored, md5 OK |

## Finding-by-finding verification

| Finding | Source | Orig severity | Fix status | Notes |
|---|---|---|---|---|
| SF-1 Tabs dangling `aria-controls` | nav | SHOULD-FIX | **FIXED** | `Tabs.tsx:143` — conditional `aria-controls={tab.id === activeId ? panelId(tab.id) : undefined}`; matches APG (attribute optional on tabs; only rendered panel referenced). Header doc updated (`Tabs.tsx:25-28`). Tests at `Tabs.test.tsx:59` and `:75` assert absence on inactive tabs AND that the one present resolves to the real panel element — provably fail on old code (old code set it on every tab). |
| SF-2 Tabs.css false contrast claim | nav | SHOULD-FIX | **FIXED** (comment corrected) | `Tabs.css:8-16` now states the truth: `--paper` text promotion is the primary indicator, underline secondary with no automated guarantee, citing light+mint 2.99:1. The reviewer offered "add assertion OR correct comment"; the fix-pass measured first and found the assertion would fail today (I confirmed: 2.994:1) — correcting the comment is the right call inside a fix-pass. See mint ruling below. |
| SF-3 BackButton can exit the PWA | nav | SHOULD-FIX | **FIXED** | `BackButton.tsx:63-77` — `location.key !== 'default'` gates `navigate(-1)`; else routes to new `fallbackTo` (default `/`). The `"default"` sentinel verified in installed react-router 7.18.1 dist (`chunk-KS7C4IRE.mjs:44` memory, `:144` browser) — same code path in prod and tests, unlike the `history.state.idx` alternative (data-router-only). Tests use real MemoryRouter + `useLocation` probe with exact `textContent` equality (correctly avoiding `toHaveTextContent`'s substring match, where `"/"` would pass on the buggy no-op). Both fail on old code — reproduced. |
| N-1 arrows relative to selection | nav | NIT | **FIXED** | `Tabs.tsx:101-118` — keydown takes `from` (the event tab's index, passed at `:148-150`). New controlled-reject test (`Tabs.test.tsx:229-254`) genuinely distinguishes focus from selection; fails on old code. |
| N-2 stale controlled id → degraded ARIA | nav | NIT | **DEFERRED-WITH-DOC** | Sound: snapping would render a panel the controlled parent didn't ask for — a behavior change in a caller-error-only path, not a fix-pass edit. |
| N-3 CollapsibleTile collapse class untested | nav | NIT | **DEFERRED-WITH-DOC** | `CollapsibleTile.test.tsx` wasn't otherwise open; consistent with the brief's NIT scope rule. One-line `toHaveClass` on next touch — carry forward. |
| N-4 BackButton `to` as button vs Link | nav | NIT | **REJECTED** | The reviewer themselves recorded it as preference, not defect. Sound. |
| N-5 loop-damping branch untested | nav | NIT | **DEFERRED-WITH-DOC** | Requires a mid-drag transform assertion in a file not otherwise edited. Sound. |
| S1 px→rem efficacy gap undocumented | textsize | SHOULD-FIX | **FIXED** (all 3 required follow-ups) | (a) **F-086 verified filed** at `BUGS_AND_FEATURES.md:1110-1113` — P2, CONFIG (UI), correct cross-refs both ways (F-086 names F-025 + the five rem-migrated primitives + the limitation-note locations; F-025's Notes at `:710` names F-086 and records the unshipped smaller-default half). (b) Known-limitation notes present at `text-size-presets.ts:17-22` and `index.css:259-263` (verified the index.css diff is comment-only). (c) Copy fixed per S2. Deferring the 256-declaration app-wide migration to F-086 is the correct scope call. |
| S2 over-promising copy | textsize | SHOULD-FIX | **FIXED** | `Settings.tsx:1839-1840` — "Scales the base text size. More of the app follows it as screens are updated." — honest. `index.css` comment no longer claims Tailwind utilities/rem paddings; names the px-pinned limitation + F-086. Settings suite green (no test pinned the old copy). |
| N1 Reset-to-defaults asymmetry | textsize | NIT | **DEFERRED-WITH-DOC** | Pre-existing, shared with accent/theme; reviewer's own note says fix all three at once. Sound. |
| N2 server-wins discards hydration-window pick | textsize | NIT | **REJECTED** | Tested and intentional per the original review. Sound. |
| SF-1 usePagination ↔ ShowMore `remaining` gap | formlist | SHOULD-FIX | **FIXED** | `usePagination.ts:77` — `remaining = Math.min(step, limit - visibleCount)`; exported at `:87` with a doc-comment forbidding the naive derivation (`:36-43`), mirrored in `ShowMore.tsx:26-33`. Boundary math verified by hand: 50/cap-30 → 15 (not 35), then 0; step-overshoots-cap → 10; list-end 18 → 3 then 0; never negative (`visibleCount ≤ limit`); `remaining = 0 ⟺ canShowMore = false`, so the label can never show a count on a button that reveals nothing. The deliberate divergence from the reviewer's `limit - visibleCount` (total-reachable) to next-batch semantics is an improvement — the label promises exactly what one click reveals — and is documented. Tests fail on old code (property didn't exist). |
| SF-2 missing boundary tests | formlist | SHOULD-FIX | **FIXED** | `usePagination.test.ts:160-199` — exactly-15, exactly-30 (incl. showMore to the coinciding cap/list-end), 14, and empty, each also pinning `remaining`. All four boundaries the reviewer named are covered. |
| SF-3 px font-sizes in new stylesheets | formlist | SHOULD-FIX | **FIXED** | All six declarations converted, each with a `/* Npx @ md root */` comment: `Tabs.css:31`, `BackButton.css:24`, `CollapsibleTile.css:26`, `FilterSelect.css:22` + `:41`, `ShowMore.css:15`. Verified rem values are exact ÷16 (0.8125 / 0.875 / 0.6875 / 0.84375) — identical rendered size at md, so no layout regression. Diffs confirm font-size lines are the ONLY property changes in those files. `SwipeCarousel.css` has zero font-size declarations (grep-verified). |
| N-1 ShowMore reduced-motion guard | formlist | NIT | **FIXED** | `ShowMore.css:30-36` — matches the other five stylesheets. |
| N-2 readonly-props inconsistency | formlist | NIT | **FIXED** | `Tabs.tsx:52` — `ReadonlyArray<TabItem>`; widening, no consumer break; typecheck clean. |
| N-3 FilterSelect duplicate values | formlist | NIT | **DEFERRED-WITH-DOC** | `FilterSelect.tsx` not otherwise edited (CSS only). Consistent with the stated scope rule; carry forward. |
| N-4 disabled dims only the control | formlist | NIT | **DEFERRED-WITH-DOC** | Genuinely a design question, not a mechanical fix. Sound. |
| N-5 `--vermilion-ink` on bare surfaces untested | formlist | NIT | **DEFERRED-WITH-DOC** | Fix report's manual measurement spot-verified (mint-ink light 5.204:1 vs my computation — AA-clear), so nothing latent is failing today. Coverage gap remains — see follow-up recommendation. |
| N-6 SwipeCarousel pre-existing divergences | formlist | NIT | **REJECTED** | Reviewer said "fine to leave"; pre-existing, outside branch diff. Sound. |
| PRAISE items (nav P-1…P-4, textsize P1…P4, formlist P-1…P-6) | all | PRAISE | **PRESERVED** | Verified by diff: SwipeCarousel source untouched; CollapsibleTile grid-collapse CSS untouched (font-size line only); controlled-mode Tabs test intact and passing; reduced-motion blocks extended, never removed; prefs-sync machinery untouched (`Settings.tsx` diff is the 6-line hint copy only); no new colors introduced by the rem conversions. |

**Tally: 8/8 SHOULD-FIX FIXED · 4 NITs FIXED · 6 DEFERRED-WITH-DOC · 3 REJECTED (all sound) · 0 NOT-FIXED · 0 REGRESSION.**

## Ruling on the newly-surfaced mint-contrast finding (2.99:1 vs `--ink`, light theme)

**Documenting-only is acceptable here; no block, no mandatory ticket — but filing one is
recommended.** Reasoning:

1. **It predates Phase 1.** The 2.99:1 figure appears verbatim in `rebuild`'s own
   `index.css` mint block (`git show rebuild:… | grep 2.99` hits line 234): the base
   design already knew, and already remediated the one hard-requirement surface —
   `--focus-ring` is deepened to `#0D8F6F` (3.58:1, my computation) for exactly this
   reason. The fix-pass discovered nothing new about the tokens; it discovered the Tabs
   comment lied about them.
2. **Conformance holds without the underline.** WCAG 1.4.11 requires 3:1 for visual
   information *required* to identify state. The corrected `Tabs.css` comment makes the
   text promotion to `--paper` the primary selected indicator; the underline is a
   redundant secondary cue, and redundant cues are exempt. The fix ensured the design's
   conformance story is now written down rather than contradicted.
3. **The margin is systemic, not mint-specific.** Light coral is 3.011:1 — one token
   tweak from the same failure. That is a token-design question (re-tune light accents,
   or extend `tokensContrast.test.ts` with an accent-as-indicator assertion plus a
   documented exemption list) that a fix-pass has no mandate to decide. Forcing an
   assertion in this pass would have shipped a red suite or a rushed palette change.
4. **Scope reality:** single-user personal app, no consumer mounts Tabs yet, and the gap
   is invisible in the default (coral-just-passes / dark-theme 11.6:1) configurations.

The residue worth capturing: this gap plus formlist N-5's coverage hole both concern
"accent tokens used as indicators on bare surfaces have no automated contrast guard."
Today that knowledge lives in CSS comments and the fix report. **Recommend filing one
small follow-up ticket** (accent non-text/ink-twin contrast coverage in
`tokensContrast.test.ts`, with either a light-mint re-tune — the focus-ring's `#0D8F6F`
at 3.58:1 shows the shape of the fix — or an explicit exemption note). Cheap insurance
before the overhaul mounts Tabs in LibrarySubnav/Chat.

## New findings introduced by the fix-pass

- **PRAISE — BackButton guard mechanism choice.** `location.key === 'default'` over
  `window.history.state?.idx` is the better engineering call, and the fix report's
  rationale is verifiably true: the sentinel is set by the same react-router history
  layer in both browser and memory histories (confirmed in the installed 7.18.1 dist),
  so the tests exercise the identical code path production will run — no mock, no
  environment fork.
- **PRAISE — test assertion hygiene.** The exact-`textContent` assertions in
  `BackButton.test.tsx:91,103` (with comments explaining why `toHaveTextContent`'s
  substring match would false-pass on the buggy outcome) show the tests were written to
  fail on the bug, not to pass on the fix.
- **NIT — deferred NITs live only in the fix report.** Nav N-3/N-5 and formlist N-3
  (all one-to-few-line test/doc additions) are deferred to "next touch" of their files,
  but nothing in the repo's tracked backlog carries them. Acceptable for NITs in this
  repo's fixpass convention (the report persists in `db/docs/`), noted so they aren't
  lost when those files are next opened.
- No BLOCKERs, no SHOULD-FIXes, no regressions introduced. Working-tree diff vs HEAD is
  exactly the 16 in-scope files; `BUGS_AND_FEATURES.md` diff is the F-086 block + the
  F-025 Notes line, nothing else.

## Recommendation

**Ready to ship.** Commit the fix-pass as-is on `feat/phase1-ui-primitives`; no further
fix-pass round is needed. Follow-ups to file/carry (none blocking):

1. *(Recommended ticket)* Accent-as-indicator contrast coverage in
   `tokensContrast.test.ts` + decide light-mint (2.99:1) / light-coral (3.01:1)
   margins — covers the mint ruling above and formlist N-5 in one change.
2. *(Already filed)* F-086 app-wide px→rem migration — verified present with correct
   cross-refs; nothing more needed.
3. *(On next touch of their files)* nav N-3 (`toHaveClass` in CollapsibleTile test),
   nav N-5 (loop-damping mid-drag assertion), formlist N-3 (FilterSelect unique-values
   JSDoc).
