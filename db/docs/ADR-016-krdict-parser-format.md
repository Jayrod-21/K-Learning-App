# ADR-016: KRDICT parser input format — XML (TEI-lite)

**Status:** Accepted, **AMENDED 2026-06** (see "Correction" below)
**Date:** 2026-05-28
**Implemented in:** `tools/ingest/krdict_parser.py`
**Owner:** Agent B2 (KRDICT)
**Relates to:** ADR-015 (KRDICT schema), ADR-001 §"Security"

> ## Correction (2026-06)
> The "XML, not JSON" call was right; the **schema** was wrong. The actual KRDICT
> bulk download (krdict.korean.go.kr → 사전 전체 내려받기, the 2026-05 export) is
> **LMF** (Lexical Markup Framework, `DTD_LMF_REV_16`):
> `<LexicalResource><Lexicon><LexicalEntry>` with every value as a
> `<feat att="X" val="Y"/>` pair — not the assumed `<entry><form><sense><cit>`
> TEI-Lite shape (the original fixture was hand-crafted/fictional).
> `krdict_parser.py` was rewritten for LMF. The rest of this ADR still holds:
> XML over JSON/CSV (LMF carries the `WordForm[type=활용]` conjugation tables and
> the multilingual `Equivalent` blocks JSON drops), defusedxml, streaming
> `iterparse`. Two LMF-specific additions: `forbid_dtd=False` (every real file
> declares a SYSTEM DOCTYPE; `forbid_entities`/`forbid_external` stay the real
> XXE defenses) and a byte-level control-character filter (KRDICT embeds
> XML-illegal control chars that otherwise abort expat mid-file). License is
> CC BY-SA 2.0 KR, not KOGL Type 1 (see KRDICT_README.md).

## Context

KRDICT (https://krdict.korean.go.kr/eng/mainAction → "오픈 사전 자료" / "Open
KORLEX") publishes its dataset in several formats. The two practical choices
are:

1. **XML** — a TEI-Lite-inspired structure: `<entry>`, `<form>`, `<sense>`,
   `<cit type="example">`, `<lbl>`, etc. Distributed as a multi-volume
   archive of XML files, one per letter range or thematic group.
2. **JSON** — a more recent export, hierarchical, less metadata-rich than
   XML (some fields elided). Easier to parse, less complete.

CSV is also offered, but flattens senses and examples into one row per
example, losing structure we need.

## Decision

**Parse XML, with `defusedxml`.** Reasons:

- **Completeness.** The XML carries the full set of fields KRDICT publishes
  — sense numbers, example translations, hanja, register, pronunciation,
  conjugation tables (verbs/adjectives). The JSON export drops conjugation
  tables and the per-sense register tag.
- **Lower-bound correctness.** TEI-Lite is a well-known dictionary schema;
  the structure is documented. If KRDICT ever publishes a schema update,
  XML diffs cleanly.
- **Defense in depth.** `defusedxml.ElementTree` blocks XXE (XML external
  entities), entity bomb (billion laughs) attacks, and DTD-driven DoS. The
  stdlib `xml.etree.ElementTree` does NOT defend against these — XXE in
  particular is the classic XML parser vulnerability and KRDICT is a
  government download, not an in-house file we can vouch for. (See
  `KRDICT_SECURITY.md`.)
- **Streaming.** XML can be parsed entry-by-entry via `iterparse` so we
  never hold the whole multi-hundred-MB file in memory.

## Alternatives considered

- **JSON.** Faster to parse, but loses conjugation tables and per-sense
  register. We'd need to re-derive conjugations via Kiwi, which is fine
  for surface forms but loses KRDICT's curated forms (which include
  irregularities). Rejected.
- **CSV.** Loses the sense/example hierarchy. Rejected.
- **Standard library `xml.etree.ElementTree`.** XXE-vulnerable by default
  in older Python; even modern Python lacks the entity-bomb defenses
  defusedxml provides. Rejected.
- **`lxml`.** Fast and flexible, but has its own history of CVE issues
  with external entities (XXE) when not configured carefully. `defusedxml`
  wraps `xml.etree.ElementTree` in a hardened form which is enough for our
  needs without adding a C-extension dependency.

## Consequences

- Parser depends on `defusedxml` (small pure-Python wrapper around stdlib).
- Streaming via `iterparse` plus `elem.clear()` on each completed entry
  keeps memory flat regardless of file size.
- Pydantic models in `krdict_models.py` are the parser's output contract;
  the loader doesn't know about XML at all.
- If KRDICT publishes a schema breakage, only `krdict_parser.py` changes;
  schema and loader are untouched.

## Open questions

- **Multi-file inputs.** KRDICT splits the archive across many XML files.
  The CLI accepts either a single file or a directory; the parser iterates
  every `*.xml` under a directory recursively, deterministically (sorted
  filename order) so resume offsets are stable.
- **Encoding.** KRDICT XML is UTF-8. The parser passes `encoding='utf-8'`
  explicitly so byte-order-mark or missing declarations don't fall back
  to platform default.
