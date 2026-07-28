"""Official ``*-Listening-Transcript.pdf`` -> per-item spoken text.

This feeds the aligner's CONFIDENCE validation (and gap recovery) with the
official spoken script — a QA signal, not load-bearing for boundaries. It is
deliberately simple and defensive: 22 of 24 papers ship the PDF, but only
the text-extractable ones (~12/24) actually parse — papers 64/83/91/96/102
(both levels) are IMAGE-ONLY scans whose ``pdftotext`` dump is just form
feeds, so their parse is empty (logged ``transcript_pdf_parsed_empty``;
the runner then falls back to ``transcript_ocr`` — Google Vision — which
feeds its text through the same :func:`parse_transcript_text`; this module
itself stays NETWORK-FREE). Whenever the PDF is absent, unreadable, image-only,
or ``pdftotext`` is unavailable, everything degrades to ``{}`` and the
caller falls back to DB stems.

Extraction shells out to ``pdftotext -layout`` (poppler) — the same tool
``tools/ingest/parse_ttmik.py`` already relies on. Parsing is a pure
function over the dumped text (unit-tested against a text fixture):

  * page headers ("제N회 한국어능력시험 ...") and bare page-number lines are
    dropped first;
  * question markers ``N.`` / ``N번`` at line start and group headers
    ``※ [N～M]`` split the text into chunks — markers are accepted only in
    strictly increasing order (a digit at line start inside a wrapped
    passage cannot hijack the split), and a "``1번 ～ 30번``" section banner
    is rejected by the tilde lookahead;
  * printed option lines (①…④), ``<보기>`` example markers, point tags
    (``(각 2점)``) and answer-blank underscores are stripped from chunks;
  * a PAIRED group's shared passage (printed between its ``※ [21～22]``
    header and question 21) is prepended to both items' texts — that passage
    IS the spoken audio for the pair.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import structlog

logger = structlog.get_logger(__name__)

# Highest item number any paper uses (TOPIK II listening has 50).
MAX_ITEM_NUMBER = 50

_PDFTOTEXT_TIMEOUT_SEC = 120

# Page running header, present on every page of every paper.
_HEADER_LINE_RE = re.compile(r"한국어능력시험")
# A line that is ONLY a number is a page number, never content.
_PAGE_NUMBER_LINE_RE = re.compile(r"^\s*\d{1,3}\s*$")

# "※ [21～22] 다음을 듣고 ..." — tolerant of the tilde variants poppler
# emits and of the bracket being split across lines by -layout.
_GROUP_HEADER_RE = re.compile(r"※?\s*\[\s*(\d{1,2})\s*[～~∼]\s*(\d{1,2})\s*\]")
# 35-II / 41-I -layout displacement: the range tilde lands BEFORE the
# bracket — same line ("※ ～[29   30] ...") or on its own line ABOVE it
# ("※    ～\n   [29   30] ...") — leaving only whitespace between the two
# numbers. Missing these headers absorbed the pair's shared passage into the
# PRECEDING question's chunk. ※ is mandatory here so a bracketed number
# pair inside a passage cannot fake a header.
_GROUP_HEADER_SPLIT_RE = re.compile(
    r"※\s*[～~∼]\s*\[\s*(\d{1,2})\s+(\d{1,2})\s*\]"
)
# "21." / "21번" at line start (35-I wraps as "1. (\n 4점)" — the dot still
# sits on the marker line). The fullwidth dot appears in some exports.
_QUESTION_MARKER_RE = re.compile(r"^[ \t]*(\d{1,2})\s*[.．번]", re.MULTILINE)
# "듣기 통합 (1번 ～ 30번)" section banners: a number followed by a range
# tilde is a banner, not a question marker.
_BANNER_TILDE_RE = re.compile(r"\s*[～~∼]")

_OPTION_LINE_RE = re.compile(r"^\s*[①②③④❶❷❸❹]")
_EXAMPLE_MARKER_RE = re.compile(r"<\s*보\s*기\s*>")
_POINTS_RE = re.compile(r"\(\s*각?\s*\d+\s*점\s*\)")
_UNDERSCORE_RE = re.compile(r"_{2,}")
# A dangling speaker label left at a chunk's END once its answer blank /
# options were stripped ("남자 :" with nothing after it) — a single token
# then a colon, no spoken content. Real content lines have text after ":".
_DANGLING_SPEAKER_RE = re.compile(r"\S{1,6}\s*:")


def extract_pdf_text(pdf_path: Path) -> str:
    """Dump a transcript PDF to text via ``pdftotext -layout``.

    Returns ``""`` on ANY failure — missing file (2 papers legitimately have
    no transcript PDF), missing binary, extraction error, timeout — because
    the transcript is a QA signal the pipeline must survive without.
    """
    if not pdf_path.is_file():
        logger.info("transcript_pdf_absent", path=str(pdf_path))
        return ""
    try:
        proc = subprocess.run(
            ["pdftotext", "-layout", str(pdf_path), "-"],
            capture_output=True,
            timeout=_PDFTOTEXT_TIMEOUT_SEC,
            check=False,
        )
    except FileNotFoundError:
        logger.warning("pdftotext_not_installed", path=str(pdf_path))
        return ""
    except subprocess.TimeoutExpired:
        logger.warning("transcript_pdf_extract_timeout", path=str(pdf_path))
        return ""
    if proc.returncode != 0:
        logger.warning(
            "transcript_pdf_extract_failed",
            path=str(pdf_path),
            returncode=proc.returncode,
            stderr=proc.stderr.decode("utf-8", errors="replace")[:500],
        )
        return ""
    return proc.stdout.decode("utf-8", errors="replace")


def _clean_chunk(chunk: str) -> str:
    """Strip printed-only artifacts (options, 보기, points, blanks) from a
    marker-delimited chunk, keeping the spoken script lines.

    Point tags are removed on the WHOLE chunk first: ``-layout`` sometimes
    wraps them across lines ("1. (\\n   4점)") and ``\\s*`` in the pattern
    spans the newline — a per-line pass would leave "(" / "4점)" residue.
    """
    chunk = _POINTS_RE.sub("", chunk)
    chunk = _UNDERSCORE_RE.sub("", chunk)
    kept: list[str] = []
    for line in chunk.splitlines():
        if _OPTION_LINE_RE.match(line) or _EXAMPLE_MARKER_RE.search(line):
            continue
        line = line.strip()
        if line:
            kept.append(line)
    while kept and _DANGLING_SPEAKER_RE.fullmatch(kept[-1]):
        kept.pop()
    return "\n".join(kept)


def parse_transcript_text(text: str, max_item: int = MAX_ITEM_NUMBER) -> dict[int, str]:
    """Pure parse of a pdftotext dump into ``{item_number: spoken_text}``."""
    if not text.strip():
        return {}
    lines = [
        line
        for line in text.splitlines()
        if not _HEADER_LINE_RE.search(line) and not _PAGE_NUMBER_LINE_RE.match(line)
    ]
    cleaned = "\n".join(lines)

    # (start, end, kind, payload) — group ranges and monotonic question markers.
    markers: list[tuple[int, int, str, object]] = []
    for header_re in (_GROUP_HEADER_RE, _GROUP_HEADER_SPLIT_RE):
        for m in header_re.finditer(cleaned):
            a, b = int(m.group(1)), int(m.group(2))
            if 1 <= a < b <= max_item:
                markers.append((m.start(), m.end(), "group", (a, b)))
    last = 0
    for m in _QUESTION_MARKER_RE.finditer(cleaned):
        n = int(m.group(1))
        if _BANNER_TILDE_RE.match(cleaned[m.end() : m.end() + 8]):
            continue  # "1번 ～ 30번" banner, not a question
        if last < n <= max_item:
            markers.append((m.start(), m.end(), "question", n))
            last = n
    markers.sort(key=lambda mk: mk[0])

    question_texts: dict[int, str] = {}
    paired_preambles: dict[tuple[int, int], str] = {}
    for idx, (_start, end, kind, payload) in enumerate(markers):
        next_start = markers[idx + 1][0] if idx + 1 < len(markers) else len(cleaned)
        chunk = _clean_chunk(cleaned[end:next_start])
        if kind == "question":
            question_texts[payload] = chunk  # type: ignore[index]
        else:
            a, b = payload  # type: ignore[misc]
            if b == a + 1:
                # A two-item group's passage is printed between the header
                # and its first question — the pair's shared spoken script.
                paired_preambles[(a, b)] = chunk

    result: dict[int, str] = {}
    for n, chunk in question_texts.items():
        preamble = next(
            (p for (a, b), p in paired_preambles.items() if a <= n <= b), ""
        )
        combined = f"{preamble}\n{chunk}".strip() if preamble else chunk
        if combined:
            result[n] = combined
    return result


def parse_transcript_pdf(pdf_path: Path, max_item: int = MAX_ITEM_NUMBER) -> dict[int, str]:
    """Extract + parse an official transcript PDF; ``{}`` when unavailable."""
    parsed = parse_transcript_text(extract_pdf_text(pdf_path), max_item=max_item)
    if parsed:
        logger.info("transcript_pdf_parsed", path=str(pdf_path), items=len(parsed))
    elif pdf_path.is_file():
        # The PDF EXISTS but yielded nothing — an image-only scan (10 of the
        # 22 transcript PDFs) or an extraction failure. Loudly distinct from
        # the legitimately-absent papers: this paper gets NO PDF validation
        # and needs OCR or heavier manual QA.
        logger.warning("transcript_pdf_parsed_empty", path=str(pdf_path))
    return parsed
