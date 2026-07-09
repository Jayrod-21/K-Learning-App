# Literature (U3b Digitized Chapter Reader) — Extraction Guide

Used by a subscription Claude-Code OCR/curation pass to turn an uploaded literature
`book_uploads` row (`type = 'literature'`) into the curated JSON `tools/ingest/loaders/
load_literature.py` consumes. Reference this so per-book curation prompts can stay short.

Consumer: `tools/ingest/loaders/load_literature.py` → `reading_chapters` + `reading_passages`
(migration 044). Design authority: `db/docs/U3_READER_DESIGN.md` §U3b.

## What this is different from

This is NOT the vocab/grammar extraction guides (`_vocab_extraction_guide.md`,
`_advanced_extraction_guide.md`, `_intermediate_extraction_guide.md`). Those pull structured
*entries* (headword + gloss + examples) out of a reference book. This guide pulls the
**running prose text** of a literature book — a novel, short-story collection, essay
collection, etc. — structured only as far as chapter → paragraph, for a reader that renders
it with tap-to-define. Nothing here is tokenized, glossed, or annotated; the client
(`client/src/lib/tapChain.ts`) tokenizes each passage body on the fly at read time.

## Before you start

1. **Identify the source upload.** Every curated JSON is scoped to exactly ONE
   `book_uploads` row. You need its `id` (the `source_upload_id` below) — ask the operator, or
   look it up: `SELECT id, title, status FROM book_uploads WHERE type = 'literature' ORDER BY
   created_at DESC;`. The loader derives the chapters' owner (`user_id`) FROM that row — it is
   never read from this JSON (see the composite-FK note in `load_literature.py`'s module
   docstring). Do not guess an id; a wrong one either loads onto the wrong book (if it happens
   to exist and be type `literature`) or fails loud (if it doesn't exist, or isn't type
   `literature`).
2. **Read the PDF via vision**, same discipline as the vocab/grammar guides: the text layer of
   a scanned book is frequently mojibake or absent. Verify the printed page number at the
   bottom of each page against your running page count — literature books often have more
   front matter (title page, table of contents, foreword) than vocab/grammar books, so the
   PDF-page-to-book-page offset can be larger and can drift mid-book (illustrations, blank
   verso pages).

## Output shape

```json
{
  "source": {
    "source_upload_id": 42,
    "book_title": "인간실격",
    "extracted_by": "claude-code-opus",
    "extracted_at": "2026-07-08",
    "note": "Front matter (title page, translator's preface) omitted — chapters start at the first numbered chapter.",
    "total_pdf_pages": 210,
    "highest_book_page": 198,
    "extraction_complete": true
  },
  "chapters": [
    {
      "chapter_number": 1,
      "title": "첫 번째 수기",
      "start_page": 11,
      "end_page": 34,
      "passages": [
        { "passage_number": 1, "body": "부끄럼 많은 생애를 보냈습니다.", "page_number": 11 },
        { "passage_number": 2, "body": "저는 인간의 삶이라는 것을 도무지 짐작할 수가 없습니다.\n소인의 마을에서 태어났습니다만, 저는...", "page_number": 11 }
      ]
    },
    {
      "chapter_number": 2,
      "title": "두 번째 수기",
      "start_page": 35,
      "end_page": 61,
      "passages": [
        { "passage_number": 1, "body": "바닷가 마을이라 바닷가와 아주 가까운...", "page_number": 35 }
      ]
    }
  ]
}
```

### `source` header

| Field | Required | Notes |
|---|---|---|
| `source_upload_id` | **yes** | The owning `book_uploads.id`. See "Before you start" above. Composite-FK enforced — the loader will reject a mismatched or missing id loudly rather than guess. |
| `book_title` | no | Informational only; the canonical title already lives in `book_uploads.title`. Fill it in anyway — it helps a human skim the JSON. |
| `extracted_by` | no | Free text (e.g. `"claude-code-opus"`, a name). |
| `extracted_at` | no | ISO date string. |
| `note` | no | Anything a future reader of this file needs to know — omitted front matter, illegible pages, ambiguous chapter boundaries, OCR uncertainty. |
| `total_pdf_pages` / `highest_book_page` | no | Progress bookkeeping for a multi-session extraction, mirrors the vocab guide's fields. |
| `extraction_complete` | no | `true` once the whole book is captured; `false`/omitted for a partial/in-progress pass. |

### `chapters[]`

