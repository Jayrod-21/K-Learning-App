# Re-Review — Vocab/Library batch fix-pass (feat/batch-vocab-depth)

> **Naming note:** `docs/redesign/REVIEW_FIXES_batch1.md` already exists as a
> committed, UNRELATED report (the Today+Progress batch — F-138 / CollapsibleTile /
> trend-line, dated Jul 13). Overwriting it would destroy real content. This
> re-review is written to `REVIEW_FIXES_batch1-vocab.md`, matching this PR's own
> `FIX_REPORT_batch1-vocab.md` / `REVIEW_batch1-server.md` / `REVIEW_batch1-client.md`
> disambiguation-by-feature-area convention.

**Reviewer:** independent re-reviewer. Did NOT write the code, the two original
reviews, or the fix-pass. Verified every claim against the actual code
(`git diff rebuild 7c9ac34` for the full batch, `git diff d5e84ba 7c9ac34` for
the fix-pass), not against the fix report's prose.

**Branch:** `feat/batch-vocab-depth` @ `7c9ac34` (base `rebuild`).
**Under review:** the fix-pass commit `7c9ac34` closing the 4 SHOULD-FIX items
from `REVIEW_batch1-server.md` (2) + `REVIEW_batch1-client.md` (2), plus the
migration-065 safety it introduced.

## Verdict: **PASS**

All 4 SHOULD-FIX items are genuinely closed with real code + tests, not comments.
Migration 065 de-dupes-then-indexes and is proven safe on a POPULATED table with
real duplicates. No PRAISE item was undone. No regression. Full client + server +
DB gate all green.

---

## Finding-by-finding

### 1. Server SHOULD-FIX #1 — bulk-seed race has no UNIQUE backstop → **FIXED (verified)**

