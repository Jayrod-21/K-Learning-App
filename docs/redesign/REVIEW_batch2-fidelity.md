# REVIEW — Batch-2 (Library) design fidelity + cross-page consistency

**Reviewer:** independent senior design-engineering reviewer (did not write this code)
**Scope:** 6 Library pages — ReviewLibrary (index), ReviewVocab, ReviewDictionary, ReviewGrammar, Mistakes, Uploads + UploadViewer.
**Branch:** `feat/redesign-library` @ 2c2d4ad (off `rebuild`).
**Against:** `DESIGN_SEOUL_DAY_NIGHT.md`, `km-prototype.html` (Vocab / Library-index screens), `km-final.html` (Grammar / Mistakes / Uploads screens), and the shipped batch-1 pages Today/Progress + foundation components.
**Lens:** fidelity to mockups+doc; cross-page + cross-batch consistency; AA both worlds; no hardcoded hex. Per-page logic is other reviewers' job.

---

## Verdict

**CONDITIONAL PASS — 1 BLOCKER, 2 SHOULD-FIX.**

The batch is genuinely strong: **zero hardcoded hex anywhere** across all 7 files (CSS + inline), correct token-driven day/night, and the character devices are real components, not a flat reskin. The ReviewLibrary page-scoped override the prompt asked me to judge is **consistent with batch-1's technique, not a divergent one-off** (see PRAISE). Surface language (CityCard vs CollapsibleTile `surface="city"` vs flat Card) is used consistently for the right jobs, and where two browse lists differ (Vocab flat-list vs Grammar per-pattern signboards) **both faithfully match their own mockups** — that divergence is by-design, not drift.

The blocker is a single, glaring cross-page inconsistency: **two of the six pages skipped the shared hub-header recipe** and still render the pre-redesign `Topbar`. Because the header is the app's most-repeated element, this is exactly the "these pages were built by different people" signal the review exists to catch. Fix the header split + the two smaller consistency gaps and this is a clean PASS.

---

## Fidelity checklist

| Page | Devices used | Matches mockup? | Consistent w/ batch-1? |
|---|---|---|---|
| **ReviewLibrary** | SkylineHeader(title) #4, DancheongRail divider #2, CityCard rows +rail #1/#2 | ✅ prototype `/library` (rows as signboards, per-row tone) | ✅ header recipe = Today/Progress. ⚠️ **missing `km-rain-sheen` #8** |
| **ReviewVocab** | SkylineHeader #4, DancheongRail #2, CollapsibleTile `surface="city"` #1 (My Lists), Sheet popups #6-treatment, rain-sheen #8 | ✅ prototype Vocab (My-Lists fold + flat corpus list) | ✅ fully |
| **ReviewDictionary** | SkylineHeader #4, DancheongRail #2, rain-sheen #8, flat corpus list | ✅ (no dict-specific mock; matches Vocab's flat-list sibling) | ✅ fully |
| **ReviewGrammar** | CityCard-per-pattern +rail #1/#2, SealStamp #7, `km-najeon` #9 (modal only), Sheet, giwa+watermark empty #3/#6, rain-sheen #8 | ✅ final Grammar (per-pattern signboards) | ❌ **header = `Topbar`, not SkylineHeader** |
| **Mistakes** | CityCard-per-session +rail #1/#2, Sheet popup, giwa+watermark empty #3/#6, rain-sheen #8 | ✅ final Mistakes (date-divided square-tile grid) | ❌ **header = `Topbar`**; Sheet uses page-rolled classes, not shared |
| **Uploads** | SkylineHeader #4, DancheongRail #2, CityCard rows +rail #1/#2, giwa+watermark empty #3/#6, rain-sheen #8 | ✅ final Uploads | ✅ fully — model page for the recipe |
| **UploadViewer** | SkylineHeader #4, DancheongRail #2, CityCard page surface +rail #1 | ✅ final Uploads `.pdf` card | ✅ header recipe. ⚠️ **missing `km-rain-sheen` #8** |

---

## Cross-page consistency findings (headline section)

The 6 pages were built by 3 parallel agents; the audit hunt was for drift a **user** perceives.

### 1. The HUB-HEADER recipe is split 5-vs-2 — the app visibly changes as you navigate. **(BLOCKER)**

