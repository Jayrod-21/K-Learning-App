# Batch 3 — Flashcards (`Review.tsx`, `/learn/vocab`) — independent review

**Reviewer:** independent senior React/TS reviewer (did not write this code)
**Scope:** `client/src/pages/Review.{tsx,css,test.tsx}` on `feat/redesign-learn-a` @ `8eae3c8`, diffed against `rebuild`.
**Tickets:** F-128 (reskin), F-129 (mobile), F-130 (swipe — claimed deferred), F-131 (accent hover), F-156 (15 not 200), F-157 (create-list popup).

## Verdict

**CONDITIONAL PASS.** F-156 is genuinely fixed and well-tested. F-157 is genuinely a Sheet, vocab-only, with a real regression test for the batch-2 focus/char-drop bug class. F-130's deferral is technically honest (`SwipeCarousel` really has no way for a parent to observe a settled swipe) but is *undocumented in the code* and, on inspection, appears to be a self-invented scope item rather than something the ticket or the design mock actually asked for on this page. The F-128 reskin is real (not a flat token pass — it composes `PageHubHeader`, `CityCard`, `SealStamp`, `SubwayProgress`, the utility devices), but has one concrete visual-fidelity bug: the flashcard's new "neon signboard / hanji paper" gradient body is painted, then immediately hidden by a pre-existing opaque `background: var(--ink-2)` on the front/back content divs one layer inside it. One test (F-129 overflow-x) is tautological and cannot catch its own regression.

## Ticket checklist

| Ticket | Status | Evidence |
|---|---|---|
| F-156 (15 not 200) | **DONE** | `SEED_LIMIT = 15` (Review.tsx:273), only call site (Review.tsx:507-511), server max is 500 (server/src/routes/vocab.ts:368) so nothing server-side re-inflates it. Real assertion in test (Review.test.tsx:1169-1176). |
| F-157 (create-list popup) | **DONE** | `CreateListSheet` (Review.tsx:941-1054), own component, stable `useCallback` `onClose` (Review.tsx:762-764), vocab-only (`kind: 'vocab'` hardcoded, no kind picker). Real dialog + Esc-close + multi-char-type regression test (Review.test.tsx:347-387, 412-429). |
| F-130 (swipe) | **DEFERRED, honest but underscoped/undocumented** | See dedicated section below. |
| F-128 (reskin) | **MOSTLY DONE, one real bug** | PageHubHeader/CityCard/SealStamp/SubwayProgress/rain-sheen/najeon all genuinely wired in. Flashcard face gradient is occluded (see Findings). |
| F-129 (mobile) | **DONE, weak test** | `overflow-x: hidden` + tightened gutter at ≤380px (Review.css:15-23). Test is structural-only/tautological (see Findings). |
| F-131 (accent hover) | **OUT OF SCOPE for this diff, not regressed** | `styles/index.css` (shared, hardcoded `--vermilion` hover states, e.g. index.css:845/851/3544-3547) is untouched by this commit — same as before. Nothing in Review.css/tsx hardcodes a hex; `--km-tone` correctly resolves through `--vermilion`, which IS accent+theme-aware (index.css:89/214/349-394). Cross-cutting F-131 remains a shared-file fix for a later/separate pass. |

## F-156 verdict (explicit)

**The real cap is 15 cards per corpus, 30 max per click (2 corpora × 15), down from 100×2=200.**

- `SEED_LIMIT = 15` — Review.tsx:273, with a doc comment explaining the math and citing the ticket.
- The only place `vocabService.initCards` is called anywhere in the client is Review.tsx:508-511 (confirmed via repo-wide grep) — no other page/path re-seeds at a different limit.
- The server's `InitBodySchema` (server/src/routes/vocab.ts:365-368) caps `limit` at 500 with a default of 50 — the server would *accept* up to 500, so the client-side `SEED_LIMIT` is the only thing preventing 200 (or worse); nothing server-side backstops the ticket's promise.
- Review.test.tsx:1143-1178 asserts `vocabService.initCards` is called with `{ corpus: 'vocab_2000_beginner', limit: 15 }` and `{ corpus: 'vocab_2000_intermediate', limit: 15 }` via `toHaveBeenNthCalledWith` — this is a real regression test: reverting `SEED_LIMIT` to 100 (or removing it) fails this assertion, not just a UI-text assertion. Good.

## F-130 deferral verdict

**Technically honest, but likely unnecessary scope, and undocumented in the shipped code.**

