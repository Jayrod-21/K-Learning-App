# Review: Token architecture — Seoul Day/Night foundation

Reviewer: independent senior front-end review (token/cascade correctness only). Scope: `client/src/styles/index.css` + `client/src/styles/seoul-devices.css` as of commit `c525288` on `feat/redesign-foundation` (off `rebuild`), against `DESIGN_SEOUL_DAY_NIGHT.md`. Code not modified.

## Summary verdict: **PASS**

The theme-override cascade is provably correct in both directions, the var-chain has no dangling or circular references, `--ink`/`--paper` surface/text meaning is preserved for all ~30 existing components, and `tsc --noEmit` plus the live contrast guard (`tokensContrast.test.ts`, 28/28) both pass clean. The structural implementation deviates from the doc's literal "define on `:root`, redefine under the media query, redefine again under `:root[data-theme=dark]` **and** `:root[data-theme=light]`" three-layer prescription — it merges the base and explicit-light layers into one rule and uses `:root:not([data-theme])` for the media-query layer instead of a third plain `:root[data-theme]` pair. I traced this alternate structure by hand against CSS specificity/cascade rules and it produces the correct result in every case tested (see trace below). Two SHOULD-FIX items and a handful of NITs below are the difference between this and a clean bill.

## Theme-override trace (light-OS→force-dark, dark-OS→force-light)

Selectors involved (`client/src/styles/index.css`):
- Base: `:root, [data-theme="light"]` — line 44 — specificity (0,1,0) per matched branch.
- Explicit dark: `[data-theme="dark"]` — line 174 — specificity (0,1,0), later in source.
- No-JS/no-attr fallback: `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` — line 264 — specificity (0,2,0) (`:root` + `:not()`'s argument specificity), later still.

Four cases, all confirmed correct:
1. **Light OS, no explicit choice (first paint, no `data-theme` yet):** media query doesn't match (OS isn't dark) → base rule (line 44) applies via the `:root` branch → Day. Correct.
2. **Dark OS, no explicit choice (first paint):** media query matches, `:root:not([data-theme])` (0,2,0) beats the base rule's `:root` branch (0,1,0) at the same element → Night applied even though `:root, [data-theme="light"]` also matched. Correct — this is the "no-flash" fallback the doc requires, and in practice `client/index.html:34-62`'s inline bootstrap script sets the real `data-theme` attribute synchronously before first paint anyway, so this path only theoretically matters between the media-query evaluation and the (synchronous, same-tick) script execution.
3. **Light OS, forced dark (`data-theme="dark"` set):** media query is irrelevant here since it only overrides `--vermilion`-family etc for the *default* case; the explicit `[data-theme="dark"]` block (line 174) and the base block (line 44) are equal specificity (0,1,0) and both match the `<html>` element (`:root` always matches the root regardless of attributes) — `[data-theme="dark"]` is later in source, so it wins the cascade. Night applied regardless of OS. Correct.
4. **Dark OS, forced light (`data-theme="light"` set):** the fallback media rule's selector is `:root:not([data-theme])` — the moment ANY `data-theme` attribute exists (including `="light"`), `:not([data-theme])` stops matching, full stop, independent of OS state. So the media block drops out entirely and only the base rule (line 44, matching via its `[data-theme="light"]` branch) applies. Day applied regardless of OS. Correct.

This is airtight for the four cases that matter. The one thing I'd flag (see SHOULD-FIX #1) is that this correctness depends on the `:not([data-theme])` guard specifically — it is not the literal 3-layer structure the design doc describes, and a future editor who doesn't re-derive this reasoning could "simplify" it into something that reintroduces a specificity war (e.g., replacing `:not([data-theme])` with a plain `:root` inside the media query, which would then tie 0,1,0 vs 0,1,0 with the explicit blocks and fall back to source order instead of intent). Worth a code comment addition (see below) rather than a rewrite — the current code is correct, just fragile to well-intentioned refactors that don't understand why `:not()` is there. (The existing comment at index.css:259-263 already explains this reasonably well — this is a NIT to make it even more explicit, not a gap.)

I also verified (`client/src/hooks/ThemeProvider.tsx:54-107`) that once React mounts it always writes a concrete `'light'` or `'dark'` value — never removes the attribute, even in "system" mode — so the `:not([data-theme])` fallback path is genuinely first-paint-only in the running app, matching its doc comment.

## Var-chain audit

All legacy names resolve to a real value in both themes; no dangling `var()`, no circular chain. "Day" / "Night" columns show the terminal literal each chain bottoms out at.

