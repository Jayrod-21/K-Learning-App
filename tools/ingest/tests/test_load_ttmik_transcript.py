"""
Tests for the TTMIK full-transcript PARSER (load_ttmik_transcript.py).

PURE tests only, per the brief: they exercise ``parse_script_text`` /
``classify_line`` against a fixture text block shaped like real pypdf output
from the Lesson Scripts PDFs (page furniture, repeated headers across page
breaks, hard-wrapped prose with hyphenation). No Docker, no DB, no pypdf, no
real PDFs — ``extract_pdf_text`` is the only pypdf touchpoint and is not
under test here (migration 036 round-trip is covered by db/tests, and the
DB write path reuses the loader-family runtime already covered by
test_load_ttmik.py's harness).
"""

from __future__ import annotations

import pytest

# Optional dep guard: mirror the sibling loader tests — the module under test
# imports the loader runtime (structlog / psycopg_pool) at module level even
# though the parser itself is pure.
pytest.importorskip("structlog")
pytest.importorskip("psycopg_pool")

from loaders.load_ttmik_transcript import (  # type: ignore  # noqa: E402
    TranscriptLine,
    classify_line,
    parse_script_text,
)

# Shaped like pypdf output: per-page header + license boilerplate injected at
# the top of every page, lesson headers repeating across page breaks,
# hard-wrapped prose ("grati-" / "expen-"), alignment-padded romanization.
FIXTURE_TEXT = """\

Printed December 2013
Levels 1 - 3
TalkToMeInKorean.com - Free Korean Lesson Notes
LEVEL 1 LESSON 1
This PDF is to be used along with the MP3 audio lesson available at TalkToMeInKorean.com.
Please feel free to share TalkToMeInKorean’s free Korean lessons and PDF files with anybody who
is studying Korean. If you have any questions or feedback, visit TalkToMeInKorean.com.
안녕하세요. = Hello. / Hi. / How are you?
안녕+하세요 = 안녕하세요.
[an-nyeong]         [ha-se-yo]
안녕 = well-being, peace, health
감사합니다 is the most commonly used formal way of saying “Thank you.” 감사 means “grati-
tude” and 합니다 means “I do” in 존댓말, polite/formal language, so together it
means “Thank you.”
Sample Conversation
A: 안녕하세요. [annyeong-haseyo]  = Hello.
B: 안녕하세요. [annyeong-haseyo]  = Hi.
TalkToMeInKorean.com - Free Korean Lesson Notes
LEVEL 1 LESSON 1
This PDF is to be used along with the MP3 audio lesson available at TalkToMeInKorean.com.
Please feel free to share TalkToMeInKorean’s free Korean lessons and PDF files with anybody who
is studying Korean. If you have any questions or feedback, visit TalkToMeInKorean.com.
(존댓말) 생각보다 비싸군요. [saeng-gak-bo-da bi-ssa-gun-yo.] = (I see that) it is more expen-
sive than I thought.
TalkToMeInKorean.com - Free Korean Lesson Notes
LEVEL 1 LESSON 2
This PDF is to be used along with the MP3 audio lesson available at TalkToMeInKorean.com.
Please feel free to share TalkToMeInKorean’s free Korean lessons and PDF files with anybody who
is studying Korean. If you have any questions or feedback, visit TalkToMeInKorean.com.
After listening to this lesson, you will be able to answer
that question with either YES or NO in Korean.
네. [ne] = Yes.
"""


@pytest.fixture(scope="module")
def parsed():
    return parse_script_text(FIXTURE_TEXT)


# ---------------------------------------------------------------------------
# Lesson splitting
# ---------------------------------------------------------------------------


def test_splits_lessons_by_level_lesson_header(parsed) -> None:
    assert set(parsed.lessons.keys()) == {(1, 1), (1, 2)}


def test_repeated_header_across_page_break_continues_same_lesson(parsed) -> None:
    # The (존댓말) pair after the second LEVEL 1 LESSON 1 header belongs to
    # lesson (1, 1) — no duplicate block, no new lesson.
    kinds = [ln.kind for ln in parsed.lessons[(1, 1)]]
    assert kinds.count("header") == 1  # only "Sample Conversation"
    assert any(
        ln.korean is not None and ln.korean.startswith("(존댓말)")
        for ln in parsed.lessons[(1, 1)]
    )


