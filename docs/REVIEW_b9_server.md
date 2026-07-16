# REVIEW — B9 server half (F-056 `GET /grammar/saved-from-uploads` + B5 NIT-B boundary tests)

Reviewer: independent senior review, branch `feat/b9-uploads-ui` vs `origin/rebuild`.
Scope: `server/src/routes/grammar.ts` (new route), `server/tests/routes/grammar.test.ts`,
`server/tests/routes/vocab.test.ts` (NIT-B test). Reference (not reviewed): `server/src/routes/vocab.ts`
`GET /vocab/saved-from-uploads`, migration 068.

## Summary verdict

**PASS — 0 BLOCKER, 0 SHOULD-FIX, 3 NIT, 4 PRAISE.**

Route is a faithful security + envelope mirror of the vocab twin. Every bar item verified against
code AND live testcontainer runs, not just read: all 15 saved-from-uploads tests pass
(`vitest run … -t "saved-from-uploads"` → 2 files, 15 passed); a deliberate `>` → `>=` mutation of
the truncation comparison (grammar.ts:463) was applied, run, **caught by the new exact-cap test**
(1 failed), and reverted — worktree left clean. `tsc --noEmit` → 0 errors. ESLint on the three
files → 0 errors, 7 warn-level `no-non-null-assertion` (same idiom the vocab route already carries).

## Bar checklist

| Bar item | Verdict | Evidence |
|---|---|---|
| User-scoped: `g.user_id = $1` | PASS | `server/src/routes/grammar.ts:445` |
| Ownership predicate ON the `book_uploads` join (`bu.user_id = $1`) | PASS | `server/src/routes/grammar.ts:444` — predicate on the join, so an unowned tag yields no row, never an error/oracle |
| `deleted_at IS NULL` | PASS | `server/src/routes/grammar.ts:446` (`grammar_entries.deleted_at` exists, 001_core_schema.up.sql:580). `book_uploads` has NO `deleted_at` — hard-deleted by design (040_book_uploads.up.sql table comment), so no filter is missing on either route |
| No cross-user title leak | PASS | test seeds an out-of-band cross-tagged row directly in DB and proves the READ hides it — `server/tests/routes/grammar.test.ts:754-792` |
| Parameterized SQL only | PASS | single query, binds `$1`/`$2` only (`grammar.ts:421-451`); no string interpolation |
| `{ groups, total, truncated }` faithful vocab mirror | PASS | truncation/sentinel/group-fold logic is line-for-line identical to `vocab.ts:957-967`; `total` = `COUNT(*) OVER ()` window (runs before LIMIT → full count, `grammar.ts:434`) |
| Whole-group cap (never a partial group) | PASS | sentinel-same-group → whole trailing group filtered (`grammar.ts:463-473`); contiguity guaranteed by `ORDER BY bu.created_at DESC, bu.id DESC` (`grammar.ts:447`); exercised by real 505-row mid-group split test (`grammar.test.ts:820-849`) |
| Sentinel over-fetch cap+1, no off-by-one | PASS | `LIMIT $2` = cap+1 (`grammar.ts:451`), `rows.length > CAP` (`grammar.ts:463`); exactly-500 → 500 rows fetched → `truncated:false`. **Mutation-verified** (see verdict) |
| `total`/`truncated` honest | PASS | window count unaffected by LIMIT; over-cap test pins `total: 505` while only 10 entries return (`grammar.test.ts:843-848`) |
| Grouping/dedup correct | PASS | no dedup CTE needed — `UNIQUE (user_id, pattern_key)` (001_core_schema.up.sql:586) means one row per (user, pattern); vocab's `first_saves` CTE exists only because vocab has two save paths. Simplification is justified, not a divergence |
| Strict TS at the boundary | PASS | typed `query<>` row shape, explicit `Number()` for pg BIGINT strings, ISO string for `saved_at` (`grammar.ts:487-500`); typecheck 0 errors |
| Auth required | PASS | `router.use(requireAuth)` (`grammar.ts:18`); 401 pinned in the auth table (`grammar.test.ts:54`) |
| Rate limiting mirrors vocab | PASS | `cheapLimiter()` on both (`grammar.ts:416`, `vocab.ts:880`) |
| No client-controlled paging | PASS | no query params parsed; server-side cap only |
| NIT-B exact-cap test on BOTH routes, catches `>=` | PASS | `grammar.test.ts:794-818`, `vocab.test.ts:1701-1728`; grammar one mutation-verified to fail under `>=` (TypeError on `rows[500]!` → 500 status, plus `truncated:true` — fails on both assertions) |
| No route shadowing | PASS | only static-path GETs at this level (`/kgiu/:id` is nested under `/kgiu`); `/saved-from-uploads` registered at `grammar.ts:416`, unreachable by any param route |

## Findings by category

### BLOCKER
None.

### SHOULD-FIX
None.

### NIT
1. **Grammar suite lacks the clean-boundary truncation mirror.** Vocab has three truncation
   shapes: mid-group split (`vocab.test.ts:1661`), truncated-but-sentinel-starts-new-group
   (500+5, `vocab.test.ts:1689`), exact-cap (`vocab.test.ts:1717`). Grammar has only mid-group
   + exact-cap. The missing case (`truncated:true`, all kept groups whole because the cap fell
   exactly on a group boundary) exercises the `sentinel.upload_id !== lastKept.upload_id`
   branch keeping all 500 rows. Logic is identical to vocab's so risk is low, but the suites
   are otherwise mirrors — one more ~15-line test closes the asymmetry.
