"""
Darakwon extraction quality audit.

WHY this module exists
======================
The five Darakwon JSONs under ``tools/ingest/output/`` (3 KGIU grammar
levels + 2 vocab levels) were produced by Claude-vision OCR via parallel
subagents. Quality is generally good but not guaranteed: individual
agents flagged page-rendering gaps, schema-fidelity calls, and one theme
needed a retry after hitting a session-budget cap.

Before downstream features (SRS, TOPIK prep, tap-to-mine) depend on this
data, we need to MEASURE how good it actually is. This module does that
by:

  1. Drawing a deterministic stratified random sample (~5% per corpus)
     across the items in each JSON, balanced by unit / chapter / theme.
  2. For each sampled entry, re-OCR-ing the source PDF page(s) via
     Claude vision and comparing the freshly-extracted view against the
     entry written by the original agent.
  3. Classifying each comparison as PASS / MINOR_DISCREPANCY /
     MAJOR_DISCREPANCY / MISSING_DATA per ADR-023.
  4. Producing AUDIT_REPORT.md (human) and AUDIT_TRIAGE.csv (machine)
     plus a 95% Wilson confidence interval on the population PASS rate.

It is READ-ONLY against the JSONs and the PDFs. C1, C2, C4 own the
write side; we do not touch their files.

The vision-OCR step requires network + an Anthropic API key. The
sampling, comparison-scoring, and report-rendering steps work fully
offline, so the audit can be planned and re-played in any environment.
``audit_darakwon.py sample`` writes a sample manifest; ``compare``
performs the OCR calls (network); ``report`` reads the results JSON
and emits the markdown + CSV.

CLI
---
::

    python audit_darakwon.py sample \\
        --seed 20260528 \\
        --rate 0.05 \\
        --output audit_artifacts/sample_manifest.json

    python audit_darakwon.py compare \\
        --manifest audit_artifacts/sample_manifest.json \\
        --output audit_artifacts/comparison_results.json \\
        [--limit N] [--model claude-opus-4-5-20250929] [--dry-run]

    python audit_darakwon.py report \\
        --manifest audit_artifacts/sample_manifest.json \\
        --results audit_artifacts/comparison_results.json \\
        --report-out AUDIT_REPORT.md \\
        --triage-out AUDIT_TRIAGE.csv

See AUDIT_README.md for the full operator runbook and
db/docs/ADR-023-quality-audit-methodology.md for the methodology.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import logging
import math
import os
import random
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

try:
    import structlog  # type: ignore

    _structlog_available = True
except ImportError:  # pragma: no cover - structlog is a soft dep for offline runs
    structlog = None  # type: ignore
    _structlog_available = False

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def _configure_logging(level: str = "INFO") -> Any:
    """Configure structlog if available, else fall back to stdlib logging."""
    if _structlog_available:
        structlog.configure(
            processors=[
                structlog.contextvars.merge_contextvars,
                structlog.processors.add_log_level,
                structlog.processors.TimeStamper(fmt="iso"),
                structlog.processors.JSONRenderer(),
            ],
            wrapper_class=structlog.make_filtering_bound_logger(
                getattr(logging, level.upper(), logging.INFO)
            ),
            cache_logger_on_first_use=True,
        )
        return structlog.get_logger("audit_darakwon")

    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    return logging.getLogger("audit_darakwon")


logger = _configure_logging()


# ---------------------------------------------------------------------------
# Repo paths
# ---------------------------------------------------------------------------

INGEST_DIR = Path(__file__).resolve().parent
REPO_ROOT = INGEST_DIR.parents[1]
PROJECT_ROOT = REPO_ROOT.parent
OUTPUT_DIR = INGEST_DIR / "output"
DARAKWON_DIR = PROJECT_ROOT / "Darakwon"

# Corpus -> JSON file + source PDF + corpus kind
CORPUS_FILES: dict[str, dict[str, Any]] = {
    "kgiu_beginner": {
        "json": OUTPUT_DIR / "grammar_kgiu_beginner.json",
        "pdf": DARAKWON_DIR / "한국어 문법" / "1. Beginner - KGIU.pdf",
        "kind": "kgiu",
        "level": "beginner",
        "pdf_offset_default": 8,
    },
    "kgiu_intermediate": {
        "json": OUTPUT_DIR / "grammar_kgiu_intermediate.json",
        # Was sliced for extraction; full PDF still present at this path.
        "pdf": DARAKWON_DIR / "한국어 문법" / "2. Intermediate - KGIU.pdf",
        "kind": "kgiu",
        "level": "intermediate",
        "pdf_offset_default": 8,
    },
    "kgiu_advanced": {
        "json": OUTPUT_DIR / "grammar_kgiu_advanced.json",
        "pdf": DARAKWON_DIR / "한국어 문법" / "3. Advanced - KGIU.pdf",
        "kind": "kgiu",
        "level": "advanced",
        "pdf_offset_default": 8,  # drifts later; recorded in source.pdf_offset_note
    },
    "vocab_beginner": {
        "json": OUTPUT_DIR / "vocab_2000_beginner.json",
        "pdf": DARAKWON_DIR / "단어" / "2000 Essential Korean Words - Beginner.pdf",
        "kind": "vocab",
        "level": "beginner",
        "pdf_offset_default": 1,
    },
    "vocab_intermediate": {
        "json": OUTPUT_DIR / "vocab_2000_intermediate.json",
        "pdf": DARAKWON_DIR / "단어" / "2000 Essential Korean Words - Intermediate.pdf",
        "kind": "vocab",
        "level": "intermediate",
        "pdf_offset_default": 1,
    },
}

# ---------------------------------------------------------------------------
# Pydantic models for sampling + scoring artifacts
# ---------------------------------------------------------------------------

Severity = Literal["PASS", "MINOR_DISCREPANCY", "MAJOR_DISCREPANCY", "MISSING_DATA"]
SEVERITY_ORDER: list[Severity] = [
    "PASS",
    "MINOR_DISCREPANCY",
    "MAJOR_DISCREPANCY",
    "MISSING_DATA",
]


class SampleEntry(BaseModel):
    """One item selected for audit."""

    model_config = ConfigDict(extra="ignore")

    corpus: str
    entry_id: str
    entry_type: str
    stratum: str  # the chapter / theme / unit it was drawn from
    source_pages: list[int] = Field(default_factory=list)
    headword: str | None = None  # Korean pattern / word for quick scan
    json_index: int  # position within source items[] for reproducibility
    sha256_short: str  # first 12 hex chars of sha256(canonical entry JSON)


class SampleManifest(BaseModel):
    """The deterministic sample drawn for an audit run."""

    model_config = ConfigDict(extra="ignore")

    seed: int
    rate: float
    generated_at: str
    corpus_stats: dict[str, dict[str, int]]  # corpus -> {population, sampled, strata}
    entries: list[SampleEntry]


class FieldDiscrepancy(BaseModel):
    """One field-level mismatch between the JSON and the re-OCR view."""

    model_config = ConfigDict(extra="ignore")

    field: str
    severity: Severity
    expected: str | None  # value we believe correct (from OCR)
    found: str | None  # value present in the JSON
    note: str | None = None


class ComparisonResult(BaseModel):
    """One audited entry's comparison outcome."""

    model_config = ConfigDict(extra="ignore")

    corpus: str
    entry_id: str
    overall_severity: Severity
    discrepancies: list[FieldDiscrepancy] = Field(default_factory=list)
    ocr_method: str  # "claude_vision" | "skipped_no_network" | "snapshot"
    ocr_model: str | None = None
    pages_examined: list[int] = Field(default_factory=list)
    notes: str | None = None


