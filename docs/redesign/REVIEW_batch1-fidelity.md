# Review: Batch-1 (Today+Progress) design fidelity + consistency

Reviewer: independent senior design-engineering reviewer (did not write this code).
Scope: fidelity to `DESIGN_SEOUL_DAY_NIGHT.md` + the approved `km-prototype.html`
mockup, and cross-page consistency between **Today** and **Progress**. Per-page
logic is out of scope (other reviewers). No code was modified.

Branch `feat/redesign-today-progress`; files reviewed:
`client/src/pages/{Today,Progress}.{css,tsx}` against `rebuild`, plus the
foundation components (`SkylineHeader`, `SubwayProgress`, `SealStamp`,
`DancheongRail`, `CityCard`, `CollapsibleTile`) and
`styles/seoul-devices.css` / `CityCard.css` / `CollapsibleTile.css`.

---

## Summary verdict: **PASS WITH CONDITIONS**

Both pages genuinely adopt the Seoul Day/Night identity through the real
character-device components — not a flat token reskin. Both themes are wired
through tokens end-to-end, accent is orthogonal and correctly tracked, and there
is **zero hardcoded hex** in either page's CSS or TSX (the only `#` literals are
the pre-existing, documented, WCAG-tuned `--kmp-*` skill-color *token
definitions* in `Progress.css`, which the design doc explicitly sanctions —
"Skill colors stay").

No true BLOCKER (no page fails to render a theme; no provable AA failure; no
*side-by-side* jarring break). But there are **two real cross-page divergences in
core elements** — the section-card surface and the page-header treatment — that a
user perceives on navigation and that both stem from the same class of shared-file
scoping shortcut. The verdict is conditional on the follow-up called out below
(a shared `CollapsibleTile`/`CityCard` variant) being ticketed.

---

## Fidelity checklist

| Device (doc §4) | On Today? | On Progress? | Consistent across the two? | Reference |
|---|---|---|---|---|
| #1 Signboard/hanji card (`CityCard`) | ✅ every `ActivityTile` wraps `CityCard` (`Today.tsx` `ActivityTile`, ~L1409) | ⚠️ **No** — the 3 section cards are plain `Card` via `CollapsibleTile` | ❌ **divergent** (see headline finding) | `Today.tsx:1409`, `Progress.tsx:451/478/487` |
| #2 Dancheong rail (`DancheongRail`) | ✅ inside each tile's `CityCard rail`, + standalone sibling on Writing tile (`Today.tsx:1637`) | ✅ standalone divider under header (`Progress.tsx:435`) | ⚠️ different *jobs* (leading-edge vs horizontal divider) | `Today.tsx:1637`, `Progress.tsx:435` |
| #3 기와 giwa texture (`km-giwa`) | ✅ error wrap (`Today.tsx:1707`) | ✅ empty state (`Progress.tsx:513`) | ✅ | both |
| #4 Namsan skyline (`SkylineHeader`) | ✅ bare strip + separate `Topbar` heading (`Today.tsx:1774`) | ✅ heading passed into `title` slot (`Progress.tsx:408`) | ❌ **divergent header architecture** (see finding S-2) | `Today.tsx:1774`, `Progress.tsx:408` |
| #5 Subway progress (`SubwayProgress`) | ❌ deliberately omitted (documented — no honest denominator) | ✅ attempt-count line (`Progress.tsx:612`) | ✅ acceptable — Today's omission is reasoned in-file | `Progress.tsx:612`; `Today.tsx` header comment |
| #6 Hangul watermark (`km-hangul-watermark`) | ✅ "Suggested learning" eyebrow, glyph `배` (`Today.tsx:2016`) | ✅ empty state, glyph `성장` (`Progress.tsx:513`) | ✅ | both |
| #7 Seal stamp (`SealStamp` milestone) | ✅ honest "Done today" row (`Today.tsx` `DoneTodayRow`, ~L1455) | ✅ "New best" milestone on personal best (`Progress.tsx:597`) | ✅ both gated on real data | `Today.tsx:1455`, `Progress.tsx:597` |
| #8 Rain-neon sheen (`km-rain-sheen`) | ✅ on `section` root (`Today.tsx:1768`) | ✅ on `section` root (`Progress.tsx:381`) | ✅ identical usage | both |
| #9 Mother-of-pearl (`km-najeon`) | ⚠️ not used (fine — reserved for the jewel; Today's seals are the "done" mark) | ✅ on the "New best" seal only (`Progress.tsx:602`) | ✅ both restrained per doc ("sparingly") | `Progress.tsx:602` |

Accent orthogonality: **correct in both worlds.** `--vermilion` is the
accent-picker knob (`styles/index.css:348-394` re-points it per
`[data-accent]`), and the tone system routes `accent → --km-tone → --vermilion`
(`seoul-devices.css:152`). Both pages drive tone through this chain, so a
blue/mint accent recolors both. (See PRAISE re: the Writing-tile workaround
preserving this.)

---

## Cross-page consistency findings (headline section)

