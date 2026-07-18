#!/usr/bin/env python3
"""Real-Life Korean Conversations: Intermediate — TTMIK (id=19) → literature JSON.

Layout: 30 dialogues. Each dialogue unit is 'Dialogue in Korean' (Korean speaker
turns) → English Translation → Vocabulary → Pattern Practice → Answer Key →
Exercises. Only the Korean dialogue turns become passages; each dialogue is one
reading_chapter.

State machine (per dialogue): KEEP from 'Dialogue in Korean' until 'Vocabulary'.
  - The interleaved English-translation pages self-filter by Korean-ratio.
  - 'Vocabulary' onward (Pattern Practice / Answer Key / Exercises — which DO
    contain Korean example sentences) is dropped until the next dialogue.
Turns are short (9-70 chars) so the length floor is low (min flat len 6); an OCR
wrap-fragment (a turn's tail on its own line, "어요.", "요?"; len ≤ 5) is glued back
onto the turn it belongs to rather than dropped.

Dialogue boundaries: the 30 'Dialogue in Korean' scans below (= printed TOC page
+ 4). The book's first 'Dialogue in Korean' (a How-To sample) is excluded.

Usage:
  python3 -m tools.ingest.reading_ocr.vision_ocr_book --scan-dir <scans> --cache-dir <cache>
  python3 drivers/real_life_conversations.py --cache-dir <cache> --out reallife.json
"""
from __future__ import annotations

import argparse
from pathlib import Path

from _common import cached_fta, number_passages, write_document
from vision_ocr_book import ordered_paragraphs, _korean_ratio

SOURCE_UPLOAD_ID = 19
BOOK_TITLE = "Real-Life Korean Conversations: Intermediate"
OFFSET = 4           # scan - printed
END_SCAN = 382

TITLES = [
    "Self-Introductions", "Exchanging Numbers", "How are you?", "Plans", "Dinner",
    "Wedding", "Coming Home", "Waking Up", "Clothing Store", "Shoe Store",
    "Furniture Store", "Cosmetics Store", "Blind Date", "Movie Date", "Park",
    "Rejection", "Overtime Work", "Meeting", "Company Dinner", "Class", "Exam",
    "Restaurant", "Cooking", "Ordering Delivery", "Pharmacy", "Hospital",
    "Not Feeling Well", "Taxi", "Subway", "Airplane",
]
STARTS = [16, 28, 42, 54, 66, 78, 90, 102, 114, 126, 138, 150, 164, 176, 188,
          200, 212, 224, 236, 248, 260, 272, 284, 296, 308, 320, 332, 344, 356, 368]


def _dialogue_turns(cache_dir: Path, start: int, end: int) -> list[str]:
    state = "KEEP"           # each dialogue begins in its 'Dialogue in Korean' section
    turns: list[str] = []
    for scan in range(start, end + 1):
        for _y, t in ordered_paragraphs(cached_fta(cache_dir, scan)):
            flat = t.replace(" ", "")
            if t.strip() == "Vocabulary":                 # end of the Korean dialogue
                state = "DROP"
                continue
            if "DialogueinKorean" in flat:                 # (re)start the Korean section
                state = "KEEP"
                continue
            if state != "KEEP":
                continue
            kr = _korean_ratio(t)
            if len(flat) >= 6 and kr >= 0.6:
                turns.append(t)
            elif len(flat) <= 5 and kr >= 0.4 and turns:
                turns[-1] = turns[-1] + t                  # glue a wrapped turn-tail back
    return turns


def build(cache_dir: Path) -> list[dict]:
    bounds = list(STARTS) + [END_SCAN + 1]
    chapters = []
    for i, (title, start) in enumerate(zip(TITLES, STARTS)):
        end = bounds[i + 1] - 1
        passages = number_passages(_dialogue_turns(cache_dir, start, end))
        chapters.append({"chapter_number": i + 1, "title": f"Dialogue #{i+1} {title}",
                         "start_page": start - OFFSET, "end_page": end - OFFSET,
                         "passages": passages})
        print(f"  #{i+1:2d} {title}: {len(passages)} turns", flush=True)
    return chapters


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