def test_preamble_before_first_header_is_skipped_not_stored(parsed) -> None:
    # "Printed December 2013" / "Levels 1 - 3" are boilerplate; nothing before
    # the first header may leak into any lesson.
    first = parsed.lessons[(1, 1)][0]
    assert first == TranscriptLine(
        kind="pair", korean="안녕하세요.", english="Hello. / Hi. / How are you?"
    )


def test_page_boilerplate_never_stored(parsed) -> None:
    all_text = " ".join(
        (ln.korean or "") + " " + (ln.english or "")
        for lines in parsed.lessons.values()
        for ln in lines
    )
    assert "TalkToMeInKorean" not in all_text
    assert "MP3 audio lesson" not in all_text


# ---------------------------------------------------------------------------
# Classification + korean/english split
# ---------------------------------------------------------------------------


def test_pair_splits_on_first_separator_korean_left_english_right(parsed) -> None:
    lines = parsed.lessons[(1, 1)]
    assert TranscriptLine(
        kind="pair", korean="안녕", english="well-being, peace, health"
    ) in lines
    # Formation line: right side may itself be Korean — stored verbatim.
    assert TranscriptLine(
        kind="pair", korean="안녕+하세요", english="안녕하세요."
    ) in lines


def test_romanization_lines_are_dropped(parsed) -> None:
    # No romanization anywhere (user directive): standalone bracket lines are
    # dropped from the parsed output entirely.
    roman = [ln for ln in parsed.lessons[(1, 1)] if ln.kind == "romanization"]
    assert roman == []


def test_dialog_lines_strip_inline_romanization(parsed) -> None:
    # Inline "[annyeong-haseyo]" romanization is stripped from the Korean side.
    dialog = [ln for ln in parsed.lessons[(1, 1)] if ln.kind == "dialog"]
    assert dialog == [
        TranscriptLine(kind="dialog", korean="A: 안녕하세요.", english="Hello."),
        TranscriptLine(kind="dialog", korean="B: 안녕하세요.", english="Hi."),
    ]


def test_section_title_becomes_header(parsed) -> None:
    headers = [ln for ln in parsed.lessons[(1, 1)] if ln.kind == "header"]
    assert headers == [
        TranscriptLine(kind="header", korean=None, english="Sample Conversation")
    ]


def test_wrapped_prose_merges_and_dehyphenates(parsed) -> None:
    prose = [ln for ln in parsed.lessons[(1, 1)] if ln.kind == "prose"]
    assert len(prose) == 1  # three physical lines → one paragraph
    text = prose[0].korean or ""
    assert "gratitude" in text  # "grati-" + "tude" repaired
    assert "grati- tude" not in text
    assert text.endswith("means “Thank you.”")
    # Contains Hangul → stored in the korean column, english NULL.
    assert prose[0].english is None


def test_wrapped_pair_tail_reattaches_to_english_side(parsed) -> None:
    # "... more expen-" + "sive than I thought." is ONE pair line.
    pair = [
        ln
        for ln in parsed.lessons[(1, 1)]
        if ln.korean is not None and ln.korean.startswith("(존댓말)")
    ]
    assert len(pair) == 1
    assert pair[0].kind == "pair"
    assert pair[0].english == "(I see that) it is more expensive than I thought."


def test_english_only_prose_lands_in_english_column(parsed) -> None:
    prose = [ln for ln in parsed.lessons[(1, 2)] if ln.kind == "prose"]
    assert prose == [
        TranscriptLine(
            kind="prose",
            korean=None,
            english=(
                "After listening to this lesson, you will be able to answer "
                "that question with either YES or NO in Korean."
            ),
        )
    ]


def test_every_line_has_text_and_valid_kind(parsed) -> None:
    # Mirrors ck_ttmik_transcript_lines_has_text + ck_..._kind: the parser
    # must never emit a row the migration would reject.
    valid = {"header", "pair", "romanization", "prose", "dialog"}
    for lines in parsed.lessons.values():
        assert lines, "a matched lesson block must not be empty"
        for ln in lines:
            assert ln.kind in valid
            assert (ln.korean is not None and ln.korean != "") or (
                ln.english is not None and ln.english != ""
            )


