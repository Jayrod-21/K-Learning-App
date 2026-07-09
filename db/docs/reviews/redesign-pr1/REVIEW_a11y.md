# Accessibility / Contrast Review — Redesign "Seoul Neon" PR1

**Reviewer role:** independent senior frontend/a11y reviewer (no prior involvement in this branch)
**Scope:** contrast + reduced-motion + color-semantics only, per `REDESIGN_SEOUL_NEON_BRIEF.md` §1, §3, §3a, §4
**Branch:** `feat/redesign-seoul-neon`
**Files reviewed:** `client/src/styles/index.css` (token blocks + `.km-card`, `.km-btn`, `.km-pill`, `.km-bottomnav__hex`, `.km-taskcard`, `.km-toast`, `.km-install`, error-state classes), `client/src/lib/accent-presets.ts`
**Method:** WCAG 2.1 relative-luminance contrast ratios computed directly from the token hex/rgba values (standard sRGB → linear luminance formula), not eyeballed. Script: `/tmp/contrast.py` (ad hoc, not committed).

---

## Summary verdict

**FAIL — do not ship as-is.** The redesign's accent-pluggability (§14a) multiplies a contrast problem that already existed conceptually in §3a's own math: **every accent, in the default light theme, fails AA (4.5:1) for at least one real on-screen text use**, and the **entire category-color system (indigo/moss/ochre/violet/cyan used as small text on their own `*-soft` chip) fails AA across the board in light theme** — this is bigger than the single instance the builder self-flagged. The builder's self-flagged number (mint-light accent-as-text ≈3.4:1) is **confirmed exactly** (3.39:1 in one real context, 3.11–3.30:1 in others) — but it is not the only failure, and not even the worst one.