The intended batch recipe — confirmed by every one of the 5 conforming pages' own doc comments ("*the same `SkylineHeader` + `DancheongRail` hub-header recipe as Today/Progress/Uploads/ReviewVocab*") — is:

```
SkylineHeader (real <h1> in title slot)  +  <DancheongRail> divider under it
```

Five pages do this: **ReviewLibrary, ReviewVocab, ReviewDictionary, Uploads, UploadViewer** (and both batch-1 hubs, Today/Progress). **Two do not:**

- `ReviewGrammar.tsx:256` renders `<Topbar krTitle="문법" …>`
- `Mistakes.tsx:425` renders `<Topbar krTitle="틀린 문제" …>`

`Topbar` (components/Topbar.tsx) is a flat sticky bar — **no skyline strip, no Namsan silhouette, no dancheong-rail divider, no device #4 at all.** So the user path Library → Vocab (skyline hero) vs Library → Grammar (flat sticky bar) reskins the top of the app mid-navigation. Both `km-final.html` and `km-prototype.html` render *every* screen under the shared `.skyhdr` strip, so this is drift from the mockups too, not just from the siblings. The header is a **core element**, and 7 of the app's 9 designed pages use SkylineHeader — the two Topbar pages are the outliers. Ranked BLOCKER per the "jarring inconsistency in a core element vs the rest of the app" bar.

**Fix:** swap `Topbar` → `SkylineHeader(title=…)` + a `.km-*__rail-divider` `<DancheongRail>` on both pages (mechanical — copy the exact block from `Uploads.tsx:192-209` / `Uploads.css:17-32`). BackButton stays above the header (see NIT-2).

### 2. `km-rain-sheen` (device #8) omitted on 2 of 7 pages. **(SHOULD-FIX)**

Every page in **both** batches carries `km-rain-sheen` on its root `.screen` — except **ReviewLibrary** (`ReviewLibrary.tsx:113`) and **UploadViewer** (`UploadViewer.tsx:762`). Device #8 is a Night-only ambient overlay (subtle, but doc §4 lists it as required app-wide, and the library **index** is the most-seen page in the batch). Their Night screens read subtly flatter than their siblings. One-class fix on each root `<section>`.

### 3. The Sheet popup treatment is inconsistent — Mistakes hand-rolled its own. **(SHOULD-FIX)**

Three "tap → drawer up from the bottom" popups ship in this library:

- **ReviewVocab** (This-Week + Add-to-list) and **ReviewGrammar** (pattern detail) both use the **shared** `.km-review__sheet{Body,Head,Title,Meta,Rule,Actions}` classes (styles/index.css:3804-3814): eyebrow + a 22px `kr-display` title + hairline rule.
- **Mistakes** (`Mistakes.tsx:238`) rolls its **own** `.km-mistakes__sheetBody` / `__sheetHead` / `__when` (Mistakes.css:104-142) — an Eyebrow **and no `.km-review__sheetTitle`**, plus different body padding (`.km-review__sheetBody` has `padding:0 4px`; the Mistakes one has none).

Same interaction, same `Sheet` primitive, but a perceptibly different header hierarchy and padding — the exact "Sheet popup treatment consistency" axis the brief calls out. Mistakes should consume the shared `.km-review__sheet*` classes; anything genuinely Mistakes-specific (the `__when` date) rides as an *extra* class, not a full re-roll.

### Non-findings (verified consistent / faithful — do NOT "fix")

