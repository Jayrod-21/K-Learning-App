# RE-REVIEW — Mobile Hardening, Round 2 (independent verification of fix-pass)

**Reviewer:** independent senior React/TS reviewer (30yr). Fresh — did not write the
round-2 fixes, either round-2 review (`REVIEW_mobile2-logic.md`,
`REVIEW_mobile2-capstone.md`), or the fix-pass (`FIX_REPORT_mobile2.md`).

**Repo:** `9b. Korean Master`, branch `feat/mobile-hardening`
**Scope:** `bd4783b..HEAD` = `c6a4436` (4 fixes) + `0361716` (fix-pass on 2
SHOULD-FIX + 1 NIT + 1 coordination NIT)
**Method:** read every changed file in full against `bd4783b`, re-traced the claims
in all three source docs against the actual code (not the docs' own summaries), and
independently re-ran all four gates from `client/` rather than trusting the reports.

## VERDICT: **PASS** — 0 blockers, ready to deploy to green

---

## Per-fix verification

### 1. Grammar tab removed from vocab/dictionary subnav — CONFIRMED
- `LibrarySubnav.tsx:34-37` — `SECTION_IDS` is exactly `['review-vocab',
  'review-dictionary']`; no `'review-grammar'`. Doc comment (`:13-20`) correctly
  explains why nothing is orphaned.
- Grammar reachable via Library index: `ReviewGrammar.tsx` never imports
  `LibrarySubnav` and carries its own `<BackButton to="/review">`, so it is not
  stranded.
- The no-Grammar-tab test is real: `LibrarySubnav.test.tsx:65-82` renders both
  `/review/vocab` and `/review/dictionary` and asserts both the absent
  `button[name=/grammar/i]` role and the absent Korean string `'문법'` — a genuine
  negative assertion exercising both consumer routes, not a tautology.
- Fix-pass coordination NIT (stale comments in an untouched file) also verified
  closed: `ReviewVocab.test.tsx:281,283,333-336` now correctly describe Grammar as
  reachable only via the Library index, not via `LibrarySubnav`.

### 2. PDF img-drag fix (`UploadViewer`) — CONFIRMED
- `UploadViewer.tsx:365-371`: `draggable={false}` + `onDragStart={(e) =>
  e.preventDefault()}` on the page `<img>`, with an in-code comment explaining the
  native-drag-source/iOS-callout root cause.
- `UploadViewer.css:93-98`: `.km-upload-viewer__img` carries
  `-webkit-touch-callout: none`, `-webkit-user-drag: none`,
  `-webkit-user-select: none`, `user-select: none`. The inert unprefixed
  `user-drag: none` line the logic review's NIT-1 flagged is **gone** — confirmed
  by direct read, only the real `-webkit-user-drag: none` remains.
- CSS source-pin test now exists: `UploadViewer.test.tsx:988-1007` reads
  `UploadViewer.css` via `readFileSync` and asserts the `.km-upload-viewer__img`
  rule contains `-webkit-touch-callout: none;` and `-webkit-user-drag: none;`, then
  re-confirms `draggable="false"` on the rendered DOM node in the same test — CSS
  half and DOM half pinned together, closing the logic review's S2.
- Zoom/paging/scroll untouched: `pageLayout()`, `touchAction` toggle (`:577`,
  `:1044`), `goPrev`/`goNext`, and `.km-upload-viewer__page{overflow:auto}` are all
  outside this diff's touched lines — confirmed by reading the surrounding
  functions, none of which reference `draggable`/`onDragStart`/the new CSS rule.

### 3. TOPIK T1…T6/Native labels — CONFIRMED, fix-pass lock verified real
- Visible short codes: `SkillsCompare.tsx:200`, `<span
  aria-hidden="true">{shortRefLabel(r.label)}</span>`.
- Accessible name unchanged: `aria-label={fullName}` / `title={fullName}`
  (`:179-180`), `fullRefName` reproduces the pre-existing "kr · en" shape
  (`:100-102`).
- **T-codes kept in ALL modes, not reverted to Bilingual** — confirmed by reading
  the render site directly: no `<Bilingual>` wraps the visible span; only the
  `aria-hidden` short-code span and the `aria-label`/`title` full name. The
  fix-pass's added lock comment (`:194-199`) matches the actual code.
- New Korean-mode test is real, not a false pass: `SkillsCompare.test.tsx:420-471`
  seeds a real `SettingsProvider` via `localStorage`/`SETTINGS_STORAGE_KEY` with
  `mode:'ko'`, renders the component under that provider, and asserts (a) the 7
  pick pills' visible text is exactly `['T1','T2','T3','T4','T5','T6','Native']`,
  not `1급…6급`/`원어민`, and (b) the eyebrow above the picker (real `Bilingual`
  chrome) DOES show `비교 기준`/does NOT show `Compare to` — proving the seed
  actually took effect, so the T-code assertion isn't a false pass from an unwired
  provider. This is exactly the kind of test the logic review's S1 said was
  missing, and it now exists and is load-bearing (verified it would fail if the
  span were reverted, since it asserts literal `T1..T6` strings against a live
  `mode:'ko'` render).
- All 7 pills reachable + selection re-targets bars: `SkillsCompare.test.tsx`'s
  existing sequential-click-through-all-7 and tick-position assertions (traced in
  the logic review at `:359-391`) are untouched by the fix-pass and still present.
- Progress + Diagnostic unaffected: `shortRefLabel`/`fullRefName` remain private to
  `SkillsCompare.tsx`; neither caller was touched in this diff.

### 4. Today carousel 1 → carousel 2's peek-slider mechanism — CONFIRMED
- Carousel 1 (`Today.tsx:604-687`) and Carousel 2 (`:707-717`) both render
  `.km-today__peekOuter > .km-today__peekTrack > .km-today__peekItem` — read both
  blocks directly, structurally identical.
- Shared CSS mechanism (`Today.css:200-263`): `flex: 0 0 78%`, `max-width: 78%`,
  `scroll-snap-align: center`, `scroll-snap-stop: always`, track
  `overflow-x: auto` + `scroll-snap-type: x mandatory` + `scroll-padding-inline:
  11%` — one shared block explicitly documented as serving both carousels
  (`Today.css:1-21` header).
- Vocab tile still uses real data and routes: `Today.tsx` reads
  `today.data.reviewCount` (no fabricated fallback) and the tile's `onClick`
  navigates to `/learn/vocab`; the three-way `loading`/`data`/error branch
  (Skeleton / ActivityTile / PlanErrorCard) is intact.
- `SwipeCarousel` confirmed used ONLY for carousel 3 (TOPIK):
  `grep -n "SwipeCarousel" Today.tsx` → one import (`:127`), one JSX use
  (`:743`/`:795` region), both inside the TOPIK section; the Today.css header
  comment (`:1-13`) explicitly states `SwipeCarousel` "remains the right tool ONLY
  for Carousel 3 (TOPIK) now."

### 5. Fix-pass NITs — CONFIRMED closed
- Dead `user-drag: none` line: gone, verified by direct read of
  `UploadViewer.css:93-98` (only `-webkit-user-drag: none` remains).
- Stale grammar-tab comments: `ReviewVocab.test.tsx` lines ~281/283/333-336
  corrected to state Grammar is reachable via the Library index, not
  `LibrarySubnav` — verified by direct read (see item 1 above).

### 6. No regressions — CONFIRMED
- Full independently-run test suite (below) passes clean at 115/115 files,
  1793/1793 tests — matches the fix-pass's claimed count exactly, and on this run
  the previously-noted flaky `ReviewDictionary.test.tsx` debounce assertion did
  **not** appear (full parallel run was clean on the first try — no flake observed
  this pass; consistent with both prior reports characterizing it as a
  parallel-run-only, pre-existing, unrelated flake, not a real break).
- Lint and typecheck both zero-error/zero-warning.
- Production build succeeds (exit 0), same 829.62 kB main-chunk warning as
  reported (pre-existing >500kB warning, no new errors, no new chunks).
- PRAISE from both prior reviews (minimal grammar-removal diff, real negative
  regression tests, precise root-cause doc-comments, aria-label/title dual channel,
  peek-slider convergence via shared classes) all still hold on direct re-read of
  the current code — nothing in the fix-pass touched or diluted any of it.

---

## Gates — independently re-run from `client/`

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0 errors, 0 warnings** |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| Full test suite | `npx vitest run` | **115 files passed, 1793 tests passed** — clean single run, flaky `ReviewDictionary` debounce test did NOT appear this pass |
| Build | `npx vite build --outDir /tmp/km-rr-mh2` | **exit 0** (829.62 kB main chunk, pre-existing >500kB warning only, no new errors) |

All four numbers match what `FIX_REPORT_mobile2.md` claimed, independently
reproduced rather than trusted.

---

## Findings

### BLOCKER
None.

### SHOULD-FIX
None. Both of the logic review's original SHOULD-FIX items (S1 language-display
bypass, S2 missing CSS test) were closed by the fix-pass and verified above.

