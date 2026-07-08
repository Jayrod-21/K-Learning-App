# PDF book upload + digitized reading (P4/P6, "hardest") — design

Jared uploads scanned book PDFs he owns → they populate the app (vocab/grammar/dialogue/literature),
source-tagged + sortable by source; a view-only in-app PDF viewer; literature gets a digitized chapter
reader + tap-to-define. Personal single-user; owned books; app is private (copyright-safe). This folds in
the P6 Reading feature. Ref: existing corpus/OCR precedent = `tools/ingest/*` + the OCR playbooks
([[km-local-deploy-on-m]] TOPIK/KGIU/vocab ingest), image blob storage `image_captures`.

## Confirmed decisions (Jared, 2026-07-08)
- PDFs are **SCANS** (no text layer) → OCR needed. Want **corpus-quality (polished)** + **low cost**.
  ⇒ Extraction = the **subscription Claude-Code OCR + curation pass** (like the corpus was built), NOT
  a live paid-API pipeline. Async/semi-manual now; **full automation = future TO-DO** (for selling the
  app skeleton, no contents).
- Volume: a **handful** of books over time (~10, 200-300 pp, a few MB each), hand-scanned by Jared.
- Literature: **both** — digitized chapter reader (primary) + PDF-view fallback + **tap-to-define**.
- Processing: **async** (upload → viewable now → structured content lands when curated).
- Chapters: **best-effort auto-detect, prompt Jared to mark when unsure**.
- **Test-then-keep**: prove the pipeline with 1 sample, keep the data once it works. Make it re-runnable/idempotent.

## Surfacing (Jared, 2026-07-08)
- **Settings → Upload** button → an **Uploads page** listing every uploaded file (title, type, status) →
  tap one → the **view-only PDF viewer**.
- Wherever an upload populates (vocab / grammar / reading / dialogue): the **home of that page** gains a
  way to **see the uploads** + the **PDF-view** option + a **"sort by source/upload" filter** that works
  like the existing beginner/intermediate/advanced (`book_level`) filter.

## Tap-to-define scope (asked): LOW cost, MODERATE work.
Reuses the existing tap stack (Tapword → lemmatize[Kiwi,local] → define[KRDICT,local DB, FREE] → WordPopover;
already powers Ttmik/Reading/Images). Only new work = tokenizing the digitized reader text into tappable
words (as Ttmik passages already do). Paid part = the optional enrich call (tiny, already per-tap app-wide).

