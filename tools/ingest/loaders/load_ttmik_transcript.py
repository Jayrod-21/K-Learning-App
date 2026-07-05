"""
TTMIK full-lesson-transcript loader.

Parses the three "Lesson Scripts" PDFs (Levels 1-3 / 4-6 / 7-9, 232 lessons)
and writes one row per rendered transcript line into ``ttmik_transcript_lines``
(migration 036). ``ttmik_sentences`` (the curated highlights) is untouched —
the client shows both: highlights tab + full transcript.

PIPELINE
    1. Extract text per page with pypdf (the PDFs have a real text layer; the
       km-loader image has no poppler, so no ``pdftotext`` shell-out here —
       pypdf is a pure-python wheel baked into Deploy/loader.Dockerfile).
    2. Split into lesson blocks on ``LEVEL <L> LESSON <M>`` header lines
       (a lesson spanning pages repeats its header — repeats of the CURRENT
       lesson are skipped so paragraphs re-join across page breaks).
    3. Classify every surviving line (page furniture stripped) into a ``kind``
       and split korean/english — see ``classify_line`` / ``parse_script_text``.
    4. Match each block to ``ttmik_lessons`` by (lesson_level, lesson_number)
       and replace that lesson's transcript atomically (DELETE + INSERT in one
       transaction per lesson).

LINE CLASSIFICATION (kind → columns):
    * 'romanization'  line consisting only of ``[...]`` groups. Text → english
                      (romanization is Latin; korean stays NULL).
    * 'dialog'        ``A: <korean...> = <english>`` — speaker prefix and any
                      inline ``[rom]`` stay in the korean side VERBATIM
                      (lossless); english = text right of the first `` = ``.
    * 'pair'          any other Hangul-left `` = `` line ("안녕 = well-being",
                      formation lines like "안녕+하세요 = 안녕하세요." included).
                      korean = left of the FIRST `` = ``, english = the rest.
    * 'header'        short title-case section heading with no Hangul, no
                      `` = `` and no terminal punctuation ("Sample
                      Conversation", "Conjugation"). Heuristic — only fires
                      between paragraphs, never inside one. Text → english.
    * 'prose'         everything else. Consecutive wrap lines are re-joined
                      into paragraphs (flush on sentence-terminal punctuation)
                      and hard hyphenation is repaired ("grati-"+"tude" →
                      "gratitude"). Text → korean when the paragraph contains
                      Hangul, else english (client renders korean ?? english).

    A prose-looking fragment that starts lowercase immediately after a
    pair/dialog line whose english side is clearly unterminated is treated as
    the wrapped tail of that line and appended to it (the PDFs wrap long
    translations mid-sentence).

IDEMPOTENCY / RESUME: same contract as load_ttmik.py — a load_state checkpoint
row keyed (corpus='ttmik', source_path=<the PDF>) gives sha256 skip-on-complete
and lesson-granular resume; each lesson's DELETE + INSERT is one transaction,
so a crash never leaves a lesson half-replaced. ``corpus_sources`` is NOT
touched: lessons already carry their corpus_source_id from the highlights
load, and upserting here would clobber that row's provenance.

REPORTING (fail-loud visibility, never guess): matched / unmatched lesson
blocks, per-kind line counts, and the count of catalog lessons still lacking
any transcript after the run.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import structlog
from psycopg_pool import AsyncConnectionPool

from .runtime import (
    LoaderConfig,
    batched,
    checkpoint_progress,
    get_or_create_checkpoint,
    mark_complete,
    mark_failed,
    mark_in_progress,
    sha256_of_file,
)

logger = structlog.get_logger(__name__)

# load_state is keyed (corpus, source_path); 'ttmik' + the PDF path is a
# distinct row from the highlights loader's JSON rows, so the two coexist.
CORPUS = "ttmik"

# ---------------------------------------------------------------------------
# Pure parsing layer — no I/O, no DB. Unit-tested against fixture text.
# ---------------------------------------------------------------------------

# "LEVEL 1 LESSON 5" on a line of its own (whitespace-tolerant).
LESSON_HEADER_RE = re.compile(r"^\s*LEVEL\s+(\d{1,2})\s+LESSON\s+(\d{1,3})\s*$", re.IGNORECASE)

# Hangul syllables + compatibility jamo + archaic jamo block.
HANGUL_RE = re.compile(r"[가-힣㄰-㆏ᄀ-ᇿ]")

# A line that is nothing but bracketed romanization group(s):
# "[an-nyeong]         [ha-se-yo]"
ROMANIZATION_LINE_RE = re.compile(r"^\s*(?:\[[^\[\]]+\]\s*)+$")

# "A: ..." / "B : ..." dialog speaker prefix.
DIALOG_PREFIX_RE = re.compile(r"^[A-Z]\s*:\s*\S")

# The korean/english separator. Space-padded so inline '=' inside prose
# ("A=B notation") without spacing never splits, and the FIRST occurrence
# wins so formation chains ("맛있다 = 맛있 + -을수록 = ...") keep the remainder
# intact on the english side.
PAIR_SPLIT_RE = re.compile(r"\s+=\s+")

# Page furniture the PDFs inject on every page (headers/footers/print stamps).
# Superset of parse_ttmik.py's list — pypdf emits the same boilerplate.
BOILERPLATE_RES = (
    re.compile(r"This PDF is to be used along with the MP3 audio lesson"),
    re.compile(r"Please feel free to share TalkToMeInKorean"),
    re.compile(r"is studying Korean\. If you have any questions"),
    re.compile(r"^\s*TalkToMeInKorean\.com - Free Korean Lesson Notes\s*$"),
    re.compile(r"^\s*From TalkToMeInKorean\.com\s*$"),
    re.compile(r"^\s*Printed by the Korea Seoul South Mission\s*$"),
    re.compile(r"^\s*Printed \w+ \d{4}\s*$"),
    re.compile(r"^\s*Levels? \d+(\s*-\s*\d+)?\s*$"),
)

# Punctuation that closes a paragraph line. Includes curly/straight quotes and
# the ellipsis so quoted sentence ends and trailing "etc..." flush correctly.
_TERMINAL_PUNCT = ('.', '?', '!', '"', '”', '…', ':', ')')


@dataclass(frozen=True)
class TranscriptLine:
    """One classified transcript line (ordinal assigned per lesson at the end)."""

    kind: str
    korean: str | None
    english: str | None


@dataclass
class ParsedScript:
    """Outcome of parsing one Lesson Scripts text dump."""

    # (level, lesson) → lines, in document order. dict preserves insertion
    # order; re-appearing headers append to the existing block.
    lessons: dict[tuple[int, int], list[TranscriptLine]] = field(default_factory=dict)
    # Non-empty lines before the first LEVEL header (title-page noise).
    preamble_lines: int = 0


def _is_boilerplate(line: str) -> bool:
    return any(rx.search(line) for rx in BOILERPLATE_RES)


def _single_text_line(kind: str, text: str) -> TranscriptLine:
    """Column contract for single-text kinds: Hangul → korean, else english."""
    if HANGUL_RE.search(text):
        return TranscriptLine(kind=kind, korean=text, english=None)
    return TranscriptLine(kind=kind, korean=None, english=text)


def _looks_like_section_header(line: str) -> bool:
    """Heuristic for standalone section titles ("Sample Conversation").

    Deliberately narrow: short, starts uppercase, no Hangul, no pair
    separator, no closing punctuation, ≤4 words. Only consulted BETWEEN
    paragraphs (the caller guarantees the prose buffer is empty), so wrapped
    mid-paragraph fragments can never match. Misclassification is cosmetic
    (render style), not data loss — the text is stored verbatim either way.
    """
    if len(line) > 48 or HANGUL_RE.search(line):
        return False
    if PAIR_SPLIT_RE.search(line):
        return False
    if line.endswith(_TERMINAL_PUNCT) or line.endswith((',', ';', '-')):
        return False
    if not line[0].isupper():
        return False
    return len(line.split()) <= 4


def classify_line(line: str) -> TranscriptLine:
    """Classify one stripped, non-empty, non-boilerplate line.

    Prose wrap-merging and header detection are context-dependent and live in
    ``parse_script_text``; this function handles the context-free kinds and
    falls back to a single 'prose' line.
    """
    if ROMANIZATION_LINE_RE.match(line):
        # Normalize interior column-alignment runs of spaces.
        return TranscriptLine(
            kind="romanization", korean=None, english=re.sub(r"\s{2,}", " ", line)
        )

    parts = PAIR_SPLIT_RE.split(line, maxsplit=1)
    is_dialog = bool(DIALOG_PREFIX_RE.match(line)) and HANGUL_RE.search(line) is not None
    if len(parts) == 2 and HANGUL_RE.search(parts[0]):
        left, right = parts[0].strip(), parts[1].strip()
        if left and right:
            return TranscriptLine(
                kind="dialog" if is_dialog else "pair", korean=left, english=right
            )
    if is_dialog:
        # Dialog line without a translation half ("A: 안녕하세요.").
        return TranscriptLine(kind="dialog", korean=line, english=None)
    return _single_text_line("prose", line)


def _join_wrapped(prefix: str, continuation: str) -> str:
    """Join a hard-wrapped continuation, repairing end-of-line hyphenation.

    "grati-" + "tude" → "gratitude", but "verb ending -을수록" style trailing
    hyphens (not between two Latin letters) join with a space untouched.
    """
    if (
        prefix.endswith("-")
        and len(prefix) >= 2
        and prefix[-2].isalpha()
        and not HANGUL_RE.search(prefix[-2])
        and continuation[:1].islower()
    ):
        return prefix[:-1] + continuation
    return f"{prefix} {continuation}"


def _paragraph_open(text: str) -> bool:
    """True while a prose paragraph looks unterminated (mid-wrap)."""
    return not text.endswith(_TERMINAL_PUNCT)


def parse_script_text(text: str) -> ParsedScript:
    """Parse one PDF's extracted text into per-lesson classified lines.

    Pure function over the text dump — this is the unit-tested surface.
    """
    parsed = ParsedScript()
    current: tuple[int, int] | None = None
    # Paragraph accumulator for prose wrap-merging. Flushed on terminal
    # punctuation, on any non-prose line, and on lesson switches. Page
    # boilerplate does NOT flush it, so paragraphs re-join across page breaks.
    prose_buf: str | None = None

    def flush() -> None:
        nonlocal prose_buf
        if prose_buf is not None and current is not None:
            parsed.lessons[current].append(_single_text_line("prose", prose_buf))
        prose_buf = None

    def emit(line: TranscriptLine) -> None:
        assert current is not None
        parsed.lessons[current].append(line)

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            flush()
            continue

        header = LESSON_HEADER_RE.match(line)
        if header:
            key = (int(header.group(1)), int(header.group(2)))
            if key != current:
                flush()
                current = key
                parsed.lessons.setdefault(key, [])
            # Same-lesson repeat (page break): skip silently, keep the buffer.
            continue

        if _is_boilerplate(line):
            continue

        if current is None:
            parsed.preamble_lines += 1
            continue

        classified = classify_line(line)

        if classified.kind == "prose":
            block = parsed.lessons[current]
            # Wrapped tail of a pair/dialog translation: lowercase fragment
            # arriving between paragraphs while the previous line's english
            # side is clearly unterminated.
            if (
                prose_buf is None
                and block
                and block[-1].kind in ("pair", "dialog")
                and block[-1].english is not None
                and _paragraph_open(block[-1].english)
                and line[:1].islower()
            ):
                prev = block[-1]
                block[-1] = TranscriptLine(
                    kind=prev.kind,
                    korean=prev.korean,
                    english=_join_wrapped(prev.english or "", line),
                )
                continue
            if prose_buf is None and _looks_like_section_header(line):
                emit(TranscriptLine(kind="header", korean=None, english=line))
                continue
            text_line = classified.korean or classified.english or ""
            prose_buf = (
                text_line if prose_buf is None else _join_wrapped(prose_buf, text_line)
            )
            if not _paragraph_open(prose_buf):
                flush()
            continue

        flush()
        emit(classified)

    flush()
    return parsed


# ---------------------------------------------------------------------------
# PDF text extraction (thin, isolated so the parser stays pure).
# ---------------------------------------------------------------------------


def extract_pdf_text(pdf_path: Path) -> str:
    """Extract the full text layer of a PDF, pages joined by newlines.

    pypdf is imported lazily so this module (and the pure parser tests) can
    load in environments without it; the km-loader image bakes it in
    (Deploy/loader.Dockerfile).
    """
    try:
        from pypdf import PdfReader
    except ImportError as err:  # pragma: no cover - env guard, not logic
        raise RuntimeError(
            "pypdf is required for the ttmik_transcript loader "
            "(baked into Deploy/loader.Dockerfile; `pip install pypdf` locally)"
        ) from err

    reader = PdfReader(str(pdf_path))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n".join(pages)


# ---------------------------------------------------------------------------
# DB loading
# ---------------------------------------------------------------------------


def _lesson_source_id(level: int, lesson: int) -> str:
    """Same checkpoint id scheme as load_ttmik.py (resume ordering)."""
    return f"ttmik-L{level}-{lesson:02d}"


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    """Load one Lesson Scripts PDF into ttmik_transcript_lines.

    Returns a report dict: matched/unmatched lessons, line counts, and the
    global count of catalog lessons still lacking a transcript.
    """
    log = logger.bind(corpus=CORPUS, source_path=str(source_path))

    parsed = parse_script_text(extract_pdf_text(source_path))
    if not parsed.lessons:
        # A Lesson Scripts PDF with zero LEVEL headers is a mispointed file,
        # not an empty corpus — fail loud rather than mark it complete.
        raise ValueError(
            f"{source_path}: no 'LEVEL <n> LESSON <m>' headers found — "
            "is this really a TTMIK Lesson Scripts PDF?"
        )

    sha = sha256_of_file(source_path)
    total_lines = sum(len(v) for v in parsed.lessons.values())
    log.info(
        "parse_complete",
        lessons=len(parsed.lessons),
        lines=total_lines,
        preamble_lines_skipped=parsed.preamble_lines,
    )

    async with pool.connection() as conn:
        async with conn.transaction():
            cp = await get_or_create_checkpoint(
                conn, corpus=CORPUS, source_path=str(source_path)
            )
            if cp.status == "complete" and cp.source_sha256 == sha and not cfg.force:
                log.info("skip_complete", reason="sha256-matches", sha256=sha)
                return {"loaded": 0, "skipped": total_lines, "status": "skipped"}
            await mark_in_progress(
                conn,
                corpus=CORPUS,
                source_path=str(source_path),
                source_sha256=sha,
                items_in_source=total_lines,
            )

    loaded_lines = 0
    skipped_lines = 0
    matched_lessons = 0
    unmatched: list[str] = []
    try:
        for (level, lesson), lines in sorted(parsed.lessons.items()):
            source_id = _lesson_source_id(level, lesson)
            if (
                cp.status == "in_progress"
                and cp.last_item_id
                and source_id <= cp.last_item_id
            ):
                skipped_lines += len(lines)
                continue

            async with pool.connection() as conn:
                async with conn.transaction():
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """
                            SELECT id FROM ttmik_lessons
                             WHERE lesson_level = %s AND lesson_number = %s
                            """,
                            (level, lesson),
                        )
                        row = await cur.fetchone()
                        if row is None:
                            # Report, never guess (ADR-019 §D10): a PDF block
                            # with no catalog row is an operator-visible gap.
                            unmatched.append(source_id)
                        else:
                            lesson_id = int(row[0])
                            # Atomic replace: DELETE + INSERT inside this
                            # lesson's transaction keeps re-runs idempotent
                            # and a crash can never half-replace a lesson.
                            await cur.execute(
                                "DELETE FROM ttmik_transcript_lines WHERE lesson_id = %s",
                                (lesson_id,),
                            )
                            ordinal = 0
                            rows = []
                            for tl in lines:
                                ordinal += 1
                                rows.append(
                                    (lesson_id, ordinal, tl.korean, tl.english, tl.kind)
                                )
                            for chunk in batched(rows, cfg.batch_size):
                                await cur.executemany(
                                    """
                                    INSERT INTO ttmik_transcript_lines (
                                        lesson_id, ordinal, korean, english, kind)
                                    VALUES (%s, %s, %s, %s, %s)
                                    """,
                                    chunk,
                                )
                            matched_lessons += 1
                            loaded_lines += len(rows)
                    await checkpoint_progress(
                        conn,
                        corpus=CORPUS,
                        source_path=str(source_path),
                        last_item_id=source_id,
                        items_loaded_delta=len(lines),
                    )
            log.info(
                "lesson_transcript_loaded",
                lesson_source_id=source_id,
                lines=len(lines),
                matched=row is not None,
            )

        # Visibility: catalog rows with no transcript at all (across ALL
        # loads — the three PDFs partition the catalog by level, so this
        # number should reach 0 only after the last of the three runs).
        async with pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT COUNT(*)::int
                      FROM ttmik_lessons l
                     WHERE NOT EXISTS (
                           SELECT 1 FROM ttmik_transcript_lines t
                            WHERE t.lesson_id = l.id)
                    """
                )
                row = await cur.fetchone()
                lessons_without_transcript = int(row[0]) if row else 0

        async with pool.connection() as conn:
            async with conn.transaction():
                await mark_complete(conn, corpus=CORPUS, source_path=str(source_path))

        for source_id in unmatched:
            log.warning("pdf_lesson_without_catalog_row", lesson_source_id=source_id)
        report = {
            "status": "complete",
            "lessons_in_pdf": len(parsed.lessons),
            "lessons_matched": matched_lessons,
            "lessons_unmatched": len(unmatched),
            "unmatched_ids": unmatched,
            "loaded": loaded_lines,
            "skipped": skipped_lines,
            "lessons_without_transcript": lessons_without_transcript,
        }
        log.info("load_complete", **report)
        return report

    except Exception as err:
        log.error("loader_failed", error=str(err))
        async with pool.connection() as conn:
            async with conn.transaction():
                await mark_failed(
                    conn,
                    corpus=CORPUS,
                    source_path=str(source_path),
                    error=repr(err),
                )
        raise
