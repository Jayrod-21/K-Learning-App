# TOPIK OCR Extraction Playbook (for a Claude Code session)

You are a Claude Code session running on the machine **M**, inside the repo
`/home/jared-williams/projects/9b. Korean Master/`. Your job is to **read scanned
official TOPIK exam PDFs and turn them into structured JSON** that this project's
loader ingests. You do the OCR *yourself* by opening each PDF page with the Read
tool (the pages are scanned images — you can read the Korean directly). **No API
key, no external OCR** — just you, reading pages and writing JSON files.

You do **NOT** load anything into the database. You only **write JSON files** to
`tools/ingest/output/`. Jared's other session loads them.

---

## Inputs

Raw PDFs live under (note the spaces + numbering):
```
/home/jared-williams/data/korean-master/corpus/TOPIK TEST/<N> - <N>th TOPIK/<LEVEL>/<file>.pdf
```
- **Sittings (`<N>`):** 35, 36, 37, 41, 47, 52, 60, 64, 83, 91, 96, 102
- **`<LEVEL>`:** `TOPIK-I` and `TOPIK-II`
- **Files per level** (names use the ordinal, e.g. `102nd`, `35th`, `41st`, `83rd`):
  - `<ord>-TOPIK-<I|II>-Reading-Test-Paper.pdf` + `-Reading-Answers.pdf`
  - `<ord>-TOPIK-<I|II>-Listening-Test-Paper.pdf` + `-Listening-Answers.pdf` + `-Listening-Transcript.pdf`
  - `<ord>-TOPIK-II-Writing-Test-Paper.pdf` + `-Writing-Answers.pdf`  (writing is **TOPIK-II only**)

TOPIK-I has **reading (Q31–70)** and **listening (Q1–30)**. TOPIK-II has
**reading**, **listening**, and **writing (Q51–54)**.

## Output

One JSON file per **(sitting, level, section)** →
`tools/ingest/output/topik_<N>_<I|II>_<section>.json`
e.g. `topik_102_I_reading.json`, `topik_102_II_listening.json`, `topik_102_II_writing.json`.
Section is `reading` | `listening` | `writing`.

**Resume rule:** before starting a unit, check if its output file already exists.
If it does, **skip it** and move on. This lets the job be re-run safely.

---

## JSON schema (produce EXACTLY this shape)

```json
{
  "source": {
    "test": "102",                 // sitting number as a string (no ordinal suffix)
    "level": "TOPIK I",            // "TOPIK I" or "TOPIK II" (with the space)
    "section": "reading",          // "reading" | "listening" | "writing"
    "form": "B (홀수형)",           // the form printed in the header, if visible; else omit
    "total_questions": 40,         // = number of items you extracted
    "origin": "국립국어원 TOPIK",
    "extracted_by": "claude",
    "extracted_at": "2026-07-01",  // today's date (YYYY-MM-DD)
    "answers_verified_against": "official answer key PDF"
  },
  "passages": {
    "40-42": "지문 텍스트 그대로…"   // keyed by the instruction_group the passage serves
  },
  "items": [
    {
      "id": "topik102-read-031",           // topik<test>-<read|listen|write>-<3-digit number>
      "number": 31,
      "instruction_group": "31-33",         // the "[31~33]" grouping printed above the questions
      "instruction": "무엇에 대한 내용입니까? 알맞은 것을 고르십시오.",  // verbatim
      "points": 2,                          // 배점, from the answer key (or the "(2점)" label)
      "has_image": false,                   // true if the question depends on a picture/chart/graphic
      "stem": "저는 누나가 있습니다. 동생도 있습니다.",   // verbatim; keep blanks like ( ) or (   )
      "options": ["나라", "나이", "날짜", "가족"],       // verbatim, in printed order (①→④)
      "answer": 4                           // the OFFICIAL answer (1-4) from the Answers PDF
    }
  ]
}
```

Field rules:
- **Required & must be right:** `source.test`, `source.level`, `source.section`; each item's
  `id`, `number`, `stem`, `options`, `answer`.
- `answer` is the integer **1–4** matching the circled ①②③④ in the official answer key —
  **never guess it; read it from the `-Answers.pdf`.**
- `has_image: true` when the question can't be answered from text alone (weather widgets,
  signs, charts, pictures). Put a short bracketed description in `stem`, e.g.
  `"[weather widget: 인주시 — 10/10 오늘 흐림, 10/11 토 비, 10/12 일 맑음]"`, then the options.
- `passages`: for reading, the shared 지문 for a question group (key = that group's
  `instruction_group`). For listening, put the **transcript** for each group here.
- Everything Korean is **verbatim** — copy it exactly, do not translate, summarize, fix,
  or "improve" it. Preserve blanks `(   )`, punctuation, and spacing as printed.
