# BUILD b9 — F-059 · manual OCR trigger + F-056 · Grammar saved-from-uploads

**Branch:** `feat/b9-uploads-ui` (worktree off `rebuild`)
**Tickets:** F-059 — the viewer's "Extract text" button, wired to the F-108/U2
backend that Batch 8 shipped; F-056 — the Grammar "Uploads" saved-from-uploads
section (the F-053/F-107 vocab mirror); plus two Batch-5 re-review carry-over
NITs in the saved-from-uploads path.

## What was built

| Piece | File |
|---|---|
| F-056 server read | `server/src/routes/grammar.ts` (`GET /grammar/saved-from-uploads`) |
| F-056 client section | `client/src/pages/review/ReviewGrammar.tsx` (`GrammarSavedFromUploads`) + `.css` |
| F-056 service fn + types | `client/src/services/grammar.ts` (`fetchGrammarSavedFromUploads`), `client/src/types/domain.ts` |
| F-059 viewer wiring | `client/src/pages/UploadViewer.tsx` (live button, status strip, fixed-copy errors) + `.css` |
| F-059 service fns + types | `client/src/services/uploads.ts` (`startExtraction`/`listExtractions`), `client/src/types/domain.ts` |
| NIT-A fix (both pages) | `client/src/pages/review/ReviewVocab.tsx` + the new grammar section |
| NIT-B tests (both routes) | `server/tests/routes/vocab.test.ts`, `server/tests/routes/grammar.test.ts` |
| Client tests | `UploadViewer.test.tsx`, `ReviewGrammar.test.tsx`, `ReviewVocab.test.tsx`, `services/uploads.test.ts`, `services/grammar.test.ts` |

**No migration needed.** F-056 reads `grammar_entries.source_upload_id`, which
migration 068 (Batch 5, F-107) already created together with its partial index
(`ix_grammar_entries_source_upload` — its comment names this exact read as the
index's purpose).

## Design decisions

### F-056 — user-SAVED vs extracted semantics

The Grammar Uploads view now has two honestly-separate surfaces, because the
data is two different things:

- **Saved** (`GET /grammar/saved-from-uploads`, new): patterns the USER banked
  via `POST /grammar/bank` with a `source_upload_id` — F-107's user-saved
  provenance on the user-scoped `grammar_entries` table. This is the exact
  mirror of Review→Vocabulary's F-053 "My uploads" section and renders the
  same way (grouped `CollapsibleTile`, honest-null when empty).
- **Extracted** (pre-existing): everything a book's OCR runs digitised
  (`GET /grammar/kgiu?source_upload_id=`, F-108's extracted-corpus provenance
  on the shared `kgiu_entries` table).

The saved read mirrors the vocab route's whole contract: `{ groups, total,
truncated }`, a 500-row defensive cap with a one-row sentinel over-fetch, and
the WHOLE-groups guarantee (a group the cap would split mid-group is dropped
entirely, never returned looking complete). It is simpler than the vocab twin
on purpose — `grammar_entries` is user-scoped with a single save path, so
`savedAt` is just the bank row's `created_at` and there is no card/list-add
dedup CTE.

### F-059 — trigger shape

- The POST sends an **empty body**: omitting the optional page range asks the
  server for its own "resume after the last done run" default slice (10 pages,
  half the 20-page ceiling) — the client never computes a range, so it can
  never blindly send the whole book.
- The server pipeline is **synchronous** (the POST response IS the settled
  run), so the button's own lifecycle is busy-in-flight → settled run in the
  status strip. A per-call 5-minute axios timeout replaces the app-wide 10 s
  default (a legitimate 10-page Vision run takes minutes).
- **No poll loop.** `GET /uploads/:id/extract` seeds the history when the
  viewer becomes viewable; if its latest run is live (another tab, or an
  orphan the stale-reap hasn't settled), the button disables honestly and a
  manual "Refresh status" re-reads the GET. Runs settle inside the triggering
  request in this design, so a background timer would only ever serve that
  edge case — the refresh button covers it without anything to leak.
- **Fixed copy for every documented error** (server prose never echoed,
  including the run row's own `error` column): 409 → already running (also
  re-reads the history so the implied live run becomes visible), 429 → daily
  limit with the structured numeric `retry_after` hint when present, 400 →
  bad range, 404 → not found.
- The wire mapping deliberately drops `upload_id` (always the id asked about)
  and `error` (prose) — enforced by a service test.

### Carry-over NITs (Batch-5 re-review)

- **NIT-A** — the degenerate `truncated: true` + zero groups response (one
  group bigger than the cap was dropped whole) was invisible client-side:
  ReviewVocab's early `return null` on empty groups made the truncation note
  unreachable. Both the vocab section and the new grammar section now return
  null only when `groups` is empty AND `truncated` is false; the degenerate
  case renders the tile with the note (the only signal that saves exist).
  Pinned by client tests on both pages.
- **NIT-B** — no test pinned the exact-cap-total UNtruncated boundary (total
  exactly 500, `truncated: false`), so a `>` → `>=` regression would have
  slipped every existing over/under test. Both `/vocab/saved-from-uploads`
  and the new `/grammar/saved-from-uploads` now have an exact-boundary
  server test (490+10 rows across two uploads → both groups whole,
  `truncated: false`, `total: 500`).
- The third B5 NIT (a cosmetic arithmetic slip in merged FIX_REPORT prose)
  was skipped per the batch brief.

## Security notes

- `GET /grammar/saved-from-uploads` is user-scoped on BOTH legs: bank rows by
  `g.user_id = $1`, uploads by `bu.user_id = $1` **on the join** — a row
  tagged to an unowned upload (only reachable by an out-of-band DB write;
  the bank route 404s cross-user tags at write time) yields no row, so
  another user's upload title can never leak. A server test seeds exactly
  that out-of-band row and proves the read hides it. Fully parameterized,
  read-only, soft-deleted rows excluded, no client-controlled paging
  (server-side row cap instead).
- The F-059 client assumes nothing about POST success: every documented
  server fence (ownership 404, range 400, one-live-run 409, daily-cap 429)
  surfaces as its own fixed message, and rate/abuse control stays entirely
  server-side.

## Gate results

- Client: `npm run lint` → 0 problems · `tsc -p tsconfig.app.json --noEmit`
  → 0 errors · `vitest run` on the 5 touched test files → **207 passed**
  (147 page + 60 service) · `vite build --outDir /tmp/km-b9-dist` → success.
- Server: `npm run typecheck` → 0 errors · `vitest run
  tests/routes/grammar.test.ts tests/routes/vocab.test.ts` (testcontainer)
  → see the batch report (run at commit time).

## Follow-ups

- The F-059 status strip shows the latest run only; a "run history" list
  (all 50 the GET returns) is available on the wire if a future ticket wants
  it.
- `BUGS_AND_FEATURES.md`'s F-056/F-059 entries still describe the pre-batch
  state; left untouched here (the backlog doc is maintained on its own
  branch cadence) — update on the next backlog sweep.
