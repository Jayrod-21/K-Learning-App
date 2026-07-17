# FIX REPORT — vocab remove/clear fix-pass

Branch `feat/vocab-queue-clear`, base `7b24b1c`. Client-only scope (per orchestrator). Fix-pass agent independent of author + reviewers.

## Dispositions

### SF-1 (client review) — remove-vs-rate race → **FIXED**
Guard = existing `removingKey` state (in-flight remove marker), three layers in `client/src/pages/Review.tsx`:
1. `rate()` → early-return `if (card === null || removingKey !== null)` — closes the index-shift skip (rating can no longer advance `idx` while the DELETE is in flight) + prevents `submitReview` against a card being soft-deleted.
2. `flip()` → early-return `if (removingKey !== null)` — covers BOTH tap-flip (Flashcard `onFlip`) and spacebar (window handler calls `flip`). Card frozen while removal pending.
3. Rating buttons `disabled={removingKey !== null}` — visible pending state (remove button already showed "Removing…"). Defense-in-depth, not the primary fix.
Guard clears in the existing `finally` (`setRemovingKey(null)`) on resolve AND fail — unchanged.

Tests (Review.test.tsx, remove describe block, deferred-promise DELETE so the in-flight window is test-controlled):
- `blocks rating the card while its removal is in flight (no skipped card)` — flip → remove → rating disabled + click no-op (`submitReview` never called, still `1 / 2`) → resolve DELETE → next card `학교` slid in at `1 / 1`, NOT `Session complete`.
- `blocks the spacebar flip while the removal is in flight` — remove in flight → `keyDown(window, ' ')` → rating group never appears → resolve → next card fine. NOTE: uses `fireEvent.click` deliberately — userEvent's click focuses the remove button and the window space handler always bails on interactive-element focus (happy-dom `blur()` doesn't restore `activeElement` to body), which would mask the guard. Verified empirically.
- **Load-bearing verified**: with guard reverted (all 3 layers), both tests FAIL (2 failed / 67 passed); with guard, 69/69.

### SF-2 (client review) — stale remove-error alert → **FIXED**
`rate()` now also does `setRemoveError(null)` alongside `setRateError(null)` — moving past a card retires its card-specific "couldn't remove X" alert. Other clear points already existed: fresh remove attempt (`removeCurrent`), `restart`.
Test: `clears the stale remove-error once the user rates past the card (SF-2)` — failed remove → alert → flip+rate → alert gone, next card shown. Verified load-bearing: fails with `setRemoveError(null)` removed from `rate`.

### Copy NIT (server review NIT-3) — clear-confirm over-promises empty session → **FIXED**
`Review.tsx` confirm Sheet:
- Title: "Remove all cards?" → "Remove all vocab cards?" (KR "어휘 카드를 모두 지울까요?").
- Body EN: "This removes your vocab cards from review (grammar practice cards stay) — your saved words and lists are kept, and you can add words back to review any time." (KR updated to match: "복습에서 어휘 카드만 제거돼요 (문법 연습 카드는 남아요) — …"). Kept the words-are-kept clause verbatim-lowercase so the existing copy assertion still pins it.
- Test extended: confirm-copy test now also asserts `/vocab cards from review \(grammar practice cards stay\)/`.
Sheet `ariaLabel` ("Clear the review queue?") + success banner ("Removed N cards… Your saved words are kept.") unchanged — both accurate.

## Skipped (with reason)
- Client N-1 (`clearDueCards` misname) — rename would touch `services/vocab.ts` + its tests + mocks; not a file this pass otherwise edits, mechanical churn only. DEFERRED.
- Client N-2 (clear unreachable at 0-due) — product gap, needs a design call, out of fix-pass scope. DEFERRED.
- Client N-3 (status live-region mount timing) — real a11y behavior change (keep-mounted refactor of the landing banner), not trivial; not attempted. DEFERRED.
- Client N-4 — reviewer marked "fine as shipped". NO ACTION.
- Client N-5 (label-in-name) — codebase-wide pattern call per reviewer. DEFERRED.
- Client N-6 (tautological service tests) — harmless, matches file style per reviewer. NO ACTION.
- Server NIT-1/NIT-2 — server files, orchestrator scoped this pass CLIENT-ONLY. DEFERRED.
- PRAISE items untouched (accessible confirm w/ initial focus on Close, non-optimistic remove, soft-delete routes).

## Gates (final code)
- `npm ci` — clean, 0 vulnerabilities.
- `npm run lint` — exit 0.
- `npx tsc -p tsconfig.app.json --noEmit --incremental false` — exit 0.
- `npx vitest run` (FULL) — **128 files passed, 2249/2249 passed, 0 failed** (baseline 2246 + 3 new).
- `npx vite build --outDir /tmp/km-vc2-dist` — success (PWA precache emitted).

## Self-assessment
- SF-1 guard is belt-and-suspenders (callback guards are primary; disabled buttons are the visible pending state). Removing any single layer still leaves the invariant tested behaviorally.
- Spacebar test is the one fragile spot found + solved during the pass: happy-dom focus semantics can silently neuter window-keydown tests. Documented in the test comment.
- Copy change keeps the load-bearing "your saved words and lists are kept" phrase byte-identical; only scope wording added.
- Files changed: `client/src/pages/Review.tsx`, `client/src/pages/Review.test.tsx`, `docs/FIX_REPORT_vocab.md` (this file). No server/db files touched.
