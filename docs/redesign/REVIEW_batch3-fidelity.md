# REVIEW — batch 3 (LEARN batch A) design fidelity + cross-page consistency

Reviewer: independent senior design-engineering reviewer (did NOT write this code).
Branch: `feat/redesign-learn-a` @ `8eae3c8` (off `rebuild`).
Scope: 4 LEARN pages built in parallel by 4 agents —
`Review.{tsx,css}` (Flashcards), `Grammar.{tsx,css}`, `Hanja.{tsx,css}`, `Reading.{tsx,css}`.
References: `DESIGN_SEOUL_DAY_NIGHT.md`; mockups `km-learn.html` (Flashcards/Grammar/Hanja) +
`km-learn2.html` (Reading); shipped `Today.tsx`/`Progress.tsx` + Library pages; shared
`components/{PageHubHeader,CollapsibleTile,CityCard,SubwayProgress,SealStamp,DancheongRail,Sheet}` +
`styles/seoul-devices.css`.

---

## VERDICT: PASS (with 1 SHOULD-FIX consistency drift + follow-up recommendation)

All four pages render both worlds through tokens (no orphaned hard-coded colors), adopt the
shared `PageHubHeader` (zero lingering flat `Topbar`), and compose real character-device
components rather than a flat reskin. No BLOCKER. **0 theme-break / AA / core-inconsistency
blockers found.** The one material cross-page drift is **Hanja's bespoke Sheet chrome + raw
`.km-btn` usage** vs the shared `.km-review__sheet*` + `<Button>` recipe the other three pages
share (SHOULD-FIX). The recurring **tone-enum ochre gap** is real and I recommend promoting it
to a shared primitive as the batch-3 follow-up (details below).

---

## Fidelity checklist

