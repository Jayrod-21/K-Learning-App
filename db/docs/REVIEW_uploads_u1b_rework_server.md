# Review: uploads U1b-rework — server reorder contract

**Reviewer:** independent senior review (did not write this code)
**Scope:** `server/src/routes/uploads.ts` (566 lines, read in full), focused on
`GET /uploads/:id/pages` and `PATCH /uploads/:id/pages/order`, plus the shared
middleware/helpers it depends on (`middleware/auth.ts`, `middleware/errors.ts`,
`middleware/validate.ts`, `middleware/rateLimits.ts`, `services/uploadStore.ts`,
`db/pool.ts`) and migrations 040/041.
**Build:** `npm run build` in `server/` — clean, no errors.

## Summary verdict: **PASS WITH CONDITIONS**

The two routes under review are correct on every criterion that matters for
data integrity and access control: the reorder PATCH does a true exact-set
validation (size + membership, catching partial/superset/foreign-upload/
duplicate submissions), the two-phase placeholder renumber is provably
collision-free against `UNIQUE(upload_id, page_number)` and the
`CHECK(page_number > 0)` constraint at every input size up to the enforced
2000/3000-page caps, the whole reorder is one transaction with `SELECT ...
FOR UPDATE` row locks that correctly serialize concurrent PATCH/PATCH and
PATCH/DELETE on the same upload, and every query is parameterized and scoped
to `getUserId(req)` with a uniform 404 for "not mine" vs. "doesn't exist."
This is a well-built artifact. The "conditions" are: (1) a stale cross-agent
comment in the client that documents a contract gap this server PR actually
closes — leaving it will mislead the next reader/agent — and (2) a handful of
non-blocking observability/testing gaps (bare `getLogger()` instead of
`req.log` losing correlation IDs on three warn/error call sites; no
concurrent-PATCH regression test exercising the locking the code correctly
relies on).

## Bar checklist

Only rows applicable to a TypeScript/Express/PostgreSQL route file are scored;
Python-specific rows (§1) are N/A.

| Bar item | Verdict |
|---|---|
| §0 P0 Robust by default (I/O failure handling) | PASS — every route wrapped in try/catch → `next(err)`; blob cleanup failures are caught, logged, non-fatal by design |
| §0 P0 Security threat-modeled, attack named in comment | PASS — file header enumerates IDOR, path traversal, mass assignment, reorder-concurrency, page-serving sniff, each with the specific defense |
| §0 P0 Correct/standard/robust path, not the easiest | PASS — two-phase placeholder renumber instead of a shortcut (e.g. `ORDER BY` trick or deferred constraint) is the right call given `NOT DEFERRABLE` |
| §0 P1 Type safety end-to-end | PASS — `strict: true` + `noUncheckedIndexedAccess`, zero `any` in the file, zod at every boundary, `tsc` build clean |
| §0 P1 Fail closed / fail loud | PASS — ownership check throws before any mutation; unmatched sets throw before any UPDATE |
| §0 P1 Observable by default | **SHOULD-FIX** — see Finding SF1 (bare `getLogger()` vs `req.log` loses correlation ID on 3 call sites) |
| §0 P0 Clean tree (no dead code / debug residue) | PASS |
| §3.4 P0 BOLA/IDOR — object-level check on every request | PASS — every route re-checks `user_id` in the query itself, not just at a prior gate; PATCH additionally `FOR UPDATE`-locks the owning row |
| §3.4 P0 Mass assignment — server assigns identity, never trusts body | PASS — `.strict()` Zod schemas; `page_ids` is the only writable PATCH field |
| §3.5 P0 SQLi — parameterized queries only | PASS — 100% parameterized, including the `unnest($1::bigint[], $2::int[])` bulk updates |
| §3.5 P1 Input validation, allow-list, size caps | PASS — `MAX_ID` bound prevents int8 overflow via a 20-digit number passing `Number.isInteger`; `page_ids` capped at 3000, itself derived from the 2000-page ingest caps |
| §3.9 CORS/security headers on served content | PASS (page route) — `nosniff`, extension-derived content-type, never client-influenced |
| §4.1 P0 CHECK constraints for domain invariants | PASS — `ck_book_pages_page_number_positive`, `uq_book_pages_upload_number` (migration 041) |
| §4.6 P0 Explicit transaction boundaries, short transactions | PASS — `withTransaction` BEGIN/fn/COMMIT with ROLLBACK-on-throw (`db/pool.ts:128-150`); no network/external I/O inside the open transaction |
| §4.6 P1 Deadlock avoidance / lock ordering | PASS — both PATCH and DELETE lock `book_uploads` first, then `book_pages`, in the same order, every time |
| §4.7 P0 Never `SELECT *` | PASS — every query enumerates columns |
| §5.2 P0 Unhappy paths as first-class (boundary values) | PASS in tests — empty set, missing page, foreign page, duplicate ids, IDOR, non-numeric id all covered (`server/tests/routes/uploads.test.ts:721-812`) |
| §5.2 P0 Test concurrency where it exists | **SHOULD-FIX** — see Finding SF2 (no test exercises the two-PATCH-race the `FOR UPDATE` locks are there to prevent) |
| §5.6 (Vitest analog) MSW/network mocking discipline | N/A — server-side integration tests against a real test Postgres, not applicable |

