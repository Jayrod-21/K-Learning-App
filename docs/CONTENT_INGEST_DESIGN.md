# Content Ingest — Design & Phased Plan

**Status:** Design (Phase 0) · **Date:** 2026-07-18 · **Author:** ingest epic kickoff

## 1. Summary

We have a real Korean content corpus on disk — **17 scanned books (3,971 pages, 2.4 GB)** and **1,142 audio files (~150–200 hours, 3.6 GB)** — that we want to turn into in-app learning content. The good news: this is **not greenfield**. The upload → page-image pipeline (shipped as F-108), the Read surface, and the Listen surface all already exist. The work is about closing specific gaps between them, not building from scratch.

The epic decomposes into **three tracks of very different size and risk**. The recommended strategy is to ship the smallest, highest-value track before beta and stage the two larger ones after.

| Track | What | Size | Pre-beta? |
|-------|------|------|-----------|
| **P — Picture / comic / manga** | A new upload type that displays page images (the "modified PDF view") | **Small** | ✅ Yes |
| **B — Books → Read (prose)** | OCR full page text → chaptered reading passages | Medium–High | After beta |
| **A — Audio → Listen (Whisper)** | User audio uploads, transcription, a Listen entry | **Large (greenfield)** | After beta |

## 2. What already exists (leverage)

The upload subsystem is genuinely strong and we reuse it wholesale:

- **Upload front door** — `POST /uploads` normalizes a ZIP-of-JPGs or a PDF into an ordered sequence of page images (`book_pages`) at upload time; the original is discarded. Per-page streaming (`GET /uploads/:id/page/:n`), a reorder contract, a 300 MiB cap, and a per-user daily cap on new titles are all in place (`server/src/routes/uploads.ts`, `services/bookUploadIngest.ts`).
- **The viewer is already an image-sequence viewer, not a PDF viewer** — `client/src/pages/UploadViewer.tsx` renders each page as a plain `<img>` with zoom, rotation, swipe, and deep-linking. **This is exactly the "modified PDF view" a comic/manga type needs — zero new storage or rendering machinery required.**
- **F-108 OCR pipeline** — `services/uploadExtract.ts` runs Claude Vision (`ocrImage`) over pages and curates the result into vocabulary and grammar rows. It has cost caps, a one-live-run lock, a stale-run reaper, and cross-user fences (`db/corpusFences.ts`). Note what it produces: **curated words, not page text.**
- **Read surface** — `reading_chapters` / `reading_passages`, the reader UI, resume positions, attempts, and a "view the original scan" deep link all exist (`routes/reading.ts`, `client/src/pages/Reading.tsx`).
- **Listen surface** — TTMIK/Iyagi lessons with Range-capable MP3 streaming and completion attempts (`routes/ttmik.ts`).
- **Storage** — the `km_book_uploads` and `km_images` Docker volumes, mounted by both blue/green colors.

## 3. What's missing (the gaps)

- **Per-page text is never persisted.** F-108 keeps curated words and discards the page transcription. `reading_passages` is the only page-text store, and today it is populated **only** by an offline Python loader (`tools/ingest/loaders/load_literature.py`) from a hand-curated JSON per book — there is no API that turns `book_pages` into readable chapters.
- **No book → Read producer.** Bridging OCR output to `reading_chapters`/`reading_passages` is the "missing middle" for prose books.
- **Chapter segmentation has no owner.** `reading_chapters` needs boundaries (`chapter_number`, `start_page`, `end_page`); nothing computes them for an OCR'd book.
- **User audio does not exist at all.** No user-owned audio table, no audio blob store (both volumes are images), and no Whisper/transcription service anywhere. `listening_attempts.source_kind` is a closed two-value CHECK, and audio content lives only in the public corpus.
- **The job model is synchronous-in-request** (20 pages/run, 50 pages/user/day) by explicit design. Whisper over hours of audio and full-book text OCR both strain this and likely need an async runner.

## 4. The corpus we're ingesting

