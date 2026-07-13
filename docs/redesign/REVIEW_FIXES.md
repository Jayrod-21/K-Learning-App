# Review: fix-pass for Seoul Day/Night foundation

Reviewer: independent re-reviewer (did not write the code, did not perform the
three original reviews, did not perform the fix-pass). Scope: verify
`docs/redesign/FIX_REPORT.md`'s claims against the actual code at
`feat/redesign-foundation` @ `2465077` (on top of `c525288`, off `rebuild`).
Nothing in this review was taken on the fix-pass's word alone — every claim
below was independently re-derived from source, re-run, or reproduced.

## Summary verdict: **PASS WITH CONDITIONS**

Every BLOCKER and SHOULD-FIX from the three original reviews is genuinely
fixed, and the new tests are real regression tests, not tautologies — I
verified this by mentally (and in one case via a revert-and-rebuild scratch
edit, fully reverted afterward) walking through what each test would do if
the underlying bug came back. Praise items are all still intact byte-for-byte
in behavior. `lint`/`tsc`/`vitest` are all clean and match the fix-pass's
reported numbers exactly.

However, this is not an unconditional PASS for one reason the fix-pass's own
report mischaracterizes: **`vite build` is broken, and it is not an
environmental/tooling issue — it is a real, one-line authoring bug inside
`index.css` introduced by the foundation commit (`c525288`)**, still present
after the fix-pass. See "Build-failure characterization" below. This means
the branch currently cannot produce a deployable production bundle. The fix
is a single line; it does not warrant sending the whole deliverable back
through another full 4-phase fix-pass, but it must not be waved through as
"pre-existing/environmental, out of scope" the way `FIX_REPORT.md` frames it.

I'm also flagging one new, non-code finding: `DESIGN_SEOUL_DAY_NIGHT.md` — the
design contract every review in this repo treats as the source of truth — is
not committed to the repository at any commit on this branch (`c525288`,
`2465077`) or on `rebuild`. It exists only as a local untracked file. See
"New findings" below.

---

## Finding-by-finding verification

