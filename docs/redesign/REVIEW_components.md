# Review: Components + a11y + tests — Seoul Day/Night foundation

Reviewer: independent senior React/TS reviewer (did not write this code).
Scope: `client/src/components/{CityCard,SkylineHeader,SubwayProgress,DancheongRail,SealStamp}.{tsx,css}`,
`client/src/styles/seoul-devices.css`, and the `SealStamp` extension inside `client/src/styles/index.css`.
Branch `feat/redesign-foundation` @ `c525288`, diffed against `rebuild`.

## Summary verdict: REQUEST CHANGES

The component code itself is genuinely strong — clean TS boundaries, correct ARIA, real
reduced-motion discipline, and a careful, provably backward-compatible `SealStamp`
extension. `tsc --noEmit` and `eslint` both come back clean on all five files, and no
`any`/unsafe casts/console/TODO exist anywhere in the diff.

The blocking problem is test coverage: **this diff adds zero test files.** None of
`CityCard`, `SkylineHeader`, `SubwayProgress`, `DancheongRail` have ever had a test, and
the `SealStamp` extension (new `milestone`/`label`/`tone` branches, plus a latent
className bug — see below) ships with none either. This project has an established,
strong per-component test convention (`SkillBar.test.tsx`, `Pill.test.tsx`, `Tabs.test.tsx`,
`Sheet.test.tsx`, …), and `SubwayProgress` in particular has real, easy-to-regress logic
(current-index clamping, fill-percent math, station-state derivation, `aria-valuetext`
fallback) that is materially similar in shape to the already-tested `SkillBar`. The
"suite is 1545 green" claim is true but misleading here — it is 1545 green with these
five files entirely outside it. Per this review's own bar, a component with real logic
and zero tests is a BLOCKER, and that applies to at least `SubwayProgress`, `CityCard`,
and the `SealStamp` extension.

Fix = add colocated test files for all five (four new + the SealStamp extension), then
this is a clean PASS.

---

## SealStamp backward-compat

| Caller (file:line) | Still valid? | Why |
|---|---|---|
| `client/src/pages/Login.tsx:89` — `<SealStamp char="韓" size="lg" />` | Yes | Only `char`/`size` passed; `milestone=false`, `label=undefined`, `tone='accent'` defaults reproduce the pre-change render exactly (`glyph = char` since `char` is provided; no `km-seal--milestone` class; `label == null` → returns bare badge, no wrapper `km-seal-group` span added). |
| `client/src/pages/Diagnostic.tsx:1042` — `<SealStamp char="完" size="lg" />` | Yes | Same as above. |
| `client/src/pages/Hanja.tsx:712` — `<SealStamp char="韓" size="md" />` | Yes | Same as above. |
| `client/src/pages/Hanja.tsx:1023` — `<SealStamp char="完" size="md" />` | Yes | Same as above. |
| `client/src/pages/Images.tsx:642` — `<SealStamp char="譯" size="sm" />` | Yes | Same as above. |
| `client/src/pages/Review.tsx:791` — `<SealStamp char="復" size="sm" />` | Yes | Same as above. |
| `client/src/pages/Review.tsx:1582` — `<SealStamp char="復" size="sm" />` | Yes | Same as above. |
| `client/src/pages/Review.tsx:1838` — `<SealStamp char="完" size="sm" />` | Yes | Same as above. |

All eight existing call sites pass only `char` and `size` — none pass `className`,
`style`, `milestone`, `label`, or `tone`. `SealStamp.tsx:55-63` gives every new prop a
default (`milestone = false`, `label` undefined, `tone = 'accent'`) that reconstructs the
pre-change markup and class list bit-for-bit: `km-tone--accent` resolves `--km-tone` to
`var(--vermilion)` (`seoul-devices.css:152`), which is exactly the accent variable the
badge already read before this change (per the file's own header comment,
`SealStamp.tsx:14-18`). `tsc --noEmit -p client/tsconfig.json` runs clean, confirming no
caller call-site now fails to type-check. Verdict: **backward-compat claim holds** — no
caller broke.

One latent, currently-dormant issue in the extension itself: see BLOCKER-adjacent
SHOULD-FIX below (`className` silently dropped from the badge when `label` is set).

---

## Per-component checklist

