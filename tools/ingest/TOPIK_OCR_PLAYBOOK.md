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

## Start
Confirm the corpus path exists, create `tools/ingest/output/` if needed, then begin with
`102 - 102nd TOPIK / TOPIK-I / Reading`. Produce `topik_102_I_reading.json` first, validate it,
and continue. Report progress as `"<file> written — N items"` after each file.