| Old/legacy token | Chains through | Day resolves to | Night resolves to |
|---|---|---|---|
| `--vermilion` | → `--dan-verm` (Day) / `--neon-coral` (Night) | `#C0492E` | `#FF3E6C` |
| `--vermilion-bright` | → `--dan-verm` / `--neon-coral-bright` | `#C0492E` | `#FF6B8A` |
| `--vermilion-soft` | → `--dan-verm-soft` / `--neon-coral-soft` | `#F3E0D6` | `#2C1420` |
| `--vermilion-ink` | → `--dan-verm-ink` / `--neon-coral-bright` | `#AB4129` | `#FF6B8A` |
| `--on-vermilion` | literal (not chained) | `#FFFFFF` | `#0A0C12` |
| `--danger` / `--danger-soft` / `--danger-ink` | → `--dan-verm*` / `--neon-coral*` | resolves | resolves |
| `--indigo` / `--indigo-soft` / `--indigo-ink` | → `--dan-cobalt*` / `--neon-blue*` | resolves | resolves |
| `--moss` / `--moss-soft` / `--moss-ink` | → `--dan-jade*` / `--neon-mint*` | resolves | resolves |
| `--ochre` / `--ochre-soft` / `--ochre-ink` | → `--dan-ochre*` (Day) / `--neon-amber*` (Night) | resolves | resolves |
| `--violet` / `--cyan` (+`-soft`/`-ink`) | literal (doc has no dancheong/neon counterpart) | resolves | resolves |
| `--gold` / `--gold-light` / `--gold-soft` | → `--vermilion` / `--vermilion-bright` / `--vermilion-soft` | resolves (via active theme+accent) | resolves |
| `--focus-ring` | → `--vermilion` | resolves | resolves (never redefined in the dark block — correctly inherits by chaining, see note below) |
| `--ink` / `--ink-1/2/3` | literal | resolves | resolves |
| `--paper` / `--paper-dim/mute/faint` | literal | resolves | resolves |
| `--line` / `--line-strong` | literal | `#E0D6BF` / `#C9BC9C` | `rgba(255,255,255,.08)` / `.16` |
| `--radius-lg` | → `--radius-card-day` / `--radius-card-night` | `8px` | `18px` |
| `--card-hairline` | literal | `1px solid var(--line)` | `none` |
| `--shadow*` / `--glow` | literal (Night's `--glow` chains to `--vermilion-bright`) | resolves | resolves |

Notable non-bug I traced carefully because it looked suspicious at first: `--gold*` and `--focus-ring` are declared **only once**, in the base `:root, [data-theme="light"]` block, and are never redeclared in `[data-theme="dark"]` or the media fallback. This is safe, not a gap — `--gold: var(--vermilion)` is a live `var()` reference, resolved at used-value time against whatever `--vermilion` is cascaded on that element right now, not evaluated at declaration time. Since `:root` always matches the root element (regardless of `data-theme`), this one declaration stays live in every theme and correctly follows whichever `--vermilion` (dan-verm or neon-coral) is currently active. Confirmed no double-declaration or override elsewhere fights it.

Palette-layer tokens `--dan-jade/verm/cobalt/ochre` (+`-soft`+`-ink`) are Day-only by design (no Night equivalent name) and `--neon-coral/blue/mint/amber` (+`-bright`+`-soft`) are Night-only — this is intentional per the doc (two distinct palettes, not a shared name reused per theme) and every actual *consumer* of these raw names (`--km-tone`, `CityCard.css`, `DancheongRail.css`, `SkylineHeader.css`) is itself theme-gated with `[data-theme="dark"] …` overrides at higher specificity, so there is no leak (e.g. `.km-tone--blue { --km-tone: var(--dan-cobalt); } [data-theme="dark"] .km-tone--blue { --km-tone: var(--neon-blue); }` in `client/src/styles/seoul-devices.css:157-161`).

## Backward-compat: did any existing consumer's token value change meaning?

**No.** Verified two ways:
1. The file's own header note (`index.css:34-41`) states explicitly that `--ink*` stays the surface family and `--paper*` stays the text family in this sheet (the inverse of the design doc's own vocabulary, on purpose) — I did not take this on faith; I read the actual hex values in both the light block (`--ink:#EFE7D6` bg / `--paper:#27331F` text) and dark block (`--ink:#07080F` bg / `--paper:#EAEEFB` text) and confirmed `--ink*` is always the darker-relative-to-`--paper*` background family in Day and the near-black background family in Night, i.e. surface semantics held in both themes.
2. Grepped every existing (non-token, non-new-device) consumer of `--line`, `--radius-lg`, `--vermilion`, `--gold*` across `client/src` — all read them as plain `var()` references for `border`/`background`/`stroke`/`border-radius`; none hardcode an assumption about the token's previous literal value (e.g. no code computing `calc(var(--radius-lg) - Npx)` against the old 22px, no code assuming `--line` is translucent rgba rather than opaque hex).

