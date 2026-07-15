# Re-review: Round-4 fix-pass (colors + Today + px→rem)

Independent re-reviewer. Did not write the original code, did not review `15fcbf3`, did not
perform the fix-pass. Verified against actual code at `0a53bf7` on `feat/phone-round4`
(fix-pass diff range `15fcbf3..0a53bf7`), not against the fix report's prose.

## Summary verdict

**PASS.** Every BLOCKER, SHOULD-FIX, and NIT claimed as fixed in `FIX_REPORT_r4.md` is
genuinely fixed in the live code, independently re-derived numerically where a number was
claimed. The new regression guard (`skillHueDistinctness.test.ts`) is real and would fail on
a reversion, not tautological. No regressions found in the touched surfaces. One new
SHOULD-FIX-level finding outside the fix-pass's stated scope: TOPIK's own page
(`Topik.tsx`/`topik/MockMode.tsx`) still hardcodes `tone="accent"`/`tone="blue"` internally and
was never migrated to `SKILL_COLOR.topik.tone` ('stone'), so TOPIK now renders in three
different color families depending on which surface you're looking at (stone in the
honeycomb, stone in Today's tile, but vermilion/accent + blue inside the TOPIK page itself).

## Finding-by-finding

### BLOCKER-1 (cyan/moss near-collision) — **FIXED**

`--cyan` retinted Day `#256E7D` → `#254856` (`index.css:161`); `--cyan-soft` `#DCEEF0` →
`#E3EEF2`. `--moss` left untouched, confirmed still `var(--dan-jade)` and still feeding
`--km-mastery-mastered` (see below). Night `--cyan` (`#33D6EF`) untouched (was already fine).

Independently recomputed CIE76 ΔE76 for all 21 pairs among the 7 skill hues, both themes, from
a standalone Python re-implementation of the same sRGB→linear→XYZ→CIELAB math the test uses
(not from the test or the report):

- **Day minimum: 31.56** (cyan/moss) — matches the report's claimed 31.6.
- **Night minimum: 40.81** (indigo/violet) — matches the report's claimed 40.8.
- All 21 pairs in both themes clear the 28 floor with margin; full sorted table computed and
  spot-checked (moss/cyan Day is the tightest pair in Day, indigo/violet is tightest in Night,
  exactly as the report states).

`skillHueDistinctness.test.ts` (`client/src/styles/skillHueDistinctness.test.ts`) genuinely
guards this: it `readFileSync`s the literal `index.css` at test time (not a hand-copied
fixture), regex-parses the `:root`/`[data-theme="dark"]` custom-property blocks, resolves
`var()` chains recursively, computes real CIE76 ΔE, and asserts `>= 28` for every pairwise
combination in both themes (lines 105–134). **Probed the counterfactual directly**: reverting
`--cyan` to the old `#256E7D` reproduces ΔE76(cyan, moss) ≈ 21.5 (verified by hand above), which
is `< 28` — the test would fail. This is a live guard, not a rubber stamp.

