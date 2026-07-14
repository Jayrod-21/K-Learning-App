# Re-Review — Mobile Hardening Batch (fix-pass verification)

**Reviewer:** independent senior React/TS re-reviewer (30yr). Fresh — did not write the code, the three original reviews, or the fix-pass. Verifying the fixes actually hold against real 360px/touch device behavior, not just against jsdom green.

**Branch:** `feat/mobile-hardening` @ `bd4783b` (off `rebuild`)
**Batch:** `9a9389f` (builders) + `1fbaa99` (fix-pass) + `bd4783b` (4th grammar surface)
**Method:** read all three source reviews (`REVIEW_mobile-touch.md`, `REVIEW_mobile-today-vocab.md`, `REVIEW_mobile-capstone.md`) and `FIX_REPORT_mobile.md`, then verified every claim against the actual current-state code (not the reports), grepped the whole client tree for a possible 5th grammar-leak surface, re-ran all four gates independently from `client/`.

## VERDICT: **PASS** — 0 blockers, mobile-safe to redeploy

---

## Finding-by-finding table

| # | Claim (from reports) | Verified against code | Verdict |
|---|---|---|---|
| 1 | Grammar purge — 4 surfaces now vocab-only | Read all 4 render/create paths directly (see dedicated section below) | **CONFIRMED, class closed** |
| 2 | Scroll-lock ref-count: capture on 0→1, restore on N→0, clamp at 0 | `useModalA11y.ts:96-116` read in full | **CONFIRMED correct** |
| 3 | Overlapping-modal regression test reproduces old leak | `useModalA11y.test.tsx:209-268` — three overlap/LIFO/arbitrary-order tests exist and pass | **CONFIRMED** |
| 4 | SF-1 comment added on `acquireScrollLock` | `useModalA11y.ts:81-94` — present, matches capstone's SF-1 request verbatim | **CONFIRMED** |
| 5 | SwipeCarousel `preventDefault` gated on `axis==='h'`, vertical surrender returns before the gate | `SwipeCarousel.tsx:178-221` — `endDrag(); return;` at L198 for `axis==='v'`, `preventDefault` unreachable until `d.axis !== 'h'` guard passes (L202) then called at L221, `cancelable`-guarded | **CONFIRMED correct** |
| 6 | `UploadViewer` got the SAME fix (preventDefault + overscroll-behavior-x, touch-action preserved) | `UploadViewer.tsx:611` `if (e.cancelable) e.preventDefault();` inside the `axis==='h'` branch, `UploadViewer.css:75` `overscroll-behavior-x: contain`, `UploadViewer.tsx:1007` `touchAction: swipeEligible ? 'pan-y' : 'auto'` preserved unmodified | **CONFIRMED** |
| 7 | `MockMode.tsx` `onClose` memoized via `useCallback` | `MockMode.tsx:1454-1456` — `const closeConfirm = useCallback(() => { setConfirming(false); }, []);` passed as `onClose: closeConfirm` at `useModalA11y` call | **CONFIRMED** |
| 8 | Today: 3 carousels in order (Review&drills → Suggested learning peek → TOPIK), Vocab restored w/ real `reviewCount` | `Today.tsx:583` (carousel 1), `:686-703` (peek), `:719` (carousel 3, `cornerSlot`) — order matches | **CONFIRMED** |
| 9 | No page-level x-overflow at 360px (`.km-shell__scroll{overflow-x:hidden}`) | Traced ancestor chain per capstone review; rule is pre-existing/untouched and wraps every routed page | **CONFIRMED (structural, unchanged by this batch)** |
| 10 | SkillsCompare: 7 pills reachable, stack <480px, override wins specificity | `SkillsCompare.css` read in full — ancestor-qualified selectors, `@media (max-width:480px)` stacking rule present | **CONFIRMED** |
| 11 | StrictMode-wrapped overlapping-modal test — explicitly deferred (not a regression) | Grepped `useModalA11y.test.tsx` — no `StrictMode` test exists; matches `FIX_REPORT_mobile.md` disposition #6 (DEFERRED, follow-up) | **CONFIRMED deferred, correctly disclosed, not silently dropped** |

