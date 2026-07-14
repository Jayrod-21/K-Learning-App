# Fix Report — Mobile hardening (BLOCKER + SHOULD-FIX close-out)

**Branch:** `feat/mobile-hardening` (based off `9a9389f`)
**Scope:** the 1 BLOCKER in `REVIEW_mobile-today-vocab.md`, the two live-bug SHOULD-FIXes in `REVIEW_mobile-touch.md` (`MockMode` focus-thrash, `UploadViewer` swipe), and the SF-1 comment requested by `REVIEW_mobile-capstone.md`.
**Not touched (explicitly out of scope):** the ref-counted scroll lock, the axis-gated swipe `preventDefault` in `SwipeCarousel.tsx`, the Today carousels/peek slider, the `SkillsCompare` fix, and the My-Lists kind filter's existing shape — all praised by the reviewers, none of it undone.
**Server code:** **not changed.** `GET /vocab/lists?kind=` was already implemented and tested server-side (`server/src/routes/vocabLists.ts:117-124,163`, same route family `services/hanja.ts`'s `fetchHanjaLists` already used) — this fix-pass only wires the client to use it everywhere on the Vocab page, plus two unrelated client-only bugs.

## Findings and disposition

| # | Finding | Source review | Disposition | Files |
|---|---|---|---|---|
| 1 | BLOCKER — `AddToListSheet` on `/review/vocab` fetched `listLists()` with no kind filter, showing grammar/mixed lists as add-to-list targets | `REVIEW_mobile-today-vocab.md` | **FIXED** | `client/src/pages/review/ReviewVocab.tsx`, `.test.tsx` |
| 2 | S-1 — `listLists()` never passed the server's existing `?kind=` filter; client-side-only filtering risks silent truncation past the route's `limit:20` | `REVIEW_mobile-today-vocab.md` | **FIXED** | `client/src/services/vocab.ts`, `.test.ts`, `client/src/components/MyVocabLists.tsx`, `.test.tsx` |
| 3 | SHOULD-FIX — `UploadViewer.tsx`'s hand-rolled swipe never got `SwipeCarousel`'s `preventDefault`/`touch-action`/`overscroll-behavior-x` treatment | `REVIEW_mobile-touch.md` | **FIXED** | `client/src/pages/UploadViewer.tsx`, `.css`, `.test.tsx` |
| 4 | SHOULD-FIX — `MockMode.tsx`'s `ExamRunner` passed an unmemoized inline `onClose` to `useModalA11y`, thrashing focus every countdown tick while the submit-confirm dialog is open | `REVIEW_mobile-touch.md` | **FIXED** | `client/src/pages/topik/MockMode.tsx`, `.test.tsx` |
| 5 | Minor — one-line comment on `useModalA11y`'s body-scroller invariant | `REVIEW_mobile-capstone.md` SF-1 | **FIXED** | `client/src/hooks/useModalA11y.ts` |
| 6 | Test-coverage gap — add a `<StrictMode>`-wrapped overlapping-modal test | `REVIEW_mobile-touch.md` SHOULD-FIX #3 | **DEFERRED** (follow-up ticket; not touched, not in a file this pass edited) | — |
| 7 | NIT — `Images.tsx`/`Uploads.tsx` pass inline `onClose` to `useModalA11y` consumers (currently inert, no co-located re-render trigger) | `REVIEW_mobile-touch.md` | **DEFERRED** (follow-up; harden for consistency, not urgent — no active bug today) | — |
| 8 | NIT — `.km-today` lacks the `overflow-x:hidden` belt-and-suspenders backstop `.km-review`/`.km-progress` document | `REVIEW_mobile-today-vocab.md` S-2 | **DEFERRED** (cosmetic consistency nit, not a live bug — `.km-shell__scroll` already backstops it; not in a file this pass touched) | — |
| 9 | NIT — duplicate "Suggested learning" accessible-name announcement | `REVIEW_mobile-today-vocab.md` N-1 | **DEFERRED** (cosmetic, common pattern) | — |
| 10 | NEW (discovered during this pass, out of the reviewers' named scope) — `/learn/vocab`'s `Review.tsx` `LandingView` has its OWN "My lists" section (`Review.tsx:768-836`) rendering `vocabService.listLists()` verbatim, same unfiltered leak class, on a **different route** than `/review/vocab` | none (found independently) | **DEFERRED — flagged as a follow-up**, see below | — |

**Blocker count after this pass: 0.**

---

## 1–2. The grammar leak — BOTH surfaces on `/review/vocab` now closed, server-side

**Root cause (restated):** `MyVocabLists`'s "My Lists" tile was fixed in the prior batch (`visibleLists` client-side filter), but `ReviewVocab.tsx`'s own `AddToListSheet` — the "Add to a list" picker opened from any Browse row's "List" button — independently called `vocabService.listLists()` with zero kind filtering and rendered every kind the server returned as a pick target.

**Fix — server-side, per S-1's preference, in one move:**

- `services/vocab.ts`'s `listLists()` now accepts an optional `{ kind?: VocabListKind }` and sends it as `?kind=` (mirrors the existing `services/hanja.ts`'s `fetchHanjaLists` pattern for the same route). Omitting it (every pre-existing caller: `Review.tsx:479`, the vocab.test.ts suite) is unchanged behavior — every kind, exactly as before.
- `MyVocabLists.tsx`: derives `serverKind = kinds.length === 1 ? kinds[0] : undefined` **outside** `load`'s `useCallback`, as a primitive (not the `kinds` array itself), and passes it to `listLists()`. This is deliberate: `kinds` is typically a fresh array literal from the caller every render (`ReviewVocab.tsx`'s `kinds={['vocab']}`), so putting the *array* in `load`'s deps would churn `load`'s identity every render and, via the mount effect (`useEffect(() => { load(); }, [load])`), refire the network fetch every render. `serverKind` is a plain string/undefined, so `load` stays exactly as stable as before. The existing `visibleLists` client-side filter is kept as defense-in-depth (still does real work for the multi-kind `ALL_KINDS` default, and backstops a server/proxy that ever ignored the param).
- `ReviewVocab.tsx`'s `AddToListSheet` now calls `vocabService.listLists({ kind: 'vocab' })` and additionally filters the response to `kind === 'vocab'` client-side before `setLists` — belt-and-suspenders, matching `MyVocabLists`'s own pattern.

