# BUILD — F-199: per-user upload provenance for saved vocab

**Ticket:** F-199 (Batch 5 follow-up, server review SF-1) · **Branch:** `feature/f199-per-user-provenance` · **Migration:** 070

## Problem

F-107 recorded "the user saved this word while reading THIS upload" on
`vocab_entries.source_upload_id` — a **shared** row keyed `(corpus,
source_id)`, not by user. `POST /vocab/mine` wrote it first-write-wins
(`ON CONFLICT … COALESCE`), so when user A mined a lemma tagged to A's
upload and user B later genuinely mined the **same** lemma from B's own
upload, B got a 201 while B's tag was silently discarded — the word never
appeared in B's `GET /vocab/saved-from-uploads`. Side effect: a weak
inference oracle (B could detect that *someone* tagged the entry first).

## Design: card vs. shared row

The user's save artifact for vocab is the `vocab_cards` row (`user_id`-
scoped, created/ensured by the same mine flow) — per-user provenance
belongs there, exactly as migration 068 concluded for the grammar side
(`grammar_entries` is already user-scoped, so grammar never had this bug).
An association table `(user, entry, upload)` was the alternative; rejected
as heavier than needed — the card already exists 1:1 with the save, and 068
set the column-on-the-save-artifact precedent.

**Migration 070** (`db/migrations/070_vocab_cards_source_upload.{up,down}.sql`):

- `vocab_cards.source_upload_id BIGINT NULL`, named FK
  `fk_vocab_cards_source_upload` → `book_uploads(id)` `ON DELETE SET NULL
  ON UPDATE RESTRICT`, partial index `ix_vocab_cards_source_upload WHERE
  source_upload_id IS NOT NULL` — mirrors 068/040 exactly. Up is
  `-- migrate: non-destructive`; down (`DROP COLUMN`) is marked destructive
  (F-088).

### Backfill ownership rule

In the up migration, one set-based, fill-only, idempotent UPDATE:

```
card gets ve.source_upload_id  ⇔  book_uploads.user_id = vocab_cards.user_id
                                   AND card.source_upload_id IS NULL
```

The pre-070 route only ever let a user tag an upload they own, so "entry
tag points at an upload owned by this card's user" recovers exactly the
tags that user wrote (plus cards banked on the user's own extracted
entries — equally correct provenance). A card whose entry was tagged to
**another** user's upload matches no row and stays NULL: the
mis-attributed shared-row tags (the exact bug) are dropped, never copied.
Soft-deleted cards are backfilled too (provenance is a historical fact;
every read filters `deleted_at`). `vocab_entries.source_upload_id` is not
modified by the backfill.

## Route changes (`server/src/routes/vocab.ts`)

### `POST /vocab/mine`

- Step-0 ownership check unchanged (upload must belong to caller → 404,
  identical for nonexistent/unowned ids; runs inside the transaction).
- The `vocab_entries` upsert **no longer writes `source_upload_id`** (the
  COALESCE first-write-wins arm and the ACCEPTED-TRADEOFF comment are
  gone). The shared row stays pure reference data; the gloss no-clobber
  rule and version bump are unchanged.
- The tag now lands on the caller's card: a new card is INSERTed with it; a
  re-mine against an existing card **fills** the tag only when the card has
  none (`… AND source_upload_id IS NULL`, re-checked under the row lock).

### Re-mine overwrite policy: keep-first, per user

- Re-mine with the **same** upload → genuine no-op (no UPDATE, no
  `updated_at`/version churn on the FSRS row).
