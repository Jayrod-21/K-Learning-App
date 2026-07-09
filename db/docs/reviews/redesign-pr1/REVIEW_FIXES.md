# Re-Review — Seoul Neon Redesign PR1, Fix-Pass Verification

**Reviewer role:** independent senior frontend/a11y reviewer. No prior involvement in this
branch, the original three reviews, or the fix-pass itself — I did not write or review any
of the code below before this pass.

**Branch/commit reviewed:** `feat/redesign-seoul-neon` @ `a6e922d` (fix-pass commit on top
of `600eeb7`, the PR1 core commit).

**Contract:** `REDESIGN_SEOUL_NEON_BRIEF.md` §1 (hard constraints), §3a (accent contrast).

**Method:** I did not reuse or trust the fix-pass's own contrast script or numbers. I wrote
my own from-scratch WCAG 2.1 relative-luminance contrast calculator
(`/tmp/km_review_contrast2.py`), extracted every token value directly from the current
`client/src/styles/index.css` by hand (not by re-deriving one token from another), and
computed every accent × theme × surface combination named in the task, plus a few the
original reviews didn't check (focus-ring non-text contrast). I also independently re-ran
all four build/test gates and grepped the source for every claim in `FIX_REPORT.md` rather
than accepting its prose.

**Self-correction note (shows my work, not the fix-pass's):** my first draft of the
contrast script re-derived each `*-soft` chip's composite base color from the "bright" or
"deep" fill token by name-guessing. That was wrong for the accent and danger families: the
literal `rgba()` written in the CSS for `--vermilion-soft`/`--danger-soft` uses the
**bright** hue as its composite base in **light** theme but the **deep/fill** hue as its
composite base in **dark** theme (confirmed by reading the raw `rgba()` triplets at
index.css:19-206, e.g. light `--vermilion-soft: rgba(255, 62, 108, 0.10)` = the bright
`#FF3E6C`, not the fill `#E11D48`; dark `--vermilion-soft: rgba(255, 77, 116, 0.14)` = the
fill `#FF4D74`, not the bright `#FF6B8A`). My first pass produced one spurious 4.48:1 "FAIL"
for danger-ink on danger-soft/ink-2 that vanished (→ 4.605:1, PASS) once I fixed the
composite basis to match the literal CSS. Flagging this so the number below is trusted for
the right reason: I verified it against the literal declared values, not a hand-wave.

---

## Summary verdict: **PASS**

Every BLOCKER and SHOULD-FIX from all three original reviews is either genuinely FIXED,
correctly DEFERRED with an explicit rationale, or was already a non-issue. I found **zero
BLOCKERs, zero cells below 4.5:1 for any text-on-background combination in the matrix the
brief asked for**, zero regressions in the praised items, and no over-reach (hero/CTA fills,
focus-ring outline, hex gradient, and glows all still read the bright/deep hues directly —
none of them were wrongly repointed to `--danger` or the `-ink` twins). All four re-run
gates are clean and match the fix-pass's own reported numbers essentially exactly.

I did find **one new, non-blocking issue** the three original reviews and the fix-pass never
checked because they scoped to *text* contrast (§3a): the `.focusring` outline is a
non-text UI component (WCAG 2.2 SC 1.4.11, 3:1 floor), and for the **Mint** accent in
**light** theme it measures **2.86:1** against the raw page background (`--ink`) — below
3:1. This is pre-existing (the `.focusring` rule and the mint fill value were untouched by
the fix-pass diff — confirmed via `git diff 600eeb7..a6e922d` touching no motion/outline
rules), narrow in practice (against the far more common ink-1/nav-composited host it clears
3:1 at 3.39–3.40), and affects a non-default accent only. Not a blocker; recommend a
follow-up ticket, not another fix-pass cycle.

**Counts:** 12 FIXED · 2 DEFERRED (by explicit, correct instruction) · 0 PARTIALLY-FIXED ·
0 NOT-FIXED · 0 REGRESSION · 1 new NIT (focus-ring, above).

---

## Finding-by-finding table

| # | Finding (source review) | Orig. severity | Status | My measurement / notes |
|---|---|---|---|---|
| a11y B1 | Category pill text (`.km-pill--red/--green/--ochre`, +gold) on own `*-soft`, light theme | BLOCKER | **FIXED** | index.css:650-658 now read `-ink` twins. Worst: ochre-ink on ochre-soft/ink-1 = **4.992:1** (was 1.87). All 5 hues ≥4.62 against the harder ink-2 host too. |
| a11y B2 | Same hues as text on solid `--ink-1` (TaskCard skill eyebrows) | BLOCKER | **FIXED** | index.css:1655-1656 (`.km-taskcard--gold/--red .km-taskcard__skill`) → `-ink` twins. All 6 hues ≥5.43:1 directly on white. |
| a11y B3 | Accent-as-text fails AA, light, coral (default) 4.14 + mint 3.11-3.39 | BLOCKER | **FIXED** | `.km-btn--ghost` (index.css:627), `.km-pill--gold` (:650), `.km-bottomnav__cell--active` (:762) all read `--vermilion-ink`. Worst light cell (coral, ghost-hover16/ink-2) = **4.605:1**. Worst dark cell (blue, soft/ink-3) = **4.623:1**. All 6 accent×theme × 5 host-surfaces I tested ≥4.5. |
| a11y B4 | Error UI hardcodes `--vermilion`, silently recolors under Blue/Mint | BLOCKER | **FIXED** | Grepped every `color: var(--vermilion)` in the sheet — **zero hits**. All 8 originally-named classes + 6 more genuine danger contexts (`.km-topik/diagnostic__choice--wrong`, `.km-mock__review-item/verdict--wrong`, `.km-images__upload-error`, `.km-progress__delta--down`) now read `--danger`/`--danger-soft`/`--danger-ink`. `--danger`/`--danger-soft` remain explicitly pinned to coral-red in the `blue`/`mint` `[data-accent]` blocks (index.css:178-179, 196-197 light; 187-188, 205-206 dark) regardless of accent. |
| a11y B5 | `--ink` (bg token) used as text — toast/install ≈1.1-1.2:1 | BLOCKER | **FIXED** | `.km-toast__message`, `.km-install__title`, plus `.km-toast__dismiss:hover` and `.km-resources__initial:hover` (2 extra sites found by the fix-pass, confirmed real) now read `--paper` (or `--vermilion-ink` for the active-state one). Measured: **18.39:1** light / **15.52:1** dark on the base card surface; ≥11.5:1 even on the error/success toast tints. |
| a11y S1 | Soft-token contrast is host-surface-dependent, not fixed | SHOULD-FIX | **FIXED** | Ink twins verified against ink-2 (light) and ink-3 (dark) — the harder hosts the original review flagged — not just ink-1. All still ≥4.5. |
| a11y S2 / fidelity N5 | `.km-pill--red` maps to indigo, not red | SHOULD-FIX/NIT | **FIXED (comment)** | Comment at index.css:651-654 explains the mapping; class renamed nothing (correctly prohibited by §1). |
| a11y S3 | Violet/cyan have no consumers yet, same trap awaits | SHOULD-FIX | **FIXED (proactively)** | `--violet-ink`/`--cyan-ink` exist in both theme blocks (confirmed, index.css:66-67, 134-135) and pass AA (4.98/5.02 light, 4.72/5.94+ dark) ahead of their first real consumer. Confirmed no `.km-pill--violet`/`--cyan` class exists yet — correctly not invented out-of-scope. |
| a11y N1 | Ambient body-glow vs. legibility | NIT | No action needed | Confirmed still true — no primary text sits directly on raw body bg. |
| a11y P1 | Reduced-motion coverage | PRAISE | **INTACT** | `git diff 600eeb7..a6e922d -- index.css` touches zero animation/keyframe/motion lines. |
| a11y P2 | `--moss` accent-independent | PRAISE | **INTACT** | Grepped `--moss` against every `[data-accent]` block — zero hits. |
| a11y P3 | CTA fill/text contrast solid | PRAISE | **INTACT / re-verified** | All 6 fill/`--on-vermilion` pairs re-measured independently: 4.697–11.465:1, matching the fix-pass's numbers. |
| cascade SF1 | Accent doesn't sync cross-device | SHOULD-FIX | **DEFERRED** (correct) | No client code changed for this; product decision explicitly left open, consistent with `km.theme` precedent. Not a defect. |
| cascade SF2 | Dead `--green`/`--green-light` in allowlist/presets | SHOULD-FIX | **FIXED** | `ALLOWED_VARS` (SettingsProvider.tsx:65-90) no longer lists them; `CORRECT_PRESETS` (palette-presets.ts:121-146) has zero `--green*` keys — only `--moss`/`--moss-soft`. Test edits in `settings.test.ts`/`SettingsProvider.test.tsx` verified against the real diff, not just the comment — honest, not softened. |
| cascade N1/N2 | Comment drift risk / Accent+ThemeProvider duplication | NIT | Not addressed | Explicitly optional per original review; unchanged, fine to leave. |
| cascade P1-P3 | ACCENT_PRESETS no vars / allowlist defence-in-depth / combo-block specificity | PRAISE | **INTACT** | `ACCENT_PRESETS` (palette-presets.ts:114-119) confirmed zero `vars` on all 4 legacy entries. All 6 `[data-accent]`/dark-combo blocks present and correctly structured (index.css:159-206). |
| fidelity SF1 | 5/6 category hues fail AA, light | SHOULD-FIX | **FIXED** | Same fix as a11y B1/B2; all named consumers (pills, skillbar, skillscompare, taskcard, mock verdict/review-pick, review ratings/cover-icons, hanja statechip, progress deltas, mastery-stale) now read `-ink` twins — spot-checked `Progress.css:267-268` (`--moss-ink`/`--danger-ink`) and `:356` (`--ochre-ink`) directly. |
| fidelity SF2 | §10 font-display not wired to stat numbers | SHOULD-FIX | **FIXED** | `Progress.css:162`, `index.css:2957`, `index.css:3810` all now carry `font-family: var(--font-display)` with a `/* §10 */` comment. |
| fidelity N3 | Leftover hanji-era RGB in `.km-seal`/scrollbar | NIT | Not fixed (by design) | Correctly deferred to PR2 (§8 misc-surfaces), unchanged. |
| fidelity N4 | Ink motifs geometry vs. soft system | NIT | Not fixed (by design) | Same — explicitly PR2 scope. |
| fidelity PRAISE | §1 constraints, accent picker, hex rotate, reduced motion, test-edit honesty | PRAISE | **INTACT** | No class/token renamed; `AccentProvider`/`ThemeProvider` untouched by the fix-pass diff; hex-float-vs-rotate scoping (`:not(.km-bottomnav__hex--open)`) unchanged. |

---

## Full contrast matrix (independently computed, WCAG 2.1 relative luminance)

All values below are from my own script against literal token values read out of
`client/src/styles/index.css` current HEAD (`a6e922d`). "soft/inkN" = the hue's `*-soft`
rgba alpha-composited over that surface token; "hover16/ink2" = `.km-btn--ghost:hover`'s
`color-mix(var(--vermilion) 16%, transparent)` composited over `--ink-2`.

### 1. CTA solid fill vs. `--on-vermilion` text (§3a headline ask)

| Accent | Light | Dark |
|---|---|---|
| Coral | 4.70:1 | 6.11:1 |
| Blue | 5.17:1 | 6.18:1 |
| Mint | 5.42:1 | 11.47:1 |

All PASS (≥4.5).

### 2. Accent-as-text (`--vermilion-ink`) on its own `*-soft`, worst-case per accent×theme

| Accent | Theme | soft/ink-1 | soft/ink-2 | soft/ink-3 | hover16/ink-2 | solid ink-1 |
|---|---|---|---|---|---|---|
| Coral | Light | 5.58 | 5.22 | 5.58 | **4.60** | 6.35 |
| Coral | Dark | 5.66 | 5.16 | 4.62 | 5.02 | 6.64 |
| Blue | Light | 5.57 | 5.21 | 5.57 | 4.67 | 6.24 |
| Blue | Dark | 5.72 | 5.19 | 4.62 | 5.03 | 6.99 |
| Mint | Light | 5.42 | 5.08 | 5.42 | 4.62 | 5.90 |
| Mint | Dark | 9.06 | 8.18 | 7.27 | 7.79 | 12.14 |

All PASS. Worst cell overall = **4.60:1** (coral-light, ghost-button hover state over
ink-2) — matches the fix-pass's own claimed worst cell (4.60:1) essentially exactly.

### 3. Danger-as-text (`--danger-ink`), accent-independent (always coral-pinned)

| Theme | soft/ink-1 | soft/ink-2 | soft/ink-3 | raw `--ink` |
|---|---|---|---|---|
| Light | 4.93 | 4.61 | 4.93 | 4.72 |
| Dark | 5.64 | 5.14 | 4.61 | 7.53 |

All PASS.

### 4. Category hues as text (`-ink` twins) on own `*-soft`

| Hue | Light soft/ink-1 | Light soft/ink-2 | Light solid-ink-1 | Dark soft/ink-1 | Dark soft/ink-2 | Dark solid-ink-1 |
|---|---|---|---|---|---|---|
| indigo | 4.94 | 4.62 | 5.54 | 5.72 | 5.19 | 6.99 |
| moss | 4.98 | 4.67 | 5.54 | 7.60 | 6.87 | 10.19 |
| ochre | 4.99 | 4.68 | 5.43 | 7.40 | 6.69 | 9.81 |
| violet | 4.98 | 4.66 | 5.80 | 5.84 | 5.29 | 7.12 |
| cyan | 5.02 | 4.71 | 5.59 | 7.41 | 6.69 | 9.94 |

All PASS. Worst cell = **4.62:1** (indigo/violet-light, soft/ink-2).

### 5. Toast/install text fix (B5)

| | ink-1 | error-toast bg | success-toast bg |
|---|---|---|---|
| Light | 18.39 | 16.18 | 16.53 |
| Dark | 15.52 | 13.23 | 11.57 |

All far above 4.5:1.

### 6. NEW — focus-ring non-text contrast (WCAG 1.4.11, 3:1 floor) — not in original scope

| Accent | Light vs. `ink-1` (card) | Light vs. raw `--ink` (page bg) | Dark vs. raw `--ink` |
|---|---|---|---|
| Coral | ~4.0 | 3.96 | 6.18 |
| Blue | ~4.4 | 4.36 | 6.25 |
| Mint | 3.39 | **2.86 (FAIL, <3:1)** | 11.60 |

Only the Mint-light / raw-page-bg cell fails, and only when a `.focusring`-tagged element
sits directly on the page background with no card/nav surface behind it. Against the more
typical ink-1 card or the 82%-opaque nav bar it clears 3:1 (3.39–3.40). Not touched by the
fix-pass (the outline still reads `var(--vermilion)` directly, unchanged value). Recommend a
low-priority follow-up (either give focus rings a `-ink`-tier twin too, or accept given
narrow real-world exposure) — **not a blocker for this PR**.

**Worst measured ratio across every TEXT scenario in the brief's required matrix: 4.60:1**
(coral-light ghost-button hover). Nothing text-related is below 4.5:1.

---

## New findings (beyond the three original reviews)

1. **Focus-ring non-text contrast gap, Mint + light + no-card host (2.86:1, sub-3:1).** See
   §6 above. Pre-existing, narrow, non-default accent, no regression from this fix-pass.
   NIT / follow-up ticket, not a blocker.
2. **User-selectable Correct/Wrong presets (pine/teal/amber/slate) were not re-verified for
   AA** — out of scope for both the original reviews and the fix-pass (which only handled
   the *default* moss/danger + the 3 accent presets), but worth noting since `--moss-ink`/
   `--danger-ink` are `color-mix()`-derived from `--moss`/`--danger` and will silently
   inherit whatever the user picks in Settings ▸ Correct/Wrong. I did not compute these —
   flagging for a future pass if those presets are audited.

---

## Gate re-run results (independently executed)

```
$ npx tsc -p tsconfig.app.json --noEmit
(no output — exit 0)

$ npm run lint
> client@0.0.0 lint
> eslint .
(no output — exit 0)

$ npx vitest run
 Test Files  96 passed (96)
      Tests  1140 passed (1140)
   Duration  11.43s

$ npx vite build --outDir /tmp/km-rereview-dist
✓ built in 428ms
PWA precache: 15 entries (811.82 KiB)
```

All four match the fix-pass's self-reported results exactly.

---

## Recommendation

**Ready to ship.** No blockers remain, no regressions, no over-reach, and my own
independently-computed contrast math confirms the fix-pass's headline claim (every
text-on-background combination named in the brief's §3a now clears 4.5:1 AA, worst cell
4.60:1, in both themes, across all three accents). File a low-priority follow-up ticket for
the Mint-accent focus-ring non-text contrast gap (§6) — it's cosmetic-adjacent, narrow in
real-world exposure, and doesn't warrant blocking this PR or spinning another `/fixpass`
cycle. Proceed to `/testcheck` (already effectively covered by the vitest re-run above) and
deploy to the idle blue/green color per the project's standard protocol.
