# 2000 Essential Korean Words — Shared Extraction Guide

Used by all parallel subagents extracting both books in the `2000 Essential Korean Words` series
(Beginner and Intermediate). Reference this so per-agent prompts can stay short.

## Source PDFs (both read directly via the Read tool's vision — both under 100MB)

- `Darakwon/단어/2000 Essential Korean Words - Beginner.pdf` (43MB, 505 pages)
- `Darakwon/단어/2000 Essential Korean Words - Intermediate.pdf` (63MB, 538 pages)

**PDF/book offset:** approximately book ≈ PDF + 1 to +2 for these books — always verify by the
printed page number at the bottom of each page. (Vocab books have minimal front matter, so the
offset is small. Drift may occur near appendix.)

## Book structure (same for both)

- **14 themes** (큰 주제 — e.g., 인간 People, 행동 Actions, 성질/양 Quality/Quantity, etc.)
- Each theme has **subsections** (작은 주제) on related categories
- Each subsection lists **word entries**, each with:
  - Korean headword (large bold)
  - Pronunciation in brackets `[가족]`
  - Part-of-speech marker (Korean abbreviation in colored circle: 대 pronoun, 명 noun, 동 verb,
    형 adjective, 부 adverb, 감 exclamation, 관 determiner, 의명 bound noun)
  - Cross-references to other entries (e.g., `Appendix p.469`)
  - English translation
  - Chinese translation (simplified)
  - Japanese translation
  - Example sentence in Korean (with bolded headword)
  - English translation of example (sometimes)
  - 동 synonym list with cross-ref page
  - 반 antonym list with cross-ref page
  - 관 related word/expression
  - 참 reference word
  - 피 passive form
  - 사 causative form
  - 본 basic form (for passive/causative entries)
  - 높 honorific form
  - 낮 humble form
  - 준 contracted form
  - Lightbulb icon = Tip (usage note)
- **Let's Check!** — review exercise pages after each subsection
- **Korean through Chinese Characters** — hanja extension page at the end of each theme (focuses on
  one character + words built from it)
- **Appendix** (book pp.466-521 or similar): Additional Vocabulary lists, Passive/Causative tables,
  Antonyms/Synonyms list, Prefixes/Suffixes, Answers, Index

## Schema (RICH, per entry)

### Word entry (type:"word") — the main type
```json
{
  "id": "vocab-int-0001",                            // sequential within the book
  "type": "word",
  "korean": "가족",
  "english": "a family",
  "pronunciation": "[가족]",
  "part_of_speech": "noun",                          // noun | verb | adjective | adverb | pronoun | exclamation | determiner | bound_noun
  "hanja": "家族",                                    // Chinese (traditional or simplified as shown)
  "japanese": "家族",
  "proficiency": "L3" | "L4",                         // Intermediate: L3 default, L4 if marked TOPIK 27-28
  "theme": "01 인간 / People",                        // top-level theme
  "subsection": "1 가족/친척 / Family/Relatives",      // subsection within theme
  "example_korean": "엔디: 가족이 모두 몇 명이에요?",
  "example_english": "Andy: How many people are in your family?",  // if printed
  "related": [{"korean":"식구","english":"family members","page":19}],
  "synonyms": [],
  "antonyms": [],
  "passive_form": null,                              // for verbs
  "causative_form": null,                            // for verbs
  "basic_form": null,                                // for passive/causative entries
  "honorific_form": null,
  "humble_form": null,
  "contracted_form": null,
  "irregular_class": null,                           // e.g., "ㅂ-irregular" if marked
  "case_marker": null,                               // e.g., "을/를" if printed before verb
  "tips": [],                                        // light-bulb notes
  "cross_refs": [{"label":"Appendix","page":469}],   // page pointers shown on the entry
  "audio_track": "track 01",
  "source_book": "2000 Essential Korean Words Intermediate",   // or Beginner
  "source_pages": [16]
}
```

