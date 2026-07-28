"""Alignment-core tests — synthetic transcripts only (no GPU, no DB).

Covers the Phase-2a-proven behaviors the core must reproduce:
  - single-anchor papers: spans run [anchor, next anchor), last -> duration;
  - FORMAT-AWARE paired spans — the passage plays BEFORE the pair's
    marker(s): a combined "N번, M번" announcement spans the between-markers
    region and ends AT its own marker (last pair excludes the outro); the
    singles->pairs TRANSITION content-locates the first pair's passage start
    and trims the neighboring single to end there; an unresolvable
    transition keeps the padded overlapping region and force-flags the pair;
  - a paired UNIT announced as two single markers (TOPIK I format: passage,
    then "25번" ... "26번" with options read aloud) shares one span from the
    located passage start;
  - 정답/부터 segments and non-monotonic stray numbers never anchor;
  - a garbled/missing announcement is recovered via the validation-text
    fallback (marker "stem:N");
  - the confidence gate FLAGS low-match spans (low_confidence), never drops;
  - unit derivation from instruction_group (exactly-2-consecutive = paired,
    unless a stem carries its own dialogue — then singles);
  - input validation fails loudly.
"""

from __future__ import annotations

import pytest

from tools.ingest.topik_audio.segment import (
    DEFAULT_MIN_CONFIDENCE,
    Segment,
    _Covered,
    _trim_preceding,
    align,
    derive_units,
    normalize_korean,
)


def _assert_span_invariants(segments: list[Segment]) -> None:
    """The migration-078 / §5-§6 contract every emitted segment must obey:
    valid geometry, and any overlap flagged on at least one side."""
    for seg in segments:
        assert seg["start_ms"] >= 0, seg
        assert seg["end_ms"] > seg["start_ms"], seg
    for i, a in enumerate(segments):
        for b in segments[i + 1 :]:
            if a["start_ms"] < b["end_ms"] and b["start_ms"] < a["end_ms"]:
                assert a["low_confidence"] or b["low_confidence"], (a, b)

# ---------------------------------------------------------------------------
# Synthetic transcript builders.
# ---------------------------------------------------------------------------


def _words(start_ms: int, text: str, step_ms: int = 300) -> list[dict]:
    """One word dict per whitespace token, spaced ``step_ms`` apart."""
    return [
        {"s": start_ms + i * step_ms, "e": start_ms + i * step_ms + 250, "w": tok}
        for i, tok in enumerate(text.split())
    ]


def _seg(start_ms: int, text: str, *, with_words: bool = True) -> dict:
    return {
        "n": 0,  # renumbered by _transcript
        "s": start_ms,
        "e": start_ms + 900,
        "text": text,
        "words": _words(start_ms, text) if with_words else [],
    }


def _transcript(duration_ms: int, segments: list[dict]) -> dict:
    for i, seg in enumerate(segments):
        seg["n"] = i + 1
    return {"duration_ms": duration_ms, "segments": segments}


def _singles(*numbers: int) -> list[dict]:
    return [{"item_numbers": [n]} for n in numbers]


# ---------------------------------------------------------------------------
# Anchoring + spans.
# ---------------------------------------------------------------------------


def test_single_only_paper_spans_and_last_ends_at_duration() -> None:
    transcript = _transcript(
        100_000,
        [
            _seg(10_000, "1번 여자가 묻습니다"),
            _seg(25_000, "네 알겠습니다"),
            _seg(40_000, "2번 남자가 대답합니다"),
            _seg(70_000, "3번 마지막 문제입니다"),
        ],
    )
    result = align(transcript, _singles(1, 2, 3))
    assert [(s["item_numbers"], s["start_ms"], s["end_ms"]) for s in result.segments] == [
        ([1], 10_000, 40_000),
        ([2], 40_000, 70_000),
        ([3], 70_000, 100_000),
    ]
    assert [s["marker"] for s in result.segments] == ["1번", "2번", "3번"]
    assert result.unresolved_items == []
    assert result.clean_anchor_items == [1, 2, 3]
    assert result.fallback_items == []


