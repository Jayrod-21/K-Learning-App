"""Unit tests for parse_ttmik's lesson-merge (F-UP-009).

`_merge_units_by_lesson` is the durable fix for the duplicate-ordinal bug: a
lesson re-declared non-contiguously in the PDF (e.g. a "Word Builder" appendix)
produced two Units with the same (level, lesson), each numbering its sentences
from 1 — colliding once both landed under the same ttmik_lessons row.
"""

from __future__ import annotations

from parse_ttmik import Sentence, Unit, _merge_units_by_lesson


def _sent(korean: str, ordinal: int) -> Sentence:
    return Sentence(ordinal=ordinal, korean=korean, english="")


def test_merge_collapses_noncontiguous_same_lesson_and_resequences():
    """A grammar block + a later Word Builder appendix for the SAME lesson merge
    into one Unit whose sentences carry contiguous, unique 1..N ordinals."""
    units = [
        Unit(
            ordinal=1,
            level=6,
            lesson=12,
            title="Grammar",
            sentences=[_sent("가", 1), _sent("나", 2)],
        ),
        Unit(
            ordinal=2,
            level=6,
            lesson=13,
            title="Other lesson",
            sentences=[_sent("다", 1)],
        ),
        # Word Builder appendix RE-DECLARES L6L12, numbering from 1 again.
        Unit(
            ordinal=3,
            level=6,
            lesson=12,
            title="Word Builder",
            sentences=[_sent("라", 1), _sent("마", 2)],
        ),
    ]

    merged = _merge_units_by_lesson(units)

    # L6L12's two blocks collapsed into one; L6L13 untouched → 2 units total.
    assert len(merged) == 2
    l612 = next(u for u in merged if (u.level, u.lesson) == (6, 12))
    # First occurrence's identity (ordinal + title) is kept.
    assert l612.ordinal == 1
    assert l612.title == "Grammar"
    # All four sentences, in first-seen order, re-sequenced 1..4 (was 1,2,1,2).
    assert [s.korean for s in l612.sentences] == ["가", "나", "라", "마"]
    assert [s.ordinal for s in l612.sentences] == [1, 2, 3, 4]
    # No lesson may carry a duplicate ordinal after the merge.
    for u in merged:
        ords = [s.ordinal for s in u.sentences]
        assert len(ords) == len(set(ords)), f"dup ordinals in L{u.level}L{u.lesson}"


def test_merge_is_noop_for_already_unique_lessons():
    """When every lesson is distinct, the merge preserves order + content and
    leaves each lesson's already-contiguous ordinals intact."""
    units = [
        Unit(
            ordinal=1,
            level=1,
            lesson=1,
            title="A",
            sentences=[_sent("가", 1), _sent("나", 2)],
        ),
        Unit(
            ordinal=2,
            level=1,
            lesson=2,
            title="B",
            sentences=[_sent("다", 1)],
        ),
    ]

    merged = _merge_units_by_lesson(units)

    assert len(merged) == 2
    assert [(u.level, u.lesson) for u in merged] == [(1, 1), (1, 2)]
    assert [s.ordinal for s in merged[0].sentences] == [1, 2]
    assert [s.korean for s in merged[0].sentences] == ["가", "나"]