# ---------------------------------------------------------------------------
# classify_line unit cases (context-free kinds)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        # Inline romanization ([ga-da], [gal-su-rok]) is stripped from the Korean.
        (
            "가다 [ga-da] --> 갈수록 [gal-su-rok] = the more you go, the more ...",
            TranscriptLine(
                kind="pair",
                korean="가다 --> 갈수록",
                english="the more you go, the more ...",
            ),
        ),
        # First-separator split: the remainder stays intact on the right.
        (
            "맛있다 [ma-sit-da] = 맛있 + -을수록 = 맛있을수록",
            TranscriptLine(
                kind="pair", korean="맛있다", english="맛있 + -을수록 = 맛있을수록"
            ),
        ),
        # Dialog without a translation half.
        (
            "A: 안녕하세요.",
            TranscriptLine(kind="dialog", korean="A: 안녕하세요.", english=None),
        ),
        # '=' without surrounding spaces never splits (prose with notation).
        (
            "In Korean A=B is not a translation pattern.",
            TranscriptLine(
                kind="prose",
                korean=None,
                english="In Korean A=B is not a translation pattern.",
            ),
        ),
        # English-only speaker-ish line: no Hangul → prose, not dialog.
        (
            "A: Hello.",
            TranscriptLine(kind="prose", korean=None, english="A: Hello."),
        ),
        # Hangul-bearing standalone line without a separator → prose in korean.
        (
            "네 / 아니요",
            TranscriptLine(kind="prose", korean="네 / 아니요", english=None),
        ),
    ],
)
def test_classify_line_cases(line: str, expected: TranscriptLine) -> None:
    assert classify_line(line) == expected


def test_no_headers_yields_empty_lessons_and_counts_preamble() -> None:
    parsed = parse_script_text("just some stray text\nwith no lesson headers\n")
    assert parsed.lessons == {}
    assert parsed.preamble_lines == 2


@pytest.mark.parametrize(
    "text,expected",
    [
        # Romanization STRIPPED — including particle romanizations that lead with
        # a hyphen or paren (these leaked past the old "[A-Za-z]" heuristic).
        ("안녕하세요. [an-nyeong-ha-se-yo]", "안녕하세요."),
        ("-도 [-do]", "-도"),
        ("-고 싶어요 [-go si-peo-yo] means", "-고 싶어요 means"),
        ("(이)랑 [(i)rang]", "(이)랑"),
        ("이상해요 [i-sang-hae-yo) mangled", "이상해요 mangled"),  # OCR-mangled ')' close
        # Romanization carrying the source's punctuation (?, /, +) — still stripped.
        ("커피 좋아해요? [keo-pi jo-a-hae-yo?]", "커피 좋아해요?"),
        ("이에요 / 예요 [i-e-yo / ye-yo] role", "이에요 / 예요 role"),
        ("가방 + 이에요 [ga-bang + i-e-yo]", "가방 + 이에요"),
        # English annotation labels KEPT — the old heuristic corrupted these.
        ("the [noun] goes", "the [noun] goes"),
        ("[verb] and [past tense]", "[verb] and [past tense]"),
        ("[honorific] form", "[honorific] form"),
        ("닫다 [Original verb: 닫다 = to close]", "닫다 [Original verb: 닫다 = to close]"),
        ("[noun] + 을/를", "[noun] + 을/를"),
        # Un-hyphenated single-syllable / short romanization — the shape the hyphen
        # heuristic missed at scale (243/303 rows). Now stripped by the allow-list.
        ("네. [ne]", "네."),
        ("이 [i]", "이"),
        ("가 [ga]", "가"),
        ("아니요 [aniyo]", "아니요"),
        ("존댓말 [jondaetmal] polite", "존댓말 polite"),
        ("일 [il = one]", "일"),  # romanization = number gloss
        # Grammar-ending romanizations led by "-(" markers, e.g. -(으)ㄹ.
        ("것 [-(eu)l geo-ye-yo]", "것"),
        ("을 [-(eu)l]", "을"),
        ("이라고 [-(i)ra-go]", "이라고"),
        # More labels / pattern slots / English prose fragments KEPT.
        ("A [subject marker] B", "A [subject marker] B"),
        ("pattern [A] + [B]", "pattern [A] + [B]"),
        ("means [a friend and a movie].", "means [a friend and a movie]."),
        ("register [polite/formal]", "register [polite/formal]"),
    ],
)
def test_strip_inline_rom_strips_romanization_keeps_labels(text: str, expected: str) -> None:
    from loaders.load_ttmik_transcript import _strip_inline_rom

    assert _strip_inline_rom(text) == expected
