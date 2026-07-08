# Fixpass Aggregate — uploads U1b-rework

Scope: PDF/zip book-upload viewer + reorder. 3 independent Sonnet reviewers, none wrote the code.

## Verdict table

| Reviewer | Scope | Verdict | BLOCKER | SHOULD-FIX | NIT | PRAISE |
|---|---|---|---|---|---|---|
| A | server `uploads.ts` (GET /pages, PATCH /pages/order) | PASS WITH CONDITIONS | 0 | 2 | 3 | 5 |
| B | `UploadViewer.tsx` | PASS WITH CONDITIONS | 0 | 3 | — | (praised) |
| C | `services/uploads.ts` + `Uploads.tsx` + `UploadTypeModal.tsx` | PASS WITH CONDITIONS | 0 | 6 | 3 | 6 |
| **Total** | — | **PASS WITH CONDITIONS** | **0** | **11** | — | — |

## BLOCKERs
None.

## Cross-cutting (flagged by multiple reviewers)
- **Stale contract comment** in `client/src/services/uploads.ts:54–66` claims `GET /uploads/:id/pages` does NOT exist server-side and reorder will 404. **This is false** — Reviewers A and C BOTH read the live `server/src/routes/uploads.ts` and confirmed the route exists with the exact wire shape the client expects (`page_ids` as numbers, exact-set enforcement; `book_pages.id` is BIGINT so client `Number(pid)` is safe). The stale comment actively MISLED Reviewer B into a false "reorder is dead / 404s" coordination note. Fixing the comment is the single highest-value cleanup.

## SHOULD-FIX (11)
Server (A):
- A-S1: 3 log sites use bare `getLogger()` instead of `req.log` → lose correlation-id traceability.
- A-S2: no regression test exercising the concurrent-PATCH `SELECT … FOR UPDATE` locking the code relies on.

Viewer (B):
- B-S1: per-page image retry re-requests the identical URL with no cache-bust → can dead-loop against the cache-friendly page route.
- B-S2: `submitMove` lacks an explicit in-flight guard; the Enter-key path bypasses the Move button's disabled state → concurrent reorders with a stale rollback baseline.
- B-S3: the `eslint-disable react-hooks/set-state-in-effect` is JUSTIFIED and hides no bug (verified via `--report-unused-disable-directives`), BUT its justifying comment defends the wrong hazard (cites the async abort-guard; the rule actually fires on the synchronous reset-on-`id`-change). Fix the comment, or drop the disable entirely via a key-based reset (cleaner).

Client (C):
- C-S1: the stale contract comment (same as cross-cutting above).
- C-S2: `client/src/lib/errorCopy.ts:108–113` shows pre-revision copy ("under 15 MB", "isn't a valid PDF") vs the new 300 MB / zip-or-PDF reality; conflates unrelated 400 causes (a >200-char title tells the user to "choose a different file").
- C-S3: title input has no client-side length cap (root of the misleading error above).
- C-S4: the Uploads list per-row "view" button isn't disabled during a pending delete on that same row.
- C-S5: large uploads (up to 300 MB) show no progress percentage.
- C-S6: fetch boundary (`services/api.ts`) uses unchecked generic casts rather than zod validation — **app-wide convention, NOT unique to this PR**; flagged for awareness, recommend DEFER to a follow-up ticket rather than fix in this pass.

## PRAISE (preserve — fix-pass must not undo)
- One-mounted-page memory bound + prefetch-next in the viewer.
- Exact-snapshot optimistic rollback (restores exact prior order).
- Thorough abort discipline / clean types in the viewer.
- Exact-set membership+size validation on PATCH order (not a length-only shortcut).
- Two-phase placeholder renumber, provably collision-free vs `UNIQUE(upload_id,page_number)` + `CHECK(page_number>0)` at all capped sizes.
- `SELECT … FOR UPDATE` serialization of concurrent PATCH/DELETE.

## Recommendation
No BLOCKERs → the feature is structurally sound. Dispatch a single fix-pass for the 10 actionable SHOULD-FIX (A-S1/2, B-S1/2/3, C-S1..S5), DEFER C-S6 (zod) to a follow-up ticket as an app-wide convention change. Then re-review.
