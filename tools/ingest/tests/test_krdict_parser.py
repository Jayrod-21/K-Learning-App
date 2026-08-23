"""
Parser tests — fixture-driven, LMF (DTD_LMF_REV_16).

The fixture (krdict_sample.xml) is hand-crafted to cover the variation matrix:
monosemous + polysemous, with/without hanja, vocabulary levels, homographs
(incl. the camelCase ``homonymNumber`` spelling), a loanword whose origin is not
hanja, a doubled HTML entity, a 대화 example carrying two example feats, AND one
malformed entry (no Lemma) the parser must skip without crashing.

Also exercises the two robustness paths against real-world KRDICT defects:
illegal XML control characters (stripped, not fatal) and XXE/entity attacks
(blocked by defusedxml).
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pytest

from krdict_models import KrdictEntryModel, VocabularyLevel
from krdict_parser import SkipReason, parse_file


FIXTURE = Path(__file__).parent / "fixtures" / "krdict_sample.xml"


@pytest.fixture
def skip_log() -> list[SkipReason]:
    return []


@pytest.fixture
def parsed(skip_log: list[SkipReason]) -> list[KrdictEntryModel]:
    return list(parse_file(FIXTURE, on_skip=skip_log.append))


def _find(
    entries: list[KrdictEntryModel], headword: str, homograph: int = 0
) -> Optional[KrdictEntryModel]:
    for e in entries:
        if e.headword == headword and e.homograph_index == homograph:
            return e
    return None


# --- Counts / skip behavior --------------------------------------------------

def test_parses_all_valid_entries(parsed: list[KrdictEntryModel]) -> None:
    # 6 valid entries; the malformed (no-Lemma) one is skipped.
    assert len(parsed) == 6


def test_malformed_entry_is_skipped_and_logged(
    parsed: list[KrdictEntryModel], skip_log: list[SkipReason]
) -> None:
    assert len(skip_log) == 1
    assert skip_log[0].source_id == "10007"


# --- Lexical core ------------------------------------------------------------

def test_noun_core_fields(parsed: list[KrdictEntryModel]) -> None:
    e = _find(parsed, "가족")
    assert e is not None
    assert e.source_id == "10001"
    assert e.homograph_index == 0
    assert e.part_of_speech == "명사"
    assert e.pronunciation == "가족"
    assert e.hanja == "家族"  # origin is hanja -> kept
    assert e.vocabulary_level is VocabularyLevel.BEGINNER  # 초급


def test_first_sense_definitions_korean_and_english(
    parsed: list[KrdictEntryModel],
) -> None:
    e = _find(parsed, "가족")
    assert e is not None
    s = e.senses[0]
    assert s.definition_korean.startswith("부모, 자식")
    # English comes from the Equivalent[language=영어] definition, not 일본어.
    assert s.definition_english == (
        "People who live together in one house, such as parents and children."
    )


def test_examples_carry_type_and_order(parsed: list[KrdictEntryModel]) -> None:
    e = _find(parsed, "가족")
    assert e is not None
    examples = e.senses[0].examples
    assert [x.korean for x in examples] == ["우리 가족.", "저는 가족과 함께 살아요."]
    assert [x.example_type for x in examples] == ["구", "문장"]
    assert [x.example_index for x in examples] == [1, 2]


# --- Vocabulary level (new) --------------------------------------------------

def test_vocabulary_levels_map_to_enum(parsed: list[KrdictEntryModel]) -> None:
    assert _find(parsed, "사과", 1).vocabulary_level is VocabularyLevel.BEGINNER
    assert _find(parsed, "사과", 2).vocabulary_level is VocabularyLevel.INTERMEDIATE


# --- Verb: senses, inflections, dialogue example -----------------------------

def test_polysemous_verb_senses(parsed: list[KrdictEntryModel]) -> None:
    e = _find(parsed, "먹다")
    assert e is not None
    assert [s.sense_index for s in e.senses] == [1, 2]
    assert e.senses[1].definition_english == "To grow older."


def test_inflections_from_wordform_hwalyong(
    parsed: list[KrdictEntryModel],
) -> None:
    e = _find(parsed, "먹다")
    assert e is not None
    # Only WordForm[type=활용] become inflections; the 발음 WordForm does not.
    assert [i.surface_form for i in e.inflections] == ["먹어", "먹으니"]
    assert all(i.inflection_label == "활용" for i in e.inflections)


def test_dialogue_example_yields_one_row_per_example_feat(
    parsed: list[KrdictEntryModel],
) -> None:
    e = _find(parsed, "먹다")
    assert e is not None
    ex = e.senses[0].examples
    assert [x.korean for x in ex] == ["밥 먹었어요?", "네, 먹었어요."]
    assert all(x.example_type == "대화" for x in ex)


# --- Homographs --------------------------------------------------------------

def test_homographs_distinguished_by_homonym_number(
    parsed: list[KrdictEntryModel],
) -> None:
    apple = _find(parsed, "사과", 1)
    apology = _find(parsed, "사과", 2)
    assert apple is not None and apology is not None
    assert apple.source_id == "10003" and apology.source_id == "10004"
    assert apple.hanja == "沙果" and apology.hanja == "謝過"
    assert apple.senses[0].definition_english == "A round, red fruit."


def test_camelcase_homonym_number_is_read(
    parsed: list[KrdictEntryModel],
) -> None:
    # 안녕 uses the camelCase `homonymNumber` spelling.
    e = _find(parsed, "안녕", 0)
    assert e is not None
    assert e.part_of_speech == "감탄사"


# --- Origin that is NOT hanja ------------------------------------------------

def test_loanword_origin_not_stored_as_hanja(
    parsed: list[KrdictEntryModel],
) -> None:
    e = _find(parsed, "버스")
    assert e is not None
    assert e.hanja is None  # origin "bus" is not CJK -> not hanja


# --- HTML entity unescaping --------------------------------------------------

def test_doubled_html_entities_are_unescaped(
    parsed: list[KrdictEntryModel],
) -> None:
    e = _find(parsed, "안녕")
    assert e is not None
    en = e.senses[0].definition_english
    assert "&quot;" not in en
    assert '"hello"' in en and '"goodbye"' in en


# --- Robustness: illegal control characters ---------------------------------

def test_illegal_control_char_is_stripped_not_fatal(tmp_path: Path) -> None:
    # An entry whose Korean definition contains a backspace (0x08) — illegal in
    # XML 1.0. Without the control-char filter expat aborts the whole file.
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<LexicalResource><Lexicon>"
        '<LexicalEntry att="id" val="900">'
        '<feat att="partOfSpeech" val="명사" />'
        '<Lemma><feat att="writtenForm" val="시험" /></Lemma>'
        '<Sense att="id" val="1">'
        '<feat att="definition" val="시\x08험 정의." />'
        "</Sense></LexicalEntry>"
        "</Lexicon></LexicalResource>"
    )
    p = tmp_path / "ctrl.xml"
    p.write_bytes(xml.encode("utf-8"))
    entries = list(parse_file(p))
    assert len(entries) == 1
    assert entries[0].headword == "시험"
    assert "\x08" not in entries[0].senses[0].definition_korean


# --- Sense re-indexing (KRDICT @val is not a reliable 1-based index) ---------

def test_single_sense_with_nonone_val_reindexed_to_one(tmp_path: Path) -> None:
    # A synonym/cross-ref entry can carry a lone Sense numbered e.g. "3" (the
    # sense number of the entry it points at). It must still parse, re-indexed to
    # sense_index 1 — not be dropped for "missing sense_index = 1".
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<LexicalResource><Lexicon>"
        '<LexicalEntry att="id" val="79620">'
        '<feat att="partOfSpeech" val="명사" />'
        '<Lemma><feat att="writtenForm" val="초야" /></Lemma>'
        '<Sense att="id" val="3">'
        '<feat att="definition" val="신랑과 신부가 처음으로 함께 자는 밤." />'
        "</Sense></LexicalEntry>"
        "</Lexicon></LexicalResource>"
    )
    p = tmp_path / "synonym.xml"
    p.write_bytes(xml.encode("utf-8"))
    entries = list(parse_file(p))
    assert len(entries) == 1
    assert [s.sense_index for s in entries[0].senses] == [1]


# --- Security: XXE / entity attacks blocked ----------------------------------

def test_entity_declaration_is_blocked(tmp_path: Path) -> None:
    # A DOCTYPE that declares an internal entity must be rejected
    # (forbid_entities=True) rather than expanded — the billion-laughs vector.
    xml = (
        '<?xml version="1.0"?>\n'
        "<!DOCTYPE LexicalResource [\n"
        '  <!ENTITY boom "boomboomboom">\n'
        "]>\n"
        "<LexicalResource><Lexicon>"
        '<LexicalEntry att="id" val="1">'
        '<Lemma><feat att="writtenForm" val="&boom;" /></Lemma>'
        '<Sense att="id" val="1"><feat att="definition" val="x" /></Sense>'
        "</LexicalEntry></Lexicon></LexicalResource>"
    )
    p = tmp_path / "xxe.xml"
    p.write_bytes(xml.encode("utf-8"))
    with pytest.raises(Exception):  # noqa: B017 - defusedxml EntitiesForbidden
        list(parse_file(p))