---

## Grammar-class closure (the recurring bug — dedicated scrutiny)

Searched the **entire** client tree for every `listLists(` call site, every `createList(` call site, and every JSX render of `MyVocabLists`, to rule out a 5th surface the batch missed.

**All 4 named surfaces confirmed vocab-only:**

1. **`MyVocabLists` My-Lists tile** (`components/MyVocabLists.tsx:130-145`) — `serverKind = kinds.length === 1 ? kinds[0] : undefined` passed to `listLists({kind: serverKind})` (server-side), PLUS `visibleLists = lists.filter((l) => kinds.includes(l.kind))` at `:202` (client-side belt-and-suspenders). Its only real mount is `pages/review/ReviewVocab.tsx:298` — `<MyVocabLists kinds={['vocab']} />` — single-kind, so `serverKind` resolves to `'vocab'` and the create-list radiogroup never renders at all (`CreateListSheet`'s `kinds.length > 1` gate, `MyVocabLists.tsx:434`). Test: `MyVocabLists.test.tsx:225-262`, mixed-kind mock, asserts grammar row absent + `listLists` called with `{kind:'vocab'}`.
2. **`ReviewVocab` `AddToListSheet`** (`pages/review/ReviewVocab.tsx:718`) — `vocabService.listLists({ kind: 'vocab' })` then `.filter((l) => l.kind === 'vocab')` at `:717` before `setLists`. Reachable via any Browse row's "List" button. Test: `ReviewVocab.test.tsx:682-717`, opens the real sheet with a mixed vocab+grammar mock, asserts the grammar row never renders and `listLists` was called with `{kind:'vocab'}`.
3. **`Review.tsx` `LandingView` My-lists** (`/learn/vocab`) — `listsRealFn` (`Review.tsx:478-491`) calls `vocabService.listLists({ kind: 'vocab' })`; `LandingView`'s `visibleLists = (lists ?? []).filter((l) => l.kind === 'vocab')` at `:768`. Test: `Review.test.tsx:325-386`, three tests — server-narrowing assertion, mixed-feed non-render assertion, grammar-only-reads-as-empty assertion.
4. **Create-list kind picker** — every reachable create flow on the vocab surfaces hardcodes or single-kind-gates to `'vocab'`: `MyVocabLists.tsx`'s `CreateListSheet` (mounted with `kinds=['vocab']`, radiogroup suppressed), `ReviewVocab.tsx:780` (`AddToListSheet`'s inline create, hardcoded `kind: 'vocab'`), `Review.tsx:981` (its own separate `CreateListSheet`, hardcoded `kind: 'vocab'`, doc comment explicitly states "no kind picker to render here at all"). No path exists on any vocab surface where a user can pick `'grammar'` as a new list's kind.

