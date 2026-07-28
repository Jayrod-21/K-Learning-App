"""transcript_ocr tests — the Vision HTTP call and the pdftoppm render are
monkeypatched at their module boundaries (``urllib.request.urlopen`` /
``subprocess.run``); no network, no poppler, no real API key.
"""

from __future__ import annotations

import base64
import http.client
import json
import logging
import subprocess
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.ingest.topik_audio import transcript_ocr as mod
from tools.ingest.topik_audio.transcript_ocr import ocr_transcript_pdf

_KEY = "test-key"


@pytest.fixture(autouse=True)
def _api_key(monkeypatch):
    """Every test starts WITH a key; the no-key tests delete it."""
    monkeypatch.setenv(mod.API_KEY_ENV, _KEY)


@pytest.fixture(autouse=True)
def _instant_retry(monkeypatch) -> list[float]:
    """Replace the pre-retry backoff sleep with a recorder — the suite must
    stay instant, and tests can assert the backoff actually fired."""
    sleeps: list[float] = []
    monkeypatch.setattr(mod, "_sleep", sleeps.append)
    return sleeps


@pytest.fixture()
def pdf(tmp_path) -> Path:
    path = tmp_path / "91st-TOPIK-II-Listening-Transcript.pdf"
    path.write_bytes(b"%PDF-1.4 fake image-only scan")
    return path


@pytest.fixture()
def cache_dir(tmp_path) -> Path:
    return tmp_path / "cache"


# ---------------------------------------------------------------------------
# Fakes.
# ---------------------------------------------------------------------------


def _install_fake_pdftoppm(monkeypatch, *, n_pages: int) -> list[list[str]]:
    """subprocess.run fake that 'renders' n_pages PNGs at the pdftoppm
    prefix (distinct bytes per page, so the request-shape test can tie a
    page's upload back to its file)."""
    commands: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        commands.append(list(cmd))
        prefix = Path(cmd[-1])
        for i in range(1, n_pages + 1):
            prefix.with_name(f"{prefix.name}-{i:02d}.png").write_bytes(
                b"PNG-page-%d" % i
            )
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    return commands


class _FakeHTTPResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _ExplodingReadResponse:
    """Context-managed response whose ``read()`` raises mid-body — the
    IncompleteRead-during-``resp.read()`` transport failure."""

    def __init__(self, exc: Exception):
        self._exc = exc

    def read(self) -> bytes:
        raise self._exc

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeVision:
    """Scripted ``urlopen``: each call pops the next response — a Vision
    per-image response dict, an Exception instance to raise, or a pre-built
    response object (e.g. ``_ExplodingReadResponse``)."""

    def __init__(self, script: list):
        self.script = list(script)
        self.requests: list = []

    def __call__(self, req, timeout=None):
        self.requests.append((req, timeout))
        assert self.script, "unexpected extra Vision call"
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        if hasattr(item, "read"):
            return item
        return _FakeHTTPResponse(json.dumps({"responses": [item]}).encode("utf-8"))


def _page(text: str) -> dict:
    return {"fullTextAnnotation": {"text": text}}


def _install_fake_vision(monkeypatch, script: list) -> _FakeVision:
    fake = _FakeVision(script)
    monkeypatch.setattr(mod.urllib.request, "urlopen", fake)
    return fake


def _forbid_vision(monkeypatch) -> None:
    def bomb(*a, **k):
        raise AssertionError("Vision must not be called")

    monkeypatch.setattr(mod.urllib.request, "urlopen", bomb)


# ---------------------------------------------------------------------------
# Happy path + the proven request shape.
# ---------------------------------------------------------------------------


def test_pages_ocred_concatenated_and_cached(monkeypatch, pdf, cache_dir) -> None:
    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    vision = _install_fake_vision(
        monkeypatch, [_page("1. 페이지 하나"), _page("2. 페이지 둘")]
    )
    text = ocr_transcript_pdf(pdf, cache_dir=cache_dir)
    assert text == "1. 페이지 하나\n2. 페이지 둘"
    assert len(vision.requests) == 2
    cached = list(cache_dir.glob("*.ocr.txt"))
    assert len(cached) == 1
    assert cached[0].read_text(encoding="utf-8") == text
    # sha256 cache key + atomic write: no tmp residue.
    assert len(cached[0].name) == len("a" * 64 + ".ocr.txt")
    assert not list(cache_dir.glob("*.tmp"))


