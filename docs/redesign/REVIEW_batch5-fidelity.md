# Batch-5 (cleanup) design-fidelity review — Diagnostic · MockMode · Images

**Reviewer:** independent senior design-engineering review (did not write this code)
**Branch:** `feat/redesign-cleanup` @ `9243489` (off `rebuild`)
**Scope:** the final reskin batch — `client/src/pages/Diagnostic.*`, `client/src/pages/topik/MockMode.*`, `client/src/pages/Images.*`
**Contract:** `DESIGN_SEOUL_DAY_NIGHT.md`

---

## Verdict

**PASS — the redesign is visually complete app-wide. 0 BLOCKERs.**

All three surfaces adopt the real Seoul character-device components (not a flat token reskin),
both worlds render through `data-theme` tokens, the accent picker stays orthogonal, there is no
hardcoded hex anywhere in the batch, and reduced-motion is honored (all motion lives in
`seoul-devices.css` behind `prefers-reduced-motion` gates). One SHOULD-FIX and two deferrable
follow-ups are listed below; none block the merge, but S1 should be closed before beta because it
is a genuine mobile-overflow on a real surface (50-item mock exams).

---

## Whole-app consistency verdict (the capstone question)

**The redesign is now visually uniform across every user-facing surface. Images was genuinely the
last flat `Topbar`.**

- **No page imports or renders `Topbar` anymore.** `grep "from '.*Topbar'" client/src` returns only
  `components/Topbar.test.tsx`; `grep "<Topbar" client/src/pages` returns nothing. Every remaining
  "Topbar" string in the tree is a docstring/comment/test-name referring back to the old chrome that
  was replaced. The builder's claim holds.
- **Diagnostic now matches Progress/Topik** — Intro + Results carry the shared `PageHubHeader`
  (`Diagnostic.tsx:319`, `:1131`); the section list, skills card and live item are `CityCard`
  signboards with a `DancheongRail` (`:331`, `:770`, `:1144`); the live run gets `SubwayProgress`
  (`:768`); Done uses the milestone `SealStamp` (`:1068`).
- **MockMode matches Topik — the F-183 seam is gone.** MockMode renders *inside* Topik's shared
  `Tabs` panel (`Topik.tsx:378`) beneath Topik's single `PageHubHeader` (`Topik.tsx:271`), and
  correctly carries **no second header**. Its section-select / chooser / start / live-exam surfaces
  are all `CityCard`, and the tone split mirrors the sibling exactly: live item `= sectionTone`
  (accent Reading / blue Listening), past-papers blue, deferred Writing `plain`+inert, results a
  shared `feat` hero (`MockMode.tsx:213`, `:750`). The shared `TopikResults` `feat` CityCard is used
  by both Study and Mock, so the two results screens are identical.
- **Images matches Uploads/UploadViewer** — `PageHubHeader` replaces the bare `Topbar`
  (`Images.tsx:250`); sample rows, recent grid tiles, the capture photo and the detected-word list
  are `CityCard tone="plain"` (`:454`, `:497`, `:631`, `:687`), the same neutral choice Uploads and
  UploadViewer already make.

No surface is left on the old flat header, and none is off `PageHubHeader`/`CityCard`. **Capstone
achieved.**

---

## Fidelity checklist

| Check | Diagnostic | MockMode | Images |
|---|---|---|---|
| Real character-device components (not a flat token reskin) | ✅ #4/#2/#1/#5/#7/#8 | ✅ #1/#2/#5/#7/#3/#6/#8 | ✅ #4/#2/#1/#3/#6/#8 |
| Both worlds via `data-theme` (no orphaned hard-coded colors) | ✅ | ✅ | ✅ |
| Accent picker orthogonal (`--km-tone` / `--vermilion`) | ✅ | ✅ | ✅ |
| No hardcoded hex (`grep` clean across all 6 files) | ✅ | ✅ | ✅ |
| Bilingual intact | ✅ | ✅ | ✅ |
| Reduced-motion honored (device CSS gated) | ✅ | ✅ | ✅ |
| Mobile-first, no off-screen-right clip | ✅ (16 items) | ⚠️ **S1** (50-item subway) | ✅ (min-width:0 fixes) |
| WCAG AA both worlds (tokens vetted in foundation) | ✅ | ✅ | ✅ |