### NIT
None outstanding. Both prior NITs (dead `user-drag`, stale grammar comments) are
closed.

### PRAISE
- The fix-pass's disposition on S1 (SkillsCompare T-codes) was the right call:
  rather than "fixing" the SHOULD-FIX by reverting to `<Bilingual/>` (which would
  have undone the user's explicit universal-T-code request), it locked the
  intended behavior with a real, seeded-provider test and an explanatory comment —
  closing the untested-behavior-change risk without regressing the feature.
- The new `SkillsCompare` Korean-mode test is a genuine regression guard, not a
  tautology: it proves the `SettingsProvider` seed took effect (via the eyebrow's
  real `Bilingual` text) before asserting the T-codes stay put, so a future
  accidental revert would be caught.
- The `UploadViewer` CSS source-pin test follows the codebase's own established
  convention exactly (mirrors `SkillsCompare.test.tsx`/`Today.test.tsx`'s
  `readFileSync` pattern) and pins the CSS and DOM halves of the fix together in
  one test.

---

## Deploy recommendation

**Ready to deploy to green.** All four round-2 fixes hold under independent
re-verification against the actual code (not the review docs' summaries), the
fix-pass's disposition on both SHOULD-FIX items is sound and correctly documented
in-code, no regressions were found anywhere in the `bd4783b..HEAD` diff, and all
four gates were independently re-run clean. The one residual known-unknown is the
capstone review's own honest ~65% confidence call on the PDF swipe fixing the
issue on a real device — that is not a code defect, is explicitly non-blocking
(the fix is additive), and the correct action is the capstone review's own
recommendation: a 60-second manual on-device swipe check (iPhone Safari + Android
Chrome) as the first post-deploy step, not another code-review pass.

Working tree left clean — no files modified during this review; only pre-existing
untracked files present (`.claude/`, `REDESIGN_SEOUL_NEON_BRIEF.md`,
`docs/redesign/BACKEND_BATCH_SCOPING.md`, and the two REVIEW_mobile2-*.md files
this re-review itself read).
