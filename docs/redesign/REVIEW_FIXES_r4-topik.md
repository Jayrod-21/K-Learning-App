# Re-Review: F-191 TOPIK identity migration + Night stone retune

Branch `feat/phone-round4` @ `b402008`, diff base `0a53bf7` (3 files:
`pages/Topik.tsx`, `pages/topik/MockMode.tsx`, `styles/index.css`). Sits on
top of an already-PASSED round-4 fix-pass; this reviews only the increment.

Independent re-reviewer — did not write this code, verified every claim
against the actual diff/files/tests, not the commit message.

## Finding-by-finding

**1. 15-site migration to `SKILL_COLOR.topik.tone` — FIXED, correct.**
Grepped both files for literal `tone="accent"` / `tone="blue"`: zero live
occurrences remain (the two grep hits are inside doc-comment prose, not
code). All 15 sites the commit claims to have moved (9 in `Topik.tsx`, 6 in
`MockMode.tsx`) now read `SKILL_COLOR.topik.tone`, which resolves to
`'stone'` (`client/src/lib/skill-colors.ts:94`). Every site inspected is
genuinely TOPIK-page chrome (chooser sheet + its two option cards, session
tally, both `AttemptsReview` tiles, study progress bar, milestone stamps
(x2), the live study/exam card, the mock chooser hero + past-papers list,
the mock start-page meta + pending-attempts cards, and the shared
`TopikResults` score panel) — none of them are legitimately neutral/
semantic surfaces that got wrongly recolored.

