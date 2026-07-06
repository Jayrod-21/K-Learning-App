# Review

**Scope:** `client/src/pages/Review.tsx` + `client/src/pages/Review.test.tsx` (`git diff HEAD~1`), branch `fix/fup008-krdict-drawer`.
**Change:** `SessionPanel` now lazily fetches KRDICT example sentences via `defineEntry(card.kr, signal)` when the "More examples" drawer opens, replacing the dead `card.extra` (always `[]`) render. F-UP-008.

## Verdict

**APPROVE.** The hooks logic is correct: unconditional (declared before every early return), no rules-of-hooks violation, no infinite loop, no double-fetch, no setState-after-unmount. The `[drawer, cardKr]` effect fetches exactly on drawer-open (and on reopen of the same card, by design), aborts cleanly on close/card-change/unmount, and — critically — `rate()` (`Review.tsx:552`) and `onStartNewSession` (`Review.tsx:738`) both call `setDrawer(false)` in the same state-update batch as the index advance, so the drawer is *never* open across a card transition in practice. There is no window where card N's examples render under card N+1. Tests: 20/20 in `Review.test.tsx`, 595/595 across the full client suite.

One SHOULD-FIX (dead `extra` field cleanup) and one NIT (test coverage gap for abort/reopen/refetch scenarios) below; neither blocks.

## Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | SHOULD-FIX | `Vocab.extra` (`types/domain.ts:82`), `dueCardToVocab`/`vocabEntryToVocab`'s `extra: []` (`Review.tsx:250,265`), and the hand-authored `extra` arrays in `data/mocks/review.ts` (`VOCAB_FIXTURE`, e.g. lines 22, 36, 50, 64, 78, 89, 102) are now fully dead — nothing reads `card.extra` anymore. The mock fixture is the more concerning half: it still hardcodes plausible-looking example sentences that silently never render, which reads as "this is wired up" to the next person who touches it. Remove the field (type, both mappers, both fixture files) in this PR or a fast follow. |
| 2 | NIT | The new test proves laziness (`defineEntry` not called pre-open) and the happy-path render + call args, but doesn't cover: abort-on-close, refetch-on-reopen, or the no-stale-examples-on-card-change guarantee. Those are correct by inspection (see Detailed §1), and are implicitly protected by `rate()`'s `setDrawer(false)`, but a regression in that pairing (e.g. someone removing `setDrawer(false)` from `rate()` in a future refactor) wouldn't be caught by this test file. Consider one test that opens the drawer, advances via a rating, and asserts the drawer/effect don't fire `defineEntry` for the new card while still "open." |
| 3 | NIT (judgment call, not a defect) | The "More examples" button is unconditionally rendered (`Review.tsx:1037`), so for a word KRDICT lacks (or a grammar-pattern `kr`), opening it always costs one network round-trip just to learn there's nothing. This is an acceptable resolution given the fetch is lazy (never paid unless the user opens it) and the alternative — prefetching to decide visibility — reintroduces the "load examples for every card" cost this fix explicitly avoids (see the comment at `Review.tsx:889-893`). No action needed. |
| 4 | PRAISE | The abort/error handling exactly mirrors the established codebase pattern in `lib/tapChain.ts::resolveWordPopover` (swallow `defineEntry` failures, including cancellation, and degrade) — consistent with precedent, not a one-off shortcut. |
| 5 | PRAISE | Correctly double-guards the cancellation path: both `ctrl.signal.aborted` (defensive against a resolved promise racing an abort) and `err instanceof ApiError && err.code === 'canceled'` (the actual shape `services/api.ts` normalises `ERR_CANCELED` into) are checked before the catch's `setKrdictExamples([])`/`setExamplesLoading(false)` fallback — so an aborted request never flashes "No additional examples." over a request that's actually still in flight for a newer card/reopen. |

## Detailed

### 1. Hooks correctness & the drawer/card-change race

`Review.tsx:894-925`. The new `useState`/`useState`/`useEffect` sit immediately after the prop destructure (`Review.tsx:867-887`) and *before* every early return (`loading` at 927, `fetchErrored` at 928, `bankEmpty || !card` at 947) — hooks are unconditional, called every render. Rules-of-hooks holds.