def test_request_matches_proven_vision_call(monkeypatch, pdf, cache_dir) -> None:
    # The exact call validated end-to-end on 91-II: DOCUMENT_TEXT_DETECTION,
    # Korean hint, base64 PNG content, key in the X-Goog-Api-Key header
    # (NEVER the URL — no URL-derived exception can embed it), JSON content
    # type.
    commands = _install_fake_pdftoppm(monkeypatch, n_pages=1)
    vision = _install_fake_vision(monkeypatch, [_page("본문")])
    ocr_transcript_pdf(pdf, cache_dir=cache_dir)

    (cmd,) = commands
    assert cmd[:4] == ["pdftoppm", "-r", "200", "-png"]
    assert cmd[4] == str(pdf)

    ((req, timeout),) = vision.requests
    assert req.full_url == mod.VISION_ENDPOINT
    assert _KEY not in req.full_url
    assert req.headers["X-goog-api-key"] == _KEY  # urllib capitalizes keys
    assert timeout == 90
    assert req.headers["Content-type"] == "application/json"
    (request,) = json.loads(req.data.decode("utf-8"))["requests"]
    assert request["features"] == [{"type": "DOCUMENT_TEXT_DETECTION"}]
    assert request["imageContext"] == {"languageHints": ["ko"]}
    assert base64.b64decode(request["image"]["content"]) == b"PNG-page-1"


def test_blank_page_yields_empty_text_not_skip(monkeypatch, pdf, cache_dir) -> None:
    # A response WITHOUT fullTextAnnotation is a valid "no text" page.
    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    _install_fake_vision(monkeypatch, [{}, _page("둘째 페이지")])
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == "\n둘째 페이지"


# ---------------------------------------------------------------------------
# Cache: written once, reused without HTTP (even key-less).
# ---------------------------------------------------------------------------


def test_second_call_serves_cache_without_http(monkeypatch, pdf, cache_dir) -> None:
    _install_fake_pdftoppm(monkeypatch, n_pages=1)
    _install_fake_vision(monkeypatch, [_page("캐시될 본문")])
    first = ocr_transcript_pdf(pdf, cache_dir=cache_dir)

    _forbid_vision(monkeypatch)  # any further HTTP fails the test
    monkeypatch.setattr(
        mod.subprocess,
        "run",
        lambda *a, **k: pytest.fail("pdftoppm must not run on a cache hit"),
    )
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == first == "캐시될 본문"


def test_cache_hit_works_without_api_key(monkeypatch, pdf, cache_dir) -> None:
    # An already-OCR'd paper must still validate on a key-less machine.
    _install_fake_pdftoppm(monkeypatch, n_pages=1)
    _install_fake_vision(monkeypatch, [_page("본문")])
    ocr_transcript_pdf(pdf, cache_dir=cache_dir)

    monkeypatch.delenv(mod.API_KEY_ENV)
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == "본문"


def test_reexported_pdf_misses_cache(monkeypatch, pdf, cache_dir) -> None:
    # Different bytes -> different sha256 -> fresh OCR, old cache untouched.
    _install_fake_pdftoppm(monkeypatch, n_pages=1)
    _install_fake_vision(monkeypatch, [_page("첫 내보내기")])
    ocr_transcript_pdf(pdf, cache_dir=cache_dir)

    pdf.write_bytes(b"%PDF-1.4 re-exported different bytes")
    _install_fake_vision(monkeypatch, [_page("재내보내기")])
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == "재내보내기"
    assert len(list(cache_dir.glob("*.ocr.txt"))) == 2


# ---------------------------------------------------------------------------
# Graceful degradation: no key / no binary / render failure / absent PDF.
# ---------------------------------------------------------------------------


def test_missing_api_key_returns_none_without_any_work(
    monkeypatch, pdf, cache_dir
) -> None:
    monkeypatch.delenv(mod.API_KEY_ENV)
    _forbid_vision(monkeypatch)
    monkeypatch.setattr(
        mod.subprocess,
        "run",
        lambda *a, **k: pytest.fail("pdftoppm must not run without a key"),
    )
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None
    assert not cache_dir.exists()


def test_blank_api_key_is_missing(monkeypatch, pdf, cache_dir) -> None:
    monkeypatch.setenv(mod.API_KEY_ENV, "   ")
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None