Two independent builders produced two pages that mostly feel like one app, but
**two core elements drifted** — and, per the reviewer's brief, both are the classic
"two agents, two workarounds for the same shared-file gap" pattern.

### C-1 (top finding) — The section card is a glowing signboard on Today and a flat card on Progress
This is the single most perceptible inconsistency and it is **also a fidelity miss
on Progress vs the mockup**, which makes it stronger than a mere style drift:

- In `km-prototype.html`, the **Progress** screen's collapsible sections are
  `.sign` elements — i.e. full signboards: at Night a neon border + inner/outer
  glow (mockup L93), at Day a hanji card with the 4-band dancheong `::before`
  stripe (mockup L139-140). The mockup's Progress is a stack of *glowing
  signboards*, one per section.
- The implementation renders those same three sections as **plain `Card`** (via
  `CollapsibleTile`, which hardcodes `<Card>` internally) — no neon border, no
  glow, no rail. `Progress.css` adds spacing/skyline/rail-divider rules but never
  a signboard surface on `.km-progress__section`.
- Meanwhile **Today's** one collapsible (the Writing tile) *is* dressed as a
  signboard: `Today.css` L1041 reproduces CityCard's exact Night neon formula on
  `.km-today__writingTile`, and a sibling `DancheongRail` supplies the edge. So
  Today's collapsible is mockup-faithful and Progress's is not.

Net user perception: "a foldable section" glows and carries a rail on Today, but
is a flat dark/paper box on Progress. At **Night** the gap is most visible — the
mockup's Progress is wall-to-wall neon; the build's Progress is matte. This is a
core-element inconsistency **and** a fidelity regression against the mockup on
Progress specifically. It lands as a high-priority SHOULD-FIX (borderline
BLOCKER; not escalated only because the two pages live on separate tabs, so a
user never sees them abreast, and each page is internally coherent). See the
dedicated verdict below.

### C-2 — Header architecture differs between the pages
`SkylineHeader` was built with a `title` slot expressly "for the Today hub's
greeting/date" (component doc). Yet:

- **Today** renders `<SkylineHeader />` **bare** and puts its heading in a
  separate `<Topbar krTitle="오늘" …/>` **below** the strip (`Today.tsx:1774-1782`).
- **Progress** passes its eyebrow + `<h1>성장</h1>` **into** the `title` slot,
  which `SkylineHeader.css:80` positions `absolute; left:20px; bottom:14px` — i.e.
  overlaid on the skyline's lower-left, with a neon text-shadow at Night
  (`SkylineHeader.css:90`). Progress uses no `Topbar`.

So the big Korean page title sits **on** the skyline on Progress but in a **plain
bar beneath** it on Today — two different header treatments for the two hub pages.
(Ironically Today under-uses the very slot the component was designed around.)
Neither is wrong in isolation, but they should match. SHOULD-FIX.

### C-3 — Progress adds a dancheong divider under its header; Today does not
`Progress.tsx:435` renders a horizontal `DancheongRail` divider immediately below
the skyline; Today has no equivalent band under its header. Neither the mockup nor
the doc mandates this divider. Minor, but it's one more "these headers were built
by different people" tell. NIT (fold into the C-2 fix).

### Consistency that is correct (worth stating)
- **Section-organization difference is intentional and mockup-faithful:** Today
  = eyebrow-labeled, always-open carousels (action hub); Progress = collapsible
  folds (reference hub). The mockup shows exactly this split (Today tiles open,
  Progress cards with chevrons). Not a finding — good.
- `km-rain-sheen`, `km-hangul-watermark`, `km-giwa`, `SealStamp` gating, and the
  tone/accent plumbing are used identically across both pages.

---

## The two shared-file workarounds — visible inconsistency? Verdict

Both builders hit the **same** underlying gap: `CollapsibleTile` composes the
plain `<Card>` primitive (`CollapsibleTile.tsx:64`), and it is a shared component
neither page was scoped to edit. Their two workarounds:

- **(a) Today** reproduced CityCard's Night neon formula **inline** in
  `Today.css` (`.km-today__writingTile`, L1041-1052), scoped to that one tile,
  so its collapsible reads as a signboard next to its `CityCard` carousel
  siblings.
- **(b) Progress** left its collapsibles as **plain `Card`** and simply didn't
  dress them (no override).

**Verdict: yes — these two different workarounds produce a real, visible
cross-page inconsistency** (this is finding C-1). One page glows its collapsible,
the other doesn't, because one page patched around the shared gap and the other
accepted it. This is the textbook argument for the follow-up the brief predicted:

> **Recommended follow-up (the condition on this PASS):** add a first-class
> signboard variant to the shared surface — either a `CityCard`-backed
> `CollapsibleTile` (e.g. a `surface="city"` prop that swaps the internal `<Card>`
> for a `CityCard`) or a thin `CityCollapsibleTile`. Then **both** pages consume
> one treatment: Progress's three sections become mockup-faithful signboards, and
> Today drops its inline `.km-today__writingTile` neon copy in favor of the shared
> variant. This removes both workarounds and the divergence in one change.

