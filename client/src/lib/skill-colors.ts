/**
 * SKILL_COLOR — the single source of truth for "which skill gets which
 * color," consumed by BOTH `LearnMenu`'s honeycomb (`hexHue`) AND
 * `pages/Today.tsx`'s tile carousels (`tone`).
 *
 * F-189 fix-pass round 4 (SHOULD-FIX-6, REVIEW_r4-colors.md — "no single
 * source of truth ties LearnMenu's HEX_HUE map to Today's scattered tone=
 * literals"): before this file existed, the two surfaces each hand-copied
 * the same 7-entry assignment in their own vocabulary (LearnMenu's
 * `--<hue>` CSS-modifier names vs CityCard/DancheongRail/SealStamp's
 * `tone` prop names), with nothing enforcing agreement beyond comments
 * promising they matched. That drift is exactly what let Grammar/TOPIK's
 * Night-theme token mismatch (vermilion vs vermilion-bright) ship
 * undetected in the prior batch — a comment-enforced invariant is not a
 * real invariant. Both call sites now import THIS object; a future
 * skill/hue reassignment has exactly one line to change, and "same skill,
 * same color, both surfaces" is true by construction, not by discipline.
 *
 * Two fields per skill because the two consumers were built with two
 * different naming vocabularies (a symptom of the drift above, not
 * something this fix invents) — `skill-colors.test.ts` asserts they
 * resolve to the SAME underlying CSS custom property in both themes, so
 * even though the strings differ, the mapping cannot silently diverge:
 *
 *   - `hexHue` keys LearnMenu's `.km-learnmenu__hexwrap--<hexHue>` CSS
 *     modifier (index.css token family: indigo, moss, ochre, violet, cyan,
 *     crimson, stone).
 *   - `tone` keys the shared `.km-tone--<tone>` mechanism
 *     (styles/seoul-devices.css) that `CityCard`/`DancheongRail`/
 *     `SealStamp`/`SubwayProgress`/Today's `DoneTodayRow` all read via the
 *     `DancheongRailTone` union. This vocabulary predates the per-skill
 *     color system (`blue`/`mint` name the DANCHEONG PALETTE LAYER, not
 *     the skill) and is shared with non-skill chrome elsewhere in the app,
 *     so it isn't renamed to match `hexHue` — see DancheongRail.tsx's doc
 *     comment.
 *
 * TOPIK (the 7th LEARN sub-page, not one of the app's 6 skills — see
 * `lib/nav.ts`'s `LEARN_SUBPAGE_IDS`) gets its OWN dedicated `stone` hue,
 * not a skill's family and not the `accent`/`vermilion` runtime-accent
 * family it used to share with Grammar. That old arrangement (F-189's
 * first pass) was BLOCKER-2 in REVIEW_r4-colors.md: Grammar and TOPIK both
 * keyed into the literal SAME class (`--hexwrap--vermilion`), which (a)
 * rendered as one fused honeycomb shape — they are geometrically adjacent
 * in the 2-3-2 comb (row1-right and row2-center sit in the same interlock
 * valley; centering math worked out in the review) — and (b) could
 * 3-way-collide with Vocab or Listening's FIXED hues under the blue/mint
 * accent presets, because `--vermilion` itself re-points to
 * `--dan-cobalt`/`--dan-jade` under those presets — the exact hexes
 * `--indigo`/`--moss` are already pinned to. Grammar now reads `--crimson`
 * (a NEW fixed token, mirroring the default coral values but never
 * touched by `[data-accent]` — see index.css's `--crimson` doc comment)
 * and TOPIK reads `--stone` (a dedicated neutral "assessment" tone, also
 * fixed). Neither can drift with the accent picker, so neither can land on
 * another skill's fixed hex under any accent choice — resolving
 * SHOULD-FIX-5 as a structural consequence of fixing BLOCKER-2, not a
 * separate patch.
 *
 * Every pairwise ΔE76 among these 7 hues clears a ≥28 categorical-
 * distinctness floor in BOTH Day and Night themes — verified by
 * `styles/skillHueDistinctness.test.ts`, which parses the literal hex
 * values back out of `index.css` so a future re-tint can't silently
 * regress it.
 */
import { LEARN_SUBPAGE_IDS } from './nav';
import type { DancheongRailTone } from '../components/DancheongRail';

export type LearnSubpageId = (typeof LEARN_SUBPAGE_IDS)[number];

/** The 7 `--<hue>` token families the LearnMenu honeycomb's
 *  `.km-learnmenu__hexwrap--<hexHue>` CSS modifiers key into. */
export type SkillHexHue =
  | 'indigo'
  | 'moss'
  | 'ochre'
  | 'violet'
  | 'cyan'
  | 'crimson'
  | 'stone';

export interface SkillColor {
  /** LearnMenu honeycomb CSS-modifier suffix (index.css `--<hue>` token). */
  hexHue: SkillHexHue;
  /** Today/CityCard/DancheongRail/SealStamp `tone` prop value. */
  tone: DancheongRailTone;
}

export const SKILL_COLOR: Record<LearnSubpageId, SkillColor> = {
  flashcards: { hexHue: 'indigo', tone: 'blue' }, // Vocab
  grammar: { hexHue: 'crimson', tone: 'crimson' }, // Grammar
  hanja: { hexHue: 'ochre', tone: 'ochre' }, // Hanja (locked)
  reading: { hexHue: 'cyan', tone: 'cyan' }, // Reading
  ttmik: { hexHue: 'moss', tone: 'mint' }, // Listening
  writing: { hexHue: 'violet', tone: 'violet' }, // Writing
  topik: { hexHue: 'stone', tone: 'stone' }, // TOPIK (assessment, not a skill)
};