- Re-mine from a **different** owned upload → the first tag is kept.
  Keep-first vs. overwrite is now harmless either way because the tag never
  crosses users; keep-first was chosen to match the pre-existing fill-only
  posture (and the backfill's). Documented at the code site.
- FK race (concurrent upload hard-delete between ownership check and card
  write) → 23503 on `fk_vocab_cards_source_upload`, mapped to the same 404
  (constraint-name-scoped so unrelated integrity errors still 500 loudly).

### `GET /vocab/saved-from-uploads`

Provenance per saved word is now resolved per user:

1. the caller's own `vocab_cards.source_upload_id` when set (F-199), else
2. the entry's F-108 extracted-corpus tag — only when the caller owns that
   upload (`bu.user_id = $1` on the join).

Leg 2 keeps the documented F-107 behavior for list-adds and plain banks of
the user's **own** digitised (U2-extracted) words, which carry the shared
F-108 tag and are owner-fenced everywhere (corpusFences). For card tags the
`bu.user_id` predicate is defense in depth (route + backfill both enforce
ownership before writing); for leg 2 it is the actual fence. The
`{ groups, total, truncated }` envelope, 500-row cap, and whole-group
truncation semantics are byte-identical to before. The weak-oracle note is
gone — B's tag lands on B's card, so nothing about A is even inferable.

## What stayed for F-108

`vocab_entries.source_upload_id` (migration 040) **survives untouched**:
from 070 on it receives **only** F-108 extracted-corpus writes
(`server/src/services/uploadExtract.ts` at U2 curation), read by
`GET /vocab/entries?source_upload_id=` (U3a browse) and by leg 2 above,
guarded by `sourceUploadFenceSql` everywhere. The only change is that the
user-saved write path (mine) no longer touches it. Same for
`kgiu_entries.source_upload_id`.

**Honest limit (legacy rows):** tags that pre-070 mines wrote onto shared
`user_mined` rows are deliberately **retained**, so "F-108 provenance only"
holds for new writes, not for all stored values. Retention is load-bearing:
leg 2 of `saved-from-uploads` resolves pre-070 **list-only** saves of mined
words through the entry tag (no card existed for 070's backfill to fill), so
clearing those tags would silently drop such words from the owner's
saved-from-uploads. The cost of retention is cosmetic and owner-only: the
U3a browse keeps showing pre-070-mined words for their tag's owner while
post-070 mines never appear there, and corpusFences keeps privatizing those
legacy shared rows (a pre-existing quirk). No tag ever crosses users either
way. A safe cleanup must first move list-only-save provenance to a
user-scoped store — deferred to **F-200** (`BUGS_AND_FEATURES.md`).

## Security notes

- Every query user-scoped (`c.user_id` / `vl.user_id` / `bu.user_id` all
  bound to the session user); parameterized SQL only.
- Ownership validated before any tag write (mine step 0); the backfill's
  ownership join is the migration-time equivalent — reasoned about in the
  070 up header.
- No existence oracle: nonexistent and unowned upload ids 404 identically.
- The F-199 inference oracle (detecting that someone tagged an entry
  first) is eliminated — tags never share a row across users anymore.

## Tests

- `db/tests/test_migration_070.py` (10 tests): F-088 marker classification,
  up without `--allow-destructive`, FK shape (NULL / owned id / dangling id
  / ON DELETE SET NULL), **backfill ownership rule** (owner-matched tag
  copied; cross-user tag dropped; untagged stays NULL; `vocab_entries`
  untouched; soft-deleted cards included; multi-owner no cross-talk), the
  **fill-only/no-overwrite guard proven non-vacuously** (direct re-execution
  of the up body over a card already carrying a route-written tag — the tag
  survives while an untagged control card still gets filled), down gate +
  DROP COLUMN, down→up round trip re-running the backfill.
- `server/tests/routes/vocab.test.ts`: mine-provenance suite rewritten to
  assert the tag on the card and the shared entry staying NULL; new
  tagged-re-mine fill + keep-first tests; **the F-199 headline test** (A
  and B mine the same lemma from their own uploads → both keep their tag
  and both see their word in their own saved-from-uploads); the user-scoped
  read test now also pins the leg-2 fence (B holding a card on an entry
  extracted from A's upload sees nothing). F-108 browse tests unchanged.

## Gate results (2026-07-16)

- `server npm run typecheck` — 0 errors
- `server npm run lint` — 0 errors / 0 warnings
- `server npx vitest run` (full, testcontainer) — 62 files, 1354 passed, 4 skipped, 0 failed
- `db` pytest full suite (pinned `python:3.12` container, testcontainers
  postgres:16-alpine) — 262 passed, 0 failed (includes the 9 new
  `test_migration_070.py` tests; migration up + down + backfill proven)
