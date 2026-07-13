# Fix-pass report — Seoul Day/Night foundation

Branch `feat/redesign-foundation` @ `c525288`. Scope: every BLOCKER + SHOULD-FIX
from `REVIEW_components.md`, `REVIEW_design-fidelity.md`, `REVIEW_token-arch.md`.
NITs out of scope except where trivially resolved as a side effect of a required
fix (noted below). No page reskins, no `--ink`/`--paper` renames — both reviewers'
PRAISE items were left untouched (see checklist at the end).

## Findings

| ID | Finding | Disposition | file:line touched |
|---|---|---|---|
| B1 | Zero tests for `SubwayProgress` | **FIXED** | `client/src/components/SubwayProgress.test.tsx` (new, 15 tests) — clamping (below 0, above steps−1, non-integer floor), `steps<1` single-station edge, `fillPct` math, done/current/ahead derivation, `role="progressbar"` + `aria-valuemin/max/now`, generated-fallback vs. caller-supplied `aria-valuetext`, dots `aria-hidden`, tone→class, NaN/Infinity guard (SF-C) |
| B2 | Zero tests for the `SealStamp` extension | **FIXED** | `client/src/components/SealStamp.test.tsx` (new, 10 tests) — proves the 8 existing `char`/`size`-only callers render a bare `aria-hidden` badge with no `km-seal-group` wrapper; covers `milestone` class + `印`/explicit-char glyph, `label` sibling-span-outside-aria-hidden, tone→class, and locks the SF-B className fix (both-props case + label-omitted case) |
| B3 | Zero tests for `CityCard` | **FIXED** | `client/src/components/CityCard.test.tsx` (new, 9 tests) — `rail`→`DancheongRail`, `heading`/`feat` render + `kr-display` class, tone→class, `...rest` spread (incl. `data-testid`/`aria-label`), className merge |
| — | `SkylineHeader` coverage gap (components review, SHOULD-FIX severity) | **FIXED** | `client/src/components/SkylineHeader.test.tsx` (new, 5 tests) — `title` renders as a real non-hidden node, svg `aria-hidden`+`focusable="false"`, both `.km-skyline__day`/`.km-skyline__night` `<g>` present unconditionally, className forwarding |
| — | `DancheongRail` coverage gap (components review, SHOULD-FIX severity) | **FIXED** | `client/src/components/DancheongRail.test.tsx` (new, 6 tests) — `aria-hidden`, tone→class default+explicit, `feat` class present/absent, className forwarding |
| SF-A | `CityCard.css:34-38,40,48` hard-coded rgba/px, contradicting the file's own "token-driven only" docstring | **FIXED** | `client/src/components/CityCard.css:33-53` — Night body gradient stops now `color-mix(in srgb, var(--ink-2) 85%, transparent)` / `color-mix(in srgb, var(--ink-1) 90%, transparent)` (keeps the alpha so `--city-gradient` still reads underneath, per the reviewers' explicit fix direction); `plain` border → `var(--line-strong)`; `border-radius: 15px` → `var(--radius-lg)` (removed as a redundant re-declaration — the base rule at line 14 already sets it, and it's now identical in both themes, which also closes N-2's 15px-vs-18px radius mismatch with `.km-card`). Docstring at `CityCard.tsx:24` ("Token-driven only — no hard-coded hex") is now accurate; left unchanged since it needed no correction |
| SF-B | `SealStamp.tsx:72` — `!label && className` dropped the caller's `className` from the badge whenever `label` was also passed | **FIXED** | `client/src/components/SealStamp.tsx:64-90` — `className` now applies to the badge unconditionally; the `label` wrapper keeps only its fixed `km-seal-group` layout class (no `className` passed to it — per the review's own suggested fix direction, since no existing caller relied on the wrapper receiving it). JSDoc on the `className` prop updated to state the new contract. Covered by 2 new tests in B2 |
| SF-C | `SubwayProgress.tsx:49-51` — unguarded `NaN`/`Infinity` input could render `aria-valuenow={NaN}` | **FIXED** | `client/src/components/SubwayProgress.tsx:49-56` — `Number.isFinite` guard falls back `steps`→`1`, `current`→`0` before the existing floor/clamp math runs. Covered by 2 new tests in B1 |
| SF-D | `tokensContrast.test.ts` had no coverage of `--on-vermilion` on the `--km-tone` fills (`blue`/`mint` — Day `dan-cobalt`/`dan-jade`, Night `neon-blue`/`neon-mint`) that `SealStamp`'s milestone variant actually paints text on | **FIXED — all 4 new assertions PASS, no regression needed** | `client/src/styles/tokensContrast.test.ts:138-171` — new `describe` block, 4 new tests (Day cobalt/jade, Night neon-blue/neon-mint). `plain` is explicitly excluded with a code comment: `.km-seal--milestone.km-tone--plain` renders `background: transparent; color: var(--paper)` (index.css:896-901), not a text-on-fill pairing, so there's nothing this check can assert about it. Verified live: Day cobalt/jade and Night neon-blue/neon-mint all clear 4.5:1, matching the design-fidelity reviewer's hand-computed numbers (cobalt 6.49:1, jade 4.93:1, neon-blue 5.22–5.92:1, neon-mint 8.32:1) |
| SF-E | Day Latin `h1`/`h2` rendered in rounded Nunito, not serif — doc §3 "Day = serif-forward" unmet | **FIXED** | `client/src/styles/index.css:455-463` — added `:root[data-theme="light"] h1, :root[data-theme="light"] h2 { font-family: 'Noto Serif', Georgia, serif; }`. `'Noto Serif'` pairs with the app's existing `Noto Serif KR` (`.kr-display`) so both scripts read as one editorial family in Day; Night is untouched (still `--font-display` = Nunito + glow). Re-ran `tokensContrast.test.ts` after the change — 32/32 pass (typography-only change, no color/contrast impact) |
| SF-F | `index.css:259-263` comment undersold why `:not([data-theme])` must not be dropped | **FIXED (comment-only)** | `client/src/styles/index.css:259-274` — added an explicit "DO NOT drop `:not([data-theme])`" paragraph spelling out the exact specificity-tie failure mode a well-intentioned refactor would reintroduce, and pointing at `REVIEW_token-arch.md` for the full 4-case trace. No code/selector change |