Two token VALUES did change substantively (not just re-tint) and are worth calling out even though meaning held:
- `--radius-lg` went from a flat `22px` to a per-theme derived `8px` (Day) / `18px` (Night). Every existing consumer (`CollapsibleTile.css:31`, `Review.css:15`, several `.km-card`/popover rules in `index.css`) will visibly change shape the instant this token PR ships, in both themes, on pages nobody has reskinned yet. This is explicitly what the design doc specifies (§2: "Day squarer ~8px, Night rounder ~18px") — not a bug — but see Coordination observations below.
- `--line` (Day) changed from a translucent `rgba(20,30,60,0.08)` to an **opaque** `#E0D6BF`. All ~25 existing consumers (`Chat.css`, `Progress.css`, `Grammar.css`, `Reading.css`, `Review.css`, `Tabs.css`, `Settings.css`, `WritingTopicGenerator.css`, `LineChart.css`) use it as a flat `border`/`stroke`/`background` color, so this doesn't break anything mechanically, but it does lose the old adaptive alpha-blend-with-whatever's-behind-it look on any nested/translucent surface. Doc-mandated (§2 gives `--line` as a literal opaque hex), just worth a visual QA pass on nested surfaces (popover-over-sheet, etc.) during the fixpass, since none of those 25 files were touched by this commit and none were visually verified as part of it.

## Findings

**BLOCKER:** none.

**SHOULD-FIX:**
1. `index.css:33` (comment) / structural choice at `index.css:264-302` — the `:not([data-theme])` media-query fallback is the load-bearing mechanism that makes the whole two-direction override provably correct, but the code comment (`index.css:259-263`) undersells *why* removing `:not()` would silently reintroduce a specificity tie decided by source order instead of intent. Recommend strengthening the comment with a one-line "if you touch this, don't drop `:not([data-theme])`" warning, since the current structure is correct but non-obvious and diverges from the doc's literal spec.
2. `CityCard.css:34-38, 48` — the Night gradient body (`rgba(30, 37, 66, 0.85)`, `rgba(16, 20, 40, 0.9)`) and the `km-tone--plain` border (`rgba(255, 255, 255, 0.12)`) are hand-picked literal colors rather than token-derived (e.g. `color-mix(in srgb, var(--ink-1) …, transparent)`), which is exactly the "no hard-coded hex in component CSS" rule this file's own header comment (line 24: "Token-driven only (no hard-coded hex — see CityCard.css)") claims to follow. They're close to but not identical to `--ink-1`/`--ink-2` — worth confirming this was a deliberate aesthetic choice (translucent gradient over whatever the ambient body glow is doing) rather than an oversight, and tokenizing if not.