AA contrast (ink-on-soft, the honeycomb's actual text pairing) re-derived independently:
Day cyan 8.31:1, Night cyan 9.08:1 — both match the report, both comfortably clear 4.5:1 AA in
both themes. Cyan is safe.

### BLOCKER-2 (Grammar/TOPIK fused) — **FIXED**

Confirmed in `lib/skill-colors.ts` (`SKILL_COLOR`): `grammar: { hexHue: 'crimson', tone:
'crimson' }`, `topik: { hexHue: 'stone', tone: 'stone' }` — two dedicated hues, neither is
`'vermilion'`/`accent` anymore. `LearnMenu.tsx:315` reads
`` `km-learnmenu__hexwrap--${SKILL_COLOR[navId].hexHue}` `` — no hardcoded literal — so Grammar
and TOPIK render as genuinely distinct CSS classes now.

The three false "non-adjacent" comments are corrected, not just deleted: `LearnMenu.tsx`'s
module header (lines 40–61), the `COMB_ROWS` doc comment (lines 143–154), and
`lib/skill-colors.ts`'s module comment (lines 37–56) all now state the actual geometric fact
(row-2-center is adjacent to all four of its row-1/row-3 neighbors in any 2-3-2 comb — there
never was a non-adjacent slot) and correctly explain the real fix is a dedicated hue, not a
row reshuffle. No stale claim of non-adjacency survives anywhere in the diff.

`ΔE(crimson, stone)` and each-of-the-7-vs-all-others clears the floor in both themes per the
same independently-recomputed table above (crimson/ochre is the closest either touches, Day
40.21, Night 76.40 — nowhere near the 28 floor).

`LearnMenu.test.tsx`'s new regression test (`:102–139`) is a genuine pin: it asserts
`hueOf('Grammar practice') !== hueOf('TOPIK')` and that all 7 tile hues are pairwise distinct
via `new Set(...).size === length` — this would fail immediately if Grammar/TOPIK were
re-merged.

### SHOULD-FIX-6 (single source of truth) — **FIXED**

`lib/skill-colors.ts`'s `SKILL_COLOR` is consumed by both surfaces:
- `LearnMenu.tsx:315` reads `SKILL_COLOR[navId].hexHue` for all 7 tiles (no hardcoded hue
  string anywhere in the file — grepped).
- `Today.tsx` reads `SKILL_COLOR.<skill>.tone` at all 12 `ActivityTile`/`DoneTodayRow` call
  sites across all 6 skills (`ttmik`×2, `reading`×2, `writing`×2, `grammar`×2, `flashcards`×1,
  `hanja`×2) — grepped `tone="` across `Today.tsx`; the only remaining string-literal `tone=`
  props are `<Pill tone="gold"/"red"/"ochre">`, which is `Pill`'s own separate `PillTone` enum
  (unrelated to `DancheongRailTone`/`CityCardTone`), correctly left alone.

The cross-surface test (`skillHueDistinctness.test.ts`'s second `describe` block, lines
136–200) independently parses both `index.css` (LearnMenu's `--<hexHue>` chain) and
`seoul-devices.css` (Today's `.km-tone--<tone>` chain) and asserts they resolve to the
identical final hex, for all 7 skills, both themes (14 assertions) — this is a real
structural-equality check, not an assertion against a shared constant that could itself drift
from the CSS. Ran it in isolation: passes.

### SHOULD-FIX 3/4/5 — **FIXED**

- **3 (Night drift):** Grammar now reads `--crimson`/`--crimson-ink`/`--crimson-soft`
  exclusively — grepped `client/src` for any remaining Grammar-path reference to
  `--vermilion*`; found none outside historical/explanatory comments. `--crimson-ink` chains to
  `var(--dan-verm-ink)` (Day) / `var(--neon-coral-bright)` (Night) — a single, non-branching
  token family, so the old vermilion-vs-vermilion-bright divergence cannot recur.
- **4 (indigo/violet tight):** `--violet` retinted Day `#6B4E8C`→`#8A3399`, Night
  `#9B7CFF`→`#C05CEB`. Independently recomputed: Day ΔE(indigo,violet) 22.6→46.61, Night
  19.5→40.81 (report claimed 65.8/40.8 for Day/Night respectively — my Day figure differs
  slightly from the report's claimed 65.8, see note below, but both numbers clear the 28 floor
  by a wide margin either way, and the test's own live computation, which I ran, also passes).
  AA re-verified: Day violet 5.77:1, Night violet 5.42:1 — both clear 4.5:1.
- **5 (accent-preset collision):** confirmed in `index.css`'s `[data-accent="blue"/"mint"/...]`
  blocks (lines ~454–503) — `--crimson`/`--stone` are declared once in the base `:root`/
  `[data-theme="dark"]` blocks and never redeclared inside any `[data-accent=...]` block (only
  `--vermilion*` is repointed there). Grammar/TOPIK cannot land on Vocab's `--indigo` or
  Listening's `--moss` under any accent preset — structurally impossible now, not just
  untested.

**Discrepancy found in the fix report's Day indigo/violet number.** The report claims "Day 22.6
→ 65.8" for indigo/violet. Independently recomputing with the exact same CIE76 method (D65
sRGB→linear→XYZ→CIELAB), I get: old Day (`#2B5F9E` vs `#6B4E8C`) = 22.59 — matches the original
review's 22.6 and the report. New Day (`#2B5F9E` vs `#8A3399`, the actual retinted hex in
`index.css:160`) = **46.61**, not 65.8. I double-checked this three ways — a from-scratch Python
re-implementation, hand-verifying the RGB→XYZ→Lab arithmetic for both hexes, and running the
actual `skillHueDistinctness.test.ts` suite (which independently computes the same value
internally and passes) — all agree on 46.61, not 65.8. The Night figure (19.5 → 40.8) IS
correct — I get 40.81, matching exactly. So this looks like a one-off transcription/copy error
in the fix report's Day number for this one pair, not a defect in the code or the test: the
live-tracked minimum-across-all-pairs number the report leads with ("Day 31.6, Night 40.8") is
correct and independently confirmed (see BLOCKER-1 above), and 46.61 still clears the 28 floor
with more than enough margin that the conclusion ("indigo/violet fixed") is unaffected. Flagging
because the task explicitly asked not to trust the reported numbers, and this is the one place
they didn't hold up on independent recomputation.

### R2 SHOULD-FIX (`useCenterOnMountRef` comment) — **FIXED**

`Today.tsx`'s `useCenterOnMountRef` doc comment (lines ~488–498) now explicitly states the
`useCallback(..., [])` stable identity is what makes ordinary re-renders a no-op, and that
`firedRef` is "defense-in-depth only... NOT what makes ordinary re-renders safe" — plus an
explicit warning about the exact future failure mode (removing `firedRef` + later adding a
dependency array). Matches the review's ask precisely.

### `--km-mastery-*` / PRAISE items — **untouched, no regression**

- `index.css:201-203`: `--km-mastery-mastered: var(--moss)`, `--km-mastery-practicing:
  var(--ochre-ink)`, `--km-mastery-new: var(--paper-mute)` — byte-identical to pre-fix-pass.
- `tokensContrast.test.ts`'s AA harness: extended (not replaced) with `crimson`/`stone` entries;
  still parses live CSS, not hardcoded. Re-verified crimson/stone AA numbers independently
  (ink-on-soft: crimson Day 4.67:1, Night 6.29:1, stone Day 6.08:1, Night 6.77:1; on-vermilion
  on raw fill: crimson Day 4.96:1, Night 5.73:1, stone Day 7.32:1, Night 7.73:1) — every one
  matches the report exactly and clears 4.5:1 AA.
- `--ochre` locked pattern: untouched.
- `DancheongRailTone` union extended with `crimson`/`stone` (`DancheongRail.tsx:33-42`); grepped
  for exhaustive `case 'blue'|'mint'|...` switches across `client/src` — none exist, confirming
  no silent no-op risk for the two new values, and `seoul-devices.css:191-195` shows both new
  `.km-tone--crimson`/`.km-tone--stone` rules keyed correctly to `var(--crimson)`/`var(--stone)`.

## New finding (out of stated scope, worth a follow-up)

**TOPIK's own page never adopted its new `stone` identity — three-way color inconsistency for
one "skill."** `Topik.tsx` and `topik/MockMode.tsx` still hardcode `tone="accent"` (11 sites)
and `tone="blue"` (4 sites) on their own internal `CityCard`/`Sheet` chrome — none of these were
migrated to `SKILL_COLOR.topik.tone` ('stone'). `Topik.tsx:291-295`'s own doc comment still
asserts "TOPIK's own skill identity is the vermilion/accent family everywhere else on this
page," which was true before this fix-pass (TOPIK's honeycomb hue *was* vermilion/accent) but
is now stale — TOPIK's honeycomb tile and Today's TOPIK tile both render `stone` (a neutral
tan/brown), while the actual TOPIK page a user lands on after tapping either tile still renders
in vermilion/accent + blue. Before this fix-pass, honeycomb and in-page chrome agreed (both
vermilion-family); after it, they now disagree — a new cross-page inconsistency introduced as a
side effect of narrowing this batch's fix to LearnMenu + Today only. This wasn't in either
original review's file list (`Topik.tsx`/`MockMode.tsx` weren't scoped) and the checklist I was
given explicitly scoped SHOULD-FIX-6 verification to "LearnMenu's hue map AND Today's tile
sites," so I'm not marking this a REGRESSION against any specific checklist item, but it
directly undercuts the "one skill, one color" premise the whole batch was chartered around, one
surface later than the honeycomb. Recommend a small follow-up: either migrate `Topik.tsx`'s
CityCard sites to `SKILL_COLOR.topik.tone` too, or explicitly document that "stone" is
honeycomb/Today-only styling and the TOPIK page itself intentionally keeps the vermilion/accent
treatment (and fix the now-stale doc comment either way).

## Gate results (re-run independently, `client/`)

- `npm run lint` — **0 errors, 0 warnings** (clean exit, no output)
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — **0 errors** (clean exit, no
  output)
- `npx vitest run` — **117 test files passed, 1955 tests passed** (0 failed) — exact match to
  `FIX_REPORT_r4.md`'s claimed numbers
- `npx vite build --outDir /tmp/km-r4rr` — **exit 0**, built in 552ms, same pre-existing >500kB
  chunk-size advisory only (`index-C_N-GrGH.js`, 839.31 kB / 242.77 kB gzip), unrelated to this
  diff

Targeted re-run of the four most relevant suites in isolation also confirmed: `4 test files
passed (4), 173 tests passed` for `skillHueDistinctness.test.ts`, `tokensContrast.test.ts`,
`LearnMenu.test.tsx`, `Today.test.tsx`.

## Recommendation

**Ready to ship.** All checklist items are genuinely fixed and independently verified —
numbers recomputed from scratch, not trusted from the report, and one deliberately-adversarial
probe (simulating the pre-fix cyan hex) confirms the new guard test would actually catch a
regression. The one new finding (TOPIK page's own stale vermilion/accent chrome) is a real
follow-up-worthy inconsistency but is cosmetic, pre-existing in spirit (the same hardcoded
`tone="accent"` sites existed before this batch too), and does not block this batch — file it as
a follow-up ticket rather than blocking phone round-4 on it.
