# FIX REPORT — Mobile Hardening, Round 2 (fix-pass on 2 SHOULD-FIX + 1 NIT)

**Repo:** `9b. Korean Master`, branch `feat/mobile-hardening`
**Source reviews:** `docs/redesign/REVIEW_mobile2-logic.md` (PASS with 2 SHOULD-FIX),
`docs/redesign/REVIEW_mobile2-capstone.md` (SHIP-SAFE, 0 blockers)

All four items closed. **T-codes were KEPT, not reverted** — the user's explicit
request for universal "T1…T6, Native" labels in every language mode stands;
nothing routes back through `<Bilingual/>`.

---

## Dispositions

### 1. SF-1 — SkillsCompare T-codes: lock the intended behavior, don't revert it
- **Disposition: closed, behavior unchanged.**
- The logic review's S1 flagged that no test exercised `mode:'ko'`/`mode:'en'`
  for the abbreviated pick pills, so a future "helpful" restore of
  `<Bilingual/>` on the visible span could silently reintroduce the old
  language-flexing behavior the user explicitly moved away from.
- **Code comment** (`client/src/components/SkillsCompare.tsx`, at the
  `<span aria-hidden="true">{shortRefLabel(r.label)}</span>` render site):
  added a one-line pointer calling out that this is a deliberate
  universal-level-code exception to the Bilingual-chrome convention, kept in
  every language-display mode, with the full localized name preserved via
  `aria-label`/`title`.
- **Test** (`client/src/components/SkillsCompare.test.tsx`, new describe block
  `"T-codes are a universal-level exception to Bilingual chrome (FIX-PASS S1
  lock)"`): renders `SkillsCompare` under a real `SettingsProvider` seeded
  (via `localStorage` + `SETTINGS_STORAGE_KEY`, the same pattern
  `Bilingual.test.tsx` uses) with `mode:'ko'`/`primary:'ko'`, and asserts:
  - the 7 pick pills' visible text is still exactly
    `['T1','T2','T3','T4','T5','T6','Native']` — not `1급…6급`/`원어민`;
  - the eyebrow above the picker (`<Bilingual en="Compare to" kr="비교 기준" />`,
    real chrome that DOES flex) shows `비교 기준`, not `Compare to` — proving
    the seed actually took effect, so the T-code assertion is a real negative,
    not a false pass from an unwired provider;
  - the accessible name (`aria-label`) stays the full `"4급 · TOPIK 4"` shape
    while the visible text stays `T4`.
- **No behavior change.** `shortRefLabel`/`fullRefName` and the JSX are
  untouched except for the added comment.

### 2. SF-2 — CSS source-pinning test for UploadViewer's iOS drag-source rules
- **Disposition: closed.**
- Added `client/src/pages/UploadViewer.test.tsx` → `'CSS: the page image
  carries the iOS drag/callout shutoff rules, and the DOM node stays
  draggable=false'`, mirroring the established `readFileSync(...).css`
  source-pin pattern from `SkillsCompare.test.tsx` (mobile-overflow fix) and
  `Today.test.tsx` (peek-slider contract) — happy-dom does no layout, so this
  is the correct test shape for CSS-only behavior.
- Reads `UploadViewer.css` from source and asserts the
  `.km-upload-viewer__img` rule contains `-webkit-touch-callout: none;`,
  `-webkit-user-drag: none;`, and `user-select: none;`; then renders the real
  component and re-confirms the DOM `<img>` carries `draggable="false"` in the
  same test, so the fix's CSS half and DOM half are pinned together.
- Added the necessary `readFileSync`/`join`/`cwd` imports to the test file
  (previously unused there).

### 3. NIT — remove non-standard `user-drag: none`
- **Disposition: closed.**
- `client/src/pages/UploadViewer.css` `.km-upload-viewer__img` rule: removed
  the inert unprefixed `user-drag: none;` line. Kept `-webkit-user-drag: none;`
  (the real, browser-implemented property).

### 4. Coordination NIT — stale "Grammar tab" comments in an untouched test file
- **Disposition: closed.**
- File: `client/src/pages/review/ReviewVocab.test.tsx` (untouched by the
  round-2 diff, flagged by the logic review's N2).
- Two comments corrected:
  - Line ~281 (`'never offers "Grammar" as a creatable list kind...'` test):
    previously said *"the page's LibrarySubnav legitimately shows a 'Grammar'
    NAVIGATION link elsewhere"* — now correctly says Grammar is reachable via
    the Library index (`ReviewLibrary`) → Grammar row, **not** via
    `LibrarySubnav`, which is vocab/dictionary-only per its own doc comment.
  - Line ~332 (`'never surfaces "Grammar"/문법 ANYWHERE...'` test): previously
    said the sweep excludes *"the LibrarySubnav's 'Grammar' navigation link"*
    — now correctly notes `LibrarySubnav` no longer has a Grammar tab at all,
    and the nav-text exclusion in the sweep is now defensive/belt-and-braces
    rather than carving out a real link.
- `LibrarySubnav.test.tsx` was checked too — its own comments already
  correctly describe the 2-tab reality (no stale references found there).
- No assertions or behavior changed — comment-only correction.

---

## Gate results (from `client/`)

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0 errors, 0 warnings** |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| Full test suite | `npx vitest run` | **115 files passed, 1793 tests passed** (clean run; a prior parallel run hit the same pre-existing flaky `ReviewDictionary.test.tsx` debounce assertion the logic review already documented — re-ran that file in isolation, 18/18 pass, and the full suite in isolation, 115/115 files — confirmed unrelated to this fix-pass, no files in that describe block were touched) |
| Build | `npx vite build --outDir /tmp/km-fix-mh2` | **exit 0** (829.62 kB main chunk, pre-existing >500kB warning, no new errors) |

---

## Files touched

- `client/src/components/SkillsCompare.tsx` — one-line locking comment only, no behavior change.
- `client/src/components/SkillsCompare.test.tsx` — new Korean-mode T-code lock (2 tests).
- `client/src/pages/UploadViewer.css` — removed non-standard `user-drag: none;`.
- `client/src/pages/UploadViewer.test.tsx` — new CSS source-pinning test.
- `client/src/pages/review/ReviewVocab.test.tsx` — 2 stale comments corrected, no assertion changes.

**Confirmation: T-codes were KEPT — SkillsCompare's abbreviated pills were NOT
reverted to routing through `<Bilingual/>`.** The fix is additive (a comment +
tests) per the review's explicit instruction.
