# Fix Report: Round-4 batch (colors + Today layout + px→rem)

Fix-pass agent, working from three independent reviews on `feat/phone-round4`
@ `15fcbf3`: `REVIEW_r4-colors.md` (2 BLOCKER + 4 SHOULD-FIX + 1 NIT),
`REVIEW_r4-today.md` (1 SHOULD-FIX), `REVIEW_r4-textsize.md` (2 NIT, no
action required — the px→rem batch was a clean PASS). Client-only; no
deploy.

## Disposition by finding

### REVIEW_r4-colors.md

**BLOCKER-1 — Reading(cyan) vs Listening(moss) near-collision (ΔE76 ≈ 21.5
Day).** **FIXED.** Re-tinted `--cyan` only (Day: `#256E7D` → `#254856`,
`--cyan-soft`: `#DCEEF0` → `#E3EEF2`). `--moss` was deliberately left
untouched: it is not just "Listening's color" — it's aliased to
`--dan-jade`, the app-wide success/correct semantic, and feeds
`--km-mastery-mastered` plus dozens of unrelated UI elements (toasts,
pills, progress fills, rating buttons — see `grep -rn "var(--moss"`).
Retinting it to fix a Reading/Listening tile clash would have silently
recolored "correct answer" everywhere in the app. `--cyan` has zero
semantic reuse outside Reading, so it was the only safe lever — this
matches what the ticket itself offered ("shift cyan bluer and/or moss
warmer/yellower as needed"), and I picked the branch that doesn't have a
hidden blast radius. Result: Day moss/cyan ΔE76 21.5 → 31.6. Night was
already fine (46.2) and left alone.

**BLOCKER-2 — Grammar(vermilion) & TOPIK collapse to the same class +
touch in the honeycomb.** **FIXED at the root**, per the ticket's own
"minimum fix" recommendation (7th dedicated hue for TOPIK), extended one
step further: TOPIK gets its own **`stone`** hue (a fixed, neutral
"assessment" tone — `#69523A` Day / `#A69FBC` Night) and Grammar gets its
own **`crimson`** hue (fixed to the current default-accent values, decoupled
from the accent picker — mirrors the pre-existing `--ochre`-locked
pattern). Neither is `--vermilion` anymore, so they cannot share a class
(BLOCKER-2's direct bug) or repoint together under a non-default accent
(SHOULD-FIX-5, see below). The three false "non-adjacent" comments
(`LearnMenu.tsx` module header, `COMB_ROWS` doc comment, the old `HEX_HUE`
doc comment) are corrected — I did NOT just delete the claim, I replaced
it with the actual geometric fact (row-2-center is adjacent to *all four*
of its row-1/row-3 neighbors in any 2-3-2 layout with 7 tiles, so there was
never a non-adjacent slot available) and note that adjacency is now moot
because every tile has its own non-shared hue. The reviewer's own
"coordination observation" (row-2-center is unfixable by relabeling alone)
is exactly why I didn't try a `COMB_ROWS` reshuffle — the fix had to be a
new hue, not a new position.

**SHOULD-FIX-3 — Grammar/TOPIK Night-theme token drift (vermilion vs
vermilion-bright).** **FIXED as a structural consequence of BLOCKER-2's
fix**, not patched in isolation. Grammar no longer reads any `--vermilion*`
token at all (it has its own `--crimson`/`--crimson-ink`/`--crimson-soft`,
identical in both Day and Night to what the OLD default-accent vermilion
values were, so the visual result under the default accent is unchanged).
There is now exactly one token family per skill, so a Day/Night drift like
this cannot recur for Grammar or TOPIK.

**SHOULD-FIX-4 — Vocab(indigo) vs Writing(violet) tight (ΔE76 ≈ 19.5
Night / 22.6 Day).** **FIXED.** Re-tinted `--violet` in both themes:
Day `#6B4E8C` → `#8A3399` (muted blue-purple → true magenta-purple), Night
`#9B7CFF` → `#C05CEB` (same hue shift, kept at neon brightness/saturation
consistent with the other Night hues). `--indigo` was left untouched
(Vocab's blue identity + its role as the fixed `--dan-cobalt` alias didn't
need to move — violet had the larger available hue-space to move into
without landing on another skill). Result: Day 22.6 → 65.8, Night 19.5 →
40.8.

**SHOULD-FIX-5 — accent-preset 3-way collision.** **FIXED**, and verified
rather than assumed. TOPIK's new `stone` hue and Grammar's new `crimson`
hue are BOTH fixed regardless of `[data-accent]` (same locking pattern as
`--ochre`) — I checked the specific collision the review named (Grammar/
TOPIK landing on Vocab's `--indigo`=`--dan-cobalt` under the blue preset,
or Listening's `--moss`=`--dan-jade` under mint) and it cannot recur:
`--crimson`/`--stone` never read `--vermilion` or any accent-repointed
token, so there is nothing left in the skill-color system that tracks the
accent picker. I went further than "verify TOPIK's new hue resolves it" —
I also decoupled *Grammar* from `--vermilion`, because giving TOPIK alone a
new hue would NOT have fully closed this finding: Grammar's old
`tone="accent"` assignment would still have re-pointed to `--dan-cobalt`/
`--dan-jade` under the blue/mint presets and landed on Vocab/Listening's
fixed hues, a 2-way collision the review's phrasing ("no fixed skill hue
... tracks the user accent") reads as in-scope. Documented in `--crimson`'s
doc comment (index.css) and `lib/skill-colors.ts`'s module comment.

**SHOULD-FIX-6 (ROOT CAUSE) — single source of truth.** **FIXED.** Added
`client/src/lib/skill-colors.ts` exporting `SKILL_COLOR`, a
`Record<LearnSubpageId, { hexHue, tone }>` — the ONE place the skill→color
assignment is declared. `LearnMenu.tsx`'s honeycomb (`hexHue`) and
`pages/Today.tsx`'s 12 `ActivityTile`/`DoneTodayRow` call sites (`tone`,
all 6 skills, not just Grammar/TOPIK) now both import and read this object
instead of hand-copied literals. A regression test
(`skillHueDistinctness.test.ts`, see below) asserts the two fields resolve
to the identical final CSS color in both themes for all 7 entries — "same
skill, same color, both surfaces" is now enforced by a test that would fail
on drift, not just promised by a comment.

**NIT-7 — LearnMenu.test.tsx's F-189 test overclaims "the SAME six
skill→hue tokens Today's tile carousels consume" without touching
`Today.tsx`.** **FIXED as a side effect of SHOULD-FIX-6.** The claim is
now literally true (both files import `SKILL_COLOR`), and
`skillHueDistinctness.test.ts`'s second `describe` block directly asserts
cross-surface equality — closing the exact gap the NIT identified, in a
dedicated test rather than a docstring.

**PRAISE items — preserved, not touched.** `tokensContrast.test.ts`'s AA
harness, the `--ochre`-locked pattern (and `--km-mastery-*`, verified
byte-for-byte unchanged — see Verification below), and
`DancheongRailTone`'s template-interpolation (no switch/exhaustiveness trap
— confirmed no `case 'blue'|'mint'|...` exhaustive switches exist anywhere
in `client/src`, so extending the union with `crimson`/`stone` needed zero
consumer changes beyond the CSS rules).

### REVIEW_r4-today.md

**SHOULD-FIX — `useCenterOnMountRef` doc comment credits `firedRef` for
the no-re-center guarantee.** **FIXED.** Rewrote the paragraph (one
comment block, `Today.tsx`) to state plainly that the `useCallback(...,
[])` stable identity is what makes ordinary re-renders a no-op, and that
`firedRef` is defense-in-depth only (guards a same-callback-fires-twice
case React doesn't do today but nothing guarantees never will). Explicitly
flagged the exact failure mode the review warned about: a future
"simplification" that drops `firedRef` believing the comment's old
framing, then someone adds a dependency to the `useCallback` — that
combination would silently break centering.

### REVIEW_r4-textsize.md

Both NITs are pre-existing, tests-and-awareness-only (no code defect in
this commit, and the file was already a clean PASS) — **DEFERRED**, no
action needed per the review's own recommendation ("not worth blocking
on", "flagging for awareness only"). Out of this fix-pass's scope (colors +
Today doc-comment were the actionable items).

## Final 7-hue palette

| Skill | Day hex | Night hex |
|---|---|---|
| Vocab (indigo) | `#2B5F9E` *(unchanged)* | `#5C87FF` *(unchanged)* |
| Grammar (crimson, NEW — was vermilion) | `#C0492E` | `#FF3E6C` |
| Hanja (ochre, **locked, unchanged**) | `#C98A1E` | `#FFB43D` |
| Reading (cyan, retinted) | `#254856` *(was `#256E7D`)* | `#33D6EF` *(unchanged)* |
| Listening (moss, **unchanged**) | `#2E7D6B` | `#12C08A` |
| Writing (violet, retinted) | `#8A3399` *(was `#6B4E8C`)* | `#C05CEB` *(was `#9B7CFF`)* |
| TOPIK (stone, NEW — was vermilion/accent) | `#69523A` | `#A69FBC` |

Minimum pairwise ΔE76 across all 21 pairs of these 7 hues: **Day 31.6**
(moss/cyan), **Night 40.8** (indigo/violet) — both clear the ~28 floor with
margin, verified by `skillHueDistinctness.test.ts` (computed straight off
the parsed `index.css` tokens, not hand-typed constants).

## AA contrast (WCAG, both re-verified by script, not assumed)

`--<hue>-ink` on `--<hue>-soft` (the honeycomb's actual text pairing,
`tokensContrast.test.ts`):

| Hue | Day | Night |
|---|---|---|
| cyan | 8.31:1 | 9.08:1 *(unchanged)* |
| violet | 5.77:1 | 5.42:1 |
| crimson | 4.67:1 *(= existing `--vermilion-ink`/`-soft` pair, reused verbatim)* | 6.29:1 |
| stone | 6.08:1 | 6.77:1 |
| indigo/moss/ochre | unchanged, still passing (pre-existing values, not touched) | unchanged |

`--on-vermilion` text on the raw `--km-tone` fill (SealStamp milestone
badges, `tokensContrast.test.ts`'s "km-tone fill contrast" describe block):

| Tone | Day | Night |
|---|---|---|
| cyan | 9.81:1 | 11.18:1 *(unchanged)* |
| violet | 6.97:1 | 5.56:1 |
| crimson | 4.96:1 | 5.73:1 |
| stone | 7.32:1 | 7.73:1 |

All comfortably clear 4.5:1 AA in both themes.

## Verification performed (not assumed)

- **`--km-mastery-*` untouched.** `grep -n "km-mastery-mastered\|practicing\|new" client/src/styles/index.css` shows all three occurrences (Day, Night, no-JS media mirror) still read `var(--moss)` / `var(--ochre-ink)` / `var(--paper-mute)` — byte-identical to before this diff.
- **Same hue, both surfaces, both themes, all 7 skills.** `skillHueDistinctness.test.ts`'s second `describe` block resolves `--<hexHue>` (LearnMenu path) and `.km-tone--<tone>`'s `--km-tone` chain (Today path) independently from the parsed CSS and asserts equality — 14 assertions (7 skills × 2 themes), all passing.
- **No stray hardcoded old hex values left anywhere** (`grep -rn "#256E7D\|#6B4E8C\|#9B7CFF\|#1D1638\|#AE96FF\|#DCEEF0\|#ECE3F1"` across `client/src` — zero hits outside this fix's own explanatory comments).
- **No exhaustive `tone` switch statements exist** anywhere in `client/src` that could silently no-op for `crimson`/`stone` (confirmed via grep for `case 'blue'|'mint'|...` patterns — none found; every consumer template-interpolates `km-tone--${tone}`).
- **Pill's unrelated `tone="ochre"`** (a completely separate `PillTone` enum, not `DancheongRailTone`) was correctly left untouched in `Today.tsx` — only the `ActivityTile`/`DoneTodayRow` (`CityCardTone`) call sites were migrated to `SKILL_COLOR`.

## Out of scope (flagged, not fixed)

- `components/CityCard.tsx`'s own doc comment enumerates `tone` values but
  was already stale before this batch (missing `cyan`/`violet` from an
  earlier round) — not touched here since neither review named this file,
  and it's meta-documentation, not a functional or false-claim defect like
  the ones this batch was chartered to fix. Flagging for whoever next
  touches `CityCard.tsx`.
- `BUGS_AND_FEATURES.md`/other project markdown mentioning the old
  Grammar=vermilion/Writing=vermilion assignment — docs-only, out of this
  client-code fix-pass's scope.

## Gate results (from `client/`)

- `npm run lint` — **0 errors / 0 warnings**
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — **0 errors**
- `npx vitest run` — **117 test files passed, 1955 tests passed** (0 failed)
- `npx vite build --outDir /tmp/km-r4fix` — **exit 0** (pre-existing >500kB chunk-size advisory only, unrelated to this diff)

## Self-assessment

The color re-tint is the substantive work here, and I verified it
numerically end-to-end rather than eyeballing swatches: every claimed ΔE76
and contrast ratio in this report was computed by a standalone script
(sRGB→linear→XYZ→CIELAB, standard D65 formulas) and then independently
re-derived inside the actual test suite that now guards it
(`skillHueDistinctness.test.ts`, `tokensContrast.test.ts`) — both computed
from the literal `index.css`/`seoul-devices.css` text at test time, so a
future re-tint that regresses either the distinctness floor or AA contrast
fails the suite, not just this report. I rejected two tempting shortcuts
along the way: retinting `--moss` (would have silently recolored the
app-wide "correct answer" semantic) and giving TOPIK a new hue without
also decoupling Grammar from `--vermilion` (would have left SHOULD-FIX-5's
2-way collision live). The one place I extended past the ticket's literal
ask is `lib/skill-colors.ts` covering all 6 skills' `tone=` sites in
`Today.tsx`, not just Grammar/TOPIK's — SHOULD-FIX-6 asked for a shared
source of truth "consumed by BOTH LearnMenu and Today's tile carousels,"
and doing it for only 2 of 8 call sites would have left the exact
half-migrated state that let Finding 3 (the vermilion/vermilion-bright
drift) ship undetected in the first place.