## Phases (each shippable)
## REVISION (2026-07-08, after seeing the sample): NORMALIZE TO PAGE IMAGES
The real scans are the **vFlat export** = a ZIP of high-res JPG **page images** (sample: "2000 Essential
Korean Words Advanced" = 548 JPGs @ 2271×3176, 240 MB) — NOT a single ≤15MB PDF. Jared chose **accept
BOTH a zip-of-images AND a PDF, normalize internally to ORDERED PAGE IMAGES.** So the storage model is
per-page images (not one blob), the viewer is a lightweight **image-page viewer** (fetch page N on demand
— never load 240MB at once; DROP pdf.js), and OCR (U2) reads the page images directly.
- Upload accepts `.zip` (image entries, ordered by filename) OR `.pdf`. Magic-byte: `PK\x03\x04` (zip) or
  `%PDF`. Cap ~**300 MB** (Jared has the storage; a book is ~240MB). 
- **Normalize**: zip → extract image entries (jpg/png), order by filename, store each as a page. pdf →
  `pdftoppm` (poppler — add `poppler-utils` to the server Dockerfile; the ingest already uses poppler) →
  one image per page. Reject zip-bombs / non-image zip entries / 0-page.
- **Storage**: `book_pages` table (`upload_id` FK, `page_number` INT, `blob_ref` UUID, unique(upload_id,page_number))
  + per-page image blobs on the shared `km_book_uploads` volume. `book_uploads.page_count` set on ingest.
- **Serving**: `GET /uploads/:id/page/:n` streams page n's image (user-scoped, nosniff, cache-friendly);
  `GET /uploads/:id` returns page_count. REMOVE the single-PDF `/uploads/:id/file`.
- **Viewer**: image-page viewer (page N of M, prev/next/zoom, lazy — fetch current page image). No pdf.js.
- Processing can be sync-ish for the store-pages step (unzip is fast; pdftoppm a few sec) OR async if a big
  zip is slow — show `processing` until pages are stored, then `ready` (viewable). OCR/extraction stays U2.
- **PAGE ORDER (Jared flagged 2026-07-08):** vFlat retakes can land OUT OF ORDER (his sample: pages ~1-60
  are misordered because retakes appended instead of replacing). So `page_number` is the DISPLAY order,
  initialized from filename sort but **MUTABLE** — plan a **reorder tool** (drag pages / move a page to N)
  as part of the viewer/uploads UI (a `PATCH /uploads/:id/pages/order` reorders `book_pages.page_number`).
  Build the storage to support it now (page_number is the source of truth, not the blob filename); the
  reorder UI can ship in U1b or a fast-follow. For the sample, filename order is wrong in 1-60 but the
  upload/viewer/extraction still testable (vocab entries are per-page self-contained — order-insensitive).
Everything else in U1a/U1b below still applies (book_uploads table, type popup, Uploads page, Settings
upload, source-filter scaffolding, routes) — only the STORAGE (per-page) + VIEWER (image) + UPLOAD (zip/pdf,
big cap, normalize) change.

### U1 — the front door (build now; needs NO extraction/OCR)
- **U1a server**: 
  - Migration: `book_uploads` (id, user_id FK, title, type ENUM[vocab|grammar|both|dialogue|literature],
    status ENUM[processing|ready|failed] default processing, page_count nullable, byte_size, created_at,
    audit cols). Blob storage for the PDF — REUSE the mechanism `image_captures` blobs use (find it; don't
    invent). A **source dimension**: add a nullable `source_upload_id` FK (→ book_uploads) to the content
    tables extraction will populate (`vocab_entries`, `kgiu_entries`, + a reading/dialogue store — check
    which exist; add the column where the type maps) so U2 can tag + the filters can sort. (Columns unpopulated until U2.)
  - Routes (user-scoped, auth, validated): `POST /uploads` (multipart PDF ≤ ~15MB + `type` + `title`;
    magic-byte %PDF sniff; per-user cap), `GET /uploads` (list), `GET /uploads/:id` (meta), 
    `GET /uploads/:id/file` (stream the PDF blob for the viewer — proper Content-Type/Range like the
    ttmik audio route does), `DELETE /uploads/:id` (removes blob + row + optionally its extracted content).
    Idempotent re-upload/replace by (user, title) so re-processing is clean (test-then-keep).
  - **nginx**: `/uploads` is a NEW top-level prefix → add it to the allow-list regex in BOTH
    `Deploy/nginx-{blue,green}-active.conf` (all 4 locations) or the SPA shadows it ([[km-nginx-api-route-allowlist]]).
  - NEVER hand-apply the migration — the deploy runner does ([[km-never-manually-apply-migrations]]).
- **U1b client**:
  - **Settings → Upload**: a button → the **type popup** (vocab/grammar/both/dialogue/literature) → file
    picker → `POST /uploads`; shows in the list as `processing`.
  - **Uploads page** (reached from the Settings upload button): list all uploads (title/type/status), tap → viewer.
  - **View-only PDF viewer**: bundle `pdfjs-dist` (vite worker config), render page-by-page from
    `GET /uploads/:id/file`; view-only (NO annotation), page nav, pinch/zoom optional. New route e.g. `/uploads/:id`.
  - **Sort-by-source filter scaffolding** on the Review-library vocab + grammar pages: a source/upload
    filter alongside the existing `domain`/`book_level` filters (populated once U2 tags content; renders
    the uploaded books as filter options; a per-source "View PDF" affordance).

### U2 — extraction (per book, via the subscription curation pass + the ingest loaders)
Extend `tools/ingest` + a per-type playbook so an uploaded book → OCR'd + curated → source-tagged JSON →
loaded via the existing loaders into vocab_entries/kgiu_entries/reading/dialogue with `source_upload_id`.
Status → ready. Idempotent (re-run replaces). This is the semi-manual/async part.

### U3 — consumption
Source-sort live across the library; the **digitized chapter reader** for literature (chapter select,
best-effort detection + manual-mark fallback) + PDF-view + **tap-to-define** (reuse the tap stack).

## Model note: Fable exhausted → build agents on **Sonnet** (Opus for hardest reasoning).
Each phase: build → /fixpass → blue/green deploy on M. U1 first (immediate value, zero OCR cost).
