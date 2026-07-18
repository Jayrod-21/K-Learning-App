#!/usr/bin/env python3
"""내 삶에 힘이 되는 니체의 말 (book_uploads id=15) → literature JSON.

Layout: a prose self-help book. Seven 장 chapters, each a run of short titled
sections (heading + a Nietzsche quote + commentary) across facing pages. Every
page is story text, so each chapter's qualifying Korean paragraphs become
passages in reading order (``story_paragraphs`` with ``anchor=False`` drops the
running header / page-number footers by length + Korean-ratio).

Structure map (validated against the printed 차례 / TOC):
  - The seven chapters open on bare "N장 <title>" title pages at the scans below;
    the printed→scan offset is a constant +4 (printed page 5 == scan 9).
  - Content runs to scan 276 (no back-matter after 7장).

Usage:
  python3 -m tools.ingest.reading_ocr.vision_ocr_book --scan-dir <scans> --cache-dir <cache>
  python3 drivers/nietzsche.py --cache-dir <cache> --out nietzsche.json
"""
from __future__ import annotations

import argparse
from pathlib import Path

from _common import cached_fta, write_document
from vision_ocr_book import story_paragraphs

SOURCE_UPLOAD_ID = 15
BOOK_TITLE = "내 삶에 힘이 되는 니체의 말"
OFFSET = 4          # scan - printed
END_SCAN = 276      # last content page

# (chapter_number, title, title-page scan, printed_start)
CHAPTERS = [
    (1, "1장 세상 바라보기", 21, 17),
    (2, "2장 나를 바로 세우기", 57, 53),
    (3, "3장 건강한 관계 맺기", 95, 91),
    (4, "4장 운명과 마주하기", 131, 127),
    (5, "5장 시련 극복하기", 169, 165),
    (6, "6장 성장을 위한 힘 키우기", 199, 195),
    (7, "7장 건강하고 행복하게 살기", 237, 233),
]


def build(cache_dir: Path) -> list[dict]:
    bounds = [c[2] for c in CHAPTERS] + [END_SCAN + 1]
    chapters = []
    for i, (cn, title, start_scan, pstart) in enumerate(CHAPTERS):
        end_scan = bounds[i + 1] - 1
        seen: set[str] = set()
        passages: list[dict] = []
        for scan in range(start_scan + 1, end_scan + 1):  # skip the bare title page
            for body in story_paragraphs(cached_fta(cache_dir, scan), anchor=False):
                if body in seen:
                    continue
                seen.add(body)
                passages.append({"passage_number": len(passages) + 1, "body": body,
                                 "page_number": scan - OFFSET})
        chapters.append({
            "chapter_number": cn, "title": title,
            "start_page": pstart, "end_page": end_scan - OFFSET, "passages": passages,
        })
        print(f"  ch{cn}: {len(passages)} passages", flush=True)
    return chapters


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args(argv)
    chapters = build(args.cache_dir)
    write_document(args.out, {
        "source_upload_id": SOURCE_UPLOAD_ID, "book_title": BOOK_TITLE,
        "extracted_by": "vision-ocr", "extraction_complete": True,
    }, chapters)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