def test_pdftoppm_not_installed_returns_none(monkeypatch, pdf, cache_dir) -> None:
    def raise_missing(*a, **k):
        raise FileNotFoundError("pdftoppm")

    monkeypatch.setattr(mod.subprocess, "run", raise_missing)
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None


def test_pdftoppm_timeout_returns_none(monkeypatch, pdf, cache_dir) -> None:
    def raise_timeout(cmd, **k):
        raise subprocess.TimeoutExpired(cmd, 300)

    monkeypatch.setattr(mod.subprocess, "run", raise_timeout)
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None


def test_pdftoppm_nonzero_exit_returns_none(monkeypatch, pdf, cache_dir) -> None:
    monkeypatch.setattr(
        mod.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=1, stdout=b"", stderr=b"corrupt"),
    )
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None


def test_render_producing_no_pages_returns_none(monkeypatch, pdf, cache_dir) -> None:
    _install_fake_pdftoppm(monkeypatch, n_pages=0)
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None


def test_absent_pdf_returns_none(monkeypatch, tmp_path, cache_dir) -> None:
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(tmp_path / "nope.pdf", cache_dir=cache_dir) is None


# ---------------------------------------------------------------------------
# Per-page errors: one retry, then skip — never abort the PDF.
# ---------------------------------------------------------------------------


def test_page_api_error_retried_once_then_skipped(
    monkeypatch, pdf, cache_dir, _instant_retry
) -> None:
    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    err = {"error": {"code": 429, "message": "rate limited"}}
    vision = _install_fake_vision(
        monkeypatch, [err, err, _page("살아남은 페이지")]  # p1 twice, p2 once
    )
    text = ocr_transcript_pdf(pdf, cache_dir=cache_dir)
    assert text == "살아남은 페이지"
    assert len(vision.requests) == 3
    assert _instant_retry == [mod._RETRY_BACKOFF_SEC]  # backed off before retry
    # The partial (good-pages-only) text is RETURNED for this run but NOT
    # cached — the next run must be free to retry the whole PDF.
    assert not list(cache_dir.glob("*.ocr.txt"))


def test_transient_error_retry_recovers_the_page(monkeypatch, pdf, cache_dir) -> None:
    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    vision = _install_fake_vision(
        monkeypatch,
        [urllib.error.URLError("connection reset"), _page("첫 페이지"), _page("둘째 페이지")],
    )
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == "첫 페이지\n둘째 페이지"
    assert len(vision.requests) == 3


def test_partial_result_not_cached_next_run_retries_whole_pdf(
    monkeypatch, pdf, cache_dir
) -> None:
    # Run 1: page 2 fails both attempts -> partial text returned, NOT cached.
    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    _install_fake_vision(
        monkeypatch,
        [_page("첫 페이지"), urllib.error.URLError("down"), urllib.error.URLError("down")],
    )
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == "첫 페이지"
    assert not list(cache_dir.glob("*.ocr.txt"))
    # Run 2 (API healthy): the WHOLE PDF is re-OCR'd — both pages requested —
    # and the now-complete result is cached.
    vision2 = _install_fake_vision(monkeypatch, [_page("첫 페이지"), _page("둘째 페이지")])
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == "첫 페이지\n둘째 페이지"
    assert len(vision2.requests) == 2
    (cached,) = cache_dir.glob("*.ocr.txt")
    assert cached.read_text(encoding="utf-8") == "첫 페이지\n둘째 페이지"


def test_mid_read_http_exception_is_page_skip_not_escape(
    monkeypatch, pdf, cache_dir
) -> None:
    # An IncompleteRead DURING resp.read() must be a per-page skip (with
    # retry), never an exception escaping ocr_transcript_pdf.
    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    vision = _install_fake_vision(
        monkeypatch,
        [
            _ExplodingReadResponse(http.client.IncompleteRead(b"partial body")),
            _ExplodingReadResponse(http.client.IncompleteRead(b"partial body")),
            _page("살아남은 페이지"),
        ],
    )
    text = ocr_transcript_pdf(pdf, cache_dir=cache_dir)
    assert text == "살아남은 페이지"
    assert len(vision.requests) == 3
    assert not list(cache_dir.glob("*.ocr.txt"))  # partial -> not cached


