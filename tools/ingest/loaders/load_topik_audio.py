"""
TOPIK listening-audio loader (F-119, Phase 3).

Consumes the per-paper segment artifacts produced by
``tools/ingest/topik_audio`` (``topik_<N>_<I|II>_listening.json``, the
plan §5/§6 contract) and writes migration 078's columns:

  * ``topik_tests.audio_path``  ← the artifact's ``source_mp3`` (the paper's
    whole-section MP3, as a corpus-RELATIVE POSIX key — 035's contract,
    verbatim; never host-absolute).
  * ``topik_items.audio_start_ms`` / ``audio_end_ms`` ← each segment's span,
    fanned out to every ``item_numbers`` member (paired questions get the
    IDENTICAL span on both rows — 078's deliberate denormalization).
  * ``topik_items.extra->'audio_seg'`` ← segmentation provenance
    (confidence, matched marker, low_confidence flag, source-MP3 sha256,
    aligner version) via ``jsonb_set`` — existing ``extra`` keys survive.

Modeled on ``load_ttmik_audio.py``: a keyed-UPDATE audio-path mapper.

KEYING: the ``topik_tests`` row is resolved by the migration-029 natural key
``(test_number, topik_level, section='listening')`` — ``topik_level`` is one
of the literal strings ``'TOPIK I'`` / ``'TOPIK II'`` — and each item by
``(topik_test_id, item_number)`` (``uq_topik_items_test_number``). An
artifact whose test has no DB row is counted (``tests_without_row``) and
skipped; a segment whose item_number has no DB row is counted
(``segments_without_matching_item``) without failing the paper.

GUARDS (078's ``ck_topik_items_audio_span`` is never violated):
  * A ZERO-SEGMENT artifact (the corrupt 96th-sitting papers) is skipped
    entirely — ``audio_path`` is NOT set when no offsets exist to serve.
    The same no-offsets-no-path rule applies per-write: ``audio_path`` is
    set only once at least ONE span actually LANDS (UPDATE rowcount-proven,
    not merely admitted past the gates), so a paper whose every segment is
    refused/gated — or whose every item is absent from the DB — never
    advertises audio it has no offsets for. A zero-landed admitted paper is
    counted (``papers_without_spans``), has its ``audio_path`` cleared to
    NULL (after the convergence clear below, a leftover path would be
    exactly the phantom-audio state this rule forbids), and fails the
    run's exit code.
  * DUPLICATE ITEMS: an artifact where the same item_number appears in more
    than one segment (or twice within one segment's ``item_numbers``) is
    rejected at PARSE time (:class:`ArtifactError`) — overlapping segments
    violate the segmenter's disjointness invariant, and letting the last
    segment silently win would hide the corruption.
  * OVERSIZED spans: a ``start_ms``/``end_ms`` beyond 24 hours
    (``MAX_SPAN_MS`` = 86_400_000; the real papers top out ~2.4M ms) is
    refused exactly like a malformed span (``segments_invalid_span``) —
    078's columns are INTEGER, and a corrupt multi-billion-ms value must be
    a named per-segment refusal, never a raw psycopg overflow abort.
  * DRIFT GUARD (``--corpus-root``, the F-185 lesson — a stored key silently
    pointing at CHANGED media): when the corpus root is given, the MP3 at
    ``<corpus_root>/<source_mp3>`` is stream-hashed and its sha256 must equal
    the artifact's ``audio_sha256`` — a mismatch (or a missing/unreadable
    file) REFUSES that paper before any write (``drift_mismatch``, error
    log, non-zero exit): stale offsets against re-encoded audio would play
    the WRONG spans. When ``--corpus-root`` is omitted the check is skipped
    and NOTED (a warning + ``drift_check_enabled: false`` in the report) —
    intended only for environments where the corpus is not mounted.
  * A malformed span (``start_ms < 0`` or ``end_ms <= start_ms``) is refused
    BEFORE the write — counted (``segments_invalid_span``), logged at error
    level, and surfaced as a non-zero exit from :func:`main`. The segmenter's
    invariant gate already guarantees valid spans, so any hit here means a
    hand-edited or corrupted artifact — fail loud, never let the DB CHECK
    be the first thing that notices.
  * ``--min-confidence`` (default 0.0 = write everything): a segment whose
    ``confidence`` is below the gate is skipped — its items stay
    transcript-only (``items_skipped_low_conf``) rather than getting a
    possibly-wrong clip. The artifact's own ``min_confidence`` field is the
    SEGMENTER's flagging threshold; this gate is the loader operator's,
    applied independently. The gate is strict ``<`` — a segment whose
    confidence EQUALS the threshold is written.

EXIT CODES (:func:`main` — the single statement of the contract):
  * 0 — clean run: every paper either mapped or was a benign skip
    (zero-segment paper).
  * 1 — the run must not read as clean: any ``segments_invalid_span``,
    ``drift_mismatch``, ``tests_without_row``, or ``papers_without_spans``
    refusal (all of them mean the artifacts or the environment are wrong —
    a missing expected paper row means ``load_topik.py`` has not seeded
    this paper; a zero-landed paper mapped nothing and needs re-segmentation
    or seeding), or any runtime failure (DB unreachable, unreadable
    artifacts dir, …). Good papers ARE still loaded before the non-zero
    exit.
  * 2 — usage error: invalid CLI arguments (argparse, out-of-range
    ``--min-confidence``) or no ``--database-url``/``$DATABASE_URL``.

IDEMPOTENCY + CONVERGENCE: each admitted paper is a full CLEAR-then-write.
Inside the shared transaction, before its current segments are written, ALL
of the paper's listening items have their spans NULLed and their
``extra->'audio_seg'`` provenance removed — so the rows converge exactly to
the CURRENT artifact on every run: an item a regenerated artifact no longer
covers (re-segmented into ``unresolved_items``, or dropped by a raised
``--min-confidence``) loses its stale span instead of silently serving the
wrong clip. A normal re-run clears then rewrites identical values and is a
no-op in effect (``updated_at``/``version`` tick via the 005 trigger, the
audio columns and provenance converge). ONE transaction for the whole pass,
exactly ``load_ttmik_audio``'s posture: a failure anywhere leaves every
``audio_path`` and span exactly as it was (no partially-mapped corpus), and
the pass is a few hundred single-row keyed UPDATEs — cheap, atomic, safely
re-runnable. Per-paper refusals (no DB row, drift, zero segments) are
``continue``s that write nothing for that paper, so refusal never poisons
the shared transaction.

``--dry-run`` plans against the REAL database — every UPDATE executes inside
the transaction so rowcounts and the report are the truth — and then rolls
back (``transaction(force_rollback=True)``), writing nothing (the same
plan-then-rollback shape the corpus loaders use).

WHY NO ``load_state`` CHECKPOINT (same rationale as ``load_ttmik_audio``):
the ``corpus`` enum has no ``topik_audio`` member, and the whole pass is a
few hundred single-row keyed UPDATEs — cheap, per-paper atomic, and safely
re-runnable, so resume bookkeeping would add a schema change for no benefit.
This loader copies nothing; it only points existing rows at existing audio.

RUNNING: km-db is NOT host-exposed (it lives on the km-internal Docker
network) — run this module inside the ingest/deploy container context where
``DATABASE_URL`` reaches km-db (the ``Deploy/load-corpora.sh`` environment),
not from the bare host. psycopg is imported lazily so the pure artifact
parsing/validation helpers stay importable host-side without DB deps.

SECURITY: every value is bound via psycopg ``%s`` placeholders — no artifact
string is ever concatenated into SQL (LOADERS_SECURITY.md §1). ``source_mp3``
is validated as a relative POSIX key (absolute paths and ``..`` traversal
are rejected at parse time) so a tampered artifact cannot plant a path that
escapes the corpus root — the serving route enforces containment again at
read time (defense in depth, 035's contract).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only; psycopg stays lazy
    from psycopg import AsyncConnection
    from psycopg_pool import AsyncConnectionPool

    from .runtime import LoaderConfig

logger = structlog.get_logger(__name__)

# Artifact filename contract of tools/ingest/topik_audio (run.py).
ARTIFACT_GLOB = "topik_*_listening.json"

# Where tools/ingest/topik_audio writes its artifacts by default (run.py's
# DEFAULT_OUTPUT_DIR) — kept in lockstep by the integration between the two
# CLIs' defaults, not by importing run.py (which would drag in whisper deps).
DEFAULT_ARTIFACTS_DIR = (
    Path(__file__).resolve().parents[1] / "output" / "topik_audio_segments"
)

# Closed set enforced by ck_topik_tests_topik_level (005).
_TOPIK_LEVELS = frozenset({"TOPIK I", "TOPIK II"})

# Sanity ceiling on span offsets: 24 hours in ms. The real listening papers
# top out around 2.4M ms; anything past a day is corrupt data, and 078's
# audio_*_ms columns are INTEGER so an unbounded value would surface as a raw
# psycopg overflow instead of a counted refusal (see GUARDS).
MAX_SPAN_MS = 86_400_000


class ArtifactError(ValueError):
    """A segment artifact is structurally malformed (bad JSON, wrong types,
    an absolute/traversing ``source_mp3``, an item_number claimed by more
    than one segment, …).

    Raised at PARSE time, before any DB work — per ADR-019 §D10 the loader
    fails loud on a broken artifact rather than guessing its way past it.
    Span-value problems (``end_ms <= start_ms``) are deliberately NOT parse
    errors: they are refused per-segment at load time so the rest of the
    paper still maps and the refusal is COUNTED in the report.
    """


@dataclass(frozen=True)
class Segment:
    """One aligned span covering one item — or two, when paired (plan §5)."""

    item_numbers: tuple[int, ...]
    start_ms: int
    end_ms: int
    confidence: float
    marker: str
    low_confidence: bool

    def span_is_valid(self) -> bool:
        """078's ck_topik_items_audio_span valid-window arm, plus the
        MAX_SPAN_MS sanity ceiling (end bounded implies start bounded, since
        start < end)."""
        return (
            self.start_ms >= 0
            and self.end_ms > self.start_ms
            and self.end_ms <= MAX_SPAN_MS
        )


@dataclass(frozen=True)
class PaperArtifact:
    """One parsed ``topik_<N>_<lvl>_listening.json`` artifact."""

    path: Path
    test_number: int
    topik_level: str
    source_mp3: str
    audio_sha256: str
    aligner_version: str
    segments: tuple[Segment, ...]
    unresolved_items: tuple[int, ...]


def _require(condition: bool, path: Path, message: str) -> None:
    if not condition:
        raise ArtifactError(f"{path.name}: {message}")


def _as_int(value: Any, path: Path, field_name: str) -> int:
    # bool is an int subclass — a JSON `true` must not sneak in as 1.
    _require(
        isinstance(value, int) and not isinstance(value, bool),
        path,
        f"{field_name} must be an integer, got {value!r}",
    )
    return int(value)


def _validate_source_mp3(value: Any, path: Path) -> str:
    _require(
        isinstance(value, str) and bool(value),
        path,
        f"source_mp3 must be a non-empty string, got {value!r}",
    )
    # A 035 corpus key is POSIX-only: any backslash (leading OR mid-string —
    # `a\..\b`, `C:\x.mp3`) is rejected outright rather than trusting POSIX
    # parsing to see through Windows separators.
    _require(
        "\\" not in value,
        path,
        f"source_mp3 must be a POSIX key with no backslashes, got {value!r}",
    )
    rel = PurePosixPath(value)
    _require(
        not rel.is_absolute(),
        path,
        f"source_mp3 must be corpus-relative, got absolute path {value!r}",
    )
    _require(
        ".." not in rel.parts,
        path,
        f"source_mp3 must not traverse ('..'), got {value!r}",
    )
    # No colon ANYWHERE (`C:/x.mp3`, `file:/…`, even mid-key `a/C:/x.mp3`) —
    # a drive/scheme token in any segment means the key was not minted by the
    # segmenter, and the key must resolve strictly under the corpus root on
    # every platform (the parse-time guarantee holds for Windows-style paths
    # too, not just the shapes PurePosixPath understands).
    _require(
        bool(rel.parts) and ":" not in value,
        path,
        f"source_mp3 must not contain a drive/scheme segment (':'), got {value!r}",
    )
    return value


def _parse_segment(raw: Any, path: Path, index: int) -> Segment:
    _require(
        isinstance(raw, dict), path, f"segments[{index}] must be an object"
    )
    numbers_raw = raw.get("item_numbers")
    _require(
        isinstance(numbers_raw, list) and len(numbers_raw) > 0,
        path,
        f"segments[{index}].item_numbers must be a non-empty array",
    )
    item_numbers = tuple(
        _as_int(n, path, f"segments[{index}].item_numbers[{i}]")
        for i, n in enumerate(numbers_raw)
    )
    _require(
        all(n >= 1 for n in item_numbers),
        path,
        f"segments[{index}].item_numbers must all be >= 1 "
        "(ck_topik_items_item_number_pos)",
    )
    confidence = raw.get("confidence")
    _require(
        isinstance(confidence, (int, float)) and not isinstance(confidence, bool),
        path,
        f"segments[{index}].confidence must be a number, got {confidence!r}",
    )
    marker = raw.get("marker")
    _require(
        isinstance(marker, str),
        path,
        f"segments[{index}].marker must be a string, got {marker!r}",
    )
    low_confidence = raw.get("low_confidence")
    _require(
        isinstance(low_confidence, bool),
        path,
        f"segments[{index}].low_confidence must be a boolean, "
        f"got {low_confidence!r}",
    )
    return Segment(
        item_numbers=item_numbers,
        start_ms=_as_int(raw.get("start_ms"), path, f"segments[{index}].start_ms"),
        end_ms=_as_int(raw.get("end_ms"), path, f"segments[{index}].end_ms"),
        confidence=float(confidence),
        marker=marker,
        low_confidence=low_confidence,
    )


def parse_artifact(path: Path) -> PaperArtifact:
    """Parse + structurally validate one segment artifact.

    Pure (filesystem read only, no DB) — unit-tested standalone. Raises
    :class:`ArtifactError` with the offending file + field named on any
    contract violation; see the class docstring for what is deliberately
    NOT a parse error.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise ArtifactError(f"{path.name}: unreadable or invalid JSON: {err}") from err
    _require(isinstance(data, dict), path, "top level must be a JSON object")

    test_number = _as_int(data.get("test_number"), path, "test_number")
    _require(test_number >= 1, path, "test_number must be >= 1")

    topik_level = data.get("topik_level")
    _require(
        topik_level in _TOPIK_LEVELS,
        path,
        f"topik_level must be one of {sorted(_TOPIK_LEVELS)}, got {topik_level!r}",
    )

    audio_sha256 = data.get("audio_sha256")
    # Shape-checked at parse: a truncated/garbage hash would otherwise only
    # surface later as a confusing drift "mismatch" against the real file.
    _require(
        isinstance(audio_sha256, str)
        and re.fullmatch(r"[0-9a-f]{64}", audio_sha256) is not None,
        path,
        f"audio_sha256 must be a 64-char lowercase hex sha256, got {audio_sha256!r}",
    )
    aligner_version = data.get("aligner_version")
    _require(
        isinstance(aligner_version, str) and bool(aligner_version),
        path,
        f"aligner_version must be a non-empty string, got {aligner_version!r}",
    )

    segments_raw = data.get("segments")
    _require(isinstance(segments_raw, list), path, "segments must be an array")
    unresolved_raw = data.get("unresolved_items", [])
    _require(
        isinstance(unresolved_raw, list), path, "unresolved_items must be an array"
    )

    segments = tuple(
        _parse_segment(raw, path, i) for i, raw in enumerate(segments_raw)
    )
    # Segmenter invariant: a paper's segments cover DISJOINT item sets. A
    # duplicate (across segments or within one item_numbers array) would make
    # the last write silently win at load time — fail loud here instead
    # (see GUARDS in the module docstring).
    seen_items: set[int] = set()
    for seg in segments:
        for n in seg.item_numbers:
            _require(
                n not in seen_items,
                path,
                f"item {n} appears in more than one segment (or twice within "
                "one) — a paper's segment item_numbers must be disjoint",
            )
            seen_items.add(n)

    unresolved_items = tuple(
        _as_int(n, path, f"unresolved_items[{i}]")
        for i, n in enumerate(unresolved_raw)
    )
    # An item cannot be BOTH segmented and unresolved — that contradiction
    # means a hand-edited artifact or broken segmenter bookkeeping; fail loud
    # rather than let the segment's span silently win.
    for n in unresolved_items:
        _require(
            n not in seen_items,
            path,
            f"item {n} appears both in a segment and in unresolved_items",
        )

    return PaperArtifact(
        path=path,
        test_number=test_number,
        topik_level=str(topik_level),
        source_mp3=_validate_source_mp3(data.get("source_mp3"), path),
        audio_sha256=audio_sha256,
        aligner_version=aligner_version,
        segments=segments,
        unresolved_items=unresolved_items,
    )


