"""faster-whisper (CTranslate2) transcribes owned audio; this maps engine
output to the 075 segment schema — copyright-clean mechanical transcription.

The engine import is LAZY (inside ``transcribe``): the worker's tests inject
a fake transcribe function and the mapping tests monkeypatch ``sys.modules``,
so neither faster-whisper nor a GPU is ever required to run the suite —
the same stance as the server tests' always-stubbed Claude proxy.

Output contract (what ``audio_transcript_segments`` — migration 075 —
enforces, re-checked HERE so a bad engine run fails at the boundary, not as
a mid-transaction CHECK violation):
  - ordered dicts {"segment_number", "start_ms", "end_ms", "body"};
  - segment_number 1..N, gap-free AFTER filtering (blank segments are
    dropped, and the survivors renumbered — the DB's UNIQUE(track_id,
    segment_number) upsert key must see a dense sequence);
  - start_ms >= 0, end_ms >= start_ms (Whisper's float seconds are rounded
    to int ms; a rounding inversion is clamped — 075 allows zero-length
    segments but never negative-length ones);
  - body stripped, 1..5000 chars (whitespace-only segments dropped — 075's
    CHECK requires length >= 1; an implausibly long body is truncated
    defensively rather than aborting the whole track).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, TypedDict

# 075's ck_audio_transcript_segments_body_length upper bound. A real Whisper
# segment is a phrase (tens of chars); this is a defensive ceiling, not an
# expected case.
MAX_SEGMENT_BODY_CHARS = 5000


class Segment(TypedDict):
    """One 075-shaped transcript segment — the worker's INSERT source. A
    TypedDict (not a dataclass) because the persist path subscripts by key
    and tests compare against plain dict literals."""

    segment_number: int
    start_ms: int
    end_ms: int
    body: str


# Loaded WhisperModel instances, keyed on (model_size, resolved_device,
# resolved_compute). A WhisperModel is a multi-GB disk -> device load (tens
# of seconds for large-v3, plus VRAM churn) — rebuilding it per job would
# dominate a sequential queue drain, so the worker reuses one instance per
# configuration for the life of the process. A plain dict (not an LRU): the
# worker runs exactly one config; the explicit key just keeps a mid-process
# config change correct.
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}


def _get_model(model_size: str, device: str, compute_type: str) -> Any:
    """Return the memoized WhisperModel for a RESOLVED (device/compute)
    config, building it on first use. faster_whisper is imported HERE —
    inside the builder, never at module import time — so importing this
    module (and running the whole test suite) stays engine-free."""
    key = (model_size, device, compute_type)
    model = _MODEL_CACHE.get(key)
    if model is None:
        from faster_whisper import WhisperModel  # noqa: PLC0415 — lazy by design

        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        _MODEL_CACHE[key] = model
    return model


def map_engine_segments(raw_segments: Iterable[Any]) -> list[Segment]:
    """Map faster-whisper segment objects (``.start``/``.end`` float seconds,
    ``.text``) to 075-shaped dicts. Pure — unit-tested without the engine.
    """
    out: list[Segment] = []
    number = 0
    for seg in raw_segments:
        body = (seg.text or "").strip()
        if not body:
            # 075 CHECK: length(body) >= 1. Whisper emits empty/whitespace
            # segments on silence/noise — drop them, don't fail the track.
            continue
        if len(body) > MAX_SEGMENT_BODY_CHARS:
            body = body[:MAX_SEGMENT_BODY_CHARS]
        start_ms = max(0, round(float(seg.start) * 1000))
        # end >= start (075): clamp a rounding inversion to a zero-length
        # segment rather than persisting a negative-length one.
        end_ms = max(start_ms, round(float(seg.end) * 1000))
        number += 1
        out.append(
            {
                "segment_number": number,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "body": body,
            }
        )
    return out


def resolve_device(device: str, compute_type: str) -> tuple[str, str]:
    """Resolve 'auto' device/compute to concrete CTranslate2 values.

    'auto' -> cuda + float16 when a CUDA device is visible, else cpu + int8
    (the quality/speed sweet spots for each backend). Explicit values pass
    through untouched so an operator can pin e.g. cuda+int8_float16.
    Imports ctranslate2 lazily — only the 'auto' path needs it.
    """
    if device == "auto":
        import ctranslate2  # noqa: PLC0415 — lazy: tests never need the engine

        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


def transcribe(
    audio_path: Path,
    *,
    model_size: str,
    device: str,
    compute_type: str,
    language: str = "ko",
) -> list[Segment]:
    """Transcribe one audio file into ordered 075-shaped segment dicts.

    faster-whisper is imported lazily inside ``_get_model`` so importing
    this module — and the entire test suite, which injects fakes — never
    requires the engine or a GPU. The model itself is MEMOIZED per resolved
    config (see _MODEL_CACHE): the first job pays the multi-GB load, every
    subsequent job reuses it. The returned segments satisfy the 075
    constraints (see the module docstring); the caller persists them
    verbatim.
    """
    resolved_device, resolved_compute = resolve_device(device, compute_type)
    model = _get_model(model_size, resolved_device, resolved_compute)
    # segments is a lazy generator — map_engine_segments drains it, which is
    # when the actual transcription compute happens.
    segments, _info = model.transcribe(str(audio_path), language=language)
    return map_engine_segments(segments)