| Component | TS strict | ARIA | reduced-motion | tests exist + real |
|---|---|---|---|---|
| `CityCard` | Pass — explicit props, no `any`, `heading` deliberately not named `title` to avoid colliding with `HTMLAttributes`'s native tooltip attr (`CityCard.tsx:42-46`) | N/A (non-decorative container; content-bearing, no ARIA role needed) — rail composed via `DancheongRail`, itself `aria-hidden` | N/A — card itself has no motion; only the caller-opt-in `.km-neon-flicker` utility animates, and that's gated (`seoul-devices.css:163-167`) | **Fail — zero tests.** Real branching logic (`rail`, `heading`, `feat`, `tone`→class) untested. |
| `SkylineHeader` | Pass — explicit `title?: ReactNode`, no `any` | Pass — `aria-hidden="true"` + `focusable="false"` on the whole decorative SVG (`SkylineHeader.tsx:41-44`); optional `title` renders as a real, separate DOM node outside the `aria-hidden` subtree (`SkylineHeader.tsx:98`) | Pass — parallax only exists inside `@media (prefers-reduced-motion: no-preference)` (`SkylineHeader.css:58-70`), so `reduce` needs no override; both day/night `<g>` layers always in the DOM, switched by CSS `display`, so no FOUC before `data-theme` settles | **Fail — zero tests.** Lower risk (mostly static SVG markup) but still no coverage that `title` renders, that the svg is `aria-hidden`, or that both theme layers exist in the DOM. |
| `SubwayProgress` | Pass — explicit props, `steps`/`current` documented int contracts, no `any` | **Praise** — textbook-correct: single `role="progressbar"` for the whole strip (not one role per dot), `aria-valuemin/max/now` + `aria-valuetext` with a sane generated fallback, decorative dots individually `aria-hidden` (`SubwayProgress.tsx:54-77`) | Pass — fill/station transitions killed under `reduce` (`SubwayProgress.css:87-92`); no ambient looping animation to begin with | **Fail — zero tests**, and this is the component with the most logic to break: `current`/`steps` clamping (`SubwayProgress.tsx:49-51`), `fillPct` math, per-station `done/current/ahead` derivation, `valueText` fallback string. Directly comparable in shape to the already-tested `SkillBar` (`SkillBar.test.tsx`). **BLOCKER.** |
| `DancheongRail` | Pass — 4-value union `DancheongRailTone`, no `any` | Pass — `aria-hidden="true"` (`DancheongRail.tsx:39-40`), correctly decorative (no information not already in the card) | N/A — no animation (static gradient/box-shadow only) | **Fail — zero tests.** Low logic surface (prop → class string only) — SHOULD-FIX severity, not blocker on its own. |
| `SealStamp` (extension) | Pass — `SealTone = DancheongRailTone` reused (no duplicate union), `ReactNode` for `label`, no `any`; **one real defect**, see below | Pass — badge always `aria-hidden`; `label`, when present, renders in a sibling span outside the `aria-hidden` glyph (`SealStamp.tsx:81-90`) | N/A — rotation is a static `rotate: -6deg`, not an animation (`index.css:890`), correctly not gated | **Fail — zero tests**, old or new behavior. Real logic added (glyph fallback `char ?? (milestone ? '印' : '韓')`, conditional wrapper, and the className-drop bug below). Given this component is the one under the strictest backward-compat bar in this review, shipping it with no regression test at all is the highest-priority gap in the set. **BLOCKER.** |

---

## Findings — BLOCKER / SHOULD-FIX / NIT / PRAISE

**BLOCKER**
1. Zero tests for `SubwayProgress` — real clamping/derivation/ARIA-text logic, directly comparable to the tested `SkillBar`, ships uncovered. (`client/src/components/SubwayProgress.tsx`)
2. Zero tests for the `SealStamp` extension — the component this whole review's backward-compat bar is centered on has no regression test proving the 8 existing callers keep rendering identically, nor any test of the new `milestone`/`label`/`tone` paths. (`client/src/components/SealStamp.tsx`)
3. Zero tests for `CityCard` — real conditional composition (`rail`, `heading`, `feat`) untested. (`client/src/components/CityCard.tsx`)

**SHOULD-FIX**
1. `SealStamp.tsx:72` — `!label && className` silently drops the caller's `className` from the badge itself whenever `label` is also passed (it only lands on the outer `km-seal-group` wrapper). Currently dormant (no caller passes both), but it's a footgun for the very first future caller who does — e.g. a page that wants both a milestone badge with a caption AND a positioning `className` on the glyph. Either apply `className` to the badge unconditionally (moving any layout-only classes the wrapper needs onto a fixed wrapper class instead), or document the split explicitly in the JSDoc so it's not accidentally "fixed" into a real regression later.
2. `SubwayProgress.tsx:49-50` — `Math.floor(steps)` / `Math.floor(current)` have no guard against `NaN`/`Infinity` input (e.g. a caller passing `current={0/0}` from a bad computed ratio). `Math.min(Math.max(0, NaN), total-1)` resolves to `NaN`, which then renders `aria-valuenow={NaN}` and a broken station-state loop. Low likelihood, but worth a defensive clamp (`Number.isFinite` check) given this is meant to be a shared primitive many pages will feed computed values into.
3. `client/src/styles/tokensContrast.test.ts` has no coverage of the new `--dan-*`/`--neon-*` tokens or the `--on-vermilion` × `--km-tone` pairing that `SealStamp`'s milestone variant, `CityCard`, `DancheongRail`, and `SubwayProgress` all share. The code comments justify contrast only for the default vermilion/coral case (`index.css:210-213`); the `blue`/`mint`/`plain` tone combinations (`--on-vermilion` text on `--neon-blue`/`--neon-mint`/`--dan-cobalt`/`--dan-jade` fills) are asserted only informally, not by the existing automated guard. Given `tokensContrast.test.ts` already exists as the established mechanism for exactly this kind of check, extending it to the new tone-family combos is the natural fix.

