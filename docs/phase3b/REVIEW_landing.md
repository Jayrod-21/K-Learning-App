# Phase 3B Review — Library Landing (`ReviewLibrary.tsx`) + Cross-Page Consistency Sweep

**Reviewer:** independent senior review (did not author this code) · **Date:** 2026-07-10
**Scope:** `client/src/pages/ReviewLibrary.{tsx,css,test.tsx}` vs `rebuild`, plus a consistency-only skim of `Mistakes.tsx`, `review/ReviewVocab.tsx`, `review/ReviewDictionary.tsx`, `review/ReviewGrammar.tsx`, `Uploads.tsx`, `UploadViewer.tsx`, and `lib/nav.ts` (three-builder edit).
**Branch:** `feat/phase3b-library` · suite state at review time: lint clean, tsc 0, vitest 1342/1342.

---

## Verdict

**APPROVE WITH CONDITIONS.** 0 BLOCKERS, 5 SHOULD-FIX, 6 NIT, 6 PRAISE.

The landing page itself is clean, manifest-driven, correctly ARIA'd, and tested against real router behavior. All three ticket checks (F-042 / F-043 / F-024) pass. The conditions are (1) the two follow-up tickets this diff *claims* exist ("/images re-entry" and "dedicated past-exams surface") are **not present anywhere in the repo** and must be filed before merge, and (2) the stale "Review" copy on the five sub-pages must be brought to "Library" — it is user-visible (eyebrows, back-button labels, one `aria-label`) and now contradicts the renamed tab.

---

## Ticket checks

| Ticket | Check | Result |
|---|---|---|
| F-042 | Exactly 4 sections, order Vocabulary → Grammar → TOPIK exams → Uploads | **PASS** — `ReviewLibrary.tsx:66-84`; order + count asserted at `ReviewLibrary.test.tsx:64-76` |
| F-042 | Each section navigates to its real route | **PASS** — `/review/vocab`, `/review/grammar`, `/review/mistakes`, `/uploads`; real `MemoryRouter` navigation asserted per-section (`test.tsx:78-91`) via a `useLocation` probe, not mocked `navigate` |
| F-042 | Removed surfaces gone (LEARN chips, Dictionary row, Scan-images row, coming-soon placeholders) | **PASS** — negative guards at `test.tsx:121-143`, capped by an "exactly 4 buttons on the page" invariant (`test.tsx:142`) |
| F-043 | Page title Review → Library via the nav manifest | **PASS** — `LIBRARY_NAV = navItem('review')` (`ReviewLibrary.tsx:39`), rendered through `Topbar`+`Bilingual`; heading asserted by accessible name `자료실 · Library` (`test.tsx:46-54`); bottom-nav tab covered in `BottomNav.test.tsx` |
| F-024 | Landing is a top-level tab → NO BackButton | **PASS** — no `BackButton` import/render; the 4-buttons-total assertion (`test.tsx:142`) structurally excludes one |

---

## Quality-bar checklist

| Bar | Status |
|---|---|
| WCAG AA / correct ARIA | PASS — `aria-labelledby` → `titleId` on the `h1`; `role="list"`/`role="listitem"` restores semantics stripped by the global reset (documented, `ReviewLibrary.tsx:100-102`); icons decorative by default (`Icon.tsx:238` `aria-hidden`); row accessible names carry both scripts via `Bilingual`'s sr-only reading; `.km-library__rowdesc` uses `--paper-mute` (#626C84 light / #8A95B3 dark) — passes 4.5:1 on the paper backgrounds |
| Strict TS | PASS — `LibrarySection` fully readonly-typed; `sectionFor(id: NavItemId)` keeps the manifest boundary typed; no `any`, no assertions |
| No swallowed errors | PASS (page is pure navigation, no I/O); `navItem()` throws on unknown id rather than returning undefined |
| Tests exercise real behavior | PASS — real router, real clicks, accessible-name queries; see NIT-3/NIT-4 for two weak spots |
| Co-located CSS | PASS with documented exception — structural classes deliberately left in `styles/index.css` to avoid shared-file churn during parallel P3 builds; policy stated in `ReviewLibrary.css:4-8` and the resulting orphans are covered by existing ticket **F-097** |
| No scope creep | PASS — `WeeklySuggestions.tsx` change is F-047 (vocab page scope, another reviewer owns it); nothing else outside the landing + manifest |
| No console.log / TODO without ticket ref | PASS on console.log; **near-miss** on ticket refs — see SF-1/SF-4 |
| No dead imports / dead CSS | PASS — all imports consumed; new CSS file has one class, one consumer; pre-existing orphans ticketed (F-097, NIT-6) |

