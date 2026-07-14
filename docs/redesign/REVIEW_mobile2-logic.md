# Review — Mobile Hardening, Round 2 (live mobile feedback)

**Reviewer:** independent senior React/TS reviewer (30yr). Did not write this code, the prior review (`REVIEW_FIXES_mobile.md`), or any of the three original mobile-hardening reviews it verified. Fresh read of this round's diff only.

**Repo:** `9b. Korean Master`, branch `feat/mobile-hardening` @ `c6a4436` (off `rebuild`)
**Diff scope:** `bd4783b..c6a4436` — `LibrarySubnav.{tsx,test.tsx}`, `SkillsCompare.{tsx,css,test.tsx}`, `Today.{tsx,css,test.tsx}`, `UploadViewer.{tsx,css,test.tsx}`
**Method:** read every changed file in full (not just hunks), diffed each file individually against `bd4783b` to isolate exactly what moved, traced every consumer of `LibrarySubnav`/`SkillsCompare` app-wide, ran the 4 independent gates from `client/`.

## VERDICT: **PASS with 2 SHOULD-FIX** — 0 blockers, safe to proceed

All four targeted bugs are genuinely fixed, correctly reasoned, and covered by tests that exercise real behavior (not tautologies). Two non-blocking gaps are worth closing before calling this class fully done: SkillsCompare's abbreviated pills silently opt out of the app's own bilingual-chrome contract for non-default language settings, and the new drag-source CSS in `UploadViewer.css` has no regression test despite the codebase's own established convention for pinning exactly this kind of CSS-only fix.

---

## Per-fix checklist

### 1. Grammar tab removal — **CONFIRMED, no blocker**
- [x] `SECTION_IDS` in `LibrarySubnav.tsx:34-37` now lists only `'review-vocab'`, `'review-dictionary'` — `'review-grammar'` removed (confirmed against the isolated diff, a pure 1-line removal + doc-comment update, nothing else touched).
- [x] The two, and only two, consumers (`ReviewVocab.tsx:99,252` and `ReviewDictionary.tsx:57,307`) render no Grammar tab. Both `LibrarySubnav.test.tsx:65-82` cases assert `queryByRole('button', {name:/grammar/i})` and `queryByText('문법')` are absent on both `/review/vocab` and `/review/dictionary` — a real negative assertion, not just an omission.
- [x] Grammar remains reachable via the Library index: `ReviewLibrary.tsx:93` (`sectionFor('review-grammar', 'blue')`, resolving to `/review/grammar` via `nav.ts:245`), with dedicated test coverage in `ReviewLibrary.test.tsx:74-99` (order assertion + a parameterized nav-on-tap test whose `['Grammar', '/review/grammar']` case actually clicks the row and asserts the route change).
- [x] `ReviewGrammar.tsx` is not orphaned: it never imported `LibrarySubnav` (confirmed by the full-tree consumer grep), and carries its own `<BackButton to="/review" .../>` at `ReviewGrammar.tsx:298-302` — an explicit forward target, not a bare history-back fallback, so it always lands on the Library index regardless of how the user arrived.
- [x] `NavItemId`/`navItem('review-grammar')` are untouched in `lib/nav.ts` (still a valid union member, line 69; full manifest entry at 241-252; still in `SECONDARY_IDS` at 331) — this was a surgical removal from one component's local array, not a type/route deletion. `lib/nav.test.ts:86,90` still pin the manifest entry directly.
- [x] No other vocab/dictionary-lens surface renders a grammar link — full-tree grep of `pages/`+`components/` for `grammar`/`Grammar` turned up nothing else reachable from the vocab lens (see Findings for the two adjacent, unrelated hits this turned up).

