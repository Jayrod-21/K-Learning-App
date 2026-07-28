"""Tuned faster-whisper transcription of one whole-section listening MP3.

The engine import is LAZY (inside ``_get_model``) — exactly the
``tools/audio_stt/whisper_transcribe.py`` stance — so importing this module,
and running the whole test suite, never requires faster-whisper or a GPU:
tests monkeypatch ``sys.modules['faster_whisper']`` and exercise the pure
mapping (:func:`_map_segments`) directly.

TUNED SETTINGS (Phase-2a proven — these eliminated the "you you you"
hallucination runaway on quiet/instruction sections; keep them together):
    word_timestamps=True                    anchors need word-level times
    vad_filter=True, min_silence_duration_ms=500
    condition_on_previous_text=False        stops hallucination feedback loops
    no_speech_threshold=0.6
    language="ko"

Output/caching contract: the per-paper transcript dict is
``{audio_sha256, duration_ms, segments: [{n, s, e, text, words: [{s, e, w}]}]}``
(all times int ms) and is cached in ``cache_dir/<sha256>.json``. A re-run
whose MP3 hashes to the same sha256 returns the cached transcript without
touching the engine — the CLI's idempotency hinge.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterable

import structlog

from tools.audio_stt.whisper_transcribe import resolve_device

logger = structlog.get_logger(__name__)

# One WhisperModel per resolved config for the life of the process (a
# multi-GB load — see tools/audio_stt/whisper_transcribe._MODEL_CACHE for the
# rationale; duplicated rather than imported because that cache is private to
# the worker and the two callers must be free to evolve independently).
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}


def _get_model(model_size: str, device: str, compute_type: str) -> Any:
    """Memoized WhisperModel for a RESOLVED config; lazy engine import."""
    key = (model_size, device, compute_type)
    model = _MODEL_CACHE.get(key)
    if model is None:
        from faster_whisper import WhisperModel  # noqa: PLC0415 — lazy by design

        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        _MODEL_CACHE[key] = model
    return model


def _tuned_transcribe_kwargs() -> dict[str, Any]:
    """The Phase-2a-proven anti-hallucination settings, built fresh per call
    (``vad_parameters`` is mutable — never share it as a module constant)."""
    return {
        "language": "ko",
        "word_timestamps": True,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 500},
        "condition_on_previous_text": False,
        "no_speech_threshold": 0.6,
    }


def sha256_file(path: Path) -> str:
    """Chunked sha256 of a file — the transcript cache key and the artifact's
    drift guard (the Phase-3 loader refuses a JSON whose hash mismatches)."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _map_segments(raw_segments: Iterable[Any]) -> list[dict]:
    """Map faster-whisper segment objects to the transcript-dict shape.

    Pure — unit-tested without the engine. Float seconds are rounded to int
    ms; a negative start clamps to 0 and a rounding inversion clamps to
    ``e >= s`` (words likewise). Segments whose text strips to empty (VAD
    silence artifacts) are dropped and the survivors renumbered 1..N.
    """
    out: list[dict] = []
    for seg in raw_segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        start_ms = max(0, round(float(seg.start) * 1000))
        end_ms = max(start_ms, round(float(seg.end) * 1000))
        words = []
        for word in seg.words or []:
            w_start = max(0, round(float(word.start) * 1000))
            w_end = max(w_start, round(float(word.end) * 1000))
            words.append({"s": w_start, "e": w_end, "w": word.word})
        out.append(
            {
                "n": len(out) + 1,
                "s": start_ms,
                "e": end_ms,
                "text": text,
                "words": words,
            }
        )
    return out


def _load_cached(cache_path: Path, audio_sha256: str) -> dict | None:
    """Return the cached transcript when it exists AND matches the MP3's
    hash; a corrupt/mismatched cache file is reported and rebuilt, never
    trusted."""
    if not cache_path.is_file():
        return None
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("transcript_cache_unreadable", path=str(cache_path), error=str(exc))
        return None
    if (
        isinstance(cached, dict)
        and cached.get("audio_sha256") == audio_sha256
        and isinstance(cached.get("duration_ms"), int)
        and isinstance(cached.get("segments"), list)
    ):
        return cached
    logger.warning("transcript_cache_mismatch", path=str(cache_path))
    return None


def transcribe_paper(
    audio_path: Path,
    *,
    cache_dir: Path,
    model_size: str = "large-v3",
    device: str = "auto",
    compute_type: str = "auto",
) -> dict:
    """Transcribe one paper's MP3 (or return its cached transcript).

    The cache key is the MP3's sha256 — a renamed/moved file still hits its
    cache; a re-exported file (different bytes) correctly re-transcribes.
    The cache write is atomic (tmp + ``os.replace``) so an interrupted run
    never leaves a half-written transcript for the next run to trust.
    """
    if not audio_path.is_file():
        raise FileNotFoundError(f"audio file not found: {audio_path}")
    audio_sha256 = sha256_file(audio_path)
    cache_path = Path(cache_dir) / f"{audio_sha256}.json"

    cached = _load_cached(cache_path, audio_sha256)
    if cached is not None:
        logger.info("transcript_cache_hit", audio=str(audio_path), sha256=audio_sha256)
        return cached

    resolved_device, resolved_compute = resolve_device(device, compute_type)
    model = _get_model(model_size, resolved_device, resolved_compute)
    logger.info(
        "transcribe_start",
        audio=str(audio_path),
        model=model_size,
        device=resolved_device,
        compute=resolved_compute,
    )
    # segments is a lazy generator — _map_segments drains it, which is when
    # the actual transcription compute happens.
    segments, info = model.transcribe(str(audio_path), **_tuned_transcribe_kwargs())
    transcript = {
        "audio_sha256": audio_sha256,
        "duration_ms": round(float(info.duration) * 1000),
        "segments": _map_segments(segments),
    }

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    # pid-suffixed tmp: two concurrent runs over the same MP3 must not
    # interleave writes into ONE tmp file (os.replace itself is atomic).
    tmp_path = cache_path.with_name(f"{cache_path.name}.{os.getpid()}.tmp")
    tmp_path.write_text(
        json.dumps(transcript, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    os.replace(tmp_path, cache_path)
    logger.info(
        "transcribe_done",
        audio=str(audio_path),
        segments=len(transcript["segments"]),
        duration_ms=transcript["duration_ms"],
    )
    return transcript