**Confirmation grammar is unreachable via BOTH surfaces:**
- `MyVocabLists.test.tsx`'s existing mixed-kind test now additionally asserts `vocabSvc.listLists` was called with `{ kind: 'vocab' }` (server-side narrowing, not just post-fetch filtering).
- `ReviewVocab.test.tsx` gained a new test, `'never offers a grammar-kind list as an add-to-list pick target, even when the server returns a mixed-kind response...'` — opens `AddToListSheet` via the real "Add … to a list" button, mocks a mixed vocab+grammar `listLists()` response, and asserts the grammar row (`중급 문법`/`Intermediate grammar`) never renders as a `<Button>` pick target while the vocab row (`병원 어휘`) does, AND that `listLists` was called with `{ kind: 'vocab' }`.
- `services/vocab.test.ts` gained a direct unit test on `listLists()` proving the query-string shape: `{ kind: 'vocab' }` → `params: { kind: 'vocab' }`; no args → `params: {}` (kind omitted entirely, not sent as `undefined`).

Both new tests pass. **Grammar is now unreachable via My Lists AND AddToListSheet on `/review/vocab`.**

---

## 3. `UploadViewer.tsx` swipe — same fix `SwipeCarousel` got

**Root cause:** `UploadViewer.tsx`'s hand-rolled page-turn pointer handler claimed (in its own module doc) to reuse `SwipeCarousel`'s exact Pointer Events model, but never got the `preventDefault`/`overscroll-behavior-x` half of that model — only `touch-action` (toggled `pan-y`/`auto` by zoom) existed.

**Fix:**
- `onPagePointerMove` now calls `if (e.cancelable) e.preventDefault();` immediately after the axis locks horizontal (`d.axis !== 'h'` guard), on every 'h' move — same placement, same `cancelable` guard, same reasoning as `SwipeCarousel.tsx`'s `onPointerMove`.
- `.km-upload-viewer__page` (`UploadViewer.css`) gained `overscroll-behavior-x: contain`, safe under both `touchAction` regimes the component toggles (`pan-y` at fit-width, `auto` while zoomed — contain only affects overscroll, not the pan/scroll itself).
- The existing `touchAction: swipeEligible ? 'pan-y' : 'auto'` zoom-aware toggle was **preserved untouched**, per instructions.
- Vertical scroll is preserved exactly as before: the vertical-surrender branch (`endSwipe(); return;`) still runs before the new `preventDefault` call is ever reached, so a vertical-dominant drag is never vetoed.