PASSAGE_A = "여자 학교 도서관 이용 안내를 말씀드리겠습니다 조용히 이용해 주시기 바랍니다"
PASSAGE_B = "남자 내일 회의 자료를 미리 준비해 주시기 바랍니다 감사합니다 수고하세요"
PASSAGE_C = "여자 주말 봉사 활동 모임에 함께 가시겠어요 할머니들을 도와드리는 모임이에요"


def test_paired_passage_before_marker_and_last_pair_ends_at_marker() -> None:
    # TOPIK II format: [passage A][1,2 marker][passage B][3,4 marker][outro].
    transcript = _transcript(
        60_000,
        [
            _seg(5_000, PASSAGE_A),
            _seg(20_000, "1번, 2번 다음을 듣고 물음에 답하십시오"),
            _seg(21_000, PASSAGE_B),
            _seg(40_000, "3번, 4번 다음을 듣고 물음에 답하십시오"),
            _seg(41_000, "듣기 시험이 끝났습니다"),  # outro — excluded
        ],
    )
    validation = {1: PASSAGE_A, 3: PASSAGE_B}
    result = align(
        transcript, [{"item_numbers": [1, 2]}, {"item_numbers": [3, 4]}], validation
    )
    assert len(result.segments) == 2
    first, second = result.segments
    # Pair 1-2 owns the passage BEFORE its marker (content-located start).
    assert first["item_numbers"] == [1, 2]
    assert (first["start_ms"], first["end_ms"]) == (5_000, 20_000)
    assert first["marker"] == "1번, 2번"
    # Pair 3-4 = the between-markers region, ending AT its own marker: the
    # audio after the LAST pair's marker (the outro) is excluded.
    assert second["item_numbers"] == [3, 4]
    assert (second["start_ms"], second["end_ms"]) == (20_000, 40_000)
    assert second["end_ms"] != transcript["duration_ms"]
    assert not first["low_confidence"] and not second["low_confidence"]


def test_transition_trims_last_single_and_starts_pair_at_passage() -> None:
    # Mixed paper: singles 1-2 (marker first), then the paired tail. The
    # boundary between single 2's audio and pair 3-4's passage has NO
    # marker — it is content-located from the pair's validation text.
    transcript = _transcript(
        50_000,
        [
            _seg(1_000, "1번 우산이 있어요 네 우산이 있어요"),
            _seg(10_000, "2번 오늘 회사에 가요 아니요 내일 집에서 쉬어요"),
            _seg(20_000, PASSAGE_C),  # pair 3-4's passage — no marker before it
            _seg(35_000, "3번, 4번 다음을 듣고 물음에 답하십시오"),
        ],
    )
    result = align(
        transcript,
        [{"item_numbers": [1]}, {"item_numbers": [2]}, {"item_numbers": [3, 4]}],
        {3: PASSAGE_C},
    )
    spans = {tuple(s["item_numbers"]): (s["start_ms"], s["end_ms"]) for s in result.segments}
    assert spans[(1,)] == (1_000, 10_000)
    assert spans[(2,)] == (10_000, 20_000)  # trimmed to the located passage start
    assert spans[(3, 4)] == (20_000, 35_000)  # passage start -> own marker


def test_unresolved_transition_pads_overlapping_and_force_flags() -> None:
    # Same shape, but the pair's passage cannot be located (no validation
    # text): both spans keep the whole region — overlapping, padded, safe —
    # and the pair is force-flagged even though nothing scored it low.
    transcript = _transcript(
        50_000,
        [
            _seg(1_000, "1번 우산이 있어요 네 우산이 있어요"),
            _seg(10_000, "2번 오늘 회사에 가요 아니요 내일 집에서 쉬어요"),
            _seg(20_000, PASSAGE_C),
            _seg(35_000, "3번, 4번 다음을 듣고 물음에 답하십시오"),
        ],
    )
    result = align(
        transcript,
        [{"item_numbers": [1]}, {"item_numbers": [2]}, {"item_numbers": [3, 4]}],
        validation_texts=None,
    )
    spans = {tuple(s["item_numbers"]): (s["start_ms"], s["end_ms"]) for s in result.segments}
    assert spans[(2,)] == (10_000, 35_000)  # keeps its full padded region
    assert spans[(3, 4)] == (10_000, 35_000)  # overlap — nothing lost
    paired = next(s for s in result.segments if s["item_numbers"] == [3, 4])
    assert paired["low_confidence"] is True  # forced by the unresolved split


