# RE-REVIEW — vocab remove/clear fix-pass verification

Independent re-reviewer (did not write, review, or fix this code). Branch
`feat/vocab-queue-clear`, fix commit `692dfc1` (base `7b24b1c`). Verified by
reading the diff + current code, plus ONE capped targeted run (permitted
mutation check — see below). Relied on orchestrator-confirmed green for the
full suite: 2249/2249 passed, tsc 0, lint 0.

## Summary verdict

**PASS.** Both SHOULD-FIX items and the copy NIT are genuinely fixed, the new
tests are proven load-bearing by an actual mutation run (3 failed / 66 passed
with the guards reverted; file restored to pristine `692dfc1` afterward), and
no regression to the normal rate/flip flow, the failure-recovery path, or the
accessible confirm was found.

## Finding-by-finding

### SF-1 (remove-vs-rate race) — **FIXED**

All three claimed layers exist in `client/src/pages/Review.tsx`:

1. `rate()` early-returns on `card === null || removingKey !== null`
   (`Review.tsx:1989`), with `removingKey` correctly in the useCallback deps
   (`Review.tsx:2001`). This is the layer that actually closes the index-shift
   skip and the concurrent `submitReview`.
2. `flip()` early-returns on `removingKey !== null` (`Review.tsx:1893`, deps
   at 1896). This single guard covers BOTH entry points: tap-flip
   (`onFlip={flip}` on the Flashcard, `Review.tsx:2131`) and spacebar (the
   window keydown handler calls `flip()`, `Review.tsx:1909`). No other flip
   path exists (`setFlipped` is otherwise called only by rate/remove-success/
   restart, all safe).
3. Rating buttons `disabled={removingKey !== null}` (`Review.tsx:2277`),
   correctly framed in the comment (2265-2267) as the visible pending state,
   not the primary fix. The remove button itself was already disabled +
   "Removing…" (`Review.tsx:2306-2310`).

**Guard clears on failure — no permanent lock.** `removeCurrent`'s
`finally { setRemovingKey(null); }` (`Review.tsx:2031-2033`) runs on both
resolve and reject; the catch sets the honest error copy first (2023-2030).
Notably, the SF-2 test doubles as behavioral proof of this: it rejects the
DELETE, then successfully flips AND rates the same card — impossible if the
guard stuck after a failed remove.

**Tests are load-bearing — verified empirically, not just by reading.** I
reverted all three guard layers (plus the SF-2 line) with sed, ran the single
permitted capped command, and got **3 failed / 66 passed** — exactly the three
new tests:

- `blocks rating the card while its removal is in flight` — fails without the
  guard (the disabled assertion and the no-skip deck arithmetic both bite).
  With the guard, it asserts `submitReview` never called, count stays `1 / 2`
  mid-flight, and after the DELETE resolves the next card (학교) is at `1 / 1`
  with `Session complete` explicitly absent (`Review.test.tsx:1756-1791`) —
  i.e., it pins the skip-prevention outcome, not a tautology.
- `blocks the spacebar flip while the removal is in flight` — without the
  guard it failed by FINDING the FSRS rating group in the document, which
  confirms the happy-dom `fireEvent.click`/`fireEvent.keyDown(window)`
  arrangement genuinely reaches `flip()` (focus stays on `body`, so the
  interactive-element bail at `Review.tsx:1907` does not mask the guard). The
  fix-pass's concern and workaround (`Review.test.tsx:1804-1809` comment) are
  real and correctly handled.
- The SF-2 test (below).

File restored via `git checkout -- client/src/pages/Review.tsx`; `git status`
clean against `692dfc1`.

### SF-2 (stale remove-error) — **FIXED**

`rate()` now calls `setRemoveError(null)` alongside `setRateError(null)`
(`Review.tsx:1994-1998`). The other clear points (fresh remove attempt at
2016, `restart` at 2046) were already present. Test
`clears the stale remove-error once the user rates past the card (SF-2)`
(`Review.test.tsx:1830-1856`) does a failed remove → alert appears → flip +
rate → next card shown, `queryByRole('alert')` empty. Mutation run confirms it
fails (alert still present) without the fix.

### Copy NIT (server NIT-3, over-promising clear) — **FIXED**

`Review.tsx:1094-1099`: "This removes your vocab cards from review (grammar
practice cards stay) — your saved words and lists are kept, and you can add
words back to review any time." No longer promises an empty due list; the
grammar-cards-stay scope is explicit in EN and KR ("복습에서 어휘 카드만
제거돼요 (문법 연습 카드는 남아요)…"). The load-bearing "your saved words and
lists are kept" clause is byte-identical to the original, so the pre-existing
copy assertion still pins it, and the copy test was extended to also assert
the new scope phrase (`Review.test.tsx:1886-1894`). Title tightened to
"Remove all vocab cards?" (1076). The Sheet `ariaLabel` and success banner
were checked and remain accurate as-is.

## Regressions / PRAISE spot-checks

- **Normal rate/flip flow:** when no remove is in flight (`removingKey ===
  null`, the steady state) every guard is a no-op; deps arrays updated
  correctly so no stale-closure risk. The 66 pre-existing tests in the file
  passed even under mutation, and the full suite is green at 2249/2249.
- **No UI lock on remove failure:** covered above — `finally` clears the key,
  and the SF-2 test exercises flip+rate immediately after a rejected DELETE.
- **Accessible confirm intact:** the fix only touched the Sheet's title/body
  strings; the Close button is still the first focusable in the sheet body
  (`Review.tsx:1081-1088`, before Cancel/confirm at 1100-1111), so initial
  focus still lands on Close and a reflexive Enter still cancels.
  `components/Sheet.tsx` untouched by the diff.
- **FIX_REPORT accuracy:** every claim in `docs/FIX_REPORT_vocab.md` checked
  out against the code, including the "2 failed with guard reverted" claim
  (my run showed 3 failed because I also reverted the SF-2 line in the same
  mutation — consistent).

## New findings

None at SHOULD-FIX or above. Two observations, both no-action:

- **OBS-1:** During an in-flight remove, un-flipping is also blocked (the
  `flip` guard is direction-agnostic). This is the intended "frozen card"
  semantic and the success path resets `flipped` itself (`Review.tsx:2021`).
- **OBS-2:** The confirm copy mentions grammar cards even for users who have
  none. Harmless and arguably still informative; not worth a conditional.

## Recommendation

**Ship.** Fixes hold, tests are demonstrably load-bearing, no regressions
found. The deferred nits (N-1 rename, N-2 zero-due reachability, N-3
live-region timing, server NIT-1/2) remain open as documented backlog items
in the fix report — none block this branch.
