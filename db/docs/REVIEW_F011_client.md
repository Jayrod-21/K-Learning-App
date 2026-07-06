# REVIEW — F-011 client slice (diagnostic hardening), commit `72e5f01`

Reviewer: independent senior React review. Scope: `client/src/lib/skillBand.ts`,
`SkillBar.tsx`, `SkillsCompare.tsx` (+ tests), `Diagnostic.tsx` ResultsBlock (+ test),
`types/domain.ts`, `data/mocks/diagnostic.ts`, `services/diagnostic.test.ts`,
fixture updates in `Today.test.tsx` / `Progress.test.tsx`, band CSS in `styles/index.css`.

Verified in Docker (node:20-slim): `vitest run` on `Diagnostic.test.tsx`,
`SkillsCompare.test.tsx`, `services/diagnostic.test.ts` → **3 files, 53 tests, all pass**.
`tsc --noEmit` → clean. `eslint` on the four touched source files (strict config,
`react-hooks/set-state-in-effect` + `react-hooks/refs` as errors) → clean.

## Verdict: **NEEDS FIXES — 1 BLOCKER** (small, copy/constants-only; everything else in the slice is solid)

The two highest-risk areas the brief flags are both **correct**:

- **Degrade-to-no-band: PASS.** `hasVisibleBand` (skillBand.ts:27-33) is the single
  source of truth — SkillBar uses it to gate the band element AND the enriched
  aria-label (SkillBar.tsx:105-114), SkillsCompare uses the same function to gate the
  legend entry (SkillsCompare.tsx:98). A degenerate pair (low == high) renders exactly
  the pre-F-011 DOM: no `.km-skillbar__band` element, plain `"{label} skill"` label,
  no legend entry, no crash. Pinned by non-vacuous tests in both
  SkillsCompare.test.tsx:133-147 (band count === 1, listening 45–45 renders none) and
  Diagnostic.test.tsx:304-326 (grammar 44–44 renders none).
