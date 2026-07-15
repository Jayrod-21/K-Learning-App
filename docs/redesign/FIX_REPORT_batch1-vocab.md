# Fix Report — Vocab/Library batch (feat/batch-vocab-depth)

> **Naming note:** the task asked for `docs/redesign/FIX_REPORT_batch1.md`,
> but that exact path is already a committed, unrelated fix-pass report (the
> Today+Progress redesign batch, commit `20c9f37`) — same generic filename,
> different feature area. Overwriting it would destroy real, already-merged
> content that has nothing to do with this PR. Named this one
> `FIX_REPORT_batch1-vocab.md` instead, matching this PR's own
> `REVIEW_batch1-server.md` / `REVIEW_batch1-client.md` convention (this PR's
> review docs already disambiguate by `-server`/`-client`; this fix report
> disambiguates by `-vocab`, the feature area).

Base commit: `d5e84ba` (Vocab list depth: examples on list rows, due-aware
list study, typed removes). Fix-pass against `docs/redesign/REVIEW_batch1-server.md`
and `docs/redesign/REVIEW_batch1-client.md` (0 BLOCKER, 4 SHOULD-FIX between
the two independent reviews). All 4 addressed below; no PRAISE items were
undone.

## Disposition by finding

### 1. Server SHOULD-FIX #1 — bulk-seed race has no UNIQUE backstop

**Fixed.** Added migration `065_vocab_recognition_card_uniq` — a partial
UNIQUE index `uq_vocab_cards_user_vocab_recognition` on
`vocab_cards (user_id, vocab_entry_id)` scoped to
`face = 'recognition' AND vocab_entry_id IS NOT NULL AND deleted_at IS NULL`,
mirroring the existing `020_grammar_production_card_uniq` /
`050_hanja_cards` precedent exactly. `POST /vocab/lists/:id/cards/seed`
(`server/src/routes/vocabLists.ts`) now inserts via
`ON CONFLICT (user_id, vocab_entry_id) WHERE face = 'recognition' AND
vocab_entry_id IS NOT NULL AND deleted_at IS NULL DO NOTHING`, which is
atomic across concurrent transactions (unlike the prior bare
NOT-EXISTS-then-INSERT under READ COMMITTED). The per-list `FOR UPDATE` lock
(praised by the reviewer as the strongest defense against the *same-list*
double-tap) is unchanged and kept.

`POST /vocab/cards/init` was deliberately **not** touched — the review said
"consider it, but stay scoped," and the task instructions repeated that. It
remains NOT-EXISTS-gated, but the new index now backstops its race too (a
second concurrent insert from `cards/init` racing this route, or racing
itself, now hits the same UNIQUE constraint and fails/no-ops instead of
landing a duplicate — the index protects the table regardless of which INSERT
statement reaches it). Porting `cards/init`'s own INSERT to `ON CONFLICT` is
a clean, low-risk follow-up but out of scope here.