### 2. PDF swipe img-drag fix — **CONFIRMED, no blocker**
- [x] Mechanism is correct and standard: `draggable={false}` (`UploadViewer.tsx:368`) + an `onDragStart` preventDefault veto (`:369-371`) turn off the HTML5 native-drag-source behavior every `<img>`/`<a>` has by default; `-webkit-touch-callout: none` + `-webkit-user-drag: none` (`UploadViewer.css:93-99`) turn off iOS's long-press callout and belt-and-brace the drag shutoff at the CSS layer for engines that honor it. This is the textbook fix for "native image drag/callout hijacks a custom touch gesture" and the doc comment's reasoning (module header §"real-device follow-up", `UploadViewer.tsx:137-160`) about *why* `touch-action`/`preventDefault` alone couldn't have caught this is accurate — those two only arbitrate scroll/pan, never the browser's separate drag-source/long-press-menu decision.
- [x] Isolated the diff (`git diff bd4783b c6a4436 -- UploadViewer.tsx UploadViewer.css`): the ONLY functional changes are the `className`/`draggable`/`onDragStart` additions on the one `<img>` and the matching CSS block. Nothing in `pageLayout()`, the zoom/rotation state machine, `touchAction` toggling, or the Prev/Next handlers was touched — so the "must not break" surface is provably untouched, not just "looks fine on read":
  - Image still renders/loads: `onLoad`/`onError`/`status` state machine (`UploadViewer.tsx:376-388`) is unchanged; `PageImage.test` … the parent test's `settleImage('load'/'error')` helpers still pass.
  - Zoom-pan above fit: `swipeEligible = zoom <= FIT_ZOOM` (`:577`) and the `touchAction: swipeEligible ? 'pan-y' : 'auto'` toggle (`:1044`) are untouched — `draggable=false` on the `<img>` has no bearing on the container's native scroll/pan, which is governed entirely by `touch-action`/`overflow: auto` on `.km-upload-viewer__page`, a different element.
  - Keyboard/Prev-Next paging: `goPrev`/`goNext` and the toolbar buttons (`:851-872`) are untouched; test `'arrow-button paging still works after the swipe handlers are wired up'` (`UploadViewer.test.tsx:895-904`) passes.
  - Vertical scroll: `.km-upload-viewer__page{overflow:auto}` (`UploadViewer.css:67-83`) untouched; the vertical-dominant-drag surrender path (`onPagePointerMove`, `:619-627`) untouched, and its dedicated test (`'a vertical-dominant drag surrenders...'`, `UploadViewer.test.tsx:695-716`) still passes.
- [x] Real tests exist for both halves: `draggable=false` is asserted directly on the rendered node (`UploadViewer.test.tsx:951-958`), and the `onDragStart` veto is asserted via the `dispatchEvent` return-value proxy (`:967-975`, `fireEvent.dragStart` returns `false` iff `preventDefault` fired) — genuine behavioral assertions, not implementation-detail snapshots. The full touch-swipe flow (down→move→move→up, `pointerType:'touch'`) is exercised end-to-end at `:917-941`.
- [x] Ran the full file: `npx vitest run src/pages/UploadViewer.test.tsx` — 39/39 pass (part of the 109/109 combined run below).

