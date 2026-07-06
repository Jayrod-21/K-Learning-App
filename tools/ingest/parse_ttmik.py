#!/usr/bin/env python3
"""
parse_ttmik.py — Convert a TTMIK lesson-script PDF into a structured JSON file
matching schema_v2_content.sql (sources / source_units / sentences).

Usage:
    python parse_ttmik.py <input.pdf> <output.json> --series-title "TTMIK Level 1-3" --slug ttmik-1-3

Pipeline:
    1. Shell out to pdftotext -layout (text-extractable PDF, no OCR needed).
    2. Split text into lessons by header "LEVEL X LESSON Y".
    3. Within each lesson, extract sentence lines matching:
         "<korean>. = <english>"          (with optional [romanization] block)
         "<korean>. [<romanization>] = <english>"
       Also captures dialog lines "A: 안녕하세요 [annyeong-haseyo] = Hello."
    4. Emit JSON: { source, units: [{ordinal, level, lesson, sentences: [...]}] }

Outputs JSON only — no DB writes. A separate loader script will INSERT into Supabase.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path


# Lines matching this are PDF page footers we want to drop.
FOOTER_PATTERNS = [
    re.compile(r"This PDF is to be used along with the MP3 audio lesson"),
    re.compile(r"Please feel free to share TalkToMeInKorean"),
    re.compile(r"is studying Korean\. If you have any questions"),
    re.compile(r"^TalkToMeInKorean\.com - Free Korean Lesson Notes\s*$"),
    re.compile(r"^From TalkToMeInKorean\.com\s*$"),
    re.compile(r"^Printed by the Korea Seoul South Mission\s*$"),
    re.compile(r"^Printed December \d{4}\s*$"),
    re.compile(r"^Levels? \d+(\s*-\s*\d+)?\s*$"),
]

# Lesson header: "LEVEL 1 LESSON 5"
LESSON_HEADER_RE = re.compile(r"^\s*LEVEL\s+(\d+)\s+LESSON\s+(\d+)\s*$", re.IGNORECASE)

# Sentence line patterns. Korean chars: AC00-D7AF (Hangul syllables) + 3130-318F (Jamo)
KOREAN_CHAR = r"[가-힯㄰-㆏]"

# Patterns we look for in priority order. Each capture group is named.
# 1) Korean [romanization] = English
SENTENCE_RE_WITH_ROMAN = re.compile(
    rf"^\s*(?P<korean>[^=\[]*{KOREAN_CHAR}[^=\[]*)"
    rf"\s*\[(?P<roman>[^\]]+)\]\s*=\s*(?P<english>.+?)\s*$"
)
# 2) Korean = English
SENTENCE_RE_NO_ROMAN = re.compile(
    rf"^\s*(?P<korean>[^=]*{KOREAN_CHAR}[^=]*?)\s*=\s*(?P<english>.+?)\s*$"
)
# 3) Dialog line: "A: 안녕하세요 [annyeong-haseyo] = Hello."
DIALOG_RE = re.compile(
    rf"^\s*(?P<speaker>[A-Z])\s*:\s*"
    rf"(?P<korean>[^=\[]*{KOREAN_CHAR}[^=\[]*)"
    rf"(?:\s*\[(?P<roman>[^\]]+)\])?"
    rf"\s*=\s*(?P<english>.+?)\s*$"
)


@dataclass
class Sentence:
    ordinal: int
    korean: str
    english: str | None
    romanization: str | None = None
    speaker: str | None = None
    is_dialog: bool = False
    content_hash: str = ""

    def finalize(self):
        h = hashlib.sha256(
            (self.korean + "|" + (self.english or "")).encode("utf-8")
        ).hexdigest()
        self.content_hash = h


@dataclass
class Unit:
    ordinal: int
    level: int
    lesson: int
    title: str
    sentences: list[Sentence] = field(default_factory=list)


@dataclass
class Source:
    slug: str
    type: str
    title: str
    publisher: str
    level: str | None
    copyright_status: str
    metadata: dict


def extract_text(pdf_path: Path) -> str:
    """Run pdftotext -layout and return the full text."""
    result = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def is_footer(line: str) -> bool:
    return any(p.search(line) for p in FOOTER_PATTERNS)


# Curated real lesson titles, derived from each lesson's actual content (the
# TTMIK PDFs ship no per-lesson titles — only "Level N Lesson M"). Keyed by
# (level, lesson); see data/ttmik_lesson_titles.json. Missing entries fall back
# to the old placeholder so a new/unseen lesson still loads.
_TITLES_PATH = Path(__file__).parent / "data" / "ttmik_lesson_titles.json"


def _load_lesson_titles() -> dict[tuple[int, int], str]:
    if not _TITLES_PATH.exists():
        return {}
    try:
        data = json.loads(_TITLES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {
        (int(e["level"]), int(e["lesson"])): str(e["title"]).strip()
        for e in data
        if str(e.get("title", "")).strip()
    }


_LESSON_TITLES = _load_lesson_titles()


def parse_lesson_text(level: int, lesson: int, ordinal: int, lines: list[str]) -> Unit:
    unit = Unit(
        ordinal=ordinal,
        level=level,
        lesson=lesson,
        title=_LESSON_TITLES.get((level, lesson)) or f"Level {level} Lesson {lesson}",
    )
    sent_ord = 1
    for raw in lines:
        line = raw.rstrip()
        if not line.strip() or is_footer(line):
            continue

        # Dialog line first (more specific)
        m = DIALOG_RE.match(line)
        if m:
            s = Sentence(
                ordinal=sent_ord,
                korean=m.group("korean").strip(),
                english=m.group("english").strip(),
                romanization=(m.group("roman") or "").strip() or None,
                speaker=m.group("speaker"),
                is_dialog=True,
            )
            s.finalize()
            unit.sentences.append(s)
            sent_ord += 1
            continue

        m = SENTENCE_RE_WITH_ROMAN.match(line)
        if m:
            s = Sentence(
                ordinal=sent_ord,
                korean=m.group("korean").strip(),
                english=m.group("english").strip(),
                romanization=m.group("roman").strip(),
            )
            s.finalize()
            unit.sentences.append(s)
            sent_ord += 1
            continue

        m = SENTENCE_RE_NO_ROMAN.match(line)
        if m:
            korean = m.group("korean").strip()
            english = m.group("english").strip()
            # Reject obvious false positives: e.g. "감사 = appreciation, thankfulness"
            # is a vocab gloss, which we DO want — but require at least one Korean char on left.
            # Filter out lines where the "korean" side is just an English word — already covered
            # by KOREAN_CHAR in the regex.
            s = Sentence(ordinal=sent_ord, korean=korean, english=english)
            s.finalize()
            unit.sentences.append(s)
            sent_ord += 1
            continue

    return unit


def parse(pdf_path: Path, slug: str, title: str) -> tuple[Source, list[Unit]]:
    raw_text = extract_text(pdf_path)
    lines = raw_text.splitlines()

    units: list[Unit] = []
    unit_ord = 1
    current_level: int | None = None
    current_lesson: int | None = None
    current_lines: list[str] = []

    def flush():
        nonlocal unit_ord
        if current_level is not None and current_lesson is not None and current_lines:
            unit = parse_lesson_text(current_level, current_lesson, unit_ord, current_lines)
            units.append(unit)
            unit_ord += 1

    for line in lines:
        m = LESSON_HEADER_RE.match(line)
        if m:
            new_level = int(m.group(1))
            new_lesson = int(m.group(2))
            # Only start a new unit when the lesson actually changes —
            # TTMIK repeats the header at the top of every page.
            if (new_level, new_lesson) != (current_level, current_lesson):
                flush()
                current_level = new_level
                current_lesson = new_lesson
                current_lines = []
            continue
        if current_level is not None:
            current_lines.append(line)

    flush()

    source = Source(
        slug=slug,
        type="lesson_series",
        title=title,
        publisher="Talk To Me In Korean",
        level=None,
        copyright_status="personal_use_only",
        metadata={"original_filename": pdf_path.name, "pdf_pages_parsed": True},
    )
    return source, units


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path, help="Input TTMIK PDF")
    ap.add_argument("output", type=Path, help="Output JSON path")
    ap.add_argument("--slug", required=True, help="Source slug, e.g. ttmik-1-3")
    ap.add_argument("--series-title", required=True, dest="title")
    args = ap.parse_args()

    if not args.pdf.exists():
        print(f"PDF not found: {args.pdf}", file=sys.stderr)
        sys.exit(1)

    source, units = parse(args.pdf, args.slug, args.title)

    total_sent = sum(len(u.sentences) for u in units)
    print(
        f"Parsed {len(units)} lessons, {total_sent} sentences from {args.pdf.name}",
        file=sys.stderr,
    )

    payload = {
        "source": asdict(source),
        "units": [
            {
                "ordinal": u.ordinal,
                "level": u.level,
                "lesson": u.lesson,
                "title": u.title,
                "sentences": [asdict(s) for s in u.sentences],
            }
            for u in units
        ],
    }
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"Wrote {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
