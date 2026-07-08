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
### U1 — the front door (build now; needs NO extraction/OCR; works with any PDF)
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