Credit where due: Today's inline copy (workaround a) is **technically excellent** —
it uses CityCard.css's *exact* `color-mix(... var(--ink-2/1) ...)` /
`var(--vermilion)` formula (compare `Today.css:1041` to `CityCard.css:33`), and
because `--vermilion` *is* the accent-picker variable, the hand-rolled glow stays
accent-orthogonal with no extra wiring. It is the right stopgap. It's simply the
wrong *long-term* place for the rule to live — hence the shared-variant ticket.

---

## Findings

### BLOCKER
_None._ Both themes render through tokens; the skyline ships day+night SVG
layers; no color is orphaned; no provable AA failure was found; the one
core-element inconsistency (C-1) is not seen side-by-side so it is graded a
high-priority SHOULD-FIX rather than a blocker.

### SHOULD-FIX
1. **C-1 — Progress section cards are plain `Card`, not signboards** (also a
   mockup-fidelity miss). Render Progress's three `CollapsibleTile` sections as
   CityCard-backed signboards (glow/rail at Night, hanji+dancheong at Day) to
   match both the mockup and Today's collapsible. Ship via the shared-variant
   follow-up above. `Progress.tsx:451/478/487`, `Progress.css` (no
   `.km-progress__section` surface rule) vs mockup L93/L139-140.
2. **C-2 — Unify the page-header treatment.** Pick one: either Today also passes
   its heading into `SkylineHeader`'s `title` slot (dropping the separate
   `Topbar`), or Progress uses `Topbar` beneath a bare `SkylineHeader` like Today.
   Currently the big title is overlaid-on-skyline on Progress and in-a-bar-below
   on Today. `Today.tsx:1774-1782` vs `Progress.tsx:408-422`.
3. **Verify muted-caption contrast at 12px.** `.km-progress__trendnote` /
   `.km-progress__trendSkill` region use `var(--paper-faint)`, and
   `.km-today__linkBtn` uses `var(--paper-dim)` at 12.5px. These are shared,
   presumably-tuned tokens, but the smallest new text (`--paper-faint` at 12px,
   `Progress.css:71-75`) is the one most likely to sit under 4.5:1 in one theme —
   confirm against `tokensContrast.test.ts` coverage. Not confirmed as a failure;
   flagged to verify.

### NIT
1. **C-3 — dancheong divider on Progress only** (`Progress.tsx:435`); fold into
   the C-2 header unification so both hubs share one header stack.
2. **Collapsible padding differs across pages.** Today's collapsible is tightened
   to `14px 16px` (`Today.css:1054-1060`) to match its `CityCard` tiles; Progress
   uses `CollapsibleTile`'s default `16px 22px`. Harmless in isolation but another
   symptom C-1's shared variant should normalize.
3. **Writing tile approximates but isn't a `CityCard`.** Its sibling
   `DancheongRail` is not `feat`, and the Night override omits CityCard's stronger
   `--feat` glow, so the Writing tile reads slightly "quieter" than its `feat`
   TOPIK CityCard neighbor in the same carousel. A per-Today nuance; the shared
   variant resolves it.

### PRAISE
1. **Zero hardcoded hex** across both pages' CSS and TSX — the doc's
   non-negotiable, cleanly met. The only `#` literals are the sanctioned
   `--kmp-*` skill-color token definitions with an explicit ΔE/WCAG rationale
   block (`Progress.css:15-40`).
2. **Honest data everywhere.** Both pages refuse to fabricate: `SubwayProgress`
   omitted on Today rather than invent a denominator; `SealStamp`/`DoneTodayRow`
   gated on real attempt-history counts; `isNewBest`/`regressionTrend` guard
   `< 2`/`< 3` points; Progress's F-143 regression assertion pins that removed
   copy stays absent. This matches the memory-logged "test with real data / no
   fabrication" bar.
3. **The Today Night-glow workaround reuses CityCard's exact token formula**, so
   it stays accent-orthogonal and theme-correct despite being hand-rolled — the
   correct stopgap, well-commented as to *why* it's page-scoped.
4. **Reduced-motion + a11y are respected consistently:** tile hover transitions
   gated (`Today.css:875`), `SkylineHeader` parallax gated in the component,
   `SubwayProgress` is a single `role="progressbar"`, collapsibles keep bodies
   mounted+`inert` so every fetch still fires regardless of fold state.

---

## Coordination observations
- The **root cause of both cross-page findings is one shared-component gap**
  (`CollapsibleTile` → plain `Card`, and `SkylineHeader`'s optional title slot
  used by only one page). A single foundation follow-up — a CityCard-backed
  collapsible variant + a documented "canonical hub header" recipe both pages
  import — closes C-1, C-2, and NITs 1-3 together. Recommend one ticket, not
  five.
- Parallel-build drift showed up exactly where predicted: the *surface language*
  of the two pages' primary containers, and the *header* composition. The token
  layer (colors/accent/motion) did **not** drift — that foundation work paid off.
  Future batches should add a shared "page hub shell" (skyline header + heading +
  optional rail divider) so header architecture can't diverge page-to-page again.