### Supplementary entries
- `type:"theme_intro"` — for the big 14 theme dividers; `pattern:null`, `notes` lists subsection titles
- `type:"subsection_intro"` — for subsection openers (the page with the theme number, large 감정
  text, and audio track ribbon); usually folded into the first word's `notes`
- `type:"lets_check"` — for Let's Check! pages (review exercises). Capture questions + best
  inferred answers.
- `type:"hanja_extension"` — for Korean through Chinese Characters pages. Each shows ONE
  central character (e.g., 心 a mind) and 6-10 derived words branching from it. Capture all
  derived words as related entries.
- `type:"reference"` — for appendix sections; one entry per appendix subsection summarizing what
  it lists, with key items in `notes`

## Section labels in the vocab books

| Korean | English in book | → schema field |
|---|---|---|
| 동 | Verb POS marker | `part_of_speech` = "verb" |
| 명 | Noun POS marker | `part_of_speech` = "noun" |
| 형 | Adjective POS marker | `part_of_speech` = "adjective" |
| 부 | Adverb POS marker | `part_of_speech` = "adverb" |
| 대 | Pronoun POS marker | `part_of_speech` = "pronoun" |
| 감 | Exclamation | `part_of_speech` = "exclamation" |
| 관 | Determiner | `part_of_speech` = "determiner" |
| 의명 | Bound noun | `part_of_speech` = "bound_noun" |
| 동 (rectangle) | Synonym (유의어) | `synonyms[]` |
| 반 | Antonym | `antonyms[]` |
| 관 | Related word | `related[]` |
| 참 | Reference | `cross_refs[]` |
| 피 | Passive form | `passive_form` |
| 사 | Causative form | `causative_form` |
| 본 | Basic form | `basic_form` |
| 높 | Honorific form | `honorific_form` |
| 낮 | Humble form | `humble_form` |
| 준 | Contracted form | `contracted_form` |
| 💡 light bulb | Tip / usage note | `tips[]` |
| Let's Check! | Review exercises | `type:"lets_check"` entry |
| Korean through Chinese Characters | Hanja extension | `type:"hanja_extension"` entry |

## Critical extraction rules

- **Vision OCR only** — the PDF text layer is mojibake/missing.
- **Korean accuracy is mandatory.** Copy printed English/Chinese/Japanese glosses verbatim.
- **High entry density** — ~3-4 word entries per page. Read pages in batches of 5-8.
- **Maintain sequential IDs within the shard** (e.g., `vocab-int-0001`, `vocab-int-0002`, ...).
  After merge the sort step will renumber for global sequence — but within your shard, increment.
- **Don't skip entries.** Every headword on every page should be captured. If a page has 4
  entries, expect 4 `type:"word"` entries.
- **Lose nothing supplementary.** Capture all Tip light bulbs, Let's Check questions, Korean
  through Chinese Characters mind maps, and theme intro page summaries.

## Proficiency tagging

- **Beginner book:** default `"basic"` (matches the existing Beginner grammar tier)
- **Intermediate book:** default `"L3"`; bump to `"L4"` for words marked with the TOPIK 27-28 icon
  or explicitly flagged as more advanced

## Output shard convention

- Beginner: `shard_vocab_beg_theme_XX.json` (or similar)
- Intermediate: `shard_vocab_int_theme_XX.json`
- Structure: `{"items": [ ... entries in book-page order ... ]}`
- Do **not** include a top-level `source` header — the merge step adds it.
- Do **not** modify any existing JSON file.

## Validation (each agent before finishing)

```bash
python3 -c "import json; d=json.load(open('PATH')); ids=[i['id'] for i in d['items']]; print(len(d['items']), 'items,', len(ids)-len(set(ids)), 'dups')"
```

If Bash is sandboxed: construct JSON carefully. The Write tool fails loudly if structure is broken.

## Final-message report (each agent)

1. Entry count by type (word / theme_intro / lets_check / hanja_extension / reference)
2. Book page range covered
3. Output file path
4. Anomalies — especially missing pages, unusual word entries, or content the schema doesn't fit
