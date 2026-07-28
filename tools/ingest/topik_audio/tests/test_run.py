"""Runner tests — structure loading, validation-text precedence, artifact
contract/determinism, and the CLI wired end-to-end with a FAKE transcriber
(no engine, no DB, no pdftotext).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.ingest.topik_audio import run as run_mod
from tools.ingest.topik_audio.run import (
    PaperStructure,
    compose_validation_texts,
    derive_transcript_pdf_path,
    load_structure_file,
    load_structure_from_db,
    main,
    write_artifact,
)
from tools.ingest.topik_audio.segment import DEFAULT_MIN_CONFIDENCE

# ---------------------------------------------------------------------------
# Structure file loading.
# ---------------------------------------------------------------------------


def _structure_json(tmp_path: Path) -> Path:
    payload = {
        "source": {"test": "60", "level": "TOPIK II", "section": "listening"},
        "passages": {"2-3": "남자: 공유 지문입니다.\n여자: 네, 맞습니다."},
        "items": [
            {"number": 1, "instruction_group": "1", "stem": "여자: 우산이 있어요?"},
            {"number": 2, "instruction_group": "2-3", "stem": "중심 생각을 고르십시오."},
            {"number": 3, "instruction_group": "2-3", "stem": "맞는 것을 고르십시오."},
        ],
    }
    path = tmp_path / "topik_60_II_listening.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def test_load_structure_file_maps_items_and_passages(tmp_path) -> None:
    structure = load_structure_file(_structure_json(tmp_path))
    assert [item["number"] for item in structure.items] == [1, 2, 3]
    assert structure.items[1]["instruction_group"] == "2-3"
    assert "공유 지문" in structure.passages["2-3"]


def test_load_structure_file_rejects_non_structure_json(tmp_path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"foo": 1}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_structure_file(bad)


# ---------------------------------------------------------------------------
# Validation-text precedence: PDF > shared passage + stem > stem.
# ---------------------------------------------------------------------------


def test_compose_validation_texts_precedence() -> None:
    structure = PaperStructure(
        items=[
            {"number": 1, "instruction_group": None, "stem": "스템 하나"},
            {"number": 2, "instruction_group": "2-3", "stem": "스템 둘"},
            {"number": 3, "instruction_group": "2-3", "stem": "스템 셋"},
        ],
        passages={"2-3": "공유 지문"},
    )
    texts = compose_validation_texts(structure, pdf_texts={1: "공식 대본 하나"})
    assert texts[1] == "공식 대본 하나"  # PDF wins
    assert texts[2] == "공유 지문\n스템 둘"  # paired passage + stem
    assert texts[3] == "공유 지문\n스템 셋"


def test_compose_validation_texts_placeholder_stem_is_absent() -> None:
    structure = PaperStructure(
        items=[{"number": 1, "instruction_group": None, "stem": "[듣기 지문 없음]"}],
        passages={},
    )
    assert compose_validation_texts(structure, pdf_texts={}) == {}


def test_compose_validation_texts_larger_group_gets_stem_only() -> None:
    structure = PaperStructure(
        items=[
            {"number": 1, "instruction_group": "1-3", "stem": "스템 일"},
            {"number": 2, "instruction_group": "1-3", "stem": "스템 이"},
            {"number": 3, "instruction_group": "1-3", "stem": "스템 삼"},
        ],
        passages={"1-3": "그룹 지시문"},  # 3-wide group — not a paired passage
    )
    texts = compose_validation_texts(structure, pdf_texts={})
    assert texts == {1: "스템 일", 2: "스템 이", 3: "스템 삼"}


# ---------------------------------------------------------------------------
# Paths + artifact contract.
# ---------------------------------------------------------------------------


def test_derive_transcript_pdf_path_from_corpus_naming() -> None:
    audio = Path("/corpus/TOPIK TEST/60 - 60th TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Audio.mp3")
    assert derive_transcript_pdf_path(audio) == Path(
        "/corpus/TOPIK TEST/60 - 60th TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Transcript.pdf"
    )


def test_write_artifact_is_atomic_and_deterministic(tmp_path) -> None:
    artifact = {"test_number": 60, "segments": [{"item_numbers": [1]}]}
    out = tmp_path / "out" / "topik_60_II_listening.json"
    write_artifact(out, artifact)
    first = out.read_bytes()
    write_artifact(out, artifact)
    assert out.read_bytes() == first  # byte-identical re-write
    assert not out.with_name(out.name + ".tmp").exists()
    assert json.loads(first.decode("utf-8")) == artifact


# ---------------------------------------------------------------------------
# CLI end-to-end with a fake transcriber.
# ---------------------------------------------------------------------------


def _fake_transcript(*, missing_two: bool = False) -> dict:
    # Format-correct paired tail: single 1 (marker first), then the pair's
    # shared PASSAGE, then the combined "2번, 3번" marker AFTER it.
    passage = "남자 공유 지문입니다 여자 네 맞습니다"
    passage_words = [
        {"s": 25_000 + i * 300, "e": 25_000 + i * 300 + 250, "w": tok}
        for i, tok in enumerate(passage.split())
    ]
    segments = [
        {"n": 1, "s": 10_000, "e": 11_000, "text": "1번 우산이 있어요", "words": []},
        {"n": 2, "s": 25_000, "e": 27_000, "text": passage, "words": passage_words},
        {"n": 3, "s": 40_000, "e": 41_000, "text": "2번, 3번 다음을 듣고 답하십시오", "words": []},
    ]
    if missing_two:
        segments = [segments[0]]
    return {
        "audio_sha256": "a" * 64,
        "duration_ms": 90_000,
        "segments": segments,
    }


def _run_cli(tmp_path, monkeypatch, *, missing_two: bool = False) -> tuple[int, Path]:
    structure = _structure_json(tmp_path)
    # Audio nested corpus-style so source_mp3 exercises a multi-level
    # relative path with spaces (the real corpus layout).
    audio_dir = tmp_path / "TOPIK TEST" / "60 - 60th TOPIK" / "TOPIK-II"
    audio_dir.mkdir(parents=True, exist_ok=True)
    audio = audio_dir / "60th-TOPIK-II-Listening-Audio.mp3"
    audio.write_bytes(b"MP3")
    out_dir = tmp_path / "segments"
    monkeypatch.setattr(
        run_mod,
        "transcribe_paper",
        lambda *a, **k: _fake_transcript(missing_two=missing_two),
    )
    monkeypatch.setattr(run_mod, "parse_transcript_pdf", lambda *a, **k: {})
    code = main(
        [
            "--test-number", "60",
            "--level", "2",
            "--audio", str(audio),
            "--corpus-root", str(tmp_path),
            "--structure", str(structure),
            "--out-dir", str(out_dir),
            "--cache-dir", str(tmp_path / "cache"),
        ]
    )
    return code, out_dir / "topik_60_II_listening.json"


def test_cli_writes_contract_artifact_and_exits_zero(tmp_path, monkeypatch, capsys) -> None:
    code, out_path = _run_cli(tmp_path, monkeypatch)
    assert code == 0
    artifact = json.loads(out_path.read_text(encoding="utf-8"))
    # The EXACT §5/§6 key contract — a renamed key (e.g. low_confidence ->
    # lowConfidence) must fail here, not in the Phase-3 loader.
    assert set(artifact) == {
        "test_number",
        "topik_level",
        "source_mp3",
        "audio_sha256",
        "aligner_version",
        "min_confidence",
        "segments",
        "unresolved_items",
    }
    assert artifact["test_number"] == 60
    assert artifact["topik_level"] == "TOPIK II"
    assert artifact["audio_sha256"] == "a" * 64
    assert artifact["aligner_version"]
    assert artifact["min_confidence"] == DEFAULT_MIN_CONFIDENCE
    # source_mp3 is the migration-078 audio_path value: corpus-relative
    # POSIX, never the absolute CLI path.
    assert artifact["source_mp3"] == (
        "TOPIK TEST/60 - 60th TOPIK/TOPIK-II/60th-TOPIK-II-Listening-Audio.mp3"
    )
    assert not artifact["source_mp3"].startswith("/")
    assert artifact["unresolved_items"] == []
    assert [seg["item_numbers"] for seg in artifact["segments"]] == [[1], [2, 3]]
    single, paired = artifact["segments"]
    for seg in (single, paired):
        assert set(seg) == {
            "item_numbers",
            "start_ms",
            "end_ms",
            "confidence",
            "marker",
            "low_confidence",
        }
    # The pair owns the passage BEFORE its marker (content-located start at
    # 25s) and ends AT its own marker — the trailing audio is excluded; the
    # preceding single is trimmed to end where the pair's passage begins.
    assert (single["start_ms"], single["end_ms"]) == (10_000, 25_000)
    assert (paired["start_ms"], paired["end_ms"]) == (25_000, 40_000)
    report = capsys.readouterr().out
    assert "units resolved: 2/2" in report
    assert "items covered:  3/3" in report
    assert "transcript PDF: absent" in report


def test_cli_rerun_is_byte_identical(tmp_path, monkeypatch) -> None:
    _, out_path = _run_cli(tmp_path, monkeypatch)
    first = out_path.read_bytes()
    code, _ = _run_cli(tmp_path, monkeypatch)
    assert code == 0
    assert out_path.read_bytes() == first


def test_cli_unresolved_items_exit_one_but_artifact_written(
    tmp_path, monkeypatch, capsys
) -> None:
    code, out_path = _run_cli(tmp_path, monkeypatch, missing_two=True)
    assert code == 1
    artifact = json.loads(out_path.read_text(encoding="utf-8"))
    assert artifact["unresolved_items"] == [2, 3]
    assert "unresolved items: [2, 3]" in capsys.readouterr().out


def test_cli_without_structure_or_db_is_usage_error(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"MP3")
    code = main(
        [
            "--test-number", "60",
            "--level", "2",
            "--audio", str(audio),
            "--corpus-root", str(tmp_path),
            "--database-url", "",
        ]
    )
    assert code == 2
    assert "provide --structure" in capsys.readouterr().err


def test_cli_audio_outside_corpus_root_is_usage_error(tmp_path, capsys) -> None:
    audio = tmp_path / "elsewhere" / "a.mp3"
    audio.parent.mkdir()
    audio.write_bytes(b"MP3")
    code = main(
        [
            "--test-number", "60",
            "--level", "2",
            "--audio", str(audio),
            "--corpus-root", str(tmp_path / "corpus"),
        ]
    )
    assert code == 2
    assert "not under --corpus-root" in capsys.readouterr().err


def test_cli_missing_audio_is_input_error(tmp_path, capsys) -> None:
    # transcribe_paper NOT monkeypatched: the missing-file check fires
    # before any engine import — FileNotFoundError maps to exit 2.
    structure = _structure_json(tmp_path)
    code = main(
        [
            "--test-number", "60",
            "--level", "2",
            "--audio", str(tmp_path / "nope.mp3"),
            "--corpus-root", str(tmp_path),
            "--structure", str(structure),
        ]
    )
    assert code == 2
    assert "error:" in capsys.readouterr().err


def test_cli_malformed_structure_json_is_input_error(tmp_path, capsys) -> None:
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"MP3")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    code = main(
        [
            "--test-number", "60",
            "--level", "2",
            "--audio", str(audio),
            "--corpus-root", str(tmp_path),
            "--structure", str(bad),
        ]
    )
    assert code == 2
    assert "error:" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# DB structure loading — fake psycopg in sys.modules (engine-monkeypatch
# stance: the driver is lazily imported, so the fake intercepts it).
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, rows: list[tuple]):
        self._rows = rows
        self.executed: tuple[str, tuple] | None = None

    def execute(self, sql: str, params: tuple) -> None:
        self.executed = (sql, params)

    def fetchall(self) -> list[tuple]:
        return self._rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor):
        self._cursor = cursor

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakePsycopgError(Exception):
    pass


def _install_fake_psycopg(
    monkeypatch, *, rows: list[tuple] | None = None, connect_error: Exception | None = None
) -> _FakeCursor:
    cursor = _FakeCursor(rows or [])

    def connect(url: str):
        if connect_error is not None:
            raise connect_error
        return _FakeConnection(cursor)

    fake = SimpleNamespace(connect=connect, Error=_FakePsycopgError)
    monkeypatch.setitem(sys.modules, "psycopg", fake)
    return cursor


def test_load_structure_from_db_query_params_and_row_mapping(monkeypatch) -> None:
    cursor = _install_fake_psycopg(
        monkeypatch, rows=[(1, "1-3", "스템 일"), (2, None, "스템 이")]
    )
    structure = load_structure_from_db("postgresql://fake", 60, 2)
    sql, params = cursor.executed
    assert params == (60, "TOPIK II")
    assert "topik_items" in sql
    assert "section = 'listening'" in sql
    assert structure.items == [
        {"number": 1, "instruction_group": "1-3", "stem": "스템 일"},
        {"number": 2, "instruction_group": None, "stem": "스템 이"},
    ]
    assert structure.passages == {}


def test_load_structure_from_db_level_one_label(monkeypatch) -> None:
    cursor = _install_fake_psycopg(monkeypatch, rows=[(1, None, "스템")])
    load_structure_from_db("postgresql://fake", 35, 1)
    assert cursor.executed[1] == (35, "TOPIK I")


def test_load_structure_from_db_zero_rows_raises(monkeypatch) -> None:
    _install_fake_psycopg(monkeypatch, rows=[])
    with pytest.raises(ValueError, match="no listening items"):
        load_structure_from_db("postgresql://fake", 60, 2)


def test_cli_db_error_exits_two_not_one(tmp_path, monkeypatch, capsys) -> None:
    # A bad/unreachable DATABASE_URL must exit 2 (input error), NOT crash
    # with an uncaught driver exception whose interpreter exit code 1 would
    # collide with the contract's "unresolved items" meaning.
    _install_fake_psycopg(
        monkeypatch, connect_error=_FakePsycopgError("connection refused")
    )
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"MP3")
    code = main(
        [
            "--test-number", "60",
            "--level", "2",
            "--audio", str(audio),
            "--corpus-root", str(tmp_path),
            "--database-url", "postgresql://bad-host/km",
        ]
    )
    assert code == 2
    assert "database error" in capsys.readouterr().err