**NIT**
1. `CityCard.tsx:36` — `CityCardProps extends HTMLAttributes<HTMLDivElement>` and spreads `...rest` onto the root `div`, so a caller could pass `onClick` and make the card interactive with no keyboard/focus affordance. This mirrors the existing `Card` component's own pattern exactly (`client/src/components/Card.tsx`) — not a new problem introduced by this diff, just flagging that the same caveat that already applies to `Card` now also applies to `CityCard`.
2. `SkylineHeader.tsx` / `DancheongRail.tsx` / `CityCard.tsx` JSDoc is long (by design, per the project's documented convention of explaining "why" — matches `Card.tsx`/`SkillBar.tsx` in verbosity) — no action needed, noting only because a lighter-touch reviewer might flag length; here it reads as intentional and consistent with house style.

**PRAISE**
1. `SubwayProgress.tsx:54-62` — the ARIA implementation is exactly right: one `role="progressbar"` for the whole strip (not per-dot roles), correct `aria-valuemin/max/now`, and a sensible generated `aria-valuetext` fallback when the caller doesn't supply a richer one. This is better than most hand-rolled progress components in the wild.
2. `SkylineHeader.tsx:1-23` / `SkylineHeader.css:23-28` — rendering both day/night `<g>` layers unconditionally and toggling visibility purely via `[data-theme]` CSS (rather than a `useTheme()` JS read) is a genuinely good call: it means the strip paints correctly on first render even before a theme provider settles, with no FOUC/flash risk.
3. Reduced-motion is handled at the right layer everywhere in this diff — the ambient/parallax/flicker animations are gated by *existence* (`@media (prefers-reduced-motion: no-preference) { … }` wrapping the whole rule), not just zeroed duration, so `reduce` users never see a stalled mid-frame. (`SkylineHeader.css:58-70`, `seoul-devices.css:60-64,163-167`)
4. The shared `--km-tone` indirection (`seoul-devices.css:145-157`) centralizing the accent/blue/mint/plain → day-dancheong/night-neon resolution once, consumed identically by `CityCard`, `DancheongRail`, `SubwayProgress`, and `SealStamp`'s milestone variant, is a clean DRY move that will keep a future 6th tone-consuming component in lockstep automatically.
5. The `SealStamp` extension's own JSDoc (`SealStamp.tsx:10-18`) states the exact backward-compat argument this review was asked to verify, and it checks out — a rare case of the code comment being an accurate, checkable claim rather than aspirational.
6. Every CSS file in the diff is genuinely token-driven — no hard-coded hex anywhere in `CityCard.css`, `SkylineHeader.css`, `SubwayProgress.css`, `DancheongRail.css`, or `seoul-devices.css`; confirmed by inspection, no `#`/`rgb(` literals outside token definitions in `index.css` itself.

---

## Detailed findings (file:line)

- `client/src/components/SealStamp.tsx:55-90` — full extended component; no test file exists at `client/src/components/SealStamp.test.tsx` (BLOCKER #2).
- `client/src/components/SealStamp.tsx:72` — `!label && className` className-drop (SHOULD-FIX #1).
- `client/src/components/SubwayProgress.tsx:41-79` — full component; no `client/src/components/SubwayProgress.test.tsx` (BLOCKER #1).
- `client/src/components/SubwayProgress.tsx:49-51` — unguarded `NaN`/`Infinity` path (SHOULD-FIX #2).
- `client/src/components/CityCard.tsx:51-77` — full component; no `client/src/components/CityCard.test.tsx` (BLOCKER #3).
- `client/src/components/SkylineHeader.tsx`, `client/src/components/DancheongRail.tsx` — no test files; lower-severity SHOULD-FIX given limited logic surface.
- `client/src/styles/tokensContrast.test.ts:1-30` — existing contrast-guard mechanism; does not yet cover `--dan-*`/`--neon-*`/`--km-tone` combos introduced by this diff (SHOULD-FIX #3).
- `client/src/pages/{Login,Diagnostic,Hanja,Images,Review}.tsx` — the 8 `SealStamp` call sites enumerated in the backward-compat table above; all confirmed unaffected by inspection + `tsc --noEmit`.

---

## Coordination observations

- No page files were touched by this diff (`git diff rebuild --stat` outside `components/`, `styles/`, and `BUGS_AND_FEATURES.md` shows only the doc file) — scope discipline held, no reskin/scope-creep to flag.
- `tsc --noEmit -p client/tsconfig.json` and `eslint` on all five changed/added component files both return clean with zero output — strong signal the TS-strictness and lint bars are genuinely met, independent of this review's own read-through.
- The `--ink`/`--paper` naming inversion relative to the design doc's own `--ground`/`--paper`/`--ink` vocabulary (flagged as a possible bug on first read of `CityCard.css`) is **not** a defect — it's a pre-existing, explicitly documented convention (`client/src/styles/index.css:34-41`) predating this diff, and this diff's new components correctly follow it.
- Recommend the fixpass fix-pass agent add the five missing test files as the primary deliverable; given `SkillBar.test.tsx` already exists as a template for exactly this shape of component (progress/derived-state + ARIA assertions), that should be a fast, low-risk addition rather than new-pattern work.