- Read `client/src/components/SwipeCarousel.tsx` in full: it is genuinely uncontrolled — `rawIndex`/`dragX` are internal `useState`, there is no `onChange`/`onIndexChange` prop, and no way for a consuming page to observe a settled swipe. The claim that a parent "can't observe a swipe settling" is factually correct as the component stands today.
- However: **Review.tsx (Flashcards) does not use `SwipeCarousel` at all, before or after this diff** (`grep -rln SwipeCarousel client/src/pages/*.tsx` → only `Progress.tsx`, `Today.tsx`, `UploadViewer.tsx`). The literal ticket text for cross-cutting F-130 is "Carousels + PDF viewer — swipe gestures don't register on touch. `components/SwipeCarousel.tsx` + PDF viewer (Uploads)" — i.e., it's about *existing* SwipeCarousel/PDF consumers not registering touch, not about adding new swipe-to-advance navigation to the flashcard study session. The design mock (`km-learn.html`) also shows no swipe affordance for flashcards — study session advances via tap-to-flip + rate buttons only.
- Net: this reads as the builder inventing an in-scope-adjacent feature ("swipe to advance/rate a flashcard, Anki/Tinder-style"), attempting to reuse `SwipeCarousel` for it, discovering the componentry doesn't support it, and recording the deferral **only in the commit message** (`git log` on `8eae3c8`), not anywhere in `Review.tsx`, `Review.test.tsx`, or `BUGS_AND_FEATURES.md`. Every other non-trivial decision in this file (B-013, B-014, B-021, B-022, FU-NF-42, SF-1..SF-5) has an inline doc comment; this one doesn't, despite being the one negative/deferred outcome. That's the actual gap: not that the deferral is dishonest, but that it leaves no trace in the artifact a future maintainer or the next fixpass reviewer will read.
- **Recommendation for the fix-pass:** either (a) add a one-line doc comment near `StudySession` recording the deferral and why (mirrors the file's own convention), and open a tracked follow-up ticket number distinct from the shared/cross-cutting F-130 (since as written F-130 doesn't actually require this), or (b) if swipe-to-advance was never actually required for Flashcards, drop the "F-130 deferred" framing entirely — attaching it to F-130 as currently worded overstates what was skipped and could cause a future reviewer to mark cross-cutting F-130 falsely "blocked" on this page.

## Findings

### BLOCKER

None outright — SEED_LIMIT is fixed correctly and the char-drop-class bug is genuinely guarded by a test. The two items below are borderline (design-fidelity non-negotiable per `DESIGN_SEOUL_DAY_NIGHT.md` §8: "not a flat token reskin"), but I'm categorizing them SHOULD-FIX because the *components/markup* are correctly wired — only the paint order is wrong, which is a fixable one-line CSS issue, not a structural gap.

### SHOULD-FIX

1. **Flashcard signboard gradient/glow is invisible — occluded by a legacy opaque child background.** `Review.css:77-93` gives `.km-review .km-flashcard__face` the Night gradient body + inset glow + Day hanji-paper treatment, keyed off `--km-tone`. But `Flashcard.tsx` renders the page's `front`/`back` slot content as the *sole direct child* of that exact face element, and `client/src/styles/index.css:3463` (`.km-review__front`) and `:3482` (`.km-review__back`) both still declare `background: var(--ink-2)` — an opaque solid fill with no margin/inset relative to the face box. Since `.km-flashcard__face` carries no padding and the front/back divs fill it edge-to-edge (`min-height: 320px`, `overflow: hidden` on the face just clips corners), the child's opaque background paints directly over the parent's gradient/inset-glow, leaving only the outer `border` + non-inset `box-shadow` visible. In practice: the card reads as "flat `--ink-2` panel with a colored ring around it," not the "dark gradient body...inner+outer glow" device #1 calls for. Compare to the real `CityCard.css` recipe this was meant to mirror (`CityCard.css:12-19`, `:33-44`) — a genuine `CityCard` has no opaque-background child covering its own surface, so the same CSS recipe reads correctly there. This is page-specific legacy CSS (`.km-review__front`/`.km-review__back` are exclusive to this page, just parked in the shared file) — safe to neutralize from `Review.css` (e.g. `background: transparent` under the `.km-review` scope, the file's own established override convention) without touching any other page.
   - Cite: `client/src/pages/Review.css:77-93`; `client/src/styles/index.css:3463`, `:3482`; `client/src/components/Flashcard.tsx:82-87`.