**Live-DB safety (the part I verified hardest):** the migration's UP first
runs a de-dupe UPDATE — `ROW_NUMBER() OVER (PARTITION BY user_id,
vocab_entry_id ORDER BY id ASC)` over the live recognition rows, soft-deleting
(`deleted_at = now()`) every row except the lowest-id ("earliest") survivor —
**before** creating the index. This is not cosmetic: if the pre-existing gap
already produced duplicate rows on a real database, a bare `CREATE UNIQUE
INDEX` would fail outright and abort the migration/deploy. Soft-delete (not
a hard DELETE) was chosen because `card_reviews.card_id`'s FK is `ON DELETE
CASCADE` (`001_core_schema.up.sql`) — a hard delete of a duplicate card would
destroy that duplicate's own review history. Soft-deleting removes it from
every live query and from the new partial index (itself `deleted_at IS
NULL`-scoped) while preserving the audit trail, matching the app's existing
soft-delete convention everywhere else.

**Tested on a POPULATED table, not just an empty one** — confirmed:
`db/tests/test_migration_065.py::test_065_up_dedupes_existing_duplicates_before_indexing`
seeds 3 duplicate live recognition cards for the same `(user, vocab_entry)`
in the pre-065 schema (which still permits it — no index yet), plus
deliberately-unrelated rows (different user, different entry, different
face, an already-soft-deleted duplicate), applies migration 065, and asserts:
exactly 1 survivor (the lowest id, with its own data — e.g. `stability` —
untouched), the other 2 soft-deleted, every unrelated row left alone, the
index now exists, a fresh duplicate insert is rejected
(`UniqueViolation`), and re-carding a genuinely soft-deleted slot still works.
A second test (`test_065_up_is_a_noop_on_a_table_with_no_duplicates`) proves
the de-dupe step is a true no-op on a clean table. A third
(`test_065_down_drops_index_but_leaves_soft_deletes_in_place`) proves the
down migration drops only the index and does not (cannot, without tagging
exactly which rows it touched) resurrect the soft-deleted duplicates —
documented as an accepted, one-way data-cleanup limitation in the down
migration's own header, the same posture `064.down` already documents for
itself.

Marked `-- migrate: destructive` on the UP (the de-dupe UPDATE is
data-mutating — equivalent to a DELETE from the app's point of view, which
F-088's explicit marker exists to catch since the legacy sniff only matches
DROP TABLE/SCHEMA/DATABASE/TRUNCATE). The DOWN is marked
`-- migrate: non-destructive` (it only drops an index — a derived structure,
no row loss — same posture 020's/050's downs take).

**Collateral fix required:** adding a destructive migration 065 after 064
broke `test_migration_064.py::test_064_round_trip_up_down_up_rederives_cleanly`,
whose final bare `migrate.main([..., "up"])` (no `--target`) now traverses
065 too and needs `--allow-destructive`. Fixed by adding the flag with a
comment cross-referencing the same collateral-flag pattern
`test_migration_050.py`'s header already documents for 045 sitting ahead of
050 in its own chain. Audited every other `full_dir`-style (whole-real-chain)
test fixture in `db/tests/` for the same exposure — `test_migration_063.py`,
`test_migrations_real.py`, `test_km_app_role.py`, and `test_migration_062.py`
all copy only a **named subset** of real migration files (e.g.
`versions={"001", "052", "063"}`), not the full chain, so none of them reach
065 and none needed a change.

### 2. Server SHOULD-FIX #2 — missing soft-deleted-list test cases

**Fixed.** Added `404 after the list is soft-deleted` to both
`describe('GET /vocab/lists/:id/cards/due (F-113)')` and
`describe('POST /vocab/lists/:id/cards/seed (F-113)')` in
`server/tests/routes/vocabLists.test.ts`, matching the file's established
pattern (`GET /vocab/lists/:id`'s own soft-delete test at line ~193).

### 3. Client SHOULD-FIX #1 — `MyVocabLists.tsx` `removingId` keys off bare `entry_id`

**Fixed.** `removingId` is now `{ entryId: number; itemType:
ListEntryItemType } | null` instead of `number | null`
(`client/src/components/MyVocabLists.tsx`). The per-row `disabled` check
compares both `entryId` and `itemType`, so removing one row in a
vocab/grammar `entry_id` collision no longer spuriously disables the
unrelated sibling's remove button.

While implementing the pinning test for this (finding #4 below), I found and
fixed one more instance of the same underlying class of bug that neither
review caught, in the **other** surface with the identical F-091 contract:
`Review.tsx`'s `ListDetailView` used a bare `key={e.entry_id}` on its `<li>`
(not composite with `item_type`) — confirmed via `git diff rebuild d5e84ba`
that this line **predates** this PR (F-091's own diff never touched it), so
it's pre-existing debt, not a regression this batch introduced. A duplicate
React `key` across two colliding rows risks React reconciling the wrong DOM
node on a re-render (e.g., after one row is optimistically removed), which
is exactly the ambiguity F-091 exists to eliminate. Changed to
`key={`${itemType}:${String(e.entry_id)}`}`, matching `MyVocabLists.tsx`'s
own correct pattern one line away in the same feature family. Very low risk
(pure key-identity fix, no behavior change to non-colliding lists) and
directly serves the same collision guarantee the reviewers were validating.

### 4. Client SHOULD-FIX #2 — no collision test

**Fixed on both surfaces** (the review named both `MyVocabLists` and
`Review`'s `ListDetailView` as worth covering):

- `client/src/components/MyVocabLists.test.tsx` — new test constructs two
  rows sharing `entry_id: 9` with `item_type: 'vocab'` vs `'grammar'`, asserts
  both render distinctly, asserts only the vocab row's own removal (which is
  optimistic — it vanishes from the DOM immediately, before the request
  settles) leaves the grammar sibling's button enabled throughout the
  in-flight request (pins SHOULD-FIX #1 above — pre-fix, the sibling would
  have spuriously disabled), and that the correct `(id, type)` pair was sent
  to the server (`removeListEntry` called with `'vocab'`, never `'grammar'`).
- `client/src/pages/Review.test.tsx` — new test in the same style for
  `ListDetailView`'s "Edit list" surface: two rows sharing `entry_id: 42`,
  asserts both render, removing the vocab row leaves the grammar row
  survives untouched, and the correct type reaches `removeListEntry`. (This
  surface intentionally disables **all** rows during any in-flight removal —
  a documented, different — and correct — convention from `MyVocabLists`, per
  the file's own SF-1 test — so this test asserts render+delete independence,
  not disable independence, which is the right assertion for this surface's
  contract.)

## Gate results (exact numbers)

| Gate | Result |
|---|---|
| Client lint (`eslint .`) | **0** errors/warnings |
| Client `tsc -p tsconfig.app.json --noEmit` | **0** errors |
| Client targeted vitest (`Review.test.tsx`, `MyVocabLists.test.tsx`, `vocab.test.ts`, `ReviewVocab.test.tsx`) | **154/154** passed (4 files) |
| Client full vitest (`npx vitest run`) | **1978/1978** passed (117 files) |
| Client `vite build --outDir /tmp/km-b1fix` | exit **0** |
| Server `tsc --noEmit` (typecheck) | **0** errors |
| Server targeted vitest (`tests/routes/vocabLists.test.ts`) | **58/58** passed |
| Server full vitest (`npx vitest run`) | **(see final message — run separately, foreground, result relayed there)** |
| DB suite (`docker run … python:3.12 … pytest db/tests --ignore=db/tests/test_discriminator_coverage.py -q`, up+down, `--allow-destructive`) | **113/113** passed |

## Self-assessment

- All 4 SHOULD-FIX items closed with real code + tests, not just comments.
- No PRAISE item was undone: the `FOR UPDATE` lock (server PRAISE #1) is
  intact; the F-112 JOIN, XOR-safety, and wire-shape claims (server PRAISE
  #2–4) are untouched; the `useListDue` hook, bank-then-review removal,
  composite optimistic filter, and due-only rewrite (client PRAISE #5–8) are
  untouched.
- One additional, low-risk fix beyond the 4 named findings: `Review.tsx`'s
  pre-existing (not-this-PR) duplicate React `key` on `ListDetailView`'s
  entry row, found while building the pinning test for finding #4. Flagged
  explicitly above rather than silently folded in.
- The riskiest piece of this fix-pass — a migration that changes a
  potentially-populated production table's uniqueness invariant — was tested
  against a **populated-with-duplicates** table, not just a clean one, per
  the task's explicit requirement, and the de-dupe rule (keep-earliest,
  soft-delete-the-rest) is the least-surprising choice for a
  scheduler-visible invariant (the first card a user ever started reviewing
  keeps driving that word's schedule).
- Scope discipline: `POST /vocab/cards/init` was left untouched as
  instructed; `BUGS_AND_FEATURES.md` was not edited; no push/deploy was
  performed; the pre-existing, unrelated `FIX_REPORT_batch1.md` was left
  untouched (see naming note at top) rather than clobbered.
