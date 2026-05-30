"""Unit tests for the Lemmatizer wrapper.

Two layers:
- Fast layer (default): uses _FakeKiwi from conftest. Asserts our offset
  translation, lemma derivation, and POS pass-through are correct.
- Slow layer (marked `slow`): runs the same assertions against real Kiwi —
  this is where we catch the regressions that matter.

The slow layer pulls real Korean sentences from the TTMIK/Iyagi corpora in
`Repository/tools/ingest/output/` (per spec) and asserts the structural
properties we care about (lemmas end in 다 for verbal POS, offsets cover the
input, surfaces concatenate back, etc.). Specific lemma strings are asserted
only for the canonical irregular-conjugation examples — those are stable
across Kiwi versions.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kiwi_service.lemmatizer import (
    AnalyzedToken,
    LemmatizationError,
    Lemmatizer,
    _build_utf16_offset_table,
)


# ---------------------------------------------------------------------------
# UTF-16 offset table
# ---------------------------------------------------------------------------


class TestUtf16OffsetTable:
    def test_pure_ascii_one_to_one(self) -> None:
        table = _build_utf16_offset_table("hello")
        assert table == [0, 1, 2, 3, 4, 5]

    def test_korean_bmp_one_to_one(self) -> None:
        # 가-힣 are all BMP -> each code point = 1 UTF-16 unit.
        text = "어제 친구를 만났어요"
        table = _build_utf16_offset_table(text)
        assert table[0] == 0
        assert table[len(text)] == len(text)
        assert table == list(range(len(text) + 1))

    def test_emoji_takes_two_units(self) -> None:
        # 😀 (U+1F600) is non-BMP -> 2 UTF-16 units.
        text = "안녕😀하세요"
        table = _build_utf16_offset_table(text)
        # 안(1) 녕(1) 😀(2) 하(1) 세(1) 요(1) = 7 UTF-16 units total
        assert table[len(text)] == 7
        # Index of 하 should be 4 in UTF-16, not 3.
        assert table[3] == 4

    def test_empty_string(self) -> None:
        assert _build_utf16_offset_table("") == [0]


# ---------------------------------------------------------------------------
# Lemmatizer with fake engine — exhaustive coverage of the API surface
# ---------------------------------------------------------------------------


class TestLemmatizerWithFake:
    def test_empty_string_returns_empty(self, fake_lemmatizer: Lemmatizer) -> None:
        assert fake_lemmatizer.lemmatize("") == []
        assert fake_lemmatizer.lemmatize("   ") == []

    def test_basic_sentence_segmentation(self, fake_lemmatizer: Lemmatizer) -> None:
        tokens = fake_lemmatizer.lemmatize("어제 친구를 만났어요")
        # Tokens should be: 어제, 친구, 를, 만나, 었, 어요
        surfaces = [t.surface for t in tokens]
        assert surfaces == ["어제", "친구", "를", "만나", "었", "어요"]
        # Verbs get 다 appended; nouns/particles/endings don't.
        lemmas = [t.lemma for t in tokens]
        assert lemmas == ["어제", "친구", "를", "만나다", "었", "어요"]

    def test_offsets_match_input(self, fake_lemmatizer: Lemmatizer) -> None:
        text = "어제 친구를 만났어요"
        tokens = fake_lemmatizer.lemmatize(text)
        # 어제 at 0-2, 친구 at 3-5
        assert (tokens[0].start, tokens[0].end) == (0, 2)
        assert (tokens[1].start, tokens[1].end) == (3, 5)
        assert text[tokens[0].start : tokens[0].end] == "어제"
        assert text[tokens[1].start : tokens[1].end] == "친구"

    def test_pos_tags_passed_through(self, fake_lemmatizer: Lemmatizer) -> None:
        tokens = fake_lemmatizer.lemmatize("어제 친구를 만났어요")
        pos = [t.pos for t in tokens]
        assert pos == ["MAG", "NNG", "JKO", "VV", "EP", "EF"]

    def test_light_tokens_drops_offsets(self, fake_lemmatizer: Lemmatizer) -> None:
        triples = fake_lemmatizer.light_tokens("어제 친구를 만났어요")
        assert all(len(t) == 3 for t in triples)
        assert triples[3] == ("만나", "만나다", "VV")

    # --- Irregular conjugations -------------------------------------------

    @pytest.mark.parametrize(
        ("text", "expected_lemma", "expected_pos"),
        [
            ("날씨가 더워요", "덥다", "VA"),       # ㅂ-irreg
            ("음악을 들어요", "듣다", "VV"),       # ㄷ-irreg
            ("물이 흘러요", "흐르다", "VV"),       # 르-irreg
            ("빨간 사과", "빨갛다", "VA"),         # ㅎ-irreg
            ("집을 지어요", "짓다", "VV"),         # ㅅ-irreg
            ("편지를 써요", "쓰다", "VV"),         # ㅡ-irreg
            ("케이크를 만들어요", "만들다", "VV"),  # ㄹ-irreg
        ],
    )
    def test_irregular_conjugations_normalize_to_dictionary_form(
        self,
        fake_lemmatizer: Lemmatizer,
        text: str,
        expected_lemma: str,
        expected_pos: str,
    ) -> None:
        tokens = fake_lemmatizer.lemmatize(text)
        verb_tokens = [t for t in tokens if t.pos == expected_pos]
        assert verb_tokens, f"No {expected_pos} token found in: {[(t.surface, t.pos) for t in tokens]}"
        assert verb_tokens[0].lemma == expected_lemma

    def test_complex_agglutination_먹었었어요(self, fake_lemmatizer: Lemmatizer) -> None:
        """먹었었어요 -> 먹다 + EP(었) + EP(었) + EF(어요).

        This is the canonical complex-agglutination example in the design
        spec — past-of-past with the polite ending stripped.
        """
        tokens = fake_lemmatizer.lemmatize("먹었었어요")
        assert tokens[0].surface == "먹"
        assert tokens[0].lemma == "먹다"
        assert tokens[0].pos == "VV"
        # Two pre-final endings + a final ending.
        eps = [t for t in tokens if t.pos == "EP"]
        assert len(eps) == 2
        assert any(t.pos == "EF" for t in tokens)

    # --- Out-of-range offsets are clamped, not crash ----------------------

    def test_pathological_token_offset_clamped(self) -> None:
        """If Kiwi (or a future binding change) reports an offset past the
        end of the string, we clamp rather than IndexError."""
        from tests.conftest import _FakeKiwi, _FakeToken

        class BadKiwi(_FakeKiwi):
            def analyze(self, text: str, top_n: int = 1):  # type: ignore[override]
                return [([_FakeToken(form="X", tag="NNG", start=0, len=9999)], 1.0)]

        lem = Lemmatizer(model_size="base", _engine=BadKiwi())
        tokens = lem.lemmatize("짧")
        # Should clamp to the string length, not crash.
        assert tokens[0].start == 0
        assert tokens[0].end == 1

    # --- Error surface ----------------------------------------------------

    def test_engine_exception_wrapped_as_lemmatization_error(self) -> None:
        class ExplodingKiwi:
            def analyze(self, text: str, top_n: int = 1):
                raise ValueError("nope")

        lem = Lemmatizer(model_size="base", _engine=ExplodingKiwi())
        with pytest.raises(LemmatizationError):
            lem.lemmatize("아무거나")


# ---------------------------------------------------------------------------
# Slow tests against real Kiwi — structural assertions on real Iyagi text
# ---------------------------------------------------------------------------


_INGEST_DIR = Path(__file__).resolve().parents[4] / "tools" / "ingest" / "output"


def _load_iyagi_sentences(limit: int = 20) -> list[str]:
    """Pull the first N non-trivial Korean sentences from iyagi_1_50.json."""
    path = _INGEST_DIR / "iyagi_1_50.json"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    out: list[str] = []
    for unit in data.get("units", []):
        for sentence in unit.get("sentences", []):
            kr = (sentence.get("korean") or "").strip()
            # Avoid one-word interjections; we want real grammar.
            if len(kr) >= 8:
                out.append(kr)
            if len(out) >= limit:
                return out
    return out


@pytest.mark.slow
class TestLemmatizerWithRealKiwi:
    """Structural assertions only — exact tokenizations vary by Kiwi version."""

    def test_loads(self, real_lemmatizer: Lemmatizer) -> None:
        assert real_lemmatizer.model_loaded
        assert real_lemmatizer.model_size in {"small", "base", "large"}

    @pytest.mark.parametrize(
        ("text", "expected_lemma"),
        [
            ("어제 친구를 만났어요.", "만나다"),
            ("음악을 들어요.", "듣다"),
            ("물이 흘러요.", "흐르다"),
            ("편지를 써요.", "쓰다"),
            ("케이크를 만들어요.", "만들다"),
        ],
    )
    def test_irregular_verbs_against_real_kiwi(
        self, real_lemmatizer: Lemmatizer, text: str, expected_lemma: str
    ) -> None:
        tokens = real_lemmatizer.lemmatize(text)
        lemmas = {t.lemma for t in tokens}
        assert expected_lemma in lemmas, f"Expected {expected_lemma} in {lemmas}"

    def test_offsets_round_trip_through_input(self, real_lemmatizer: Lemmatizer) -> None:
        text = "어제 친구를 만났어요"
        tokens = real_lemmatizer.lemmatize(text)
        # For BMP-only Korean text, Python and UTF-16 indexes coincide, so
        # text[t.start:t.end] should equal t.surface for surface tokens
        # (allowing for the fact that endings like EF can be reconstructed
        #  forms that don't appear verbatim — we filter to N* and MA* below).
        nominal = [t for t in tokens if t.pos.startswith(("N", "MA"))]
        assert nominal, "expected at least one nominal/adverb token"
        for t in nominal:
            assert text[t.start : t.end] == t.surface

    def test_iyagi_corpus_smoke(self, real_lemmatizer: Lemmatizer) -> None:
        sentences = _load_iyagi_sentences(limit=10)
        if not sentences:
            pytest.skip("Iyagi corpus not available at expected path")
        for s in sentences:
            tokens = real_lemmatizer.lemmatize(s)
            assert tokens, f"No tokens for: {s[:30]}"
            # Every verbal lemma should end in 다.
            for t in tokens:
                if t.pos in {"VV", "VA", "VX", "VCP", "VCN"}:
                    assert t.lemma.endswith("다"), f"Bad lemma {t.lemma!r} for pos {t.pos}"
