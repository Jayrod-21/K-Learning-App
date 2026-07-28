"""transcript_pdf tests — the parser is pure (a pdftotext dump fixture);
extraction failures are exercised via monkeypatched subprocess. pdftotext is
never actually invoked.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.ingest.topik_audio import transcript_pdf as mod
from tools.ingest.topik_audio.transcript_pdf import (
    extract_pdf_text,
    parse_transcript_pdf,
    parse_transcript_text,
)

FIXTURE = Path(__file__).parent / "fixtures" / "transcript_mini.txt"


@pytest.fixture()
def parsed() -> dict[int, str]:
    return parse_transcript_text(FIXTURE.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Pure parsing.
# ---------------------------------------------------------------------------


def test_parses_all_question_numbers(parsed) -> None:
    assert sorted(parsed) == [1, 2, 3, 4, 5, 6, 7]


def test_section_banner_is_not_question_one(parsed) -> None:
    # "듣기 통합 (\n 1번 ～ 30번)" wraps so "1번 ～" starts a line — the tilde
    # guard must reject it; question 1 is the real dialogue.
    assert parsed[1].startswith("여자 : 무엇을 도와 드릴까요?")


def test_page_headers_and_page_numbers_are_stripped(parsed) -> None:
    for text in parsed.values():
        assert "한국어능력시험" not in text
    # The bare page-number line between questions 2 and 3 must not leak.
    assert "\n1\n" not in f"\n{parsed[2]}\n"


def test_option_lines_and_example_block_are_stripped(parsed) -> None:
    assert "친구와 마셨어요" not in parsed[3]  # ① option line
    assert "옵션 하나" not in parsed[4]
    assert "공부를 해요" not in parsed[1]  # <보기> example content precedes q1
    assert "보 기" not in parsed[1]


def test_wrapped_point_tag_is_stripped(parsed) -> None:
    # 35-I style "3. (\n   4점)" — the tag spans lines; no "(" / "4점)" residue.
    assert "4점" not in parsed[3]
    assert not parsed[3].startswith("(")
    assert "누구하고 커피를 마셨어요" in parsed[3]


def test_answer_blank_underscores_are_stripped(parsed) -> None:
    assert "_" not in parsed[3]


def test_paired_group_passage_prepended_to_both_items(parsed) -> None:
    for n in (4, 5):
        assert "페어드 패시지 첫 문장입니다" in parsed[n]
        assert "페어드 패시지 둘째 문장입니다" in parsed[n]
    assert "남자의 중심 생각으로 알맞은 것을 고르십시오" in parsed[4]
    assert "들은 내용으로 맞는 것을 고르십시오" in parsed[5]


def test_larger_group_passage_not_prepended_to_singles(parsed) -> None:
    # [1~3] is a 3-item group — its header chunk (instruction) must NOT be
    # prepended to items 1..3.
    assert "다음을 듣고 알맞은 그림을 고르십시오" not in parsed[1]


def test_split_tilde_group_header_recognized(parsed) -> None:
    # 35-II -layout form: "※    ～" on its own line, "[6   7]" on the next
    # (whitespace-only between the numbers). Missing this header absorbed
    # the pair's shared passage + junk into the PRECEDING question's chunk.
    for n in (6, 7):
        assert "분리형 틸데 지문 첫 문장입니다" in parsed[n]
        assert "분리형 틸데 지문 둘째 문장입니다" in parsed[n]
    assert "분리형" not in parsed[5]  # question 5 no longer swallows it
    assert "각 2점" not in parsed[5]


def test_same_line_displaced_tilde_header() -> None:
    # 41-I -layout form: "※ ～[1   2]" — tilde before the bracket on the
    # SAME line, numbers whitespace-separated inside.
    text = (
        "※ ～[1   2] 다음을 듣고 물음에 답하십시오. (각 2점)\n"
        "\n"
        "남자 : 같은 줄 분리형 지문입니다.\n"
        "\n"
        "1. 질문 하나입니다.\n"
        "\n"
        "2. 질문 둘입니다.\n"
    )
    parsed = parse_transcript_text(text)
    assert sorted(parsed) == [1, 2]
    for n in (1, 2):
        assert "같은 줄 분리형 지문입니다" in parsed[n]


def test_trailing_dangling_speaker_label_stripped() -> None:
    # Stripping the answer blank can leave a bare "남자 :" dangling at the
    # chunk's end — printed-only residue, never spoken.
    text = (
        "1. 여자 : 어디에 가요?\n"
        "   남자 : _____________\n"
        "\n"
        "2. 다음 질문입니다.\n"
    )
    parsed = parse_transcript_text(text)
    assert parsed[1] == "여자 : 어디에 가요?"
    assert not parsed[1].rstrip().endswith(":")


def test_non_monotonic_stray_number_ignored() -> None:
    text = (
        "1. 첫 번째 질문입니다.\n"
        "2. 두 번째 질문입니다.\n"
        "1. 본문 안에서 줄 머리에 나타난 숫자입니다.\n"
        "3. 세 번째 질문입니다.\n"
    )
    parsed = parse_transcript_text(text)
    assert sorted(parsed) == [1, 2, 3]
    # The stray "1." stays inside question 2's chunk.
    assert "본문 안에서" in parsed[2]


def test_out_of_range_numbers_ignored() -> None:
    parsed = parse_transcript_text("1. 질문입니다.\n51. 범위 밖입니다.\n", max_item=50)
    assert sorted(parsed) == [1]


def test_empty_text_parses_to_empty() -> None:
    assert parse_transcript_text("") == {}
    assert parse_transcript_text("   \n  ") == {}


# ---------------------------------------------------------------------------
# Extraction — defensive, {} on every failure mode.
# ---------------------------------------------------------------------------


def test_extract_missing_file_returns_empty(tmp_path) -> None:
    assert extract_pdf_text(tmp_path / "absent.pdf") == ""


def test_extract_missing_binary_returns_empty(tmp_path, monkeypatch) -> None:
    pdf = tmp_path / "t.pdf"
    pdf.write_bytes(b"%PDF-1.4")

    def raise_missing(*args, **kwargs):
        raise FileNotFoundError("pdftotext")

    monkeypatch.setattr(mod.subprocess, "run", raise_missing)
    assert extract_pdf_text(pdf) == ""


def test_extract_nonzero_returncode_returns_empty(tmp_path, monkeypatch) -> None:
    pdf = tmp_path / "t.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(
        mod.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=1, stdout=b"", stderr=b"boom"),
    )
    assert extract_pdf_text(pdf) == ""


def test_extract_timeout_returns_empty(tmp_path, monkeypatch) -> None:
    pdf = tmp_path / "t.pdf"
    pdf.write_bytes(b"%PDF-1.4")

    def raise_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="pdftotext", timeout=1)

    monkeypatch.setattr(mod.subprocess, "run", raise_timeout)
    assert extract_pdf_text(pdf) == ""


def test_parse_transcript_pdf_absent_returns_empty(tmp_path) -> None:
    assert parse_transcript_pdf(tmp_path / "absent.pdf") == {}


def test_parse_transcript_pdf_existing_but_empty_warns(tmp_path, monkeypatch) -> None:
    # An image-only scan (10 of the 22 transcript PDFs): the file EXISTS but
    # pdftotext dumps only form feeds. Must warn — silently losing PDF
    # validation for 10 papers is how it went unnoticed.
    pdf = tmp_path / "t.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(
        mod.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=b"\x0c\x0c\x0c", stderr=b""),
    )
    events: list[tuple[str, tuple, dict]] = []
    monkeypatch.setattr(
        mod,
        "logger",
        SimpleNamespace(
            info=lambda *a, **k: events.append(("info", a, k)),
            warning=lambda *a, **k: events.append(("warning", a, k)),
        ),
    )
    assert parse_transcript_pdf(pdf) == {}
    assert any(
        level == "warning" and args[0] == "transcript_pdf_parsed_empty"
        for level, args, _ in events
    )


def test_parse_transcript_pdf_happy_path(tmp_path, monkeypatch) -> None:
    pdf = tmp_path / "t.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    dump = FIXTURE.read_text(encoding="utf-8").encode("utf-8")
    monkeypatch.setattr(
        mod.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=dump, stderr=b""),
    )
    parsed = parse_transcript_pdf(pdf)
    assert sorted(parsed) == [1, 2, 3, 4, 5, 6, 7]
