# Redesign PR1 (Seoul Neon) — Design Fidelity + Test-Regression Review

**Reviewer slice:** design fidelity vs `REDESIGN_SEOUL_NEON_BRIEF.md` §3/§5/§6/§7/§9/§10/§11 + §1 constraints, and regression risk in the 4 stale-assertion test updates.

**Scope reviewed:** `client/src/styles/index.css` (single commit `600eeb7`, diffed against its parent `HEAD~1`), `client/index.html`, `client/src/components/Card.tsx`, `client/src/components/Button.tsx`, `client/src/lib/settings.test.ts`, `client/src/hooks/SettingsProvider.test.tsx`, `client/src/hooks/useLanguageDisplay.test.tsx`, `client/src/pages/Settings.test.tsx`, plus their backing production diffs (`client/src/lib/settings.ts`, `client/src/lib/palette-presets.ts`, `client/src/hooks/SettingsProvider.tsx`) to verify the test edits are honest. Full vitest suite executed: **1140/1140 passing**.

## Summary verdict

**No BLOCKERs.** This is a well-executed, token-driven restyle that matches the brief's CSS almost verbatim for §5–§7/§9/§11, and the four "stale" test edits all track genuine, verifiable production-code changes (confirmed by reading the non-test diffs, not just the test comments) — none of them mask a regression. The one real gap is §10 (font-display wasn't wired to the two numeric "stat readout" spots the brief named), and there's a pre-existing accessibility risk the brief itself flagged (§3a contrast) that was not verified/fixed in this pass: five of the six category hues (indigo/moss/ochre/violet/cyan), used directly as small (10–15px) text color on their own `*-soft` tints in the **light** theme, compute at 2.0–4.4:1 contrast against a near-white card — all below the 4.5:1 AA threshold the brief explicitly demanded be checked. That's a SHOULD-FIX for `/fixpass` before this ships, not a blocker on its own (dark theme is fine; nothing here is a data-loss or system-breaking issue), but it's exactly the risk the brief called out by name and it landed unaddressed.

## Brief-section checklist

