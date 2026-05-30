#!/usr/bin/env python3
"""
parse_iyagi.py — Convert a TTMIK 이야기 (Iyagi) podcast-transcript PDF into JSON
matching schema_v2_content.sql (sources / source_units / sentences).

Iyagi format is very different from TTMIK lesson scripts:
  - Pure Korean (no English glosses, no romanization)
  - Dialog between two hosts: "<speaker name> : <korean text>"
  - Continuation lines (no name) belong to the previous speaker
  - One episode = one unit; one dialog TURN = one sentence row
  - Backchannels like "(네)" inline stay attached to the parent turn

Usage:
    python parse_iyagi.py <input.pdf> <output.json> \\
        --slug ttmik-iyagi-1-50 --series-title "TTMIK 이야기 #1-50" \\
        --episode-offset 0
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


FOOTER_PATTERNS = [
    re.compile(r"This PDF is to be used along with the MP3 audio"),
    re.compile(r"intermediate level learners"),
    re.compile(r"If you have any questions, please visit"),
    re.compile(r"^TalkToMeInKorean\.com.*Level\s*$"),
    re.compile(r"^From TalkToMeInKorean\.com\s*$"),
    re.compile(r"^Printed by the Korea Seoul South Mission\s*$"),
    re.compile(r"^Printed December \d{4}\s*$"),
    re.compile(r"^\s*Talking \d+\s*-\s*\d+\s*$"),
]

# Episode header: "이야기 (Iyagi) #1 - 최경은 & 진석진"
EPISODE_HEADER_RE = re.compile(
    r"^\s*이야기\s*\(Iyagi\)\s*#\s*(?P<num>\d+)\s*-\s*(?P<hosts>.+?)\s*$"
)

# Speaker line: "  최경은 : 안녕하세요..."  (2-4 Hangul chars, then colon)
KOREAN_NAME_RE = re.compile(
    r"^\s*(?P<speaker>[가-힯]{2,4})\s*:\s*(?P<text>.+?)\s*$"
)


@dataclass
class Turn:
    ordinal: int
    speaker: str
    korean: str
    content_hash: str = ""

    def finalize(self):
        self.content_hash = hashlib.sha256(
            (self.speaker + "|" + self.korean).encode("utf-8")
        ).hexdigest()


@dataclass
class Episode:
    ordinal: int
    number: int
    hosts: str
    title: str
    turns: list[Turn] = field(default_factory=list)


def extract_text(pdf_path: Path) -> str:
    result = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        capture_output=True, text=True, check=True,
    )
    return result.stdout


def is_footer(line: str) -> bool:
    return any(p.search(line) for p in FOOTER_PATTERNS)


def parse(pdf_path: Path, slug: str, title: str, episode_offset: int = 0):
    text = extract_text(pdf_path)
    lines = text.splitlines()

    episodes: list[Episode] = []
    ep_ord = 1
    current_ep: Episode | None = None
    current_speaker: str | None = None
    current_text: list[str] = []
    last_ep_num: int | None = None

    def flush_turn():
        nonlocal current_speaker, current_text
        if current_ep is None or current_speaker is None or not current_text:
            current_speaker = None
            current_text = []
            return
        merged = " ".join(t.strip() for t in current_text if t.strip())
        if merged:
            t = Turn(
                ordinal=len(current_ep.turns) + 1,
                speaker=current_speaker,
                korean=merged,
            )
            t.finalize()
            current_ep.turns.append(t)
        current_speaker = None
        current_text = []

    for line in lines:
        if is_footer(line):
            continue

        ep_m = EPISODE_HEADER_RE.match(line)
        if ep_m:
            ep_num = int(ep_m.group("num"))
            # Same episode appearing again means it's just a repeated page header.
            if ep_num == last_ep_num:
                continue
            flush_turn()
            if current_ep is not None:
                episodes.append(current_ep)
                ep_ord += 1
            current_ep = Episode(
                ordinal=ep_ord,
                number=ep_num + episode_offset,
                hosts=ep_m.group("hosts").strip(),
                title=f"이야기 #{ep_num + episode_offset}",
            )
            last_ep_num = ep_num
            continue

        if current_ep is None:
            continue

        sp_m = KOREAN_NAME_RE.match(line)
        if sp_m:
            flush_turn()
            current_speaker = sp_m.group("speaker")
            current_text = [sp_m.group("text")]
            continue

        # Continuation line for the current speaker
        stripped = line.strip()
        if stripped and current_speaker is not None:
            current_text.append(stripped)

    flush_turn()
    if current_ep is not None:
        episodes.append(current_ep)

    source = {
        "slug": slug,
        "type": "podcast",
        "title": title,
        "title_korean": "이야기",
        "publisher": "Talk To Me In Korean",
        "level": "intermediate",
        "copyright_status": "personal_use_only",
        "metadata": {"original_filename": pdf_path.name},
    }
    return source, episodes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--series-title", required=True, dest="title")
    ap.add_argument("--episode-offset", type=int, default=0,
                    help="If a PDF starts at episode 51, set offset=50 only if PDF numbers from 1")
    args = ap.parse_args()

    source, episodes = parse(args.pdf, args.slug, args.title, args.episode_offset)

    total_turns = sum(len(e.turns) for e in episodes)
    print(f"Parsed {len(episodes)} episodes, {total_turns} turns from {args.pdf.name}",
          file=sys.stderr)

    payload = {
        "source": source,
        "units": [
            {
                "ordinal": e.ordinal,
                "number": e.number,
                "hosts": e.hosts,
                "title": e.title,
                "sentences": [
                    {**asdict(t), "is_dialog": True, "english": None, "romanization": None}
                    for t in e.turns
                ],
            }
            for e in episodes
        ],
    }
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"Wrote {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
