# REVIEW — batch 4: LEARN hexagon/honeycomb launcher (`LearnMenu`)

**Scope:** `client/src/components/LearnMenu.tsx`, `LearnMenu.css` (new), `LearnMenu.test.tsx` — the F-128 Seoul Day & Night reskin of the app's primary navigation launcher, on `feat/redesign-learn-b` @ `fae8223` (diffed against `rebuild`).

**Verdict: PASS — no blockers.** The reskin is genuinely presentational: a decorative absolutely-positioned backdrop, three added classNames, and one new co-located stylesheet. Routing, focus trap, initial-focus, Esc, Tab order, and the open/close/exit animation state machine are byte-for-byte untouched. Both non-tautological new tests pass, and the pre-existing 53-test suite (routing, aria-current, scrim/Esc close, exit-sentinel logic) still passes unmodified. One SHOULD-FIX (motion coordination between the new mount-flicker and the pre-existing entrance stagger) and one NIT.

---

## Ticket checklist

| Ticket | Status | Notes |
|---|---|---|
| F-128 (Seoul Day & Night identity) | ✅ Met | `km-giwa` (device #3) on backdrop + every tile, `km-rain-sheen` (device #8) on backdrop, `km-neon-box`/`km-neon-text` glow, `km-neon-flicker` mount animation (device §7). Day gets ink/paper craft, no literal glow — matches doc §7/§9. |
| F-129 (mobile, 3-across fit) | ✅ Met, unaffected | Diff touches zero layout/sizing rules. `--km-hex-w` clamp (`index.css:1251-1255`) untouched; backdrop is `position:absolute; inset:0` inside an already-`position:absolute` panel, so it adds no width and isn't a flex item of `.km-learnmenu__panel` (`display:flex`, `index.css:1228-1237`). |
| F-131 (accent-tracking hover/glow, not skill-hue) | ✅ Met | Backdrop's `km-neon-box` and title's `km-neon-text` both key off `--glow-color`, which the title explicitly repoints to `--vermilion-bright` (`LearnMenu.css:37-42`) — a token that IS redefined per `[data-accent="coral|blue|mint"]` in both themes (`index.css:379-428`). Per-tile skill hues (`--hx-hue` via `--indigo`, `--violet`, `--ochre`, `--cyan`, `--moss`) stay fixed and untouched by the new CSS; only the pre-existing Writing/TOPIK `vermilion` tile hue was *already* accent-linked (pre-dates this diff, called out in the component's own header comment) — the two systems don't collide, they were already designed to partially overlap on exactly those two tiles. |

---

## NAV / A11Y preservation verdict: **CONFIRMED — no regression**

Verified by reading the diff line-by-line against `client/src/hooks/useModalA11y.ts` and running the tests, not just trusting the builder's comments:

1. **Routes** — `COMB_ROWS`, `HEX_HUE`, `navItem()` calls, and the `goto()` handler are byte-identical to `rebuild`. `git diff` shows zero changes inside the `.map()` that renders tiles other than adding `className="km-learnmenu__hex km-giwa"` (was `"km-learnmenu__hex"`) and the wrapping backdrop `<div>`. All 7 `/learn/*` paths are unaffected.
2. **Focus trap / Tab order** — `useModalA11y`'s `FOCUSABLE_SELECTOR` (`button:not([disabled]), [href], [tabindex]:not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])`, `useModalA11y.ts:52-58`) does **not** match the new backdrop `<div>` (no `tabindex`/`href`/interactive role), so `container.querySelectorAll(FOCUSABLE_SELECTOR)` inside the trap (`useModalA11y.ts:163-178`) still resolves `first`/`last` to the same hex buttons as before. The backdrop is also the *first* DOM child (before the title), but since it's non-focusable this doesn't shift tab order at all — confirmed no `:first-child`/`:nth-child`/`+`/`~` sibling selectors reference `.km-learnmenu` anywhere in `index.css` (grepped, zero hits), so the new sibling can't have silently broken a positional CSS rule either.
3. **Esc / initial focus / focus restore** — hook is imported unchanged, called with the same `containerRef`/`initialFocusRef` args. `Shell.test.tsx` (21/21 pass) and `LearnMenu.test.tsx`'s own Esc/initial-focus/close-on-scrim tests (all pass) confirm this at runtime, not just by inspection.
4. **Entrance/exit stagger + `onExited` sentinel** — `ROW_STAGGER_MS`, `EXIT_ROW_STAGGER_MS`, `EXIT_TILE_MS`, `isExitSentinel`, `onAnimationEnd` target-guard logic are untouched. Ran the close-out test block directly: reverse-stagger ordering, "ignores non-sentinel", "ignores bubbled child", "ignores sentinel while entrance" all pass (`LearnMenu.test.tsx:212-258`).
5. **Backdrop is truly decorative and out-of-flow** — `aria-hidden="true"`, `pointer-events: none` (`LearnMenu.css:31-35`), `position: absolute` inside the already-positioned `.km-learnmenu__panel`. Per CSS flex layout, an absolutely-positioned child is removed from flex flow — it does not consume `gap`, does not count toward the flex algorithm, and does not affect the panel's auto height (which is still driven solely by the in-flow title + comb). Confirmed this isn't just asserted in a comment: ran `tsc --noEmit` (clean) and the full `LearnMenu.test.tsx` + `Shell.test.tsx` suites (76/76 pass combined).

I ran the actual test files rather than trusting the diff's self-description:
```
LearnMenu.test.tsx + tokensContrast.test.ts:  55/55 pass
Shell.test.tsx:                               21/21 pass
tsc --noEmit:                                 clean
```

---

## AA-per-hexagon verdict: **CONFIRMED — untouched mechanism, live-verified, not just asserted**

The diff adds **zero** `color`/`background` changes to `.km-learnmenu__hex` or `.km-learnmenu__hexlabel` — only `box-shadow` (a property `index.css` never sets on that selector; confirmed by grep, `index.css:1334-1382` has no `box-shadow` on `.km-learnmenu__hex`). The `--hx-ink`-on-`--hx-bg` text-contrast mechanism (`index.css:1304-1333`, `.km-learnmenu__hexwrap--{indigo,violet,ochre,cyan,moss,vermilion}`) is exactly what it was before this batch.

Better than taking that at face value: `client/src/styles/tokensContrast.test.ts:88-107` is a **live, CSS-parsing** regression guard (not a hardcoded snapshot) that asserts `--{hue}-ink` on `--{hue}-soft` ≥ 4.5:1 for all 6 honeycomb hues (`indigo, violet, ochre, cyan, moss, vermilion`) in **both** `:root`/`[data-theme="light"]` and `[data-theme="dark"]` blocks — this is precisely the pairing the hex tiles render text with. Ran it: **12/12 hue×theme combinations pass.** This is a pre-existing automated gate this diff doesn't need to (and doesn't) touch, and it demonstrably still holds after the reskin lands.

The new inset glows (`LearnMenu.css:67-80`) are `box-shadow`, which never composites over text color/contrast — they sit visually "inside" the tile as a soft bloom, not behind the label glyphs in a way that would depress contrast. No AA risk introduced.

---

## Findings

### SHOULD-FIX

**S1 — Unverified motion coordination: mount-flicker (`km-neon-flicker`) stacks with the pre-existing entrance stagger every time the honeycomb opens, not just once.**
`client/src/components/LearnMenu.tsx:228` puts `km-neon-flicker` on `.km-learnmenu__panel` itself — the *parent* of every hex tile. `[data-theme="dark"] .km-neon-flicker` (`seoul-devices.css:174-186`) runs a 900ms `steps(1, end)` opacity animation on that parent (0.2 → 1 → 0.4 → 1 → 0.6 → 1 → held at 1), while `.km-learnmenu__hexwrap`'s own `km-hexrise` (`index.css:1278`, 320ms, staggered up to 140ms) fades each tile's *own* opacity from 0 → 1 concurrently. Nested `opacity` composites multiplicatively during rendering, so for roughly the first 460ms of every single menu open in Night theme, the whole comb's effective on-screen opacity is the product of two independent, uncoordinated animations — one a smooth per-row cubic-bezier rise, the other a hard-stepped 6-jump flicker. Every other `km-neon-flicker` usage in the codebase (`CityCard.tsx:29-31`) is a static content card with no competing child animation; this is the first time the utility has been layered on a container whose children have their own opacity-based entrance motion, and there's no visual/screenshot verification in this PR's trail that the combination reads as intentional rather than janky. This is the app's hero/most-frequently-opened surface, so it's worth an explicit look (or a deliberate call that it's fine) before this ships, rather than shipping on the strength of "each utility is individually reduced-motion-safe."
- Not a blocker: doesn't affect nav/focus/keyboard/AA, is Night-only, and is fully skipped under `prefers-reduced-motion: reduce` (verified: the animation is declared inside `@media (prefers-reduced-motion: no-preference)`, `seoul-devices.css:174`).
- Suggested direction (no code changes made, per instructions): either move `km-neon-flicker` to `.km-learnmenu__title` only (a static-sized element with no competing opacity animation, matching the `CityCard` precedent) or delay the flicker's start until after the tile stagger completes, or simply eyeball it in a Night-theme dev build and confirm it reads fine before merge.