| Section | Status | Note |
|---|---|---|
| §3 Token blocks | **Done** (values match the brief's drop-in blocks verbatim) — **contrast verification incomplete**, see Findings | New tokens (`--radius*`, `--shadow*`, `--glow`, `--violet`/`--cyan`, `--font-display`, `--gold*` aliases) all present; runtime accent picker (§14a) fully implemented, exceeding the PR1 minimum |
| §5 Cards | **Done** | Hairlines dropped, `box-shadow: var(--shadow)`/`var(--shadow-sm)`, `--radius-lg`, TaskCard hover-lift added exactly per spec |
| §6 Buttons/Pills | **Done** | Pill radius, borderless, `:active{scale(.96)}`, gold fill+glow, ghost soft tint, pills soft-filled — all verbatim |
| §7 BottomNav/Hex | **Done** | Floated glass bar, `24px 24px 0 0`, hex gradient `vermilion-bright→violet`, glow, `--current`/`:focus-visible` glow, `km-hexfloat` idle float; `--open` rotate confirmed still authoritative |
| §9 Body texture | **Done** | Paper-grain dots removed, ambient city-glow radial-gradients added, `background-attachment: fixed` |
| §10 Fonts | **Partial** | Nunito added to `index.html`; `--font-display` applied to h1/h2/.km-btn/.km-bottomnav labels/.km-eyebrow — but NOT wired to the "streak/stat numbers" the brief names (no `font-family` override on `.km-progress__readout-value` or `.km-today__queueCount`; no literal streak UI exists in the app at all) |
| §11 Motion | **Done** | Active-scale, hover-lift, hex-float all correctly no-op under the existing global `prefers-reduced-motion` block; no `!important` fighting it |

## Findings by category

### BLOCKER
None found.

### SHOULD-FIX

1. **§3a contrast requirement (explicitly named in the brief) not verified/fixed — 5 of 6 category hues fail AA as small text in light theme.**
   Computed contrast ratio (WCAG relative-luminance formula) of each category hue against white (`#FFFFFF`, the light-theme card surface these hues sit on as pill/label text):
   - `--indigo #4F7BFF` → 3.74:1
   - `--moss #12C08A` → 2.35:1
   - `--ochre #F7A424` → 2.04:1
   - `--violet #7C5CFC` → 4.38:1
   - `--cyan #0EB8D6` → 2.37:1
   - (control: the CTA fill `--vermilion #E11D48` → 4.70:1, matching the brief's own §3a math — confirms the failing numbers above are real, not a review artifact)
   All are below the 4.5:1 AA floor for small text (10–15px), several badly so (ochre/moss/cyan sit around 2–2.4:1). These hues are used as literal text `color` in numerous places, not just decorative chips:
   `client/src/styles/index.css:607-609` (`.km-pill--red/--green/--ochre`), `:1430` (`.km-skillbar__score--meets`), `:1518` (`.km-skillscompare__pick--ceiling`), `:1607` (`.km-taskcard--red .km-taskcard__skill`), `:2424`/`:2440` (mock verdict/review-pick), `:3084-3085` (review rating labels), `:3234-3235` (review cover icons), `:3765` (hanja statechip count).
   Brief §3a said: "Category text on its own `*-soft` bg: verify ≥4.5:1 … if short, bump pill font-weight/size or darken the text hue. `/fixpass` should confirm." No evidence this verification/fix happened — the hues shipped are the raw §3 swatch values. Dark theme is fine (bright hues on near-black backgrounds land well above AA); this is a light-theme-only issue. Flag for `/fixpass` before deploy — either darken the text-use hue per category (keep the brighter value for icons/glows/chip dots) or bump weight/size per the brief's own suggested remedy.

2. **§10 "streak/stat numbers" font-display target not wired.**
   `client/src/pages/Progress.css:160-163` (`.km-progress__readout-value`) and `client/src/styles/index.css:2907-2912` (`.km-today__queueCount`) — the two closest analogues to "stat numbers" in the actual app — set no `font-family`, so neither picks up `--font-display`. (No literal "streak" UI exists anywhere in `client/src` — `streak_days` is a backend-only metric key — so that half of the brief's phrase is moot, but the stat-readout half is a real, small miss.)

### NIT

3. **Leftover hardcoded hanji-era RGB values not re-tokenized (cosmetic-only, easy to miss).**
   `.km-seal` box-shadow `0 0.5px 0 rgba(27, 24, 19, 0.18)` (`client/src/styles/index.css:621`) and the scrollbar-thumb rules `rgba(27,24,19,0.18)` / `rgba(239,231,208,0.12)` (`:294-297`) still bake in the old sumi-ink RGB triplet (`#1B1813`) instead of a token/`color-mix` expression, so they don't track the new cool-navy `--line*` palette. Visually near-invisible at these alpha values, but inconsistent with the rest of the token-driven pass. Not brief-mandated (§8 misc-surfaces is explicitly deferred to PR2) — noting so it isn't lost.

4. **Ink motifs (`.hr-gold`, `.km-seal`, `.km-goldrule`, `.km-cornermark`, `.km-tian*`) — correctly deferred, but now visually adjacent to a much softer system.**
   These all read `var(--vermilion)`, so they already re-tint with the new palette/accent and don't clash on *color*. But their geometry — 1px hairline rules, a 2px-radius square seal stamp, a hard L-bracket corner mark, dashed diagonal grid lines — is still sharp/linework against the new fully-rounded, shadow-elevated surfaces. The brief explicitly scoped this to PR2 (§8) and asked reviewers to "flag any that look out of place" — flagging per that instruction; **not counted as a PR1 defect**.

5. **Pre-existing pill-class naming quirk, not introduced by this PR.** `.km-pill--red` maps to `--indigo` (blue), not a red hue — this predates the redesign (same mapping existed in the hanji-era sheet) and isn't part of this diff. Noted only for completeness; no action needed here.

### PRAISE

- **§1 constraints fully honored.** Grepped `border:` across every `.km-card*`/`.km-bottomnav*` rule — zero hits; hairlines were cleanly dropped, not just visually hidden. No CSS class names or token names were renamed (confirmed via diff — every changed rule keeps its selector, only values changed).
- **Accent picker (§14a) is a genuine runtime feature, not a token reskin.** `AccentProvider.tsx` mirrors `ThemeProvider` exactly (no-flash bootstrap in `index.html:43-49`, `data-accent` attribute, localStorage persistence), and `--danger` is explicitly pinned to the coral red in both the `blue` and `mint` `[data-accent]` blocks (`client/src/styles/index.css:235-236,251-252,259-260`) so error semantics never re-hue when the user picks a different accent — exactly the constraint §1/§3a asked for.
- **Hexagon `--open` rotate priority verified correct.** The idle-float keyframe animation is scoped to `.km-bottomnav__hex:not(.km-bottomnav__hex--open)` (`client/src/styles/index.css:2151-2153` area / diff line ~505), so when `--open` is applied the animation's own selector stops matching — no specificity war with the static rotate transform, it just cleanly stops owning `transform`. This was worth checking (the brief flagged it as a risk) and it holds.
- **Reduced-motion correctly "just works."** All three new motion additions (button active-scale, TaskCard hover-lift transition, hex idle-float) are covered by the pre-existing global `@media (prefers-reduced-motion: reduce)` block with no new `!important` fighting it — exactly per §11's instruction not to re-litigate that gate.
- **Test-edit honesty confirmed, not assumed.** All four "stale assertion" updates were checked against their backing production diff, not taken on faith:
  - `settings.test.ts` / `SettingsProvider.test.tsx`: the new `expect(vars).toEqual({})` / no-`--vermilion`-projected assertions match a real code change — `ACCENT_PRESETS` was removed from `paletteVars`'s source list (`client/src/lib/settings.ts` diff) and the default presets in `palette-presets.ts` (hanji/moss/vermilion-under-wrong) had their `vars` maps deleted entirely, and `--vermilion`/`--gold*` were removed from `SettingsProvider.tsx`'s `ALLOWED_VARS` allowlist. The reasoning holds: an inline `--vermilion` override would outrank the new `[data-accent]` cascade and freeze the accent.
  - `useLanguageDisplay.test.tsx`: switched from asserting on `accent: 'indigo'` to `wrong: 'slate'` because accent no longer projects at all; the replacement assertion (`--danger` → `#4A4A55`) matches the real `slate` preset definition in `palette-presets.ts:168-175`.
  - `Settings.test.tsx`: wraps renders in the new `AccentProvider` because `Settings.tsx` now calls `useAccent()` — a straightforward test-scaffolding update, not a weakened assertion.
  None of these delete or soften coverage without a paired, verifiable code change; they track the architecture shift honestly.
- **Card.tsx/Button.tsx** — comment-only as instructed; no incidental logic drift. The old "squared corners are deliberate, don't soften them" note is properly retired and replaced with the new rounded/elevated rationale.

## Coordination observations

- §4's new category hues (`--violet`, `--cyan`) are declared but only `--violet` is actually consumed so far (the hex gradient). Wiring them into pill/eyebrow/SkillBar variants for Grammar/Reading isn't itemized in the brief's own §13 PR1 slice list, so this reads as intentionally deferred rather than missed — but whoever picks up that wiring should do it *after* resolving the SHOULD-FIX #1 contrast issue above, since the same "raw hue as small text" trap will recur for violet/cyan the moment they're used as pill text.
- Recommend the `/fixpass` gate for this PR explicitly re-run the six-combination contrast matrix the brief asked for (3 accents × light/dark) — this review only exhaustively checked the fixed category hues (indigo/moss/ochre/violet/cyan) against white; the accent-family fills (`coral`/`blue`/`mint`) were spot-checked and look fine per the brief's own math, but weren't independently recomputed for all six combinations here (out of this reviewer's slice — content/behavior of the accent picker itself belongs to whoever reviews the feature, this slice covered the CSS/token fidelity + test regression only).