Notes confirming quality of the reskin:
- Honest-empty devices (#3/#6 giwa + hangul watermark) are correctly gated to *genuine* emptiness,
  never to a loading/error state — Diagnostic omits them entirely (documented precedent), MockMode
  drives them off a real `attemptsEmpty` predicate (`MockMode.tsx:518`), Images applies them only in
  the `words.length === 0` branch (`:687`).
- Accent-aware hovers are done through `color-mix(in srgb, var(--km-tone) 10%, transparent)`
  (`MockMode.css:127`) and `border-color: var(--vermilion)` (`Diagnostic.css:31`,
  `MockMode.css:136`) — the `--km-tone`/`--vermilion` aliases track `[data-accent]`, so both worlds
  and every accent preset come free. The Diagnostic choice-hover rule correctly targets the answer
  buttons (`km-diagnostic__choice`, `Diagnostic.tsx:1036`).
- `.km-rain-sheen` (#8) is Night-only and reduced-motion-safe by its own gate
  (`seoul-devices.css:36`, `:60`) on all three roots.

---

## Findings

### BLOCKER
None.

### SHOULD-FIX

**S1 — `SubwayProgress` overflows / becomes illegible with 50 dots on a mock exam (mobile).**
`MockMode.tsx:582` passes `steps={total}` to `SubwayProgress`, and a mock Reading/Listening exam is
**50 items** (`MockMode.tsx:201–202`). `SubwayProgress.css` lays the stations out as a
`display:flex; justify-content:space-between` row of `flex:none` fixed **10px** dots with **no
wrap, no `overflow-x`, and no dot-count cap**. 50 dots × 10px = ~500px of intrinsic width against a
~330px phone content box → the stations overflow the track to the right (or overlap), which trips
the §8 non-negotiable "*nothing clips off-screen-right*". Diagnostic (16 dots ≈ 160px) and Topik
Study drills are comfortably under budget, so this is specific to the new 50-item mock exposure this
batch introduced. The `QuestionPalette` jump-grid below still provides working navigation, so it is
not a hard blocker — but it is a real visual break on a real screen and should close before beta.
*Root cause is the foundation `SubwayProgress` component, not MockMode's usage.* Suggested fix:
cap/condense dots above a threshold (e.g. render a compressed line past ~24 stations), or wrap the
track in an `overflow-x:auto` scroller, or only mount the subway for `steps ≤ N` and let the palette
carry longer runs. Cite: `client/src/components/SubwayProgress.css` (`.km-subway__stations`,
`.km-subway__station`), `MockMode.tsx:582`.

### NIT

**N1 — Orphaned CSS in shared `styles/index.css` (ruling: remove, but SURGICALLY, in a dedicated
follow-up — NOT this batch).** Confirmed genuinely dead by className grep (no `.tsx` reference
outside comments):

- `.km-diagnostic__display` (index.css:3061)
- `.km-diagnostic__progress` (:3120) and `.km-diagnostic__progress-fill` (:3126)
- `.km-diagnostic__results-title` (:3258)
- `.km-diagnostic__goals-card` (:3274), `.km-diagnostic__goals` (:3282),
  `.km-diagnostic__goal-row` (:3290), `.km-diagnostic__goal-num` (:3298) — from the F-143 removal
- `.km-mock__section` (:2876), `.km-mock__section:hover` (:2890),
  `.km-mock__section--disabled`/`:disabled` (:2891–2892)

**The removal is safe only if surgical, because live and dead selectors are interleaved:**
`.km-diagnostic__progress-label` (:3119) is **still used** (the "N / M" readout at
`Diagnostic.tsx:759`) and sits *directly above* the orphaned `.km-diagnostic__progress` block; and
`.km-mock__sections` (:2871) plus the child spans `.km-mock__section-en/-kr/-go/-soon` (:2896–2904)
are **still used** by the new `.km-mock__section-btn` markup. A careless "delete the progress/section
rules" would clobber those. Given the interleaving *and* that `index.css` was under parallel edits
from three surfaces this batch, the builder's decision to leave the dead rules in place and flag
them is **defensible and low-risk**. Ruling: **do NOT fold this into batch-5's fix-pass** — open one
dedicated shared-file cleanup ticket after this batch merges, removing only the eight/three
selectors above and explicitly preserving the interleaved live ones.

**N2 — `WordPopover` still renders bespoke dialog chrome instead of the shared `Sheet` (ruling:
worth ONE final follow-up ticket, deferrable to post-beta).** `components/WordPopover.tsx` builds its
own `.km-popover__backdrop` + `.km-popover` surface (`:157`, `:164`) rather than composing the now
tone-aware shared `Sheet`. It is shared across **five** pages (Ttmik, Reading, Chat, Images,
MockMode). It is already `role="dialog"` + `aria-modal="true"` + `aria-labelledby` with a real close
control and is token-driven, so this is a "promote to shared primitive" consolidation, not a fidelity
or a11y gap. Value is real (it's the last bespoke popup in the redesign) but low, and the risk of
touching a 5-consumer shared primitive is non-trivial — **file it as the final redesign follow-up
and let it ride to post-beta polish; it does not gate this batch.**

### PRAISE

- **The capstone landed cleanly.** Images really was the last `Topbar`; the whole app is now on one
  header recipe and one card system. Verified by import + JSX grep, not just the builder's word.
- **The F-183 seam is properly closed at the architecture level** — MockMode nests under Topik's
  single header and reuses the exact `sectionTone` split and the shared `feat` `TopikResults` hero,
  so Study↔Mock read as one continuous surface rather than two reskins that merely resemble each
  other.
- **Zero hardcoded hex across 6 files**, all color via `--km-tone`/token aliases, with genuinely
  accent-aware hovers (`color-mix`) rather than a one-size vermilion tint.
- **Honest-empty discipline held** — the giwa/watermark pairing is driven off real emptiness
  predicates everywhere, never a loading/error state.

---

## Coordination observations — final follow-ups before beta

1. **S1 (SubwayProgress 50-dot mobile overflow)** — foundation-component fix; affects the mock
   Reading/Listening runner. Close before beta.
2. **N1 shared-file dead-CSS cleanup** — one surgical ticket, *after* this batch merges; preserve the
   interleaved live selectors called out above.
3. **N2 `WordPopover` → `Sheet` promotion** — optional final consolidation ticket; safe to defer to
   post-beta polish.

With S1 addressed, the Seoul "Day & Night" reskin is complete and uniform across the entire app.