| Field | Required | Notes |
|---|---|---|
| `chapter_number` | **yes** | 1-based, sequential, UNIQUE within the book (`uq_reading_chapters_upload_number`). Use the book's own chapter numbering if it has one; otherwise number sequentially in reading order. |
| `title` | no | The book's own chapter title/heading, if it has one. `null`/omit for books with unnamed or numbered-only chapters (e.g. "Chapter 1" with no further title — in that case just omit `title` rather than writing the literal string "Chapter 1"). 1..500 chars if present. |
| `start_page` / `end_page` | no | The book-page span this chapter covers (matching `book_pages.page_number` — the same page numbers you're tracking for the offset check above). Lets the reader's "view original scan" jump to the right page. Omit if you didn't track page numbers this granularly; both are independently optional but if both are present `end_page >= start_page`. |
| `passages[]` | **yes** (may be empty for a divider-only chapter) | See below. |

### `passages[]` — the tap-to-define unit

One passage per **paragraph** (not per sentence, not per page). This is the unit the reader
renders and the unit future per-passage progress/graded-passage features will key on.

| Field | Required | Notes |
|---|---|---|
| `passage_number` | **yes** | 1-based, sequential, UNIQUE within the chapter (`uq_reading_passages_chapter_number`). Resets to 1 at the start of every chapter. |
| `body` | **yes** | The paragraph's curated text, newline-preserving (use `\n` for an internal line break the book itself prints, e.g. a stanza break in embedded verse — don't insert artificial line breaks). **1..20000 characters** (`ck_reading_passages_body_len`) — never empty, never truncated. If a single "paragraph" as printed would exceed 20000 chars (essentially never for prose, but possible for an unbroken block of verse or a very long unindented paragraph), split it into consecutive `passage_number`s at a natural sentence boundary rather than truncating. |
| `page_number` | no | The book page this specific paragraph starts on. Optional, but include it whenever you're tracking page numbers anyway — it's what backs the reader's per-passage "view original scan" jump (finer-grained than the chapter-level `start_page`/`end_page`). |

## Critical extraction rules

- **Vision OCR only** — same as every other guide in this directory; do not trust a scanned
  book's text layer.
- **Korean accuracy is mandatory.** This is prose a learner will read closely and tap words in;
  a wrong character changes meaning in a way a vocab-list typo mostly doesn't. Re-check any
  page with unusual spacing, italics, or hanja mixed into the Korean text.
- **Preserve paragraph breaks exactly as printed.** Don't merge two printed paragraphs into one
  passage, and don't split one printed paragraph across two passages. The paragraph boundary
  IS the tap-to-define unit boundary.
- **Preserve punctuation, quotation marks, and dialogue formatting verbatim** — Korean prose
  quotation conventions (「」, 『』, “”, em-dashes for interrupted dialogue) carry meaning; do
  not normalize them to ASCII equivalents.
- **Don't skip pages.** If a chapter spans pages 35–61, every paragraph on every one of those
  pages should appear as a passage, in order. A gap is a silent content loss a reader will hit
  as a jump in the story.
- **Omit true front/back matter** (title page, copyright page, translator's preface,
  publisher's afterword, blank pages) — record what you omitted in `source.note`. If the book
  has a numbered "prologue" or "epilogue" that IS part of the narrative, include it as a
  chapter (often `chapter_number: 0` for a prologue is reasonable if the book itself doesn't
  number it — but `chapter_number` must be `> 0`, so use the book's own numbering if it has
  one, or renumber sequentially starting at 1 and note the substitution in `source.note`).
- **Illustrations / plates with no body text**: skip them (they have nothing for tap-to-define
  to render); note their page in `source.note` if it interrupts pagination continuity.

## Validation (before finishing)

```bash
python3 -c "
import json
d = json.load(open('PATH'))
chs = d['chapters']
ch_nums = [c['chapter_number'] for c in chs]
print(len(chs), 'chapters,', len(ch_nums) - len(set(ch_nums)), 'dup chapter_numbers')
for c in chs:
    pn = [p['passage_number'] for p in c['passages']]
    dups = len(pn) - len(set(pn))
    empties = sum(1 for p in c['passages'] if not p['body'].strip())
    toolong = sum(1 for p in c['passages'] if len(p['body']) > 20000)
    if dups or empties or toolong:
        print('chapter', c['chapter_number'], 'dup_passages=', dups, 'empty=', empties, 'too_long=', toolong)
"
```

Or dry-run the loader itself once `source.source_upload_id` is filled in (no DB connection
required in `--dry-run`):

```bash
python -m tools.ingest.loaders.load_literature PATH --dry-run
```

If Bash is sandboxed: construct JSON carefully. The loader's Pydantic models + `--dry-run`
validation fail loudly on structural problems (missing required fields, wrong types); the
script above additionally catches the semantic issues (dup numbers, empty/oversized bodies)
that Pydantic's tolerant `StrictBase` (extra keys ignored, no length bounds) doesn't reject on
its own — those are enforced by the loader's `_validate_document` right before any DB write.

## Final-message report (each agent)

1. Chapter count + total passage count.
2. Book page range covered (and any front/back matter you omitted).
3. Output file path.
4. Anomalies — illegible pages, ambiguous chapter boundaries, illustrations/plates skipped,
   any paragraph that needed splitting for the 20000-char bound.
