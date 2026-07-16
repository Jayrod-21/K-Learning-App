# Build b5 — F-107 upload provenance + F-102 `/images` re-entry

Branch: `feat/b5-uploads-provenance` (off `origin/rebuild` @ `f01bdc4`).

## F-107 — Upload provenance on save paths + saved-from-uploads read

### What already existed vs. what was missing (verify-before-build)

The pre-build brief suggested the vocab-save half might already be done
("`POST /vocab/mine` already accepts+persists `source_upload_id`, schema
~line 87, insert ~line 162"). **That turned out to be wrong on this branch:**
line 87 of `server/src/routes/vocab.ts` is `VocabSearchQuerySchema` — the U3a
**read filter** on `GET /vocab/entries` — and line 162 is that query's bind
array. `MineBodySchema` had no `source_upload_id`, and the mine upsert never
wrote the column. So the vocab-save half was built here, not skipped.

What genuinely existed already:

- `vocab_entries.source_upload_id` + `kgiu_entries.source_upload_id`
  (migration 040, nullable FK → `book_uploads`, ON DELETE SET NULL) — so the
  **vocab** side needed **no new migration**.
- The U3a ownership-guarded read filters (`GET /vocab/entries` /
  `GET /grammar/kgiu` `?source_upload_id=`).
- The reserved `SavedFromUploads` client stub in
  `client/src/pages/review/ReviewVocab.tsx` (F-053, rendered `null` with a
  documented "backend can't supply this yet" contract).
- ReviewGrammar's F-056 "Uploads" view — already wired to real endpoints
  (`GET /uploads` + `GET /grammar/kgiu?source_upload_id=`), i.e. the
  *extracted-corpus* provenance surface. It reserves **no** saved-from-uploads
  section, so the new read endpoint is vocab-only (matching the reserved UI).

### What was added

**Migration `068_grammar_entries_source_upload`** (up + down, F-088 markers)
— required because `grammar_entries` (the user-scoped table
`POST /grammar/bank` writes; F-107's *user-saved* provenance, distinct from
F-108's corpus provenance on `kgiu_entries`) had no `source_upload_id`.
Nullable BIGINT FK → `book_uploads`, ON DELETE SET NULL, named constraint
`fk_grammar_entries_source_upload`, partial index. Up declared
non-destructive, down declared destructive (DROP COLUMN), both idempotent
(`IF NOT EXISTS`/`IF EXISTS`). Per-migration pytest
`db/tests/test_migration_068.py` follows the 046–067 convention (marker
classification, FK shape, SET NULL behavior, gated down, clean re-up).

**Server, `POST /vocab/mine`** — optional `source_upload_id`
(int/positive/`MAX_ID`-bounded). Ownership validated inside the existing
transaction *before* anything persists: one combined id+ownership `SELECT`
(nonexistent and unowned ids both 404 identically — no existence oracle).
Persisted on the shared `vocab_entries` upsert with **first-write-wins**
(`COALESCE(existing, EXCLUDED)`) — same no-clobber rule the shared gloss
already uses, so no user can re-tag an entry someone else tagged. A scoped
23503 catch maps the check→insert race (concurrent upload delete) to the
same 404.

**Server, `POST /grammar/bank`** — exact mirror: same schema field, same
in-transaction ownership check (route now uses `withTransaction`), value
persisted on the user-scoped `grammar_entries` upsert with the same
first-write-wins COALESCE (consistent with `discovered_via`, which the
upsert also never rewrites), same scoped 23503→404 race guard.

**Server, `GET /vocab/saved-from-uploads`** — user's saved vocab grouped by
upload. "Saved" = a live card (`vocab_cards`) **or** a live-list membership
(`vocab_list_entries` joined through the user's `vocab_lists`) — deduped per
entry, earliest save wins. Joined to `vocab_entries.source_upload_id` →
`book_uploads` with `bu.user_id = $1` **on the join**, so another user's
uploads/titles can never appear. No query params (nothing client-controlled);
server-side row cap (500). Shape:
`{ groups: [{ upload: { id, title }, entries: [{ id, korean, english, savedAt }] }] }`,
groups newest-upload-first, entries newest-saved-first.

**Client** — `fetchSavedFromUploads()` in `services/vocab.ts`;
`SavedFromUploadEntry`/`SavedFromUploadsGroup`/`SavedFromUploadsResponse` +
`MineWordInput.source_upload_id` in `types/domain.ts`; the reserved
`SavedFromUploads` section in `ReviewVocab.tsx` now fetches and renders a
`CollapsibleTile` ("My uploads / 내 업로드") of per-upload groups — and per the
F-053 contract renders **nothing** when there are no groups (and, best-effort,
on fetch failure — supplementary shelf, same posture as the theme-filter
fetch). Small colocated CSS in `ReviewVocab.css`.

### Security notes (enumerated)

- **Cross-user upload tagging** (attacker passes someone else's upload id on a
  save): in-transaction ownership check → 404, nothing persists (tests prove
  rollback: no entry, no card, no bank row).
- **Existence oracle**: unowned and nonexistent ids return identical 404s.
- **Cross-user read leak**: saved-from-uploads scopes cards, lists, AND
  uploads to the session user; a user holding a card on a shared entry tagged
  to someone else's upload sees nothing (test-pinned).
- **Shared-row clobber**: first-write-wins COALESCE on both upserts; a second
  user cannot re-point provenance (test-pinned).
- **Injection/overflow**: all SQL parameterized; ids bounded by
  `MAX_SAFE_INTEGER` (int8-safe), garbage 400s at the zod boundary.
- **TOCTOU race**: constraint-scoped 23503 → 404 mapping on both save paths.

## F-102 — `/images` in-app re-entry point

**Chosen home: a Library row** (`client/src/pages/ReviewLibrary.tsx`), added
as `sectionFor('images', 'plain')`, LAST in the shelf order under Uploads.

Why this and not the alternatives the ticket floated:

- The Library **is** where the entry point lived before F-042 removed it, and
  `ReviewLibrary.tsx`'s own header already pointed at F-102 as the re-entry
  ticket. Restoring a row there is pure pattern reuse — the `images` NavItem
  (label/eyebrow/icon/path) never left `lib/nav.ts`, and `sectionFor()` is the
  exact recipe every other shelf uses. Zero new patterns.
- The **LEARN hexagon launcher** would break the launcher's route-namespace
  convention (all seven entries live under `/learn/*`; `/images` does not),
  and image mining is a library-of-your-own-material concern, not a study
  loop.
- **Folding into Uploads/chat image capture** is the pending P4 IA decision —
  out of scope for a P3 discoverability restore.

Placement: last, next to Uploads (both are "your own material" surfaces),
tone `plain` matching Uploads. The pinning test
(`ReviewLibrary.test.tsx`) was updated: five sections, order, per-row
navigation (including Images → `/images`), CityCard/button counts.

## Gate results

| Gate | Result |
|------|--------|
| Client `npx tsc --noEmit` | 0 errors |
| Client `npm run lint` | clean |
| Client `npx vitest run ReviewLibrary.test.tsx review/ReviewVocab.test.tsx` | 58/58 pass |
| Client `npx vitest run services/vocab.test.ts` | 36/36 pass |
| Client `npx vite build --outDir /tmp/km-b5-dist` | success (scratch outDir per known `.tmp` EACCES env issue) |
| Server `npm ci` + `npm run typecheck` | 0 errors |
| Server `npx vitest run tests/routes/vocab.test.ts tests/routes/grammar.test.ts` | 194/194 pass (testcontainer, ~410 s; includes migration 068 auto-apply) |
| DB `pytest db/tests/test_migration_068.py` (pinned `python:3.12` container, per `Deploy/local-test.sh` recipe) | 7/7 pass |

## Follow-ups

- **Grammar saved-from-uploads read**: `POST /grammar/bank` now records
  provenance, but no read exposes it yet (the F-056 client view reads corpus
  provenance, which stays empty until F-108/U2). When a user-saved grammar
  grouping surface is wanted, either add `source_upload_id` to the
  `GET /grammar/bank` DTO or mint a sibling `GET /grammar/saved-from-uploads`.
- **No client caller passes `source_upload_id` yet**: the save-path plumbing
  is live end-to-end, but today's tap-to-mine surfaces (Reading, Images OCR,
  TTMIK) have no book-upload context. The natural first caller is the F-108/U2
  upload text-extraction viewer; `MineWordInput.source_upload_id` is ready.
- **BUGS_AND_FEATURES.md statuses** for F-107/F-102 left to the orchestrator's
  backlog pass (parallel builders share that file).
- Stale test-file comments in `server/tests/routes/vocab.test.ts` (pre-040
  claims that the beforeEach "does not truncate vocab_entries") predate the
  040 FK cascade; harmless, not this ticket's edit.
