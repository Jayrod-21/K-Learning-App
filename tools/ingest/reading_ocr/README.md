# Reading-ingest OCR pipeline (`vision_ocr_book.py`)

Turns a scanned reading book (owned page images) into the curated chapter-JSON
that `tools/ingest/loaders/load_literature.py` consumes, so it becomes readable
in the app's Read surface (`reading_chapters` / `reading_passages`).

**The OCR engine produces the text; this script only maps structure.** Google
Cloud Vision (`DOCUMENT_TEXT_DETECTION`, Korean) transcribes each scan
mechanically; the script groups the engine's output into chapters/passages
using an operator-supplied structure config. No prose is authored here — every
`body` is Vision's verbatim output. This is the copyright-clean path: a
dedicated OCR tool transcribing owned scans, not a model generating book text.

## Usage

```bash
export GOOGLE_VISION_API_KEY=...            # a restricted Cloud Vision API key

# 1. Look at what the extractor picks for a few pages before trusting a run:
python3 vision_ocr_book.py --scan-dir <scans> --layout comic --test 0013.jpg 0069.jpg

# 2. Run a config -> JSON:
python3 vision_ocr_book.py --scan-dir <scans> --config book.config.json --out book.json

# 3. Load it (km-loader image, on km-internal to reach km-db):
docker run --rm --network km-internal -v <dir>:/data:ro -w /app \
  -e DATABASE_URL=postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@km-db:5432/$POSTGRES_DB \
  km-loader:<tag> python -m tools.ingest.loaders.load_literature /data/book.json --dry-run
# (drop --dry-run to write; the loader replaces the book's chapters idempotently)
```

Runs on plain host Python 3 (stdlib only — `urllib`, `base64`, `json`). Costs
~1 Vision page/call; a book fits inside Vision's free 1,000-pages/month tier.

## Config shape

```jsonc
{
  "layout": "comic",           // or "prose" (default). See below.
  "source": { "source_upload_id": 18, "book_title": "...", "extraction_complete": true },
  "chapters": [
    { "chapter_number": 1, "title": "요리 (Cooking)",
      "printed_start": 9, "printed_end": 12,
      "pages": [ { "file": "0013.jpg", "printed_page": 9 } ] }
  ]
}
```

`example_easy_korean_reading.config.json` is a complete worked example (TTMIK
*Easy Korean Reading*, 30 stories on a tidy 4-page grid → prose page at scan
`4N+9`).

## Extraction: story prose vs. everything else

A page's *story* paragraphs are LONG and mostly HANGUL, so short banner /
comic-bubble text and English-glossed footnotes (low Korean ratio) drop out
without any pixel cropping. Two layouts:

- **`comic`** (e.g. *Easy Korean Reading*): story sits at the page BOTTOM under
  the comic panels. The extractor anchors on the longest block and keeps it +
  anything at-or-below it, dropping in-panel Korean signs above.
- **`prose`** (default; facing-page prose books): the whole page is story text,
  so keep every qualifying Korean paragraph in order.

**`drop_exercises`** (config flag; `--drop-exercises` in test mode): exercise-
bearing language-learner books (e.g. *Korean Folktales*) interleave numbered
**comprehension questions** (`1. …`) and imperative **discussion prompts**
(`… 소개해 보세요`) with the story prose. This drops both so only the story
becomes reading passages. (The questions themselves are a future feature —
F-205 — which will *capture* rather than discard them.) Duplicate blocks from
facing-page re-OCR are also deduped per chapter.

`example_korean_folktales.config.json` is the second worked example — a
facing-page collection with `layout:prose` + `drop_exercises:true`.

## Per-book caveat (learned the hard way)

The page→chapter mapping is book-specific. A tidy grid (EKR) is a formula; a
facing-page folktale collection is NOT. Two things bit us on *Korean Folktales*
and are worth knowing:
1. The scan↔printed offset was constant (+2), but confirm it from the **printed
   page numbers on the scans**, not an assumption — read the numbers off the
   pages and match the TOC.
2. In a facing-page spread the Korean story sits on the page **before** its
   TOC-listed (English/title) page, so the per-folktale range had to shift
   **-1 printed page**. Always `--test` a few pages and confirm titles align
   with their story content before a full run.

## Known limitation

OCR is ~99% on clean Korean print/handwriting — expect the occasional single-
character slip (e.g. 물→울). These are left as-is; correcting a scanned
copyrighted book's text back to the source is out of scope for this tooling.
