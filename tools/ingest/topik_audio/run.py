"""Per-paper segmentation CLI — orchestrates transcribe -> parse -> align.

    python -m tools.ingest.topik_audio \
        --test-number 60 --level 2 \
        --corpus-root "/corpus" \
        --audio "/corpus/TOPIK TEST/60 - 60th TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Audio.mp3" \
        --structure tools/ingest/output/topik_60_II_listening.json

Question STRUCTURE (single vs paired units + stems) comes from either:
  * ``--structure`` — an ingest output JSON (``topik_<N>_<I|II>_listening.json``
    shape: ``{source, passages, items:[{number, instruction_group, stem}]}``), or
  * the DB (``--database-url`` / ``$DATABASE_URL``) — the same
    ``topik_items`` rows, read-only, ordered by ``item_number``. The DB query
    lives HERE in the runner; the alignment core stays pure.

Validation text per item (best available wins):
  1. the official ``*-Listening-Transcript.pdf`` (auto-derived from the MP3
     path, or ``--transcript-pdf``) — 22/24 papers ship one, but only the
     text-extractable ones (~12/24) actually parse; image-only scans parse
     EMPTY (warned + surfaced in the QA report) and fall through to 2./3.;
  2. the structure file's shared ``passages`` (paired groups) + the stem;
  3. the DB/structure stem alone. ``[듣기 지문 없음]`` placeholders are
     treated as absent (paper 60-I's known gap — those spans align by anchor
     only and are flagged low-confidence).

Output: ``tools/ingest/output/topik_audio_segments/topik_<N>_<I|II>_listening.json``
with the §5/§6 contract — ``{test_number, topik_level, source_mp3,
audio_sha256, aligner_version, min_confidence, segments: [...]}`` — written
atomically and DETERMINISTICALLY (no timestamps): a re-run over the same
inputs is byte-identical, and the transcription itself is cached by the
MP3's sha256, so re-runs skip the GPU entirely. ``source_mp3`` is the
migration-078 ``audio_path`` value: POSIX-relative to ``--corpus-root``
(NEVER an absolute machine path — the artifact must be portable and
DB-servable).

Exit codes: 0 = every unit resolved (low-confidence spans are FLAGGED in the
artifact, not failures here — the loader/operator decides); 1 = one or more
items unresolved (the artifact is still written for inspection); 2 = usage /
input error (including DB connection/query failures).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

import structlog

from .segment import (
    ALIGNER_VERSION,
    DEFAULT_MIN_CONFIDENCE,
    AlignResult,
    derive_units,
)
from .segment import align as align_units
from .transcribe import transcribe_paper
from .transcript_pdf import parse_transcript_pdf

logger = structlog.get_logger(__name__)

_INGEST_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = _INGEST_DIR / "output" / "topik_audio_segments"
DEFAULT_CACHE_DIR = _INGEST_DIR / "_work" / "topik_audio_transcripts"

# Stems recorded for paper 60-I's 28 missing questions (a known pre-existing
# content gap) — no validation value, treated as absent.
_PLACEHOLDER_STEM_MARKER = "지문 없음"


@dataclass(frozen=True)
class PaperStructure:
    """The paper's ordered question structure + validation raw material."""

    # [{"number": int, "instruction_group": str | None, "stem": str | None}]
    items: list[dict]
    # instruction_group -> shared spoken passage (structure files only).
    passages: dict[str, str]


def _level_label(level: int) -> str:
    return "TOPIK I" if level == 1 else "TOPIK II"


def _level_roman(level: int) -> str:
    return "I" if level == 1 else "II"


