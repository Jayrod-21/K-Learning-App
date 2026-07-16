# Review

**Branch:** `feat/batch-vocab-depth` @ `d5e84ba` (base `rebuild`)
**Scope:** client-side of F-091 (typed list-entry removal), F-112 (example sentences on list rows), F-113 (due-only list study + bulk seed)
**Reviewer:** independent, read-only (no code modified)

## Summary verdict

**PASS with SHOULD-FIX items.** No blockers. The F-091 keying/deletion fix is genuinely correct on inspection (composite `(item_type, entry_id)` keys and filters, not just entry_id) and the F-113 study rewrite genuinely replaces the bank-then-review-all path with a due-only fetch (`useListDue` → `GET /vocab/lists/:id/cards/due`) — the old path is cleanly removed, not left dead. All 152 tests in the touched files pass; `tsc --noEmit` is clean. The rewritten/new tests assert real, non-tautological behavior and would fail if the code reverted (verified by tracing the assertions against the actual implementation, not just reading them).

The two real gaps: (1) `MyVocabLists.tsx`'s per-row in-flight "removing" disable check still keys off `entry_id` alone, so in the exact vocab/grammar-same-id collision scenario F-091 exists to handle, removing one row will spuriously disable its unrelated sibling's remove button for the duration of the request; (2) no test actually constructs two rows sharing an `entry_id` with different `item_type` to prove the collision is resolved end-to-end (render distinctly + delete independently) — the fix is correct by code inspection, but its exact motivating scenario is untested.

## Findings

### BLOCKER
None.

### SHOULD-FIX

1. **`MyVocabLists.tsx:496,724` — in-flight remove-disable doesn't account for `item_type`, reintroducing the F-091 collision as a UI glitch.** `removingId` is a bare `number | null` (`useState<number | null>(null)`, line 496), and the per-row `disabled` check is `disabled={removingId === e.entry_id}` (line 724) — it does not also compare `item_type`. In the scenario this feature exists to fix (a vocab row and a grammar row in the same list sharing a numeric `entry_id`), clicking "Remove" on one row sets `removingId` to that shared id, which then ALSO disables the *other* row's remove button until the request settles — even though they are unrelated targets. Deletion targeting itself is correct (the pair is threaded through to `removeEntry`/`removeListEntry` correctly), so no data is corrupted, but the UI incorrectly freezes an unrelated control. `Review.tsx`'s `ListDetailView` sidesteps this by deliberately disabling *all* rows during any in-flight removal (documented rationale at Review.tsx:900-904), which is consistent; `MyVocabLists.tsx`'s sheet instead does a *targeted* per-row disable that silently assumes `entry_id` is unique, which F-091 explicitly established is no longer true. Fix: either track `removingId` as `{ entryId: number; itemType: ListEntryItemType } | null` and compare both fields, or adopt the same "disable everything while any removal is in flight" convention as `Review.tsx` for consistency.