def discover_artifacts(artifacts_dir: Path) -> list[Path]:
    """Every ``topik_*_listening.json`` under ``artifacts_dir``, sorted.

    Raises FileNotFoundError on a missing directory OR zero matches — a
    mispointed ``--artifacts-dir`` must fail loudly, never "0 papers mapped,
    exit 0" (the same posture as ``scan_audio_tree``'s missing-dir guard).
    """
    if not artifacts_dir.is_dir():
        raise FileNotFoundError(
            f"{artifacts_dir} is not a directory — --artifacts-dir must point "
            "at the tools/ingest/topik_audio output directory "
            f"(default: {DEFAULT_ARTIFACTS_DIR})"
        )
    paths = sorted(artifacts_dir.glob(ARTIFACT_GLOB))
    if not paths:
        raise FileNotFoundError(
            f"{artifacts_dir} contains no {ARTIFACT_GLOB} artifacts — "
            "run tools/ingest/topik_audio first, or fix --artifacts-dir"
        )
    return paths


def _sha256_of_file(path: Path) -> str:
    """Stream-hash a file in 64 KiB chunks (the MP3s run 38–85 MB — never
    slurp them). Local twin of ``runtime.sha256_of_file``: importing
    ``.runtime`` at module level would drag psycopg in and break the
    lazy-import contract (see RUNNING in the module docstring)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_source_mp3(paper: PaperArtifact, corpus_root: Path) -> str | None:
    """DRIFT GUARD (F-185): prove the artifact's offsets still describe the
    bytes on disk. Returns None when ``<corpus_root>/<source_mp3>`` hashes to
    the artifact's ``audio_sha256``; otherwise a human-readable refusal
    reason (missing file, unreadable file, or a sha256 mismatch — i.e. the
    audio was replaced/re-encoded after segmentation and every stored span
    would point at the wrong sounds).

    Pure filesystem helper (no DB) — unit-tested standalone. ``source_mp3``
    was already validated relative + traversal-free at parse time, so the
    join cannot escape ``corpus_root``.
    """
    mp3_path = corpus_root / PurePosixPath(paper.source_mp3)
    try:
        actual = _sha256_of_file(mp3_path)
    except FileNotFoundError:
        return f"source_mp3 not found under corpus root: {mp3_path}"
    except OSError as err:
        return f"source_mp3 unreadable: {mp3_path}: {err}"
    if actual != paper.audio_sha256:
        return (
            f"sha256 mismatch for {mp3_path}: artifact={paper.audio_sha256} "
            f"actual={actual} — re-run segmentation before loading"
        )
    return None


def _audio_seg_provenance(paper: PaperArtifact, seg: Segment) -> str:
    """The ``extra->'audio_seg'`` JSON payload (078's provenance contract)."""
    return json.dumps(
        {
            "confidence": seg.confidence,
            "marker": seg.marker,
            "low_confidence": seg.low_confidence,
            "audio_sha256": paper.audio_sha256,
            "aligner_version": paper.aligner_version,
        },
        ensure_ascii=False,
    )


@dataclass
class _Report:
    """Mutable run counters — finalized into the report dict by :func:`load`."""

    papers_total: int = 0
    papers_mapped: int = 0
    papers_skipped_empty: int = 0
    # Admitted papers (test row resolved) where ZERO spans actually landed —
    # every segment refused/gated, or every item absent from the DB. Gates
    # the non-zero exit: an admitted paper that maps nothing must not read
    # clean (and gets no audio_path — see GUARDS).
    papers_without_spans: int = 0
    tests_without_row: int = 0
    drift_mismatch: int = 0
    items_updated: int = 0
    items_skipped_low_conf: int = 0
    # Counted PER missing item_number, not per segment: a paired segment with
    # one absent DB item still maps its present sibling and adds 1 here.
    segments_without_matching_item: int = 0
    segments_invalid_span: int = 0
    items_without_segment: int = 0


async def _resolve_test_id(
    conn: AsyncConnection, *, test_number: int, topik_level: str
) -> int | None:
    """Resolve the listening paper's topik_tests.id by the 029 natural key."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id FROM topik_tests
             WHERE test_number = %s AND topik_level = %s AND section = 'listening'
            """,
            (test_number, topik_level),
        )
        row = await cur.fetchone()
    return int(row[0]) if row else None