### 3. TOPIK T1…T6/Native labels — **CONFIRMED functionally, 1 SHOULD-FIX (a11y/i18n contract)**
- [x] Accessible name is unchanged and correct: `aria-label={fullRefName(r)}` (`SkillsCompare.tsx:179`, `fullRefName` at `:100-102`) reproduces the exact "kr · en" shape the computed accessible name used before this pass (confirmed against `bd4783b`'s version, which rendered `<Bilingual en={r.label} kr={r.kr} compact/>` inside the button — Bilingual's own computed accessible name for two present languages is that same "kr · en" string). Every existing test that queries `getByRole('radio', {name: '4급 · TOPIK 4'})` etc. (`SkillsCompare.test.tsx:86,98,107-112,121...`) still passes unmodified — a real regression guard, not a rewritten expectation.
- [x] All 7 pills reachable + re-target the bars: `SkillsCompare.test.tsx:319-414` — visible-text assertion (`['T1'...'T6','Native']`, `:329`), full-name-as-accessible-name assertion (`:332-342`), no-kr fallback (`:344-357`), sequential-click-through-all-7 (`:359-369`), and a tick-position assertion proving a pick genuinely re-targets `SkillBar` (`:371-391`, not just flips `aria-checked`).
- [x] Progress + Diagnostic are unaffected: both feed `SkillsCompare` via internal mappers (`Progress.tsx:224-233` `toSkillRefs`, `Diagnostic.tsx:1153`) that pass through `label`/`kr` from the domain snapshot unchanged; `shortRefLabel`/`fullRefName` are private to `SkillsCompare.tsx`, so neither caller needed or received any change. The real production reference set (`data/mocks/diagnostic.ts:30-36,102-108`) is exactly `TOPIK 1..6` + `Native`, matching the regex `shortRefLabel` expects.
- [ ] **SHOULD-FIX — the visible pill silently stops following the Bilingual language-display setting.** Before this pass, the pick's visible text was `<Bilingual en={r.label} kr={r.kr} compact/>` (confirmed via `git show bd4783b:.../SkillsCompare.tsx` lines 137-151) — per `Bilingual.tsx`'s own documented contract ("the single primitive for bilingual UI CHROME text... so the user's language-display setting... applies everywhere at once", `Bilingual.tsx:1-4`), that meant: in `mode:'en'` the visible pick read "TOPIK 4"; in `mode:'ko'` it read "4급"; in the default `mode:'both'` (compact, Korean-primary per `useLanguageDisplay.ts:16` default) it read "4급" too. After this pass (`SkillsCompare.tsx:194`, `<span aria-hidden="true">{shortRefLabel(r.label)}</span>`), the visible text is **always** "T4"/"Native" regardless of the setting — Korean-display users lose the Korean pill entirely, not just get it abbreviated. The builder's own doc comment (`SkillsCompare.tsx:150-159`) explicitly flags this as a deliberate scope-step-out and reasons "T4 is a universal code, not a translation choice" — that's a defensible call for a genuinely universal token (the app already does this for `id` values like `'L4'`), but "TOPIK 4"/"4급" is exactly the kind of localized chrome text `Bilingual` exists to own, and no other chrome element in this codebase bypasses it this way. No test exercises `mode:'ko'` or `mode:'en'` for this component, so this silent behavior change is untested, not merely unaddressed. **Judgment: SHOULD-FIX, not BLOCKER** — the accessible name is fully intact (screen-reader users see no regression at all) and no functionality breaks; this is a visual/i18n consistency regression for sighted Korean-display-mode users, which on a personal bilingual-learner app is a real but non-blocking product paper-cut. Recommend either restoring `<Bilingual compact>` for the visible span (accepting the original overflow risk the CSS scroll-rail already defends against) or, if the abbreviation is kept, adding a `mode==='ko'` variant ("4급" instead of "T4") plus a test pinning it.