- **"Level 4" removal: PASS.** `git grep` confirms no rendered "Level 4" or
  "5 min ago"/"completed … ago" remains in ResultsBlock (Diagnostic.tsx:1036-1052 —
  only explanatory comments mention the old strings). The dead
  `.km-diagnostic__level` CSS rule was also removed (index.css). The disclaimer copy
  ("A short adaptive quiz — a rough placement estimate, not an official TOPIK score.
  Bands show how confident each result is.") is present and honest. Anti-regression
  assertions exist: `queryByText(/Level 4/)` and `queryByText(/min ago/i)` both
  asserted absent (Diagnostic.test.tsx:299-301).

---

## BLOCKER

### B1. Intro screen still advertises the OLD test shape — 8 items / 2 per section / 12 min — while the server now serves 16 / 4 / ~2× the time
`client/src/pages/Diagnostic.tsx:111-113` (and stale module doc at `:99-100`)

```ts
const INTRO_TOTAL_MINS = 12;
const INTRO_TOTAL_ITEMS = 8;
const INTRO_PER_SECTION = 2;
```

Rendered user-facing at `:274-275` ("진단평가 · 12 min · 8 items") and `:294`
("2 items" per section row). This same commit changed the server to
`ITEMS_PER_DIMENSION = 4` / `TARGET_ITEM_COUNT = 16`
(`server/src/routes/diagnostic.ts:81,91`), and the taking-screen progress bar takes
`total` from the server — so the user is promised 8 items on the intro and then
watches a progress bar count to /16. That is a directly user-visible contradiction
introduced by this commit, and for a feature whose entire theme is *honest labeling*
it is the exact sin F-011 exists to remove (the commit deletes one false claim in
ResultsBlock while its own server change falsifies three claims one screen earlier).
No test catches it (nothing asserts the intro counts). Fix: bump the three constants
(16 / 4 / ~20 min) with a comment cross-referencing `ITEMS_PER_DIMENSION` in
`server/src/routes/diagnostic.ts` so the next knob-turn doesn't repeat this, update
the stale module docstring at `:99-100` ("2 each … 8 items, ~12 min"), and add an
intro-copy assertion to `Diagnostic.test.tsx`.

## SHOULD-FIX

### S1. The defensive band paths are documented but not tested — no unit tests for `skillBand.ts`, and the inverted-pair sort is unpinned
`client/src/lib/skillBand.ts` (no test file), `client/src/components/SkillBar.tsx:100-111`

SkillBar's comment promises "an inverted server pair can't render a negative-width
band" (edges are min/max-sorted) and clamping defends out-of-range edges — the code
is correct (left = min%, width = max−min ≥ 0; clamp before compare means 101/102
collapses to 100/100 → no band) — but nothing exercises it: no test passes
`scoreLow > scoreHigh`, an out-of-range edge, or NaN. The happy path and degenerate
path are well pinned; the defensive paths exist only as comment claims. Add a small
`skillBand.test.ts` (hasVisibleBand: undefined / equal / clamped-equal / inverted /
NaN) plus one SkillBar render test with an inverted pair asserting sorted
left/width and the sorted aria range. Cheap insurance on the exact code a future
refactor is most likely to "simplify" away.

### S2. DoneBlock hint "Scoring against TOPIK II L4 reference." — borderline; keep the idea, fix the verb
`client/src/pages/Diagnostic.tsx:993`

Judged NOT a false placement claim: the results gap map genuinely defaults to the L4
reference line (`defaultRef: 'L4'`), so "L4 reference" describes a real comparison
anchor, not an awarded level — materially different from the deleted "Against TOPIK
II Level 4" result label. But "Scoring against" overstates it: the 0–100 scores are
computed independently of L4; L4 is only the default tick the bars are displayed
against. One-word copy fix: "Comparing against the TOPIK II L4 reference line." Note
the results-screen regression test would not catch this drifting ("L4" ≠ /Level 4/,
and DoneBlock renders in a different phase).

## NIT

### N1. A NaN band edge renders a large confident-looking band instead of none
`client/src/lib/skillBand.ts:31-33`. `hasVisibleBand(NaN, 70)` → `clampScore(NaN)` = 0
≠ 70 → true, so garbage renders a 0–70 band and the aria-label asserts "range 0–70".
NaN-to-0 mirrors the pre-existing score clamp, but for a *confidence claim* the
honest degrade is no band: guard with `Number.isFinite` on both edges.

### N2. aria-label range uses an en dash: "range 52–68"
`client/src/components/SkillBar.tsx:113`. Some screen readers announce this as
"fifty-two sixty-eight" with no separator. "range 52 to 68" is unambiguous.
(Alternatively move the range into `aria-valuetext`, which is the idiomatic slot for
a qualified progressbar value — current approach does not double-announce, since the
overlay is correctly `aria-hidden`, so this is polish, not a defect.)

### N3. Today's tile drops the band at the data layer, with the rationale only in the test file
`client/src/pages/Today.tsx:79-87` (`toSkillRows` omits `scoreLow`/`scoreHigh`);
rationale comment lives in `Today.test.tsx:150-152`. Defensible product call (the
compact tile is a glance surface), but the omission is in the mapping function, not
the compact presentation — if Today ever switches to the full variant the band
silently stays missing, and nothing in Today.tsx explains why. Either pass the edges
through (compact already renders no legend; the wash is subtle) or move the
"deliberately no band here" comment into `toSkillRows`.

## PRAISE

- **Single-source-of-truth visibility rule.** Extracting `hasVisibleBand`/`clampScore`
  into `skillBand.ts` — with an explicit note that the extraction exists so fast
  refresh keeps working (component modules export only components) — and consuming it
  from both SkillBar and the SkillsCompare legend is exactly right; bar and legend
  cannot disagree.
- **Overlay architecture is correct.** DOM order fill → band → tick with
  absolute positioning gives the right paint order: the translucent band reads across
  both the filled and empty track halves, the target tick stays on top, and
  `pointer-events: none` keeps it inert. Band left/width math is correct on the
  0–100 = % scale.
- **Theme handling is genuinely theme-aware.** `color-mix(in srgb, var(--paper) 14%, transparent)`
  keys off the theme's type color (dark ink on hanji, cream on sumi), so one rule is
  legible in both themes with no hardcoded color; the legend swatch adds a
  `--line-strong` border so a 14% wash stays visible off the track.
- **Type ripple done honestly.** `scoreLow`/`scoreHigh` are REQUIRED on
  `DiagnosticDimension` (domain.ts:325-334) and every constructor was updated —
  populated mock (with a deliberate degenerate `writing` row to exercise the
  fallback), Today/Progress/services test fixtures — with zero `any`/casts to dodge
  the contract (`tsc --noEmit` clean; the only casts are `as HTMLElement` on DOM
  queries in tests, which is fine). Component props stay optional, which is the right
  layering: the domain contract is strict, the reusable component is defensive.
- **Tests are non-vacuous.** They assert exact geometry (`left: 52%`, `width: 16%`),
  exact accessible names for both the banded and plain bars, `aria-hidden` on the
  overlay, legend gating via rerender, and the anti-regression literals — not just
  "renders without crashing".