- Optional (include if easy, else omit): `skill_tag`, `proficiency`, `instruction_group`,
  `form`. The loader tolerates missing optional fields.

---

## Procedure — one unit at a time

For each `(sitting, level, section)`:

1. **Skip if output exists** (`tools/ingest/output/topik_<N>_<I|II>_<section>.json`).
2. **Read the answer key first** (`-<Section>-Answers.pdf`) with the Read tool. It's a clean
   table: `번호` (number) · `정답` (①②③④) · `배점` (points). Build a map `number → (answer, points)`.
3. **Read the test paper** (`-<Section>-Test-Paper.pdf`) in page ranges (Read supports up to
   ~20 pages per call; do a few pages at a time). Extract every question verbatim: `number`,
   `instruction` + `instruction_group`, `stem`, `options` (①→④ order), `has_image`, and the
   shared `passages`.
4. **Listening only:** also read the `-Listening-Transcript.pdf` and put each group's script
   text into `passages` (keyed by `instruction_group`).
5. **Writing (TOPIK-II) only:** items 51–52 are short-answer (`"answer"` is the model text or
   an object; set `has_image` as needed); 53–54 are essays — set the item's `stem` to the
   prompt and put the official model/anchor answer (from the Answers PDF) in `model_answer`.
   Don't force 1–4 answers for writing.
6. **Merge** the official `answer`+`points` from step 2 into each item.
7. **Set `total_questions`** = item count; **write** the JSON file (pretty-printed, UTF-8).
8. **Validate before moving on** (see checklist). Then go to the next unit.

**Work incrementally and write often.** Finish and write ONE file before starting the next,
so you don't hold thousands of pages in memory. If you run low on context, just stop after the
current file — the resume rule lets a fresh run continue.

---

## Recommended order (highest value first)
1. All **TOPIK-I reading**, then **TOPIK-I listening** (Q1–30) across the 12 sittings.
2. All **TOPIK-II reading**, then **listening**, then **writing**.
Newest sittings first is fine (102 → 96 → 91 → …). Any order is OK — just be systematic and rely on the resume rule.

## Per-file validation checklist (do this before writing each file)
- [ ] `items` count == `source.total_questions` and == the question-number range for that section.
- [ ] Every item has an `answer` that came from the **Answers PDF** (not inferred), 1–4 for MCQ.
- [ ] `options` has the right count (usually 4) in printed order.
- [ ] Korean is verbatim; blanks preserved; no translations/paraphrase.
- [ ] `id`s are unique and follow `topik<test>-<sec>-<NNN>`.
- [ ] JSON is valid (parse it mentally / keep it simple).

## Do NOT
- ❌ Guess or infer answers — always read the official Answers PDF.
- ❌ Translate, summarize, or "correct" the Korean.
- ❌ Invent questions/options or skip ones you find hard — read the page carefully.
- ❌ Load into the database or run docker/psql — that's handled separately.
- ❌ Touch anything outside `tools/ingest/output/`.

---

## Start (TOPIK)
Confirm the corpus path exists, create `tools/ingest/output/` if needed, then begin with
`102 - 102nd TOPIK / TOPIK-I / Reading`. Produce `topik_102_I_reading.json` first, validate it,
and continue. Report progress as `"<file> written — N items"` after each file.

---

# PART 2 — Darakwon (grammar + vocab)

Same idea, same tools: read the scanned pages with the Read tool (these PDFs are image-only or
have a **garbled** text layer — ignore any extracted text, read the page image yourself), write
JSON to `tools/ingest/output/`, load is handled separately. These are full textbooks (300+ pages
each), so use the **in-book resume** pattern below — don't try to hold a whole book in memory.

## 2A — Grammar: "Korean Grammar in Use" (KGIU) → `load_kgiu`

**Inputs** (`.../corpus/Darakwon/1. 한국 문법/<level>/`):
- `1. Beginner/1. Beginner - KGIU.pdf`      → `beginner`
- `2. Intermediate/2. Intermediate - KGIU.pdf` → `intermediate`
- `3. Advanced/3. Advanced - KGIU.pdf`       → `advanced`

**Output:** `tools/ingest/output/grammar_kgiu_<level>.json` (`grammar_kgiu_beginner.json`, …).