- **BLOCKERs found: 5** (grouped; see below — not all 30 individual ratio cells, since many share one root cause)
- **Worst ratio found: 1.87:1** — `--ochre` (#F7A424) as pill text on its own `--ochre-soft` chip, light theme (`.km-pill--ochre`, index.css:609). That is barely above "no contrast at all" for text a user is meant to read (Hanja category label).
- Dark theme is clean throughout (all computed dark-theme combinations pass AA, several by a wide margin).
- Reduced-motion coverage for the new hex-float/hover-lift/active-scale animations is correctly wired (no `!important` fights) — **PRAISE**.
- `--moss` (success) is correctly *not* touched by any `[data-accent]` block — stays green under all 3 accents — **PRAISE**.
- Found an **undocumented semantics bug** beyond what was asked to verify: `--danger` is correctly pinned red in the blue/mint accent blocks, but ~8 real error-state CSS classes (login, TOPIK, diagnostic, grammar, toast, chat) read `var(--vermilion)` directly instead of `var(--danger)` — so under Blue/Mint accents, error UI silently recolors to the *brand* accent instead of staying red. This is in-scope per your item 5 and is a real, currently-shippable bug.
- The pre-existing `--ink`-as-text bug (`.km-toast__message`, `.km-install__title`) is confirmed real (~1.15–1.19:1, i.e. functionally invisible) but is **not new** — pre-redesign values were equally broken (1.07–1.13:1). The redesign neither fixes nor meaningfully worsens it.

---

## Full 3×2 contrast matrix

### 1. Solid CTA fill vs its own text (`--vermilion` bg / `--on-vermilion` text)

| Accent | Theme | Fill | Text | Ratio | AA (≥4.5:1) |
|---|---|---|---|---|---|
| Coral | Light | `#E11D48` | `#FFFFFF` | **4.70:1** | PASS |
| Coral | Dark  | `#FF4D74` | `#0A0C12` | **6.11:1** | PASS |
| Blue  | Light | `#2563EB` | `#FFFFFF` | **5.17:1** | PASS |
| Blue  | Dark  | `#5B8CFF` | `#0A0C12` | **6.18:1** | PASS |
| Mint  | Light | `#0F9E7A` | `#10141F` | **5.42:1** | PASS |
| Mint  | Dark  | `#2BE0A6` | `#0A0C12` | **11.46:1** | PASS |

All 6 fill/text pairs pass — the CSS comment at index.css:132-136 claiming these numbers is accurate. **This part of §3a was done correctly.**

### 2. Accent-as-text (ghost button text / `.km-pill--gold` text) on `--vermilion-soft` composited over card bg (`--ink-1`)

| Accent | Theme | Text | Composited bg | Ratio | AA (≥4.5:1) |
|---|---|---|---|---|---|
| Coral | Light | `#E11D48` | `#FFECF0` | **4.14:1** | **FAIL** |
| Coral | Dark  | `#FF4D74` | `#352133` | 4.63:1 | PASS |
| Blue  | Light | `#2563EB` | `#EDF2FF` | 4.61:1 | PASS |
| Blue  | Dark  | `#5B8CFF` | `#1E2A46` | 4.50:1 | PASS (borderline) |
| Mint  | Light | `#0F9E7A` | `#E7F9F5` | **3.11:1** | **FAIL** |
| Mint  | Dark  | `#2BE0A6` | `#17363A` | 7.58:1 | PASS |

**Coral is the DEFAULT accent and fails this in light mode out of the box.** This is worse than what was self-flagged — the builder only called out mint.

---

## Findings by category

### BLOCKER (AA fail on real text a user reads)

**B1 — Category pill text-on-soft fails AA across the board in light theme (index.css:606-609, `.km-pill--gold/red/green/ochre`)**
Every wired category/accent hue, used as 10px uppercase pill text on its own `*-soft` chip, fails 4.5:1 in light theme:
| Hue | Class | Text | Composited bg (over `--ink-1`) | Ratio |
|---|---|---|---|---|
| indigo (Vocab) | `.km-pill--red` | `#4F7BFF` | `#EDF2FF` | **3.34:1** |
| moss (success) | `.km-pill--green` | `#12C08A` | `#E3F7F1` | **2.11:1** |
| ochre (Hanja) | `.km-pill--ochre` | `#F7A424` | `#FEF4E5` | **1.87:1** ← worst in review |
| violet (Grammar, token-only, no `.km-pill--violet` class yet) | — | `#7C5CFC` | `#EFEBFF` | **3.75:1** |
| cyan (Reading, token-only, no `.km-pill--cyan` class yet) | — | `#0EB8D6` | `#E2F6FA` | **2.12:1** |
All 5 **pass** in dark theme (4.50–7.58:1) — this is a light-theme-only failure. `--ochre` at 1.87:1 is nearly imperceptible; a user with any vision impairment cannot read a "HANJA" pill label in light mode today.

**B2 — Same hues, as text directly on solid `--ink-1` (TaskCard skill eyebrow, `.km-taskcard--gold/red .km-taskcard__skill`, index.css:1599-1607, 11px uppercase)**
| Hue | Text | On `--ink-1` (light `#FFFFFF`) | Ratio |
|---|---|---|---|
| indigo | `#4F7BFF` | `#FFFFFF` | **3.74:1** |
| moss | `#12C08A` | `#FFFFFF` | **2.35:1** |
| ochre | `#F7A424` | `#FFFFFF` | **2.04:1** |
| violet | `#7C5CFC` | `#FFFFFF` | **4.38:1** (just under) |
| cyan | `#0EB8D6` | `#FFFFFF` | **2.37:1** |
All pass in dark (5.50–9.94:1). Only `.km-taskcard--gold`/`--red` are wired today, but the brief's §4 table commits all 6 skills to this pattern — the other 4 hues will fail identically the moment they're wired to `.km-taskcard__skill` unless light-theme values are darkened first.

**B3 — Accent-as-text fails AA in light theme for the DEFAULT accent (Coral) and for Mint** (ghost buttons `.km-btn--ghost` index.css:581-586, `.km-pill--gold` index.css:606, nav active text `.km-bottomnav__cell--active` index.css:713)
- Coral-light: `#E11D48` on soft-over-`ink-1` `#FFECF0` = **4.14:1** (fail)
- Coral-light: `#E11D48` on soft-over-`ink-2` `#F5E4EE` = **3.85:1** (worse — depends on which card surface the button sits on)
- Mint-light: `#0F9E7A` on soft-over-`ink-1` `#E7F9F5` = **3.11:1**, on soft-over-`ink-2` = **2.92:1**, on nav bg (`ink-1` 82% over `ink`) = **3.30:1**
- Mint-light: `#0F9E7A` directly on solid `#FFFFFF` (e.g. `.km-taskcard--gold` if remapped, or any solid-surface usage) = **3.39:1** — this is the exact number the builder self-flagged (≈3.4:1). **Confirmed. Ruling: BLOCKER, not acceptable.** It fails AA on real, frequently-seen UI text (ghost button labels, active nav label, gold pills) every time a user has Mint selected in light mode.
- Blue passes in every tested context (4.33–5.66:1, with one borderline 4.07:1 against `ink-2`).
Because `--vermilion-soft` is a semi-transparent token, the *actual* rendered contrast is not fixed — it depends on what surface sits underneath it (`ink-1` vs `ink-2` vs the blurred nav bar). Several combinations that pass against `ink-1` (blue-dark 4.50, blue-light 4.61) drop below 4.5 against `ink-2` (4.07, 4.33). This is a structural fragility, not just a value-tuning issue (see Coordination Observations).

**B4 — `--danger` semantics silently break under Blue/Mint accents (in-scope per your item 5)**
The token layer is correct: `--danger`/`--danger-soft` are explicitly pinned to coral-red in the `[data-accent="blue"]` and `[data-accent="mint"]` blocks (index.css:160-161, 168-169, 176-177, 184-185), overriding the base `--danger: var(--vermilion)` chain. **But nothing in the app actually reads `--danger`.** Every real error-state class hard-codes `var(--vermilion)` instead:
- `.km-toast--error` (index.css:395-396) + `.km-toast--error .km-toast__icon` (:412)
- `.km-login__error` (:998-1002)
- `.km-topik__state--error` (:2095-2098)
- `.km-diagnostic__state--error` (:2453-2456)
- `.km-grammar__state--error` (:2715-2718)
- `.km-chat__dictNotice--error` (:3509)
- `.km-chat__historyError` (:3646, uses vermilion further in its rule body)

Net effect: under Blue or Mint accent, login errors, TOPIK/diagnostic/grammar error states, error toasts, and chat error notices all render in the *brand accent color* (blue or mint) instead of red. This directly violates the brief's own hard constraint (§1: "`--danger` = error → keep red-ish… even blue/mint"). The `--danger` token exists specifically to prevent this and is simply not wired up. Zero contrast-ratio impact (blue/mint values pass fine as colors) — this is a pure semantics/consistency bug, but it's exactly what item 5 asked me to verify, so it's reported as a blocker on the "verify --danger isn't recolored to the accent" question: **it is recolored.**

**B5 — `--ink` used as text color (`.km-toast__message` index.css:420, `.km-install__title` index.css:495) — PRE-EXISTING, confirmed still broken**
`--ink` is the app's base *background* token (page bg), not a text color. Used as `color`, against the card's actual `--ink-1` background:
- Light: `#E7ECF5` text on `#FFFFFF` bg = **1.19:1**
- Dark: `#080A11` text on `#141A28` bg = **1.14:1**
Both are functionally invisible (a hairline off from the background itself). **Ruling: pre-existing, not introduced by this PR** — I checked the pre-redesign values (commit `e34faa1`, old `--ink #E8DFC5` / old `--ink-1 #F3ECD5` light, `--ink #15110D` / `--ink-1 #1E1812` dark) and computed the same pair: **1.13:1 (light) / 1.07:1 (dark)** — equally broken before this branch touched the file. The redesign neither fixes nor meaningfully worsens it (moves from ~1.1 to ~1.15-1.19, still catastrophically failing). Still counts as a live BLOCKER in the shipped app today, and since this PR is already editing every token in this file, it's a cheap, in-scope fix to bundle (`--paper` or `--paper-dim`, not `--ink`).

### SHOULD-FIX

**S1 — `--vermilion-soft`'s effective contrast is surface-dependent, not fixed**
Because the soft tokens are alpha-composited rgba values, the same "ratio" quoted in the CSS comment (index.css:132-136) only holds against the one background the author mentally composited against. In practice `.km-btn--ghost`/`.km-pill--gold` render on `--ink-1` in some screens and `--ink-2` in others (e.g. inside `.km-card--flat`), and the ratio swings meaningfully (e.g. blue-dark: 4.50 → 4.07 crossing the AA line). Recommend either (a) picking one canonical host surface for all soft-chip usage and enforcing it, or (b) bumping alpha/darkening the text hue enough that it clears 4.5:1 against the *lightest* plausible host surface, with margin.

**S2 — `.km-pill--red` naming vs. semantics mismatch**
`.km-pill--red` maps to `--indigo` (blue), not red — legacy naming carried over from the old palette. Not an a11y issue, but worth flagging since it's adjacent to the danger/color-semantics review (B4): a future maintainer skimming class names could reasonably assume `--red` variants are error-related.

**S3 — Violet/Cyan (Grammar/Reading) have zero CSS consumers yet**
Tokens exist (`--violet`, `--violet-soft`, `--cyan`, `--cyan-soft`) but no `.km-pill--violet`/`.km-pill--cyan` class and no `.km-taskcard--violet`/`--cyan` variant exist in index.css. Not a contrast bug (nothing renders yet), but flagging so the *same* light-theme contrast failures (B1/B2 patterns) get caught before these are wired up, not after.

### NIT

**N1 — Ambient body-glow (§9) vs. text legibility**
The new ambient radial-gradient body background (index.css ~200, 10% `--vermilion-bright`/`--indigo` alpha at fixed corners) sits behind the whole app. Any text rendered directly on `body`/`#root` rather than inside a card would have a very slightly reduced contrast at the gradient's peak (roughly ±2-3% luminance shift at 10% alpha, 70% falloff). I did not find any component rendering primary text directly on raw body background (everything I checked sits on `--ink-1`/`--ink-2` cards), so this is a non-issue in practice — flagging only because the brief explicitly asked to "verify text legibility over it both themes."

### PRAISE

**P1 — Reduced-motion coverage is correctly wired for every new animation**
Checked `km-hexfloat` (index.css:771-777), `.km-taskcard:hover` lift (index.css:1584-1590), and `.km-btn:active` scale (index.css:568). All three use `animation`/`transition` (never bare JS-driven motion), and all are covered by the existing global block (index.css:307-316) which zeroes `animation-duration`, `animation-delay`, `animation-iteration-count`, and `transition-duration`/`transition-delay` with `!important`. No new `!important` was added anywhere that could fight this block. The hex-float-vs-rotate interaction (float animation scoped via `:not(.km-bottomnav__hex--open)`, rotate applied via a separate, non-conflicting selector) is correctly designed so the two never fight over the `transform` property.

**P2 — `--moss` (success) is correctly accent-independent**
Confirmed by grep: `--moss`/`--moss-soft` never appear inside any `[data-accent="..."]` block. Success color stays green regardless of which accent the user has selected, matching the §1 hard constraint exactly.

**P3 — CTA fill/text contrast (§3a's primary ask) is solid**
All 6 accent×theme combinations for the solid button fill pass AA with real margin (4.14 lowest → wait, that's the soft case; solid fill lowest is 4.70:1). The dark-theme "bright fill + dark ink text" strategy is a good, deliberate high-contrast pattern, and it's applied consistently across all 3 accents.

---

## Coordination observations

- The single most valuable fix for the next iteration: **darken the light-theme category hues** (indigo/moss/ochre/violet/cyan) enough that they clear 4.5:1 as small text on their own soft/solid light backgrounds — this alone resolves B1 and B2, the two biggest-blast-radius findings. The dark-theme values are fine as-is; only light needs adjustment. This mirrors exactly what §3a already did for the CTA fill (deepen for light, brighten for dark) — it just wasn't extended to the category hues or to the vermilion-as-text (ghost/pill) case.
- Recommend wiring `.km-toast--error`/`.km-login__error`/etc. to `var(--danger)`/`var(--danger-soft)` instead of `var(--vermilion)`/`var(--vermilion-soft)` — a small, mechanical find-and-replace that fixes B4 completely and actually uses the `--danger` token the brief and this PR's own CSS comment (index.css:127-130) claims already protects this.
- Suggest a lightweight CI/test check (even a simple node script asserting ratios ≥4.5 for the known text/bg token pairs) so this class of regression doesn't require a manual audit every time an accent or category hue value changes — six accent×theme combinations plus five category hues is thirty checks that are more reliably caught by script than by /fixpass review each time.
- This review did not evaluate the Settings accent-picker UI, persistence, or state wiring (§14a feature work) — out of scope for the accessibility/contrast slice; flag to whichever reviewer owns that slice.

---

## Appendix — computed values reference

Tokens used (verified against `client/src/styles/index.css` lines 19-186):
- Light surfaces: `--ink #E7ECF5`, `--ink-1 #FFFFFF`, `--ink-2 #F4F7FC`
- Dark surfaces: `--ink #080A11`, `--ink-1 #141A28`, `--ink-2 #1B2233`
- Accent presets: coral/blue/mint × light/dark, per index.css:143-186
- Category hues: indigo/moss/ochre/violet/cyan × light/dark, per index.css:47-51, 103-107

Full computed output (all combinations, including the ink-2 sensitivity check) is in the "Full 3×2 contrast matrix" and "Findings" sections above; raw script output available on request.
