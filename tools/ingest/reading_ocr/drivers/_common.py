#!/usr/bin/env python3
"""Shared helpers for the per-book structured-OCR drivers.

Each driver in this package maps ONE scanned book's page-images into the curated
literature JSON that ``tools/ingest/loaders/load_literature.py`` consumes. They
all read a pre-built OCR cache (see ``vision_ocr_book.py --cache-dir``) rather
than calling Vision directly, so re-slicing a book while dialing in its chapter
boundaries is local and free.

The book-specific structure (chapter names, boundary scans, page offset, section
markers) lives at the top of each driver; the reusable plumbing lives here.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Make the sibling ``vision_ocr_book`` importable when a driver is run directly
# as ``python drivers/<book>.py`` (its shared extractors are the engine).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def cached_fta(cache_dir: Path, scan: int) -> dict | None:
    """The cached Vision fullTextAnnotation for page ``NNNN.json`` (or None)."""
    return json.loads((cache_dir / f"{scan:04d}.json").read_text("utf-8"))


def number_passages(bodies: list[str], *, dedup: bool = True,
                    page_number: int | None = None) -> list[dict]:
    """Turn ordered body strings into numbered passage dicts.

    ``dedup`` drops exact-duplicate bodies (facing-page spreads re-OCR the same
    block); the first occurrence wins and numbering stays gap-free.
    """
    seen: set[str] = set()
    passages: list[dict] = []
    for body in bodies:
        if dedup and body in seen:
            continue
        seen.add(body)
        passages.append({"passage_number": len(passages) + 1, "body": body,
                         "page_number": page_number})
    return passages


def write_document(out_path: Path, source: dict, chapters: list[dict]) -> None:
    """Write the ``{source, chapters}`` literature document and print a summary."""
    doc = {"source": source, "chapters": chapters}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    passages = sum(len(c["passages"]) for c in chapters)
    print(f"DONE: {len(chapters)} chapters, {passages} passages -> {out_path}")