**NIT:**
- `index.css:195-208` / `264-302` — the `--neon-amber` pair is a legitimate extension consistent with the doc's semantic-triad description (§2: "mint/amber/coral in Night" for good/warn/critical) but is not literally listed in the doc's §2 Night palette block (which only enumerates coral/blue/mint). Not a fabrication — it's reused verbatim from the pre-existing (pre-redesign) dark `--ochre` value — but a future doc reader diffing the CSS against §2's four-line code block will notice a 4th color with no matching line there. Consider a one-line doc update or CSS comment cross-reference.
- The design doc's "semantic good/warn/critical" concept has no dedicated `--good`/`--warn`/`--critical` tokens in the codebase — it's implemented by reusing the existing `--moss`/`--ochre`/`--danger` skill-hue/accent tokens (which is what the file's own comments say, and matches "Hanja already used ochre" reasoning), so `--ochre` does double duty as both the Hanja skill hue and the "warn" semantic. Not a defect, just worth knowing if a future component wants "warn" independent of whatever accent Hanja happens to be using.
- `seoul-devices.css` is `@import`ed at the very top of `index.css` (line 2), before any token block — functionally fine (CSS custom-property resolution is cascade-based, not import-order-based, so `var()` references in `seoul-devices.css` still resolve correctly regardless of import position), but it reads oddly on a first pass since a utility file appears to reference tokens "before they exist." Worth a one-line comment noting this is intentional/safe if it isn't already there for a future reader unfamiliar with CSS custom-property timing.

**PRAISE:**
- The two-direction theme-override trace is genuinely correct, and the `:not([data-theme])` trick is a smart way to avoid a real specificity war without needing `!important` or duplicated attribute selectors — better engineering than the doc's own literal prescription would have produced if implemented naively.
- `tokensContrast.test.ts` (`client/src/styles/tokensContrast.test.ts`) is a live, CSS-parsing regression guard against exactly the failure mode this review was asked to hunt for (var-chain breakage, AA regressions) — it re-derives the token blocks straight from `index.css` rather than hardcoding expected hex, so it will actually catch a future re-tint that breaks contrast. Ran it: 28/28 pass.
- `--km-tone` centralization in `seoul-devices.css:150-158` is exactly right — three components (`CityCard`, `DancheongRail`, `SealStamp`'s milestone mode) needed identical tone→color resolution and got one shared implementation instead of three copies that could drift.
- Every animated utility in `seoul-devices.css` (najeon shimmer, neon-flicker) and `SkylineHeader.css` (parallax drift) is gated under `@media (prefers-reduced-motion: no-preference)` in addition to the blanket `!important` zero-out at `index.css:547-556` — belt-and-suspenders, and correctly reasoned in the comments (a reduced-motion user gets the *settled end state*, not a stalled mid-frame).
- `tsc --noEmit` is clean and the full contrast test suite passes; nothing here is theoretical.

## Detailed findings (file:line)

- `client/src/styles/index.css:44-172` — base `:root, [data-theme="light"]` block (Day tokens).
- `client/src/styles/index.css:174-257` — `[data-theme="dark"]` block (Night tokens); `--focus-ring` and `--gold*` deliberately absent here (see var-chain audit note).
- `client/src/styles/index.css:259-302` — no-JS/first-paint media fallback; `:not([data-theme])` is load-bearing (SHOULD-FIX #1).
- `client/src/styles/index.css:337-390` — accent presets (`[data-accent]` / `[data-theme="dark"][data-accent]`); higher specificity (0,2,0) than the base theme blocks so accent always wins regardless of source order — correct independent of the SHOULD-FIX #1 concern.
- `client/src/styles/index.css:773` (`.km-card--default`/`--flat` border) — `border: var(--card-hairline)` addition; safe under `box-sizing: border-box` (`index.css:414`), confirmed no old `border: none !important` elsewhere fighting it.
- `client/src/components/CityCard.css:34-38,48` — literal rgba hex, SHOULD-FIX #2.
- `client/src/components/DancheongRail.css:21-27` — Day's fixed four-band stripe reads `--dan-jade/verm/cobalt/ochre` directly (unconditionally, no theme gate needed since it's Day-only visually — the rail's Night variant is a separate rule at line 34), correctly.
- `client/src/styles/seoul-devices.css:150-158` — `--km-tone` central resolution, praised above.
- `client/src/styles/tokensContrast.test.ts` — ran via `npx vitest run`, 28/28 pass.
- `client/src/hooks/ThemeProvider.tsx:54-107`, `client/index.html:34-62` — confirmed the runtime attribute-setting contract the CSS trace above depends on.

## Coordination observations

- This PR is titled/described as a "foundation" with "no page reskinned," but because `--ink*`, `--paper*`, `--line`, `--radius-lg`, and the skill-hue tokens are all global custom properties, merging it **does** immediately change the rendered look of every existing page that uses `Card`, `Tabs`, `Progress`, `Chat`, `Grammar`, `Reading`, `Review`, `Settings`, `WritingTopicGenerator`, and `LineChart` — new colors, new card radius, and (in Day) new hairline borders where there previously were none. This is the explicit mechanism the design doc calls for (§5: "Retheme existing shared primitives … so the whole app shifts at once"), so it isn't a scope violation, but the fixpass / QA pass for this PR should include a visual smoke-pass over a few of those *unreskinned* pages (not just the 5 new components), since none of them were touched by this commit's diff and their new rendered appearance hasn't been eyeballed as part of it.
- `docs/redesign/REVIEW_design-fidelity.md` already exists in this repo alongside this new review — worth checking whether that review (presumably scoped to the character-device/visual-fidelity side, per the design doc's own "design-fidelity reviewer" framing in §8) already covers any of the same ground, to avoid duplicate/contradictory sign-off across the two review docs.