## Praise items — confirmed untouched

- All three `@media (prefers-reduced-motion: no-preference)` gates (`SkylineHeader.css:58`, `seoul-devices.css:60`, `seoul-devices.css:163`) — unchanged, still gate by existence not zero-duration.
- `:root:not([data-theme])` structure (`index.css:264-302`, renumbered to `275-313` after the SF-F comment addition) — selector logic byte-identical; only the comment above it grew.
- `--km-tone` centralization (`seoul-devices.css:145-158`) — untouched.
- `SubwayProgress`'s single `role="progressbar"` pattern — untouched (only the NaN guard was added upstream of it).
- `SkylineHeader` rendering both theme `<g>` layers unconditionally — untouched; now also regression-tested (new test file above).
- The deepened hex values (`--paper-mute #6B614D`, `--neon-blue #5C87FF`) — untouched.
- No `--ink`/`--paper` renames, no page reskins — `git diff --stat` confirms only `CityCard.css`, `SealStamp.tsx`, `SubwayProgress.tsx`, `index.css`, `tokensContrast.test.ts`, and 5 new `*.test.tsx` files changed.

## Gate results

Run from `client/`:

- `npm run lint` → **0 problems** (clean `eslint .` output).
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0 errors** (clean output).
- `npx vitest run` → **114 test files passed, 1594 tests passed** (0 failed).
  - Baseline before this fix-pass: 109 files / 1545 tests (per `REVIEW_components.md`'s own count; confirmed exactly by subtraction below).
  - Delta: **+5 test files** (`SubwayProgress.test.tsx` 15, `SealStamp.test.tsx` 10, `CityCard.test.tsx` 9, `SkylineHeader.test.tsx` 5, `DancheongRail.test.tsx` 6 = **45 tests**, independently confirmed by running just these 5 files in isolation: `45 passed (45)`) **+4 tests** added to the existing `tokensContrast.test.ts` (SF-D, 28→32) = **+49 tests total**. `1545 + 49 = 1594` — ties out exactly to the final full-suite count, no unaccounted tests.
- `npx vite build --outDir /tmp/km-fix-dist` → **fails**, but **not a regression**: reproduced the identical `CssSyntaxError: Missing opening (` from the `@tailwindcss/vite` plugin by `git stash`-ing every change in this fix-pass and re-running the build against the untouched `c525288` baseline — same failure, same file (`src/styles/index.css`), same error. This is a pre-existing build-tooling issue independent of this diff (distinct from, but in the same "known environmental, not code" category as, the EACCES issue flagged in the task brief). Not investigated further — out of scope per the task's own gate note, and the three required gates (lint/tsc/vitest) are the pass/fail bar here.

## Self-assessment

All 9 BLOCKER-and-SHOULD-FIX-severity findings across the three reviews are
**FIXED**, with tests added alongside every code change (no fix shipped without
a regression test proving it). Nothing was deferred or rejected — every
reviewer-proposed fix direction was viable as written and was followed as
specified (SF-A's `color-mix` alpha preservation, SF-B's "className always on
the badge, fixed class on the wrapper," SF-C's `Number.isFinite` guard, SF-D's
"don't hardcode expected hex, extend the live-parsing test," SF-E's serif stack
choice, SF-F's comment-only strengthening).

One deviation from the letter of SF-A's redundant-radius note: rather than
leaving `border-radius: 15px` and only swapping the value to
`var(--radius-lg)`, the now-fully-redundant re-declaration (identical to the
base rule at `CityCard.css:14` once tokenized) was removed outright rather than
kept as a no-op duplicate — a minor simplification beyond the literal ask, in
service of the same N-2 fix the reviewer already flagged as a side benefit.

The `npm run build` failure was investigated (not simply asserted as
"environmental") by reproducing it against the pristine pre-fix-pass commit —
confirmed pre-existing and out of scope, rather than risking a false
"everything passes" claim.

---

## Second fix-pass addendum

Branch `feat/redesign-foundation` @ `2465077`. Scope: the two items raised by
the independent re-review in `REVIEW_FIXES.md` ("Build-failure
characterization" + "New findings"). This addendum corrects the
"environmental, out of scope" framing above — the `vite build` failure was in
fact a real, one-line authoring bug in this PR's own diff, not a pre-existing
tooling issue, and it is now fixed.

| Finding | Disposition | file:line touched |
|---|---|---|
| **BLOCKER (new)** — `client/src/styles/index.css:75` contained the literal substring `--ink*/paper` inside a `/* ... */` comment. The embedded `*/` prematurely closed the comment 2 lines early; the rest of the intended comment prose (through the real `*/` at line 77) was then parsed as CSS tokens, including a stray `)` from "work log)" that surfaced as `CssSyntaxError: Missing opening (` in `@tailwindcss/vite`. This broke `vite build` outright — vitest/tsc/eslint don't parse the Tailwind pipeline, so nothing in the existing gate gauntlet caught it. | **FIXED** | `client/src/styles/index.css:75` — reworded `every --ink*/paper surface` → `` every `--ink`/`--paper` surface `` (backtick-quoted, no literal `*/` substring). Meaning preserved: the text twins clear ≥4.5:1 on both the ink and paper surface families. Scanned the full `index.css` (4909 lines) plus `seoul-devices.css`, `CityCard.css`, `SkylineHeader.css`, `SubwayProgress.css`, `DancheongRail.css` for any other comment prose containing a literal `*/` — this was the only instance; every other `*/` match in these files is a legitimate comment terminator at the end of its block. No style/value changed anywhere. |
| **SHOULD-FIX (new)** — `DESIGN_SEOUL_DAY_NIGHT.md` (the design contract every review cites) was untracked, so the branch had no version-controlled source of truth for a fresh clone/CI/future reviewer. | **FIXED** | `git add DESIGN_SEOUL_DAY_NIGHT.md` plus `docs/redesign/REVIEW_FIXES.md` (the only file under `docs/redesign/` that was still untracked — `FIX_REPORT.md`, `REVIEW_components.md`, `REVIEW_design-fidelity.md`, `REVIEW_token-arch.md` were already tracked from the prior commit). Left untouched per the task's explicit exclusion list: `REDESIGN_SEOUL_NEON_BRIEF.md` (superseded scratch doc, still untracked), `.claude/` (worktree state, still untracked), `BUGS_AND_FEATURES.md` (unrelated uncommitted edit, left modified-but-unstaged in the working tree). |

### Gate results (this pass)

Run from `client/`:

- `npm run lint` → **0 problems.**
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **0 errors.**
- `npx vitest run` → **114 test files passed (114), 1594 tests passed (1594), 0 failed** — unchanged from the prior fix-pass, as expected (only a comment string was touched).
- `npx vite build --outDir /tmp/km-fix2-dist` → **PASSES** — 296 modules transformed, `manifest.webmanifest`/`index.html`/CSS/JS bundle/service worker all emitted, exit 0. This is the first time this branch has produced a working production build; the `CssSyntaxError: Missing opening (` failure reported in the previous fix-pass and re-confirmed in `REVIEW_FIXES.md` no longer reproduces.

The branch is now shippable: all four gates (lint, tsc, vitest, vite build) are
green, and the design contract is version-controlled alongside the code that
implements it.
