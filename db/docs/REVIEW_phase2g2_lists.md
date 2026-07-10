# REVIEW — Phase 2 G2: list membership multi-type widening (F-048/F-060/F-061, closes B-013)

**Reviewer:** independent senior review (did not author this code)
**Branch:** `feat/phase2-g2-new-tables`, commit `e85ed6a`
**Scope:** `db/migrations/049_vocab_list_entries_multitype.{up,down}.sql`,
`db/tests/test_migration_049.py`, `server/src/routes/vocabLists.ts`,
`server/tests/routes/vocabLists.test.ts`
**Gate:** `npx vitest run tests/routes/vocabLists.test.ts` → **45/45 passed**
(67.35s, real Postgres testcontainer; no OOM).

## Verdict

**APPROVE with SHOULD-FIXes — 0 BLOCKERs, 2 SHOULD-FIX, 4 NIT.**

The XOR integrity, type-confusion defenses, IDOR posture, and reversibility
are all sound and *tested at the level that matters* (pg_constraint catalog
assertions, real migration chain, cross-table smuggling test). The one
significant issue is deployment-shaped, not correctness-shaped: the
`entry_id` → `vocab_entry_id` rename breaks the blue/green expand/contract
discipline. Ruling below.

---

## SHOULD-FIX

### SF-1 · The rename breaks zero-downtime blue/green — ruling: keep it, but it FORCES a coordinated brief-downtime release

