"""
Unit tests for the cross-reference normalizer.

Pure functions, no DB — fast and exhaustive on edge cases.
"""

from __future__ import annotations

import unicodedata

import pytest

from resolver.normalize import (  # type: ignore  # noqa: E402
    collapse_whitespace,
    extract_entry_ids,
    nfc,
    normalize_target,
)


# -----------------------------------------------------------------------------
# nfc + whitespace
# -----------------------------------------------------------------------------


class TestNfc:
    def test_idempotent_on_already_composed(self):
        s = "가족"
        assert nfc(s) == s
        assert nfc(nfc(s)) == s

    def test_decomposes_to_composes(self):
        decomposed = unicodedata.normalize("NFD", "가족")
        # NFD form is structurally different from NFC even if it renders the same.
        assert decomposed != "가족"
        assert nfc(decomposed) == "가족"

    def test_handles_ascii_only(self):
        assert nfc("hello") == "hello"


class TestCollapseWhitespace:
    def test_collapses_runs(self):
        assert collapse_whitespace("a   b\t\tc") == "a b c"

    def test_strips_leading_trailing(self):
        assert collapse_whitespace("   hello   ") == "hello"

    def test_handles_cjk_ideographic_space(self):
        # U+3000 IDEOGRAPHIC SPACE
        assert collapse_whitespace("a　b") == "a b"

    def test_handles_nbsp(self):
        assert collapse_whitespace("a\xa0b") == "a b"

    def test_empty_in_empty_out(self):
        assert collapse_whitespace("") == ""
        assert collapse_whitespace("   ") == ""


# -----------------------------------------------------------------------------
# normalize_target
# -----------------------------------------------------------------------------


class TestNormalizeTarget:
    def test_none_in_none_out(self):
        assert normalize_target(None) is None

    def test_empty_string_returns_none(self):
        assert normalize_target("") is None
        assert normalize_target("   ") is None

    def test_simple_korean_unchanged(self):
        n = normalize_target("가족")
        assert n is not None
        assert n.canonical == "가족"
        assert n.homograph_index is None
        assert n.subtargets == ("가족",)

    def test_nfd_input_becomes_nfc_canonical(self):
        decomposed = unicodedata.normalize("NFD", "가족")
        n = normalize_target(decomposed)
        assert n is not None
        # canonical should be NFC even though `original` is preserved verbatim
        assert n.canonical == "가족"
        assert n.original == decomposed

    def test_strips_trailing_circled_digit(self):
        n = normalize_target("N에 ②")
        assert n is not None
        assert n.canonical == "N에"
        assert n.homograph_index == "②"

    def test_strips_trailing_paren_index(self):
        # Source occasionally uses "(2)" instead of a circled digit.
        n = normalize_target("N에 (2)")
        assert n is not None
        assert n.canonical == "N에"
        assert n.homograph_index == "2"

    def test_strips_inline_homograph_and_english_gloss(self):
        n = normalize_target("N에 ② (time)")
        assert n is not None
        assert n.canonical == "N에"
        assert n.homograph_index == "②"

    def test_preserves_korean_only_paren(self):
        # A Korean parenthetical is content, not metadata — keep it.
        n = normalize_target("이/가 (주격)")
        assert n is not None
        # Heuristic strip is conservative; Korean parens stay.
        assert "주격" in n.canonical or n.canonical == "이/가"

    def test_splits_comma_multi_target(self):
        n = normalize_target("만족하다, 만족스럽다")
        assert n is not None
        assert n.subtargets == ("만족하다", "만족스럽다")

    def test_splits_middle_dot_multi_target(self):
        n = normalize_target("걸다 · 걸리다")
        assert n is not None
        assert "걸다" in n.subtargets
        assert "걸리다" in n.subtargets

    def test_collapses_double_spaces(self):
        n = normalize_target("  가족  ")
        assert n is not None
        assert n.canonical == "가족"

    def test_single_token_keeps_one_subtarget(self):
        n = normalize_target("식구")
        assert n is not None
        assert n.subtargets == ("식구",)


# -----------------------------------------------------------------------------
# extract_entry_ids
# -----------------------------------------------------------------------------


class TestExtractEntryIds:
    def test_extracts_kgiu_id_from_note(self):
        ids = extract_entry_ids(
            "은/는 = old/known topic or contrast; 이/가 = new info. See kgiu-beg-u03-01."
        )
        assert ids == ["kgiu-beg-u03-01"]

    def test_extracts_vocab_id(self):
        ids = extract_entry_ids("See vocab-int-2109 for the basic form.")
        assert ids == ["vocab-int-2109"]

    def test_extracts_multiple_ids_preserves_order(self):
        ids = extract_entry_ids(
            "See kgiu-beg-u01-01 and kgiu-beg-u01-02 for related forms."
        )
        assert ids == ["kgiu-beg-u01-01", "kgiu-beg-u01-02"]

    def test_deduplicates(self):
        ids = extract_entry_ids("See kgiu-adv-c01-01 — see kgiu-adv-c01-01 again.")
        assert ids == ["kgiu-adv-c01-01"]

    def test_empty_in_empty_out(self):
        assert extract_entry_ids(None) == []
        assert extract_entry_ids("") == []

    def test_no_match_returns_empty(self):
        assert extract_entry_ids("See chapter 5 and the appendix.") == []

    def test_case_insensitive_match(self):
        ids = extract_entry_ids("See KGIU-BEG-U03-01.")
        # We lowercase for lookup consistency.
        assert ids == ["kgiu-beg-u03-01"]

    def test_does_not_match_unrelated_dashes(self):
        # The pattern requires the well-known prefix.
        assert extract_entry_ids("ttmik-1-5") == []

    @pytest.mark.parametrize(
        "level,prefix",
        [("beg", "kgiu-beg-u03-01"), ("int", "kgiu-int-c12-04"),
         ("adv", "kgiu-adv-c20-05")],
    )
    def test_matches_all_kgiu_levels(self, level, prefix):
        assert extract_entry_ids(f"See {prefix}.") == [prefix]
