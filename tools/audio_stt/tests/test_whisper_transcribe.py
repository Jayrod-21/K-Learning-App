"""Segment-mapping tests for whisper_transcribe — the engine is ALWAYS fake
(sys.modules monkeypatch for the lazy imports; no faster-whisper, no GPU,
no model download in the suite, ever).

Coverage:
  - float seconds → int ms (rounded); negative start clamped to 0; a
    rounding inversion clamped to end_ms >= start_ms (075's CHECKs).
  - empty/whitespace-only bodies DROPPED (075 requires length >= 1) and the
    survivors renumbered 1..N gap-free.
  - bodies > 5000 chars truncated defensively.
  - transcribe(): lazy import satisfied by a fake module; model/device/
    compute/language plumbed through; engine segments mapped.
  - resolve_device(): auto → cuda+float16 when CUDA is visible, else
    cpu+int8; explicit values pass through (no ctranslate2 import needed).
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from tools.audio_stt import whisper_transcribe
from tools.audio_stt.whisper_transcribe import (
    MAX_SEGMENT_BODY_CHARS,
    map_engine_segments,
    resolve_device,
    transcribe,
)


@dataclass
class FakeSeg:
    start: float
    end: float
    text: str


# ---------------------------------------------------------------------------
# map_engine_segments — the pure mapping.
# ---------------------------------------------------------------------------


def test_maps_seconds_to_ms_and_strips_bodies() -> None:
    out = map_engine_segments(
        [
            FakeSeg(0.0, 1.4996, "  안녕하세요  "),
            FakeSeg(1.4996, 3.2, "뉴스입니다"),
        ]
    )
    assert out == [
        {"segment_number": 1, "start_ms": 0, "end_ms": 1500, "body": "안녕하세요"},
        {"segment_number": 2, "start_ms": 1500, "end_ms": 3200, "body": "뉴스입니다"},
    ]


def test_drops_blank_segments_and_renumbers_gap_free() -> None:
    out = map_engine_segments(
        [
            FakeSeg(0.0, 1.0, "하나"),
            FakeSeg(1.0, 2.0, "   "),  # whitespace-only — dropped (075 CHECK)
            FakeSeg(2.0, 3.0, ""),  # empty — dropped
            FakeSeg(3.0, 4.0, "둘"),
        ]
    )
    assert [s["segment_number"] for s in out] == [1, 2]
    assert [s["body"] for s in out] == ["하나", "둘"]


def test_handles_none_text_defensively() -> None:
    assert map_engine_segments([FakeSeg(0.0, 1.0, None)]) == []


def test_clamps_negative_start_and_inverted_end() -> None:
    out = map_engine_segments([FakeSeg(-0.25, -0.5, "잡음")])
    assert out == [
        {"segment_number": 1, "start_ms": 0, "end_ms": 0, "body": "잡음"}
    ]


def test_truncates_oversized_body() -> None:
    out = map_engine_segments([FakeSeg(0.0, 1.0, "가" * 6000)])
    # The PREFIX survives — truncation must keep the leading content, not
    # just produce any 5000-char string.
    assert out[0]["body"] == "가" * MAX_SEGMENT_BODY_CHARS


# ---------------------------------------------------------------------------
# transcribe — lazy import, faked engine.
# ---------------------------------------------------------------------------


class FakeWhisperModel:
    init_args: tuple | None = None
    transcribe_args: tuple | None = None

    def __init__(self, model_size: str, device: str, compute_type: str):
        FakeWhisperModel.init_args = (model_size, device, compute_type)

    def transcribe(self, path: str, language: str | None = None):
        FakeWhisperModel.transcribe_args = (path, language)
        segments = iter(
            [FakeSeg(0.0, 1.5, " 안녕하세요 "), FakeSeg(1.5, 3.0, "   ")]
        )
        info = SimpleNamespace(duration=3.0, language=language)
        return segments, info


def test_transcribe_uses_lazy_import_and_maps(monkeypatch) -> None:
    # Fresh model cache: another test may have populated the same key.
    monkeypatch.setattr(whisper_transcribe, "_MODEL_CACHE", {})
    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel)
    )
    out = transcribe(
        Path("/audio/1/track.mp3"),
        model_size="large-v3",
        device="cpu",
        compute_type="int8",
    )
    assert FakeWhisperModel.init_args == ("large-v3", "cpu", "int8")
    assert FakeWhisperModel.transcribe_args == ("/audio/1/track.mp3", "ko")
    # The blank second segment is dropped; the survivor is number 1.
    assert out == [
        {"segment_number": 1, "start_ms": 0, "end_ms": 1500, "body": "안녕하세요"}
    ]


def test_whisper_model_is_memoized_across_jobs(monkeypatch) -> None:
    """S-SF1: the multi-GB WhisperModel is built ONCE per resolved config
    and reused across jobs — never reloaded per transcription. A different
    resolved config gets its own instance."""
    init_calls: list[tuple] = []

    class CountingModel(FakeWhisperModel):
        def __init__(self, model_size: str, device: str, compute_type: str):
            init_calls.append((model_size, device, compute_type))
            super().__init__(model_size, device, compute_type)

    monkeypatch.setattr(whisper_transcribe, "_MODEL_CACHE", {})
    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=CountingModel)
    )

    for _ in range(2):  # two "jobs"
        out = transcribe(
            Path("/audio/1/track.mp3"),
            model_size="large-v3",
            device="cpu",
            compute_type="int8",
        )
        assert out[0]["body"] == "안녕하세요"
    assert init_calls == [
        ("large-v3", "cpu", "int8")
    ], "the model must be constructed exactly once across jobs"

    transcribe(
        Path("/audio/1/track.mp3"),
        model_size="large-v3",
        device="cpu",
        compute_type="int8_float16",
    )
    assert len(init_calls) == 2, "a different config builds its own model"


def test_resolve_device_auto_prefers_cuda(monkeypatch) -> None:
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(get_cuda_device_count=lambda: 2),
    )
    assert resolve_device("auto", "auto") == ("cuda", "float16")


def test_resolve_device_auto_falls_back_to_cpu(monkeypatch) -> None:
    monkeypatch.setitem(
        sys.modules,
        "ctranslate2",
        SimpleNamespace(get_cuda_device_count=lambda: 0),
    )
    assert resolve_device("auto", "auto") == ("cpu", "int8")


def test_resolve_device_explicit_values_pass_through() -> None:
    # No ctranslate2 in sys.modules needed — explicit values skip the import.
    assert resolve_device("cuda", "int8_float16") == ("cuda", "int8_float16")
    assert resolve_device("cpu", "auto") == ("cpu", "int8")