| Page | Character devices present | Matches its mockup? | Consistent w/ shipped pages? |
|---|---|---|---|
| **Flashcards** (`Review.tsx`) | PageHubHeader (#4/#2); CityCard signboards for My-lists + seed tile (#1/#2); **SubwayProgress** session bar (#5, `tone="accent"`); flip card restyled as a CityCard-tone signboard keyed off `--km-tone` (#1); SealStamp `復` due + `完` **milestone** completion (#7); najeon shimmer bar on completion (#9); giwa+watermark empties (#3/#6); rain-sheen root (#8); Sheet create-list w/ shared chrome (#6-treatments) | YES — subway dots, flip+rate, "More examples" tile, lists-first landing, create-as-popup, add-to-review starts at 15 | YES — SubwayProgress `tone="accent"` identical to Progress/Hanja; shared `.km-review__sheet*`; shared `<Button>` |
| **Grammar** (`Grammar.tsx`) | PageHubHeader w/ `actions` Practice button (#4/#2); **CollapsibleTile `surface="city"`** per proficiency group, 4 tones cycled by index (#1/#2); CityCard `accent` rail drill **hero** card (#1); SealStamp `milestone tone="mint"` on Known rows (#7); giwa+watermark empties (#3/#6); rain-sheen root (#8); DetailSheet w/ shared chrome | YES — Learning/Known/Mastered wording, one-line forms, mark-mastered, **pick-a-form-to-drill-continuously** (F-158) | YES — reuses `.km-review__tabs`/`__tab`, `.km-review__sheet*`, `<Button>`; no SubwayProgress (drill is continuous — correct omission) |
| **Hanja** (`Hanja.tsx`) | PageHubHeader `railTone="plain"` (#4/#2); CityCard `tone="plain"` band + `feat` feature hero (#1/#2); **SubwayProgress** on BOTH drills (#5, `tone="accent"`); SealStamp `韓`/`完` + najeon (#7/#9); HanjaCell mastery remap moss/ochre/danger (F-167); giwa+watermark empties (#3/#6); rain-sheen root (#8) | YES — `sign plain` mastery card, index tiles color-by-mastery, `＋` quick-add, draw-drill ✓/✗ loop; `tone="plain"` matches the mockup's plain Hanja signboards | **PARTIAL** — devices fine, but **Sheets use bespoke `.km-hanja__quickadd`/`.km-hanja__picker` chrome + raw `.km-btn`**, not the shared `.km-review__sheet*` + `<Button>` the other 3 use |
| **Reading** (`Reading.tsx`) | PageHubHeader (#4/#2); CityCard `accent` rail reader-card (#1/#2, shared by chapter + story readers); Resume CityCard `tone="blue"` (#1); StoryGenerator CityCard `tone="mint" feat` **hero** + najeon shimmer on spark glyph (#1/#9); giwa+watermark empties (#3/#6); rain-sheen root (#8); TranslateSheet w/ shared chrome | YES — section chips, Resume signboard, mint Generate sign, tap-a-sentence translate popup, single-word tap-to-define preserved | YES — shared `.km-review__sheet*` (explicitly, per Mistakes/ReviewGrammar precedent); shared `<Button>`; Day serif passage treatment capped ~65ch per doc §3 |

---

## Cross-page consistency — HEADLINE

**The four parallel agents landed remarkably in-sync on the big pieces.** All four use
`PageHubHeader` (no flat `Topbar` survived); all four wrap featured surfaces in
CityCard / CollapsibleTile-`city`; all four put `.km-rain-sheen` on the page root and
`.km-giwa`/`.km-hangul-watermark` on genuine empty states only (never on loading/error);
SubwayProgress renders `tone="accent"` identically in Flashcards + Hanja + shipped Progress;
Hanja/Reading use the shared `useToast` (not a bespoke toast à la the mockup). This is the
consistency bar batch-2's `PageHubHeader` extraction was meant to buy, and it held.

**The one place the sync broke is Hanja's popups.** See SF-1.

---

## Tone-enum / HanjaCell-override verdict + recommended shared follow-up

**Facts confirmed:**
- `DancheongRailTone = 'accent' | 'blue' | 'mint' | 'plain'` (`DancheongRail.tsx:24`); the
  `--km-tone` map (`seoul-devices.css:152-157`) has **no ochre entry**.
- Per doc §2/§7, the Hanja **skill color** maps to **ochre** (`--dan-ochre` Day / a neon-amber
  Night). With no enum slot, Hanja falls back to `tone="plain"` everywhere:
  `Hanja.tsx:565` (`railTone="plain"`), `:701` (band), `:861` (feature) — the same fallback
  `Today.tsx`'s own Hanja tile already took. Hanja's character devices therefore read
  **neutral, not ochre** — a documented fidelity compromise (it happens to match the mockup,
  which also draws Hanja as `sign plain`, so it is not a blocker — but it diverges from the
  doc's skill-color contract).
- `HanjaCell`'s `practicing` state tracks `--vermilion` (accent-follows-picker), so F-167 had
  to **override it in page CSS** (`Hanja.css:99-107`, `.screen.km-hanja .km-hanja__grid
  .km-hanjacell--{banked,practicing,new}` → fixed `--moss`/`--ochre`/`--danger`) to stop a
  "practicing" tile reading blue/mint under a non-coral accent.

**Verdict: YES — promote to a shared primitive, exactly the batch-1 (CollapsibleTile `city`)
/ batch-2 (PageHubHeader) pattern.** Two distinct follow-ups (keep them distinct — they solve
different problems):

1. **Add an `ochre` skill-tone to `DancheongRailTone`** + its `--km-tone` mapping
   (Day `--dan-ochre`, Night a neon-amber token). Then Hanja's PageHubHeader/CityCards use
   `tone="ochre"` per the doc's skill-color system instead of `plain`; **Today's Hanja tile
   benefits too**, retiring its identical `plain` workaround. Small, mechanical, mirrors the
   existing accent/blue/mint rows.
2. **Give `HanjaCell` a semantic mastery-tone** (or repoint its `--*` state classes at fixed
   `--moss`/`--ochre`/`--danger` tokens instead of `--vermilion`), so the F-167
   `.km-hanja__grid` page override retires into the shared component.

**Caveat (important):** do NOT collapse these two. The mastery triad
(banked=green / practicing=yellow / new=red) is a **semantic status signal**; the ochre
skill-tone is **section identity**. They coincidentally both touch "ochre" but must stay
separate enums, or a future accent change or status recolor will corrupt the other.

---

## Findings

### BLOCKER
_None._

### SHOULD-FIX

- **SF-1 — Hanja's Sheets diverge from the shared sheet recipe (cross-page drift).**
  `Review.tsx:976-1035` (CreateListSheet), `Grammar.tsx:2374-2396` (DetailSheet), and
  `Reading.tsx:946-954` (TranslateSheet) all use the shared `.km-review__sheetBody` /
  `__sheetHead` / `__sheetTitle` / `__sheetActions` chrome with a top-right `<Button>` Close,
  per the batch-2 precedent. **Hanja's three Sheets do not:** `QuickAddSheet`
  (`Hanja.tsx:1128-1215`, `.km-hanja__quickadd`), `CreateListSheet` (`:1770-1815`,
  `.km-hanja__quickadd` + bare `<Eyebrow>`, no head/close row), and `AddHanjaPicker`
  (`:2294`, `.km-hanja__picker`) roll their own chrome and use **raw `.km-btn km-btn--gold`
  HTML buttons** (`:1204`, `:1795`) instead of `<Button>`. The most visible instance is the
  create-list popup: the SAME job ("create a list" drawer) reads as two different objects on
  Flashcards vs Hanja. Fold Hanja's sheets onto `.km-review__sheet*` + `<Button>` (or, if the
  intent is a Hanja-specific layout, at minimum adopt the shared `__sheetHead` + Close-in-
  corner so dismissal is consistent app-wide).

### NIT

- **N-1 — Completion-seal treatment differs between the two session-complete moments.**
  Flashcards renders `<SealStamp milestone char="完" size="lg" tone="accent">` +
  `.km-najeon--shimmer` (animated) (`Review.tsx:1944`, `:1961`); Hanja's deck-clear renders
  `<SealStamp char="完" size="md" tone="accent" className="km-najeon">` — **non-milestone**
  (no hand-stamped rotation) + **static** najeon (`Hanja.tsx:1392`). Same "you finished the
  session" beat; pick one stamp treatment. (Grammar/Review agree that `milestone` = mastery,
  so Hanja's completion arguably should be `milestone` too.)
- **N-2 — Hanja draw-buttons hover-guard asymmetry.** `.km-hanja__draw-right:hover:not(:disabled)`
  guards the disabled state (`Hanja.css:639`) but `.km-hanja__draw-wrong:hover` does not
  (`:649`). Right disables during an in-flight write; Wrong does not, so it's currently
  harmless, but the asymmetry will bite if Wrong ever gets a `disabled` state. Add
  `:not(:disabled)` for symmetry.

### PRAISE

- **P-1 — The only hardcoded hex on the whole batch is legitimate and well-handled.**
  `Hanja.tsx:2770` `ctx.strokeStyle = inkColor !== '' ? inkColor : '#3a3a3a'` — the canvas 2D
  API can't read CSS custom properties, so the code reads the **tokenized**
  `getComputedStyle(canvas).color` (which follows theme + accent) and only falls back to the
  literal in the jsdom/empty-string case. Grep of all 4 CSS + 4 TSX files returns no other hex.
- **P-2 — Flashcard-as-signboard without touching the shared component.** `Review.css:64-100`
  reproduces CityCard's Day-hanji / Night-neon recipe on `.km-flashcard__face` keyed off the
  same `--km-tone`, wrapped in `.km-tone--accent` — so the flip card reads as the *same*
  signboard object as every other CityCard, with the 3D flip mechanics untouched. Correct way
  to restyle a shared primitive from page scope.
- **P-3 — Reduced-motion is fully covered without per-page work.** najeon shimmer is gated in
  `seoul-devices.css:60` (animates only under `no-preference`); the flip drops its duration to
  ~0 in the shared `Flashcard` component; no page introduces an ungated animation.
- **P-4 — AA on the mastery tiles is not sole-carrier.** F-167's moss/ochre/danger are 3px
  `border-top-color` accents (not text), and per `Hanja.tsx:125-129` every tile's accessible
  name still carries the hangul reading + the detail-sheet's named state pill — color
  supplements, never replaces, the label. The tokens are the AA-checked pairs already shipped
  on Today/Progress.

---

## Coordination observations

- **Where 4 agents converged cleanly:** PageHubHeader adoption, rain-sheen root, giwa/watermark
  empty-state discipline, SubwayProgress `tone="accent"`, shared `useToast`, `<Button>` (3 of 4),
  `.km-review__sheet*` (3 of 4), CityCard for hero surfaces. The shared-primitive extractions
  from batches 1–2 did their job — most consistency came for free.
- **Where the parallelism showed a seam:** the Hanja agent hand-rolled its popup chrome and
  buttons (SF-1) instead of reaching for the shared sheet recipe — the same class of "missed
  the shared component" that batch-2's fix-pass caught with the Topbar/PageHubHeader split. A
  shared `Sheet` header sub-component (title + eyebrow + Close slot) would close this seam the
  way `PageHubHeader` closed the header seam.
- **The tone-enum gap is a genuine shared-primitive debt, not a per-page bug** — three
  independent workarounds now key off it (Today's `plain` Hanja tile, Hanja's `plain`
  everything, F-167's page CSS override). It has crossed the threshold where a shared fix is
  cheaper than the accumulating overrides; recommend it as the batch-3 follow-up ticket.
