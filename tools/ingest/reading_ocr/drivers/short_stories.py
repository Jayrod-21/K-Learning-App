#!/usr/bin/env python3
"""Short Stories in Korean — Olly Richards (book_uploads id=16) → literature JSON.

Layout: 8 stories, each split into 제N장 chapters. After every story-chapter comes
a 복습 (review) block — 줄거리 (summary), 어휘 (vocab), 이해도 평가 (comprehension
questions) — which must NOT become reading passages (the questions are a future
feature, F-205). Each story becomes one reading_chapter; only its 제N장 STORY prose
becomes passages.

Section state machine (per story, over paragraphs in reading order):
  - "제N장 복습 …"      → REVIEW (drops the 줄거리 summary, which is otherwise clean
                          prose that the length/Korean filters would keep).
  - "제N장 - <title>"   → STORY. The hyphen is OCR-optional ("제2장 찾기"); matching it
                          strictly once dropped a whole chapter's prose as REVIEW.
  - Running footers ("제2장 - 찾기 39") also match 제N장 → excluded by a trailing page
    digit AND by only honouring the FIRST 제N장 per story (the top heading precedes
    its footer in reading order; page numbers sometimes OCR to a non-digit, e.g.
    "71"→"기", so the seen-set is the real guard).

Story boundaries: the 8 story-chapter-1 scans below (= printed TOC page + 21, the
roman-numeral front matter shifts the offset). Content ends at scan 227 (Answer
Key starts 228).

Usage:
  python3 -m tools.ingest.reading_ocr.vision_ocr_book --scan-dir <scans> --cache-dir <cache>
  python3 drivers/short_stories.py --cache-dir <cache> --out shortstories.json
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from _common import cached_fta, number_passages, write_document
from vision_ocr_book import ordered_paragraphs, _korean_ratio, _is_exercise

SOURCE_UPLOAD_ID = 16
BOOK_TITLE = "Short Stories in Korean"
OFFSET = 21          # scan - printed
END_SCAN = 227       # last story page (Answer Key starts 228)

# (chapter_number, title, story-chapter-1 scan)
STORIES = [
    (1, "미친 비빔밥", 23), (2, "아주 특이한 여행", 51), (3, "기사", 77),
    (4, "시계", 103), (5, "나무 상자", 127), (6, "새로운 땅", 153),
    (7, "투명 인간 지유", 179), (8, "캡슐", 203),
]

_CH_START = re.compile(r"^제\s*(\d+)\s*장")   # story-chapter heading (hyphen optional)


def _is_chapter_heading(m: re.Match | None, flat: str) -> bool:
    """A top story-chapter heading ('제2장 - 찾기', or '제2장 찾기' when OCR drops the
    hyphen) — not the page footer ('제2장 - 찾기 39', ends in a page digit) and not
    the review heading ('제1장 복습 줄거리', caught earlier). ``m`` is the caller's
    already-computed ``_CH_START`` match for the paragraph."""
    return bool(m) and len(flat) < 20 and not flat[-1:].isdigit()


def _story_bodies(cache_dir: Path, start: int, end: int) -> list[str]:
    state = "STORY"          # a story's first page is its 제1장 prose
    seen_ch: set[int] = set()
    bodies: list[str] = []
    for scan in range(start, end + 1):
        for _y, t in ordered_paragraphs(cached_fta(cache_dir, scan)):
            flat = t.replace(" ", "")
            m = _CH_START.match(t)
            # Review heading "제N장 복습 줄거리": anchored on the 제N장 heading shape
            # so a story line that merely mentions 복습 ("복습 좀 해!") can't flip
            # the machine to REVIEW mid-story, and with no length cap so an OCR
            # merge with the first 줄거리 sentence still fires. This branch stays
            # BEFORE the chapter-heading one (load-bearing ordering).
            if m and "복습" in flat:
                state = "REVIEW"
                continue
            if _is_chapter_heading(m, flat):
                cn = int(m.group(1))
                if cn in seen_ch:                          # a later footer, not a heading
                    continue
                seen_ch.add(cn)
                state = "STORY"
                bodies.append(t)                           # inline chapter marker
                continue
            if state != "STORY":
                continue
            if len(flat) >= 25 and _korean_ratio(t) >= 0.6 and not _is_exercise(t):
                bodies.append(t)
    return bodies


def build(cache_dir: Path) -> list[dict]:
    bounds = [s[2] for s in STORIES] + [END_SCAN + 1]
    chapters = []
    for i, (cn, title, start) in enumerate(STORIES):
        end = bounds[i + 1] - 1
        passages = number_passages(_story_bodies(cache_dir, start, end))
        chapters.append({"chapter_number": cn, "title": title,
                         "start_page": start - OFFSET, "end_page": end - OFFSET,
                         "passages": passages})
        print(f"  story {cn} {title}: {len(passages)} passages", flush=True)
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