def test_paired_unit_announced_as_two_singles_topik1_format() -> None:
    # TOPIK I format: shared passage FIRST, then each member announced
    # singly ("1번" ... "2번") with its options read aloud after. The unit
    # spans from the located passage start; the last unit runs to duration
    # (the spoken options after the markers belong to it).
    transcript = _transcript(
        40_000,
        [
            _seg(2_000, PASSAGE_A),
            _seg(20_000, "1번 대답으로 알맞은 것을 고르십시오"),
            _seg(25_000, "2번 들은 내용으로 맞는 것을 고르십시오"),
        ],
    )
    result = align(transcript, [{"item_numbers": [1, 2]}], {1: PASSAGE_A})
    assert len(result.segments) == 1
    seg = result.segments[0]
    assert seg["item_numbers"] == [1, 2]
    assert (seg["start_ms"], seg["end_ms"]) == (2_000, 40_000)
    assert seg["marker"] == "1번, 2번"
    assert seg["low_confidence"] is False


def test_answer_readout_and_range_instruction_never_anchor() -> None:
    transcript = _transcript(
        20_000,
        [
            _seg(1_000, "1번 문제입니다"),
            _seg(2_000, "정답은 2번입니다"),  # answer readout — excluded
            _seg(3_000, "1번부터 2번까지 잘 들으십시오"),  # range — excluded
            _seg(5_000, "2번 진짜 문제입니다"),
        ],
    )
    result = align(transcript, _singles(1, 2))
    assert [(s["item_numbers"][0], s["start_ms"]) for s in result.segments] == [
        (1, 1_000),
        (2, 5_000),
    ]


def test_midtext_buteo_does_not_demote_clean_anchor() -> None:
    # "부터" INSIDE the passage ("서울역부터") must not disqualify a clean
    # anchor: the old anywhere-substring rule demoted such segments to the
    # fallback path (feeding unflagged-overlap recoveries). Only a leading
    # "N번부터/까지" range opener or head-adjacent 정답 excludes.
    transcript = _transcript(
        30_000,
        [
            _seg(1_000, "1번 문제입니다"),
            _seg(10_000, "2번 서울역부터 명동까지 어떻게 갑니까"),
        ],
    )
    result = align(transcript, _singles(1, 2))
    assert [(s["item_numbers"][0], s["start_ms"]) for s in result.segments] == [
        (1, 1_000),
        (2, 10_000),
    ]
    assert result.fallback_items == []


def test_monotonic_stray_low_number_is_ignored() -> None:
    transcript = _transcript(
        50_000,
        [
            _seg(1_000, "1번 첫 문제"),
            _seg(10_000, "2번 둘째 문제"),
            _seg(20_000, "3번 셋째 문제"),
            _seg(30_000, "2번 이라고 잘못 들린 잡음"),  # stray low — ignored
        ],
    )
    result = align(transcript, _singles(1, 2, 3))
    third = result.segments[2]
    assert third["item_numbers"] == [3]
    # The stray "2번" at 30s must not terminate (or re-open) anything: the
    # last real anchor still runs to the end of the audio.
    assert third["end_ms"] == 50_000
    second = result.segments[1]
    assert (second["start_ms"], second["end_ms"]) == (10_000, 20_000)


