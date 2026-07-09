# Fix-Pass Report — Redesign "Seoul Neon" PR1

**Branch:** `feat/redesign-seoul-neon` (fix commit on top of `600eeb7`)
**Scope:** every BLOCKER + SHOULD-FIX from the three reviews (`REVIEW_a11y.md`, `REVIEW_cascade.md`, `REVIEW_fidelity.md`), except the one deferral called out below.
**Verification:** from-scratch WCAG 2.1 luminance/contrast script (`/tmp/km_fix_contrast.py` + verify run below), then `tsc` / `eslint` / `vitest` / `vite build`.

---

## Fix strategy (contrast blockers)

Per brief §3a ("darken the text hue"), the fix introduces **on-surface TEXT twins** for every hue that renders as small foreground text, instead of darkening the shared hue tokens (which are also fills, chip tints, borders, glows, and gradients — darkening them would have wrecked the CTA fill + hex gradient):

- `--indigo-ink / --moss-ink / --ochre-ink / --violet-ink / --cyan-ink / --vermilion-ink / --danger-ink` — **new tokens only; zero renames** (§1 constraint honored).
- **Light values are deepened** so each computes ≥ 4.5:1 on the *darkest* light-theme host it can sit on: its own `*-soft` tint composited over `--ink-2`, and for the accent even the 16% ghost-hover `color-mix`. This also resolves the a11y review's S1 (surface-dependent soft contrast) — the values clear the worst plausible host with margin, not just `--ink-1`.
- **Dark values are brightened (or passed through)** so each clears 4.5:1 even on `*-soft` over `--ink-3` (popovers/sheets — the lightest dark host). Dark previously passed only against `--ink-1`; blue-dark was already 4.07:1 over `--ink-2` per the review's own S1 note, so pass-through alone was not enough for indigo/violet/coral/blue.
- `--moss-ink` and `--danger-ink` are **`color-mix()`-derived** from `--moss`/`--danger` so they keep tracking the user-projectable `CORRECT_PRESETS`/`WRONG_PRESETS` inline overrides (a literal would have silently detached pill/verdict text from the user's chosen correct/wrong color).
- `--vermilion-ink` is defined per accent in all six `[data-accent]`/`[data-theme="dark"][data-accent]` blocks (same cascade pattern as the other accent tokens, so light accent values can't leak into dark).
- Every `color: var(--vermilion)` foreground site (39 rules) now reads `--vermilion-ink`; every category-hue foreground site reads its `-ink` twin. Fills, soft chip backgrounds, borders, `outline` (`.focusring`), `accent-color`, gradients, and glows still read the bright base hues — the neon look is unchanged where it was safe.

---

## Findings → dispositions

### REVIEW_a11y.md (was FAIL)

| # | Finding | Disposition |
|---|---|---|
| B1 | Category pill text on `*-soft` fails AA across the board, light theme | **FIXED** — `.km-pill--red/--green/--ochre` (and `--gold`) read the `-ink` twins; worst cell went 1.87 → 4.99 (ochre, soft/ink-1). See matrix. |
| B2 | Same hues as text on solid `--ink-1` (TaskCard eyebrows) | **FIXED** — `.km-taskcard--gold/--red .km-taskcard__skill` → ink twins; every hue ≥ 5.4:1 on white now. Violet/cyan twins exist ahead of their first consumer (see S3). |
| B3 | Accent-as-text fails AA light (coral 4.14, mint 3.11–3.39) | **FIXED** — ghost buttons, gold pills, active nav label, and every other accent-as-foreground rule now read `--vermilion-ink` (coral `#BB183C`, blue `#1554DF`, mint `#0B7258` light; `#FF7190`/`#7AA2FF`/`#5BF0C0` dark). Mint-light worst case 2.66 → 4.62. |
| B4 | Error UI hardcodes `--vermilion`, re-hues under Blue/Mint accents | **FIXED** — all 8 listed classes (`.km-toast--error`+icon, `.km-login__error`, `.km-topik__state--error`, `.km-diagnostic__state--error`, `.km-grammar__state--error`, `.km-chat__dictNotice--error`, `.km-chat__historyError`) now read `--danger`/`--danger-soft`/`--danger-ink`. The grep-for-all also caught six more genuine danger contexts: `.km-topik__choice--wrong`, `.km-diagnostic__choice--wrong`, `.km-mock__review-item--wrong`, `.km-mock__verdict--wrong`, `.km-images__upload-error`, `.km-progress__delta--down` (Progress.css). Hero/CTA uses of `--vermilion` untouched. Error *text* uses `--danger-ink` (plain `--danger` as text is itself only 4.14:1 on its soft bg — wiring it verbatim would have created a fresh AA fail). |
| B5 | `--ink` (a bg token) used as text — toast message / install title invisible | **FIXED** — `.km-toast__message`, `.km-install__title` → `color: var(--paper)` (18.4:1 light / 15.5:1 dark). Two more same-class sites found while in the file and fixed the same way: `.km-toast__dismiss:hover` (→ `--paper`) and `.km-resources__initial:hover` (→ `--vermilion-ink`, matching its `.is-active` state). The `.km-images__thumb-line`/`capture-line` `--ink` usages are intentional scene-text over gradient placeholders and were left alone. |
| S1 | Soft-token contrast is host-surface-dependent | **FIXED** — via option (b) from the review: ink values are verified against the *worst* plausible host (light: soft-over-`--ink-2` + 16% hover mix; dark: soft-over-`--ink-3`), all with margin. |
| S2 | `.km-pill--red` naming vs semantics | **FIXED (comment)** — renaming classes is prohibited by §1; a NOTE now sits on the pill variants stating `--red` maps to `--indigo` (Vocab), not the danger red. |
| S3 | Violet/cyan have zero consumers; same trap awaits | **FIXED (proactively)** — `--violet-ink`/`--cyan-ink` exist in both theme blocks (verified in the matrix), and the pill comment directs future `.km-pill--violet/--cyan` variants at them. No consumer classes invented (out of PR1 scope). |
| N1 | Ambient body-glow vs legibility | No action — reviewer confirmed non-issue (no primary text on raw body bg). |
| P1–P3 | Reduced motion / `--moss` accent-independence / CTA fill contrast | **INTACT** — no `[data-accent]` block touches `--moss*`; reduced-motion block untouched; all 6 CTA fill/text pairs re-verified (table below). |

### REVIEW_cascade.md (was PASS)

| # | Finding | Disposition |
|---|---|---|
| SF1 | Accent choice doesn't sync across devices | **DEFERRED (by instruction)** — accepted product tradeoff, consistent with the `km.theme` localStorage-only precedent; extending the server `AccentPreset` PrefsSchema enum (or adding a `runtimeAccent` field) is out of PR1 scope. Flagged for a follow-up product decision. |
| SF2 | Dead `--green`/`--green-light` in allowlist + presets | **FIXED** — removed from `CORRECT_PRESETS` pine/teal `vars`, from `ALLOWED_VARS`, and the two tests that pinned them updated to assert the tokens are now *absent* (`settings.test.ts`, `SettingsProvider.test.tsx` — spot-check moved to the live `--moss-soft`). Grep re-confirmed zero `var(--green` readers in client+server. |
| N1 | Cascade comment doesn't call out the light/dark asymmetry | Not addressed (NIT, optional) — the accent header comment did gain a `--vermilion-ink` paragraph, but the asymmetry note was left as-is to keep the diff tight. |
| N2 | AccentProvider/ThemeProvider duplication | Not addressed (NIT, explicitly "not required for this PR"). |
| P1–P3 | ACCENT_PRESETS carries no vars; allowlist defence-in-depth; combo-block specificity | **INTACT** — `ACCENT_PRESETS`, `paletteVars()` sources, and the accent-token exclusions in `ALLOWED_VARS` untouched; the clobber regression tests still pass unmodified (only the `--green` assertions changed, per SF2). |

### REVIEW_fidelity.md (no blockers)

| # | Finding | Disposition |
|---|---|---|
| SF1 | 5 of 6 category hues fail AA as small light-theme text | **FIXED** — same fix as a11y B1/B2; every listed consumer repointed: pills, `.km-skillbar__score--meets`, `.km-skillscompare__pick--ceiling`, TaskCard skills, mock verdict/review-pick, review rating labels, review cover icons, review sourceStatus, hanja statechip counts, Progress deltas, `.km-mastery__stale`. |
| SF2 | §10 display font never wired to stat numbers | **FIXED** — `font-family: var(--font-display)` added to `.km-progress__readout-value` (Progress.css), `.km-today__queueCount`, and the sibling stat readout `.km-hanja__statechip-count`. (No literal "streak" UI exists — confirmed by the review.) |
| N3 | Leftover hanji-era RGB in `.km-seal`/scrollbar | Not fixed — §8 misc-surface retint is PR2 by design. Same bucket: `.km-today__queue:hover`'s `rgba(184,58,46,0.16)`. |
| N4 | Ink motifs geometry vs soft system | Not fixed — explicitly PR2 (§8), flagged per the brief's instruction. |
| N5 | `.km-pill--red` naming quirk | **FIXED (comment)** — same as a11y S2. |
| PRAISE | §1 constraints, accent picker, hex rotate, reduced motion, test-edit honesty | **INTACT** — no class/token renamed, no provider touched, no motion rules changed. |

---

## Contrast matrix — before → after (WCAG 2.1, computed)

Hosts: `soft/inkN` = the hue's own `*-soft` tint alpha-composited over `--ink-N`; `hover16/ink2` = the ghost button's 16% `color-mix` hover bg over `--ink-2`; `raw --ink` = page background. **Bold** = previously failing cell.

### Light theme — category hues as small text

| Hue (light) | before → after value | soft/ink-1 | soft/ink-2 | white |
|---|---|---|---|---|
| indigo | `#4F7BFF` → `#1C55FF` | **3.34 → 4.94** | **3.12 → 4.62** | **3.74 → 5.54** |
| moss | `#12C08A` → `color-mix(62%, #000)` = `#0B7756` | **2.11 → 4.98** | **1.98 → 4.67** | **2.35 → 5.54** |
| ochre | `#F7A424` → `#965D05` | **1.87 → 4.99** | **1.76 → 4.68** | **2.04 → 5.43** |
| violet | `#7C5CFC` → `#643EFB` | **3.77 → 4.98** | **3.53 → 4.66** | **4.38 → 5.79** |
| cyan | `#0EB8D6` → `#097285` | **2.13 → 5.02** | **2.00 → 4.71** | **2.37 → 5.59** |

### Light theme — accent as text (`--vermilion-ink`)

| Accent (light) | before → after value | soft/ink-1 | soft/ink-2 | hover16/ink-2 | white |
|---|---|---|---|---|---|
| Coral (default) | `#E11D48` → `#BB183C` | **4.13 → 5.58** | **3.86 → 5.22** | **3.41 → 4.60** | 4.70 → 6.35 |
| Blue | `#2563EB` → `#1554DF` | 4.61 → 5.57 | **4.31 → 5.21** | **3.87 → 4.67** | 5.17 → 6.24 |
| Mint | `#0F9E7A` → `#0B7258` | **3.12 → 5.42** | **2.92 → 5.08** | **2.66 → 4.62** | **3.39 → 5.90** |

### Light theme — danger as error text (`--danger-ink`)

| | before → after value | dsoft/ink-1 | dsoft/ink-2 | raw `--ink` |
|---|---|---|---|---|
| danger | `#E11D48` → `color-mix(90%, #000)` = `#CA1A41` | **4.13 → 4.93** | **3.86 → 4.61** | **3.96 → 4.72** |

### Dark theme — category hues as small text

| Hue (dark) | before → after value | soft/ink-1 | soft/ink-2 | soft/ink-3 |
|---|---|---|---|---|
| indigo | `#5B8CFF` → `#7AA2FF` | 4.50 → 5.72 | **4.08 → 5.19** | **3.64 → 4.62** |
| moss | unchanged `#2BE0A6` | 7.60 | 6.87 | 6.10 |
| ochre | unchanged `#FFB43D` | 7.40 | 6.69 | 5.95 |
| violet | `#9B7CFF` → `#AE96FF` | 4.56 → 5.84 | **4.13 → 5.29** | **3.68 → 4.72** |
| cyan | unchanged `#33D6EF` | 7.41 | 6.69 | 5.94 |

### Dark theme — accent as text (`--vermilion-ink`)

| Accent (dark) | before → after value | soft/ink-1 | soft/ink-2 | soft/ink-3 | hover16/ink-2 |
|---|---|---|---|---|---|
| Coral | `#FF4D74` → `#FF7190` | 4.63 → 5.66 | **4.22 → 5.16** | **3.78 → 4.62** | **4.11 → 5.02** |
| Blue | `#5B8CFF` → `#7AA2FF` | 4.50 → 5.72 | **4.08 → 5.19** | **3.64 → 4.62** | **3.95 → 5.03** |
| Mint | `#2BE0A6` → `#5BF0C0` | 7.60 → 9.06 | 6.87 → 8.18 | 6.10 → 7.27 | 6.54 → 7.79 |

### Dark theme — danger as error text

| | before → after value | dsoft/ink-1 | dsoft/ink-2 | dsoft/ink-3 |
|---|---|---|---|---|
| danger | `#FF4D74` → `color-mix(80%, #fff)` = `#FF7190` | 4.63 → 5.64 | **4.22 → 5.14** | **3.78 → 4.61** |

Note on "dark stayed passing": the a11y review's dark PASS verdict was computed against `--ink-1`. This fix keeps every previously-passing dark cell passing and *additionally* clears the lighter `--ink-2`/`--ink-3` hosts the review's S1 flagged (blue-dark was already 4.07 over `--ink-2` pre-fix).

### `--ink`-as-text fix (B5)

| Site | before → after | ink-1 | error-toast bg | success-toast bg |
|---|---|---|---|---|
| toast/install text, light | `--ink #E7ECF5` → `--paper #10141F` | **1.19 → 18.39** | **1.04 → 16.18** | **1.07 → 16.53** |
| toast/install text, dark | `--ink #080A11` → `--paper #EDF2FF` | **1.14 → 15.52** | **1.33 → 13.23** | **1.53 → 11.57** |

### CTA fill/text pairs (unchanged — re-verified)

Coral L 4.70 / D 6.11 · Blue L 5.17 / D 6.18 · Mint L 5.42 / D 11.46 — all ≥ 4.5:1.

**Worst post-fix ratio anywhere in the matrix: 4.60:1** (coral-light ghost-button hover). Every cell ≥ 4.5:1; the script exits non-zero on any cell below 4.5 and exited clean.

---

## Gate results (post-fix)

```
npx tsc -p tsconfig.app.json --noEmit   → 0 errors
npm run lint                            → 0 errors / 0 warnings
npx vitest run                          → Test Files 96 passed (96) · Tests 1140 passed (1140)
npx vite build --outDir /tmp/km-fix-dist → ✓ built (PWA precache 15 entries)
```

Test edits made (both tracking the SF2 dead-token removal, no coverage softened):
- `client/src/lib/settings.test.ts` — `vars['--green']` `#2E5B3E` → `toBeUndefined()` (+ `--green-light`).
- `client/src/hooks/SettingsProvider.test.tsx` — allowlist spot-check moved from the removed `--green-light` to the live `--moss-soft`; now also asserts `--green-light` does NOT land.

## Files changed

- `client/src/styles/index.css` — ink-twin tokens (both theme blocks + all six accent blocks), 39 accent-as-text repoints, 16 category-text repoints, 14 danger-family repoints, 3 `--ink`-as-text fixes, 2 `font-display` additions, pill-naming comment.
- `client/src/pages/Progress.css` — delta up/down + mastery-stale ink repoints, readout-value `font-display`.
- `client/src/hooks/SettingsProvider.tsx` / `client/src/lib/palette-presets.ts` — dead `--green*` removal.
- `client/src/lib/settings.test.ts` / `client/src/hooks/SettingsProvider.test.tsx` — assertions updated per above.
