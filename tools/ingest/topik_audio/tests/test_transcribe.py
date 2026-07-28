"""transcribe tests — the engine is ALWAYS fake (sys.modules monkeypatch for
the lazy import; no faster-whisper, no GPU, no model download, ever).

Coverage:
  - ``_map_segments``: seconds -> int ms (rounded), word mapping, clamps
    (negative start, rounding inversion), blank segments dropped + renumbered;
  - ``transcribe_paper``: tuned anti-hallucination kwargs passed verbatim;
    sha256 cache — second run returns the cache WITHOUT the engine even
    importable; changed audio bytes re-transcribe; corrupt cache rebuilt;
    missing audio fails loudly.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.ingest.topik_audio import transcribe as transcribe_mod
from tools.ingest.topik_audio.transcribe import (
    _map_segments,
    sha256_file,
    transcribe_paper,
)


@dataclass
class FakeWord:
    start: float
    end: float
    word: str


@dataclass
class FakeSeg:
    start: float
    end: float
    text: str
    words: list[FakeWord] = field(default_factory=list)


# ---------------------------------------------------------------------------
# _map_segments — the pure mapping.
# ---------------------------------------------------------------------------


def test_map_segments_rounds_ms_and_maps_words() -> None:
    out = _map_segments(
        [
            FakeSeg(0.0, 1.4996, " 1번 문제 ", [FakeWord(0.1004, 0.5, " 1번"), FakeWord(0.6, 1.4, " 문제")]),
            FakeSeg(1.5, 3.0, "둘째"),
        ]
    )
    assert out == [
        {
            "n": 1,
            "s": 0,
            "e": 1500,
            "text": "1번 문제",
            "words": [{"s": 100, "e": 500, "w": " 1번"}, {"s": 600, "e": 1400, "w": " 문제"}],
        },
        {"n": 2, "s": 1500, "e": 3000, "text": "둘째", "words": []},
    ]


def test_map_segments_drops_blank_and_renumbers_gap_free() -> None:
    out = _map_segments(
        [
            FakeSeg(0.0, 1.0, "하나"),
            FakeSeg(1.0, 2.0, "   "),  # VAD silence artifact — dropped
            FakeSeg(2.0, 3.0, ""),  # dropped
            FakeSeg(3.0, 4.0, "둘"),
        ]
    )
    assert [(s["n"], s["text"]) for s in out] == [(1, "하나"), (2, "둘")]


def test_map_segments_clamps_negative_and_inverted_times() -> None:
    out = _map_segments(
        [FakeSeg(-0.25, -0.5, "잡음", [FakeWord(-0.2, -0.4, "잡음")])]
    )
    assert out == [
        {"n": 1, "s": 0, "e": 0, "text": "잡음", "words": [{"s": 0, "e": 0, "w": "잡음"}]}
    ]


def test_map_segments_handles_none_text_and_none_words() -> None:
    out = _map_segments([FakeSeg(0.0, 1.0, None, None), FakeSeg(1.0, 2.0, "말", None)])
    assert [s["text"] for s in out] == ["말"]


# ---------------------------------------------------------------------------
# transcribe_paper — lazy import, tuned kwargs, sha256 cache.
# ---------------------------------------------------------------------------

TUNED_EXPECTED = {
    "language": "ko",
    "word_timestamps": True,
    "vad_filter": True,
    "vad_parameters": {"min_silence_duration_ms": 500},
    "condition_on_previous_text": False,
    "no_speech_threshold": 0.6,
}


class FakeWhisperModel:
    init_count = 0
    transcribe_calls: list[tuple[str, dict]] = []

    def __init__(self, model_size: str, device: str, compute_type: str):
        FakeWhisperModel.init_count += 1

    def transcribe(self, path: str, **kwargs):
        FakeWhisperModel.transcribe_calls.append((path, kwargs))
        segments = iter(
            [FakeSeg(1.0, 2.0, "1번 문제입니다", [FakeWord(1.0, 1.4, " 1번")])]
        )
        info = SimpleNamespace(duration=90.0)
        return segments, info


@pytest.fixture()
def fake_engine(monkeypatch) -> type[FakeWhisperModel]:
    FakeWhisperModel.init_count = 0
    FakeWhisperModel.transcribe_calls = []
    monkeypatch.setattr(transcribe_mod, "_MODEL_CACHE", {})
    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel)
    )
    return FakeWhisperModel


def _write_audio(tmp_path: Path, content: bytes = b"MP3-BYTES") -> Path:
    audio = tmp_path / "60th-TOPIK-II-Listening-Audio.mp3"
    audio.write_bytes(content)
    return audio


def test_transcribe_paper_passes_tuned_kwargs_and_shapes_output(
    tmp_path, fake_engine
) -> None:
    audio = _write_audio(tmp_path)
    out = transcribe_paper(
        audio, cache_dir=tmp_path / "cache", device="cpu", compute_type="int8"
    )
    assert not list((tmp_path / "cache").glob("*.tmp"))  # atomic, no residue
    (path, kwargs), = fake_engine.transcribe_calls
    assert path == str(audio)
    assert kwargs == TUNED_EXPECTED  # the anti-hallucination settings, verbatim
    assert out["audio_sha256"] == sha256_file(audio)
    assert out["duration_ms"] == 90_000
    assert out["segments"] == [
        {
            "n": 1,
            "s": 1000,
            "e": 2000,
            "text": "1번 문제입니다",
            "words": [{"s": 1000, "e": 1400, "w": " 1번"}],
        }
    ]


def test_transcribe_paper_cache_hit_never_touches_engine(
    tmp_path, fake_engine, monkeypatch
) -> None:
    audio = _write_audio(tmp_path)
    cache_dir = tmp_path / "cache"
    first = transcribe_paper(
        audio, cache_dir=cache_dir, device="cpu", compute_type="int8"
    )
    assert fake_engine.init_count == 1
    # Prove the cache path is engine-free: remove the fake module AND the
    # memoized model — a cache miss would now crash on import.
    monkeypatch.delitem(sys.modules, "faster_whisper")
    monkeypatch.setattr(transcribe_mod, "_MODEL_CACHE", {})
    second = transcribe_paper(
        audio, cache_dir=cache_dir, device="cpu", compute_type="int8"
    )
    assert second == first


def test_transcribe_paper_changed_audio_bytes_retranscribe(
    tmp_path, fake_engine
) -> None:
    audio = _write_audio(tmp_path)
    cache_dir = tmp_path / "cache"
    transcribe_paper(audio, cache_dir=cache_dir, device="cpu", compute_type="int8")
    audio.write_bytes(b"DIFFERENT-EXPORT")  # new sha256 -> stale cache ignored
    transcribe_paper(audio, cache_dir=cache_dir, device="cpu", compute_type="int8")
    assert len(fake_engine.transcribe_calls) == 2


def test_transcribe_paper_corrupt_cache_is_rebuilt(tmp_path, fake_engine) -> None:
    audio = _write_audio(tmp_path)
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    (cache_dir / f"{sha256_file(audio)}.json").write_text("{not json", encoding="utf-8")
    out = transcribe_paper(
        audio, cache_dir=cache_dir, device="cpu", compute_type="int8"
    )
    assert len(fake_engine.transcribe_calls) == 1
    # The rebuilt cache file is valid JSON matching what was returned.
    cached = json.loads(
        (cache_dir / f"{out['audio_sha256']}.json").read_text(encoding="utf-8")
    )
    assert cached == out


def test_transcribe_paper_sha_mismatch_cache_is_rebuilt(tmp_path, fake_engine) -> None:
    audio = _write_audio(tmp_path)
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    stale = {"audio_sha256": "0" * 64, "duration_ms": 1, "segments": []}
    (cache_dir / f"{sha256_file(audio)}.json").write_text(
        json.dumps(stale), encoding="utf-8"
    )
    out = transcribe_paper(
        audio, cache_dir=cache_dir, device="cpu", compute_type="int8"
    )
    assert out["audio_sha256"] == sha256_file(audio)
    assert len(fake_engine.transcribe_calls) == 1


def test_transcribe_paper_missing_audio_fails_loudly(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        transcribe_paper(
            tmp_path / "nope.mp3",
            cache_dir=tmp_path / "cache",
            device="cpu",
            compute_type="int8",
        )
