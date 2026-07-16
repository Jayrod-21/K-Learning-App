# FIX REPORT — Batch 5 fix-pass (F-107 upload provenance + F-102 /images re-entry)

Fix-pass agent, 2026-07-16. Branch `feat/b5-uploads-provenance` @ worktree.
Inputs: `REVIEW_b5_server.md` (PASS WITH CONDITIONS — 0 blockers, 2 should-fix, 4 nits) and
`REVIEW_b5_client.md` (PASS — 0 blockers, 2 should-fix, 5 nits).
Scope = the 4 SHOULD-FIX items. Migration 068 untouched (no re-run of `test_migration_068.py` needed).

## Disposition — should-fixes (4/4 FIXED)

| Finding | Disposition | Fix |
|---|---|---|
| **Server SF-2** — `GET /vocab/saved-from-uploads` truncates silently at 500 rows and can split the last group mid-group | **FIXED** | The route now returns `{ groups, total, truncated }`. `total` = the user's full saved-with-provenance word count via `COUNT(*) OVER ()::text` (the same window idiom this file already uses twice in `GET /vocab/entries` and `/vocab/mastery`); `truncated` = the cap trimmed the response. Whole-group guarantee: the query over-fetches ONE sentinel row past the cap — if the sentinel belongs to the same upload as the last kept row, the cap split that group and the entire trailing group is dropped (its rows are the ordered tail, so an upload-id filter removes exactly that run); if the sentinel starts a new group, every kept group is already whole. Degenerate case (one group > 500 rows → zero groups + `truncated: true`) is documented at the fold. Propagated end-to-end: `SavedFromUploadsResponse` gains `total`/`truncated` (`client/src/types/domain.ts`), `fetchSavedFromUploads` now returns the full envelope (`client/src/services/vocab.ts`), and the `SavedFromUploads` consumer (`client/src/pages/review/ReviewVocab.tsx`) renders a quiet bilingual "Showing your most recent saves only / 최근 저장 항목만 표시됩니다" note when `truncated` — styled like the page's other secondary state text (`.km-vocab__savedUploadsTruncated`, ReviewVocab.css). Tests (server, real testcontainer DB, set-based `generate_series` bulk seeding so 500+-row fixtures stay fast): (1) 505 rows straddling the cap mid-group → `truncated: true`, `total: 505`, the split group is absent and the surviving group is whole; (2) the cut landing EXACTLY on a group boundary → the 500-row group is kept whole (not over-dropped), `truncated: true`; (3) the existing empty + grouped tests now pin `total`/`truncated` for the un-capped path. Client tests: truncation note shown when `truncated: true`, absent when false (ReviewVocab.test.tsx). |
| **Server SF-1** — shared-`vocab_entries` provenance: a 2nd user mining the same lemma gets 201 but their tag is silently discarded | **FIXED** (documented-tradeoff path, per the fix brief — no re-architecture) | (a) The upsert's F-107 comment in `server/src/routes/vocab.ts` now carries an explicit `ACCEPTED TRADEOFF (single-user scope, tracked as F-199)` block spelling out the consequence (a second user's 201 silently drops their tag; the word never appears in that user's saved-from-uploads) and the correct future model (provenance on the user-scoped save artifact, `vocab_cards`). (b) Follow-up ticket **F-199** filed in `BUGS_AND_FEATURES.md` (new section "Batch 5 follow-up — surfaced by the uploads-provenance fix-pass", status open, priority P4, category multi-user correctness, full What/Why/Key-files/Fix-hint in the existing ticket format). No cheap in-place fix exists without re-architecting: any per-user provenance needs the tag on `vocab_cards` or a `(user, entry, upload)` association table — i.e. a migration + read rewrite, exactly the re-architecture the brief excludes. Behavior unchanged; the "first write wins" test still pins it. |
| **Client SF-1** — stale doc comment `client/src/services/vocab.ts` (`SearchEntriesOptions.source_upload_id`) claims no `vocab_entries` row can carry `source_upload_id` | **FIXED** | Comment rewritten to match this branch's reality: LIVE as of F-107 — `POST /vocab/mine` writes `vocab_entries.source_upload_id`, so the U3a filter returns those user-mined rows (owner-scoped, unowned id → zero rows); U2's PDF extraction will additionally populate the column for loader-extracted entries. The same falsified claim in the sibling `client/src/components/SourceFilterRow.tsx` module doc (client review NIT-4, explicitly folded into this item by the reviewer's coordination note §2) was corrected in the same pass: vocab rows can now carry provenance, `kgiu_entries` still cannot until U2, both paths fully wired. Comment-only — no behavior change, no test needed. |
| **Client SF-2** — no unit coverage for `fetchSavedFromUploads` | **FIXED** | New `describe('fetchSavedFromUploads')` in `client/src/services/vocab.test.ts`, matching the file's exact style (`vi.spyOn(api, 'get').mockResolvedValueOnce(...)` + call-shape assertion, as in `getEntry`/`mineWord`): (1) happy path — GETs `/vocab/saved-from-uploads` with the threaded `signal` and returns the full envelope; (2) empty case — `{ groups: [], total: 0, truncated: false }` passes through untouched, and no signal → `undefined` options (the fn's exact call shape); (3) the `truncated` flag + full `total` surface when the server capped the response. |

## Nits and praise

- NITs N-1…N-4 (server) and NIT-1/2/3/5 (client): out of scope per the fix brief (none were in a file whose edit made them trivially free — the only exception taken was client NIT-4, folded into Client SF-1 above at the reviewer's own direction).
- All PRAISE items verified intact: the in-transaction ownership check + constraint-scoped 23503 → 404 race handling is untouched; the cross-user attack tests, the honest-null F-053 states, the F-102 pinning tests, and migration 068 are all unmodified (068 not renumbered, not edited).

## Gate results (run by this fix-pass, not trusted from the reviews)

| Gate | Result |
|---|---|
| client `npx tsc --noEmit` | 0 errors (no `typecheck` script exists; `tsc` invoked directly, matching the client review's gate) |
| client `npm run lint` (eslint .) | clean |
| client `npx vitest run src/services/vocab.test.ts src/pages/review/ReviewVocab.test.tsx src/pages/ReviewLibrary.test.tsx` | 98/98 pass |
| client `npx vite build --outDir /tmp/km-b5fix-dist` | success |
| server `npm ci` + `npm run typecheck` | 0 errors |
| server `npx vitest run tests/routes/vocab.test.ts tests/routes/grammar.test.ts` (testcontainer) | 196/196 pass (2 files), 268.8s — includes the 2 new truncation tests and the extended empty/grouped assertions |

## Self-assessment vs the bar

- Every behavioral change carries a real test that fails on the pre-fix code: the mid-group-split test seeds the exact 505-row shape whose old response returned a complete-looking 495-row lie; the boundary test guards against the over-eager fix (dropping a group that was actually whole); the client note test pins the new signal's only user-visible surface.
- The truncation design keeps the wire contract honest without adding pagination the personal-scope app doesn't need — `total` + `truncated` + whole-groups is the smallest API that makes the cap observable, and it reuses the file's established `COUNT(*) OVER ()` idiom rather than a second round-trip.
- SF-1 was deliberately NOT "fixed" in code: the reviewer's own analysis says the correct model is per-user provenance, which is a schema change. The documented-tradeoff-plus-ticket path is what the brief prescribes and what single-user scope justifies; F-199 keeps it from ossifying.
- No praise item was disturbed; migration 068 untouched; no scope creep beyond the reviewer-directed sibling-comment fix.
