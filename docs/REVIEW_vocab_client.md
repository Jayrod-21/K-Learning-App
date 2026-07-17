# Independent review — vocab review-queue remove/clear (CLIENT half)

Branch `feat/vocab-queue-clear` @ `7b24b1c`, diff `origin/rebuild...feat/vocab-queue-clear -- client/`.
Reviewer did not write this code. Verified by reading; relied on orchestrator-confirmed
green (client suite 2246/0, tsc 0, lint 0) — no test run needed, no claim was in doubt.

## Summary verdict

**PASS — no blockers.** The feature is well built: the bulk clear sits behind a real,
accessible confirmation whose copy states plainly that saved words and lists are kept;
the per-card remove is deliberately non-optimistic (deck mutates only after the DELETE
succeeds) with honest, fixed-copy error handling; the queue and session both update
correctly after remove/clear; the tests exercise real behavior including the
cancel and failure paths. Two minor SHOULD-FIX items (a narrow in-flight race and a
stale error banner), five nits.

## Bar checklist

| Bar item | Verdict | Where |
|---|---|---|
| Per-card remove calls `DELETE /vocab/cards/:id` | PASS | `client/src/services/vocab.ts:306-308`; wired at `client/src/pages/Review.tsx:2001` |
| Honest error handling on remove (no silent success / stuck state) | PASS | `Review.tsx:2005-2015` — card stays in deck, `role="alert"` at 2296-2300, control re-enabled (`finally` resets `removingKey`, 2013-2015) |
| Queue/list updates after remove (not stale) | PASS | `liveDeck` filter `Review.tsx:1818`; every count/progress/index reads it (2081-2103); removing last card completes the session (1820) |
| Clear behind a REAL confirmation | PASS | Opener only opens the Sheet (`Review.tsx:1024`, 911-925); service fires only from `confirmClear` (922-925 → 627-655); test asserts service NOT called pre-confirm (`Review.test.tsx:1778-1782`) |
| Confirmation copy says words are KEPT | PASS | `Review.tsx:1088-1093` — "your saved words and lists are kept, and you can add words back to review any time" (EN+KR); asserted in test 1786-1789 |
| Removed-count / empty-state after clear | PASS | `Review.tsx:634-640` ("Removed N cards… Your saved words are kept." / "already empty"); banner kept mounted post-clear via `hasDueWork` including `clearStatus !== null` (878-882) |
| Disabled/busy during the call | PASS | Opener `disabled={clearing}` + "Clearing…" (1025-1032); confirm button `disabled={clearing}` (1102); in-flight guard `Review.tsx:628` |
| Can't fire accidentally | PASS | Sheet's `useModalA11y` puts initial focus on the first focusable — the Close (X) button (`Review.tsx:1078-1085`), NOT the destructive confirm; Esc/backdrop cancel; cancel path tested (`Review.test.tsx:1802-1820`) |
| WCAG/ARIA on both controls | PASS (one convention-nit) | Real `<Button>`s, keyboard-reachable; `aria-label`s at 1026, 2286; dialog = `role="dialog"` + `aria-modal` + focus trap + Esc + focus restore (`components/Sheet.tsx:84-107`); error banners `role="alert"` |
| Strict TS at the fetch boundary | PASS | `ClearCardsResult` in `client/src/types/domain.ts:1186-1194`; `api.post<ClearCardsResult>` / `api.delete<void>` match the app-wide typed-wrapper convention (`services/api.ts:251-271`); no `any` |
| Tests exercise real behavior | PASS | `Review.test.tsx:1676-1851` — remove advances the deck (1/2 → 1/1, next word visible), last-card completes, failure keeps card + alert + enabled retry, fixture cards get no control; clear: not-called-before-confirm, copy assertion, count banner + refetch, cancel clears nothing, failure alert |
| Consistent with Review conventions + kebab-case BEM | PASS | Mirrors the B-013 seed pattern (627-655 vs 585-618); `km-review__clear-status`, `__clear-confirm-copy`, `__clear-confirm-actions`, `__remove-row` (`Review.css:250-277`) all kebab-case |
| No scope creep | PASS | Diff touches exactly the six scoped client files |

## Findings

### BLOCKER — none

### SHOULD-FIX

**SF-1 — Flip/rate not blocked while a remove is in flight (narrow race skips a card).**
`Review.tsx:1973-1984` (`rate`) and the spacebar flip (1894-1906) have no
`removingKey` guard; only the remove button itself disables (2285). During the
DELETE round-trip the user can flip and rate the very card being removed: `rate`
advances `idx` to the next card, then the DELETE resolves, `removedKeys` grows,
`liveDeck` (1818) loses the card at the position *before* `idx` — every later card
shifts down one, so the card that slid into the old index is silently skipped for
this session (it stays in the server queue, so no data loss). It also fires
`submitReview` against a card the server is concurrently soft-deleting, and the
success handler's `setFlipped(false)` (2003) un-flips the card the user just moved
to. One-RTT window, low likelihood — but a one-line `removingKey !== null` guard in
`rate` (and the spacebar handler) closes it.

