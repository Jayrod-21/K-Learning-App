# Review — Mobile hardening: Today carousel restructure + Grammar purge from Library→Vocab

**Reviewer:** independent senior React/TS reviewer (30yr, did not write this code)
**Branch:** `feat/mobile-hardening` @ `9a9389f` (off `rebuild`)
**Scope:** `client/src/pages/Today.tsx`/`.css`/`.test.tsx`, `client/src/pages/review/ReviewVocab.tsx`/`.test.tsx`, `client/src/components/MyVocabLists.tsx`/`.test.tsx`
**Method:** full diff read (`git diff rebuild --`), full current-file reads of all five touched source files plus their direct dependents (`SwipeCarousel.tsx`, `Writing.tsx`, `Shell.tsx`, `services/vocab.ts`, `server/src/routes/vocabLists.ts`, `server/src/routes/plan.ts`), `client/src/styles/index.css` for the shell's overflow contract, live test run (`vitest run` on all three touched test files: **79/79 pass**), `tsc --noEmit` (clean), `eslint` on the three touched source files (clean, `--max-warnings=0`). Reasoned about real 360px mobile layout math by hand (jsdom does no layout) rather than trusting the tests' own jsdom assertions for anything geometry-dependent.

## Verdict: **CHANGES REQUIRED — 1 BLOCKER**

The Today restructure is genuinely well done: all three carousels exist, in the right order, Vocab is authentically restored (real `reviewCount`, not fabricated), the peek slider's scroll-snap math is correct and will produce a real peek effect at 360px, it cannot cause page-level horizontal overflow, and the Writing handoff trade is clean. **But the grammar purge is not actually complete.** The batch-3 fix-pass patched exactly one of at least two places that render vocab lists on `/review/vocab`. `MyVocabLists`'s "My Lists" tile is now correctly kind-filtered — but `ReviewVocab.tsx`'s own `AddToListSheet` (the "Add to a list" picker opened from any Browse-row's "List"/"Add" button) independently calls `vocabService.listLists()` with **zero kind filtering**, completely untouched by this PR, and renders every list the server returns — grammar-kind included — as a pickable destination. The new tests prove the My-Lists path is clean; none of them ever open the picker sheet with a mixed-kind server response, so the suite is silent about the bug that's still there. This is exactly the "test can't catch its bug" failure mode the review brief calls out — just in a sibling code path the fix-pass never looked at.

---

## Carousel structure — CONFIRMED correct

`Today.tsx:574-772` — three carousels, in the required order:

1. **`Today.tsx:582-674`** — "Review & drills" `SwipeCarousel`, looped, 3 pages: Vocab (`:584-620`) → Grammar (`:621-650`) → Hanja (`:651-672`). Vocab is genuinely restored: `today.data.reviewCount` (`:591-616`) traces to `TodayPlan.reviewCount` (`types/domain.ts:526`) ← `services/plan.ts:52` (`reviewCount: res.dueCount`) ← `server/src/routes/plan.ts:222,346` (`due.rows[0].due_count`, a real FSRS due-count query) — not a fabricated number, and `onClick` navigates to `/learn/vocab` (`:614`). Confirmed by `Today.test.tsx:338-354` clicking the tile and asserting the real due-count text and route.
2. **`Today.tsx:686-703`** — "Suggested learning" peek slider (native scroll-snap, not `SwipeCarousel`), Reading → Listening → Writing, each gated on the corresponding `today.data.*` field being non-null (`:448-531`).
3. **`Today.tsx:714-772`** — "TOPIK" `SwipeCarousel` (single page), last, carrying the folded-in "Review mistakes" button and the F-007 resume-exam `cornerSlot`.

`Today.test.tsx:310-336` asserts this order directly (queries all three regions, checks `aria-roledescription` presence/absence per-carousel, and asserts DOM order via `querySelectorAll`). Ran it: passes.

## (a) Peek slider — VERDICT: no page-level x-overflow, and the peek math is genuinely correct at 360px

**Mechanism traced, `Today.css:216-298`:**
- `.km-today__peekTrack` (`:223-241`): `display:flex; overflow-x:auto; overflow-y:hidden; scroll-snap-type:x mandatory; scroll-padding-inline:11%; padding:4px 11% 10px; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch`.
- `.km-today__peekItem` (`:247-256`): `flex:0 0 78%; max-width:78%; min-width:0; scroll-snap-align:center; scroll-snap-stop:always`.