## Findings

### BLOCKER
None.

### SHOULD-FIX
- **SF1** — `getLogger()` used instead of `req.log` on 3 call sites, dropping correlation ID from otherwise-legitimate warn/error logs (`server/src/routes/uploads.ts:198-201`, `:325`, `:531-534`).
- **SF2** — No regression test exercises concurrent `PATCH .../pages/order` (or PATCH-vs-DELETE) on the same upload; the correctness of the `FOR UPDATE` locking is argued from reading the code, not demonstrated by a test.

### NIT
- **N1** — `GET /uploads/:id/pages` does its ownership check and its page-list `SELECT` as two separate non-transactional queries (`server/src/routes/uploads.ts:370-382`); a concurrent `DELETE` landing between them could make an about-to-not-exist upload return `200 {pages: []}` instead of `404`. Harmless (no data leak, matches "just deleted" semantics closely enough) but worth a one-line comment if it's deliberate.
- **N2** — `PLACEHOLDER_BASE = 1_000_000_000` is a magic number repeated only in the one comment above it; consider hoisting to a named module constant next to `MAX_ID`/`PageOrderBodySchema`'s `.max(3000)` so the "well inside int4, well above the 2000/3000 page caps" invariant is enforced/documented in one place instead of by convention.
- **N3** — The duplicate-id check (`server/src/routes/uploads.ts:408-411`) runs before the transaction/ownership check, so a duplicate-id submission against another user's upload returns 400 instead of 404. Not an IDOR leak (the check never touches the DB, so it reveals nothing about the target upload's existence), just a minor inconsistency in which validation error wins.

### PRAISE
- **P1** — The two-phase renumber's placeholder reasoning (`server/src/routes/uploads.ts:437-458`) is exemplary: it explicitly rules out the tempting shortcut (negative placeholders) by naming the exact constraint that would break (`CHECK(page_number > 0)` checked per-row, not deferred), and derives the placeholder base's safety from the actual page-count caps rather than asserting it. This is the right way to document a non-obvious invariant — a fix-pass must preserve this comment verbatim if the code around it changes.
- **P2** — The exact-set validation (`server/src/routes/uploads.ts:423-435`) is genuinely a size-and-membership check, not a subset/length-only check that a lazier implementation would ship — and it's covered by tests for every failure mode (omitted page, foreign page, duplicate, wrong upload).
- **P3** — Consistent, deliberate lock ordering between PATCH and DELETE (`book_uploads` row first, `FOR UPDATE`, in both handlers) closes a cross-route race that would be easy to miss if each route were reviewed in isolation.
- **P4** — IDOR handling is uniform and disciplined across all five routes: every "not mine" and every "doesn't exist" collapses to the identical 404, including the deliberately-folded `page/:n` "not your upload" vs. "n out of range" case — no route lets an authenticated attacker distinguish "exists, not yours" from "doesn't exist."
- **P5** — The `MAX_ID = Number.MAX_SAFE_INTEGER` bound and its comment (`server/src/routes/uploads.ts:98-103`) heads off a real bug class (a 20+ digit id string passing `Number.isInteger` in JS but overflowing Postgres `int8`) that's easy to miss when reasoning about "just coerce to number."