def test_ordinal_and_each_suffixes_do_not_anchor() -> None:
    transcript = _transcript(
        20_000,
        [
            _seg(1_000, "1번 문제입니다"),
            _seg(4_000, "2번째 이야기를 소개합니다"),  # ordinal — not an anchor
            _seg(6_000, "2번씩 반복해서 들려줍니다"),  # "each" — not an anchor
            _seg(9_000, "2번 진짜 문제입니다"),
        ],
    )
    result = align(transcript, _singles(1, 2))
    assert result.segments[1]["start_ms"] == 9_000


# ---------------------------------------------------------------------------
# Validation-text fallback for gaps.
# ---------------------------------------------------------------------------


def test_garbled_anchor_recovered_via_validation_fallback() -> None:
    passage_2 = "여자 우산이 있어요 남자 네 우산이 있어요 정말 좋은 날씨네요 그렇지요"
    transcript = _transcript(
        80_000,
        [
            _seg(1_000, "1번 첫 문제입니다 잘 들어 보세요"),
            # Item 2's announcement was garbled ("이번" etc.) — no anchor, but
            # the passage words are in the stream for the fallback to find.
            _seg(20_000, f"이번 {passage_2}"),
            _seg(50_000, "3번 셋째 문제입니다"),
        ],
    )
    validation = {2: "여자: 우산이 있어요? 남자: 네, 우산이 있어요. 정말 좋은 날씨네요. 그렇지요."}
    result = align(transcript, _singles(1, 2, 3), validation)
    assert result.unresolved_items == []
    recovered = result.segments[1]
    assert recovered["item_numbers"] == [2]
    assert recovered["marker"] == "stem:2"
    # Recovery lands on a word INSIDE the surrounding gap (after anchor 1,
    # before anchor 3) at the matched passage's position.
    assert 20_000 <= recovered["start_ms"] < 50_000
    assert recovered["end_ms"] == 50_000
    assert result.fallback_items == [2]
    assert result.clean_anchor_items == [1, 3]


def test_gap_without_validation_text_stays_unresolved() -> None:
    transcript = _transcript(
        30_000,
        [_seg(1_000, "1번 문제"), _seg(20_000, "3번 문제")],
    )
    result = align(transcript, _singles(1, 2, 3), validation_texts=None)
    assert result.unresolved_items == [2]
    assert [s["item_numbers"] for s in result.segments] == [[1], [3]]


# ---------------------------------------------------------------------------
# Span invariants: combined-marker merge (BLOCKER-1), recovery trim
# (BLOCKER-2), and the final structural gate (BLOCKER-4).
# ---------------------------------------------------------------------------


def test_combined_marker_over_two_single_units_merges_into_shared_pair() -> None:
    # BLOCKER-1 live repro: the structure says items 3 and 4 are SINGLES but
    # the audio announces one combined "3번, 4번" marker. Pre-fix, both units
    # started at that marker and unit 3 ended there too — a degenerate
    # end_ms == start_ms span ([3] 40000→40000) violating migration 078's
    # CHECK. The combined anchor must merge them into one shared-span pair.
    transcript = _transcript(
        90_000,
        [
            _seg(5_000, "1번 첫 문제입니다"),
            _seg(15_000, "2번 둘째 문제입니다"),
            _seg(25_000, PASSAGE_B),  # the pair's shared passage — no marker
            _seg(40_000, "3번, 4번 다음을 듣고 물음에 답하십시오"),
            _seg(50_000, "5번 다섯째 문제입니다"),
        ],
    )
    result = align(transcript, _singles(1, 2, 3, 4, 5), {3: PASSAGE_B})
    assert result.unresolved_items == []
    spans = {tuple(s["item_numbers"]): (s["start_ms"], s["end_ms"]) for s in result.segments}
    # One shared span for the de-facto pair — passage start to its marker.
    assert spans[(3, 4)] == (25_000, 40_000)
    assert spans[(2,)] == (15_000, 25_000)  # trimmed to the located passage
    assert spans[(5,)] == (50_000, 90_000)
    assert sorted(result.clean_anchor_items) == [1, 2, 3, 4, 5]
    _assert_span_invariants(result.segments)