**Why 78%/11%/11% is the right ratio, worked by hand:** `78% + 11% + 11% = 100%`. Combined with `scroll-padding-inline:11%` on the scroll container, the browser's effective "viewport" for centering math is `100% − 2×11% = 78%` — exactly the item's own width. When an item is snapped, it exactly fills the adjusted viewport with zero slack, and its two neighbors sit precisely in the two 11% peek zones at the track's edges. This is percentage-based, not hardcoded pixels, so the peek effect is preserved at any viewport width, 360px included — at 360px the peek zone is ~40px per side (minus half the 12px inter-item `gap`), enough to show a real, legible sliver of each neighbor (icon-chip width), matching the "spin table" feel the user asked for. `scroll-snap-stop:always` (`:255`) is the correct choice to stop a fast fling from skipping a tile — matches the user's "glides one step" description, not free-run momentum.

**Why this can't cause page-level horizontal scroll, traced ancestor-by-ancestor:**
- `Today.tsx`'s root `<section className="screen km-today km-rain-sheen">` renders inside `<main className="km-shell__scroll"><Outlet/></main>` (`client/src/components/Shell.tsx:153-155`).
- `.km-shell__scroll` (`client/src/styles/index.css:1019-1024`) sets `overflow-y:auto; overflow-x:hidden` — both axes explicit (no accidental `visible`→`auto` promotion). This is the actual, single source of truth for "the app body never scrolls sideways," and it wraps **every** routed page, Today included, pre-existing and untouched by this diff.
- `.km-today__peekOuter`'s `margin:0 -2px` (`Today.css:216-221`, clawing back `.km-today__tilePage`'s 2px inset so the peek slider visually lines up with Carousels 1/3) does push the box 2px past `.km-today`'s own edge on each side — but `.km-today` itself carries no horizontal padding (pre-existing across this app; `.km-progress` has the identical "belt-and-suspenders `overflow-x:hidden`" comment for the same reason, `Progress.css:31-34`), so those 2px are simply clipped by `.km-shell__scroll`'s backstop. Invisible, harmless.
- The scroll surface itself (`.km-today__peekTrack`) is the only element with `overflow-x:auto` in this subtree, and its flex children use `min-width:0` (`Today.css:250`) — the correct guard against a long Korean title (`overflow-wrap:anywhere` on `.km-today__tileHeadline`, `Today.css:140`, backs this up too) forcing a flex item wider than its `78%` basis and blowing out the track's own box.

**Conclusion for (a): confirmed correct.** No page-level x-overflow risk, and the peek effect is real at 360px, not just a class-name aspiration.

One consistency NIT: `.km-today` doesn't carry its own `overflow-x:hidden` backstop, unlike `.km-review`/`.km-progress` (both explicitly comment that they add it as "belt-and-suspenders" over the shared shell rule). Not a bug — `.km-shell__scroll` already covers it — but worth adding to `Today.css` for consistency with the stated project convention, cheap while in the file.

## Progressive-enhancement animation — CONFIRMED gated correctly

`Today.css:268-291`: the `view(inline)`-timeline center-pop lives entirely inside `@supports (animation-timeline: view())`, so unsupported browsers get zero animation rules (not a broken partial one) — every tile renders at equal opacity/scale, a flat but fully functional row. The separate `@media (prefers-reduced-motion: reduce)` block (`:287-291`) sets `animation:none` unconditionally, so it fires regardless of `@supports` — correctly gated regardless of feature-detection order. `Today.test.tsx:579-616` pins both blocks by source-string (with an honest comment that jsdom does no layout so this is the right test, not a cop-out) — verified structurally, not just substring-matched, so it can't false-positive against the base rule. Good test.

## Carousel 1/3 vs. the peek slider — a11y model is honest and correctly differentiated

`Today.tsx:678-682`/`Today.css` comment block: Carousels 1/3 use `SwipeCarousel`'s `aria-roledescription="carousel"` + `aria-hidden`/`inert` off-screen paging (verified in `SwipeCarousel.tsx:308-322`); the peek slider is a plain labeled `<section aria-label="Suggested learning">` with all three tiles simultaneously real, focusable `<button>`s (`ActivityTile` always renders an unconditional `<button>`, `Today.tsx:277-282` — no `tabIndex=-1`/`aria-hidden` applied to peek items). This is the right a11y shape for a continuous-scroll rail: Tab order plus the browser's native scroll-into-view on focus makes every tile reachable without any bespoke ARIA-carousel wiring. `Today.test.tsx:468-482` confirms `queryAllByRole('tab')` is empty inside this region while all three tile texts are present — a real assertion, not a tautology.

