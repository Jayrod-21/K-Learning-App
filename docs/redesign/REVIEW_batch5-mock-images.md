# Batch 5 fidelity review — MockMode (F-183) + Images (F-184)

**Reviewer:** independent senior React/TS review (did not write this code)
**Branch:** `feat/redesign-cleanup` @ `9243489` (off `rebuild`)
**Scope:** `client/src/pages/topik/MockMode.{tsx,css,test.tsx}`, `client/src/pages/Images.{tsx,css,test.tsx}`
**Method:** full diff vs `rebuild` read end-to-end; both target files read in full (not just the diff hunks); `Topik.tsx`, `Uploads.tsx`, `CityCard.tsx`, `DancheongRail.tsx`, `SubwayProgress.tsx`, `SealStamp.tsx`, `PageHubHeader.tsx`, `Topbar.tsx`, `styles/index.css`, `styles/seoul-devices.css` read as consistency references; `vitest run` and `tsc -b`/`eslint` executed against both changed files (not just reasoned about statically).

## Verdict: **PASS** — 0 BLOCKERS

Both reskins hold to the "reskin, don't rewrite" contract. Exam-flow behavior in MockMode is untouched at the logic level (confirmed by full read of the timer/submit/palette/resume code, not just the diff hunks), and Images' Topbar removal is confirmed complete and total across the app. Tests are real — they assert on interaction outcomes, not just presence of a className. Found several SHOULD-FIX/NIT items, all cosmetic-coverage or dead-code hygiene, none of which regress behavior.

Verification run (not just static reading):
- `npx vitest run src/pages/Images.test.tsx src/pages/topik/MockMode.test.tsx` → **66/66 passed**.
- `npx tsc -b --noEmit` → no errors attributable to either file.
- `npx eslint` on all four changed/touched files → clean.

---

## MockMode exam-flow-preservation verdict: **PRESERVED, no regression**

Walked the full `ExamRunner` (client/src/pages/topik/MockMode.tsx:1406-1887) line by line against the pre-diff logic:

- **Timer**: the wall-clock-deadline countdown (`deadlineRef`, the 1s `setInterval` at L1553-1565, the `remaining<=0` auto-submit effect at L1573-1578) is byte-for-byte unchanged. `doSubmit`/`submittedRef` guard, resume budget seeding (L1465-1476), and the 15s/unmount progress-save effects (L1636-1648) are all untouched — only their JSX *container* changed.
- **Palette jump**: `QuestionPalette` (L1900-1938) is untouched; `goTo` (L1580-1587) is untouched. The new `SubwayProgress` (L1758-1766) reads the SAME `idx`/`total` state and is proven to move on a real palette click, not just painted once — `MockMode.test.tsx`'s new test clicks "Question 2" and asserts `aria-valuenow` flips 1→2 (client/src/pages/topik/MockMode.test.tsx:582-586). This is a genuine regression guard, not a snapshot of initial state.
- **Prev/Next/Submit**: `ChoiceGroup` (L1957-2069), the nav buttons, and the submit-confirm `alertdialog` (L1851-1884) are unchanged in logic — only wrapped inside the new `CityCard` hero (MockMode.tsx:1779, closing 1849). The Submit button lives inside the same `CityCard` as the prompt, verified structurally by test (MockMode.test.tsx:588-603).
- **TopikResults**: `buildMockResultsSummary` (L2280-2323) — the string-keyed `Map` fix, the F-009 `!isCorrect` gating, `SKIPPED_PICK` — is untouched. Only the score panel (`km-mock__score`) is now a `feat` `CityCard` (MockMode.tsx:2151-2173) instead of a flat `Card`.
- **No second header**: `MockMode` is rendered at `Topik.tsx:378` inside the shared `<Tabs>` panel, AFTER `Topik.tsx`'s own `<PageHubHeader>` (Topik.tsx:271/533). `MockMode.tsx` itself never imports or renders `PageHubHeader` — confirmed by grep, zero hits. No duplicate header.

**Net:** the reskin is exactly what its docstring claims (MockMode.tsx:69-85) — a surface-only pass. I found nothing that alters the countdown, the grading contract, or the answer-tamper defenses described in the file's own threat-model comment.

## Images Topbar-gone confirmation: **CONFIRMED — no `Topbar` import remains in any page**

