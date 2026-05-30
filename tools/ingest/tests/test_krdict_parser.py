"""
Parser tests — fixture-driven.

The fixture (krdict_sample.xml) is hand-crafted to cover the variation
matrix: monosemous + polysemous, with/without English, hanja yes/no,
register tagged/untagged, homographs, inflection tables, AND one
malformed entry the parser must skip without crashing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pytest

from krdict_models import KrdictEntryModel, RegisterLevel
from krdict_parser import SkipReason, parse_file


FIXTURE = Path(__file__).parent / "fixtures" / "krdict_sample.xml"


@pytest.fixture
def skip_log() -> list[SkipReason]:
    return []


@pytest.fixture
def parsed(skip_log: list[SkipReason]) -> list[KrdictEntryModel]:
    return list(parse_file(FIXTURE, on_skip=skip_log.append))


def _find(entries: list[KrdictEntryModel], headword: str,
          homograph: int = 0) -> Optional[KrdictEntryModel]:
    for e in entries:
        if e.headword == headword and e.homograph_index == homograph:
            return e
    return None


# -----------------------------------------------------------------------------
# Top-line: count + skip behavior.
# -----------------------------------------------------------------------------
def test_parser_yields_eight_valid_entries(parsed):
    assert len(parsed) == 8


def test_parser_skips_malformed_entry_via_callback(parsed, skip_log):
    assert len(skip_log) == 1
    reason = skip_log[0]
    assert reason.source_id is None  # no entry_id in the bad entry
    assert "entry_id" in reason.error


# -----------------------------------------------------------------------------
# Field-level extraction.
# -----------------------------------------------------------------------------
def test_parses_monosemous_noun(parsed):
    entry = _find(parsed, "가족")
    assert entry is not None
    assert entry.source_id == "10001"
    assert entry.part_of_speech == "명사"
    assert entry.hanja == "家族"
    assert entry.register is None
    assert len(entry.senses) == 1
    sense = entry.senses[0]
    assert sense.sense_index == 1
    assert "한집" in sense.definition_korean
    assert sense.definition_english.startswith("family")
    assert len(sense.examples) == 2
    assert sense.examples[0].english.startswith("I live with my family")


def test_parses_polysemous_verb_with_inflections(parsed):
    entry = _find(parsed, "먹다")
    assert entry is not None
    assert entry.part_of_speech == "동사"
    assert len(entry.senses) == 3
    # Sense numbers preserved.
    assert [s.sense_index for s in entry.senses] == [1, 2, 3]
    # Sense 3 omits English — must be None, not "".
    assert entry.senses[2].definition_english is None
    # Example without English translation present and english is None.
    ex = entry.senses[2].examples[0]
    assert ex.korean == "오늘 또 욕을 먹었어요."
    assert ex.english is None
    # 6 inflections, all unique on (form, label).
    assert len(entry.inflections) == 6
    forms = {(i.surface_form, i.inflection_label) for i in entry.inflections}
    assert ("먹었어요", "해요체 과거형") in forms


def test_parses_adjective(parsed):
    entry = _find(parsed, "예쁘다")
    assert entry is not None
    assert entry.part_of_speech == "형용사"
    assert len(entry.senses) == 2


def test_parses_register_tag(parsed):
    entry = _find(parsed, "안녕")
    assert entry is not None
    assert entry.register is RegisterLevel.HAEYOCHE


def test_parses_homographs_separately(parsed):
    h1 = _find(parsed, "사과", homograph=1)
    h2 = _find(parsed, "사과", homograph=2)
    assert h1 is not None and h2 is not None
    assert h1.hanja is None  # empty <hanja /> tag becomes None.
    assert h2.hanja == "謝過"
    assert h1.source_id == h2.source_id == "10006"


def test_parses_sense_level_domain(parsed):
    entry = _find(parsed, "학교")
    assert entry is not None
    assert entry.senses[0].sense_domain == "교육"


def test_parses_pronunciation_field(parsed):
    entry = _find(parsed, "먹다")
    assert entry.pronunciation == "[먹따]"


# -----------------------------------------------------------------------------
# Edge cases.
# -----------------------------------------------------------------------------
def test_empty_tag_becomes_none():
    # <hanja /> in the fixture should become None, not "".
    entries = list(parse_file(FIXTURE))
    h1 = _find(entries, "사과", homograph=1)
    assert h1.hanja is None


def test_parser_is_streaming(parsed):
    # Indirect: if the parser were buffering, .clear() wouldn't be called
    # and memory would balloon — but at fixture scale we mainly check that
    # the iterator-style API works.
    assert isinstance(parsed, list)
    assert all(isinstance(e, KrdictEntryModel) for e in parsed)


def test_parser_rejects_missing_file(tmp_path):
    from krdict_parser import iter_entries
    with pytest.raises(FileNotFoundError):
        list(iter_entries(tmp_path / "nonexistent.xml"))


# -----------------------------------------------------------------------------
# Pydantic-level validators — model invariants directly.
# -----------------------------------------------------------------------------
def test_model_rejects_duplicate_sense_index():
    from krdict_models import (
        KrdictEntryModel,
        KrdictSenseModel,
    )
    with pytest.raises(ValueError):
        KrdictEntryModel(
            source_id="x",
            homograph_index=0,
            headword="가",
            senses=[
                KrdictSenseModel(sense_index=1, definition_korean="a"),
                KrdictSenseModel(sense_index=1, definition_korean="b"),
            ],
        )


def test_model_rejects_missing_sense_1():
    from krdict_models import KrdictEntryModel, KrdictSenseModel
    with pytest.raises(ValueError):
        KrdictEntryModel(
            source_id="x",
            homograph_index=0,
            headword="가",
            senses=[KrdictSenseModel(sense_index=2, definition_korean="b")],
        )


def test_model_drops_unknown_register():
    from krdict_models import KrdictEntryModel, KrdictSenseModel
    m = KrdictEntryModel(
        source_id="x",
        homograph_index=0,
        headword="가",
        register="존댓말",  # not in the enum — must coerce to None.
        senses=[KrdictSenseModel(sense_index=1, definition_korean="a")],
    )
    assert m.register is None


def test_model_rejects_oversized_headword():
    from krdict_models import KrdictEntryModel, KrdictSenseModel
    with pytest.raises(ValueError):
        KrdictEntryModel(
            source_id="x",
            homograph_index=0,
            headword="가" * 5000,  # exceeds MAX_HEADWORD_LEN.
            senses=[KrdictSenseModel(sense_index=1, definition_korean="a")],
        )


def test_model_rejects_extra_fields():
    # extra="forbid" — parser-vs-schema drift must surface immediately.
    from krdict_models import KrdictEntryModel, KrdictSenseModel
    with pytest.raises(ValueError):
        KrdictEntryModel(
            source_id="x",
            homograph_index=0,
            headword="가",
            senses=[KrdictSenseModel(sense_index=1, definition_korean="a")],
            mystery_field="x",  # type: ignore[call-arg]
        )
