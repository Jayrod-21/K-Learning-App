# Build note — Remove words from the vocab review queue + clear the queue

**Branch:** `feat/vocab-queue-clear` (off `rebuild`)
**Date:** 2026-07-17

## What this is

Two beta features for the vocab review queue:

1. **Remove one word from review** — a per-card control in the flashcard
   session removes the current card from the review queue.
2. **Clear the review queue** — a confirmed bulk action on the flashcards
   landing removes every vocab card from review at once.

**Core semantic (Jared's decision): the word stays SAVED.** Both operations
soft-delete `vocab_cards` rows only (`deleted_at = now()`). The
`vocab_entries` word, any `vocab_lists` membership, and saved-from-uploads
provenance are never touched. Nothing is ever hard-deleted; a removed word
can be re-added to review any time through the existing bank/mine/seed
routes (they skip only *live* cards — `deleted_at IS NULL` — so a removed
word simply gets a fresh card).

## Endpoints (`server/src/routes/vocab.ts`)

### `DELETE /vocab/cards/:cardId` → 204

Soft-deletes the caller's OWN card:

```sql
UPDATE vocab_cards
   SET deleted_at = COALESCE(deleted_at, now())
 WHERE id = $1 AND user_id = $2
   AND hanja_character_id IS NULL
   AND grammar_entry_id IS NULL
```

- **Idempotent:** re-removing an already-removed card is still 204; the
  `COALESCE` preserves the original removal timestamp.
- **404** for a nonexistent id, another user's card (uniform response — no
  existence oracle, the other user's card is never touched), a hanja card,
  or a grammar production card (see scoping below).

### `POST /vocab/cards/clear` → 200 `{ cleared: <count> }`

Soft-deletes ALL of the caller's active vocab cards:

```sql
UPDATE vocab_cards
   SET deleted_at = now()
 WHERE user_id = $1 AND deleted_at IS NULL
   AND hanja_character_id IS NULL
   AND grammar_entry_id IS NULL
```

Returns how many cards were removed. Idempotent — a repeat call returns
`{ cleared: 0 }`.

## Scoping decisions (documented per the ticket)

- **Suspended vocab cards: CLEARED.** Suspension is a pause *within* the
  review set; clearing removes the set itself. A suspended card left behind
  would un-suspend into a queue the user deliberately emptied. Future-due
  (not-yet-due) cards clear too, for the same reason — "clear" means "start
  over", not "hide today's slice".
- **Hanja cards: NOT touched** (`hanja_character_id IS NULL`). They have
  their own queue (`GET /hanja/cards/due`) and review UI (F-075).
- **Grammar production cards: NOT touched** (`grammar_entry_id IS NULL`).
  Note this is one predicate MORE than the due query's own vocab-only
  scoping: grammar production cards ride the same `/vocab/cards/due` wire
  (FU-NF-42) — `hanja_character_id IS NULL` alone would have bulk-deleted
  them, contradicting the stated requirement that grammar cards are not
  cleared. The client partitions them into their own drill section, and
  "I know this pattern" already has a first-class mechanism (graduation,
  migration 033) whose FSRS history a queue-clear must not destroy.
  Both endpoints share one SQL fragment (`VOCAB_DECK_SCOPE_SQL`) so they
  can never drift apart. Sentence/topik cards ARE part of the vocab deck
  and are removable/clearable.
- **No migration needed:** `vocab_cards.deleted_at TIMESTAMPTZ` exists
  since migration 001; every reader (`/cards/due`, mastery, plan counts,
  bank idempotency) already filters `deleted_at IS NULL`.

## Client

- **Per-card remove** — `client/src/pages/Review.tsx` `StudySession`
  (`/learn/vocab?study=due` and per-list study alike): a ghost "Remove from
  review · 복습에서 제거" button under the flashcard (only on real due-wire
  cards; dev fixture cards don't render it). Non-optimistic: the card
  leaves the local deck only after the DELETE succeeds; a failure shows a
  `role="alert"` line and keeps the card. Removing the last card completes
  the session. Counts/progress read the live (post-removal) deck.
- **Clear review queue** — flashcards landing (`LandingView`), in the
  "Review queue" strip next to Study: a "Clear · 비우기" button opens a
  confirmation `Sheet` that states plainly *"This removes these cards from
  review — your saved words and lists are kept."* Confirm calls
  `POST /vocab/cards/clear`, shows the removed count as the post-clear
  status/empty-state, and refetches the due feed. The button is disabled
  while the call is in flight; a failure states nothing was removed.
- **Service fns** — `client/src/services/vocab.ts`: `removeCard(cardId)`,
  `clearDueCards()`. Type: `ClearCardsResult` in
  `client/src/types/domain.ts`.
- CSS in `Review.css`, kebab-case BEM (`km-review__remove-row`,
  `km-review__clear-status`, `km-review__clear-confirm-copy`,
  `km-review__clear-confirm-actions`).

## Security

- **User-scoped everywhere:** both writes bind the SESSION user id; a
  crafted request cannot remove or clear another user's cards (cross-user
  id → uniform 404; clear literally cannot name another user).
- **Parameterized SQL only**; the only non-parameter fragments are
  server-side constants.
- **Soft delete preserves data** — words are never deleted, cards are
  recoverable in principle (`deleted_at` flip).
- **Bulk clear is confirmed client-side AND scoped server-side** — the
  confirmation is UX; the `user_id` scoping is the actual defense.
- `requireAuth` + `cheapLimiter` on both routes.

## Tests

- **Server** (`server/tests/routes/vocab.test.ts`, testcontainer):
  remove → soft-deleted, word intact, gone from due; idempotent re-remove
  preserves the timestamp; cross-user 404 + untouched; hanja/grammar 404 +
  untouched; bad ids 400/404; clear → due+future+suspended all cleared with
  exact count, words intact, hanja/grammar/other-user cards untouched,
  queue honestly empty, repeat clear → 0; auth-required rows for both.
- **Client:** service tests (`services/vocab.test.ts`) for both fns;
  `Review.test.tsx` — remove advances/shrinks the session, last-card
  removal completes it, failure keeps the card with an alert, fixture cards
  offer no control; clear only fires after the confirmation (which must
  contain the words-are-kept copy), cancel clears nothing, success shows
  the removed count + refetches, failure shows "nothing was removed".