Minor NIT: the visible `Eyebrow` text "Suggested learning" (`Today.tsx:683-685`) sits as a sibling immediately above a `<section aria-label="Suggested learning">` with the identical string — a screen-reader landmark-navigation user hears the name twice (once as plain text, once as the region's accessible name). Extremely common pattern, not worth blocking on, but note for a future pass if landmark navigation ever gets a dedicated audit.

## F-134 removal (Writing inline-expand) — CONFIRMED a clean trade

- `Today.tsx` no longer imports `CollapsibleTile`/`WritingTopicGenerator` (diff `:163-164` removed, confirmed no orphaned import remains — `grep` clean).
- Writing is now a plain `ActivityTile` (`Today.tsx:496-531`) navigating to `/learn/writing` with **no router state** — it's a plain open, not a generated-topic handoff (Today no longer generates topics inline, so there's nothing to hand off from here).
- `Writing.tsx` mounts its own `WritingTopicGenerator` and independently supports `location.state.generatedTopic` (`Writing.tsx:296-314`, `readGeneratedTopic` — a defensive, field-by-field runtime narrow of untrusted router state, degrading to the bank-prompt flow on anything malformed) — this is pre-existing F-101 code, unaffected by this diff, so the generator capability is preserved, one tap away, exactly as the module doc claims.
- `Today.test.tsx:506-514` confirms the Writing tile still navigates and there's no leftover CollapsibleTile control.
- Nothing else broke: `grep` across the client for `CollapsibleTile`/`WritingTopicGenerator` shows their only other production usage is `ReviewVocab.tsx` (My Lists tile) and `Writing.tsx` itself respectively — both untouched, both still functioning. **Clean trade, no blocker.**

---

## (b) Grammar purge — VERDICT: **NOT fully gone.** BLOCKER — a second, untouched leak path.

### What the fix actually did (correct, as far as it goes)

`MyVocabLists.tsx:184` — `const visibleLists = lists.filter((l) => kinds.includes(l.kind));` — computed in the render body, not inside `load`'s `useCallback` (`:116-129`, deps `[]`). This is exactly right per the brief's concern: `load`'s referential identity must stay stable across renders because a new `onClose` identity fed to `<Sheet>` re-runs `useModalA11y`'s open/close effect on every keystroke, whose cleanup re-steals focus out of the create-list name input (documented at `:138-145`, `:175-183`). Filtering downstream of `load` in render, off the `kinds` prop directly, avoids ever needing `kinds` in `load`'s deps. Correct call.