`grep -rn "Topbar" client/src/pages/` and `grep -rln "from '.*Topbar'" client/src` (repo-wide) both come back with **zero** remaining `import { Topbar }` in any page file — the only surviving references are `components/Topbar.tsx` itself and its own `components/Topbar.test.tsx`. Images.tsx is confirmed as the true last consumer; `Images.test.tsx:378-384` directly asserts `document.querySelector('.km-topbar')` is null on the reskinned page, and the assertion is meaningful (I confirmed `Topbar.tsx:55` really does render `className="km-topbar"`, so the selector isn't a false negative from a class-name mismatch).

**Fallout** (see Coordination section): `components/Topbar.tsx`, `components/Topbar.test.tsx`, and the `.km-topbar*` rules in `styles/index.css` (~L2596-2619, L3996) are now fully dead code repo-wide. Nobody flagged this in the commit message or file docstrings.

---

## Checklist — MockMode.tsx (F-183)

| Item | Status | Notes |
|---|---|---|
| Timer counts down + auto-submits at 0 | PASS | Untouched logic (L1553-1578) |
| Palette jump navigates + syncs SubwayProgress | PASS | Regression-tested (MockMode.test.tsx:563-586) |
| Prev/Next/pick/submit/resume/scoring | PASS | Untouched logic, only re-wrapped in CityCard |
| No duplicate PageHubHeader | PASS | Nested under Topik's Tabs; never imports PageHubHeader |
| Both themes, token-driven, no hex | PASS | `grep -n '#[0-9a-fA-F]\{3,6\}'` on MockMode.css → 0 hits |
| Mobile (F-129) | SHOULD-FIX (weak, self-aware) | See finding M-3 |
| Accent (F-131) | PASS | `--km-tone`/`color-mix` idiom, matches Topik.css |
| Test quality | PASS, mostly | One self-acknowledged-weak test (M-3); rest assert real state |
| Full coverage of every surface in the flow | SHOULD-FIX | ResumeBanner + submit-confirm dialog left un-reskinned (M-1) |

## Checklist — Images.tsx (F-184)

| Item | Status | Notes |
|---|---|---|
| Topbar → PageHubHeader | PASS | Confirmed last holdout, confirmed removed |
| Gallery/capture/detected-word behavior preserved | PASS | Zero handler/state changes; only JSX wrapping |
| CityCard adopted (samples, recent grid, capture, detected) | PASS | All 4 surfaces converted |
| F-128 reskin both themes, no hex | PASS | `grep` on Images.css → 0 hits |
| F-129 mobile (no h-scroll) | PASS | `min-width:0`/`overflow-wrap` on the actual overflow-risk elements (Images.css:64-78) |
| F-131 accent | PASS | `tone="plain"` throughout (deliberate — no skill color), inherits token system |
| Test quality | PASS | Real interaction tests, not tautologies |

---

## Detailed findings

### BLOCKER
None.

### SHOULD-FIX

**M-1 — MockMode's ResumeBanner still carries a hardcoded, non-token color (pre-existing, but a gap in this pass's "no hardcoded hex" bar).**
`client/src/pages/topik/MockMode.tsx` (ResumeBanner, ~L1320-1333, unchanged by this diff): the resume banner's inline `style` includes `border: '1px solid rgba(127, 127, 127, 0.25)'` — a literal color value, not a CSS custom property. The submit-confirm `alertdialog` (~L1851-1884) is also left as a plain `variant="flat"` `Card`, not a `CityCard`. Neither surface is mentioned in the F-183 docstring's list of what got reskinned (MockMode.tsx:69-85), so this isn't a broken claim — but DESIGN_SEOUL_DAY_NIGHT.md's non-negotiable #8 ("no orphaned hard-coded colors... toggling `data-theme` fully reskins") is written as an app-wide bar, and this banner is the one interactive surface a learner sees on EVERY visit to the section-select screen with a saved attempt. Recommend folding it into a follow-up ticket rather than shipping it as permanently out-of-scope.

