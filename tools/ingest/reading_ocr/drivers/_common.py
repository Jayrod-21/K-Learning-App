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
    """The cached Vision fullTextAnnotation for scan ``NNNN`` (None when the
    cache pass stored literal JSON ``null`` for a blank page).

    A MISSING cache file is an error, not a None: silently skipping it would
    drop every passage on that page from the output, so fail loudly and name
    both the scan and the cache dir.
    """
    path = cache_dir / f"{scan:04d}.json"
    try:
        raw = path.read_text("utf-8")
    except FileNotFoundError:
        raise FileNotFoundError(
            f"scan {scan:04d} not in cache {cache_dir} — re-run the "
            f"--cache-dir pass to (re)build the OCR cache"
        ) from None
    return json.loads(raw)


def number_passages(bodies: list[str] | list[tuple[str, int | None]], *,
                    dedup: bool = True) -> list[dict]:
    """Turn ordered bodies into numbered passage dicts.

    Each item is either a plain body string (``page_number`` stays null) or a
    ``(body, page_number)`` pair for books whose passages span known printed
    pages. ``dedup`` drops exact-duplicate bodies (facing-page spreads re-OCR
    the same block); the first occurrence wins — keeping its page number — and
    numbering stays gap-free.
    """
    seen: set[str] = set()
    passages: list[dict] = []
    for item in bodies:
        body, page = item if isinstance(item, tuple) else (item, None)
        if dedup and body in seen:
            continue
        seen.add(body)
        passages.append({"passage_number": len(passages) + 1, "body": body,
                         "page_number": page})
    return passages


def write_document(out_path: Path, source: dict, chapters: list[dict]) -> None:
    """Write the ``{source, chapters}`` literature document and print a summary."""
    doc = {"source": source, "chapters": chapters}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    passages = sum(len(c["passages"]) for c in chapters)
    print(f"DONE: {len(chapters)} chapters, {passages} passages -> {out_path}")