def test_combined_marker_over_singles_without_validation_stays_valid() -> None:
    # Same shape but NO validation text: the merged pair cannot content-
    # locate its passage, keeps the padded region and is force-flagged —
    # still no degenerate span, and the overlap carries a flag.
    transcript = _transcript(
        90_000,
        [
            _seg(5_000, "1번 첫 문제입니다"),
            _seg(15_000, "2번 둘째 문제입니다"),
            _seg(25_000, PASSAGE_B),
            _seg(40_000, "3번, 4번 다음을 듣고 물음에 답하십시오"),
            _seg(50_000, "5번 다섯째 문제입니다"),
        ],
    )
    result = align(transcript, _singles(1, 2, 3, 4, 5), validation_texts=None)
    assert result.unresolved_items == []
    paired = next(s for s in result.segments if s["item_numbers"] == [3, 4])
    assert paired["low_confidence"] is True
    _assert_span_invariants(result.segments)


def test_recovery_trims_preceding_span_no_unflagged_nesting() -> None:
    # BLOCKER-2 live repro: anchors 1 and 3 resolve, item 2's announcement
    # is garbled and recovered by validation text. Pre-fix, item 1 kept
    # end_ms at anchor 3 (conf 1.0, low=False) so item 2's recovered span
    # sat entirely INSIDE it — item 1's clip ~3x too long, playing Q2.
    passage_2 = "여자 우산이 있어요 남자 네 우산이 있어요 정말 좋은 날씨네요 그렇지요"
    transcript = _transcript(
        80_000,
        [
            _seg(1_000, "1번 첫 문제입니다 잘 들어 보세요"),
            _seg(20_300, f"이번 {passage_2}"),  # garbled announcement
            _seg(50_000, "3번 셋째 문제입니다"),
        ],
    )
    validation = {
        1: "첫 문제입니다. 잘 들어 보세요.",  # scores high -> UNFLAGGED pre-fix
        2: "여자: 우산이 있어요? 남자: 네, 우산이 있어요. 정말 좋은 날씨네요. 그렇지요.",
        3: "셋째 문제입니다.",
    }
    result = align(transcript, _singles(1, 2, 3), validation)
    assert result.unresolved_items == []
    first, recovered, third = result.segments
    assert recovered["marker"] == "stem:2"
    # The preceding span now ENDS where the recovery starts — no nesting.
    assert first["end_ms"] == recovered["start_ms"]
    assert first["start_ms"] < first["end_ms"]
    assert first["low_confidence"] is False  # trimmed span still scores high
    assert third["item_numbers"] == [3]
    _assert_span_invariants(result.segments)


def test_trim_preceding_pair_members_flag_when_untrimmable() -> None:
    # Pair members share one window — both trimmed together.
    covered = {
        1: _Covered(1_000, 50_000, "1번, 2번", via_fallback=False),
        2: _Covered(1_000, 50_000, "1번, 2번", via_fallback=False),
    }
    _trim_preceding(covered, 3, 20_000)
    assert covered[1].end_ms == 20_000
    assert covered[2].end_ms == 20_000
    # A boundary AT the window's start cannot trim (end == start would be
    # invalid) — the window is force-flagged instead, never silently left.
    covered = {1: _Covered(10_000, 30_000, "1번", via_fallback=False)}
    _trim_preceding(covered, 2, 10_000)
    assert covered[1].end_ms == 30_000
    assert covered[1].forced_low is True
    # No overlap with the boundary — untouched.
    covered = {1: _Covered(1_000, 15_000, "1번", via_fallback=False)}
    _trim_preceding(covered, 2, 20_000)
    assert covered[1] == _Covered(1_000, 15_000, "1번", via_fallback=False)


