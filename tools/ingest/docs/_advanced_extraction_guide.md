# KGIU Advanced — Shared Extraction Guide

Used by all parallel subagents extracting `Korean Grammar in Use: Advanced` (안진명, 손은희).
Reference this so per-agent prompts can stay short.

## Source PDF (no splitting — 85MB, under the 100MB Read cap)

`Darakwon/한국어 문법/3. Advanced - KGIU.pdf` (349 PDF pages, original)

**PDF/book offset:** book page ≈ PDF page + 8 (verified: PDF p.6 = book p.14, Ch.1 #01).
Always verify by the page number printed at the bottom of each book page.

## Book structure

22 chapters (장1–장22). Each chapter is "Expressing X" (X를 나타낼 때 / X을/를 나타낼 때).
Each chapter:
- A purple-pink divider page listing the chapter title and the grammar points
- 2–11 grammar points (Ch.4 is heaviest with 11)
- Each grammar point typically spans 3–4 pages:
  - 도입 대화 (cartoon intro dialogue)
  - 문법을 알아볼까요? (Grammar Focus paragraph + conjugation tables)
  - 더 알아볼까요? (Let's Learn More — numbered tips and rules)
  - 이럴 때는 어떻게 말할까요? (How do we say it in this situation? — additional dialogue + substitutions)
  - 연습해 볼까요? (Let's Practice — exercises; answer key in Appendix p.360+)
- 확인해 볼까요? at end of chapter (review quiz; may be folded into the last grammar entry's exercises)

## Schema (RICH, per entry)

```json
{
  "id": "kgiu-adv-c01-01",                          // id prefix "kgiu-adv-", c=chapter
  "type": "grammar" | "intro",
  "unit": "Ch.1. Expressing Choices (선택을 나타낼 때)",
  "pattern": "-느니",
  "title_en": "<short English gloss>",
  "category": "<short tag, e.g. choice / quotation / nominalization / cause / hypothetical>",
  "proficiency": "L4" | "L5+",                       // default L4/L5+ for Advanced; almost never L3
  "register": "해요체" | "합쇼체" | "반말" | "문어체" | "하오체" | "하게체",
  "explanation": "<paragraph from 문법을 알아볼까요?>",
  "formation_rules": ["..."],
  "examples": [{"korean":"…","english":"…"}],        // intro dialog + sample sentences from Grammar Focus
  "dialogues": [{"context":"How do we say it (이럴 때는 어떻게 말할까요?)","lines":[{"speaker":"가","korean":"…","english":"…"}]}],
  "vocabulary": [],                                   // Tip-box glossed words
  "tips": ["<더 알아볼까요? content, full prose, one string per numbered item>"],
  "compare_with": [{"with":"…","note":"…"}],
  "exercises": [{"prompt":"연습해 볼까요? — …","answer":"…"}],
  "cultural_notes": [],
  "notes": "",
  "audio_track": "<Track NN>",
  "source_book": "KGIU Advanced",
  "source_pages": [<book page numbers>]
}
```

## Chapter intros (장 dividers)

Each chapter begins with a pink/purple divider page. Make ONE `type:"intro"` per chapter:

- `id`: `kgiu-adv-cNN-00`
- `pattern`: null
- `title_en`: `"Ch.NN. <English title> — chapter opener"`
- `register`: null
- `explanation`: copy the short blurb on the divider page
- `notes`: `"Contents: 01 <form> · 02 <form> · …"`
- `source_pages`: [the divider book page]

## Section labels in the Advanced book

Same as Intermediate. Map:

| Korean | → schema field |
|---|---|
| 도입 대화 | `examples` (the cartoon dialog) |
| 도입 대화문 번역 | already covered in `examples` (English glosses) |
| 문법을 알아볼까요? | `explanation` + `formation_rules` |
| 더 알아볼까요? | `tips[]` (one string per numbered item) |
| 이럴 때는 어떻게 말할까요? | `dialogues[]` |
| Tip (yellow box) | `vocabulary[]` for glossed words; if conceptual, append to nearest `tips[]` |
| 연습해 볼까요? | `exercises[]` |
| 비교해 볼까요? | `compare_with[]` (or condensed into `tips[]`) |
| 확인해 볼까요? (end of chapter) | append to last grammar entry's `exercises[]` and note in `notes` |

## Extraction rules — LOSE NOTHING

- **Vision OCR only** — the PDF text layer is mojibake.
- **Korean accuracy is mandatory.** Copy printed English glosses verbatim; don't paraphrase Korean.
- **Multi-page grammar points** — list every book page in `source_pages`.
- **Capture all formation rules** including full conjugation tables and irregular notes.
- **Capture every 더 알아볼까요? tip** as a separate string in `tips[]`.
- **Capture every 비교해 볼까요? table** — these are critical for Advanced (the whole book hinges on
  distinguishing similar forms). Put in `compare_with[]` or in `tips[]` as a condensed table.
- **연습해 볼까요? answers** — the practice pages don't print answers (Answer Key is in Appendix p.360,
  which may or may not be in the PDF range). Infer linguistically-correct answers from the rule.

## Proficiency tagging (Advanced default)

- Default to **L4** for typical advanced grammar
- Bump to **L5+** for forms that are:
  - Literary/written-only (-(으)ㅁ으로써, -(으)므로, etc.)
  - Highly stylistic (하오체, 하게체, -(으)랴 -(으)랴)
  - Rare colloquial idioms with narrow contexts (-기 십상이다, -기 일쑤이다)

## Output shard convention

- File: `Repository/tools/ingest/output/shard_advanced_cXX[-YY].json`
- Structure: `{"items": [ ... entries in book-page order ... ]}`
- Do **not** include a top-level `source` header — the merge step adds it.
- Do **not** modify any existing JSON file.

## Validation (each agent before finishing)

```bash
python3 -c "import json; d=json.load(open('PATH')); ids=[i['id'] for i in d['items']]; print(len(d['items']), 'items,', len(ids)-len(set(ids)), 'dups')"
```

If Bash is sandboxed: construct JSON carefully (balanced braces/brackets, escaped quotes, no
trailing commas). The Write tool fails loudly if the structure is broken.

## Final-message report (each agent)

1. Entry count by type
2. Book pages actually covered
3. Output file path
4. Anomalies — especially tricky 비교해 볼까요? tables, missing pages, or unclear answers

## Cross-references to lower levels

Many Advanced forms parallel or extend Beginner/Intermediate ones. When applicable, add a
`compare_with` entry pointing to the lower-level entry id, e.g.:
- Advanced -느니 → Intermediate Ch.5 indirect quotations
- Advanced -(느)ㄴ다니까 → Intermediate Ch.5 quotative reactions
- Advanced -듯이 / -다시피 하다 → Beginner Unit 3.18 처럼/같이
- Advanced 피동과 사동 → Intermediate Ch.9 + Ch.10