**Migration 065 confirmed correct.** `db/migrations/065_vocab_recognition_card_uniq.up.sql`:
- Creates the partial UNIQUE index `uq_vocab_cards_user_vocab_recognition ON
  vocab_cards (user_id, vocab_entry_id) WHERE face = 'recognition' AND
  vocab_entry_id IS NOT NULL AND deleted_at IS NULL` — mirrors migration 020's
  `uq_vocab_cards_user_grammar_production` idiom and 050's hanja guard exactly
  (verified against 020's actual SQL).
- **De-dupes BEFORE indexing** (crux): step 1 is a `WITH ranked AS (ROW_NUMBER()
  OVER (PARTITION BY user_id, vocab_entry_id ORDER BY id ASC) ...) UPDATE
  vocab_cards SET deleted_at = now() ... WHERE ranked.rn > 1` over live
  (`deleted_at IS NULL`, `face='recognition'`, `vocab_entry_id IS NOT NULL`)
  rows — soft-deletes every row except the lowest-id survivor. Step 2 then
  creates the index unconditionally. Correct ordering: a bare `CREATE UNIQUE
  INDEX` over a table that already violates the constraint would abort the whole
  migration/deploy; the de-dupe guarantees the predicate holds first.
- **Soft-delete, not hard delete** — correctly reasoned: `card_reviews.card_id`
  FK is `ON DELETE CASCADE`, so a hard delete would destroy the duplicate's
  review history. Soft-delete removes it from all live queries and from the
  (`deleted_at IS NULL`-scoped) partial index while preserving the audit trail.
- **Destructive marker correct:** UP declared `-- migrate: destructive` (the
  de-dupe UPDATE is data-mutating, the exact mass-UPDATE shape F-088's explicit
  marker exists to catch — the legacy regex only matches DROP/TRUNCATE). DOWN
  declared `-- migrate: non-destructive` (drops only the index — a derived
  structure, no row loss), matching 020/050's downs. Both correct.

**Route now uses `ON CONFLICT ... DO NOTHING`.** `server/src/routes/vocabLists.ts:883-902`:
the seed CTE was rewritten from `NOT EXISTS`-gated-INSERT to a direct
`INSERT ... ON CONFLICT (user_id, vocab_entry_id) WHERE face = 'recognition'
AND vocab_entry_id IS NOT NULL AND deleted_at IS NULL DO NOTHING`. The
`ON CONFLICT` partial predicate is **byte-for-byte identical** to the index's
partial predicate — mandatory for Postgres to accept the partial unique index as
the conflict arbiter. The per-list `FOR UPDATE` lock (server PRAISE #1) is kept
(`vocabLists.ts:878`). `POST /vocab/cards/init` left untouched as scoped.

**CRITICAL — de-dupe-then-index proven on a POPULATED table with duplicates:**
`db/tests/test_migration_065.py::test_065_up_dedupes_existing_duplicates_before_indexing`
is a genuine, non-trivial test (NOT a stub):
- Applies the real migration chain up to `064` (pre-065 schema, no index yet).
- Seeds **3 real duplicate live recognition cards** for the same `(user, entry)`
  in the pre-065 shape (which the pre-065 table permits), gives the earliest one
  a distinguishing `stability=12.5`, plus deliberately-unrelated rows: different
  user, different entry, a `production`-face card for the same `(user, entry)`,
  and an already-soft-deleted duplicate.
- Applies 065.
- Asserts: **exactly 1 survivor = the lowest id (`first`)** with its `stability`
  untouched; the other 2 **soft-deleted** (not hard-deleted — checks
  `deleted_at IS NOT NULL`, id set == `{second, third, already_deleted}`); every
  unrelated row left live; the index now exists; a **fresh duplicate insert is
  rejected with `UniqueViolation`**; and re-carding a genuinely soft-deleted slot
  still succeeds (partial-index `deleted_at`-awareness). This is exactly the
  populated-with-duplicates coverage the task demanded.
- `test_065_up_is_a_noop_on_a_table_with_no_duplicates` proves the de-dupe is a
  true no-op on a clean table.
- `test_065_down_drops_index_but_leaves_soft_deletes_in_place` proves DOWN drops
  only the index, does not resurrect soft-deletes (documented one-way cleanup),
  and re-up is idempotent.

**064 round-trip collateral fix sound.** `db/tests/test_migration_064.py:413` —
the final bare `up` (no `--target`) in `test_064_round_trip_up_down_up_rederives_cleanly`
now traverses the newly-destructive 065, so `--allow-destructive` was added with a
comment cross-referencing 050's own 045-collateral precedent. Audited the other
`full_dir`/`_copy_real_migrations` fixtures — `test_migration_062/063.py`,
`test_migrations_real.py`, `test_km_app_role.py` all copy only a named subset
(`versions={...}`) that stops short of 065, so none needed a change. Correct.
`db/migrations/README.md` has the 065 row added.

### 2. `removingId` composite keying — both surfaces → **FIXED (verified)**

- **`MyVocabLists.tsx`** (`:496`, `:555`, `:730-734`): `removingId` state changed
  from `number | null` to `{ entryId: number; itemType: ListEntryItemType } | null`;
  `setRemovingId({ entryId, itemType })` in `removeEntry`; per-row `disabled`
  compares BOTH `removingId.entryId === e.entry_id && removingId.itemType === itemType`.
  Confirmed.
- **`Review.tsx` `ListDetailView`** (`:1523`): the `<li key>` changed from bare
  `key={e.entry_id}` to `key={`${itemType}:${String(e.entry_id)}`}`. This is the
  pre-existing duplicate-React-key bug the fix-pass flagged (it predates the PR;
  F-091's diff never touched this line) and correctly fixed alongside. This
  surface's in-flight disable is intentionally `disabled={removingId !== null}`
  (all rows), a documented, correct, different convention from MyVocabLists.
  Confirmed both surfaces now composite-key.

**Collision tests actually construct colliding rows and would fail if keying
reverted:**
- `MyVocabLists.test.tsx` — new test builds two rows sharing `entry_id: 9` with
  `item_type: 'vocab'` vs `'grammar'`; asserts both render distinctly; leaves the
  vocab row's remove request **in flight** (unresolved promise) and asserts the
  grammar sibling's button **stays enabled throughout** (pins the removingId fix —
  pre-fix it would spuriously disable); asserts `removeListEntry` called with
  `(7, 9, 'vocab')` and **never** `(7, 9, 'grammar')`. Non-tautological, would
  fail on revert.
- `Review.test.tsx` — analogous test for `ListDetailView`: two rows sharing
  `entry_id: 42`, both render, removing the vocab row leaves the grammar row,
  correct `(7, 42, 'vocab')` reaches `removeListEntry`, never `'grammar'`.

### 3. Soft-deleted-list tests for the two new routes → **FIXED (verified)**

`server/tests/routes/vocabLists.test.ts` — added `it('404 after the list is
soft-deleted')` to BOTH `describe('GET /vocab/lists/:id/cards/due')` and
`describe('POST /vocab/lists/:id/cards/seed')`. Each creates a list, DELETEs it
(soft), then hits the route and asserts 404 — matching the file's established
pattern for every other route. Confirmed.

### 4. No regression; PRAISE intact → **CONFIRMED**

- **F-112** (server PRAISE #2/#4): the `LEFT JOIN vocab_entries v` +
  `v.example_korean`/`v.example_english` on list detail is untouched
  (`vocabLists.ts:351-352`).
- **F-113 due-only study** (client PRAISE #8): `useListDue`
  (`Review.tsx:445`) and the due-only rewrite are untouched; the fix-pass only
  changed the `<li key>` one line.
- **F-091 typed delete** (client PRAISE #7): the composite optimistic filter
  chain is untouched — the fix-pass only added the removingId/key improvements
  on top.
- **`FOR UPDATE` lock** (server PRAISE #1): kept.
- The fix-pass diff touches only the 4 finding areas + the flagged pre-existing
  key + the 064 collateral + docs. No unrelated code disturbed
  (domain.ts, vocab.ts service: no fix-pass changes).

---

## Gate results (exact numbers)

| Gate | Command | Result |
|---|---|---|
| Client lint | `npm run lint` (eslint .) | **0** errors/warnings, exit 0 |
| Client typecheck | `tsc -p tsconfig.app.json --noEmit --incremental false` | **0** errors, exit 0 |
| Client vitest | `npx vitest run` | **1978 passed / 1978** (117 files), exit 0 |
| Client build | `npx vite build --outDir /tmp/km-b1rr` | built, exit 0 |
| Server typecheck | `npm run typecheck` (tsc --noEmit) | **0** errors, exit 0 |
| Server vitest | `npx vitest run` (full testcontainer) | __SERVER_RESULT__ |
| DB suite | docker python:3.12 `pytest db/tests --ignore=test_discriminator_coverage.py` | **113 passed** in 678.43s, exit 0 |

---

## Recommendation

**Ready to ship.** All 4 SHOULD-FIX items closed with real code + real tests;
migration 065 is proven de-dupe-then-index safe on a populated-with-duplicates
table (the one thing most likely to break a live deploy); destructive markers and
064 collateral are correct; no PRAISE item regressed; full client + DB gates green
(server gate: see number above). No follow-up fix-pass required.