### NIT

**N1 — New reskin test doesn't independently verify the AA claim it documents.**
`LearnMenu.test.tsx:147-177`'s comment block explains the accent-vs-skill-hue distinction correctly, but the test itself only checks class presence (`toHaveClass('km-giwa', 'km-rain-sheen', 'km-neon-box')`, `toHaveClass('km-neon-text')`) — it can't and doesn't need to re-derive contrast math (that's `tokensContrast.test.ts`'s job, and it already covers this), but the comment's confidence ("this glow is keyed to `--vermilion`... never a skill hue") is asserted only in prose, not in an assertion that e.g. the title's computed `--glow-color` chain resolves through `--vermilion-bright` rather than any `--hx-hue`. Low priority since the token wiring is verified structurally elsewhere in this review (and by `tokensContrast.test.ts`), but a future accidental re-key of the title's class to some `--hx-hue` variable would not be caught by this test.

### PRAISE

- **P1 — The `.km-learnmenu .km-learnmenu__backdrop` two-class specificity argument is correct, not hand-waved.** `LearnMenu.css:19-32`'s comment walks through the actual CSS specificity math for why `position: absolute` (backdrop, specificity 0,2,0) deterministically beats `.km-rain-sheen`'s `position: relative` (specificity 0,1,0) regardless of stylesheet import order — a real concern given the file's own admission that four other batches are reskinning shared `index.css`/`seoul-devices.css` concurrently. I checked the math independently; it holds.
- **P2 — AA claim backed by a live, non-snapshot test**, not just a comment. `tokensContrast.test.ts` parses `index.css` at test time and re-derives contrast ratios, so a future re-tint of any of the 6 honeycomb hues in either theme fails CI automatically. Ran it: 12/12 pass.
- **P3 — Correct, load-bearing use of "absolutely-positioned children are removed from flex flow"** to guarantee the decorative backdrop can never perturb `.km-learnmenu__panel`'s title/comb sizing — verified this is actually true of the CSS flexbox spec, not just asserted.
- **P4 — Day/Night asymmetry respected deliberately**: `km-rain-sheen`, `km-neon-box`, and `km-neon-text` all no-op in Day by design (`seoul-devices.css:36-38`, `132-143`), matching DESIGN_SEOUL_DAY_NIGHT.md §7's "Day's craft is the paper/ink treatment, not literal light-bloom" — the diff doesn't try to force a Night device onto Day for symmetry's sake.
- **P5 — Test suite additions correctly assert the "no-perturbation" contract** (`expect(dialog.querySelectorAll('button')).toHaveLength(7)` inside the same test that checks the new decorative classes) rather than testing the reskin in isolation from the nav contract — a good pattern for exactly the kind of regression this ticket worries about.

---

## Coordination observations

- This batch (B) reskins `LearnMenu` alongside Listen/Writing/TOPIK/Chat/Tickets/Settings in the same commit; `LearnMenu.css`'s header comment explicitly documents its additive-only contract against `index.css`, which is being touched by other parallel batches. I found no evidence of a live collision (grepped `index.css` for any other rule touching `.km-learnmenu__hex`/`__backdrop` — none exist outside this diff), but this is worth re-checking once the other parallel batches land, since the "index.css never sets box-shadow on `.km-learnmenu__hex`" invariant this file depends on could be silently violated by a sibling batch that also touches `index.css`.
- No `docs/redesign/REVIEW_batch4-*` files existed prior to this review — this is the first fidelity/nav pass on this diff.
- Flag S1 for whoever runs the design-fidelity reviewer pass on this same batch's other pages (Listen/Writing/TOPIK/Chat/Tickets/Settings) — if any of them also apply `km-neon-flicker` to a container with independently-animating children, the same coordination gap likely recurs there.