async def _load_paper(
    conn: AsyncConnection,
    paper: PaperArtifact,
    *,
    test_id: int,
    min_confidence: float,
    report: _Report,
) -> int:
    """Write one paper's audio_path + item spans; returns how many spans
    actually LANDED (item-UPDATE rowcount hits). Runs inside the caller's
    shared run transaction; every statement is a keyed UPDATE. The paper is
    a full CLEAR-then-write: all its listening items' spans + audio_seg
    provenance are reset first, then the current segments land, so the rows
    converge exactly to THIS artifact (see the convergence comment below).

    ``audio_path`` is written only after at least one span actually LANDS
    (rowcount-proven, not merely admitted past the gates) — a paper whose
    every segment is refused/gated, or whose every item is absent from the
    DB, must not advertise audio it has no offsets for (the zero-segment
    rule, applied per-write; see GUARDS). When zero spans land the path is
    set to NULL: after the clearing below, a path left over from a previous
    run would be exactly the phantom-audio state that rule forbids. A
    landing segment whose PAIRED sibling is absent from the DB still maps
    the present item — that is a seeding gap surfaced via
    ``segments_without_matching_item``, not a bad artifact.
    """
    log = logger.bind(
        artifact=paper.path.name,
        test_number=paper.test_number,
        topik_level=paper.topik_level,
    )
    writable: list[Segment] = []
    for seg in paper.segments:
        if not seg.span_is_valid():
            # 078's CHECK (or its INTEGER columns, for an oversized value)
            # would reject this — refuse BEFORE the write and make the
            # corruption visible (see module docstring GUARDS).
            report.segments_invalid_span += 1
            log.error(
                "invalid_span_refused",
                item_numbers=list(seg.item_numbers),
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                marker=seg.marker,
            )
            continue
        if seg.confidence < min_confidence:
            # Below the operator's gate: the items stay transcript-only
            # rather than risking a wrong clip (plan §5's confidence gate).
            report.items_skipped_low_conf += len(seg.item_numbers)
            log.info(
                "segment_below_confidence_gate",
                item_numbers=list(seg.item_numbers),
                confidence=seg.confidence,
                min_confidence=min_confidence,
            )
            continue
        writable.append(seg)

    landed = 0
    async with conn.cursor() as cur:
        # CONVERGENCE (the stale-span clear): before this paper's CURRENT
        # segments are written, every one of its listening items is reset —
        # spans NULLed (both together, so 078's both-or-neither CHECK holds)
        # and the audio_seg provenance key deleted (other extra keys
        # survive `- 'audio_seg'`; a NULL extra stays NULL). An item a
        # regenerated artifact no longer covers therefore loses its stale
        # span instead of serving the wrong clip, and a normal re-run
        # clears-then-rewrites identical values (idempotent). This UPDATE's
        # rowcount is deliberately NOT counted anywhere: ``items_updated``
        # means spans WRITTEN, never spans cleared.
        await cur.execute(
            """
            UPDATE topik_items
               SET audio_start_ms = NULL,
                   audio_end_ms   = NULL,
                   extra = extra - 'audio_seg'
             WHERE topik_test_id = %s AND section = 'listening'
            """,
            (test_id,),
        )
        for seg in writable:
            provenance = _audio_seg_provenance(paper, seg)
            for item_number in seg.item_numbers:
                await cur.execute(
                    """
                    UPDATE topik_items
                       SET audio_start_ms = %s,
                           audio_end_ms   = %s,
                           extra = jsonb_set(
                               coalesce(extra, '{}'::jsonb),
                               '{audio_seg}',
                               %s::jsonb)
                     WHERE topik_test_id = %s AND item_number = %s
                    """,
                    (seg.start_ms, seg.end_ms, provenance, test_id, item_number),
                )
                if cur.rowcount == 1:
                    landed += 1
                    report.items_updated += 1
                else:
                    # Counted per missing item_number (a paired segment with
                    # one absent item still maps its present sibling).
                    report.segments_without_matching_item += 1
                    log.warning(
                        "segment_without_db_item",
                        item_number=item_number,
                        marker=seg.marker,
                    )

        # audio_path decided AFTER the item writes, on rowcount-proven
        # evidence: ≥1 landed span → advertise the paper's MP3; zero landed
        # (every segment refused/gated, or every item absent from the DB) →
        # NULL, because after the convergence clear above a leftover path
        # would advertise audio with no offsets behind it (see GUARDS).
        if landed:
            await cur.execute(
                "UPDATE topik_tests SET audio_path = %s WHERE id = %s",
                (paper.source_mp3, test_id),
            )
        else:
            await cur.execute(
                "UPDATE topik_tests SET audio_path = NULL WHERE id = %s",
                (test_id,),
            )
            log.warning("no_spans_landed_audio_path_cleared")

        # Listening items of this paper the artifact left span-less —
        # informational (unresolved/low-confidence/invalid items land here).
        # Read inside the same transaction so the count reflects this run's
        # writes (and, under --dry-run, the rolled-back plan).
        await cur.execute(
            """
            SELECT COUNT(*) FROM topik_items
             WHERE topik_test_id = %s
               AND section = 'listening'
               AND audio_start_ms IS NULL
            """,
            (test_id,),
        )
        row = await cur.fetchone()
        report.items_without_segment += int(row[0]) if row else 0
    return landed