**Tests added** in `UploadViewer.test.tsx` (mirroring `SwipeCarousel.test.tsx`'s own two proof tests): `'calls preventDefault on every move once the axis locks horizontal, not before'` (undecided move → not prevented; the locking move → prevented on that same move; a subsequent 'h' move → still prevented) and `'leaves a vertical-dominant touch drag alone, preserving native scroll (no preventDefault)'`. Both pass, using the `dispatchEvent` return-value contract (`true` = not prevented) the same way the SwipeCarousel suite does.

---

## 4. `MockMode.tsx` focus-thrash — memoized

**Root cause:** `ExamRunner`'s `confirmRef`/`useModalA11y` call passed `onClose: () => { setConfirming(false); }` as a fresh arrow every render; the 1s exam countdown (`setRemaining`, `MockMode.tsx`) re-renders `ExamRunner` every tick — including while the submit-confirm `alertdialog` is open — retriggering the hook's `[open, onClose]` effect every second and thrashing focus in/out of the dialog.

**Fix:** wrapped it in `const closeConfirm = useCallback(() => { setConfirming(false); }, []);`, passed as `onClose: closeConfirm` — matching the documented `Tickets.tsx`/`MyVocabLists.tsx` pattern.

**Confirmation the dialog still opens/closes/works correctly:**
- The existing end-to-end test (`'answers items, submits with confirm, and shows results with reveals'`) still opens the dialog via the real "Submit test" button and submits via its "제출 · Submit" button — unchanged, passes.
- New regression test, `'does not thrash focus while the countdown ticks with the submit-confirm dialog open'`: opens the dialog with fake timers running, spies on `HTMLElement.prototype.focus`, advances the faked 1s interval four times while the dialog stays open, and asserts **zero** additional `.focus()` calls and that the dialog is still the same, still-open element afterward. This directly proves the effect no longer re-runs from ticking alone (under the old unmemoized `onClose`, each tick would queue a `previouslyActive.focus()` microtask via the hook's cleanup — this test would have caught that). Pass.
- The "Keep going" cancel button's `onClick={() => setConfirming(false)}` is a separate, pre-existing handler (not routed through the memoized `closeConfirm`) and was not touched — Esc-to-close routes through `useModalA11y`'s own `onKey` handler calling the hook's `onClose` prop (now `closeConfirm`), unaffected in behavior, just stable in identity.

---

## 5. `useModalA11y.ts` SF-1 comment

Added a doc comment on `acquireScrollLock` (not a behavior change) stating the lock's correctness depends on `document.body` remaining the real document scroller — true today because the shell uses a `min-height` chain, not a fixed height — and that a future ancestor gaining a fixed/`100dvh` height would silently break the lock with no test able to catch it. Matches the capstone review's SF-1 request verbatim.

---

## Deferred / follow-ups (not in this pass's file set, or genuinely lower priority)

- **`REVIEW_mobile-touch.md` SHOULD-FIX #3** (StrictMode-wrapped overlapping-modal test for `useModalA11y`) — a real coverage gap, but adding it means writing a new test scenario in `useModalA11y.test.tsx`, a file this pass didn't otherwise touch; filing as a follow-up rather than expanding scope.
- **`Images.tsx`/`Uploads.tsx` inline `onClose` NITs** — currently inert (no co-located re-render trigger in either file), same shape as the `MockMode` bug this pass just fixed. Cheap to harden but not a live bug today; follow-up.
- **`.km-today` `overflow-x:hidden` consistency NIT (S-2)** and the **duplicate "Suggested learning" landmark name NIT (N-1)** — both cosmetic, neither in a file this pass edited; deferred per instructions ("only if trivial + in a file you're already editing").
- **NEW discovery, flagging explicitly: `/learn/vocab` (`Review.tsx`'s `LandingView`, lines ~768-836) has its own independent "My lists" render, `lists={lists.data}` sourced from `vocabService.listLists()` with no kind filter at all** — the same bug class as the BLOCKER this pass fixed, but on a *different route* than the one any of the three reviews scoped to (`/review/vocab`). The `MyVocabLists.tsx` header comment's claim that "`/learn/vocab` links here instead of rendering its own copy" is **stale** — `Review.tsx` still renders its own list UI. This was NOT fixed in this pass: it's a different file/page than the named BLOCKER's scope, and touching `Review.tsx`'s `LandingView` deserves its own reviewed pass rather than a scope-creep edit here. **Recommend a dedicated follow-up ticket** (same fix shape: either scope `Review.tsx`'s `listsRealFn` to `vocabService.listLists({ kind: 'vocab' })`+client filter, or confirm/restore the dedup the doc comment claims already happened).

---

## Gate results (from `client/`)

- `npm run lint` — **0 errors, 0 warnings**
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — **0 errors**
- `npx vitest run` — **115 test files passed (115), 1777 tests passed (1777)**
- `npx vite build --outDir /tmp/km-fix-mh` — **exit 0**

**Server:** no server files were changed. `GET /vocab/lists` already accepted and applied `?kind=` server-side before this pass (`server/src/routes/vocabLists.ts:117-124,163`) — confirmed by reading the route, not assumed. No server suite re-run needed for this change set.

---

## Addendum — 4th surface closed (`/learn/vocab` Flashcards landing)

Follow-up to finding #10 above: rather than defer it, the coordinator directed closing the 4th surface to clear the whole grammar-in-vocab class (the user has reported grammar-in-vocab 3×).

**Did `Review.tsx` have its own call or inherit the fix?** It has its **OWN** `listLists()` call — it does **not** render lists via `MyVocabLists`. `Review.tsx`'s `listsRealFn` (`Review.tsx:478-491`) fed the `'review:lists'` `useEndpointOrMock` feed, which `LandingView` (`Review.tsx:766-833`) renders as its "My lists" study-list rows. The `MyVocabLists.tsx` header comment claiming "`/learn/vocab` links here instead of rendering its own copy" was **stale** — this surface leaked independently, on a different route than the BLOCKER's `/review/vocab`.

**Fix (same shape as the other three surfaces):**
- `Review.tsx`'s `listsRealFn` now calls `vocabService.listLists({ kind: 'vocab' })` — server-side narrowing (also dodges the route's `limit:20` truncating real vocab lists behind mixed-kind rows).
- Client-side belt-and-suspenders lives in `LandingView`'s render as `const visibleLists = (lists ?? []).filter((l) => l.kind === 'vocab')`, mirroring `MyVocabLists`'s `visibleLists` exactly — used by both the empty-state check and the row `.map`, so a non-vocab row can never reach a study-list row even if the server ignored the param.

| Finding | Disposition | Files |
|---|---|---|
| 10 (now closed) — `/learn/vocab` `LandingView` rendered `listLists()` unfiltered — 4th grammar-in-vocab surface | **FIXED** | `client/src/pages/Review.tsx`, `.test.tsx` |

**Tests** (`Review.test.tsx`, all pass):
- `'narrows its own list fetch to kind:"vocab" (server-side)...'` — invokes the captured real fetch fn and asserts `vocabService.listLists` was called with `{ kind: 'vocab' }`.
- `'never renders a grammar-kind list as a study-list row, even if the feed carries one'` — feeds the landing a mixed vocab+grammar response and asserts the grammar row (`중급 문법`/`Intermediate grammar`) never renders while the vocab row (`병원 어휘`) does.
- `'shows the empty-lists card when the only lists are non-vocab kinds'` — a grammar-only feed reads as "No lists yet." (the empty check keys off the filtered list), never a grammar row.

**Server:** still no server changes — `?kind=` was already server-side.

## Gate results — addendum re-run (from `client/`)

- `npm run lint` — **0 errors, 0 warnings**
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — **0 errors**
- `npx vitest run` — **115 test files passed (115), 1780 tests passed (1780)** (+3 new)
- `npx vite build --outDir /tmp/km-fix-mh2` — **exit 0**

**All four vocab-list surfaces are now vocab-only: `MyVocabLists` (My Lists tile), `ReviewVocab` `AddToListSheet` (add-to-list picker) on `/review/vocab`, and `Review.tsx` `LandingView` (My lists) on `/learn/vocab`. The grammar-in-vocab class is closed.**