def test_cache_write_oserror_still_returns_text(monkeypatch, pdf, tmp_path) -> None:
    # cache_dir path occupied by a FILE -> mkdir raises OSError -> the
    # paid-for Vision text is still served (uncached) for this run.
    blocked = tmp_path / "cache-blocked"
    blocked.write_text("not a directory", encoding="utf-8")
    _install_fake_pdftoppm(monkeypatch, n_pages=1)
    _install_fake_vision(monkeypatch, [_page("본문")])
    assert ocr_transcript_pdf(pdf, cache_dir=blocked) == "본문"


def test_all_pages_erroring_returns_none_and_caches_nothing(
    monkeypatch, pdf, cache_dir
) -> None:
    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    vision = _install_fake_vision(
        monkeypatch, [urllib.error.URLError("down")] * 4  # 2 pages x 2 attempts
    )
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None
    assert len(vision.requests) == 4
    assert not list(cache_dir.glob("*.ocr.txt"))


# ---------------------------------------------------------------------------
# The key never leaks: not in the URL, not in any log record, not on
# stdout/stderr — across EVERY error path.
# ---------------------------------------------------------------------------


def test_api_key_never_logged_on_error_paths(
    monkeypatch, pdf, cache_dir, caplog, capsys
) -> None:
    secret = "AIzaSy-SECRET-DO-NOT-LOG"
    monkeypatch.setenv(mod.API_KEY_ENV, secret)
    _install_fake_pdftoppm(monkeypatch, n_pages=4)
    # 4 pages x 2 attempts, one error family per page: in-band {"error"},
    # URLError + HTTPError, InvalidURL, HTTPException mid-read. Post-fix the
    # URL carries no key, so none of these exception strings can embed it.
    _install_fake_vision(
        monkeypatch,
        [
            {"error": {"code": 403, "message": "API key not valid"}},
            {"error": {"code": 403, "message": "API key not valid"}},
            urllib.error.URLError("connection reset"),
            urllib.error.HTTPError(mod.VISION_ENDPOINT, 429, "rate limited", None, None),
            http.client.InvalidURL(f"nonnumeric port: {mod.VISION_ENDPOINT}"),
            http.client.InvalidURL(f"nonnumeric port: {mod.VISION_ENDPOINT}"),
            _ExplodingReadResponse(http.client.IncompleteRead(b"partial")),
            _ExplodingReadResponse(http.client.IncompleteRead(b"partial")),
        ],
    )
    with caplog.at_level(logging.DEBUG):
        assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None
    captured = capsys.readouterr()
    # The error paths really fired (structlog's default logger prints to
    # stdout) — the assertions below are not vacuous.
    assert "transcript_ocr_page_api_error" in captured.out
    assert "transcript_ocr_page_request_failed" in captured.out
    assert "transcript_ocr_all_pages_failed" in captured.out
    for stream in (captured.out, captured.err, caplog.text):
        assert secret not in stream


def test_graceful_paths_log_promised_event_names(
    monkeypatch, pdf, cache_dir, capsys
) -> None:
    # The docstring promises DISTINCT events per failure cause — pin the
    # names operators will grep for.
    monkeypatch.delenv(mod.API_KEY_ENV)
    _forbid_vision(monkeypatch)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None
    assert "transcript_ocr_no_api_key" in capsys.readouterr().out

    monkeypatch.setenv(mod.API_KEY_ENV, _KEY)

    def raise_timeout(cmd, **k):
        raise subprocess.TimeoutExpired(cmd, 300)

    monkeypatch.setattr(mod.subprocess, "run", raise_timeout)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None
    assert "transcript_ocr_render_timeout" in capsys.readouterr().out

    _install_fake_pdftoppm(monkeypatch, n_pages=2)
    _install_fake_vision(
        monkeypatch,
        [
            urllib.error.URLError("down"),
            urllib.error.URLError("down"),
            _page("살아남은 페이지"),
        ],
    )
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) == "살아남은 페이지"
    out = capsys.readouterr().out
    assert "transcript_ocr_page_skipped" in out
    assert "transcript_ocr_partial_not_cached" in out


def test_malformed_response_body_is_a_page_error(monkeypatch, pdf, cache_dir) -> None:
    class _Garbage:
        def read(self):
            return b"not json"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        return _Garbage()

    _install_fake_pdftoppm(monkeypatch, n_pages=1)
    monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
    assert ocr_transcript_pdf(pdf, cache_dir=cache_dir) is None
    assert calls["n"] == 2  # retried once, then the only page skipped
