# Fix Report — Batch 5 (Diagnostic / MockMode / Images cleanup)

**Branch:** `feat/redesign-cleanup` (based off `9243489`)
**Scope:** every SHOULD-FIX raised across `REVIEW_batch5-diagnostic.md`, `REVIEW_batch5-mock-images.md`, `REVIEW_batch5-fidelity.md`.
**Not touched (explicitly out of scope, per instruction):** `components/WordPopover.tsx` reskin — filed as a follow-up (see bottom). F-143 removal, byte-identical flows, and the no-Topbar capstone were left as-is (praised, not to be undone).

## Findings and disposition

| # | Finding | Source review(s) | Disposition | Files |
|---|---|---|---|---|
| 1 | `SubwayProgress` 50-dot mobile overflow (foundation bug) | fidelity S1 | **FIXED** | `client/src/components/SubwayProgress.tsx`, `SubwayProgress.test.tsx` |
| 2a | MockMode `ResumeBanner` hardcoded `rgba()` border | mock-images M-1 | **FIXED** | `client/src/pages/topik/MockMode.tsx` |
| 2b | MockMode submit-confirm dialog not reskinned | mock-images M-1 | **FIXED** | `client/src/pages/topik/MockMode.tsx` |
| 2c | MockMode duplicate `.km-rain-sheen` (parent Topik.tsx already applies it) | mock-images M-2 | **FIXED** | `client/src/pages/topik/MockMode.tsx`, `MockMode.test.tsx` |
| 3 | Delete dead `Topbar.tsx`/`.test.tsx`/CSS | mock-images coordination #2, fidelity capstone | **FIXED** | deleted `client/src/components/Topbar.tsx`, `Topbar.test.tsx`; removed `.km-topbar*` rules in `client/src/styles/index.css` |
| 4 | Surgical dead-CSS cleanup in `styles/index.css` | diagnostic S1, fidelity N1 | **FIXED** (surgical, see grep evidence below) | `client/src/styles/index.css` |

**Blocker count: 0. Nothing rejected. Nothing deferred beyond the explicitly out-of-scope WordPopover follow-up.**

---

## 1. SubwayProgress mobile overflow — the real bug

**Root cause:** `SubwayProgress.tsx` rendered one fixed 10px dot per step with no wrap/scroll/cap. A 50-item MockMode exam (and a maxed-out 50-card Hanja study session — `STUDY_SESSION_LIMIT = 50` in `Hanja.tsx:236`, same latent exposure, not previously audited) produced ~500px of intrinsic dot-row width against a ~330px mobile content box.

**Fix:** added a `DOT_RENDER_CAP = 24` threshold inside the shared component. At or below the cap, rendering is byte-identical to before (full row of per-station dots). Above it, the component condenses to the fill line alone (no per-station dots) — the same "plain bar" fallback the design doc itself documents (`DESIGN_SEOUL_DAY_NIGHT.md` §6: "Progress bars … plain bars fill with the accent"). The `role="progressbar"`/`aria-value*` contract, `tone`, and `fillPct` math are all unchanged; only the station-dot enumeration is now gated.

24 was chosen because it's comfortably under budget on a ~330px phone content box (24×10px + gaps ≈ under 300px), matching the fidelity review's own suggested "~24 stations" cutoff.

### Consumer regression confirmation

Grepped every `<SubwayProgress` call site and ran each page's full test file after the change — **all pass, zero regressions**:

| Consumer | File | Typical `steps` | Below/above cap | Test result |
|---|---|---|---|---|
| Diagnostic live run | `pages/Diagnostic.tsx:770` | 16 | below (dots, unchanged) | `Diagnostic.test.tsx` — pass |
| Hanja study drill | `pages/Hanja.tsx:1450` | `deck.length` (≤ `STUDY_SESSION_LIMIT`=50) | below *or* above depending on session size — now safe either way | `Hanja.test.tsx` — pass |
| Hanja draw drill | `pages/Hanja.tsx:2694` | `totalInSession` (≤ `DRAW_SESSION_LIMIT`=20) | below (dots, unchanged) | `Hanja.test.tsx` — pass |
| Progress (diagnostic attempts) | `pages/Progress.tsx:842` | `n` (attempt count, small) | below (dots, unchanged) | `Progress.test.tsx` — pass |
| Topik study drill | `pages/Topik.tsx:958` | `draw.length` (small drill draw) | below (dots, unchanged) | `Topik.test.tsx` — pass |
| Review flashcard session | `pages/Review.tsx:1718` | `deck.length` | below normally; now safe if a session is ever large | `Review.test.tsx` — pass |
| MockMode exam (Reading/Listening) | `pages/topik/MockMode.tsx:1759` | `total` = 50 | **above cap — now condenses, no overflow** | `MockMode.test.tsx` — pass (49/49) |