All four render branches use `visibleLists`, not `lists`: loading (`:204-207`, doesn't reference either), error-with-nothing-to-show (`:208`, `error && visibleLists.length === 0`), true-empty (`:210`), and the populated `<ul>` (`:231`, `visibleLists.map`). The stale-refresh banner correctly still checks bare `error` (`:223`) so a background refresh failure surfaces even when `visibleLists` still has rows from the last good fetch — unchanged, correct behavior.

`MyVocabLists.test.tsx:225-262` and `ReviewVocab.test.tsx:307-355` both mock a **mixed** vocab+grammar `listLists()` response and assert the grammar row never renders in "My Lists" (by text, by button role, and — in the `ReviewVocab.test.tsx` version — by a full-page text sweep excluding only the legitimate `LibrarySubnav` "Grammar" route-link). Ran both: pass. This part of the fix is real, well-tested, and would have caught the original bug in *this* path.

### What's still broken

`ReviewVocab.tsx` has a **second, completely independent list-fetching path** that this PR's diff never touches (the diff to this file is 13 lines, all doc-comment prose — confirmed via `git diff rebuild -- client/src/pages/review/ReviewVocab.tsx`):

- **`ReviewVocab.tsx:708`** — `AddToListSheet`'s own `useEffect` calls `vocabService.listLists()` directly (not through `MyVocabLists`, no `kinds` prop exists on this path at all).
- **`ReviewVocab.tsx:711`** — `setLists(rows)` — the raw server response, unfiltered by kind.
- **`ReviewVocab.tsx:822`** — `{lists.map((list) => (` inside the "Add to a list" `Sheet` — every list the server returned renders as a `<Button>` pick target, by `list.name_kr` (`:837`). A pre-existing `kind:'grammar'` list (the exact scenario the new tests construct for the *other* path) renders here as a legitimate-looking destination the user can tap to file a vocab word into a grammar list.

This sheet is reachable from `/review/vocab` today: tap "List" next to any Browse-corpus row (`VocabBrowse`'s per-row button, `ReviewVocab.tsx:607-630`, `setAddTarget(entry)`) opens exactly this sheet. **It is a live, first-class affordance on this page, not a hidden dev path.**

The `kind:'vocab'` hardcode that *does* exist in this file (`ReviewVocab.tsx:765`, inside `AddToListSheet`'s own inline "create a new list" flow) only scopes what a **newly created** list becomes — it does nothing for the **picker list above it**, which is exactly the same "create vs. display" conflation the batch-2 and batch-3 fix-passes already diagnosed and fixed once, in a different component. The same class of bug survives here, unnoticed, one file scroll down from the fix.

**Why no test catches this:** every existing `AddToListSheet` test (`ReviewVocab.test.tsx` "add a corpus word to a list (F-048)" describe block, e.g. `:657-700`) relies on the file's default `beforeEach` mock, `vocabSvc.listLists.mockResolvedValue([SERVER_LIST])` (`:136`) — vocab-only, same blind spot the batch-2 review already flagged once for a sibling component ("every existing test's `listLists()` mock returned vocab-only rows"). No test ever mocks a mixed-kind response and then opens this specific sheet. The two new tests this PR added (`MyVocabLists.test.tsx:225`, `ReviewVocab.test.tsx:307`) both exercise the *page's initial render* and the *My Lists* tile — neither ever calls `setAddTarget`/opens the word-picker sheet. **So: would this PR's new tests have caught this bug? No — they test a different component's render path entirely.** And directly answering the brief's question — *"Is grammar now truly unreachable anywhere on `/review/vocab`?"* — **no, it is not.**

**Fix-pass action:** either (a) give `AddToListSheet` the same treatment as `MyVocabLists` — filter `rows` to `kind === 'vocab'` before `setLists`, mirroring `visibleLists`'s pattern exactly (cheap, consistent) — or, better, (b) see the SHOULD-FIX below: pass `kind: 'vocab'` at the API boundary instead, which fixes this same leak and a second latent issue in one move. A follow-up ticket is not an acceptable disposition here, per this repo's own stated precedent (`REVIEW_batch2-vocab.md`'s B-1 finding: "A follow-up ticket is not an acceptable disposition for a P1 ticket whose entire point is 'the user is annoyed grammar shows up here.'" — the same standard applies to this recurrence).

---

## SHOULD-FIX

**S-1 — The fix filters client-side; the server already supports `?kind=`, and ignoring it reintroduces a truncation bug at scale.**
`server/src/routes/vocabLists.ts:117-121` — `GET /vocab/lists` already accepts an optional `kind` query param (`IndexQuerySchema.kind: LIST_KIND.optional()`) and applies it server-side (`:163`, `AND ($2::text IS NULL OR l.kind = $2)`). But `client/src/services/vocab.ts:308-312`'s `listLists()` takes **no parameters at all** and always calls the bare `/vocab/lists` endpoint — every consumer, including the just-patched `MyVocabLists`, fetches *all* kinds and filters client-side after the fact.

This matters beyond wasted bandwidth: the same endpoint defaults `limit` to **20** (`IndexQuerySchema.limit: z.coerce.number()....default(20)`, `:119`), ordered `updated_at DESC` (`:159`), and neither `MyVocabLists` nor `AddToListSheet` paginate past page one. For a user whose 20 most-recently-touched lists happen to be a mix of kinds — plausible for anyone who's used both a Grammar-adjacent feature and Vocab lists — the client-side `.filter()` can only ever operate on whatever slice of *all-kind* rows the server's `LIMIT 20` happened to return, so a real vocab list that exists but wasn't in the most-recent-20-of-any-kind window silently never appears, with no error, no "show more," nothing. Passing `kind: 'vocab'` through to the query string would apply the `LIMIT` **after** the kind predicate server-side (it's a single `WHERE`+`LIMIT` query, `:148-166`), guaranteeing up to 20 real vocab lists instead of up to 20 real lists-of-any-kind. This is currently a low-probability edge case for this app's stated single-user/handful-of-friends scope, but it's the textbook argument for preferring the filter that already exists over reinventing one client-side — and it would fix the BLOCKER above for free if `AddToListSheet` adopted the same param.

**S-2 — `Today.css`'s `.km-today` doesn't carry the same defensive `overflow-x:hidden` backstop `.km-review`/`.km-progress` document as house convention.**
Not a functional bug (`.km-shell__scroll` already backstops every page, see the (a) analysis above) — but if a future edit ever gives `.km-today` its own scrolling ancestor context, or the shell rule is ever loosened, Today would be the one page silently missing the second layer of defense every sibling page's CSS file explicitly calls out in its own header comment. Cheap to add for consistency while this file is already being edited for this exact concern.

## NIT

**N-1** — Duplicate accessible-name announcement for the "Suggested learning" region (visible `Eyebrow` text immediately followed by a sibling `<section aria-label="Suggested learning">` with the same string) — see the a11y discussion above. Cosmetic, common pattern, not worth a ticket on its own.

**N-2** — `Today.tsx:719-770`: `SwipeCarousel`'s `children: ReactNode[]` contract is satisfied for the single-page TOPIK carousel via an explicit `{[...]}` array-literal wrapper with an inline comment explaining why (rather than loosening the shared component's prop type). This is the right call, not a real nit — flagging only because it reads slightly awkward on first pass; no action needed.

## PRAISE

**P-1** — The peek slider's percentage-based `78%/11%/11%` geometry (`Today.css:223-256`) is genuinely well-engineered: it guarantees the "peek" effect at any viewport width by construction (the scroll-padding and item-width percentages are complementary by design, not by coincidence), rather than a fixed-pixel layout that would only work at one assumed screen width. This is exactly right for a "mobile-hardening" pass whose whole premise is a real, reported 360px-class device.

**P-2** — `Today.test.tsx:579-616`'s CSS-mechanism test is an honest, well-reasoned response to a real tooling limitation: it says outright that jsdom can't measure real scroll/snap behavior, and pins the actual CSS rule text from source instead of faking a jsdom layout assertion that would just be lying about what it verified.

**P-3** — The module-header doc comments in both `Today.tsx` and `MyVocabLists.tsx` are unusually precise about *why* a decision was made where it was (e.g., the `visibleLists` filter's placement relative to `load`'s `useCallback`, spelled out with the exact downstream consequence it avoids) — this is the kind of comment that actually prevents the next person from "fixing" it back into a bug.

---

## Explicit answers to the brief's two flagged questions

**(a) Does the peek slider avoid page-level x-overflow at 360px, and is the peek genuinely visible?** **Yes to both**, confirmed by tracing the full ancestor chain to `.km-shell__scroll`'s `overflow-x:hidden` (pre-existing, untouched, wraps every page) and by hand-computing the `78%/11%/11%` scroll-snap geometry, which is percentage-based and therefore correct at any viewport width including 360px.

**(b) Is grammar truly gone from `/review/vocab`?** **No.** `MyVocabLists`'s "My Lists" tile is now correctly kind-filtered and well-tested. But `ReviewVocab.tsx`'s own `AddToListSheet` (`:708`/`:711`/`:822`) — reachable via any Browse row's "List" button — independently fetches and renders **every** list kind, completely unaffected by this PR's fix. This is a BLOCKER: the ticket's stated goal ("grammar purge") is not met, and no test in this PR would catch it because none of the new mixed-kind-response tests ever open this specific sheet.

## Coordination

- The `AddToListSheet` fix is small and mechanical (mirror `visibleLists`'s one-line filter, or better, add `kind: 'vocab'` to the `listLists()` call per S-1) and should land before this PR is considered to have closed the grammar-purge ticket — recommend blocking merge/deploy on it rather than filing a follow-up, consistent with this repo's own stated precedent in `REVIEW_batch2-vocab.md`.
- S-1 (server-side `kind` filtering) is a slightly larger but still contained change (`services/vocab.ts:listLists()` gains an optional `kind` param, `MyVocabLists`+`AddToListSheet` both pass it) — worth doing in the same pass since it fixes the BLOCKER and the latent pagination-truncation issue in one move, but could ship as an immediate fast-follow if there's schedule pressure, PROVIDED the `AddToListSheet` client-side filter (the mechanical fix) ships first so the BLOCKER itself is closed either way.
- Everything else in this diff (Today's three-carousel restructure, Vocab restoration, peek slider, F-134 trade) is ready as-is — no changes needed there.