2. **Stale comment: "category 'ending' is in the DB whitelist"** —
   `server/tests/routes/grammar.test.ts:650`. Migration 034 dropped
   `ck_grammar_entries_category_known`; category is free text with a 1–40 length CHECK
   (`034_grammar_entry_category_freetext.up.sql`). Harmless (the value is valid either way),
   but the comment asserts a constraint that no longer exists.
3. **~40 lines of truncation/sentinel/group-fold logic now duplicated** between
   `vocab.ts:957-1000` and `grammar.ts:463-501`. Two copies is tolerable under the explicit
   "mirror exactly" mandate and this codebase's self-contained-route style; if a third
   saved-from-uploads surface appears (hanja?), extract a shared
   `capWholeGroups(rows, cap)` helper first — manual divergence-checking is exactly what this
   review had to spend time on.

### PRAISE
1. **Read-side ownership proven independently of the write-side check** — the cross-user test
   (`grammar.test.ts:754-792`) seeds a bank row tagged to another user's upload via direct DB
   write (the only way to produce one, since `POST /bank` 404s cross-user tags at
   `grammar.ts:220-233`), then asserts B gets zero groups AND A never sees B's row. This tests
   the join predicate itself, not the happy path.
2. **The NIT-B boundary test is real, not decorative** — mutation run confirmed it fails loudly
   under a `>=` regression (both via `truncated:true` and via the 500-status TypeError path).
3. **Set-based `generate_series` bulk seeding** (`grammar.test.ts:652-667`) keeps 500-row
   fixtures at one round trip; the whole 15-test saved-from-uploads slice runs in ~24 s
   including two cap-scale fixtures.
4. **Honest degenerate-case documentation** — the zero-groups + `truncated:true` outcome is
   called out in the route comment (`grammar.ts:461-463` block) rather than left as a surprise,
   and the client-side NIT-A fix (out of this review's scope) is referenced by name.

## Detailed findings

- `server/src/routes/grammar.ts:414` — cap constant 500, same value/rationale as
  `vocab.ts:878`. Match confirmed.
- `server/src/routes/grammar.ts:426-451` — single SELECT; both ownership predicates present
  (444, 445); soft-delete filter (446); deterministic ORDER BY with id tiebreaks (447);
  `LIMIT $2` bound to cap+1 (451). `COUNT(*) OVER ()::text` (434) is computed before LIMIT per
  Postgres semantics, so `total` is the full matching count — verified by the over-cap test
  expecting `total: 505` with 501 rows fetched.
- `server/src/routes/grammar.ts:463-473` — sentinel comparison uses the raw pg string ids on
  both sides (`===` and `!==` on strings), consistent; the filter removes only the trailing
  contiguous run because the ORDER BY groups uploads contiguously.
- `server/src/routes/grammar.ts:487-501` — group fold preserves SQL order (Map for lookup,
  array for order); `Number()` conversions match the file-wide BIGINT-as-string convention.
- `server/tests/routes/grammar.test.ts:794-818` — exact-cap: 490 (newer) + 10 (older) = 500;
  asserts `truncated:false`, `total:500`, both groups whole. Correct construction: a `>=`
  regression flips `truncated` AND dereferences the missing sentinel — double-pinned.
- `server/tests/routes/grammar.test.ts:820-849` — over-cap: 10 + 495 = 505, cap lands
  mid-older-group; asserts exactly one whole group of 10 and `total:505`. This is the real
  split-group behavior, not a synthetic assertion.
- `server/tests/routes/vocab.test.ts:1701-1728` — vocab exact-cap twin, same 490+10 shape,
  additionally asserts group order by title. Consistent with the pre-existing vocab truncation
  tests it sits beside.
- Test isolation: `TRUNCATE grammar_entries, sessions, users RESTART IDENTITY CASCADE`
  (`grammar.test.ts:35-37`) cascades to `book_uploads` via its user FK — no fixture bleed
  between the cap-scale tests.

## Coordination observations

- **BUILD doc server claims verified accurate** (`docs/BUILD_b9_uploads_ui.md`): migration 068's
  index comment does name this read as its purpose (068 up.sql, `ix_grammar_entries_source_upload`
  COMMENT); the security-notes paragraph matches the code exactly. The doc's gate section defers
  server test results to "the batch report" — I ran them in this worktree: **2 files, 15 passed,
  0 failed** (plus typecheck 0 errors), so that gap is closed.
- **For the client reviewer:** the server deliberately can return `groups: []` with
  `truncated: true` (single group > 500 dropped whole). The B5 NIT-A client fix
  (`ReviewVocab.tsx` / `ReviewGrammar.tsx` — render the tile + note instead of `return null`
  when `truncated`) is the ONLY user-visible signal in that case; verify it on both pages.
- Cosmetic suite inconsistency: grammar tests write `String(Date.now())` in template literals,
  the vocab NIT-B test writes bare `${Date.now()}` — each matches its own file's local
  precedent; lint passes on both. No action needed.
- Mutation-check hygiene: the temporary `>=` mutation was reverted via `git checkout`;
  `git status --porcelain` confirms the worktree is clean apart from committed branch content.
