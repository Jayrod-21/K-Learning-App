"""
Unit tests for the canonical-grammar normalizer.

These tests are PURE — no DB, no filesystem. They exercise the contract
that the dedup key collapses surface variation correctly.

Covers:
    * ㅏ/ㅓ alternation surfaces ("-아/어도", "-아/어요").
    * Parenthesized (으)/(이) morphophonological alternations.
    * Leading A/V/N placeholder + hyphen stripping.
    * Bare leading hyphen stripping.
    * NBSP / invisible character handling.
    * Trailing circled-digit ordinal stripping (polysemy markers).
    * Multi-form compound patterns split into component keys.
    * Idempotence (normalize(normalize(x)) == normalize(x)).
    * Semantic family classifier baseline behaviour.
"""

from __future__ import annotations

import pytest

# conftest.py adds Repository/tools/ingest/ to sys.path, so the bare module
# name imports cleanly without requiring an installed package.
from canonical_grammar import (  # type: ignore[import-not-found]
    classify_semantic_family,
    normalize_pattern,
    pick_canonical_surface,
    split_compound_pattern,
)


# ---------------------------------------------------------------------------
# normalize_pattern
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Plain forms keep the meaningful content.
        ("A/V-아/어도", "아/어도"),
        ("-아/어도", "아/어도"),
        ("아/어도", "아/어도"),
        # (으) parenthesised morphophonology preserved.
        ("A/V-(으)면", "(으)면"),
        ("-(으)면", "(으)면"),
        ("V-(으)니까", "(으)니까"),
        # Ordinal markers (polysemy) collapse to the same key.
        ("A/V-(으)니까 ①", "(으)니까"),
        ("V-(으)니까 ②", "(으)니까"),
        ("A/V-(으)ㄴ/는데 ①", "(으)ㄴ/는데"),
        ("A/V-(으)ㄴ/는데 ②", "(으)ㄴ/는데"),
        # Trailing whitespace stripped.
        ("  A/V-아/어요  ", "아/어요"),
        # Empty string is fine.
        ("", ""),
        # Bare placeholder + hyphen-only pattern (degenerate).
        ("V-", ""),
        # N-prefixed patterns.
        ("N처럼", "처럼"),
        ("N의", "의"),
        # Patterns that contain Korean morpheme placeholders but no hyphen.
        ("스럽다", "스럽다"),
        ("얼마나 -(으)ㄴ/는지 모르다", "얼마나 -(으)ㄴ/는지 모르다"),
    ],
)
def test_normalize_pattern_canonical_cases(raw: str, expected: str) -> None:
    assert normalize_pattern(raw) == expected


def test_normalize_pattern_strips_nbsp() -> None:
    # The literal NBSP character (U+00A0) appears in OCR'd source data and
    # would otherwise produce a distinct key from the regular-space version.
    nbsp = " "
    assert normalize_pattern(f"A/V-아/어도{nbsp}①") == "아/어도"
    assert normalize_pattern(f"-아/어도{nbsp}") == "아/어도"


def test_normalize_pattern_strips_zero_width_chars() -> None:
    # Vision-OCR pipelines have been seen to inject ZWSP into Korean strings.
    zwsp = "​"
    assert normalize_pattern(f"A/V-{zwsp}아/어도") == "아/어도"


def test_normalize_pattern_unicode_nfc_normalised() -> None:
    # Decomposed jamo: ㅇ + ㅏ. NFC composes them to 아.
    decomposed = "아/어도"  # ㅇㅏ/ㅇㅓ도
    composed = "아/어도"
    assert normalize_pattern(decomposed) == composed


def test_normalize_pattern_idempotent() -> None:
    """normalize(normalize(x)) == normalize(x) — the contract that lets us
    re-run the clusterer without churn."""
    cases = [
        "A/V-아/어도",
        "A/V-(으)니까 ①",
        "  N 처럼  ",
        "",
        "-(으)ㄴ/는데도",
    ]
    for raw in cases:
        once = normalize_pattern(raw)
        twice = normalize_pattern(once)
        assert once == twice, f"not idempotent for {raw!r}: {once!r} -> {twice!r}"


def test_normalize_pattern_rejects_non_string() -> None:
    with pytest.raises(TypeError):
        normalize_pattern(None)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        normalize_pattern(42)  # type: ignore[arg-type]