**2. `sectionTone()` deliberately left alone — correct, verified live.**
`MockMode.tsx`'s `sectionTone()` (Reading -> `accent`, Listening -> fixed
`blue`, Writing -> `plain`) is untouched and is a different axis (which mock
*section* am I looking at, not "is this TOPIK"). Confirmed with the existing
test `MockMode.test.tsx:1652` ("renders each section pick as a CityCard...
toned per section") — still asserts `km-tone--accent` / `km-tone--blue` and
still passes. Correct to leave as-is.

**3. Two hero/secondary pairs losing tone-contrast — one clean, one weaker
but acceptable, no regression found.**
- `MockMode.tsx` `ExamChooser`: hero (`feat`) + past-papers list (no `feat`)
  now share `stone`. Verified `feat` is a real, independent visual-weight
  channel (`CityCard.css`: `feat` adds `border-width: 2px` and a
  stronger/thicker glow/shadow in Night, `box-shadow: var(--shadow)` vs
  `--shadow-sm` in Day) — hierarchy genuinely survives the tone unification.
  Clean.
- `MockMode.tsx` `StartPage`: exam-meta card + pending-attempts card, neither
  uses `feat` — hierarchy here rests only on document order + distinct
  `Eyebrow` headings/content volume. Verified this is not a "flat merge":
  every `CityCard` independently renders its own border + background
  gradient + box-shadow (`CityCard.css`) regardless of shared tone, and
  `MockMode.css` gives explicit spacing (`.km-mock__start-meta { margin: 14px
  0 }`, `.km-mock__pending { margin-bottom: 14px }`) between them, so the two
  remain visually distinct bordered blocks, just without a glow-intensity
  cue. This is a legitimate, common top-to-bottom primary/secondary reading
  pattern, not a UX regression — but it is objectively the weaker of the two
  pairs. **Recommendation (non-blocking):** a good, cheap follow-up polish
  would be adding `feat` to the meta card here too, to fully match the
  ExamChooser pair's pattern. Not required to ship.
- `Topik.tsx`'s chooser Study/Mock option cards and `AttemptsReview`'s two
  `CollapsibleTile`s are NOT hero/secondary pairs (equal side-by-side choices
  and sequential sibling sections, respectively) — correctly no
  hierarchy-preservation comment was needed or added for those.

**4. Stale doc comment at `Topik.tsx`'s chooser `Sheet` — FIXED, not just
moved.** The removed comment claimed "the tally/study CityCards below all
pass `tone="accent"` too" — false even pre-diff, since `SessionTally` used
`tone="blue"` (see its own adjacent comment, unchanged: "F-128 device #1/#2
— a blue-tone CityCard"). The new comment does not repeat this error; it
correctly describes the prior state as "a leftover mix of the shared accent
token and Vocab's fixed `blue`." Genuinely corrected, not relocated.

**5. Night `--stone` retune (#A69FBC -> #DAD6ED) — math independently
re-derived from scratch (own CIE76/WCAG implementation, not the repo's
test file), confirms the gate but contradicts the inline comment's framing.**
ΔE76 of new `#DAD6ED` vs all 6 Night skill hues:
- indigo `#5C87FF`: 62.44
- crimson `#FF3E6C`: 79.76
- ochre `#FFB43D`: 79.76
- cyan `#33D6EF`: 40.55
- moss `#12C08A`: 66.58
- violet `#C05CEB`: 77.91
- **min = 40.55** (builder's claimed 40.6, matches — floor is 28, clears
  comfortably)

Old `#A69FBC` min ΔE76 = 43.20 (also matches builder's claim).

**REGRESSION IN THE COMMENT, not the code:** `index.css`'s new doc comment
states *"Distinctness only IMPROVES: the old value cleared a 43.2 min ΔE76
... the new one clears 40.6"* — but 43.2 -> 40.6 is a **decrease**, not an
improvement. The comment's own two numbers contradict its own claim. This
looks like a conflation with the AA/ink-contrast number, which *did*
improve (6.77:1 -> 12.08:1, verified below) — but as written, the
distinctness claim is factually wrong, even though the actual value (40.6)
is nowhere near the 28 floor so nothing breaks. **Should-fix, not a
blocker:** correct "only IMPROVES" to something accurate (e.g., "narrows
slightly, from 43.2 to 40.6, but stays far above the 28 floor") before this
ships, since a future engineer re-tinting again may take "only improves" at
face value and not re-check the actual number.

**6. Both dark-mode declaration sites updated — FIXED, verified.**
`--stone: #DAD6ED` is present in both `[data-theme="dark"]` (`index.css:336`)
and the `@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`
mirror (`index.css:422`). No theme-toggle divergence.

**7. AA contrast — recomputed independently, PASS in both themes.**
- Night: `--stone-ink` (`var(--stone)` = `#DAD6ED`) on `--stone-soft`
  (`#1E182F`, unchanged) = **12.08:1** (matches builder's claim exactly).
- Day: `--stone-ink` (`var(--stone)` = `#69523A`, unchanged) on
  `--stone-soft` (`#F0E9E0`, unchanged) = **6.08:1** (matches builder's
  claim). Day was not touched by this diff and correctly still passes.
- Both clear the 4.5:1 AA floor with large margin. No `-soft`/`-ink` edit
  was needed or made beyond the passthrough that already existed
  (`--stone-ink: var(--stone)`), confirmed at all three declaration sites
  (`index.css:180`, `351`, `427`).

**8. Regression checks — clean.**
- `--km-mastery-mastered/-practicing/-new` untouched (still `var(--moss)`,
  `var(--ochre-ink)`, `var(--paper-mute)` in every block) — unaffected by
  this diff since `--moss`/`--ochre` were not touched.
- `styles/skillHueDistinctness.test.ts` and `styles/tokensContrast.test.ts`
  both parse hex values live out of `index.css` (not hardcoded constants),
  so they automatically re-validated the new `--stone` value on this test
  run rather than needing manual updates — confirmed both files still pass.
- Minor NIT: no test directly asserts that the 15 migrated JSX sites render
  `km-tone--stone` (only the untouched `sectionTone()` sites are
  class-asserted, `MockMode.test.tsx:1661-1662`). The underlying color
  system is guarded transitively (skill-colors single-source-of-truth test +
  contrast/distinctness tests), but a future accidental revert of one JSX
  site's `tone` prop back to a literal wouldn't be caught by a component
  test. Not a blocker — pre-existing test-depth pattern, not something this
  diff introduced.

## Gate results (client/, this session, exact)

- `npm run lint` — clean, no output, exit clean.
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — clean, zero
  errors.
- `npx vitest run` — **117 test files passed (117), 1955 tests passed
  (1955)**, 0 failed.
- `npx vite build --outDir /tmp/km-r4topik-rr` — succeeded in 598ms (312
  modules transformed). Pre-existing >500kB chunk-size warning only,
  unrelated to this diff.

## Recommendation

**Ready to ship**, with two cheap, non-blocking suggestions for a follow-up
pass (not this one):
1. Fix the self-contradicting "Distinctness only IMPROVES" line in
   `index.css`'s `--stone` comment (finding 5) — factually wrong as written,
   though the actual number is safely over the floor.
2. Consider adding `feat` to `StartPage`'s exam-meta hero card to fully match
   the `ExamChooser` pair's hierarchy pattern (finding 3) — cosmetic
   improvement, not a fix.

No blockers, no regressions found. Gate is green end to end.
