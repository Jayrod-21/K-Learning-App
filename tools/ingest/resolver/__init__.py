"""
Cross-reference resolver package.

Walks every loaded Darakwon entry's text-form cross-references, normalizes
the target strings, looks the targets up across all corpora (same-corpus
preferred), and populates kgiu_entry_relations / vocab_entry_relations with
FK links where the target exists and text fallback where it doesn't.

WHY a separate package, not a module: the resolver has four logically
distinct stages (extract, normalize, lookup, write) and one CLI driver.
Each stage is small, has its own tests, and the package boundary keeps the
test surface honest.

Public surface:
    * pipeline.run(...)          — orchestrate one corpus.
    * pipeline.run_all(...)      — orchestrate all corpora.
    * extractor.extract_*        — pull refs out of a source-JSON entry.
    * normalize.normalize_target — NFC + whitespace + homograph index parser.
    * lookup.LookupIndex         — same-corpus-prefer FK resolution.

The entry-point CLI is `tools/ingest/resolve_cross_references.py`.
"""

from __future__ import annotations