| Finding ID | Source review | Orig severity | Fix status | Did the test catch the bug? | Notes |
|---|---|---|---|---|---|
| B1 — zero tests, `SubwayProgress` | REVIEW_components.md | BLOCKER | **FIXED** | **Yes** — real assertions | `SubwayProgress.test.tsx` asserts actual derived `aria-valuenow`/`aria-valuemax` numbers (not just "renders"), station `className` per index (done/current/ahead), `fillPct` as a literal `%` string, and clamp behavior at both ends (`current=-3`→`aria-valuenow=1`; `current=99`→`aria-valuenow=5`). Reverting the clamp math (e.g. dropping `Math.max(0,...)`) would flip these exact assertions. `client/src/components/SubwayProgress.test.tsx:78-99` |
| B2 — zero tests, `SealStamp` extension | REVIEW_components.md | BLOCKER | **FIXED** | **Yes** | The backward-compat test (`SealStamp.test.tsx:12-23`) asserts `container.querySelector('.km-seal-group')` is **absent** for a bare `char`/`size` call — if the component regressed to always wrap in `km-seal-group`, this fails immediately. I confirmed by inspection that this is a real structural assertion, not a smoke test. |
| B3 — zero tests, `CityCard` | REVIEW_components.md | BLOCKER | **FIXED** | **Yes** | `CityCard.test.tsx` asserts `rail`→`.km-dancheong-rail` presence/absence, `feat`→both `km-citycard--feat` AND `km-dancheong-rail--feat` (composition, not just the card's own class), `heading`→text + `kr-display` class, and `...rest` spread via `data-testid`/`aria-label`. Real conditional-composition coverage. `client/src/components/CityCard.test.tsx:18-43,53-62` |
| — SkylineHeader gap | REVIEW_components.md | SHOULD-FIX | **FIXED** | Yes | Asserts both `<g>` layers present unconditionally (`SkylineHeader.test.tsx:32-36`), title renders outside `aria-hidden` subtree, svg has `aria-hidden`+`focusable="false"`. Real, not tautological. |
| — DancheongRail gap | REVIEW_components.md | SHOULD-FIX | **FIXED** | Yes | Low-logic component, but the 5 tests do assert the real tone→class and feat→class mappings, not just render-without-throw. |
| SF-1/SF-2 (components review numbering) | REVIEW_components.md | SHOULD-FIX | **FIXED** | n/a (className behavior, see SF-B row) | Superseded by SF-B/SF-C below (same findings, cross-referenced across all three review docs with different numbering — confirmed same underlying issues). |
| SF-A — `CityCard.css` hard-coded rgba/px | REVIEW_design-fidelity.md / REVIEW_token-arch.md | SHOULD-FIX | **FIXED** | n/a (CSS, no test possible for literal-hex-absence beyond grep) | Confirmed by grep: zero `rgb(`/`#` literals remain in `CityCard.css`. Night body is now `color-mix(in srgb, var(--ink-2) 85%, transparent)` / `color-mix(in srgb, var(--ink-1) 90%, transparent)` — **alpha is preserved**, so `--city-gradient` still reads through the signboard body (verified by reading the actual `color-mix` stops — `transparent` is the second color-mix argument, not a solid `var(--ink-1)` swap, which would have flattened the depth). Border/radius now `var(--line-strong)`/`var(--radius-lg)`. Docstring at `CityCard.tsx:24` ("Token-driven only — no hard-coded hex") is now true. `client/src/components/CityCard.css:33-53` |
| SF-B — `SealStamp` className dropped when `label` set | REVIEW_components.md | SHOULD-FIX | **FIXED** | **Yes, precisely** | `SealStamp.test.tsx:83-98` — two tests, one with **both** `label` and `className` passed (the exact dormant-bug shape), asserting `className` lands on `.km-seal` (the badge), not just the wrapper. Against the old `!label && className` code this test would fail outright. `client/src/components/SealStamp.tsx:71-78` |
| SF-C — `SubwayProgress` NaN/Infinity | REVIEW_components.md | SHOULD-FIX | **FIXED** | **Yes** | `SubwayProgress.tsx:53-54` adds `Number.isFinite` guards before the floor/clamp math. Two tests (`SubwayProgress.test.tsx:120-132`) directly pass `current={0/0}` and `steps={Infinity}` and assert `aria-valuenow`/`aria-valuemax` are neither `'NaN'` nor `'Infinity'` string values. I confirmed by re-deriving the math: without the guard, `Math.floor(NaN)` → `NaN`, `Math.min(Math.max(0,NaN),4)` → `NaN` (NaN poisons both `Math.max`/`Math.min`), so the test would fail against the pre-fix code. Real catch. |
| SF-D — `tokensContrast.test.ts` missing `--on-vermilion`-on-`--km-tone` coverage | REVIEW_components.md | SHOULD-FIX | **FIXED** | n/a (contrast math, not a regression-catching unit test in the traditional sense) | New `describe` block (`tokensContrast.test.ts:138-181`) computes real WCAG contrast via the same CSS-parsing/`resolve()` mechanism as the rest of the file (not hardcoded expected values) for Day `dan-cobalt`/`dan-jade` and Night `neon-blue`/`neon-mint`, both `>= 4.5:1`. `plain` correctly excluded with a code comment explaining it's not a text-on-fill pairing. This is a live guard against future re-tints, exactly as intended. |
| SF-E — Day Latin headings not serif | REVIEW_design-fidelity.md | SHOULD-FIX | **FIXED** | n/a (no test added, but doesn't need one — pure CSS selector addition) | `index.css:473-476` adds `:root[data-theme="light"] h1, :root[data-theme="light"] h2 { font-family: 'Noto Serif', Georgia, serif; }`. Specificity (0,1,1) correctly beats the base `h1, h2 { font-family: var(--font-display) }` (0,0,1) at `index.css:465`. Night is untouched — still Nunito (`--font-display`) + glow (`[data-theme="dark"] h1` text-shadow, unchanged). Verified no contrast regression: this is a font-family-only change, doesn't touch color. |
| SF-F — `:not([data-theme])` comment undersold the risk | REVIEW_token-arch.md | SHOULD-FIX | **FIXED (comment-only, as scoped)** | n/a | `index.css:264-274` — comment now explicitly says "DO NOT drop `:not([data-theme])`" and spells out the exact specificity-tie failure mode. Selector logic itself is byte-identical (confirmed: `:root:not([data-theme])` still at `index.css:275` inside the same `@media (prefers-color-scheme: dark)` block). |

**Verified tally: 9/9 BLOCKER+SHOULD-FIX findings from the three original reviews are genuinely FIXED, 0 PARTIALLY-FIXED, 0 NOT-FIXED, 0 REGRESSION.**

---

## Praise-intact check

| Praised item | Still present? | Evidence |
|---|---|---|
| 3× `@media (prefers-reduced-motion: no-preference)` gates (existence-gated, not zero-duration) | **Yes** | `client/src/components/SkylineHeader.css:58`, `client/src/styles/seoul-devices.css:60`, `client/src/styles/seoul-devices.css:163` — all three still wrap the whole animation rule in the media query, confirmed via direct grep. |
| `:root:not([data-theme])` structure (only comment strengthened) | **Yes** | `client/src/styles/index.css:275` — selector unchanged; comment above it (`259-274`) grew per SF-F. |
| `--km-tone` centralization | **Yes** | `client/src/styles/seoul-devices.css:152-157` — `.km-tone--accent/blue/mint/plain` + dark-theme overrides, unchanged, still the single resolution point consumed by `CityCard`, `DancheongRail`, `SubwayProgress`, `SealStamp`. |
| `SubwayProgress` single `role="progressbar"` pattern | **Yes** | `client/src/components/SubwayProgress.tsx:59-68` — one `role="progressbar"` on the root, dots individually `aria-hidden` via the parent `.km-subway__track[aria-hidden="true"]`. |
| `SkylineHeader` dual `<g>` layers unconditionally in DOM | **Yes** | `client/src/components/SkylineHeader.tsx:46,70` — both `g.km-skyline__day` and `g.km-skyline__night` always rendered; now also regression-tested (`SkylineHeader.test.tsx:32-36`). |
| Deepened hex values (Day `--paper-mute #6B614D`, Night `--neon-blue #5C87FF`) | **Yes** | `client/src/styles/index.css:70` (`--paper-mute: #6B614D`), `index.css:206` (`--neon-blue: #5C87FF`) — unchanged from the pre-fix-pass values reviewed and endorsed in `REVIEW_design-fidelity.md`. |

No praised item was silently undone.

---

## Build-failure characterization

**Verdict: genuine code regression relative to `rebuild`, introduced by the foundation commit (`c525288`) — NOT environmental/tooling, and NOT fixed by the fix-pass.**

I independently reproduced and bisected this rather than trusting `FIX_REPORT.md`'s characterization:

1. `cd client && npx vite build --outDir /tmp/km-rereview-dist` on the current branch (`2465077`) → **fails** with `CssSyntaxError: Missing opening (` from `@tailwindcss/vite` processing `src/styles/index.css`. Matches `FIX_REPORT.md`'s claim.
2. I stashed all uncommitted local state, then used `git checkout c525288 -- .` (revert-in-place, no branch switch) to restore the fix-pass's 5 touched files to their pre-fix-pass content, and rebuilt: **same failure, same file, same error.** This confirms `FIX_REPORT.md`'s narrow claim — the fix-pass itself did not introduce this — is technically correct.
3. I then went one step further than the fix-pass did: `git checkout rebuild -- .` (restoring `index.css` fully to its pre-redesign content) and rebuilt: **build succeeds cleanly.** This means the failure was introduced somewhere in the foundation commit's `index.css` changes — it is a real bug in this PR's own deliverable, not something that predates the whole redesign effort, and not comparable to a generic environmental/tooling flake.
4. I isolated the exact line with a paren-balance scan and manual read: **`client/src/styles/index.css:75`** — inside a `/* ... */` comment block starting at line 73, the prose reads `soft chip AND on every --ink*/paper surface`. The substring `--ink*/paper` contains a literal `*/`, which is a **premature CSS comment terminator**. From that point, the rest of the intended comment (`paper surface — see repo contrast note in DESIGN_SEOUL_DAY_NIGHT.md work log). \`-verm\` doubles as the seal-stamp red. Un-suffixed value is the accent/border/glow-carrying fill. */`) is parsed as literal CSS — including a stray `)` from `work log)`, which is exactly the "Missing opening (" the parser reports.
5. I confirmed the fix: changing the phrase to avoid the literal `*/` (e.g. `--ink family / paper surface`), rebuilding — **build succeeds, 296 modules transformed, valid CSS/JS/SW output emitted.** I then reverted this scratch edit immediately; `git status`/`git diff` confirm the tree is back to the exact `2465077` state (only the pre-existing, out-of-scope `BUGS_AND_FEATURES.md` local edit and untracked files remain, unchanged from before I started).

**Why this matters:** `FIX_REPORT.md` says the build failure "reproduces on the untouched c525288 baseline (pre-existing, not caused by the diff)" and lumps it in with "the same 'known environmental, not code' category" as an unrelated EACCES issue. That framing is misleading. This is not environmental — it is a one-character-class authoring slip in a code comment, it is 100% within the scope of this PR's own deliverable (introduced at `c525288`, still broken at `2465077`), it is trivially fixable, and **`npm run build`/`vite build` currently cannot produce a deployable bundle on this branch at all.** No test in the suite (lint/tsc/vitest) exercises the Tailwind CSS pipeline, so nothing here would have caught it — this is a real gap in the gate gauntlet, not just a build-tool quirk to shrug off.

---

## New findings introduced by the fix-pass (or newly discovered in re-review)

**BLOCKER (new)**
1. `client/src/styles/index.css:75` — a literal `*/` inside a CSS comment's prose (`--ink*/paper`) prematurely terminates the comment, leaking a stray `)` into the CSS token stream and breaking `vite build` outright via `@tailwindcss/vite`'s parser. One-line fix (reword to avoid the literal `*/` sequence, e.g. "`--ink` family / `paper` surface"). This predates the fix-pass (present since `c525288`) but the fix-pass did not catch or fix it despite running (and reporting on) a build check. **Must be fixed before this branch is deployable**, regardless of whether it's folded into this fix-pass's scope or filed as an immediate same-day follow-up.

**SHOULD-FIX (new)**
1. `DESIGN_SEOUL_DAY_NIGHT.md` (repo root) is **not committed** at any commit on this branch or on `rebuild` — confirmed via `git show HEAD:DESIGN_SEOUL_DAY_NIGHT.md` (fails) and `git log --all --oneline -- DESIGN_SEOUL_DAY_NIGHT.md` (empty). It is also not gitignored — it's simply an untracked local file. Every review in `docs/redesign/` treats this doc as the authoritative contract (`REVIEW_design-fidelity.md`'s entire scope is fidelity *to this file*), but merging this branch as-is would not bring the contract itself into version control — a fresh clone, CI run, or future page-builder reskinning per §9 would have no committed source of truth to check against. Recommend committing `DESIGN_SEOUL_DAY_NIGHT.md` (and likely `REDESIGN_SEOUL_NEON_BRIEF.md`, also untracked) alongside the code before merge.

**NIT**
1. `client/src/styles/index.css:76` — same comment block also contains the phrase "see repo contrast note in DESIGN_SEOUL_DAY_NIGHT.md work log" — once the doc is committed (per the SHOULD-FIX above), worth confirming that doc actually contains the referenced "work log" section, since I did not find a dedicated contrast work-log section in the copy I reviewed (the doc's contrast reasoning lives inline in `index.css`'s own comments, not in `DESIGN_SEOUL_DAY_NIGHT.md`). Low priority — doesn't block anything, just a possibly-stale cross-reference.

**PRAISE (new, not called out by the original three reviews)**
1. `client/src/styles/tokensContrast.test.ts`'s new SF-D block continues the file's existing discipline of computing contrast from the actual CSS source rather than hardcoding expected pass/fail — this is the right way to guard a design-token system and the fix-pass extended it faithfully rather than taking a shortcut (e.g. asserting a literal `4.87` instead of re-deriving it).
2. The SF-B fix (`SealStamp.tsx:71-78`) is a clean, minimal diff that exactly matches the reviewer's own suggested fix direction — no scope creep, no incidental refactor of the surrounding component.

---

## Gate results (independently re-run)

- `cd client && npm run lint` → **clean, 0 problems.** (matches `FIX_REPORT.md`)
- `cd client && npx tsc -p tsconfig.app.json --noEmit --incremental false` → **clean, 0 errors, 0 output.** (matches `FIX_REPORT.md`)
- `cd client && npx vitest run` → **114 test files passed (114), 1594 tests passed (1594), 0 failed.** Exact match to `FIX_REPORT.md`'s claimed 114 files / 1594 tests.
- `cd client && npx vite build --outDir /tmp/km-rereview-dist` → **FAILS** (`CssSyntaxError: Missing opening (` from `@tailwindcss/vite` on `src/styles/index.css`). Root-caused above to `index.css:75` — a real code bug, not environmental. Confirmed absent on `rebuild`, confirmed present on `c525288`, confirmed fixed by a 1-line change (change reverted after verification; working tree restored to exact `2465077` state).

---

## Recommendation

**File a targeted follow-up, do not merge as-is; a full new fix-pass cycle is not warranted, but the branch is not shippable in its current state.**

Concretely, before this PR merges into `rebuild`:
1. **New BLOCKER, trivial fix:** reword `client/src/styles/index.css:75` to remove the literal `*/` inside the comment (e.g. "`--ink` family / `paper` surface" instead of "`--ink*/paper` surface"). Re-run `vite build` to confirm a clean production bundle — I've already verified this exact fix resolves it.
2. **New SHOULD-FIX:** commit `DESIGN_SEOUL_DAY_NIGHT.md` (and `REDESIGN_SEOUL_NEON_BRIEF.md`) to the repository so the design contract this whole redesign is built against is actually version-controlled and available to future reviewers/CI.

Everything else — all 9 original BLOCKER/SHOULD-FIX findings, the test quality, the praise-item integrity, lint/tsc/vitest — is genuinely solid and does not need another round. Once items 1–2 above are addressed (expected to be minutes of work, not a new fix-pass cycle), this is ready to PR into `rebuild`.

---

## Second fix-pass verification (commit 93014e7)

Reviewer: independent re-reviewer (fresh — did not write `93014e7`, did not
perform the second fix-pass, did not perform the review immediately above).
Scope: verify that `93014e7` ("fix(redesign): unbreak vite build (stray `*/`
in index.css comment) + commit design trail") genuinely closes the two open
items from the "Recommendation" section above — the `vite build` BLOCKER and
the untracked `DESIGN_SEOUL_DAY_NIGHT.md` SHOULD-FIX — without collateral
damage. Every item below was independently re-derived (diffed, grepped, or
re-run), not taken on the commit message's word.

### Verdict: **PASS**

The `vite build` BLOCKER is genuinely fixed by a comment-only reword — zero
CSS values/selectors/tokens changed — and the design-trail docs are now
tracked. All four gates (lint, tsc, vitest, and — the previously-missing,
load-bearing one — `vite build`) pass clean when I re-ran them independently.
No collateral changes rode along. Branch is ready to PR into `rebuild`.

### Checklist

1. **Build bug fixed, comment-only change.** `git diff 2465077 93014e7 --
   client/src/styles/index.css` shows exactly one changed line, `index.css:75`:
   `--ink*/paper` → `` `--ink`/`--paper` `` (backtick-wrapped token names, no
   literal `*/` substring remains). This is inside the existing `/* ... */`
   Dancheong-palette comment block (opened `index.css:73`, closed `index.css:78`
   — both unchanged) — no selector, property, value, or token declaration on
   any line was touched. **PASS.**
   I also grepped for the underlying bug *pattern* (a non-whitespace character
   immediately followed by `*/`, i.e. an accidental early comment terminator)
   across every `.css` file under `client/src` (33 files, listed via `find
   client/src -iname "*.css"`), not just the five named in my brief:
   `grep -rnP '\S\*/' client/src --include="*.css"` → **zero matches.** No
   other instance of this bug class exists anywhere in the tree. **PASS.**
2. **No unintended changes rode along.** `git diff 2465077 93014e7 --stat` →
   exactly 4 files: `client/src/styles/index.css` (+1/-1, the comment reword),
   `DESIGN_SEOUL_DAY_NIGHT.md` (new, 193 lines), `docs/redesign/REVIEW_FIXES.md`
   (new-to-this-diff at this point — 124 lines, this very file pre-append),
   `docs/redesign/FIX_REPORT.md` (+29 lines, an addendum). No component/page
   `.tsx`/`.ts`/`.css` file besides `index.css` appears in the stat. **PASS.**
   Note (pre-existing, out of scope, not touched by `93014e7` or by me):
   `git status` at the time of this review showed a locally modified
   `BUGS_AND_FEATURES.md` and untracked `.claude/` + `REDESIGN_SEOUL_NEON_BRIEF.md`
   in the working tree. These are not part of `93014e7`'s diff (confirmed by
   `git show 93014e7 --stat`, which lists only the 4 files above) and are
   irrelevant to this branch's mergeability — flagging only for completeness.