def test_normalize_pattern_circled_digits_full_range() -> None:
    # All circled ASCII digits should be stripped, not just ① / ②.
    for marker in "①②③④⑤⑥⑦⑧⑨⑩":
        assert normalize_pattern(f"-아/어요 {marker}") == "아/어요"


def test_normalize_pattern_en_dash_em_dash_treated_as_hyphen() -> None:
    # Vision OCR sometimes substitutes en-dash or em-dash for "-" in
    # pattern strings. The normalizer treats them as the leading hyphen.
    assert normalize_pattern("–아/어도") == "아/어도"   # en-dash
    assert normalize_pattern("—아/어도") == "아/어도"   # em-dash
    assert normalize_pattern("A/V–아/어도") == "아/어도"  # placeholder + en-dash


# ---------------------------------------------------------------------------
# split_compound_pattern
# ---------------------------------------------------------------------------


def test_split_compound_pattern_multi_form_with_N_placeholder() -> None:
    # The headline test: "-와/과, N(이)랑, N하고" should split into 3 keys.
    keys = split_compound_pattern("N와/과, N(이)랑, N하고")
    assert keys == ["와/과", "(이)랑", "하고"]


def test_split_compound_pattern_single_form_returns_singleton() -> None:
    assert split_compound_pattern("A/V-아/어도") == ["아/어도"]


def test_split_compound_pattern_empty_returns_empty() -> None:
    assert split_compound_pattern("") == []
    assert split_compound_pattern("   ") == []


def test_split_compound_pattern_drops_empty_components() -> None:
    # Trailing comma must not produce a phantom empty key.
    assert split_compound_pattern("A/V-아/어요, ") == ["아/어요"]


def test_split_compound_pattern_keeps_intra_form_slashes() -> None:
    # The "/" in "아/어" is a morphophonology marker, NOT a list separator.
    keys = split_compound_pattern("A/V-아/어도")
    assert keys == ["아/어도"]
    # Multi-form with placeholder N + alternations inside each.
    keys = split_compound_pattern("N에서 N까지, N부터 N까지")
    assert keys == ["에서 N까지", "부터 N까지"]


def test_split_compound_pattern_handles_cjk_comma() -> None:
    # Source data uses both Latin "," and CJK "、" / fullwidth "，".
    assert split_compound_pattern("N처럼，N같이") == ["처럼", "같이"]
    assert split_compound_pattern("N처럼、N같이") == ["처럼", "같이"]


# ---------------------------------------------------------------------------
# pick_canonical_surface
# ---------------------------------------------------------------------------


def test_pick_canonical_surface_prefers_placeholder_over_bare() -> None:
    # "A/V-아/어도" is the most fully-formed presentation.
    chosen = pick_canonical_surface(["아/어도", "-아/어도", "A/V-아/어도"])
    assert chosen == "A/V-아/어도"


def test_pick_canonical_surface_prefers_dash_over_bare() -> None:
    chosen = pick_canonical_surface(["아/어도", "-아/어도"])
    assert chosen == "-아/어도"


def test_pick_canonical_surface_empty_input() -> None:
    assert pick_canonical_surface([]) == ""
    assert pick_canonical_surface(["", ""]) == ""


def test_pick_canonical_surface_deterministic_tiebreak() -> None:
    # Two equally-shaped options must produce the SAME choice every run.
    a = pick_canonical_surface(["A/V-X", "A/V-Y"])
    b = pick_canonical_surface(["A/V-Y", "A/V-X"])
    assert a == b


# ---------------------------------------------------------------------------
# classify_semantic_family
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "category,title,pattern,family",
    [
        ("conjecture", None, None, "conjecture"),
        ("Conjecture", None, None, "conjecture"),
        ("contrast", None, None, "concession"),
        ("speech_style", None, None, "speech_style"),
        ("particle", None, None, "particle"),
        # Title fallback.
        (None, "Expressing concession", None, "concession"),
        (None, "Even though", None, "concession"),
        (None, "When", None, "time"),
        # Pattern-only fallback.
        (None, None, "-아/어 보이다 — looks", "conjecture"),
        # Nothing matches.
        (None, None, None, "uncategorized"),
        (None, "totally novel concept", "obscure", "uncategorized"),
    ],
)
def test_classify_semantic_family(
    category: str | None, title: str | None, pattern: str | None, family: str
) -> None:
    assert classify_semantic_family(
        category=category, title_en=title, pattern=pattern
    ) == family