- **Picture / children's books (564 pages):** 그림으로 보는 이순신, 그림으로 보는 한국사, 이순신 이야기, 너의 이름은 — natural fits for Track P.
- **Graded readers:** Easy Korean Reading, Short Stories in Korean, Korean Folktales — the best prose → Read pilots (Track B).
- **Reference:** 2000 Essential Korean Words, TOPIK 2300 mindmap, Real-Life Conversations, Korean Slang — word-mining fits (existing F-108).
- **Classical (한문):** Samguk Sagi / Yusa — the OCR hard case; defer.
- **Audio (~150–200 hrs, no transcripts):** grammar levels, TOPIK prep, news, and graded-reader audio. **Three confirmed book↔audio pairings** — Easy Korean Reading, Korean Folktales, Real-Life Conversations — are the cleanest "book → Read + audio → Listen" pilots.

## 5. Recommended phasing

- **Phase 0 — Design (this doc) + decisions.** Now.
- **Phase 1 — Track P (picture / comic / manga).** *Before beta.* Add a new `book_upload_type` value; the whole page-image pipeline and viewer already handle display. It is not grammar-bearing and does not feed word-mining by default. It gets its own entry on the Read/Library surface. Small, additive, low-risk, and immediately visible to testers. **This is the recommended pre-beta build.**
- **Phase 2 — Track B (books → Read, prose).** *After beta.* A new full-text OCR output mode (page text, not word lists), an intermediate page-text store so re-curation doesn't re-spend Vision budget, chapter segmentation, and an API producer for `reading_chapters`/`reading_passages` reconciled with the existing loader contract. Pilot on the 3 graded readers.
- **Phase 3 — Track A (audio → Listen, Whisper).** *After beta — the big one.* An async job runner (the `upload_extractions` claim/settle/reap pattern is already ~80% of a job table), a user-audio table pair (file + transcript segments) mirroring `book_uploads`/`book_pages`, a Whisper transcription service, a user-scoped MP3 streaming route, a third `listening_attempts.source_kind`, and the fence/sanitize treatment for transcripts entering prompts.

## 6. Key decisions needed (with recommendations)

1. **Phase 1 first, shippable before beta?** *Rec: yes* — Track P reuses everything and gives testers new content immediately.
2. **Comic tap-to-define.** OCR here deliberately returns word lists with no coordinates (a locked decision). For manga, tap-define would be a **side word-list** beside the image, not in-image tapping. *Rec: accept the side word-list; keep the no-bounding-box decision.*
3. **Should Track P run any OCR at all?** *Rec: no by default* — a comic/picture type is a viewer; offer word-mining as an optional, explicit action later, not automatic.
4. **Books → Read (Phase 2): reuse `reading_passages` auto-chaptered, or add an intermediate `page_texts` table?** *Rec: add `page_texts`* so re-chaptering/re-curation never re-spends Vision budget.
5. **Chapter segmentation authority (Phase 2)?** *Rec: Claude proposes boundaries, user edits* in a lightweight boundary editor over the existing page viewer.
6. **Audio transcript shape (Phase 3): per-segment table or per-word corpus rows?** *Rec: per-segment*, mirroring the existing TTMIK transcript-line model, so read-along works.
7. **Job model (Phase 3)?** *Rec: introduce an async runner*, extending the existing claim/settle/reap pattern rather than inventing a new one.

## 7. Phase 1 concrete plan — the pre-beta build (Track P)

Scope: let a user upload a picture book / comic / manga and read it as page images in the app, with the existing viewer.

1. **DB** — `ALTER TYPE book_upload_type ADD VALUE 'comic'` (additive migration, mirrors prior enum extensions). No new tables — `book_pages` already stores the images.
2. **Upload type flow** — extend the type picker so choosing "picture / comic / manga" is distinct from "novel/prose" (which maps to `literature` → Track B later). `client/src/components/UploadTypeModal.tsx` + the `type` validation in `services/bookUploadIngest.ts` and the Zod `UploadBodySchema`.
3. **Not grammar-bearing / not auto-OCR'd** — exclude `comic` from `GRAMMAR_BEARING_TYPES` and from any automatic extraction; the "Extract text" button stays optional.
4. **Read/Library surface** — add a "Comics & Picture Books" grouping (a 4th section in `client/src/pages/Reading.tsx`) that opens the page-image viewer directly, rather than the prose reader.
5. **Tests + `/fixpass`** — service + route + client tests; full four-phase fixpass; then blue/green deploy on your authorization.

Deliberately out of scope for Phase 1: any OCR, any text extraction, any chapter model. Those are Track B/Track A.