- `db/migrations/049_vocab_list_entries_multitype.up.sql:73-91` (the rename +
  DROP NOT NULL); self-flagged at `up.sql:59-62` ("NOT expand/contract …
  046-style brief-downtime window").
- Evidence of the break: the pre-049 server names `entry_id` in **every**
  list-membership query path — seed INSERT (`e85ed6a~1` vocabLists.ts:189,199),
  detail SELECT/JOIN/ORDER BY (:276-285), dup-check (:461-463), append INSERT
  (:488). The instant 049 applies, the still-active old color throws
  `42703 undefined_column` on the entire `/vocab/lists` surface until the LB
  flips. That is the same violation class as 046 (whose partial-unique swap
  invalidated the old color's `ON CONFLICT (user_id)` arbiter).
- **The safer option exists and is cheap:** an ADD-only expand — keep the
  column named `entry_id`, add `kgiu_entry_id` / `hanja_character_id`, the
  XOR CHECK, and per-target partial UNIQUEs keyed on `(list_id, entry_id)`.
  Old-color code keeps working untouched (its INSERTs always set `entry_id`,
  satisfying the XOR; its SELECTs still resolve), and the cosmetic rename
  ships later as a contract-phase migration once no old color can be serving.
  The rename buys naming uniformity with `vocab_cards.vocab_entry_id` —
  aesthetics, not correctness.
- **Ruling:** on pure expand/contract merits the rename is *not* worth the
  break, and a two-phase (expand now / rename later) split is the
  senior-engineer answer for a multi-instance deployment. However: this app
  is single-user on M, 046 already established the coordinated
  brief-downtime precedent, the up header documents the posture explicitly,
  and a second migration purely to rename a column carries its own risk
  budget. **Accepting the rename as shipped is defensible HERE — but it is a
  hard constraint on the release:**
  - **→ INTEGRATION REVIEWER:** 049 must NOT be applied while the old color
    is still serving. Sequence: quiesce → migrate → deploy new color →
    health-check → flip, as one coordinated release (046 protocol). There is
    no rollback-by-flip once 049 is in: the old color is schema-incompatible.
    If the integration plan for this branch assumed zero-downtime blue/green,
    that assumption is broken by this migration and must be called out in the
    deploy notes.

### SF-2 · Client is not multi-type-aware — coordination gate before any grammar/hanja add-UI ships

- The current client only speaks the legacy shape: `addListEntries` sends
  `entry_ids` (client/src/services/vocab.ts:365-372) and `removeListEntry`
  sends no `?type` (vocab.ts:374-382) — fine today, because the server keeps
  both back-compat paths (vocabLists.ts:477-492, 656-660).
- But two client sites assume `entry_id` alone identifies an item within a
  list, which stops being true the moment a list can hold mixed types
  (vocab 7 and grammar 7 may coexist — proven by
  vocabLists.test.ts:385-402):
  - `client/src/components/MyVocabLists.tsx:517` — React key
    `` `entry:${String(e.entry_id)}` `` collides across types → wrong-row
    rendering/reconciliation.
  - `MyVocabLists.tsx:526` + `vocab.ts:374-382` — remove always addresses the
    vocab column (server default, vocabLists.ts:658-660), so tapping remove
    on a grammar row would 404 (best case) or delete a same-numbered vocab
    row (worst case).
- Nothing in THIS slice is defective — the server's `(item_type, entry_id)`
  discriminator (vocabLists.ts:332-336) is exactly right. But the F-060/F-061
  client work must key on the pair and pass `?type=` before any UI can add
  grammar/hanja items. Flag to whoever owns the client slice.

---

## NIT

### N-1 · 049.down is not re-runnable (asymmetric with the guarded up)

`049_...down.sql:27` (`DELETE … WHERE vocab_entry_id IS NULL`) and `:43`
(`ALTER COLUMN vocab_entry_id SET NOT NULL`) reference `vocab_entry_id`
unguarded — a second execution against the already-reverted 012 shape errors
on the missing column. The runner's bookkeeping + single-tx atomicity
(ADR-013) makes this theoretical, but the up went to the trouble of catalog
guards (`up.sql:73-88`) and the down didn't; a `DO $$ … IF EXISTS` wrapper
would make the pair symmetric.

### N-2 · Seed path silently skips what the append path 404s

`POST /vocab/lists` with `seed_entry_ids` silently drops nonexistent ids and
already-member ids (vocabLists.ts:239-247, `WHERE EXISTS … AND NOT EXISTS`),
returning 201 with a smaller `appended`; `POST /:id/entries` 404s missing ids
(vocabLists.ts:544-560) and 409s duplicates (:568-585). Both contracts are
individually documented, but the same logical operation ("add these ids")
having opposite failure semantics on two endpoints is a surprise stored for a
future client author. Consider aligning seed to the strict contract, or at
least returning the skipped ids.

### N-3 · `TARGET_COLUMN` / `TARGET_TABLE` typed as `Record<ItemType, string>`

vocabLists.ts:87-98 — the values are interpolated into SQL (:550, :694).
The design is safe (keys come only from the closed Zod enum; values are
server-owned literals) and correctly commented, but typing them
`as const satisfies Record<ItemType, …>` would make the interpolation sites
literal-typed and let the compiler, not just the comment, forbid a widened
string ever reaching them.

### N-4 · CASCADE vs RESTRICT asymmetry has a product consequence worth remembering

`vocab_entry_id` keeps 012's RESTRICT; `kgiu_entry_id`/`hanja_character_id`
are CASCADE (up.sql:37-49, asserted from pg_constraint at
test_migration_049.py:327-338 — good). Intentional and spec'd, but note the
operational edge: a grammar/hanja corpus reload done as DELETE+reINSERT will
*silently* wipe users' grammar/hanja list memberships while the same reload
of vocab is blocked loudly. Fine for now; if a kgiu/hanja reloader ever gets
written, it needs to know this.

---

## What was checked and held (the adversarial pass)

- **XOR correctness:** exactly-one-non-NULL CHECK (up.sql:134-141) mirrors
  `ck_vocab_cards_target_xor` (001_core_schema.up.sql:715); two-target and
  zero-target inserts rejected at the DB level in BOTH test layers
  (test_migration_049.py:344-362; vocabLists.test.ts:548-570). Pre-049 vocab
  rows survive the reshape with values and positions in place, new columns
  NULL (test_migration_049.py:293-308) — the rename moves, never copies.
- **Per-target uniqueness:** three partial UNIQUEs created *before* the old
  constraint drops (up.sql:147-167); each proven to fire with its exact
  constraint name, same target allowed in a different list, same numeric id
  allowed under two types in one list (test_migration_049.py:364-421;
  vocabLists.test.ts:385-402).
- **Type-confusion:** item `type` is a closed Zod enum (vocabLists.ts:79);
  ids validated per-type against the RIGHT table via the server-owned map
  (:544-560); a real vocab id submitted as `type: 'grammar'` 404s
  (vocabLists.test.ts:404-415 — precisely the smuggling test this feature
  needed). The client never names a column or table.
- **IDOR:** every route resolves the list via
  `id = $1 AND user_id = $2 AND deleted_at IS NULL` and 404s (not 403s) on
  foreign/missing/soft-deleted ids; covered for GET/PATCH/POST-entries/
  DELETE-entries including the typed variants
  (vocabLists.test.ts:184-191, 222-229, 285-295, 438-448, 532-545).
- **Parameterization:** every user value is a bind parameter; the only
  interpolations are the two server-owned enum-keyed maps (see N-3).
- **Concurrency:** append serializes on `SELECT … FOR UPDATE` of the list row
  (vocabLists.ts:528-537) so position math and the dup-check→INSERT window
  can't race; the partial UNIQUEs back it at the DB level anyway.
- **ADR-013:** no top-level tx control in either file; idempotent up
  (catalog-guarded rename/constraints, `IF NOT EXISTS` elsewhere); down's
  destructive-gate blind spot (DELETE + DROP COLUMN evade
  `DESTRUCTIVE_PATTERNS`) explicitly documented per the 046 precedent
  (down.sql:14-17) rather than hidden.
- **Down reversibility:** best-effort loss (grammar/hanja memberships have no
  012 representation) is documented, tested, and confined to membership rows
  — reference rows survive, vocab memberships round-trip losslessly, and
  re-up after rollback is clean (test_migration_049.py:439-525).
- **B-013 closure:** end-to-end add-to-list works — client
  `ReviewVocab.tsx:366` → `addListEntries` (`entry_ids`) → legacy path →
  `vocab_entry_id`; create/remove wired in `MyVocabLists.tsx:100,376`; 409
  duplicate contract surfaced to the client (vocab.ts:361-364). The
  grammar/hanja widening is server-complete, client-pending (SF-2 — that is
  F-060/F-061 UI scope, not this slice).
- **nginx allow-list:** routes live under the existing `/vocab` prefix
  (app.ts:83) — no new top-level prefix, so the km-lb regex needs no change
  (the F-012 trap does not apply).

## PRAISE

- `test_migration_049.py` is a model migration test: real chain via
  `migrate.main()`, seeds in the pre-049 shape *before* applying 049, asserts
  FK delete rules from `pg_constraint` letters instead of prose, proves the
  CASCADE live with an actual reference-row delete, and closes the loop with
  down → re-up.
- The route header's threat model (vocabLists.ts:32-54) is specific enough to
  review against — each claim in it checked out in the code below it.
- The 409-not-silent-skip duplicate contract, and the deliberate rejection of
  `ON CONFLICT DO NOTHING` with the reasoning written down
  (vocabLists.ts:562-567), is exactly the kind of decision trail that keeps
  this codebase reviewable.

## Coordination summary

| To | Item |
|----|------|
| Integration reviewer | SF-1: 049 forces a coordinated brief-downtime release (migrate + deploy + flip as one unit; old color is schema-incompatible with 049 — no rollback-by-flip). |
| Client slice owner (F-060/F-061 UI) | SF-2: key list rows and deletes on `(item_type, entry_id)` and pass `?type=` before shipping any grammar/hanja add surface. |
| Future kgiu/hanja corpus reloader | N-4: DELETE+reINSERT reloads silently purge list memberships (CASCADE). |