---

## Findings

### BLOCKER

None.

### SHOULD-FIX

**SF-1 — `/images` is now fully orphaned, and the ticket the code cites does not exist in the repo.**
Removing the interim "Scan images" row deleted the route's **only** in-app entry point. Verified: on this branch the only references to the `/images` path are the route registration (`client/src/App.tsx:139`), the page's own `navItem('images')` (`client/src/pages/Images.tsx:70`), and an unrelated API URL (`client/src/services/images.ts:219`). No tab, menu, subnav, FAB, or page links there — the OCR image-mining feature is reachable only by typing the URL. `ReviewLibrary.tsx:9-10` says "see the P3B ticket in the report," but `docs/phase3b/` contained no report at review time and `BUGS_AND_FEATURES.md` is untouched on this branch (the diff is 24 client files only).
**Severity: SHOULD-FIX (high).** The removal itself is an accepted P3B design decision (not re-litigated here); the defect is that an entire feature surface went dark with no in-repo record. **Merge condition:** file the ticket (re-entry point for `/images` — plausible homes: a Library row, the LEARN launcher, or Uploads) in `BUGS_AND_FEATURES.md`. If no ticket can be produced, escalate this to BLOCKER.

**SF-2 — Stale hand-written "Review library / 복습 자료실" eyebrows on the three browse sub-pages.**
`ReviewVocab.tsx:135`, `ReviewDictionary.tsx:235`, `ReviewGrammar.tsx:232` all render `eyebrow={<Bilingual en="Review library" kr="복습 자료실" />}`. The parent tab now reads **Library / 자료실** (F-043), so this is user-visible contradictory copy on every library sub-page header. It also cuts against the manifest's own guidance (`nav.ts:30-35`: consumers render manifest en/kr pairs; the landing does this correctly via `navItem('review')` — the sub-pages should source the parent name the same way instead of hand-writing it). One-line fix per file; note these files are owned by other Phase-3B builders — coordinate the fix-pass (see Coordination).

**SF-3 — BackButton labels stale and internally inconsistent.**
Four sub-pages use `label="Review"` (`Mistakes.tsx:299`, `Uploads.tsx:165`, `ReviewVocab.tsx:129`, `ReviewDictionary.tsx:229`); ReviewGrammar alone uses `label="Review library"` (`ReviewGrammar.tsx:240`). `BackButton` folds the label into the accessible name (`BackButton.tsx:83`), so screen-reader users hear "Back to Review" — a destination that no longer exists under that name anywhere in the UI. All five should read **"Library"** (ideally `navItem('review').label`). `UploadViewer.tsx:601` (`fallbackTo="/uploads"`, no label → bare "Back") is correct as-is — it is a multi-entry detail view in history-back mode, per the component's documented contract.