**SF-2 — Stale remove-error banner outlives its card.**
`rate` clears `rateError` (`Review.tsx:1980`) but not `removeError`. After a failed
removal, if the user shrugs and rates the card instead, the card-specific alert
("Couldn't remove 영향 from review — it's still in your queue", set at 2007-2012,
rendered at 2296-2300) persists under every subsequent card until restart (2028) or
a fresh remove attempt (1998). The claim stays technically true, but a stale
`role="alert"` about a card no longer on screen is noise; clear it in `rate`
alongside `rateError`.

### NIT

**N-1 — `clearDueCards` is misnamed.** Its own docstring (`vocab.ts:311-321`) and the
build note say it clears due, future-scheduled, AND suspended cards — "due" in the
name undersells the blast radius the confirmation exists for. `clearAllCards` /
`clearReviewQueue` would be honest.

**N-2 — Clear affordance unreachable at 0-due.** The Clear button lives inside the
due-strip Card, rendered only when `dueCount > 0` (`Review.tsx:1007-1033`). A user
whose cards are all future-scheduled/suspended (exactly what clear also removes)
sees no strip and has no way to clear. Acceptable for the personal-scope app, but
worth knowing it's a product gap, not an accident of the confirm flow.

**N-3 — Success banner live-region announced unreliably.** The `role="status"` node
(`Review.tsx:1047-1058`) is mounted simultaneously with its content; several screen
readers only announce live regions that already existed before the text change. The
error path is fine (`role="alert"` is announced on insertion). Consider keeping the
status node mounted or reusing the alert pattern the seed banner uses.

**N-4 — "Nothing was removed" fallback is a claim the client can't fully verify.**
`Review.tsx:646-649` asserts "Nothing was removed" for any unmapped failure (e.g. a
500 raised after the atomic UPDATE committed — near-theoretical for a single-statement
clear, and the genuinely ambiguous case, timeout, gets `errorMessageFor`'s claim-free
timeout copy, `lib/errorCopy.ts:38-40`). Fine as shipped; noting for the record.

**N-5 — Label-in-name (WCAG 2.5.3, strict reading).** Remove control: accessible name
"Remove 영향 from review" (`Review.tsx:2286`) does not contain the visible label
"Remove from review" contiguously, so voice-control users saying the visible label
won't match. This exactly mirrors the pre-existing list-detail convention
(`Review.tsx:1697`), so it's a codebase-wide pattern call, not a defect of this diff.
(The Clear opener is clean: "Clear the review queue" contains the visible "Clear".)

**N-6 — Near-tautological service error tests.** `vocab.test.ts:320-326` and 338-345
mock a rejection and assert it rejects — for one-line wrappers that's testing the
mock. Harmless, matches the file's existing style; the happy-path URL/verb
assertions (315-318, 331-336) carry the real value.

### PRAISE

**P-1 — The confirmation is real and fails safe.** Opener-only-opens is asserted in
test (`Review.test.tsx:1778-1782`); the Sheet brings a full modal a11y contract
(focus trap, Esc, restore — `components/Sheet.tsx:14-25, 84`); and because initial
focus lands on the first focusable — the Close button (`Review.tsx:1078-1085`) — a
reflexive Enter *cancels* rather than clears. That is exactly how a destructive
confirm should be laid out, and it appears to be by construction, not luck.

**P-2 — Deliberately non-optimistic remove, with the reasoning written down.** The
card leaves the local deck only after the DELETE succeeds (`Review.tsx:1807-1818`,
2001-2002), and `removedKeys` intentionally survives `restart` with the comment
"re-presenting them would be a lie" (2029-2030). The `hasDueWork` extension
(878-882) that keeps the success banner mounted after the section's own data
empties shows the same end-to-end thinking.

**P-3 — Tests probe the seams, not the happy path only.** Two-card deck proving the
next card slides in and the count shrinks (1676-1712), last-card-completes
(1714-1726), failure keeps the card with an enabled retry (1728-1750), fixture cards
excluded (1752-1766), cancel-clears-nothing (1802-1820), and the clear-failure alert
asserting the "Nothing was removed" recourse (1822-1850). None are tautologies.

**P-4 — CSS comment discipline.** `Review.css:251-254` explains why
`.km-review__clear-status` must NOT set `color` (it would silently beat
`.km-review__inline-error`'s vermilion by source order) — a specificity landmine
defused in advance.
