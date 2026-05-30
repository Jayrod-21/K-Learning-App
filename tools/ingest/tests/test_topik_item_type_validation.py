"""
TopikItemModel.type discriminator validation — FU-NF-7 regression fix.

Why this is a separate file from ``test_load_topik_properties.py``:
the property suite calls ``pytest.importorskip("testcontainers.postgres")``
at module level, which would also skip these pure-Pydantic tests on dev
machines without Docker. These tests need no DB and must always run.

Covers:
1. Every underscored canonical form in the Literal parses cleanly.
2. Every hyphenated form observed in production writing JSONs
   (``output/topik_{36,37,41,47,52,60,64,91,96}_writing.json``)
   normalizes to its underscored canonical form.
3. ``None`` (typical MCQ items) still parses.
4. A genuinely invalid value raises ``ValidationError`` — fail-loud
   contract from ADR-019 §D10 / Senior Engineer Bar.
5. ``_resolve_item_type`` collapses every Literal-accepted writing
   variant onto one of the four ``topik_item_type`` Postgres enum
   members (migration 005).

See:
- ``Repository/db/docs/REVIEW_FIXES_FU_NF.md`` §B1 (regression report)
- ``Repository/db/docs/FIX_REPORT_FU_NF.md`` §FU-NF-7 (fix log)
- ``FOLLOW_UPS.md`` FU-NF-7 (status)
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from loaders.load_topik import _resolve_item_type  # type: ignore
from loaders.models import TopikItemModel  # type: ignore


_CANONICAL_UNDERSCORED_TYPES = [
    "short_answer_blanks",
    "short_answer_cloze",
    "blank_fill",
    "sentence_completion",
    "complete_the_sentence",
    "chart_description",
    "data_description",
    "essay",
]

# Drawn from the actual writing JSONs in ``output/`` (2026-05-29 census).
_HYPHENATED_TO_NORMALIZED = {
    "short-answer-cloze": "short_answer_cloze",
    "blank-fill": "blank_fill",
    "sentence-completion": "sentence_completion",
    "complete-the-sentence": "complete_the_sentence",
    "chart-description": "chart_description",
    "data-description": "data_description",
}


def _make_item(type_value: Any) -> dict[str, Any]:
    return {
        "id": "topik99-write-001",
        "number": 1,
        "type": type_value,
    }


@pytest.mark.parametrize("canonical", _CANONICAL_UNDERSCORED_TYPES)
def test_topik_item_accepts_canonical_underscored_type(canonical: str) -> None:
    """Every underscored canonical form parses cleanly."""
    item = TopikItemModel.model_validate(_make_item(canonical))
    assert item.type == canonical


@pytest.mark.parametrize(
    "hyphenated,normalized", list(_HYPHENATED_TO_NORMALIZED.items())
)
def test_topik_item_normalizes_hyphenated_type(
    hyphenated: str, normalized: str
) -> None:
    """Hyphenated forms (used by 4 of 5 production writing JSONs) are
    normalized to underscored before the Literal check. The model
    surfaces the underscored form so downstream consumers see one
    canonical shape."""
    item = TopikItemModel.model_validate(_make_item(hyphenated))
    assert item.type == normalized


def test_topik_item_accepts_none_type() -> None:
    """``None`` means 'infer multiple_choice from options' — must still
    pass validation."""
    item = TopikItemModel.model_validate(_make_item(None))
    assert item.type is None


def test_topik_item_rejects_unknown_underscored_type() -> None:
    """A genuinely invalid value (typo, unknown discriminator) raises
    ``ValidationError`` — the FU-NF-7 fail-loud contract."""
    with pytest.raises(ValidationError) as exc_info:
        TopikItemModel.model_validate(_make_item("nonsense_type"))
    msg_lower = str(exc_info.value).lower()
    assert "type" in msg_lower
    # nonsense_type has no hyphens, so normalization is a no-op and
    # Pydantic's Literal validator rejects it directly.
    assert "nonsense_type" in str(exc_info.value) or "literal" in msg_lower


def test_topik_item_rejects_unknown_hyphenated_type() -> None:
    """Hyphenated typo: normalization runs first (hyphens→underscores),
    then the Literal still rejects. Confirms the validator doesn't
    accidentally rescue garbage by mapping to a known value."""
    with pytest.raises(ValidationError):
        TopikItemModel.model_validate(
            _make_item("totally-made-up-discriminator")
        )


@pytest.mark.parametrize(
    "underscored,expected_db_enum",
    [
        ("short_answer_blanks", "short_answer_blanks"),
        ("short_answer_cloze", "short_answer_blanks"),
        ("blank_fill", "short_answer_blanks"),
        ("sentence_completion", "short_answer_blanks"),
        ("complete_the_sentence", "short_answer_blanks"),
        ("chart_description", "chart_description"),
        ("data_description", "chart_description"),
        ("essay", "essay"),
    ],
)
def test_resolve_item_type_collapses_writing_variants_to_db_enum(
    underscored: str, expected_db_enum: str
) -> None:
    """Every Literal-accepted writing discriminator must map onto one of
    the four ``topik_item_type`` Postgres enum members (migration 005),
    otherwise the DB cast would still fail at insert time."""
    assert _resolve_item_type(underscored, []) == expected_db_enum


def test_resolve_item_type_none_infers_multiple_choice() -> None:
    """``None`` discriminator with options ⇒ MCQ inference."""
    assert _resolve_item_type(None, ["a", "b", "c", "d"]) == "multiple_choice"


def test_topik_item_accepts_full_item_with_hyphenated_type() -> None:
    """End-to-end: a realistic writing item from a production-shape JSON
    (hyphenated ``type``, options absent) parses and surfaces the
    normalized canonical form."""
    raw = {
        "id": "topik47-write-053",
        "number": 53,
        "instruction": "다음을 그래프를 보고 200~300자로 쓰십시오.",
        "prompt": "한국인의 독서량 변화",
        "type": "chart-description",
        "has_image": True,
    }
    item = TopikItemModel.model_validate(raw)
    assert item.type == "chart_description"
    assert _resolve_item_type(item.type, item.options) == "chart_description"