### 4. Today carousel 1 → peek slider — **CONFIRMED, no blocker**
- [x] Both carousels use the identical mechanism: Carousel 1 (`Today.tsx:604-696`) and Carousel 2 (`:716-717`) both render `.km-today__peekOuter > .km-today__peekTrack > .km-today__peekItem` — confirmed structurally by `Today.test.tsx:346-359` (`drills.querySelector('.km-today__peekTrack')` / `suggested.querySelector(...)` both non-null, 3 `.km-today__peekItem` children in carousel 1) and by the CSS-source-pin test (`Today.test.tsx:576-613`) that reads `Today.css` directly for `scroll-snap-type`/`scroll-snap-align`/the `flex: 0 0 78%` geometry/the reduced-motion override — the right test shape given happy-dom does no layout.
- [x] Vocab tile still shows the real `reviewCount` and routes correctly: `Today.tsx:607-641` reads `today.data.reviewCount` (no fabricated fallback — the `today.loading`/`today.data`/error three-way branch is unchanged from the pre-restructure logic, only its wrapping div's class changed from a `SwipeCarousel` page to a `.km-today__peekItem`), navigates to `/learn/vocab` (`:636`). Tests: `'Vocab tile is RESTORED...'` (`Today.test.tsx:363-377`, clicks through to the mocked `/learn/vocab` route) and the singular/plural due-count test (`:379-388`).
- [x] No page-level x-overflow introduced: `.km-today__peekTrack` owns its own `overflow-x: auto` (`Today.css:230-248`); `.km-today__peekOuter` only claws back a 2px inset (`:223-228`) and carries no overflow rule of its own. This is the same self-contained-rail pattern the prior round's re-review (`REVIEW_FIXES_mobile.md` finding #9) traced up to the pre-existing `.km-shell__scroll{overflow-x:hidden}` backstop — unchanged by this round, and this round's new track is exactly the same shape as Carousel 2's track that already passed that scrutiny.
- [x] `SwipeCarousel` is used only for Carousel 3: confirmed via `grep -n "SwipeCarousel" Today.tsx` — one import (`:127`), one JSX use (`:743-795`), both inside the TOPIK section. Test `'renders exactly THREE carousels...'` (`Today.test.tsx:317-344`) asserts the TOPIK region alone carries `aria-roledescription="carousel"` while both peek regions explicitly do not, and pins DOM order (drills → suggested → TOPIK).

---

## Findings

### BLOCKER
None.

### SHOULD-FIX

**S1 — SkillsCompare pick pills no longer respect the language-display setting.**
`client/src/components/SkillsCompare.tsx:194` renders the pill's visible text as a hardcoded `shortRefLabel(r.label)` span instead of routing through `<Bilingual/>`. Previously (`bd4783b`, `SkillsCompare.tsx:150-151` in that revision) the same span was `<Bilingual en={r.label} kr={r.kr} compact/>`, meaning the visible pill tracked `mode:'en'|'ko'|'both'` like every other piece of chrome in the app (`Bilingual.tsx:1-4`'s own stated contract). Now it's frozen to an English-letter abbreviation ("T4"/"Native") in all three modes. A `mode:'ko'` user — a real, supported setting, not a hypothetical — loses the Korean pill text entirely; this was true before the abbreviation only in the sense that "TOPIK 4"/"4급" were both real localized options, not that either was universally shown. No test in `SkillsCompare.test.tsx` varies `useLanguageDisplay`'s mode, so this is an untested behavior change, not a knowingly-accepted one. See checklist item 3 above for the full trace and a recommended fix (either restore `Bilingual` for the visible span, or add a `mode==='ko'` short-form + a pinning test).

