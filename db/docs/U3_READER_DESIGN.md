# U3 — Consumption: source filtering + digitized chapter reader + tap-to-define — design

U3 is the "consumption" phase of the book-upload feature line (U1 = the front door /
image-page viewer, U2 = source-tagged extraction). It makes uploaded books *usable*:
source-sort works live across the library, and literature books get a real digitized
chapter reader with tap-to-define. Personal single-user, owned books, private app.

Authoritative parent doc: `db/docs/PDF_UPLOAD_DESIGN.md` (§U3). This doc expands §U3 into
buildable phases after a recon of what already exists on `feat/u3-reader-tap-define`.

## What already exists (recon, 2026-07-08)

- **Tap-to-define stack — fully built, reusable as-is.** `client/src/lib/tapChain.ts`
  (`tokeniseKorean` eojeol splitter + `resolveWordPopover` abortable lemmatize→define→enrich
  chain), `client/src/components/Tapword.tsx`, `client/src/components/WordPopover.tsx`.
  Server routes `POST /lemmatize`, `GET /define`, `POST /enrich` (Kiwi morphology + local
  KRDICT + cached Haiku enrich). `Ttmik.tsx`'s inline `TapKorean` (`:936-968`) is the render
  template. No backend work needed to add tap-to-define to a new surface.
- **Upload storage + page-image viewer.** `book_uploads` / `book_pages` tables (migrations
  040/041), `server/src/routes/uploads.ts` (7 routes incl. per-page image streaming +
  reorder), `client/src/pages/UploadViewer.tsx` (view-only bitmap viewer), `Uploads.tsx`
  list page. `book_upload_type` ENUM already includes `'literature'`.
- **Source-filter UI — mounted but inert.** `client/src/components/SourceFilterRow.tsx` is
  wired into `ReviewVocab.tsx` and `ReviewGrammar.tsx` alongside the domain/book_level
  filters, and the client threads `source_upload_id` into the search call — but the server
  (`server/src/routes/vocab.ts`, `grammar.ts`) accepts only `domain`+`book_level` in its Zod
  schema and has no `source_upload_id` branch in the SQL WHERE, so the param is silently
  dropped.
- **`source_upload_id` FK columns** already exist on `vocab_entries` and `kgiu_entries`
  (migration 040). Migration 040's own comment notes no reading/dialogue/literature table
  existed yet to attach one to.

## What is net-new

- **No literature/chapter content store exists.** No `chapters` / `reading_passages` /
  `literature` table anywhere (migrations end at 043). The chapter reader is net-new content.
- **`client/src/pages/Reading.tsx` is a bare placeholder** (`/learn/reading`, no I/O). It
  becomes the real reader.
- **No routes serve chapter/passage text** — `uploads.ts` serves only images + metadata.
- **The source filter must be made to actually filter** server-side.

---

## Phases (each independently shippable + deployable)

### U3a — Source filtering, end-to-end (small; no OCR needed; immediate value)
Make the already-mounted source filter real.
- **Server**: add `source_upload_id` (nullable BIGINT) to the query Zod schema and the SQL
  WHERE in `server/src/routes/vocab.ts` and `server/src/routes/grammar.ts`. Validate the
  upload belongs to the requesting user (join/guard) so it can't be used to probe another
  user's `book_uploads` ids — uniform behaviour with the existing user-scoping.
- **Client**: `SourceFilterRow` already renders + threads the param; verify the round-trip
  and the `ALL_SOURCES` sentinel clears the filter.
- **Ships**: source-sort works live on the vocab + grammar review libraries. Testable today
  against `vocab_2000_advanced`-tagged entries once any exist; renders the filter regardless.