**Schema:**
```json
{
  "source": {
    "book": "Korean Grammar in Use: Beginning",
    "publisher": "Darakwon",
    "level": "beginner",                 // beginner | intermediate | advanced
    "default_proficiency": "basic",
    "extracted_by": "claude",
    "extracted_at": "2026-07-01",
    "total_pdf_pages": 380,              // the PDF's page count
    "last_pdf_page_done": 60             // RESUME MARKER — highest PDF page you've fully extracted
  },
  "items": [
    {
      "id": "kgiu-beginner-001",         // kgiu-<level>-<3-digit sequence>
      "type": "grammar",                 // "grammar" | "intro" (chapter/unit intro) | "reference"
      "unit": "01",                      // chapter/unit label if shown
      "pattern": "-아/어/여요",            // the grammar form (verbatim); the heart of the item
      "title_en": "Polite present-tense ending",
      "category": "ending",
      "proficiency": "basic",
      "explanation": "설명 그대로…",       // the explanation text, verbatim Korean/English as printed
      "formation_rules": ["동사 어간 + 아요/어요/여요"],
      "examples": [ {"korean": "가다 → 가요", "english": "go → goes"} ],
      "tips": ["모음조화가 적용됩니다."],
      "source_book": "Korean Grammar in Use: Beginning",   // REQUIRED on every item
      "source_pages": [20, 21]           // the BOOK page numbers this point spans
    }
  ]
}
```
Rules:
- **One item per grammar point.** Chapter/section intros → `type: "intro"`; back-matter/appendix
  reference pages → `type: "reference"`.
- `pattern`, `explanation`, `examples`, `formation_rules`, `tips` — **verbatim** (Korean and English
  as printed). Every item needs `id` + `source_book`. Everything else is optional (the loader tolerates gaps).
- `examples`/`formation_rules`/`tips` are lists; example entries are `{"korean","english"}` objects.

## 2B — Vocab: "2000 Essential Korean Words" → `load_vocab_2000`

**Inputs** (`.../corpus/Darakwon/2. 단어/<level>/`):
- `1. Beginner/2000 Essential Korean Words.pdf`               → `beginner`
- `2. Intermediate/2000 Essential Korean Words - Intermediate.pdf` → `intermediate`
- (there is **no Advanced vocab** book — only these two levels.)

**Output:** `tools/ingest/output/vocab_2000_<level>.json`.

**Schema:**
```json
{
  "source": {
    "book": "2000 Essential Korean Words for Beginners",
    "publisher": "Darakwon",
    "level": "beginner",                 // beginner | intermediate  (NO advanced)
    "default_proficiency": "basic",
    "extracted_by": "claude",
    "extracted_at": "2026-07-01",
    "total_pdf_pages": 320,
    "highest_book_page": 60,             // RESUME MARKER — highest BOOK page fully extracted
    "extraction_complete": false
  },
  "items": [
    { "id": "vocab-beginner-0001", "type": "theme_intro",
      "theme": "01 사람 / People", "korean": "사람", "english": "People",
      "source_book": "2000 Essential Korean Words for Beginners", "source_pages": [15] },
    { "id": "vocab-beginner-0002", "type": "word",
      "korean": "가족", "english": "a family", "pronunciation": "[가족]", "hanja": "家族",
      "part_of_speech": "noun", "proficiency": "basic",
      "theme": "01 사람 / People", "subsection": "1 가족/친척 / Family/Relatives",
      "example_korean": "가족이 모두 몇 명이에요?", "example_english": "How many are in your family?",
      "source_book": "2000 Essential Korean Words for Beginners", "source_pages": [18] }
  ]
}
```
Rules:
- **One item per word** (`type: "word"`), each with `korean` + `english` at minimum, plus
  `pronunciation`, `hanja`, `part_of_speech`, and example sentence(s) when printed — **verbatim**.
- Theme headers (e.g. "01 사람 / People") → `type: "theme_intro"`; subsection headers →
  `type: "subsection_intro"`. Carry the current `theme`/`subsection` onto each word under it.
- Review/"Let's Check" pages → `type: "lets_check"`; hanja supplements → `type: "hanja_extension"`.
- Every item needs `id`, `type`, `source_book`. Other fields optional.

## In-book resume pattern (grammar + vocab)
Because a book is huge:
1. If `grammar_kgiu_<level>.json` / `vocab_2000_<level>.json` already exists, **read it**, note
   `source.last_pdf_page_done` (grammar) / `source.highest_book_page` (vocab), and continue from
   the next page — **append** new items to the existing `items`, don't restart.
2. Work in page-range chunks (Read ~10-20 pages), extract items, then **rewrite the whole file**
   with the extended `items` and an updated resume marker. Keep `id` sequence monotonic.
3. Set `extraction_complete: true` (vocab) only when you reach the last content page.
4. It's fine to stop after any chunk — the next run resumes from the marker.

## Do NOT (Darakwon)
- ❌ Trust the PDF's embedded text layer (grammar's is garbled) — read the page image.
- ❌ Translate/summarize — copy Korean + the book's own English verbatim.
- ❌ Worry about audio (`Audio.zip`) — text content only; audio wiring is a separate step.

## Order
TOPIK first (Part 1). Then grammar: `beginner → intermediate → advanced`. Then vocab:
`beginner → intermediate`. Resume markers make any order safe.