def test_full_mixed_paper_all_segments_satisfy_invariants() -> None:
    # Property-style sweep over a full singles -> combined pairs -> single
    # paper: every emitted span must be valid geometry with no unflagged
    # overlap, whatever path produced it.
    transcript = _transcript(
        200_000,
        [
            _seg(5_000, "1번 우산이 있어요 네 우산이 있어요"),
            _seg(20_000, "2번 오늘 회사에 가요 아니요 내일 집에서 쉬어요"),
            _seg(35_000, PASSAGE_A),
            _seg(60_000, "3번, 4번 다음을 듣고 물음에 답하십시오"),
            _seg(62_000, PASSAGE_B),
            _seg(90_000, "5번, 6번 다음을 듣고 물음에 답하십시오"),
            _seg(95_000, "7번 마지막 문제입니다"),
        ],
    )
    units = [
        {"item_numbers": [1]},
        {"item_numbers": [2]},
        {"item_numbers": [3, 4]},
        {"item_numbers": [5, 6]},
        {"item_numbers": [7]},
    ]
    result = align(transcript, units, {3: PASSAGE_A, 5: PASSAGE_B})
    assert result.unresolved_items == []
    assert len(result.segments) == 5
    _assert_span_invariants(result.segments)


def test_twice_read_passage_transition_picks_first_reading() -> None:
    # TOPIK reads paired passages TWICE: both readings match the validation
    # text near-equally, so a plain argmax can land on the SECOND reading
    # and silently halve the span. The earliest-near-best + forward-walk
    # logic must pin the FIRST reading (seen on the real 60th II, Q21-22).
    transcript = _transcript(
        70_000,
        [
            _seg(1_000, "1번 우산이 있어요 네 우산이 있어요"),
            _seg(15_000, PASSAGE_C),  # FIRST reading — span must start here
            _seg(30_000, PASSAGE_C),  # second reading — argmax alone may pick it
            _seg(45_000, "2번, 3번 다음을 듣고 물음에 답하십시오"),
        ],
    )
    result = align(
        transcript,
        [{"item_numbers": [1]}, {"item_numbers": [2, 3]}],
        {2: PASSAGE_C},
    )
    spans = {tuple(s["item_numbers"]): (s["start_ms"], s["end_ms"]) for s in result.segments}
    assert spans[(2, 3)] == (15_000, 45_000)
    assert spans[(1,)] == (1_000, 15_000)
    _assert_span_invariants(result.segments)


# ---------------------------------------------------------------------------
# Confidence gate.
# ---------------------------------------------------------------------------


def test_confidence_gate_flags_low_match_span_without_dropping_it() -> None:
    good_text = "여자 오늘 날씨가 참 좋네요 남자 네 산책하기 좋은 날입니다 공원에 갈까요"
    transcript = _transcript(
        40_000,
        [
            _seg(1_000, "1번"),
            _seg(2_000, good_text),
            _seg(20_000, "2번"),
            _seg(21_000, "전혀 관계없는 소리가 들립니다"),
        ],
    )
    validation = {
        1: "여자: 오늘 날씨가 참 좋네요. 남자: 네, 산책하기 좋은 날입니다. 공원에 갈까요?",
        2: "지하철 공사로 인한 소음 문제에 대한 안내 방송과 주민 대표의 항의가 이어집니다",
    }
    result = align(transcript, _singles(1, 2), validation, min_confidence=0.5)
    first, second = result.segments
    assert first["confidence"] >= 0.5
    assert first["low_confidence"] is False
    assert second["confidence"] < 0.5
    assert second["low_confidence"] is True  # flagged, NOT dropped
    assert len(result.segments) == 2


def test_missing_validation_text_scores_zero_and_flags() -> None:
    transcript = _transcript(10_000, [_seg(1_000, "1번 문제입니다")])
    result = align(transcript, _singles(1))
    assert result.segments[0]["confidence"] == 0.0
    assert result.segments[0]["low_confidence"] is True


# ---------------------------------------------------------------------------
# Unit derivation from instruction_group.
# ---------------------------------------------------------------------------


