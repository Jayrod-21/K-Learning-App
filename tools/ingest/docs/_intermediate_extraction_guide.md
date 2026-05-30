# KGIU Intermediate — Shared Extraction Guide

Used by all parallel subagents. Reference this so per-agent prompts can stay short.

## Source PDFs (split into 4 slices because the original 117MB > 100MB Read cap)

| Slice | File | Original PDF pages | Book pages (offset +8) |
|---|---|---|---|
| A | `Darakwon/한국어 문법/_intermediate_chunks/sliceA_001-100.pdf` (36MB) | 1–100 | 1–108 |
| B | `Darakwon/한국어 문법/_intermediate_chunks/sliceB_101-200.pdf` (38MB) | 101–200 | 109–208 |
| C | `Darakwon/한국어 문법/_intermediate_chunks/sliceC_201-300.pdf` (39MB) | 201–300 | 209–308 |
| D | `Darakwon/한국어 문법/_intermediate_chunks/sliceD_301-390.pdf` (37MB) | 301–390 | 309–398 |

**Inside each slice the page numbering restarts at 1.** Read(sliceA.pdf, pages=N) returns
the original PDF page N. Book page = original PDF page + 8 (verify by the printed page
number at the bottom of each book page).

To convert "book page B" → "slice + slice-internal page":
- Slice A: book p.B = sliceA p.(B−8)   if 14 ≤ B ≤ 108
- Slice B: book p.B = sliceB p.(B−108) if 109 ≤ B ≤ 208
- Slice C: book p.B = sliceC p.(B−208) if 209 ≤ B ≤ 308
- Slice D: book p.B = sliceD p.(B−308) if 309 ≤ B ≤ 398

## Schema (RICH, per entry)

```json
{
  "id": "kgiu-int-c01-01",                          // id prefix "kgiu-int-", c=chapter
  "type": "grammar" | "intro",
  "unit": "Ch.1. Expressing Conjecture and Supposition (추측과 예상을 나타낼 때)",
  "pattern": "-아/어 보이다",
  "title_en": "<short English gloss>",
  "category": "<short tag, e.g. conjecture / contrast / reason / passive>",
  "proficiency": "L3" | "L4" | "L5+",               // default L3/L4 for Intermediate; bump to L5+ if clearly advanced
  "register": "해요체" | "합쇼체" | "반말" | "문어체",
  "explanation": "<paragraph from 문법을 알아볼까요?>",
  "formation_rules": ["…"],
  "examples": [{"korean":"…","english":"…"}],       // the cartoon intro dialog 도입 대화 + sample sentences
  "dialogues": [{"context":"In Conversation (대화를 만들어 볼까요?)","lines":[{"speaker":"가","korean":"…","english":"…"}]}],
  "vocabulary": [],                                  // glossed words / Tip boxes
  "tips": ["<더 알아볼까요? content, full prose>"],
  "compare_with": [{"with":"…","note":"…"}],
  "exercises": [{"prompt":"연습해 볼까요? — …","answer":"…"}],
  "cultural_notes": [],
  "notes": "",
  "audio_track": "<Track NN if shown on page>",
  "source_book": "KGIU Intermediate",
  "source_pages": [<book page numbers>]
}
```

## Section labels in the Intermediate book (vs Beginner)

| Korean | English on page | → maps to schema field |
|---|---|---|
| 도입 대화 | (intro cartoon dialog at top) | `examples` (mark as the intro sentences) |
| 문법을 알아볼까요? | Grammar Focus | `explanation` + `formation_rules` (conjugation tables) |
| 더 알아볼까요? | Let's Learn More | `tips[]` (one string per numbered item) |
| 대화를 만들어 볼까요? | Let's Make a Conversation | `dialogues[]` (each numbered exchange is one dialogue) |
| 연습해 볼까요? | Let's Practice | `exercises[]` |
| Tip (yellow box) | Tip | `vocabulary[]` for glossed words; if conceptual note, append to nearest entry's `tips[]` |
| 도입 대화문 번역 | (translation of intro dialog) | already covered by `examples` |

## Chapter intros (장 dividers)

Each chapter (장) begins with a full-page divider in purple/violet listing the chapter
title and the grammar points in that chapter. Make ONE `type:"intro"` entry per chapter:

- `id`: `kgiu-int-cNN-00`
- `pattern`: null
- `title_en`: `"Ch.NN. <English title> — chapter opener"`
- `register`: null
- `explanation`: copy/translate the short blurb on the divider page
- `notes`: `"Contents: 01 <form> · 02 <form> · …"`
- `source_pages`: [the divider book page]

## Critical extraction rules

- **Lose nothing.** Capture grammar focus + intro cartoon dialog + 더 알아볼까요? + 대화를
  만들어 볼까요? + Tip boxes + 연습해 볼까요? + every conjugation table row + irregulars.
- **Vision OCR only** — the PDF text layer is mojibake. Use Read with `pages` parameter.
- **Korean accuracy is mandatory.** Copy the printed English glosses; don't paraphrase Korean.
- **Multi-page grammar points** — list every book page in `source_pages`.
- **In Conversation** sections often have 2-3 numbered exchanges with a vocabulary chart
  underneath listing 3-4 substitution alternatives. Capture the main exchange in `dialogues[]`
  and the substitution lists in `notes` or `dialogues[i].alternatives`.
- **연습해 볼까요? answers** — if the book doesn't print the answer (most don't on the
  practice pages; Answer Key is in the Appendix at p.400), infer the linguistically-correct
  answer from the grammar rule and supply it.

## Output shard convention

- File: `Repository/tools/ingest/output/shard_intermediate_cXX-YY.json` (or chapter-specific name)
- Structure: `{"items": [ ... entries in book-page order ... ]}`
- Do **not** include a top-level `source` header — the merge step will add it.
- Do **not** modify any existing JSON file.

## Validation (each agent before finishing)

```bash
python3 -c "import json; d=json.load(open('PATH')); ids=[i['id'] for i in d['items']]; print(len(d['items']), 'items,', len(ids)-len(set(ids)), 'dups')"
```

If Bash is sandboxed: construct JSON carefully (balanced braces/brackets, escaped quotes,
no trailing commas). The Write tool will fail loudly if the structure is broken.

## Final-message report (each agent)

1. Entry count by type
2. Book pages actually covered
3. Output file path
4. Anomalies, especially tricky conjugations or unclear answers