def load_structure_file(path: Path) -> PaperStructure:
    """Load an ingest output JSON (``topik_<N>_<lvl>_listening.json`` shape)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError(f"{path}: no items[] — not a listening structure file")
    items = [
        {
            "number": int(item["number"]),
            "instruction_group": item.get("instruction_group"),
            "stem": item.get("stem"),
        }
        for item in raw_items
    ]
    passages = data.get("passages")
    return PaperStructure(
        items=items,
        passages=dict(passages) if isinstance(passages, dict) else {},
    )


def load_structure_from_db(database_url: str, test_number: int, level: int) -> PaperStructure:
    """Read the paper's listening items from the DB (read-only, one query).

    psycopg is imported lazily — the test suite (and structure-file runs)
    never needs the driver.
    """
    import psycopg  # noqa: PLC0415 — lazy: only the DB path needs the driver

    try:
        with psycopg.connect(database_url) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT i.item_number, i.instruction_group, i.stem
                  FROM topik_items i
                  JOIN topik_tests t ON t.id = i.topik_test_id
                 WHERE t.test_number = %s
                   AND t.topik_level = %s
                   AND t.section = 'listening'
                   AND i.section = 'listening'
                 ORDER BY i.item_number
                """,
                (test_number, _level_label(level)),
            )
            rows = cur.fetchall()
    except psycopg.Error as exc:
        # Narrowed to the driver's base class; re-raised as ValueError so
        # main() maps it to exit 2 (usage/input error) — an uncaught driver
        # exception would exit 1, colliding with "unresolved items".
        raise ValueError(f"database error loading structure: {exc}") from exc
    if not rows:
        raise ValueError(
            f"no listening items in DB for test {test_number} {_level_label(level)}"
        )
    items = [
        {"number": int(num), "instruction_group": group, "stem": stem}
        for num, group, stem in rows
    ]
    return PaperStructure(items=items, passages={})


def compose_validation_texts(
    structure: PaperStructure, pdf_texts: dict[int, str]
) -> dict[int, str]:
    """Best validation text per item: PDF > shared passage + stem > stem."""
    group_by_number = {
        item["number"]: item.get("instruction_group") for item in structure.items
    }
    paired_groups: dict[int, str | None] = {
        n: group_by_number.get(n)
        for unit in derive_units(structure.items)
        if len(unit["item_numbers"]) == 2
        for n in unit["item_numbers"]
    }
    texts: dict[int, str] = {}
    for item in structure.items:
        n = item["number"]
        stem = item.get("stem") or ""
        if _PLACEHOLDER_STEM_MARKER in stem:
            stem = ""
        pdf_text = pdf_texts.get(n, "")
        if pdf_text:
            texts[n] = pdf_text
            continue
        passage = structure.passages.get(paired_groups.get(n) or "", "")
        combined = f"{passage}\n{stem}".strip() if passage else stem
        if combined:
            texts[n] = combined
    return texts


def derive_transcript_pdf_path(audio_path: Path) -> Path:
    """Sibling transcript PDF from the corpus naming convention
    (``...-Listening-Audio.mp3`` -> ``...-Listening-Transcript.pdf``)."""
    return audio_path.with_name(
        audio_path.stem.replace("-Audio", "-Transcript") + ".pdf"
    )


def build_artifact(
    *,
    test_number: int,
    level: int,
    source_mp3: str,
    audio_sha256: str,
    min_confidence: float,
    result: AlignResult,
) -> dict:
    """The §5/§6 per-paper artifact the Phase-3 loader consumes."""
    return {
        "test_number": test_number,
        "topik_level": _level_label(level),
        "source_mp3": source_mp3,
        "audio_sha256": audio_sha256,
        "aligner_version": ALIGNER_VERSION,
        "min_confidence": min_confidence,
        "segments": result.segments,
        "unresolved_items": result.unresolved_items,
    }