**S2 — No regression test for the new drag-source CSS in `UploadViewer.css`.**
`UploadViewer.css:93-99` adds `-webkit-touch-callout: none`, `-webkit-user-drag: none` (`user-drag: none` alongside it — see NIT below), and `user-select: none` on `.km-upload-viewer__img`. These are exactly the class of fix `SkillsCompare.test.tsx:286-316` and `Today.test.tsx:576-613` already pin from source in this same round/codebase, precisely because "happy-dom does no layout, so the actual on-screen ... behavior can't be measured by rendering" (both tests' own comments). `UploadViewer.test.tsx` has no equivalent — I grepped it for `readFileSync`/`UploadViewer.css`/`touch-callout`/`user-drag` and found none. The two behavioral tests that do exist (`draggable=false`, `onDragStart` veto — `:951-975`) cover the JS half of the fix but not the CSS half, which per this component's own module-header reasoning (`UploadViewer.tsx:137-160`) is load-bearing on real iOS Safari (the JS `draggable`/`onDragStart` pair alone doesn't stop the native long-press callout — that's what `-webkit-touch-callout: none` is for). A future refactor of this stylesheet could silently drop these three lines and nothing in the suite would fail. Recommend a source-pinning test mirroring the established `readFileSync(...SkillsCompare.css...)` pattern.

### NIT

**N1 — `user-drag: none` is not a real CSS property.**
`UploadViewer.css:96` — there is no standard (or any-browser-implemented) unprefixed `user-drag` property; only `-webkit-user-drag` (`:95`) is real. The unprefixed line is inert (browsers silently ignore unknown declarations) so it's harmless, but it reads as intentional belt-and-braces when it's dead weight. Low priority; drop it or leave it — no behavioral difference either way.

**N2 — Two stale doc-comments elsewhere describe the just-removed Grammar tab as if it still exists.**
`ReviewVocab.test.tsx:281,332-336` (not touched by this round's diff) contain comments like *"the page's LibrarySubnav legitimately shows a 'Grammar' NAVIGATION link elsewhere"* and *"the LibrarySubnav's 'Grammar' navigation link to the sibling `/review/grammar` route"*. These are now factually wrong — `LibrarySubnav.tsx:34-37` no longer includes `'review-grammar'` — though the assertions themselves still pass (they only exclude the subnav's own text from an unrelated text-sweep, and that text no longer contains "Grammar" either way, so the test's behavior is accidentally still correct). Not a functional bug and out of this round's touched-file set, but worth a follow-up edit since this is the exact bug class this round just fixed — leaving the stale reasoning in place invites someone to "fix" `LibrarySubnav` back toward matching the comment.

### PRAISE

- **Grammar removal is a genuinely minimal, well-reasoned diff.** One array-literal line removed, no route/type/manifest surface touched, and the doc comment change correctly documents *why* nothing is orphaned (`LibrarySubnav.tsx:13-20`) rather than just asserting it.
- **`LibrarySubnav.test.tsx`'s new negative assertion is a real regression guard**, not a tautology: it renders both consumer routes and asserts both the absent button role and the absent Korean string, which is exactly the shape of the bug ("grammar keeps showing on the Vocab page") this fixes.
- **The `UploadViewer` img-drag root-cause writeup** (module header, `UploadViewer.tsx:137-160`) is unusually precise about *why* the prior `touch-action`/`preventDefault` port didn't work — correctly separates "scroll/pan arbitration" from "native drag-source/long-press-menu arbitration" as genuinely different browser subsystems, which is the actual reason this class of real-device bug is hard to catch in code review or jsdom.
- **`SkillsCompare`'s `aria-label`/`title` dual-channel** (`:179-180`) means sighted mouse users (hover tooltip) and screen-reader users get the same unabbreviated name via two different affordances — a thoughtful belt-and-braces choice, and the "derives the short code from the label, not the id" regression test (`SkillsCompare.test.tsx:393-414`) specifically guards against a plausible future refactor mistake.
- **Today's peek-slider unification** is a clean convergence, not a copy-paste: Carousel 1 now literally shares CSS classes with Carousel 2 rather than duplicating the mechanism, so a future geometry tweak (78%/11% peek) only has one place to change.

---

## Coordination

- **S1 (language-display bypass)** and **S2 (missing CSS test)** are both independently fixable without touching the other three fixes — no sequencing dependency between them or against fix 1/2/4's own closure.
- **N2** is a one-line comment edit in `ReviewVocab.test.tsx`, unrelated to this round's diff; safe to fold into whatever PR fixes S1, or its own tiny follow-up.
- Full-suite run turned up one flaky, unrelated failure: `ReviewDictionary.test.tsx` (a file untouched by this round) failed once under `npx vitest run` (full suite, parallel) on a debounced-search-clear assertion, then passed 18/18 in isolation on re-run. Not a regression from this batch — flagging only so it isn't mistaken for one if CI reproduces it.

---

## Gates — run independently from `client/`

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0 errors, 0 warnings** |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| Targeted tests | `npx vitest run` on the 4 changed test files | **4 files, 109/109 pass** |
| Full suite | `npx vitest run` | **114/115 files pass, 1789/1790 tests pass** (1 flaky, unrelated — see Coordination) |

Build was not run this round (no bundler-relevant changes — CSS/TSX only, no new deps/config); happy to add if requested.