def test_derive_units_pairs_exactly_two_consecutive_grouped_items() -> None:
    items = [
        {"number": 1, "instruction_group": "1-3"},
        {"number": 2, "instruction_group": "1-3"},
        {"number": 3, "instruction_group": "1-3"},
        {"number": 4, "instruction_group": "4-5"},
        {"number": 5, "instruction_group": "4-5"},
        {"number": 6, "instruction_group": None},
    ]
    assert derive_units(items) == [
        {"item_numbers": [1]},
        {"item_numbers": [2]},
        {"item_numbers": [3]},
        {"item_numbers": [4, 5]},
        {"item_numbers": [6]},
    ]


def test_derive_units_two_item_group_with_own_dialogues_stays_single() -> None:
    # 35th TOPIK I "5-6": two items sharing a printed instruction but each
    # carrying its OWN dialogue stem — individually announced singles, not a
    # shared-passage pair.
    items = [
        {"number": 5, "instruction_group": "5-6", "stem": "여자: 민수 씨, 저 먼저 갈게요.\n남자: ____"},
        {"number": 6, "instruction_group": "5-6", "stem": "남자: 실례합니다.\n여자: ____"},
        {"number": 25, "instruction_group": "25-26", "stem": "어떤 이야기를 하고 있는지 고르십시오."},
        {"number": 26, "instruction_group": "25-26", "stem": "들은 내용과 같은 것을 고르십시오."},
    ]
    assert derive_units(items) == [
        {"item_numbers": [5]},
        {"item_numbers": [6]},
        {"item_numbers": [25, 26]},  # question-prompt stems — true pair
    ]


def test_derive_units_two_item_group_with_gap_stays_single() -> None:
    items = [
        {"number": 7, "instruction_group": "7-9"},
        {"number": 9, "instruction_group": "7-9"},
    ]
    assert derive_units(items) == [{"item_numbers": [7]}, {"item_numbers": [9]}]


def test_derive_units_rejects_empty_and_non_increasing() -> None:
    with pytest.raises(ValueError):
        derive_units([])
    with pytest.raises(ValueError):
        derive_units(
            [{"number": 2, "instruction_group": None}, {"number": 2, "instruction_group": None}]
        )


# ---------------------------------------------------------------------------
# Input validation + misc.
# ---------------------------------------------------------------------------


def test_align_rejects_bad_transcript_and_bad_units() -> None:
    good_transcript = _transcript(10_000, [_seg(1_000, "1번 문제")])
    with pytest.raises(ValueError):
        align({"duration_ms": 0, "segments": []}, _singles(1))
    with pytest.raises(ValueError):
        align({"duration_ms": 10_000, "segments": "nope"}, _singles(1))
    with pytest.raises(ValueError):
        align(good_transcript, [])
    with pytest.raises(ValueError):
        align(good_transcript, [{"item_numbers": [1, 3]}])  # non-consecutive pair
    with pytest.raises(ValueError):
        align(good_transcript, [{"item_numbers": [2]}, {"item_numbers": [1]}])
    # Malformed segments fail loudly up front — not as silent KeyErrors or
    # inverted spans mid-alignment.
    with pytest.raises(ValueError):  # out of time order
        align(
            {"duration_ms": 10_000, "segments": [{"s": 5_000, "words": []}, {"s": 1_000, "words": []}]},
            _singles(1),
        )
    with pytest.raises(ValueError):  # missing words key
        align({"duration_ms": 10_000, "segments": [{"s": 1_000, "text": "1번 문제"}]}, _singles(1))
    with pytest.raises(ValueError):  # non-int start
        align({"duration_ms": 10_000, "segments": [{"s": "1000", "words": []}]}, _singles(1))


def test_normalize_korean_strips_punctuation_whitespace_and_bogi() -> None:
    assert normalize_korean("여자 : 우산이… 있어요? <보기>") == "여자우산이있어요"
    assert normalize_korean(None) == ""


def test_default_min_confidence_is_the_phase2a_qa_line() -> None:
    assert DEFAULT_MIN_CONFIDENCE == 0.50