def write_artifact(out_path: Path, artifact: dict) -> None:
    """Atomic, deterministic write (tmp + replace; no timestamps inside)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_name(out_path.name + ".tmp")
    tmp_path.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp_path, out_path)


def transcript_pdf_note(pdf_path: Path, pdf_texts: dict[int, str]) -> str:
    """One QA-report line describing the official transcript's availability:
    parsed / present-but-unusable (image-only scan, needs OCR) / absent."""
    if pdf_texts:
        return f"{pdf_path.name} ({len(pdf_texts)} items)"
    if pdf_path.is_file():
        return f"{pdf_path.name} — present but unusable (parsed empty; image-only scan needs OCR)"
    return "absent"


def print_qa_report(
    *,
    test_number: int,
    level: int,
    result: AlignResult,
    total_units: int,
    total_items: int,
    min_confidence: float,
    out_path: Path,
    pdf_note: str,
) -> None:
    resolved_units = len(result.segments)
    covered_items = len(result.clean_anchor_items) + len(result.fallback_items)
    confidences = [seg["confidence"] for seg in result.segments]
    low = [
        (seg["item_numbers"], seg["confidence"])
        for seg in result.segments
        if seg["low_confidence"]
    ]
    print(f"=== TOPIK {test_number} {_level_label(level)} listening segmentation QA ===")
    print(f"transcript PDF: {pdf_note}")
    print(
        f"units resolved: {resolved_units}/{total_units}  "
        f"(clean-anchor items {len(result.clean_anchor_items)}, "
        f"fallback-recovered items {len(result.fallback_items)})"
    )
    print(f"items covered:  {covered_items}/{total_items}")
    if confidences:
        print(f"median confidence: {statistics.median(confidences):.2f}")
    if low:
        listed = ", ".join(f"{nums} ({conf:.2f})" for nums, conf in low)
        print(f"low-confidence (<{min_confidence:.2f}): {listed}")
    else:
        print(f"low-confidence (<{min_confidence:.2f}): none")
    print(f"unresolved items: {result.unresolved_items or 'none'}")
    print(f"artifact: {out_path}")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="tools.ingest.topik_audio",
        description="Segment one TOPIK paper's listening MP3 into per-question offsets",
    )
    p.add_argument("--test-number", type=int, required=True, help="e.g. 60")
    p.add_argument("--level", type=int, choices=(1, 2), required=True, help="1=TOPIK I, 2=TOPIK II")
    p.add_argument("--audio", type=Path, required=True, help="whole-section listening MP3")
    p.add_argument(
        "--corpus-root",
        type=Path,
        required=True,
        help=(
            "corpus root directory — the artifact's source_mp3 is stored POSIX-"
            "relative to this (the DB audio_path contract; never an absolute path)"
        ),
    )
    p.add_argument(
        "--transcript-pdf",
        type=Path,
        default=None,
        help="official Listening-Transcript.pdf (default: derived next to --audio)",
    )
    p.add_argument(
        "--structure",
        type=Path,
        default=None,
        help="ingest output JSON with the paper's items[] (else the DB is queried)",
    )
    p.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="Postgres URL for the structure query (default: $DATABASE_URL)",
    )
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    p.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    p.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
    p.add_argument("--model-size", default="large-v3")
    p.add_argument("--device", default="auto")
    p.add_argument("--compute-type", default="auto")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        # Fail fast, before any GPU/DB work: source_mp3 must be expressible
        # as a corpus-relative POSIX path (migration 078's audio_path value).
        source_mp3 = (
            args.audio.resolve().relative_to(args.corpus_root.resolve()).as_posix()
        )
    except ValueError:
        print(
            f"error: --audio {args.audio} is not under --corpus-root {args.corpus_root}",
            file=sys.stderr,
        )
        return 2
    try:
        if args.structure is not None:
            structure = load_structure_file(args.structure)
        elif args.database_url:
            structure = load_structure_from_db(
                args.database_url, args.test_number, args.level
            )
        else:
            print(
                "error: provide --structure or --database-url/$DATABASE_URL",
                file=sys.stderr,
            )
            return 2
        units = derive_units(structure.items)

        transcript = transcribe_paper(
            args.audio,
            cache_dir=args.cache_dir,
            model_size=args.model_size,
            device=args.device,
            compute_type=args.compute_type,
        )

        pdf_path = args.transcript_pdf or derive_transcript_pdf_path(args.audio)
        pdf_texts = parse_transcript_pdf(pdf_path)
        validation_texts = compose_validation_texts(structure, pdf_texts)

        result = align_units(
            transcript,
            units,
            validation_texts,
            min_confidence=args.min_confidence,
        )
    except (OSError, ValueError) as exc:
        # json.JSONDecodeError is a ValueError subclass — already covered.
        print(f"error: {exc}", file=sys.stderr)
        return 2

    artifact = build_artifact(
        test_number=args.test_number,
        level=args.level,
        source_mp3=source_mp3,
        audio_sha256=transcript["audio_sha256"],
        min_confidence=args.min_confidence,
        result=result,
    )
    out_path = (
        args.out_dir
        / f"topik_{args.test_number}_{_level_roman(args.level)}_listening.json"
    )
    write_artifact(out_path, artifact)

    print_qa_report(
        test_number=args.test_number,
        level=args.level,
        result=result,
        total_units=len(units),
        total_items=len(structure.items),
        min_confidence=args.min_confidence,
        out_path=out_path,
        pdf_note=transcript_pdf_note(pdf_path, pdf_texts),
    )
    return 1 if result.unresolved_items else 0