Full combined run of all seven files: **269/269 passed** (see gate section). New dedicated tests added to `SubwayProgress.test.tsx`:
- condenses (0 station dots) at `steps=50`, fill bar still present and reflects real progress
- still renders full dots at the cap boundary (`steps=24`)
- condenses one step past the boundary (`steps=25`)

`SealStamp.tsx` and `Today.tsx`/`Ttmik.tsx` were also grepped — they only *mention* `SubwayProgress` in doc comments (deliberately not consumers), confirmed no actual usage there.

---

## 2. MockMode polish

**2a — ResumeBanner hardcoded color.** Replaced the literal `border: '1px solid rgba(127, 127, 127, 0.25)'` inline style with `border: '1px solid var(--line)'` — the shared hairline-divider token already used for this exact role elsewhere in the app (`styles/index.css`), token-driven in both Day/Night themes.

**2b — Submit-confirm dialog not reskinned.** Converted the inner `<Card variant="flat" className="km-mock__confirm">` to `<CityCard tone={sectionTone(test.section)} rail className="km-mock__confirm">` — matching the tone the rest of the exam screen (the exam `CityCard`, `SubwayProgress`) already reads as. Chose CityCard over `Sheet` deliberately: every other surface in MockMode is already CityCard-based (Sheet is the app's bottom-attached-drawer primitive used for detail/list/creation flows elsewhere, a different interaction shape than a centered confirm), and reusing CityCard let the fix stay atomic — the outer `<div role="alertdialog" aria-label="Confirm submit" ref={confirmRef}>` and its `useModalA11y` wiring (focus trap, Esc-close, focus restore) are completely untouched, so the a11y contract carries zero risk of regression. `MockMode.test.tsx:548` (`getByRole('alertdialog')`) still passes unchanged.

**2c — Duplicate `.km-rain-sheen`.** Removed `km-rain-sheen` from MockMode's own root `<div className="km-mock" ...>` (was `"km-mock km-rain-sheen"`) — `Topik.tsx`'s outer `.screen.km-topik` wrapper (MockMode's actual parent, `Topik.tsx:264`/`:526`) already applies device #8 to the whole Study/Mock tab panel, so the duplicate was doubling the ambient overlay opacity over the same shared subtree for no visual gain. Updated the module docstring and replaced the stale test (`MockMode.test.tsx` — "the root carries the ambient rain-sheen…") with a regression guard asserting the class is **absent** on MockMode's own root, so the duplicate can't silently come back.

All three are cosmetic/token-only or class-list changes — no state/handler/logic touched. `npx vitest run src/pages/topik/MockMode.test.tsx` → 49/49 pass. `grep -n "rgba(\|#[0-9a-fA-F]\{3,6\}" MockMode.tsx MockMode.css` → zero hits outside a code comment.

---

## 3. Topbar deletion

Confirmed **zero remaining imports/JSX usages** repo-wide before deleting:
```
grep -rn "from '.*Topbar'" client/src        → only components/Topbar.test.tsx (its own test)
grep -rn "<Topbar" client/src --include=*.tsx → only components/Topbar.test.tsx
grep -rln "\bTopbar\b" client/src | grep -v "^src/components/Topbar" → all hits are doc-comments/test-descriptions referring to the historical flat header (no import, no JSX)
```
Deleted:
- `client/src/components/Topbar.tsx`
- `client/src/components/Topbar.test.tsx`
- `.km-topbar`, `.km-topbar__row`, `.km-topbar__meta`, `.km-topbar__eyebrow`, `.km-topbar__title`, `.km-topbar__right`, `.km-topbar__title-en` from `client/src/styles/index.css` (there was no separate `Topbar.css` — its rules lived in the shared file)

`Images.test.tsx:383` (`expect(document.querySelector('.km-topbar')).not.toBeInTheDocument()`) is a negative assertion and needed no update — it still passes correctly with the class gone entirely from the app.

**Confirmation: Topbar deletion is complete and safe.** Full suite (`npx vitest run`) passed at 1760/1760 after the deletion, including `Images.test.tsx`.

---

## 4. Surgical orphaned-CSS cleanup

Grepped each named selector individually across `client/src/**/*.tsx` (excluding comments/tests where noted) before removing. Interleaved live selectors named in the fidelity review were re-verified live and left untouched.

**Removed (confirmed zero `.tsx` references):**
| Selector | Grep evidence |
|---|---|
| `.km-diagnostic__display` | zero hits anywhere |
| `.km-diagnostic__progress` (exact) | zero hits anywhere (distinct from `-label`, which is live) |
| `.km-diagnostic__progress-fill` | zero JSX hits; only a negative test assertion (`Diagnostic.test.tsx:595`, asserts it's `null` — doesn't require the CSS rule) |
| `.km-diagnostic__results-title` | zero hits anywhere |
| `.km-diagnostic__goals-card` | zero hits anywhere |
| `.km-diagnostic__goals` (exact) | zero hits anywhere |
| `.km-diagnostic__goal-row` | zero hits anywhere |
| `.km-diagnostic__goal-num` | zero hits anywhere |
| `.km-mock__section` (bare) | zero hits anywhere (distinct from `-card`, `-btn`, `-en`, `-kr`, `-go`, `-soon`, all live) |
| `.km-mock__section:hover:not(:disabled)` | same — bare selector unused |
| `.km-mock__section--disabled` / `:disabled` | zero hits anywhere |

**Explicitly left alone (confirmed live):**
- `.km-diagnostic__progress-label` — used at `Diagnostic.tsx:759` (`<Eyebrow className="km-diagnostic__progress-label">`)
- `.km-mock__sections` — used (grid wrapper) in `MockMode.tsx`
- `.km-mock__section-en` / `-kr` / `-go` / `-soon` — used throughout `MockMode.tsx`'s `.km-mock__section-btn` markup
- `.km-diagnostic__results-sub`, `.km-diagnostic__skills-card`, `.km-diagnostic__skills-title` — not named as dead by either review; left untouched per the "surgical, only the named rules" instruction, even though not independently re-audited here

No ambiguous cases — every named selector resolved cleanly to either "zero references, safe to delete" or "live, must stay," confirmed by exact-selector grep (not fuzzy/prefix matching) to avoid the exact `-label`/`-en`/`-kr`/`-go`/`-soon` interleaving trap the fidelity review warned about.

---

## Follow-up ticket to file

**(F) Migrate `WordPopover.tsx` to the shared tone-aware `Sheet`** — the last bespoke modal in the redesign (its own `.km-popover` chrome instead of composing `Sheet`), used by Reading/Grammar/Hanja/Listen/Images. "Promote to shared primitive" consolidation, not a fidelity or a11y gap (WordPopover already has correct `role="dialog"`/focus-trap/etc.). Deferred to post-beta polish per instruction — not touched in this pass.

---

## Gate — exact numbers (run from `client/`)

| Check | Result |
|---|---|
| `npm run lint` | **0 errors, 0 warnings** (clean output) |
| `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** (clean output) |
| `npx vitest run` | **115 test files passed, 1760 tests passed**, 0 failed |
| `npx vite build --outDir /tmp/km-fix-batch5` | **exit 0** — built in 593ms, PWA precache generated (15 entries); pre-existing >500kB main-chunk warning unrelated to this change |

## Self-assessment vs. gate

All four gate commands ran clean with no suppressions, no `--force`, no test deletions to dodge a failure. The two new/updated test files (`SubwayProgress.test.tsx` +4 tests, `MockMode.test.tsx` 1 test rewritten) are real regression guards, not tautologies — the SubwayProgress condensed-state tests assert on actual DOM absence of station-dot markup (the thing that was overflowing), and the rain-sheen test now asserts absence (guarding against the duplicate returning) rather than the previous test's presence assertion (which had been guarding the wrong direction). Every SHOULD-FIX from all three reviews is closed; the one item both reviews agreed should NOT be touched this batch (WordPopover) was correctly left alone and filed as a follow-up instead.