- **Flat-list vs signboard-per-row browse lists is mockup-faithful, not drift.** ReviewVocab's corpus browse + ReviewDictionary both use one flat `Card variant="flat"` `<ul>` (matching `km-prototype.html`'s Vocab screen — one `.sign.plain` holding `.wrow`s). ReviewGrammar makes each pattern its own CityCard signboard (matching `km-final.html`'s Grammar screen — separate `.sign` cards, each with a Mastery action). Both are correct against their own mockups. Leave as-is.
- **Surface language is used consistently for the right job:** fold-away sections → `CollapsibleTile surface="city"` (Progress sections, Vocab My-Lists, Mistakes Writing stubs); feature rows/sections → `CityCard` (+`rail`); dense corpus lists → flat `Card`. No page reaches for the wrong primitive.

---

## Findings

### BLOCKER
- **B1 — Header recipe split (ReviewGrammar `:256`, Mistakes `:425`).** See headline #1. Two pages use `Topbar` instead of `SkylineHeader`+`DancheongRail`; breaks the app's most-repeated element mid-navigation and diverges from both the mockups and the 5 sibling pages.

### SHOULD-FIX
- **S1 — `km-rain-sheen` missing on ReviewLibrary (`:113`) + UploadViewer (`:762`).** Headline #2.
- **S2 — Mistakes Sheet uses page-rolled classes, not the shared `.km-review__sheet*`.** Headline #3. Three library popups; one looks hand-built.

### NIT
- **N1 — Three section-heading classes for one job.** `.km-review__sectionTitle` (Vocab, shared, 17px), `.km-mistakes__section-title` (Mistakes.css:192, `font-display` 1.05rem), `.km-review-grammar__group-title` (15px). The shared `.km-review__sectionTitle` should be the default; Mistakes' "Writing review" could ride it.
- **N2 — BackButton placement drifts.** SkylineHeader pages place BackButton **above** the header; Mistakes wraps it in `.km-mistakes__nav` above `Topbar`; ReviewGrammar places it **below** `Topbar` (`.km-review-grammar__back`). Largely resolves once B1 unifies the headers — verify both land above the skyline afterward.
- **N3 — ReviewLibrary carries no hangul-watermark/giwa.** Today decorates a section eyebrow with `km-hangul-watermark`; the library index (a hub) has none. Optional (it has no empty state), low priority — noting for texture parity only.

### PRAISE
- **P1 — Zero hardcoded hex, all 7 files.** `grep` for `#hex`/`rgb(`/`hsl(` across every page CSS **and** inline TSX style returns nothing. Fully token-driven; both themes + all three accents come free. Exemplary.
- **P2 — The ReviewLibrary page-scoped override is the RIGHT pattern (the thing I was asked to judge).** `.km-library .km-library__row` (ReviewLibrary.css:53) resets the pre-redesign flat surface via a higher-specificity two-class selector — **identical technique** to `.km-today__tileCard.km-citycard` (Today.css:104) and `.km-citycard.km-collapsible` (CollapsibleTile.css). Button owns 100% of a11y/interaction; CityCard nested as a purely decorative surface. Well-documented, touches no shared file. Verdict: **consistent with batch-1, not a divergent one-off.**
- **P3 — SealStamp / najeon discipline honored.** Grammar puts a `SealStamp` milestone on mastered rows (device #7 — a named use case) and reserves `km-najeon` (device #9, the "jewel") for the **single modal** action only, not per-row — matching Progress's sparing use.
- **P4 — Uploads + UploadViewer are model-consistent** — the cleanest adoption of the full recipe in the batch; use them as the reference when fixing B1.

---

## Coordination observations (shared-component follow-ups that would unify treatments)

1. **Extract a shared hub-header block.** The `__skyline` (`margin:0 0 12px`) + `__rail-divider` (`position:relative; height:26px; margin:0 0 4px`) pair is copied **verbatim** into 7 files (Today, Progress, ReviewLibrary, ReviewVocab, ReviewDictionary, Uploads, UploadViewer). Seven identical copies is precisely the drift-surface a shared class removes — and it's *why* B1 could happen (there was no single thing to adopt). Recommend a `.km-hubheader` / `.km-hubheader__rail` utility (or a small `HubHeader` wrapper component) so a future page can't render a different header by omission. Same spirit as batch-1's `CollapsibleTile surface="city"` variant that killed two hand-rolled glows.
2. **Unify the Sheet header.** Fold Mistakes onto `.km-review__sheet*` (S2). If the shared classes need a per-page hook, add one — don't re-roll the anatomy. This is the exact pattern batch-1 used to converge Today's + Progress's fold-away surfaces.
3. **Known pre-existing debt (out of this batch's scope, flagged for the owners):** `MyVocabLists` / `WeeklySuggestions` still render loading states through the misnamed shared `.km-grammar__state`, and several pages here (Dictionary, Grammar, Uploads, UploadViewer) still borrow `.km-grammar__state` for their own loaders. ReviewVocab already migrated to `.km-vocab__state` (F-144) and documents this. A shared `.km-loading-state` would retire the misnomer everywhere.