async def load(
    pool: AsyncConnectionPool,
    source_path: Path,
    cfg: LoaderConfig,
    *,
    min_confidence: float = 0.0,
    corpus_root: Path | None = None,
) -> dict:
    """Map every segment artifact under ``source_path`` into migration 078.

    All artifacts are parsed UP FRONT (fail loud before any DB write on a
    structurally broken file) and drift-verified against ``corpus_root``
    when given — both pure filesystem work, kept OUTSIDE the transaction so
    hashing ~2 GB of MP3s never holds a DB connection. Then every admitted
    paper's UPDATEs run in ONE shared transaction (``load_ttmik_audio``'s
    posture); ``cfg.dry_run`` rolls it back after planning. Returns the
    report dict described in the module docstring.
    """
    log = logger.bind(source_path=str(source_path), dry_run=cfg.dry_run)
    papers = [parse_artifact(p) for p in discover_artifacts(source_path)]
    report = _Report(papers_total=len(papers))
    log.info("artifacts_discovered", papers=len(papers))
    if corpus_root is None:
        # Deliberate but noted: without the corpus mount we cannot prove the
        # offsets still describe the audio on disk (module docstring GUARDS).
        log.warning("drift_check_skipped_no_corpus_root")

    admitted: list[PaperArtifact] = []
    for paper in papers:
        plog = log.bind(
            artifact=paper.path.name,
            test_number=paper.test_number,
            topik_level=paper.topik_level,
        )
        if not paper.segments:
            # The corrupt papers (e.g. the 96th sitting) — never set an
            # audio_path that has no offsets behind it.
            report.papers_skipped_empty += 1
            plog.warning("artifact_has_no_segments_skipped")
            continue
        if corpus_root is not None:
            refusal = verify_source_mp3(paper, corpus_root)
            if refusal is not None:
                report.drift_mismatch += 1
                plog.error(
                    "source_mp3_drift_refused",
                    source_mp3=paper.source_mp3,
                    reason=refusal,
                )
                continue
        admitted.append(paper)

    async with (
        pool.connection() as conn,
        conn.transaction(force_rollback=cfg.dry_run),
    ):
        for paper in admitted:
            plog = log.bind(
                artifact=paper.path.name,
                test_number=paper.test_number,
                topik_level=paper.topik_level,
            )
            test_id = await _resolve_test_id(
                conn,
                test_number=paper.test_number,
                topik_level=paper.topik_level,
            )
            if test_id is None:
                report.tests_without_row += 1
                plog.warning("test_row_not_found")
                continue
            landed = await _load_paper(
                conn,
                paper,
                test_id=test_id,
                min_confidence=min_confidence,
                report=report,
            )
            if landed:
                report.papers_mapped += 1
            else:
                # Admitted, resolved, but ZERO spans landed — the per-segment
                # counters already say WHY; this counter makes the paper-level
                # outcome gate the exit code (see GUARDS + EXIT CODES).
                report.papers_without_spans += 1
                plog.warning("paper_admitted_but_no_spans_landed")

    # The same refusal counters that drive main()'s exit-1 gate also mark the
    # report itself, so a captured/logged report is self-describing instead
    # of reading "complete" over a run that must not be treated as clean.
    had_refusals = bool(
        report.segments_invalid_span
        or report.drift_mismatch
        or report.tests_without_row
        or report.papers_without_spans
    )
    result = {
        "status": "complete_with_refusals" if had_refusals else "complete",
        "dry_run": cfg.dry_run,
        "drift_check_enabled": corpus_root is not None,
        "papers_total": report.papers_total,
        "papers_mapped": report.papers_mapped,
        "papers_skipped_empty": report.papers_skipped_empty,
        "papers_without_spans": report.papers_without_spans,
        "tests_without_row": report.tests_without_row,
        "drift_mismatch": report.drift_mismatch,
        "items_updated": report.items_updated,
        "items_skipped_low_conf": report.items_skipped_low_conf,
        "segments_without_matching_item": report.segments_without_matching_item,
        "segments_invalid_span": report.segments_invalid_span,
        "items_without_segment": report.items_without_segment,
    }
    log.info("load_complete", **result)
    return result


