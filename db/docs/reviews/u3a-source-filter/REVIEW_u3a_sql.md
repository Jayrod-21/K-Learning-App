# U3a Review — Server SQL + Validation (`vocab.ts` / `grammar.ts` source-filter)

**Reviewer:** independent senior review (not the author)
**Scope:** `server/src/routes/vocab.ts` (`VocabSearchQuerySchema` + `GET /entries`),
`server/src/routes/grammar.ts` (`KgiuSearchQuerySchema` + `GET /kgiu`) — SQL and
Zod validation only, per the diff on `feat/u3-reader-tap-define`
(`git diff` confirms only these two route files changed, plus tests/seed helpers
which are out of scope for this review).

## Summary verdict: **PASS**

Both handlers correctly implement the U3a contract from `db/docs/U3_READER_DESIGN.md`
§U3a: the `source_upload_id` filter now actually filters, and it is airtight against
IDOR (a user cannot use another user's `book_uploads.id` to see rows tagged by that
upload — they get a normal `200` with zero rows, not an error, avoiding an
existence-oracle). Parameter numbering is correct in both routes; I traced every
`$N` to its array element and both are right. No BLOCKERs found.

## Findings by category

- **BLOCKER:** none.
- **SHOULD-FIX:** none.
- **NIT:** 2 (both cosmetic/comment-accuracy, see below).
- **PRAISE:** 3.

---

## Detailed findings

### NIT-1 — `vocab.ts:132-133` comment overstates soft-delete semantics

`server/src/routes/vocab.ts:132-133`:

```
-- soft/hard-deleted upload's id likewise matches nothing.
```

`book_uploads` has **no** `deleted_at` column — migration `040_book_uploads.up.sql`
explicitly documents it as hard-delete-only (`"book_uploads is HARD-deleted (no
deleted_at)"`, `db/migrations/040_book_uploads.up.sql:19-24`). There is no
soft-delete code path for this table today, so "soft/hard-deleted" is describing a
state that can't currently occur. The EXISTS guard is still correct for the only
state that *can* occur (hard-deleted → row gone → `EXISTS` false → zero rows, via
the `ON DELETE SET NULL` on `vocab_entries.source_upload_id` /
`kgiu_entries.source_upload_id`), so this is purely a comment-accuracy nit, not a
behavior issue. `grammar.ts:94` ("unowned/deleted upload") is more careful and
doesn't have this problem.

### NIT-2 — EXISTS guard is uncorrelated; could be written as a single correlated EXISTS

`vocab.ts:134-138` / `grammar.ts:96-100`:

```sql
AND ($6::bigint IS NULL
     OR (source_upload_id = $6::bigint
         AND EXISTS (SELECT 1 FROM book_uploads bu
                      WHERE bu.id = $6::bigint
                        AND bu.user_id = $7)))
```

The `EXISTS` subquery references only `$6`/`$7` — it never correlates to the outer
row (no reference to the entries table's `source_upload_id` inside the subquery).
Postgres will hoist this to a single `InitPlan` evaluated once per query execution,
so there's no per-row performance cost, but the redundancy (`source_upload_id = $6`
in the outer AND, `bu.id = $6` again in the subquery) could be simplified to one
correlated form:

```sql
AND ($6::bigint IS NULL
     OR EXISTS (SELECT 1 FROM book_uploads bu
                 WHERE bu.id = source_upload_id
                   AND bu.id = $6::bigint
                   AND bu.user_id = $7))
```

Purely stylistic — current form is correct and no less efficient. Not blocking.

---

## Praise (fix-pass must not undo)

1. **IDOR guard is airtight and byte-identical between the two routes.**
   `vocab.ts:134-138` and `grammar.ts:96-100` are structurally identical (mirrors
   the doc's "uniform behaviour with the existing user-scoping" requirement,
   `U3_READER_DESIGN.md:51`). Traced the logic: when `$6` (source_upload_id) is
   non-null, the row must BOTH carry that exact `source_upload_id` AND the
   `EXISTS` subquery must find a `book_uploads` row with that id owned by `$7`
   (`userId` from `getUserId(req)`, never client-supplied). If the id belongs to
   another user, `EXISTS` is false, the whole `OR` branch is false, and — because
   `$6` is non-null — the first branch (`$6::bigint IS NULL`) is also false, so
   the row is excluded. Confirmed against the test at
   `server/tests/routes/vocab.test.ts:190-211`
   ("cannot filter by another user's upload — ownership guard returns zero rows"),
   which asserts exactly this: `200` + `total: 0` + `entries: []`, not a `403`/`404`.
   Returning an empty `200` rather than a differentiated error is the correct
   choice — it avoids giving an attacker an oracle to enumerate other users'
   `book_uploads` ids by status-code, which the design doc explicitly called out
   as the goal ("so it can't be used to probe another user's book_uploads ids").

2. **Parameter numbering verified correct in both routes, including the
   limit/offset renumbering.** Diffed against the prior version: both routes
   previously ended `LIMIT $6 OFFSET $7`; the two new params
   (`source_upload_id`, `userId`) were inserted at `$6`/`$7` and limit/offset
   correctly bumped to `$8`/`$9` in both the SQL text *and* the JS params array,
   in both files. I checked every placeholder against its array element by
   position (`vocab.ts:118-152`, `grammar.ts:82-114`) — no off-by-one, no stale
   `$6`/`$7` reference left over from the pre-change SQL.

3. **Zod bounds correctly close the known overflow class for this codebase.**
   `source_upload_id: z.coerce.number().int().positive().max(MAX_ID).optional()`
   (`vocab.ts:79`, `grammar.ts:55`) matches the established pattern documented at
   `vocab.ts:44-48` / `grammar.ts:29-32` (bounding against `Number.MAX_SAFE_INTEGER`
   so a 20-digit garbage value 400s via Zod instead of overflowing `int8` in pg
   and surfacing as an unhandled `22003`/500). `.positive()` correctly rejects `0`
   and negatives (upload ids are `GENERATED ALWAYS AS IDENTITY`, starting at 1) —
   confirmed against `vocab.ts:221-225` / `grammar.ts:235-238`, which assert `abc`,
   `-1`, and `0` all 400 before reaching pg.

## Coordination observations

- The design doc's own "What already exists" recon (`U3_READER_DESIGN.md:23-28`)
  accurately predicted the pre-change state (param silently dropped, no SQL
  branch) — the diff closes exactly that gap and nothing more. `git diff` for
  these two files shows a surgical, minimal change: new Zod field, new
  `getUserId` call, new `AND` clause, and the mechanical `$6/$7 → $8/$9` shift —
  no unrelated changes to the `domain`/`book_level`/`corpus`/`proficiency`
  filters, which are all still present and functioning identically to before.
- Test coverage (out of this review's scope, but noted for coordination) already
  exercises exactly the cases this review probed: owned-upload narrowing,
  omitted-filter passthrough, cross-user ownership denial (zero rows), a
  non-existent upload id (zero rows, not 404), and the `abc`/`-1` boundary
  rejections — see `server/tests/routes/vocab.test.ts:152-226` and the mirrored
  `describe` block in `grammar.test.ts:198-238`. This gives good confidence the
  contract asserted here is pinned, not just true today.
- No `client/` changes are in this diff — per the design doc, `SourceFilterRow`
  and the client's threading of `source_upload_id` were already wired
  (§"Source-filter UI — mounted but inert"); this change is purely the
  server-side half of the round-trip and doesn't touch the client.