**SF-4 — The past-exams follow-up ticket is also missing from the repo.**
The "TOPIK exams" section deliberately lands on Mistakes (`ReviewLibrary.tsx:69-82`). The stub is **honest**: the row copy reads "Mistakes · past exams / 틀린 문제 · 기출" so the user is told what's behind the tap; the code comment explains the takeover plan; a dedicated test pins the behavior and instructs its own update (`ReviewLibrary.test.tsx:93-104`); and F-042's own ticket text ("TOPIK Exams (where mistakes and past TOPIK exams will live)", `BUGS_AND_FEATURES.md:810`) sanctions exactly this. Not a fabricated stub — no blocker. But the comment and test both call it "a reported follow-up ticket" and no such ticket exists in `BUGS_AND_FEATURES.md`. **Merge condition:** file it (dedicated past-exams surface takes over the row's `to`; Mistakes becomes a link inside it).

**SF-5 — `LibrarySubnav` aria-label still announces "Review library section".**
`LibrarySubnav.tsx:36` — this is AT-user-facing copy (the landmark name screen-reader users navigate by) on both browse pages that mount the strip. Should be "Library sections" (or similar). The component is outside this phase's diff, which is why it slipped; flagged here because the sweep's job is to find every stale "Review" that users encounter.

### NIT

**NIT-1 — `BottomNav.tsx` comments still say the tab "lights Review".** Lines 11, 144-145, 152 (`…still lights "Review" (the library owns it)`, `Review for /review-history…`). Comments only — the rendered label is correct (test updated to `Library · 자료실`). Update the prose to "Library" while noting the id stays `review`.

**NIT-2 — nav manifest header comment (`nav.ts:16-18`) still says "the Review-library sub-pages".** Historical framing, comment-only; harmless but the fix-pass may as well normalize it to "Library sub-pages" alongside NIT-1.

**NIT-3 — redundant matcher:** `ReviewLibrary.test.tsx:116,118` — `getAllByText(...)` throws when it matches nothing, so `.not.toHaveLength(0)` can never be the failing assertion. Harmless; `expect(getAllByText(...).length).toBeGreaterThan(0)` or just calling the getter says the same thing without the decoy matcher.

**NIT-4 — weak negative guard:** `test.tsx:52` `queryByText('Review')` is a full-string match, so it would *not* catch a regression that reintroduces a "Review library" eyebrow on this page. A `queryByText(/Review/)` regex (scoped to avoid false positives) would make the "retired title must not linger" claim true to its comment.

**NIT-5 — BackButton placement varies across sub-pages:** Mistakes and the three review/* pages plus Uploads render it **above** the Topbar (Mistakes additionally wraps it in `div.km-mistakes__nav`), while ReviewGrammar renders it **below** the Topbar (`ReviewGrammar.tsx:238`, custom `km-review-grammar__back` class). Same control, three visual arrangements. Worth one convention in the fix-pass or a follow-up nit ticket.

**NIT-6 — orphaned `km-library` rules in the shared sheet:** `.km-library__quick`, `__chip`, `__row--soon`, `__rowkr` (`styles/index.css:1195-1252`) now have zero `.tsx` consumers after the F-042 removals. Deliberate per the parallel-build policy documented in `ReviewLibrary.css:4-8`, and squarely covered by existing ticket **F-097** (app-wide dead-CSS sweep). No action this phase; recorded so F-097's executor knows these four blocks are sweepable.

### PRAISE (fix-pass must not undo)

**P-1 — Manifest-driven sections.** `sectionFor()` (`ReviewLibrary.tsx:52-63`) sources every row's label/kr/description/icon/path from `nav.ts`. The landing is rename-proof by construction — the exact property the sub-pages' hand-written eyebrows lack (SF-2). This is the pattern the fix should copy, not replace.

**P-2 — nav.ts edits are coherent and complete.** All three builder edits verified: F-043 (`nav.ts:98-111` — label/kr/eyebrow/headerTitle all moved together, id/path contract explicitly preserved in the comment), F-050 (`nav.ts:225-240` — same completeness, rationale recorded), F-100 (`nav.ts:285-290` — uploads comment now correctly says the area is reached from the Library row, not Settings). Bonus attention to detail: the file-header example `headerTitle` was updated from the now-stale `복습 · Review` to `오늘 · Today` (`nav.ts:28`). The compile-time bucket-exhaustiveness machinery is untouched, and `nav.test.ts:70-71` was updated to assert the *label* (the actual F-043 claim) rather than mechanically patching the old eyebrow assertion.

**P-3 — Tests exercise real behavior.** Navigation is proven end-to-end through `MemoryRouter` + `userEvent` + a `useLocation` probe (`test.tsx:17-43`) — no mocked `navigate`. Queries are accessible-name-based. The removal test closes with a whole-page interactivity invariant ("the four section rows are the ONLY buttons", `test.tsx:142`), which structurally guarantees both F-042's removals and F-024's no-BackButton in one assertion.

**P-4 — The exams stub is handled honestly in every layer that ships:** UI copy discloses "Mistakes · past exams", the code comment documents the takeover plan (`ReviewLibrary.tsx:69-74`), and a dedicated test pins it with self-updating instructions (`test.tsx:93-104`). Only the ticket artifact is missing (SF-4).

**P-5 — A11y detailing:** `titleId` on the `h1` with `aria-labelledby` on the section; the `role="list"` rationale comment (`ReviewLibrary.tsx:100-102`); `compact` on the description `Bilingual` so tight chrome shows one language while the accessible name keeps both — consistent with `LibrarySubnav`'s established pattern.

**P-6 — Co-location policy stated, not silent:** `ReviewLibrary.css:1-9` explains exactly why only new styles land in the co-located file and where the rest live — the kind of comment that saves the F-097 executor an hour.

---

## Cross-page consistency

**(1) Nav manifest coherence after three builders — COHERENT.** No conflicting edits, no stale sibling fields, exhaustiveness checks intact, `nav.test.ts` has zero remaining "Review"/"복습" expectations. See P-2. The only manifest-adjacent residue is comment prose (NIT-2).

**(2) Eyebrow/title copy — the complete stale-"Review" inventory (user-facing items bolded):**

| Location | Copy | Class |
|---|---|---|
| **`ReviewVocab.tsx:135`** | eyebrow "Review library / 복습 자료실" | SF-2 |
| **`ReviewDictionary.tsx:235`** | eyebrow "Review library / 복습 자료실" | SF-2 |
| **`ReviewGrammar.tsx:232`** | eyebrow "Review library / 복습 자료실" | SF-2 |
| **`Mistakes.tsx:299`, `Uploads.tsx:165`, `ReviewVocab.tsx:129`, `ReviewDictionary.tsx:229`** | BackButton `label="Review"` | SF-3 |
| **`ReviewGrammar.tsx:240`** | BackButton `label="Review library"` | SF-3 |
| **`LibrarySubnav.tsx:36`** | `aria-label="Review library section"` | SF-5 |
| `BottomNav.tsx:11,144-145,152` | comments "lights Review" | NIT-1 |
| `nav.ts:16-18` | comment "Review-library sub-pages" | NIT-2 |
| Comment-only mentions in `ReferenceRedirect.tsx:3`, `Grammar.tsx:6`, `redirects.test.tsx:6`, `MyVocabLists.tsx:9`, `grammarBank.ts:6`, `Review.tsx` (several), `styles/index.css:1192`, test names in `ReviewGrammar.test.tsx` / `ReviewVocab.test.tsx:193-200` / `Uploads.test.tsx:145` / `Mistakes.test.tsx:259` | historical "Review library" prose | acceptable as history; the *test expectations* at `ReviewVocab.test.tsx:199-200` and `ReviewGrammar.test.tsx:490` pin the stale strings and must move with SF-2/SF-3 |

Mistakes and Uploads correctly consume their own manifest eyebrows (`MISTAKES_NAV.eyebrow`, `UPLOADS_NAV.eyebrow`) — only the three review/* pages hand-write the parent name.

**(3) BackButton presence — CORRECT everywhere.** All six nested surfaces have one: Mistakes, ReviewVocab, ReviewDictionary, ReviewGrammar, Uploads (all `to="/review"`, deterministic-parent mode) and UploadViewer (history-back with `fallbackTo="/uploads"` — the right mode for a multi-entry detail view). The landing has none (F-024). Residual inconsistencies are the labels (SF-3) and placement (NIT-5).

**(4) FilterSelect + usePagination — CONSISTENT.** All four consumers honor the same contract: `''` is `FilterSelect`'s reserved placeholder/"all" sentinel (`ReviewVocab.tsx:84,107`, `ReviewDictionary.tsx:59`, `ReviewGrammar.tsx:86-94`, `Mistakes.tsx:95,283`), each with an explicit narrow-guard where the DOM string crosses into a typed domain. `usePagination` consumers (`ReviewVocab.tsx:234`, `Progress.tsx:1244`) both pair it with `ShowMore` windowing; Progress's referentially-stable empty-list trick (`Progress.tsx:1215`) has no analogue needed in ReviewVocab. No divergent conventions found.

---

## Coordination observations

- **Landing copy is live-coupled to the manifest.** The section descriptions ARE the targets' `eyebrow` pairs (`sectionFor`, `ReviewLibrary.tsx:58-59`), and `ReviewLibrary.test.tsx:116-117` pins the current strings. Any fix-pass edit to a manifest eyebrow (e.g., vocab or uploads) will correctly propagate to the landing **and** trip this suite — expected, update the pinned strings together.
- **SF-2/SF-3 touch files owned by the vocab, dictionary, grammar, mistakes, and uploads builders.** The fixes are one-liners plus their pinned test expectations (`ReviewVocab.test.tsx:193-200`, `ReviewGrammar.test.tsx:484-490`, `Uploads.test.tsx:145`) — a single fix-pass agent should take all of them in one commit to avoid five-way churn.
- The hand-rolled `exams` section (`ReviewLibrary.tsx:69-82`) is the only non-manifest copy on the landing — when the past-exams surface ships (SF-4 ticket), both its `to` and its description strings change, plus the two tests that pin `/review/mistakes`.
- `docs/phase3b/` was empty at review time; builder "reports" referenced from code comments live only in agent final messages. Recommend the fix-pass land the two tickets (SF-1, SF-4) in `BUGS_AND_FEATURES.md` so in-tree references stop pointing at nothing.