2. **No test constructs the actual F-091 collision (two rows, same `entry_id`, different `item_type`, in one list).** Every new/updated test (`MyVocabLists.test.tsx:463-513`, `Review.test.tsx:634-321`, `ReviewVocab.test.tsx:1004`) exercises either (a) a single row with an explicit `item_type`, or (b) the `?? 'vocab'` default-fallback path. None renders a fixture with two entries sharing an `entry_id` under different `item_type` values to assert they get distinct React keys, render independently, and that removing one leaves the other alone (the literal bug in the ticket description). The implementation is correct by inspection (verified above), but nothing in the suite would catch a future regression that flattens the key back to `entry:${entry_id}` alone or drops the `item_type` from the filter predicate. Worth adding one test per surface (`MyVocabLists`, `Review`'s `ListDetailView`) with a two-row, colliding-id, mixed-type fixture.

### NIT

3. **`seedStatus`/B-013-style status text is plain English only, no `Bilingual`.** `ListDetailView`'s new "Add all to review" result banner (`Review.tsx:1489-1497`, `text: "Added N cards…" / "Every word here is already in review."`) isn't run through `<Bilingual>` the way every other user-facing string on this page is. Not a regression — the *landing*'s pre-existing B-013 seed-status banner (`Review.tsx:992-1000`) has the same limitation, so this is consistent with, not a deviation from, existing convention. Flagging only because it's new surface area that could be fixed at the same time cheaply.

4. **F-112 example-sentence blocks render Korean text without `lang="ko"`.** `<span className="kr">{e.example_korean}</span>` (`MyVocabLists.tsx:734`, `Review.tsx:1555`) doesn't carry a `lang` attribute the way `Bilingual`'s Korean segments do (`Bilingual.tsx:70`). Again, this matches an existing sibling pattern already in `Review.tsx` (the flashcard's own example rendering, line ~2015, pre-dates this diff) — not a new inconsistency, just an existing app-wide gap this diff perpetuates rather than introduces.

### PRAISE

5. **`useListDue` (`Review.tsx:426-492`) is a faithful, disciplined mirror of the existing `useListDetail` tagged-state pattern** (`forId`/`settled` derivation, abort-on-cleanup, `ApiError`/`code === 'canceled'` swallow, `refetch` via tick bump) rather than a bespoke one-off. Loading/empty/error are all handled explicitly; nothing is swallowed silently.

6. **The bank-then-review removal is clean.** `StudyCardWire` narrows from a 3-variant union to 2 (`due`/`local`) with the `entry` variant and its `entryToStudyCard` helper deleted outright — no dead code, no orphaned `bankEntry` call left behind in `Review.tsx`. Confirmed `bankEntry` itself is still correctly exported and used elsewhere (`WeeklySuggestions.tsx:108`, unrelated single-word "add to review" flow), so its service-level test/mock removal from `Review.test.tsx`'s `vi.mock` block was the right call, not a regression.

7. **`removeEntry`'s optimistic filter genuinely composite-keys** in both surfaces: `MyVocabLists.tsx:557-561` and `Review.tsx:788-791` both filter on `!(e.entry_id === entryId && (e.item_type ?? 'vocab') === itemType)` — i.e., removing one row cannot drop an unrelated sibling row that happens to share a numeric id, which is the actual bug the ticket names. Traced end-to-end (React key → onClick → optimistic filter → service call → `?type=` query param → server route) and it is consistent all the way through.

8. **The F-113 due-only rewrite is genuinely due-scoped, not just cosmetically renamed.** `StudySession`'s `persist()` (`Review.tsx:965-993`) now has a single code path (`submitReview(wire.snapshot.id, buildReviewSubmission(...))`) for every real card, whether from the global due queue or from `useListDue`; the old branch that called `bankEntry` unconditionally for every list entry is gone. The rewritten test at `Review.test.tsx:872-891` would fail against the old behavior — it now expects `submitReview` called directly with `expected_version: 1` (the due-card's own version) and does NOT expect a `bankEntry` call at all; reverting to the old code would either not compile (mock signature mismatch) or fail the assertion. The new empty-due-state test (`Review.test.tsx:495-514`) and the "disables Add all to review for a list with no studyable words" test (`Review.test.tsx:422-437`) both exercise genuinely distinct states, not tautologies.

## Detailed findings (file:line)

- `client/src/components/MyVocabLists.tsx:496` — `removingId` state is `number | null`, not paired with `item_type`.
- `client/src/components/MyVocabLists.tsx:724` — `disabled={removingId === e.entry_id}` ignores `item_type`; see SHOULD-FIX #1.
- `client/src/components/MyVocabLists.tsx:557-561,563,702-710,721-722` — F-091 composite key/filter/delete-call chain; correct.
- `client/src/pages/Review.tsx:788-791,798,912-918,934` — F-091 composite key/filter/delete-call chain in `ListDetailView`; correct, and (unlike MyVocabLists) the in-flight disable is `disabled={removingId !== null}` (all rows), which is documented and doesn't have MyVocabLists' bug.
- `client/src/services/vocab.ts:1121-1142` — `removeListEntry(id, entryId, itemType = 'vocab')` → `api.delete(..., { params: { type: itemType } })`; default preserves pre-F-091 call sites' behavior.
- `client/src/types/domain.ts:1135-1269` — `ListEntryItemType` and the extended `VocabListEntryRow`/`AddedListEntry` shapes; well-documented, optional fields correctly modeled as `?: T | null` where the server can omit vs. explicitly null.
- `client/src/pages/Review.tsx:128,158-172(removed),591-613(removed)` — `StudyCardWire` narrowed, `entryToStudyCard` deleted; clean.
- `client/src/pages/Review.tsx:426-492` — `useListDue` hook; see PRAISE #5.
- `client/src/pages/Review.tsx:696-753` — list-study body now branches on `listDue` (loading/error/empty/session) instead of `detail`; empty-state copy correctly points at "Add all to review".
- `client/src/pages/Review.tsx:965-993` — `persist()` single-path rewrite; see PRAISE #8.
- `client/src/pages/Review.tsx:1310-1344,1468-1486` — `seedAll`/"Add all to review" button; in-flight guard is both a `seeding` check inside the callback and a `disabled={seeding || !studyable}` on the button — no double-tap risk. Error path uses `errorMessageFor` (fixed copy), never raw server prose — verified by the "surfaces a fixed-copy alert" test (`Review.test.tsx:402-420`) which explicitly asserts the alert does NOT contain the mocked server message.
- `client/src/components/MyVocabLists.test.tsx:463-513`, `client/src/pages/Review.test.tsx:634-660,728-923,495-514`, `client/src/services/vocab.test.ts:1033-1102` — new/updated tests; all traced against implementation, all real (see SHOULD-FIX #2 for the one gap: no colliding-id fixture).
- `client/src/services/vocab.ts:1151-1183` — `getListDueCards`/`seedListCards`; wire shape reuses `normalizeDueCard`/`DueCardWire`, no parallel FSRS path introduced.

## Verification performed

- Read full `git diff rebuild -- client/` (1282 lines).
- Traced F-091's key/filter/delete chain end-to-end in both `MyVocabLists.tsx` and `Review.tsx`'s `ListDetailView`, and cross-checked against the server route (`server/src/routes/vocabLists.ts:665-674`, `?type=` param) to confirm no phantom/mismatched contract.
- Ran the full touched test suite: `npx vitest run src/pages/Review.test.tsx src/components/MyVocabLists.test.tsx src/services/vocab.test.ts src/pages/review/ReviewVocab.test.tsx` → **152/152 passed**.
- Ran `npx tsc -p tsconfig.app.json --noEmit` → clean, no errors.
- Confirmed `bankEntry` is not dead code (still used by `WeeklySuggestions.tsx:108`) and its removal from `Review.tsx`/`Review.test.tsx` was scoped correctly.