`cardKr = card?.kr ?? null` (line 894) is computed before the `bankEmpty || !card` return, so on a render with no card (`card` is `null`), `cardKr` is `null` and the effect's `if (!drawer || cardKr === null) return;` guard skips the fetch — no crash, no fetch, correct even though the component hasn't hit its "no card" return yet at hook-evaluation time.

Effect dependency `[drawer, cardKr]` (both primitives, compared by value — no unstable-reference re-fire risk):
- **Mount / drawer closed:** guard returns early, no ctrl created, no cleanup registered. No fetch while closed. ✓
- **Drawer opens (same card):** effect re-runs, previous effect (which registered no cleanup) needs none; new ctrl created, `examplesLoading(true)` + `krdictExamples(null)` set synchronously before the async call (no flash of a stale prior result), `defineEntry(cardKr, ctrl.signal)` fires. ✓ fetches exactly on open.
- **Drawer closes:** React runs the previous effect's cleanup (`ctrl.abort()`) before evaluating the new effect body, which then returns early (drawer false) with no new ctrl. Exactly one abort, no new fetch. ✓
- **Card changes while drawer somehow stays true:** cleanup aborts the old ctrl, new effect fires for the new `cardKr`. In this codebase that path is actually unreachable in the UI (see below) but the effect is still correct if it ever becomes reachable — good defense-in-depth.
- **Unmount:** cleanup aborts; `.then`/`.catch` both check `ctrl.signal.aborted` before any `setState`, so no setState-after-unmount warning/leak.
- **Reopen same card after a completed fetch:** by design, refetches (spec explicitly calls this acceptable). Correctly clears `krdictExamples` to `null` first so there's no stale flash of the previous result while awaiting.

**Why stale-card examples can never actually show:** `rate()` (`Review.tsx:539-596`) sets `setFlipped(false)`, `setDrawer(false)`, and `setIdx((i) => i + 1)` together at lines 551-553 — all in the same event handler, batched into one commit. `onStartNewSession` (`Review.tsx:732-742`) does the same (`setIdx(0)` + `setDrawer(false)`). Every code path that changes `idx`/`card` also closes the drawer in the same update. So `cardKr` never changes while `drawer` is `true` in practice — the drawer is always closed before or exactly when the card underneath it changes, eliminating the "card N's examples under card N+1" failure mode by construction, not by luck.

### 2. Abort plumbing

`services/define.ts::defineEntry` forwards `signal` to axios (`api.get(..., { signal })`); `services/api.ts::normaliseError` (lines 118-135) discriminates `ERR_CANCELED` into `ApiError({ code: 'canceled' })` distinctly from `timeout`/`network`. The effect's catch handler checks for both the raw `ctrl.signal.aborted` flag and the normalised `ApiError.code === 'canceled'` — belt-and-suspenders, correctly implemented.

### 3. Non-abort failures (404 no entry, 503 `krdict_unavailable`, network error)

All fall into the same `catch` branch as an aborted request and render identically as "No additional examples." (`Review.tsx:919`, `1063-1066`). This masks a genuine backend outage (503) behind the same UI as "this word just has no examples," with no `console.error`/telemetry. This mirrors the pre-existing pattern in `lib/tapChain.ts::resolveWordPopover` for the same `defineEntry` call site, so it's consistent with codebase precedent rather than a new shortcut — flagged as informational, not a blocker.

### 4. Grammar / non-dictionary `kr` values

No special-casing needed or present: `defineEntry` on a grammar pattern or any string KRDICT doesn't recognize resolves (404-shaped) into the same catch → `krdictExamples: []` → "No additional examples." No crash path identified for any string input to `card.kr`.

### 5. Test run

```
npx vitest run src/pages/Review.test.tsx   → 1 file, 20/20 passed
npx vitest run                              → 61 files, 595/595 passed
```

The new test (`Review.test.tsx:317-350`) asserts `defineEntry` is NOT called after flip-but-before-drawer-open (proves laziness — would fail on an eager fetch), then asserts it IS called with `('영향', expect.anything())` and that both the Korean example and its English gloss render after opening (would fail on a broken render or wrong field mapping, e.g. reading `ex.kr`/`ex.en` instead of `ex.korean`/`ex.english`). Gap noted in Findings #2.