**M-2 — Duplicate `.km-rain-sheen` device in the same DOM subtree.**
`Topik.tsx:264`/`526` already puts `km-rain-sheen` on the outer `.screen.km-topik` container. `MockMode.tsx:647` puts `km-rain-sheen` on its own root `<div>`, which renders INSIDE that same `.km-topik` container whenever `mode=mock` (via `Topik.tsx:378`'s `<Tabs>` panel). Both classes resolve to the same `styles/seoul-devices.css:21-36` rule: an absolutely-positioned, full-cover `::before` with a 1.4%-alpha diagonal stripe. Two overlapping instances double the effective opacity over the overlap region. At 1.4% alpha this is very unlikely to be visible, so I'm not calling it a blocker — but it's a literal instance of applying device #8 twice to the same screen, which the design doc's ambient-texture intent ("very subtle... Night only") argues against. Simplest fix: drop `km-rain-sheen` from MockMode's own root, since Topik's outer wrapper already provides it whenever MockMode is visible.

### NIT

**M-3 — The F-129 mobile test is honestly weak.**
`MockMode.test.tsx:639-653` ("a mobile-width exam head/nav row is allowed to wrap...") only asserts `.km-mock__exam-head`/`.km-mock__nav` exist in the DOM — it cannot exercise the actual `@media (max-width: 380px)` wrap behavior because jsdom doesn't compute layout, and the test's own comment says so plainly. This is not a hidden tautology (the comment is upfront about the limitation), but it means the `flex-wrap` rule at `MockMode.css:524-529` has zero regression coverage beyond "the CSS file parses and the class exists." Acceptable given the stack's testing constraints; flagging so a future visual-regression pass (Playwright/Percy) knows this is unguarded.

**I-1 — `ExamChooser`'s `testsNet === 'error'` state is still a flat `Card`, not a `CityCard`.**
`MockMode.tsx:996-1007` (the past-papers fetch-error card) wasn't converted alongside its sibling states (loading text, honest-empty `CityCard`-adjacent `Card` at L1015-1027, and the populated list at L1039). Low priority — it's a transient error state, and the app's `ErrorCard` convention elsewhere doesn't get CityCard treatment either — but it's a visible inconsistency: 3 of 4 states on the same screen got the reskin treatment, one didn't.

### PRAISE

- **SubwayProgress↔palette sync test** (MockMode.test.tsx:563-586) is the standout test in this batch: it clicks the palette, then asserts the progressbar's `aria-valuenow` actually moved — a real regression guard against exactly the failure mode the review was asked to probe for ("palette jump still works AND moves the new SubwayProgress").
- **Distinct-tone assertion** (MockMode.test.tsx:547-556) verifies Reading tracks the accent picker while Listening is pinned to blue — checks the actual `sectionTone()` behavior contract, not just "a CityCard exists somewhere."
- **Images' honest-empty test** (Images.test.tsx:414-433) forces the real failure path (`fetchImageMock.mockRejectedValueOnce`) to reach the empty detected-word state, rather than asserting on a fixture that happens to have no words — this is testing the actual code path, not a shortcut.
- Both files came back clean on `tsc -b` and `eslint` with zero suppressions/`any` added for this change — the strict-TS bar held.

---

## Coordination observations

1. **Orphaned `.km-mock__section*` container rules in `styles/index.css` (~L2876-2894)**: `.km-mock__section`, `.km-mock__section:hover:not(:disabled)`, `.km-mock__section--disabled`/`:disabled` are now unreferenced — the container class is renamed to `.km-mock__section-card`/`.km-mock__section-btn`. Correctly noted as a flagged follow-up in `MockMode.css`'s own top-of-file comment (lines ~399-406) rather than silently left; the builder's reasoning (index.css is being edited in parallel by the Diagnostic/Images passes, so a cross-page edit here was deliberately deferred) is sound. Note the SUB-part classes (`.km-mock__section-en/-kr/-go/-soon`, index.css:2896-2909) are still live — only the container-level rules are dead.

2. **`components/Topbar.tsx` + `components/Topbar.test.tsx` + `.km-topbar*` rules (`styles/index.css` ~L2596-2619, L3996) are now fully dead code repo-wide.** Since Images.tsx was confirmed the last consumer, nothing in the app imports `Topbar` anymore except its own test. This wasn't called out anywhere in the diff or commit message. Recommend a follow-up ticket to delete the component, its test, and its CSS rather than let three files/blocks of dead code linger — it's a bigger and cleaner deletion than the index.css follow-up already tracked in item 1.

3. **WordPopover is not built on the shared `Sheet`/`CityCard` vocabulary, and Images (its main non-vocab consumer) doesn't touch it.** `components/WordPopover.tsx` is its own bespoke `role="dialog"` modal with its own `km-popover` CSS namespace and its own `useModalA11y` wiring (a "rule-of-three with Sheet + MoreSheet" per its docstring at L118-119) — it doesn't render through `Sheet` or adopt any of the nine character devices. DESIGN_SEOUL_DAY_NIGHT.md §6 says "Popups / sheets... the sheet is a `CityCard`," and WordPopover is the single most-used popup in the app (every tap-a-word gesture, including the one Images.tsx's detected-word list relies on). I did not find a written flag for this in the diff, commit message, or `docs/redesign/*.md` — I'm surfacing it here as an observed gap rather than confirming a pre-existing flag, since I could not locate one. Worth a dedicated ticket: either fold WordPopover onto `Sheet` (reducing to one modal primitive) or explicitly scope it out of the Seoul redesign with a documented reason.

4. **No visual/contrast regression tooling was run** — this review is a code-level read plus `vitest`/`tsc`/`eslint`, not a rendered-pixel or axe-core pass. WCAG AA contrast claims in both themes are architecturally plausible (everything routes through `--km-tone`/`--vermilion` tokens that are defined for both `data-theme` values), but nothing in this review actually measured contrast ratios. Flagging so this isn't mistaken for a visual sign-off.