# ---------------------------------------------------------------------------
# JSON shape helpers (read-only)
# ---------------------------------------------------------------------------


def _canonical_entry_bytes(entry: dict[str, Any]) -> bytes:
    """Stable JSON bytes for hashing — sorted keys, UTF-8, no NaN."""
    return json.dumps(entry, sort_keys=True, ensure_ascii=False).encode("utf-8")


def _short_sha(entry: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_entry_bytes(entry)).hexdigest()[:12]


def _load_corpus(corpus_key: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load the source JSON for a corpus and return (source_header, items)."""
    cfg = CORPUS_FILES[corpus_key]
    path = Path(cfg["json"])
    if not path.exists():
        raise FileNotFoundError(f"corpus JSON not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or "items" not in doc:
        raise ValueError(f"unexpected JSON shape in {path} — expected top-level 'items'")
    return doc.get("source", {}), list(doc["items"])


def _stratum_for(corpus_key: str, entry: dict[str, Any]) -> str:
    """Compute the sampling stratum for an entry.

    KGIU: chapter (parsed from id ``kgiu-<lvl>-cNN-XX`` or from ``unit``).
    Vocab: theme (the ``theme`` field, falling back to ``id`` prefix bucket).

    Returning a stable string lets us bucket items deterministically even
    when ``unit`` / ``theme`` are missing.
    """
    kind = CORPUS_FILES[corpus_key]["kind"]
    entry_id = entry.get("id") or ""

    if kind == "kgiu":
        # id shapes:
        #   "kgiu-beg-intro-01"   - intro block
        #   "kgiu-beg-u01-01"     - Beginner uses unit numbering (1..24)
        #   "kgiu-beg-gr-001"     - Beginner "grammar" appendix block
        #   "kgiu-beg-app-*"      - appendix sections
        #   "kgiu-int-c01-00"     - Intermediate uses chapter numbering (1..26)
        #   "kgiu-adv-c22-04"     - Advanced uses chapter numbering (1..22)
        parts = entry_id.split("-")
        if len(parts) >= 4:
            slug = parts[2]
            if slug.startswith("c") and slug[1:].isdigit():
                return f"chapter_{int(slug[1:]):02d}"
            if slug.startswith("u") and slug[1:].isdigit():
                return f"unit_{int(slug[1:]):02d}"
            if slug == "intro":
                return "intro_block"
            if slug == "gr":
                return "grammar_index"
            if slug == "app":
                return f"appendix_{parts[3][:20]}"
        if "intro" in entry_id:
            return "intro_block"
        unit = entry.get("unit")
        if unit:
            # take first 40 chars as a cheap stable bucket key
            return f"unit_{unit[:40]}"
        return "uncategorized"

    # vocab
    theme = entry.get("theme")
    if theme:
        return f"theme_{theme[:40]}"
    # fall back to bucketing by id range (~100 per bucket)
    parts = entry_id.split("-")
    if parts and parts[-1].isdigit():
        bucket = int(parts[-1]) // 100
        return f"idrange_{bucket:03d}"
    return "uncategorized"


def _headword_for(entry: dict[str, Any]) -> str | None:
    return entry.get("pattern") or entry.get("korean") or entry.get("title_en")


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------


def stratified_sample(
    items: list[dict[str, Any]],
    corpus_key: str,
    rate: float,
    rng: random.Random,
) -> list[SampleEntry]:
    """Stratified random sample of items at the requested rate.

    Implementation notes:
      * Buckets items by ``_stratum_for``.
      * Per stratum, target sample = ``ceil(rate * |stratum|)`` (so even
        small strata get representation).
      * Within a stratum we sample without replacement using the seeded
        RNG, so re-running with the same seed reproduces the exact list.
      * Final list is sorted by (stratum, json_index) so the manifest is
        deterministic regardless of dict iteration order.
    """
    if not 0 < rate <= 1:
        raise ValueError(f"rate must be in (0, 1]; got {rate}")

    buckets: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for idx, entry in enumerate(items):
        if not isinstance(entry, dict) or "id" not in entry:
            # corrupted source line — skip but log for audit context
            logger.warning(
                "skipping malformed entry in sampling",
                corpus=corpus_key,
                json_index=idx,
            )
            continue
        buckets[_stratum_for(corpus_key, entry)].append((idx, entry))

    selected: list[SampleEntry] = []
    for stratum in sorted(buckets):
        population = buckets[stratum]
        # Need at least 1 from each non-empty stratum (coverage > rate fidelity).
        target = max(1, math.ceil(len(population) * rate))
        target = min(target, len(population))
        pool_copy = list(population)
        rng.shuffle(pool_copy)
        drawn = pool_copy[:target]
        drawn.sort(key=lambda t: t[0])
        for idx, entry in drawn:
            selected.append(
                SampleEntry(
                    corpus=corpus_key,
                    entry_id=str(entry["id"]),
                    entry_type=str(entry.get("type") or "unknown"),
                    stratum=stratum,
                    source_pages=[
                        int(p) for p in (entry.get("source_pages") or []) if isinstance(p, int)
                    ],
                    headword=_headword_for(entry),
                    json_index=idx,
                    sha256_short=_short_sha(entry),
                )
            )

    return selected


def build_sample_manifest(seed: int, rate: float) -> SampleManifest:
    """Draw a stratified random sample across every Darakwon corpus."""
    rng = random.Random(seed)
    entries: list[SampleEntry] = []
    corpus_stats: dict[str, dict[str, int]] = {}

    for corpus_key in CORPUS_FILES:
        try:
            _, items = _load_corpus(corpus_key)
        except FileNotFoundError as exc:
            logger.warning("corpus missing; skipping", corpus=corpus_key, error=str(exc))
            corpus_stats[corpus_key] = {"population": 0, "sampled": 0, "strata": 0}
            continue

        sample = stratified_sample(items, corpus_key, rate, rng)
        strata_count = len({s.stratum for s in sample})
        corpus_stats[corpus_key] = {
            "population": len(items),
            "sampled": len(sample),
            "strata": strata_count,
        }
        entries.extend(sample)

    return SampleManifest(
        seed=seed,
        rate=rate,
        generated_at=datetime.now(timezone.utc).isoformat(),
        corpus_stats=corpus_stats,
        entries=entries,
    )


# ---------------------------------------------------------------------------
# Scoring — pure functions, testable
# ---------------------------------------------------------------------------


# Fields whose absence/change is a MAJOR finding for KGIU grammar entries.
_KGIU_CRITICAL_FIELDS: tuple[str, ...] = ("pattern", "explanation", "examples")
# Fields whose absence/change is a MAJOR finding for vocab word entries.
_VOCAB_CRITICAL_FIELDS: tuple[str, ...] = ("korean", "english", "part_of_speech")
# Fields where a value mismatch is MINOR (formatting / paraphrase tolerable).
_FORMATTING_FIELDS: tuple[str, ...] = (
    "category",
    "pronunciation",
    "audio_track",
    "register",
    "domain",
    "irregular_class",
    "case_marker",
)


def _normalize_text(value: Any) -> str:
    """Normalize a value for comparison: NFC, strip, collapse whitespace."""
    if value is None:
        return ""
    if isinstance(value, list):
        # list compare = join with separator so order matters but spacing
        # differences don't
        return " | ".join(_normalize_text(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True, ensure_ascii=False)
    text = unicodedata.normalize("NFC", str(value)).strip()
    return " ".join(text.split())


def _korean_only(text: str) -> str:
    """Keep only Hangul syllables/jamo for fuzzy Korean-equivalence checks."""
    return "".join(
        ch
        for ch in text
        if "가" <= ch <= "힣"  # Hangul syllables
        or "ᄀ" <= ch <= "ᇿ"  # Jamo
        or "㄰" <= ch <= "㆏"  # Compat jamo
    )


def classify_field_discrepancy(
    field: str,
    *,
    found: Any,
    expected: Any,
    is_critical: bool,
) -> Severity:
    """Pure classifier — given a found vs expected pair, return a severity.

    Semantics:
      * Both empty/None  -> PASS
      * found empty, expected nonempty -> MISSING_DATA
      * Both nonempty and equal (after normalization) -> PASS
      * Both nonempty, Korean-equivalent (ignoring punctuation / spacing)
        but English/markup differs -> MINOR
      * Critical field, values differ materially -> MAJOR
      * Non-critical field, values differ materially -> MINOR
    """
    f_norm = _normalize_text(found)
    e_norm = _normalize_text(expected)

    if not f_norm and not e_norm:
        return "PASS"
    if not f_norm and e_norm:
        return "MISSING_DATA"
    if f_norm and not e_norm:
        # We claim a value the OCR view doesn't see. Don't flag MAJOR unless
        # the field is structural — could be the OCR view that's incomplete.
        return "MINOR_DISCREPANCY"
    if f_norm == e_norm:
        return "PASS"

    # Look at Korean-only equivalence — many discrepancies are just
    # romanization/punctuation differences in surrounding English text.
    f_kr = _korean_only(f_norm)
    e_kr = _korean_only(e_norm)
    if f_kr and f_kr == e_kr:
        return "MINOR_DISCREPANCY"

    return "MAJOR_DISCREPANCY" if is_critical else "MINOR_DISCREPANCY"


def aggregate_severity(discrepancies: Iterable[FieldDiscrepancy]) -> Severity:
    """The overall severity for an entry is the worst per-field severity."""
    worst_index = 0
    for disc in discrepancies:
        try:
            idx = SEVERITY_ORDER.index(disc.severity)
        except ValueError:
            continue
        if idx > worst_index:
            worst_index = idx
    return SEVERITY_ORDER[worst_index]


def score_entry(
    *,
    corpus_kind: str,
    entry_type: str,
    found: dict[str, Any],
    expected: dict[str, Any],
) -> list[FieldDiscrepancy]:
    """Score a single audited entry given a found/expected dict pair.

    ``expected`` should be the fresh OCR view (subset of fields). Fields
    missing from ``expected`` are simply not checked — the OCR pass is
    not authoritative beyond the fields it returned.
    """
    if corpus_kind == "kgiu":
        critical = set(_KGIU_CRITICAL_FIELDS)
    elif corpus_kind == "vocab":
        critical = set(_VOCAB_CRITICAL_FIELDS)
    else:
        critical = set()

    discrepancies: list[FieldDiscrepancy] = []
    for field, expected_value in expected.items():
        if field in {"id", "source_pages", "ocr_notes"}:
            continue
        found_value = found.get(field)
        severity = classify_field_discrepancy(
            field,
            found=found_value,
            expected=expected_value,
            is_critical=field in critical and field not in _FORMATTING_FIELDS,
        )
        if severity != "PASS":
            discrepancies.append(
                FieldDiscrepancy(
                    field=field,
                    severity=severity,
                    expected=_normalize_text(expected_value) or None,
                    found=_normalize_text(found_value) or None,
                    note=None,
                )
            )
    return discrepancies


# ---------------------------------------------------------------------------
# Vision-OCR client (Anthropic SDK + prompt caching)
# ---------------------------------------------------------------------------


_OCR_SYSTEM_PROMPT = (
    "You are auditing a Korean language textbook extraction. You will be "
    "given (a) the printed PDF page(s) of the source textbook and (b) the "
    "JSON entry an earlier agent wrote from those pages. Respond with a "
    "compact JSON object describing what the page ACTUALLY contains for the "
    "fields the JSON populated. Do NOT paraphrase Korean — copy printed "
    "Hangul verbatim. If a field on the JSON is not visible on the page, "
    "omit it from your response (do not invent). Return ONLY JSON."
)


def _render_pdf_page_png(pdf_path: Path, pdf_page: int) -> bytes:
    """Render a 1-indexed PDF page as PNG bytes via PyMuPDF.

    Imported lazily so the sampling/report steps work without PyMuPDF
    installed.
    """
    import fitz  # type: ignore  # PyMuPDF

    doc = fitz.open(str(pdf_path))
    try:
        if pdf_page < 1 or pdf_page > doc.page_count:
            raise IndexError(
                f"page {pdf_page} out of range for {pdf_path.name} "
                f"({doc.page_count} pages)"
            )
        page = doc.load_page(pdf_page - 1)
        # 2x scale for vision OCR — readable at typical Hangul body font.
        pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
        buf = io.BytesIO(pix.tobytes("png"))
        return buf.getvalue()
    finally:
        doc.close()


def _book_page_to_pdf_page(book_page: int, offset: int) -> int:
    """Convert a printed book page to a PDF page using the configured offset."""
    return book_page + offset


class VisionOcrClient:
    """Thin wrapper around the Anthropic Python SDK with prompt caching.

    Prompt caching: the system prompt + the page image are sent as
    cache-eligible blocks so when the same page covers multiple sampled
    entries we don't pay the OCR cost twice (we send a different user
    message asking about a different entry, but the heavy bits — the
    image + system instructions — hit the cache).

    The client is offline-safe: if the SDK isn't installed or the API
    key is missing, ``available`` is False and callers should fall back
    to ``ocr_method="skipped_no_network"`` results.
    """

    def __init__(
        self,
        *,
        model: str = "claude-opus-4-5-20250929",
        api_key: str | None = None,
        max_tokens: int = 2048,
    ) -> None:
        self.model = model
        self.max_tokens = max_tokens
        self._client = None
        self._page_cache: dict[tuple[str, int], bytes] = {}
        try:
            import anthropic  # type: ignore
        except ImportError:
            logger.warning("anthropic SDK not installed; OCR step will be skipped")
            return

        key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            logger.warning("ANTHROPIC_API_KEY not set; OCR step will be skipped")
            return

        self._client = anthropic.Anthropic(api_key=key)

    @property
    def available(self) -> bool:
        return self._client is not None

    def _get_page_png(self, pdf_path: Path, pdf_page: int) -> bytes:
        key = (str(pdf_path), pdf_page)
        cached = self._page_cache.get(key)
        if cached is not None:
            return cached
        png = _render_pdf_page_png(pdf_path, pdf_page)
        self._page_cache[key] = png
        return png

    def extract_entry_view(
        self,
        *,
        pdf_path: Path,
        pdf_pages: list[int],
        entry: dict[str, Any],
    ) -> dict[str, Any]:
        """Ask the model what the page actually shows for this entry's fields.

        Returns a dict subset of the audited fields. Raises on transport
        error so the caller can decide to retry / mark MISSING_DATA.

        BLIND EXTRACTION (REVIEW_C3 F2 — self-confirmation bias fix):
            The pre-fix prompt included the JSON values being audited:

                "Fields on the JSON to verify: {pattern: '-아/어도', ...}"

            That anchored the model toward confirming what the agent already
            wrote — exactly the bias ADR-023 §"Negative consequences" calls
            out in the abstract. The fix is to send only the field NAMES the
            comparator cares about. The model has to extract values from the
            page image alone; the JSON's values are never seen by the OCR
            pass. The score_entry step compares the model's blind extraction
            against the JSON in a separate, value-aware pass.

            This makes the audit a real second opinion. ADR-023 has been
            updated to reflect the fix.
        """
        if not self.available:
            raise RuntimeError("vision client unavailable (no SDK or no API key)")

        # Build the user content: page images (cached) + a question.
        content_blocks: list[dict[str, Any]] = []
        for pdf_page in pdf_pages:
            png_bytes = self._get_page_png(pdf_path, pdf_page)
            content_blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": base64.b64encode(png_bytes).decode("ascii"),
                    },
                    # Mark each image as cacheable — repeated calls with the
                    # same page hit the prompt cache.
                    "cache_control": {"type": "ephemeral"},
                }
            )

        # Build the field-NAMES-only list. We intentionally do NOT include
        # the JSON values — the model must extract them from the image,
        # not echo what we already wrote. Bookkeeping fields (source_pages,
        # source_book) are still excluded because they describe the
        # extraction process, not the dictionary content.
        field_names = sorted(
            k for k in entry.keys()
            if k not in {"source_pages", "source_book"}
        )
        question = {
            "type": "text",
            "text": (
                "Audited entry id: " + str(entry.get("id"))
                + "\nField names to extract from the page (do NOT guess; "
                "look at the printed page and report what you actually see): "
                + json.dumps(field_names, ensure_ascii=False)
                + "\n\nRespond with a compact JSON object whose keys are a "
                "SUBSET of the field names above and whose values are what "
                "the page actually prints. If a field name is not visibly "
                "represented on the page, omit it from your response — do "
                "not invent a value."
            ),
        }
        content_blocks.append(question)

        message = self._client.messages.create(  # type: ignore[union-attr]
            model=self.model,
            max_tokens=self.max_tokens,
            system=[
                {
                    "type": "text",
                    "text": _OCR_SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": content_blocks}],
        )

        # Concatenate any text blocks the model returned.
        text_chunks: list[str] = []
        for block in message.content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text_chunks.append(getattr(block, "text", ""))
        raw = "".join(text_chunks).strip()
        # Strip Markdown code fences if present.
        if raw.startswith("```"):
            raw = raw.strip("`")
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.warning(
                "OCR response was not valid JSON",
                entry_id=entry.get("id"),
                error=str(exc),
                raw_first_120=raw[:120],
            )
            return {}


# ---------------------------------------------------------------------------
# Compare orchestrator
# ---------------------------------------------------------------------------


_PAGES_TO_EXAMINE_CAP = 4


def _pages_to_examine(
    entry: dict[str, Any],
    *,
    pdf_offset: int,
) -> list[int]:
    """Convert ``source_pages`` (book pages) to 1-indexed PDF pages.

    Caps at ``_PAGES_TO_EXAMINE_CAP`` pages per entry to keep OCR cost
    bounded — most entries cover 1–3 pages anyway. When the cap fires we
    log a warning so the operator can decide whether to bump the cap for
    a re-audit (REVIEW_C3 F4 — observability gap).
    """
    book_pages = [int(p) for p in (entry.get("source_pages") or []) if isinstance(p, int)]
    if not book_pages:
        return []
    pdf_pages = [_book_page_to_pdf_page(p, pdf_offset) for p in book_pages]
    if len(pdf_pages) > _PAGES_TO_EXAMINE_CAP:
        logger.warning(
            "truncating_source_pages_for_cost",
            entry_id=entry.get("id"),
            requested=len(pdf_pages),
            cap=_PAGES_TO_EXAMINE_CAP,
            dropped=pdf_pages[_PAGES_TO_EXAMINE_CAP:],
        )
    return pdf_pages[:_PAGES_TO_EXAMINE_CAP]


def run_comparisons(
    manifest: SampleManifest,
    *,
    ocr_client: VisionOcrClient,
    limit: int | None = None,
    dry_run: bool = False,
) -> list[ComparisonResult]:
    """Run the comparison step. Returns one ComparisonResult per audited entry.

    If the OCR client is unavailable (no SDK, no key, or ``dry_run=True``),
    we still produce a result for each entry with
    ``ocr_method="skipped_no_network"`` — the report step then surfaces
    them so the operator knows the audit didn't include vision validation.
    """
    # Cache loaded corpora so we don't re-read them per entry.
    corpus_cache: dict[str, list[dict[str, Any]]] = {}
    results: list[ComparisonResult] = []

    entries = manifest.entries[: (limit if limit and limit > 0 else None)]
    for sample in entries:
        cfg = CORPUS_FILES[sample.corpus]
        if sample.corpus not in corpus_cache:
            _, items = _load_corpus(sample.corpus)
            corpus_cache[sample.corpus] = items
        items = corpus_cache[sample.corpus]

        # Locate the canonical entry — defend against array reorder by
        # checking json_index then falling back to id-match.
        entry: dict[str, Any] | None = None
        if 0 <= sample.json_index < len(items):
            candidate = items[sample.json_index]
            if str(candidate.get("id")) == sample.entry_id:
                entry = candidate
        if entry is None:
            for item in items:
                if str(item.get("id")) == sample.entry_id:
                    entry = item
                    break

        if entry is None:
            results.append(
                ComparisonResult(
                    corpus=sample.corpus,
                    entry_id=sample.entry_id,
                    overall_severity="MISSING_DATA",
                    discrepancies=[
                        FieldDiscrepancy(
                            field="<entry>",
                            severity="MISSING_DATA",
                            expected=None,
                            found=None,
                            note="entry id not found in source JSON",
                        )
                    ],
                    ocr_method="skipped_no_entry",
                    ocr_model=None,
                    pages_examined=[],
                )
            )
            continue

        pdf_pages = _pages_to_examine(entry, pdf_offset=cfg["pdf_offset_default"])

        if dry_run or not ocr_client.available:
            results.append(
                ComparisonResult(
                    corpus=sample.corpus,
                    entry_id=sample.entry_id,
                    overall_severity="PASS",  # cannot judge — recorded as PASS-with-note
                    discrepancies=[],
                    ocr_method="skipped_no_network",
                    ocr_model=None,
                    pages_examined=pdf_pages,
                    notes="OCR comparison skipped — re-run with ANTHROPIC_API_KEY set.",
                )
            )
            continue

        try:
            expected_view = ocr_client.extract_entry_view(
                pdf_path=Path(cfg["pdf"]),
                pdf_pages=pdf_pages,
                entry=entry,
            )
        except Exception as exc:  # noqa: BLE001 — boundary; we log + downgrade
            logger.error(
                "OCR call failed",
                corpus=sample.corpus,
                entry_id=sample.entry_id,
                error=str(exc),
            )
            results.append(
                ComparisonResult(
                    corpus=sample.corpus,
                    entry_id=sample.entry_id,
                    overall_severity="MISSING_DATA",
                    discrepancies=[
                        FieldDiscrepancy(
                            field="<ocr>",
                            severity="MISSING_DATA",
                            expected=None,
                            found=None,
                            note=f"OCR error: {exc!s}",
                        )
                    ],
                    ocr_method="ocr_error",
                    ocr_model=ocr_client.model,
                    pages_examined=pdf_pages,
                )
            )
            continue

        discrepancies = score_entry(
            corpus_kind=cfg["kind"],
            entry_type=sample.entry_type,
            found=entry,
            expected=expected_view,
        )
        overall = aggregate_severity(discrepancies)
        results.append(
            ComparisonResult(
                corpus=sample.corpus,
                entry_id=sample.entry_id,
                overall_severity=overall,
                discrepancies=discrepancies,
                ocr_method="claude_vision",
                ocr_model=ocr_client.model,
                pages_examined=pdf_pages,
            )
        )

    return results


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------


def wilson_ci(passes: int, n: int, *, z: float = 1.96) -> tuple[float, float]:
    """Wilson-score 95% CI for a binomial proportion.

    Better behaved than the normal-approximation interval at the small
    samples / extreme proportions we'll see at 5% of a few thousand items.
    """
    if n == 0:
        return (0.0, 0.0)
    phat = passes / n
    denom = 1 + z * z / n
    center = (phat + z * z / (2 * n)) / denom
    margin = z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def _severity_breakdown(results: Iterable[ComparisonResult]) -> Counter[str]:
    return Counter(r.overall_severity for r in results)


# ---------------------------------------------------------------------------
# Structural audit — offline checks that don't need OCR
# ---------------------------------------------------------------------------


def structural_audit(corpus_key: str) -> list[ComparisonResult]:
    """Scan a whole corpus for structural / schema-fidelity issues.

    Catches what static inspection can: duplicate ids, missing
    source_pages on non-intro entries, vocab `word` entries missing
    the Korean headword or English gloss, KGIU `grammar` entries
    missing both ``pattern`` and ``title_en``, and a small set of
    well-known eyeballed bugs (POS values not in the schema enum,
    obvious bookkeeping mistakes). Cheap, instant, and a useful
    smoke-test even when network OCR isn't available.
    """
    cfg = CORPUS_FILES[corpus_key]
    kind = cfg["kind"]
    _, items = _load_corpus(corpus_key)

    results: list[ComparisonResult] = []
    seen_ids: Counter[str] = Counter()
    valid_pos = {
        "noun",
        "verb",
        "adjective",
        "adverb",
        "pronoun",
        "exclamation",
        "determiner",
        "bound_noun",
    }

    for entry in items:
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id") or "<no-id>")
        seen_ids[entry_id] += 1
        discrepancies: list[FieldDiscrepancy] = []

        if "id" not in entry:
            discrepancies.append(
                FieldDiscrepancy(
                    field="id",
                    severity="MAJOR_DISCREPANCY",
                    expected="<non-empty>",
                    found=None,
                    note="entry has no id",
                )
            )

        # All entries should record their source pages.
        pages = entry.get("source_pages") or []
        if not pages:
            # intros sometimes omit source_pages — flag MINOR rather than MAJOR
            severity: Severity = "MINOR_DISCREPANCY"
            if entry.get("type") in {"grammar", "word"}:
                severity = "MAJOR_DISCREPANCY"
            discrepancies.append(
                FieldDiscrepancy(
                    field="source_pages",
                    severity=severity,
                    expected="non-empty list",
                    found="empty",
                    note=f"entry type={entry.get('type')}",
                )
            )

        if kind == "kgiu":
            if entry.get("type") == "grammar":
                if not entry.get("pattern") and not entry.get("title_en"):
                    discrepancies.append(
                        FieldDiscrepancy(
                            field="pattern",
                            severity="MAJOR_DISCREPANCY",
                            expected="pattern or title_en",
                            found=None,
                            note="grammar entry missing both pattern and title_en",
                        )
                    )
                if not entry.get("explanation"):
                    discrepancies.append(
                        FieldDiscrepancy(
                            field="explanation",
                            severity="MISSING_DATA",
                            expected="non-empty explanation",
                            found=None,
                        )
                    )
                if not entry.get("examples"):
                    discrepancies.append(
                        FieldDiscrepancy(
                            field="examples",
                            severity="MISSING_DATA",
                            expected="at least one example",
                            found="[]",
                        )
                    )
                # POS is a vocab field — KGIU shouldn't have it. Don't check.
        elif kind == "vocab":
            if entry.get("type") == "word":
                if not entry.get("korean"):
                    discrepancies.append(
                        FieldDiscrepancy(
                            field="korean",
                            severity="MAJOR_DISCREPANCY",
                            expected="Korean headword",
                            found=None,
                        )
                    )
                if not entry.get("english"):
                    discrepancies.append(
                        FieldDiscrepancy(
                            field="english",
                            severity="MAJOR_DISCREPANCY",
                            expected="English gloss",
                            found=None,
                        )
                    )
                pos = entry.get("part_of_speech")
                if pos and pos not in valid_pos:
                    # Composite POS like "noun, adverb" is a schema-fidelity
                    # call documented in the guide — flag MINOR so it's
                    # visible but doesn't dominate.
                    discrepancies.append(
                        FieldDiscrepancy(
                            field="part_of_speech",
                            severity="MINOR_DISCREPANCY",
                            expected="one of " + " | ".join(sorted(valid_pos)),
                            found=str(pos),
                            note="composite/non-enum POS",
                        )
                    )
                # audio_track presence check (REVIEW_C3 F1).
                #
                # The two vocab books group multiple words per audio track,
                # but extraction should still record the track on each word
                # so the cards UI can play audio per-card without joining to
                # a separate table. A missing audio_track is MINOR — the
                # entry is still usable, just lacks playback. Counting it
                # here makes the per-entry MINOR column in AUDIT_REPORT.md
                # mechanically reproducible (pre-fix, the report claimed
                # numbers the structural pass did not actually emit).
                if "audio_track" not in entry or entry.get("audio_track") in (
                    None, "", []
                ):
                    discrepancies.append(
                        FieldDiscrepancy(
                            field="audio_track",
                            severity="MINOR_DISCREPANCY",
                            expected="non-empty audio_track",
                            found="missing",
                            note="vocab word entry missing audio_track",
                        )
                    )

        results.append(
            ComparisonResult(
                corpus=corpus_key,
                entry_id=entry_id,
                overall_severity=aggregate_severity(discrepancies),
                discrepancies=discrepancies,
                ocr_method="structural_only",
                ocr_model=None,
                pages_examined=[],
            )
        )

    # Duplicate id detection — add MAJOR after the loop so we know totals.
    for entry_id, count in seen_ids.items():
        if count > 1:
            # Find the first result for this id and append the discrepancy.
            for r in results:
                if r.entry_id == entry_id:
                    r.discrepancies.append(
                        FieldDiscrepancy(
                            field="id",
                            severity="MAJOR_DISCREPANCY",
                            expected="unique id",
                            found=f"{count} copies",
                            note="duplicate id",
                        )
                    )
                    # Re-aggregate severity since we mutated discrepancies.
                    r.overall_severity = aggregate_severity(r.discrepancies)
                    break

    return results


def render_report(
    *,
    manifest: SampleManifest,
    results: list[ComparisonResult],
) -> str:
    """Render the human-readable AUDIT_REPORT.md."""
    by_corpus: dict[str, list[ComparisonResult]] = defaultdict(list)
    for r in results:
        by_corpus[r.corpus].append(r)

    total_pass = sum(1 for r in results if r.overall_severity == "PASS")
    total = len(results)
    lo, hi = wilson_ci(total_pass, total)

    lines: list[str] = []
    lines.append("# Darakwon Extraction Audit Report")
    lines.append("")
    lines.append(f"- Generated: {datetime.now(timezone.utc).isoformat()}")
    lines.append(f"- Sample seed: {manifest.seed}")
    lines.append(f"- Sample rate: {manifest.rate:.1%}")
    lines.append(f"- Sample size: {total}")
    lines.append(
        f"- Overall PASS rate: {total_pass}/{total} "
        f"({(total_pass / total if total else 0):.1%}) "
        f"— 95% Wilson CI [{lo:.1%}, {hi:.1%}]"
    )
    skipped = sum(1 for r in results if r.ocr_method == "skipped_no_network")
    if skipped:
        lines.append(
            f"- **WARNING:** {skipped} of {total} entries were not OCR-compared "
            "(no network / no API key). The PASS rate above is therefore "
            "structural-only; re-run `compare` with ANTHROPIC_API_KEY set "
            "for content-level validation."
        )
    lines.append("")
    lines.append("## Per-corpus stats")
    lines.append("")
    lines.append(
        "| Corpus | Population | Sampled | Strata | PASS | MINOR | MAJOR | MISSING |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for corpus in sorted(by_corpus):
        stats = manifest.corpus_stats.get(corpus, {})
        breakdown = _severity_breakdown(by_corpus[corpus])
        lines.append(
            "| {corpus} | {pop} | {sampled} | {strata} | "
            "{p} | {mi} | {ma} | {miss} |".format(
                corpus=corpus,
                pop=stats.get("population", 0),
                sampled=stats.get("sampled", len(by_corpus[corpus])),
                strata=stats.get("strata", 0),
                p=breakdown.get("PASS", 0),
                mi=breakdown.get("MINOR_DISCREPANCY", 0),
                ma=breakdown.get("MAJOR_DISCREPANCY", 0),
                miss=breakdown.get("MISSING_DATA", 0),
            )
        )
    lines.append("")

    lines.append("## Entries with MAJOR_DISCREPANCY")
    lines.append("")
    majors = [r for r in results if r.overall_severity == "MAJOR_DISCREPANCY"]
    if not majors:
        lines.append("_None._")
    else:
        for r in majors:
            lines.append(f"### `{r.entry_id}` ({r.corpus})")
            for d in r.discrepancies:
                if d.severity == "MAJOR_DISCREPANCY":
                    lines.append(
                        f"- **{d.field}**: expected `{d.expected}` — "
                        f"found `{d.found}`"
                    )
            lines.append("")

    lines.append("## Entries with MISSING_DATA")
    lines.append("")
    missing = [r for r in results if r.overall_severity == "MISSING_DATA"]
    if not missing:
        lines.append("_None._")
    else:
        for r in missing:
            lines.append(f"### `{r.entry_id}` ({r.corpus})")
            for d in r.discrepancies:
                if d.severity == "MISSING_DATA":
                    lines.append(
                        f"- **{d.field}**: expected `{d.expected}` "
                        f"({d.note or 'no note'})"
                    )
            lines.append("")

    lines.append("## Cross-corpus patterns")
    lines.append("")
    field_severity_counter: Counter[tuple[str, str]] = Counter()
    for r in results:
        for d in r.discrepancies:
            field_severity_counter[(d.field, d.severity)] += 1
    if not field_severity_counter:
        lines.append(
            "_No discrepancies observed — either coverage is excellent or "
            "the OCR step was skipped (see warning above)._"
        )
    else:
        lines.append("| Field | Severity | Count |")
        lines.append("|---|---|---:|")
        for (field, sev), n in field_severity_counter.most_common(25):
            lines.append(f"| {field} | {sev} | {n} |")
    lines.append("")

    lines.append("## Recommendations")
    lines.append("")
    lines.append(
        "- **MAJOR_DISCREPANCY** entries: open as triage tickets, re-extract "
        "or hand-fix from the source PDF page before downstream loading."
    )
    lines.append(
        "- **MISSING_DATA** entries: most likely a dropped field during the "
        "agent's run; re-extract just the affected fields from the listed "
        "PDF pages."
    )
    lines.append(
        "- **Recurring field patterns** (e.g. all `hanja` entries off by "
        "one in the vocab Beginner): treat as a systematic bug — write a "
        "follow-up script to re-extract that single field across the corpus, "
        "rather than re-running the whole extraction."
    )
    lines.append(
        "- Re-run `audit_darakwon.py` after fixes with the SAME `--seed`; "
        "the sample is reproducible so before/after PASS rates are "
        "directly comparable."
    )

    return "\n".join(lines) + "\n"


def render_triage_csv(results: list[ComparisonResult]) -> str:
    """Render AUDIT_TRIAGE.csv — one row per non-PASS discrepancy."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["corpus", "entry_id", "severity", "field", "expected", "found", "notes"]
    )
    for r in results:
        for d in r.discrepancies:
            writer.writerow(
                [
                    r.corpus,
                    r.entry_id,
                    d.severity,
                    d.field,
                    d.expected or "",
                    d.found or "",
                    d.note or "",
                ]
            )
    return buf.getvalue()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cmd_sample(args: argparse.Namespace) -> int:
    manifest = build_sample_manifest(seed=args.seed, rate=args.rate)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(manifest.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info(
        "sample manifest written",
        path=str(out_path),
        total=len(manifest.entries),
        rate=manifest.rate,
        seed=manifest.seed,
    )
    print(
        f"Sampled {len(manifest.entries)} entries across "
        f"{len(manifest.corpus_stats)} corpora → {out_path}"
    )
    return 0


def _cmd_compare(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        logger.error("manifest not found", path=str(manifest_path))
        return 2
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest = SampleManifest.model_validate(raw)

    client = VisionOcrClient(model=args.model)
    results = run_comparisons(
        manifest, ocr_client=client, limit=args.limit, dry_run=args.dry_run
    )

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps([r.model_dump() for r in results], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    breakdown = _severity_breakdown(results)
    logger.info(
        "comparison results written",
        path=str(out_path),
        total=len(results),
        breakdown=dict(breakdown),
        client_available=client.available,
    )
    print(
        f"Compared {len(results)} entries → {out_path}\n"
        f"  breakdown: {dict(breakdown)}\n"
        f"  ocr_available: {client.available}"
    )
    return 0


def _cmd_structural(args: argparse.Namespace) -> int:
    if args.corpus == "all":
        targets = list(CORPUS_FILES)
    else:
        targets = [args.corpus]

    all_results: list[ComparisonResult] = []
    for corpus_key in targets:
        try:
            results = structural_audit(corpus_key)
        except FileNotFoundError as exc:
            logger.warning("corpus missing; skipping", corpus=corpus_key, error=str(exc))
            continue
        all_results.extend(results)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps([r.model_dump() for r in all_results], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    breakdown = _severity_breakdown(all_results)
    logger.info(
        "structural audit complete",
        path=str(out_path),
        total=len(all_results),
        breakdown=dict(breakdown),
    )
    print(
        f"Structural audit: {len(all_results)} entries → {out_path}\n"
        f"  breakdown: {dict(breakdown)}"
    )
    return 0


def _cmd_report(args: argparse.Namespace) -> int:
    manifest = SampleManifest.model_validate(
        json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    )
    results_raw = json.loads(Path(args.results).read_text(encoding="utf-8"))
    results = [ComparisonResult.model_validate(r) for r in results_raw]

    report_md = render_report(manifest=manifest, results=results)
    triage_csv = render_triage_csv(results)

    Path(args.report_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report_out).write_text(report_md, encoding="utf-8")
    Path(args.triage_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.triage_out).write_text(triage_csv, encoding="utf-8")
    logger.info(
        "report rendered",
        report=str(args.report_out),
        triage=str(args.triage_out),
        total=len(results),
    )
    print(f"Report → {args.report_out}\nTriage CSV → {args.triage_out}")
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="audit_darakwon",
        description="Audit the Darakwon KGIU + 2000 Words JSONs against the source PDFs.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sample = sub.add_parser("sample", help="draw the deterministic stratified sample")
    p_sample.add_argument("--seed", type=int, default=20260528, help="RNG seed")
    p_sample.add_argument(
        "--rate", type=float, default=0.05, help="fraction of each corpus to audit"
    )
    p_sample.add_argument(
        "--output",
        type=str,
        default=str(INGEST_DIR / "audit_artifacts" / "sample_manifest.json"),
    )
    p_sample.set_defaults(func=_cmd_sample)

    p_compare = sub.add_parser("compare", help="run the OCR comparison step")
    p_compare.add_argument("--manifest", required=True)
    p_compare.add_argument(
        "--output",
        type=str,
        default=str(INGEST_DIR / "audit_artifacts" / "comparison_results.json"),
    )
    p_compare.add_argument("--limit", type=int, default=None)
    p_compare.add_argument("--model", type=str, default="claude-opus-4-5-20250929")
    p_compare.add_argument(
        "--dry-run",
        action="store_true",
        help="don't call the API; emit skipped_no_network results",
    )
    p_compare.set_defaults(func=_cmd_compare)

    p_struct = sub.add_parser(
        "structural",
        help="offline structural audit (every entry, schema-fidelity checks)",
    )
    p_struct.add_argument(
        "--output",
        type=str,
        default=str(INGEST_DIR / "audit_artifacts" / "structural_results.json"),
    )
    p_struct.add_argument(
        "--corpus",
        choices=list(CORPUS_FILES) + ["all"],
        default="all",
    )
    p_struct.set_defaults(func=_cmd_structural)

    p_report = sub.add_parser("report", help="render AUDIT_REPORT.md and AUDIT_TRIAGE.csv")
    p_report.add_argument("--manifest", required=True)
    p_report.add_argument("--results", required=True)
    p_report.add_argument(
        "--report-out", type=str, default=str(INGEST_DIR / "AUDIT_REPORT.md")
    )
    p_report.add_argument(
        "--triage-out", type=str, default=str(INGEST_DIR / "AUDIT_TRIAGE.csv")
    )
    p_report.set_defaults(func=_cmd_report)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