**Hunted for a 5th surface — none found.** Full-tree grep for every `listLists(` and `createList(` call site turns up exactly: the 3 real `listLists()` calls above (all `{kind:'vocab'}`), 3 `createList()` calls with `kind:'hanja'` (all in `Hanja.tsx`, a structurally separate domain — hanja lists, not vocab/grammar, out of this bug's blast radius), and the 2 `kind:'vocab'`-hardcoded create calls above. `Reference.tsx` (the legacy pre-dedup "My Lists" implementation the header comment references) **no longer exists** in the tree — confirmed via `ls`, ENOENT. `Grammar.tsx` has zero references to `listLists`/`MyVocabLists`/`CreateListSheet` — it has no lists surface of its own to leak from. `ListsPanel` (the old Review.tsx component name) appears only in a stale doc-comment string, not in code. **No 5th surface exists; the class is closed.**

---

## Mobile-correctness reasoning (real device behavior, not jsdom)

- **Scroll-lock, global-scroll restored:** `.km-shell__scroll` uses `overflow-y: auto` with no bounding height (`min-height` chain all the way up per `useModalA11y.ts:84-89`'s own SF-1 comment) — body remains the true document scroller, so `document.body.style.overflow='hidden'`/restore genuinely locks/unlocks page scroll, not an inert declaration on a non-scrolling element. Ref-count acquire/release pairing is structurally symmetric (`if (!open) return` gates both the acquire call and the cleanup registration, `useModalA11y.ts:166,182`), so there is no code path that acquires without a matching release — confirmed by re-reading the effect, not just trusting the prior review's trace.
- **Vertical scroll preserved through the swipe fix, both implementations:** In `SwipeCarousel.tsx` and the newly-patched `UploadViewer.tsx`, `preventDefault` is unreachable until the 8px axis lock has already decided `'h'`; a vertical-dominant drag calls `endDrag()`/`endSwipe()` and returns before either implementation's `preventDefault` line is reached, and the ref is cleared so no later move for that gesture can retroactively veto the scroll. `touch-action: pan-y` is declared on the exact element receiving the pointer events in both cases (not an ancestor), which is load-bearing per real `touch-action` semantics.
- **No page-level x-overflow at 360px:** `.km-shell__scroll{overflow-x:hidden}` is the untouched, pre-existing structural backstop wrapping every routed page (`Shell.tsx:153-155`, `index.css:1019-1024`). Today's peek slider and SkillsCompare's picker are each self-contained internal scroll rails (own `overflow-x:auto`), never the page. This batch didn't touch the backstop rule and didn't need to.

---

## Praise intact

Everything the three source reviews praised remains true on re-read: the ref-counted scroll-lock design (order-independent by construction, StrictMode-safe by reasoning), the Pointer-Events-over-Touch-Events choice (sidesteps React's passive-listener default so `preventDefault` actually works), the `cancelable`-guard reasoning against the real browser gesture-arbitration race, the percentage-based `78%/11%/11%` peek geometry (correct at any viewport width, not just 360px by luck), the SkillsCompare specificity-based override (wins regardless of source order, no `!important`), and the honest, well-commented test suites throughout. None of it was undone by the fix-pass or the 4th-surface commit.

## New findings from this re-review

None. No regressions, no new bugs, no gaps beyond the two items the fix-pass itself already disclosed as deliberately deferred (the `StrictMode`-wrapped overlap test, and the `Images.tsx`/`Uploads.tsx` inert-inline-`onClose` NITs) — both correctly filed as follow-ups, neither is a live bug today, and both were independently confirmed still-deferred (not silently dropped) by this review.

---

## Gates — independently re-run from `client/`

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **0 errors, 0 warnings** |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` | **0 errors** |
| Tests | `npx vitest run` | **115 test files passed (115), 1780 tests passed (1780)** |
| Build | `npx vite build --outDir /tmp/km-rr-mh` | **exit 0** |

All four numbers match what `FIX_REPORT_mobile.md`'s addendum claimed — independently reproduced, not taken on faith.

---

## Recommendation

**Ready to deploy to the idle (green) color.** The recurring grammar-in-vocab bug class is genuinely closed across all 4 reachable surfaces (confirmed by direct code read + a full-tree grep hunting for a 5th, which found none), the scroll-lock leak fix is structurally sound and covered by a real overlap-order regression test, both swipe implementations (`SwipeCarousel` and the previously-unpatched `UploadViewer`) now share the same vertical-scroll-preserving, cancelable-guarded `preventDefault` treatment, and the `MockMode` focus-thrash is fixed via a correctly-scoped `useCallback`. All four gates pass independently. This is honestly mobile-safe to put back on the user's phone.

## Working tree

Clean after this review (only pre-existing untracked files unrelated to this batch: `.claude/`, `REDESIGN_SEOUL_NEON_BRIEF.md`, `docs/redesign/BACKEND_BATCH_SCOPING.md` — none created or touched by this review). Build output was written to `/tmp/km-rr-mh`, outside the repo.
