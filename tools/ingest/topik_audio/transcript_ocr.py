"""Google Vision OCR fallback for IMAGE-ONLY transcript PDFs.

10 of the 22 transcript PDFs (papers 64/83/91/96/102, both levels) are
image-only scans whose ``pdftotext`` dump is empty — ``transcript_pdf``
deliberately stays network-free, so the OCR fallback lives HERE and the
runner wires the two together: when ``parse_transcript_pdf`` comes back
empty for a PDF that exists, this module renders its pages with
``pdftoppm`` (poppler, the same package as pdftotext) and OCRs each page
with Google Vision ``DOCUMENT_TEXT_DETECTION`` (Korean language hint) —
the exact call proven end-to-end on 91-II (26 pages -> 50 items parsed).
The concatenated raw text then goes through the SAME pure
``parse_transcript_text`` as a text-PDF dump.

The HTTP call uses stdlib ``urllib`` — no new Python dependency, matching
``tools/ingest/reading_ocr/vision_ocr_book.py`` (same endpoint, same
``GOOGLE_VISION_API_KEY`` env var, same 90s timeout + transient retry).

Caching/degradation contract:

  * the concatenated raw text is cached by the PDF's sha256
    (``cache_dir/<sha256>.ocr.txt``, atomic tmp + ``os.replace`` like
    ``transcribe.py``) — a re-run never re-pays Vision, and a cached
    result is served even when the key is no longer in the environment;
  * only a COMPLETE result (zero skipped pages) is cached — a partial
    one is returned for the current run but NOT cached, so the next run
    retries the whole PDF instead of trusting frozen incomplete text;
  * :func:`ocr_transcript_pdf` returns ``None`` (never raises) when it
    CANNOT OCR — no API key, pdftoppm missing/failed, or every page
    errored — each cause logged distinctly, and the runner falls back to
    DB stems exactly as for an absent PDF;
  * a single page's Vision error/timeout is retried once (after a short
    backoff) then SKIPPED (logged) — one bad page must not discard 25
    good ones for THIS run.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import structlog

from .transcribe import sha256_file

logger = structlog.get_logger(__name__)

VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
API_KEY_ENV = "GOOGLE_VISION_API_KEY"

_VISION_TIMEOUT_SEC = 90
_PDFTOPPM_TIMEOUT_SEC = 300
_RENDER_DPI = 200
# Pause before the single per-page retry — an immediate retry against a 429
# burst deterministically fails both attempts; a short backoff lets it clear.
_RETRY_BACKOFF_SEC = 2.0

# Module-level alias so tests can inject an instant fake.
_sleep = time.sleep


def _render_pdf_pages(pdf_path: Path, work_dir: Path) -> list[Path] | None:
    """Render the PDF to per-page PNGs via ``pdftoppm``; ``None`` on failure.

    ``pdftoppm -r 200 -png <pdf> <work_dir>/pg`` writes ``pg-01.png``,
    ``pg-02.png``, ... — the sorted glob IS the page order (poppler
    zero-pads the page index).
    """
    prefix = work_dir / "pg"
    try:
        proc = subprocess.run(
            ["pdftoppm", "-r", str(_RENDER_DPI), "-png", str(pdf_path), str(prefix)],
            capture_output=True,
            timeout=_PDFTOPPM_TIMEOUT_SEC,
            check=False,
        )
    except FileNotFoundError:
        logger.warning("pdftoppm_not_installed", path=str(pdf_path))
        return None
    except subprocess.TimeoutExpired:
        logger.warning("transcript_ocr_render_timeout", path=str(pdf_path))
        return None
    if proc.returncode != 0:
        logger.warning(
            "transcript_ocr_render_failed",
            path=str(pdf_path),
            returncode=proc.returncode,
            stderr=proc.stderr.decode("utf-8", errors="replace")[:500],
        )
        return None
    pages = sorted(work_dir.glob("pg-*.png"))
    if not pages:
        logger.warning("transcript_ocr_render_no_pages", path=str(pdf_path))
        return None
    return pages


def _vision_ocr_page(png_path: Path, api_key: str) -> str | None:
    """One Vision ``DOCUMENT_TEXT_DETECTION`` call for one rendered page.

    Returns the page's full text ("" when Vision finds none) or ``None``
    on any error — transport failure, timeout, mid-read failure, malformed
    response, or an in-band ``{"error": ...}`` — so the caller can
    retry/skip. The API key travels ONLY in the ``X-Goog-Api-Key`` request
    header, never in the URL — so no URL-derived exception string (e.g.
    ``http.client.InvalidURL``) can embed it — and is never logged.
    """
    body = json.dumps(
        {
            "requests": [
                {
                    "image": {
                        "content": base64.b64encode(png_path.read_bytes()).decode("ascii")
                    },
                    "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                    "imageContext": {"languageHints": ["ko"]},
                }
            ]
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        VISION_ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=_VISION_TIMEOUT_SEC) as resp_fh:
            response = json.loads(resp_fh.read())["responses"][0]
    except (
        urllib.error.URLError,  # HTTPError subclasses this; DNS/conn refusal too
        http.client.HTTPException,  # e.g. IncompleteRead mid-``read()``
        TimeoutError,
        OSError,
        json.JSONDecodeError,
        KeyError,
        IndexError,
        TypeError,
    ) as exc:
        logger.warning(
            "transcript_ocr_page_request_failed",
            page=png_path.name,
            error=f"{type(exc).__name__}: {exc}"[:300],
        )
        return None
    if not isinstance(response, dict):
        logger.warning("transcript_ocr_page_bad_response", page=png_path.name)
        return None
    if "error" in response:
        logger.warning(
            "transcript_ocr_page_api_error",
            page=png_path.name,
            error=json.dumps(response["error"], ensure_ascii=False)[:300],
        )
        return None
    annotation = response.get("fullTextAnnotation")
    if not isinstance(annotation, dict):
        return ""  # a valid response for a blank page — no text detected
    return str(annotation.get("text", ""))


def _load_cached(cache_path: Path) -> str | None:
    """Cached concatenated OCR text, or ``None`` when absent/unreadable.

    The cache stores only COMPLETE, successful Vision results — every
    page OCR'd, zero skipped (keyed by the PDF's sha256, so a re-exported
    PDF re-OCRs) — an unreadable file is reported and rebuilt, never
    trusted.
    """
    if not cache_path.is_file():
        return None
    try:
        return cache_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning(
            "transcript_ocr_cache_unreadable", path=str(cache_path), error=str(exc)
        )
        return None


def ocr_transcript_pdf(pdf_path: Path, *, cache_dir: Path) -> str | None:
    """OCR an image-only transcript PDF into raw text (or ``None``).

    Renders pages with ``pdftoppm``, Vision-OCRs each (one backed-off
    retry per page, then skip), concatenates page texts with ``"\\n"``,
    and caches the result by the PDF's sha256 — the cache is checked
    BEFORE the API key so an already-OCR'd paper still validates on a
    key-less machine. Only a COMPLETE result (zero skipped pages) is
    cached: a partial one is returned for this run but the next run
    retries the whole PDF. Returns ``None`` whenever no OCR text could be
    produced; never raises for the expected failure modes (the transcript
    is a QA signal the pipeline must survive without).
    """
    if not pdf_path.is_file():
        logger.info("transcript_ocr_pdf_absent", path=str(pdf_path))
        return None
    try:
        pdf_sha256 = sha256_file(pdf_path)
    except OSError as exc:
        logger.warning("transcript_ocr_hash_failed", path=str(pdf_path), error=str(exc))
        return None
    cache_path = Path(cache_dir) / f"{pdf_sha256}.ocr.txt"
    cached = _load_cached(cache_path)
    if cached is not None:
        logger.info(
            "transcript_ocr_cache_hit", pdf=str(pdf_path), sha256=pdf_sha256
        )
        return cached

    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        logger.warning(
            "transcript_ocr_no_api_key", path=str(pdf_path), env=API_KEY_ENV
        )
        return None

    with tempfile.TemporaryDirectory(prefix="topik_transcript_ocr_") as tmp:
        pages = _render_pdf_pages(pdf_path, Path(tmp))
        if pages is None:
            return None
        page_texts: list[str] = []
        skipped = 0
        for png in pages:
            text = _vision_ocr_page(png, api_key)
            if text is None:  # transient? — back off, exactly one retry, then skip
                _sleep(_RETRY_BACKOFF_SEC)
                text = _vision_ocr_page(png, api_key)
            if text is None:
                skipped += 1
                logger.warning(
                    "transcript_ocr_page_skipped", pdf=str(pdf_path), page=png.name
                )
                continue
            page_texts.append(text)

    if not page_texts:
        logger.warning(
            "transcript_ocr_all_pages_failed", pdf=str(pdf_path), pages=skipped
        )
        return None

    full_text = "\n".join(page_texts)
    if skipped:
        # Partial result: RETURN it for this run (one bad page must not
        # discard the good pages), but NEVER cache it — a cached partial
        # would be frozen under the PDF's sha256 and silently poison every
        # later run; leaving the cache empty lets the next run retry the
        # whole PDF.
        logger.warning(
            "transcript_ocr_partial_not_cached",
            pdf=str(pdf_path),
            pages_ok=len(page_texts),
            pages_skipped=skipped,
        )
        return full_text
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        # pid-suffixed tmp + os.replace: same atomic-write stance as the
        # transcribe cache — an interrupted run never leaves a half-written
        # cache for the next run to trust.
        tmp_path = cache_path.with_name(f"{cache_path.name}.{os.getpid()}.tmp")
        tmp_path.write_text(full_text, encoding="utf-8")
        os.replace(tmp_path, cache_path)
    except OSError as exc:
        # Disk trouble must not discard paid-for Vision text — serve it
        # uncached this run; the next run simply re-OCRs.
        logger.warning(
            "transcript_ocr_cache_write_failed",
            path=str(cache_path),
            error=str(exc),
        )
    logger.info(
        "transcript_ocr_done",
        pdf=str(pdf_path),
        pages_ok=len(page_texts),
        pages_skipped=skipped,
        chars=len(full_text),
    )
    return full_text