## Detailed findings

### SF1 — correlation ID lost on 3 warn/error log sites
`server/src/routes/uploads.ts:198-201` (POST, blob cleanup after replace),
`:325` (page-stream error), `:531-534` (DELETE, blob cleanup) call
`getLogger()` directly rather than `req.log` (the per-request child logger
bound with `correlationId`, set up in `middleware/correlation.ts` and used
correctly by the shared `errorHandler` in `middleware/errors.ts:96-118`). Bar
§1.9/§3.12: "structured logs with correlation IDs... through every request."
These three sites are genuine failure paths (a stream error, an orphaned
blob) — exactly the events an operator would want to correlate back to the
originating request via `correlationId`, and currently can't. Low severity
(the events are still logged, just not correlatable), but a one-line fix
(`req.log.warn(...)` instead of `getLogger().warn(...)`) each. Not scored as
a BLOCKER because it degrades debuggability, not correctness or security.

### SF2 — no concurrency regression test for the reorder lock
`server/tests/routes/uploads.test.ts:721-812` covers the reorder route's
validation contract thoroughly (exact-set, IDOR, duplicates) but has no test
that fires two `PATCH .../pages/order` (or a PATCH racing a DELETE) at the
same upload concurrently and asserts the second either serializes cleanly
after the first commits, or 404s if the first was a DELETE. The code's
correctness here is real (traced through `withTransaction` + the `FOR UPDATE`
locks on both `book_uploads` and `book_pages`), but per Bar §5.2 ("test
concurrency where it exists... never sleep-and-hope"), an un-tested
concurrency guarantee is one refactor away from silently regressing — e.g. if
a future change reorders the two `FOR UPDATE` selects, or moves the
`book_uploads` lock after the `book_pages` lock, nothing in CI would catch it.
Recommend one test: two concurrent `agent.patch(...)` calls with disjoint
target orders against the same upload, asserting the final DB state matches
exactly one of the two submitted orders (not an interleaved mix).

## Coordination observations

**Stale cross-agent contract-gap comment in the client (action needed, not a
server defect).** `client/src/services/uploads.ts:54-66` carries a "KNOWN
CROSS-AGENT CONTRACT GAP" comment stating that `GET /uploads/:id/pages`
"does NOT exist on that server commit" (commit `82ea4c2`) and that "the
reorder tool's initial load will 404 in the running app." The server route
under review here (`server/src/routes/uploads.ts:355-390`) implements exactly
that route, with the exact response shape (`{ pages: [{ id, page_number }] }`)
the client already expects (`client/src/services/uploads.ts:108-111`,
`179-185`) — the gap this comment describes is closed by this PR. Leaving the
comment as-is will cause a future reader (human or agent) to believe the
reorder tool is still broken and either duplicate this work or waste time
re-diagnosing a 404 that no longer happens. Recommend the client-side owner
delete or update that paragraph in the same change window that merges this
server work — this is a documentation-sync action item, not a code defect on
either side.

**Wire contract match confirmed.** Verified field-by-field: server's page id
(`BIGINT` → returned as a JS string by node-postgres, per
`server/src/routes/uploads.ts:379-385` and `:468-472`) matches the client's
`PageWire.id: string` (`client/src/services/uploads.ts:103-106`); both GET
and PATCH return the identical envelope shape by design (server comment at
`server/src/routes/uploads.ts:350-352` states this explicitly and it holds).
No action needed — noted so a fix-pass doesn't accidentally diverge the two
shapes while addressing SF1/SF2.

**Design-doc alignment.** The reorder mechanism (`PATCH
/uploads/:id/pages/order`, mutable `page_number`, `book_pages.id` as the
stable identity used by the client) matches
`db/docs/PDF_UPLOAD_DESIGN.md` §"PAGE ORDER" exactly, including the detail
that `page_number` — not blob filename — is the source of truth for order.
Migrations 040/041 back this correctly: `uq_book_pages_upload_number` is the
constraint the two-phase renumber is built around, and `book_uploads.blob_ref`
was correctly dropped in 041 now that pages, not a single blob, are the unit
of storage.
