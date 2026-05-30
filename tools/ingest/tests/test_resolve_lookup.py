"""
Unit tests for the in-memory LookupIndex and `resolve()`.

Hand-build the index — no DB. Covers:
    * same-corpus preference
    * cross-corpus fallback
    * multi-candidate tiebreak (priority)
    * source_id direct match short-circuits text match
    * multi-target resolution
"""

from __future__ import annotations

from resolver.lookup import IndexedRow, LookupIndex, resolve  # noqa: E402
from resolver.models import CorpusKind  # noqa: E402
from resolver.normalize import normalize_target  # noqa: E402


def _build_index(rows: list[IndexedRow]) -> LookupIndex:
    by_source_id: dict[tuple[str, str], IndexedRow] = {}
    by_korean: dict[tuple[CorpusKind, str], list[IndexedRow]] = {}
    for r in rows:
        by_source_id[(r.corpus, r.source_id)] = r
        kind = CorpusKind.KGIU if r.corpus.startswith("kgiu_") else CorpusKind.VOCAB
        key_text = r.korean or r.pattern or ""
        key = key_text.strip().lower()
        if key:
            by_korean.setdefault((kind, key), []).append(r)
    return LookupIndex(by_source_id=by_source_id, by_korean=by_korean)


def _ir(*, entry_id, corpus, source_id, korean=None, pattern=None, english=None, page=None):
    return IndexedRow(
        entry_id=entry_id,
        corpus=corpus,
        source_id=source_id,
        korean=korean,
        english=english,
        pattern=pattern,
        page=page,
    )


# -----------------------------------------------------------------------------
# Source-id resolution
# -----------------------------------------------------------------------------


class TestSourceIdLookup:
    def test_finds_by_source_id(self):
        idx = _build_index([
            _ir(entry_id=10, corpus="kgiu_beginner", source_id="kgiu-beg-u03-01",
                pattern="N이/가"),
        ])
        target = normalize_target("N이/가 (subject particle)")
        outcome = resolve(
            target, index=idx,
            source_corpus="kgiu_beginner",
            parsed_target_source_id="kgiu-beg-u03-01",
        )
        assert outcome.status == "resolved"
        assert outcome.target_entry_id == 10
        assert outcome.target_corpus == "kgiu_beginner"

    def test_text_only_when_id_not_loaded(self):
        idx = _build_index([])
        outcome = resolve(
            normalize_target("N이/가"),
            index=idx,
            source_corpus="kgiu_beginner",
            parsed_target_source_id="kgiu-beg-u99-99",
        )
        assert outcome.status == "text_only"
        assert outcome.target_entry_id is None
        assert outcome.target_source_id == "kgiu-beg-u99-99"


# -----------------------------------------------------------------------------
# Same-corpus preference
# -----------------------------------------------------------------------------


class TestSameCorpusPreference:
    def test_prefers_same_corpus_when_multiple_match(self):
        idx = _build_index([
            _ir(entry_id=1, corpus="kgiu_beginner", source_id="kgiu-beg-x-01",
                pattern="처럼"),
            _ir(entry_id=2, corpus="kgiu_intermediate", source_id="kgiu-int-x-02",
                pattern="처럼"),
        ])
        outcome = resolve(
            normalize_target("처럼"),
            index=idx,
            source_corpus="kgiu_intermediate",
            parsed_target_source_id=None,
        )
        assert outcome.target_entry_id == 2  # same-corpus win
        assert outcome.ambiguous is True
        assert outcome.candidate_count == 2

    def test_priority_tiebreak_when_no_same_corpus(self):
        # Source is advanced, candidates exist in beg + int.
        idx = _build_index([
            _ir(entry_id=1, corpus="kgiu_beginner", source_id="kgiu-beg-x-01",
                pattern="처럼"),
            _ir(entry_id=2, corpus="kgiu_intermediate", source_id="kgiu-int-x-02",
                pattern="처럼"),
        ])
        outcome = resolve(
            normalize_target("처럼"),
            index=idx,
            source_corpus="kgiu_advanced",
            parsed_target_source_id=None,
        )
        # Beginner wins by priority order.
        assert outcome.target_entry_id == 1


# -----------------------------------------------------------------------------
# Cross-corpus fallback
# -----------------------------------------------------------------------------


class TestCrossCorpusFallback:
    def test_kgiu_source_falls_back_to_vocab(self):
        idx = _build_index([
            _ir(entry_id=42, corpus="vocab_2000_beginner", source_id="vocab-beg-0042",
                korean="가족"),
        ])
        outcome = resolve(
            normalize_target("가족"),
            index=idx,
            source_corpus="kgiu_beginner",
            parsed_target_source_id=None,
        )
        assert outcome.target_entry_id == 42
        assert outcome.target_corpus == "vocab_2000_beginner"

    def test_vocab_source_falls_back_to_kgiu(self):
        idx = _build_index([
            _ir(entry_id=99, corpus="kgiu_advanced", source_id="kgiu-adv-c15-02",
                pattern="-듯이"),
        ])
        outcome = resolve(
            normalize_target("-듯이"),
            index=idx,
            source_corpus="vocab_2000_intermediate",
            parsed_target_source_id=None,
        )
        assert outcome.target_entry_id == 99


# -----------------------------------------------------------------------------
# Multi-target resolution
# -----------------------------------------------------------------------------


class TestMultiTarget:
    def test_resolves_first_subtarget_match(self):
        idx = _build_index([
            _ir(entry_id=7, corpus="vocab_2000_intermediate", source_id="vocab-int-0007",
                korean="만족스럽다"),
        ])
        outcome = resolve(
            normalize_target("만족하다, 만족스럽다"),
            index=idx,
            source_corpus="vocab_2000_intermediate",
            parsed_target_source_id=None,
        )
        # Either subtarget could win; the one present in the index does.
        assert outcome.target_entry_id == 7
        assert outcome.status == "resolved"

    def test_text_only_when_no_subtarget_matches(self):
        idx = _build_index([])
        outcome = resolve(
            normalize_target("만족하다, 만족스럽다"),
            index=idx,
            source_corpus="vocab_2000_intermediate",
            parsed_target_source_id=None,
        )
        assert outcome.status == "text_only"
        assert outcome.target_entry_id is None


# -----------------------------------------------------------------------------
# No match
# -----------------------------------------------------------------------------


class TestNoMatch:
    def test_returns_text_only(self):
        idx = _build_index([])
        outcome = resolve(
            normalize_target("nonexistent"),
            index=idx,
            source_corpus="kgiu_beginner",
            parsed_target_source_id=None,
        )
        assert outcome.status == "text_only"
        assert outcome.target_entry_id is None
        assert outcome.candidate_count == 0

    def test_normalize_failure_returns_broken(self):
        idx = _build_index([])
        outcome = resolve(
            None,  # normalize_target returned None
            index=idx,
            source_corpus="kgiu_beginner",
            parsed_target_source_id=None,
        )
        assert outcome.status == "broken"