3. **Gates re-run independently, from `client/`:**
   - `npm run lint` → **clean, 0 problems, 0 output.**
   - `npx tsc -p tsconfig.app.json --noEmit --incremental false` → **clean,
     0 errors, exit 0, 0 output.**
   - `npx vitest run` → **114 test files passed (114), 1594 tests passed
     (1594), 0 failed.** Exact match to both `FIX_REPORT.md` and the prior
     re-review's numbers.
   - `npx vite build --outDir /tmp/km-rr2-dist --emptyOutDir` → **exit 0,
     succeeds.** `296 modules transformed`, real CSS emitted
     (`assets/index-gSIf16QB.css`, 152.02 kB / 25.57 kB gzip — non-trivial
     size, not an empty/truncated stylesheet), real JS emitted
     (`assets/index-Cetp8yHg.js`, 790.35 kB / 231.36 kB gzip), plus
     `manifest.webmanifest`, `sw.js`, `workbox-*.js`, icons, and `index.html`
     all present in `/tmp/km-rr2-dist/`. Only warning is the pre-existing
     "chunk larger than 500 kB" advisory (unrelated to this fix, not a build
     failure). **This is the load-bearing check the first fix-pass missed —
     it now passes cleanly.**
4. **No regression to earlier work — spot-confirmed still intact** (expected,
   since the `2465077`→`93014e7` diff literally cannot touch these — none of
   the files below appear in that diff's stat):
   - 3× `@media (prefers-reduced-motion: no-preference)` gates — still present,
     `client/src/components/SkylineHeader.css:58`,
     `client/src/styles/seoul-devices.css:60,163`.
   - `:root:not([data-theme])` structure — still at `index.css:276`, selector
     byte-identical.
   - `--km-tone` centralization — still at `index.css:903-915` /
     `seoul-devices.css:152-157`, consumed via `var(--km-tone)` /
     `color-mix(in srgb, var(--km-tone) ...)`, not inlined anywhere.
   - `CityCard.css` SF-A tokenization — still `color-mix(in srgb, var(--ink-2)
     85%, transparent)` / `color-mix(in srgb, var(--ink-1) 90%, transparent)`
     at `CityCard.css:34-41`; zero raw `rgb(`/`#` literals reintroduced.
   - All 5 test files present: `client/src/components/{CityCard,SkylineHeader,
     SubwayProgress,DancheongRail}.test.tsx` + `client/src/styles/
     tokensContrast.test.ts` (the 5th — the contrast-guard file referenced by
     `index.css:189`'s "Guarded by tokensContrast.test.ts" comment).
   **PASS** on all five.
5. **Design trail tracked.** `git ls-files | grep -E
   "DESIGN_SEOUL_DAY_NIGHT|docs/redesign"` → returns all 6 expected paths:
   `DESIGN_SEOUL_DAY_NIGHT.md`, `docs/redesign/FIX_REPORT.md`,
   `docs/redesign/REVIEW_FIXES.md`, `docs/redesign/REVIEW_components.md`,
   `docs/redesign/REVIEW_design-fidelity.md`,
   `docs/redesign/REVIEW_token-arch.md`. **PASS.**
   Minor residual gap (not a blocker, not in this fix-pass's stated scope):
   `REDESIGN_SEOUL_NEON_BRIEF.md` — flagged as a SHOULD-FIX companion doc in
   this file's own "Recommendation" section above (item 2) — is still
   untracked (confirmed via the same `git status` in item 2 above). It was
   not part of the two items `93014e7`'s commit message claims to fix
   (build bug + `DESIGN_SEOUL_DAY_NIGHT.md`), so its absence isn't a broken
   promise, but it remains an open loose end from the prior review's
   recommendation. Non-blocking.

### New findings

None that block merge. The one residual item is #5's `REDESIGN_SEOUL_NEON_BRIEF.md`
gap noted above (NIT — untracked companion doc, not required by this commit's
own stated scope, not cited as authoritative by any `docs/redesign/*.md`
review the way `DESIGN_SEOUL_DAY_NIGHT.md` is).

### Final ship recommendation

**Ready to PR into `rebuild`.** Both open items from the prior re-review are
closed: the `vite build` BLOCKER is fixed with a verified comment-only change
(no CSS semantics altered), and the design contract is now version-controlled.
All four gates — lint, tsc, vitest, and the previously-missing `vite build` —
pass independently and cleanly. Optional, non-blocking follow-up: commit
`REDESIGN_SEOUL_NEON_BRIEF.md` in a future small PR for the same reasoning
the original review gave for `DESIGN_SEOUL_DAY_NIGHT.md`.
