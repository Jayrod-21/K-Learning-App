#!/usr/bin/env python3
"""너의 이름은 (book_uploads id=14) → literature JSON.

Layout: a novel. Its 8 chapters open on bare "제N장" title pages, so the chapter
title pages ARE the boundaries — no printed-page↔scan offset arithmetic needed
(novels drift, so marker detection beats a constant offset). Each chapter's
facing-page prose becomes passages (``story_paragraphs`` with ``anchor=False``).

Boundary detection: a page is a chapter title page when its flattened text is a
bare "제N장" (``< 12`` chars). The regex is NOT ^-anchored and uses ``.search``
because some title pages carry a leading ornament that OCRs as "0"/"O" (scan 0016
== "0\n제2장", scan 0260 == "O\n제8장"). Extraction stops at the 작가후기 afterword.

Usage:
  python3 -m tools.ingest.reading_ocr.vision_ocr_book --scan-dir <scans> --cache-dir <cache>
  python3 drivers/your_name_novel.py --cache-dir <cache> --out yourname.json
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from _common import cached_fta, number_passages, write_document
from vision_ocr_book import ordered_paragraphs, story_paragraphs

SOURCE_UPLOAD_ID = 14
BOOK_TITLE = "너의 이름은"
FIRST_SCAN = 9       # first content page (after front matter)
LAST_SCAN = 289      # scan an upper bound; extraction stops at the afterword

NAMES = {1: "꿈", 2: "단서", 3: "나날", 4: "탐방", 5: "기억",
         6: "재연", 7: "아름답게, 발버둥치다", 8: "너의 이름은"}

_CH_RE = re.compile(r"제([1-8])장")   # NOT ^-anchored: some title pages lead with an ornament


def build(cache_dir: Path) -> list[dict]:
    chapters: list[dict] = []
    cur: dict | None = None
    for scan in range(FIRST_SCAN, LAST_SCAN + 1):
        path = cache_dir / f"{scan:04d}.json"
        if not path.exists():
            break
        fta = cached_fta(cache_dir, scan)
        flat = "".join(t for _y, t in ordered_paragraphs(fta)).replace(" ", "")
        m = _CH_RE.search(flat)
        if m and len(flat) < 12:                          # a bare "제N장" title page
            cn = int(m.group(1))
            cur = {"chapter_number": cn, "bodies": [],
                   "title": f"제{cn}장 {NAMES.get(cn, '')}".strip()}
            chapters.append(cur)
            print(f"  scan {scan:04d}: 제{cn}장 start", flush=True)
            continue
        if ("작가후기" in flat or "작가의말" in flat) and len(flat) < 20:
            print(f"  scan {scan:04d}: afterword — stop", flush=True)
            break
        if cur is not None:
            cur["bodies"].extend(story_paragraphs(fta, anchor=False))

    out = []
    for c in chapters:
        out.append({"chapter_number": c["chapter_number"], "title": c["title"],
                    "start_page": None, "end_page": None,
                    "passages": number_passages(c["bodies"])})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args(argv)
    write_document(args.out, {
        "source_upload_id": SOURCE_UPLOAD_ID, "book_title": BOOK_TITLE,
        "extracted_by": "vision-ocr", "extraction_complete": True,
    }, build(args.cache_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