2. **F-129 test is tautological — cannot catch its own regression.** `Review.test.tsx:1235-1244` ("F-129: the page root carries its own overflow-x guard") only asserts `document.querySelector('section.km-review')` is non-null. `vitest.config.ts` runs with `css: false` (confirmed), so no test in this suite can observe computed style at all — that's an environment constraint, fine. But this specific test doesn't even fall back to checking the stylesheet source contains the rule; it just re-confirms the element it queried by that exact class exists, which was true before F-129 too. Deleting `Review.css:15-18`'s `overflow-x: hidden` entirely would not fail this test. This is the "test can't catch its own bug" pattern the review brief calls out explicitly — recommend either a source-content assertion (read `Review.css` text, assert it contains `overflow-x`) or accept this as an intentionally-unverifiable-in-CI item and say so in the test name/comment instead of implying coverage.
   - Cite: `client/src/pages/Review.test.tsx:1235-1244`.
3. **F-130 deferral has no trace in the shipped artifact.** See F-130 section above — recommend a doc-comment note in `Review.tsx` (near `StudySession`) at minimum.

### NIT

1. **Duplicate accessible name inside the "Add to review" `CollapsibleTile`.** Both the disclosure header and the inner action `Button` render the identical bilingual string "복습에 추가 · Add to review" (Review.tsx:881, :902). This predates this batch (not a regression here), but the test itself had to work around the collision with a fragile `.find((b) => b.hasAttribute('aria-expanded'))` filter (Review.test.tsx:1152-1160, 1188-1194) rather than a semantic query — a screen-reader user tabbing by name would hit two controls that announce identically. Worth a follow-up ticket to give the inner button a more specific label (e.g. "Add 15 cards to review").
2. Good, honest documentation of the dead `.km-review__progressBar`/`__progressFill` CSS (Review.css:102-111) — confirmed genuinely dead (no JSX references it anywhere; `grep` across `client/src` turns up nothing), and correctly left alone since it lives in the shared stylesheet other pages might still reference (they don't, in this case, but the "not this ticket's file to edit" discipline is the right call). Low-priority cleanup opportunity for whoever next touches `styles/index.css`.

### PRAISE

1. **F-156's fix is exemplary traceability.** The `SEED_LIMIT` comment (Review.tsx:266-273) states the old value, the new value, the exact math, and *why* 200 was bad ("front-loading the review backlog far past a sane daily session") — this is the standard every deferral/fix in this file should be held to, which makes the undocumented F-130 deferral stand out more, not less.
2. **F-157's `CreateListSheet` split is correctly justified and cross-referenced.** The doc comment (Review.tsx:922-934) names the exact prior bug class (focus-stealing via unstable `onClose` identity), points at the sibling implementation in `MyVocabLists.tsx` for the fuller writeup, and the test suite includes a real multi-character-type regression test (Review.test.tsx:370-372) rather than a single-keystroke smoke test — this is exactly the shape of test that would have caught the original batch-2 bug.
3. **Optimistic-mutation discipline.** Entry removal (`removeEntry`, Review.tsx:1183-1216) snapshots both `entries` AND `entry_count` before rollback — a smaller, easy-to-miss correctness detail (restoring only `entries.length` would corrupt the header count for a list whose fetched page is a subset of a larger list) that's handled correctly and commented.
4. **`SubwayProgress` NaN-guard.** Not part of this diff, but worth noting since it's exercised here: `current={idx}`/`steps={deck.length}` flow through a component that explicitly guards `Number.isFinite` before `Math.floor`, so a `0/0`-shaped edge case can't produce a broken `aria-valuenow={NaN}`.

## Coordination observations (for whoever runs the fix-pass / other batches)

- `BUGS_AND_FEATURES.md`'s F-131 (accent hover) is genuinely a shared-file fix (`styles/index.css`), not something any single page-batch can close — flag it as still fully open after this batch (and after batches 1/2, per the same file being untouched there too), rather than letting it quietly fall off the list because every page batch correctly treats it as "someone else's file."
- Batch 1's `REVIEW_batch1-today.md` marked F-130 "✅ Yes (inherited)" for Today's carousels via Pointer Events; batch 2's `REVIEW_batch2-uploads.md` called the carousel half of F-130 "out of this batch's scope... should stay tracked separately until `SwipeCarousel`'s own touch behavior is (re-)verified." This batch's commit message reintroduces F-130 a third time with a third meaning (swipe-to-advance flashcards). Recommend the next aggregation pass split F-130 into its actual sub-parts (touch-registration on existing carousels — apparently already fine; PDF viewer — closed per F-155; hypothetical flashcard swipe-to-advance — never actually requested) so "F-130" stops being reused across batches for three different claims.