# ---------------------------------------------------------------------------
# Standalone CLI
#
# Like load_literature.py, deliberately NOT wired into load_to_postgres.py's
# ALL_CORPORA dispatch: that orchestrator is keyed on the `corpus` enum and
# this pass has no member (see the checkpoint note in the module docstring).
# Deploy/load-corpora.sh invokes it alongside the other loaders.
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Load TOPIK listening segment artifacts "
            "(tools/ingest/topik_audio output) into migration 078's "
            "topik_tests.audio_path + topik_items audio span columns."
        )
    )
    p.add_argument(
        "--artifacts-dir",
        type=Path,
        default=DEFAULT_ARTIFACTS_DIR,
        help=f"Directory of {ARTIFACT_GLOB} artifacts "
        f"(default: {DEFAULT_ARTIFACTS_DIR}).",
    )
    p.add_argument(
        "--database-url",
        default=None,
        help="Postgres URL; falls back to $DATABASE_URL.",
    )
    p.add_argument(
        "--corpus-root",
        type=Path,
        default=None,
        help="Corpus audio root (CORPUS_AUDIO_DIR). When given, each "
        "artifact's source MP3 is sha256-verified against its audio_sha256 "
        "and a mismatching paper is refused (drift guard). Omit only where "
        "the corpus is not mounted — the check is then skipped and noted.",
    )
    p.add_argument(
        "--min-confidence",
        type=float,
        default=0.0,
        help="Skip segments below this alignment confidence (0.0-1.0); "
        "their items stay transcript-only. Default 0.0 = write all.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan against the real DB (full report), then roll back — "
        "writes nothing.",
    )
    p.add_argument(
        "--log-level", default="info", choices=("debug", "info", "warning", "error")
    )
    args = p.parse_args(argv)
    if not 0.0 <= args.min_confidence <= 1.0:
        p.error(f"--min-confidence must be within 0.0-1.0, got {args.min_confidence}")
    return args


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # Lazy: .runtime imports psycopg at module load; deferring it keeps the
    # pure parse/validate helpers importable without DB deps (see RUNNING).
    from .runtime import LoaderConfig, configure_logging, open_pool

    configure_logging(args.log_level)

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        logger.error("database_url_missing")
        print(
            "error: --database-url or $DATABASE_URL is required "
            "(postgres://user:pass@host:5432/db)",
            file=sys.stderr,
        )
        return 2
    cfg = LoaderConfig(database_url=database_url, dry_run=args.dry_run)

    async def _run() -> dict:
        async with open_pool(cfg) as pool:
            return await load(
                pool,
                args.artifacts_dir,
                cfg,
                min_confidence=args.min_confidence,
                corpus_root=args.corpus_root,
            )

    try:
        result = asyncio.run(_run())
    except Exception as err:  # noqa: BLE001 - CLI boundary: any failure → exit 1
        logger.error("topik_audio_loader_failed", error=str(err))
        return 1
    logger.info("topik_audio_loader_done", **result)
    # A refused span means a corrupted/hand-edited artifact slipped past the
    # segmenter's invariant gate; a drift refusal means the audio on disk no
    # longer matches the offsets; a missing expected test row means the
    # environment is wrong (load_topik.py has not seeded this paper); an
    # admitted paper that landed ZERO spans means every one of its segments
    # was refused/gated or every item is unseeded. In every case the good
    # papers are loaded, but the run must not read as clean (fail-loud,
    # ADR-019 §D10 — the full contract is in EXIT CODES above).
    environment_wrong = (
        result["segments_invalid_span"]
        or result["drift_mismatch"]
        or result["tests_without_row"]
        or result["papers_without_spans"]
    )
    return 1 if environment_wrong else 0


if __name__ == "__main__":
    sys.exit(main())