### U3b — Digitized chapter reader for literature (the net-new core)
- **Schema (new migration ≥ 044)**: a two-level chapter + passage store (per-paragraph rows —
  Jared's call, 2026-07-08, for per-passage progress + graded-passage reuse).
  - `reading_chapters` — `id`, `source_upload_id` FK → `book_uploads` (ON DELETE CASCADE),
    `user_id` FK (denormalized for scoping / matches other content tables), `chapter_number`
    (INT, display order), `title` (nullable — books without titled chapters), `start_page` /
    `end_page` (nullable INT → `book_pages.page_number` range, links reader ↔ original scan),
    audit cols. UNIQUE `(source_upload_id, chapter_number)`.
  - `reading_passages` — `id`, `chapter_id` FK → `reading_chapters` (ON DELETE CASCADE),
    `passage_number` (INT, display order within chapter), `body` (TEXT — the OCR'd + curated
    passage/paragraph text, newline-preserving), optional `page_number` (INT → the scan page
    this passage sits on), audit cols. UNIQUE `(chapter_id, passage_number)`. Idempotent
    re-load replaces a chapter's passages by that key.
  - Rationale (per-paragraph vs one-body-per-chapter): enables per-passage read/progress
    state and graded-passage reuse; tap-to-define still tokenizes each passage body
    client-side on the fly (`tokeniseKorean`), so no pre-tokenized storage is needed.
- **Server routes** (`server/src/routes/reading.ts`, user-scoped, auth, validated):
  - `GET /reading/chapters?source_upload_id=` — list chapters (number, title, page range) for
    an owned upload; used by the chapter selector.
  - `GET /reading/chapters/:id` — one chapter's metadata + its ordered `reading_passages`
    (passage_number, body, page_number).
  - New top-level `/reading` prefix → **must be added to the km-lb nginx allow-list regex in
    BOTH `Deploy/nginx-{blue,green}-active.conf`** or the SPA shadows it
    (the U1 `/uploads` lesson — see `km-nginx-api-route-allowlist`).
- **Client — real `Reading.tsx`**:
  - Source (book) selector → chapter selector → reader pane.
  - Reader body: a `TapKorean`-style renderer (`tokeniseKorean` → `Tapword` → `WordPopover`),
    modeled on `Ttmik.tsx:936-968`. Paragraph breaks on blank lines.
  - "View original scan" affordance → `UploadViewer` at the chapter's `start_page`
    (reuses the existing page-image viewer; the PDF-view fallback the design calls for).
  - Client service `client/src/services/reading.ts`.
- **Extract `useTapWord()` hook** (optional, folded here): the tap-handler state machine
  (`popData`/`popLoading`/`inFlightCtrlRef` + `handleTapWord`/`handleClosePopover`) is
  copy-pasted across `Ttmik.tsx`, `Reading`(old), and Images. Extract once; the new reader
  consumes it; leave existing copies for a follow-up de-dup to keep U3b's blast radius small.
- **Content / test data**: literature OCR extraction (the semi-manual subscription curation
  pass, U2-style) plus a `load_literature.py` loader (mirroring `load_vocab_2000.py`) are
  deferred to in-person at M when a literature book is scanned. Per Jared (2026-07-08), **do
  NOT seed a throwaway fixture** — U3b builds against schema + routes + UI, and the reader is
  fully exercised end-to-end at M once a real literature book is uploaded + OCR'd. Automated
  tests still cover the routes/loaders with inline test data (CI/testcontainers), as U2 did.

### U3c — (fast-follow, not blocking) Broaden source filter + de-dup
- Extend the source filter to the reading library surface once chapters exist.
- Complete the `useTapWord()` de-dup across Ttmik + Images.

---

## Per-phase workflow
Each phase: build → `/fixpass` (independent review→fix→re-review) → real CI green (server
`npm run lint` + Python migration discovery, not just build+vitest) → blue/green deploy on M
→ verify end-state. PR → `origin/rebuild`; Jared merges; I deploy.

## Decisions (Jared, 2026-07-08)
1. **Build order**: U3a (source filter) first → ship → then U3b (reader).
2. **Chapter unit**: per-paragraph/passage rows (`reading_chapters` → `reading_passages`),
   for per-passage progress + graded-passage reuse.
3. **Test data**: no throwaway fixture; U3b builds against schema/routes/UI and is exercised
   end-to-end at M with a real literature book (routes/loaders still unit-tested inline in CI).
