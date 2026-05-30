"""
In-memory lookup index for resolving text targets to FK entry ids.

WHY in-memory: the entire kgiu+vocab headword/source-id space is small (<5k
rows). Pulling the index once per resolver run and doing dictionary lookups
is dramatically simpler and faster than round-tripping to Postgres for every
reference. We refresh the index per-corpus only when needed.

The index supports two lookup modes:
    1. Source-ID lookup — exact match against `kgiu_entries.source_id` /
       `vocab_entries.source_id` (used when the source `note` contained
       something like "See kgiu-beg-u03-01").
    2. Korean-form lookup — case-folded match against the canonical Korean
       form. Vocab uses `korean`; KGIU uses `pattern`.

Same-corpus preference: when a canonical form matches in multiple corpora,
the lookup returns the row whose corpus matches the source row's corpus.
If none match same-corpus, the lookup falls back to a cross-corpus match
using a deterministic priority order (kgiu_beginner > intermediate >
advanced; vocab_2000_beginner > intermediate). This keeps re-resolves stable.
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog
from psycopg import AsyncConnection

from .models import (
    KGIU_CORPORA,
    VOCAB_CORPORA,
    CorpusKind,
    NormalizedTarget,
    ResolutionOutcome,
    corpus_kind,
)
from .normalize import collapse_whitespace, nfc

logger = structlog.get_logger(__name__)


# Deterministic cross-corpus tiebreaker ordering. Lower index = higher
# priority. Beginner corpora win — the rationale: when a higher-level book
# references a form that exists in both levels, the foundational definition
# is the one we want learners to land on.
_CORPUS_PRIORITY: dict[str, int] = {
    "kgiu_beginner": 0,
    "kgiu_intermediate": 1,
    "kgiu_advanced": 2,
    "vocab_2000_beginner": 0,
    "vocab_2000_intermediate": 1,
}


@dataclass(frozen=True)
class IndexedRow:
    entry_id: int
    corpus: str
    source_id: str
    korean: str | None
    english: str | None
    pattern: str | None
    page: int | None


class LookupIndex:
    """Two-tier in-memory lookup index.

    Build with `LookupIndex.from_db(conn)` and then call `find_*`.
    The index is read-only after construction; safe to share across coroutines.
    """

    def __init__(
        self,
        *,
        by_source_id: dict[tuple[str, str], IndexedRow],
        by_korean: dict[tuple[CorpusKind, str], list[IndexedRow]],
    ) -> None:
        # (corpus, source_id) → row
        self._by_source_id = by_source_id
        # (kind, lower(korean)) → [row, …] (multiple if homographs across corpora)
        self._by_korean = by_korean

    # ----- Construction ------------------------------------------------------

    @classmethod
    async def from_db(cls, conn: AsyncConnection) -> "LookupIndex":
        """Build the index from the current contents of kgiu+vocab entries."""
        by_source_id: dict[tuple[str, str], IndexedRow] = {}
        by_korean: dict[tuple[CorpusKind, str], list[IndexedRow]] = {}

        # KGIU: lookup key is `pattern` (the headword form). We also index
        # `title_en` for English-only matches? — no, that's noisy. Pattern only.
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, corpus::text, source_id, pattern, title_en, NULL::int
                  FROM kgiu_entries
                """
            )
            async for row in cur:
                rid, corpus, source_id, pattern, title_en, _page = row
                ir = IndexedRow(
                    entry_id=int(rid),
                    corpus=corpus,
                    source_id=source_id,
                    korean=None,
                    english=title_en,
                    pattern=pattern,
                    page=None,
                )
                by_source_id[(corpus, source_id)] = ir
                if pattern:
                    key = _korean_key(pattern)
                    if key:
                        by_korean.setdefault((CorpusKind.KGIU, key), []).append(ir)

            # Vocab: lookup key is `korean`.
            await cur.execute(
                """
                SELECT id, corpus::text, source_id, korean, english,
                       CASE WHEN array_length(source_pages, 1) > 0
                            THEN source_pages[1] ELSE NULL END
                  FROM vocab_entries
                 WHERE entry_type = 'word'
                """
            )
            async for row in cur:
                rid, corpus, source_id, korean, english, page = row
                ir = IndexedRow(
                    entry_id=int(rid),
                    corpus=corpus,
                    source_id=source_id,
                    korean=korean,
                    english=english,
                    pattern=None,
                    page=int(page) if page is not None else None,
                )
                by_source_id[(corpus, source_id)] = ir
                if korean:
                    key = _korean_key(korean)
                    if key:
                        by_korean.setdefault((CorpusKind.VOCAB, key), []).append(ir)

        logger.info(
            "lookup_index_built",
            by_source_id_size=len(by_source_id),
            by_korean_size=len(by_korean),
        )
        return cls(by_source_id=by_source_id, by_korean=by_korean)

    # ----- Lookup ------------------------------------------------------------

    def find_by_source_id(self, source_id: str) -> IndexedRow | None:
        """Look up by entry source_id across all corpora.

        Returns the first match; source_ids are globally unique by construction
        (the prefix encodes the corpus — `kgiu-beg-…`, `vocab-int-…`).
        """
        sid = source_id.strip().lower()
        for corpus in (*KGIU_CORPORA, *VOCAB_CORPORA):
            row = self._by_source_id.get((corpus, sid))
            if row is not None:
                return row
        return None

    def find_by_korean(
        self,
        target: NormalizedTarget,
        *,
        source_corpus: str,
    ) -> tuple[IndexedRow | None, int, bool]:
        """Look up by canonical Korean form.

        Returns (row_or_None, candidate_count, ambiguous_bool).

        `ambiguous` is True iff multiple candidates were found and we used
        the same-corpus / priority tiebreaker to pick one — the caller logs
        these so QA can review.
        """
        kind = corpus_kind(source_corpus)
        key = _korean_key(target.canonical)
        if not key:
            return None, 0, False

        candidates = list(self._by_korean.get((kind, key), []))
        # Cross-corpus fallback: if no same-kind match, try the OTHER kind.
        # A KGIU `compare_with` of "처럼" might point at a vocab headword;
        # a vocab synonym might be a grammar pattern (rare but possible).
        if not candidates:
            other = CorpusKind.VOCAB if kind == CorpusKind.KGIU else CorpusKind.KGIU
            candidates = list(self._by_korean.get((other, key), []))

        if not candidates:
            return None, 0, False

        if len(candidates) == 1:
            return candidates[0], 1, False

        # Multiple candidates — apply same-corpus-prefer + priority tiebreak.
        def rank(row: IndexedRow) -> tuple[int, int]:
            same_corpus = 0 if row.corpus == source_corpus else 1
            priority = _CORPUS_PRIORITY.get(row.corpus, 99)
            return (same_corpus, priority)

        candidates.sort(key=rank)
        return candidates[0], len(candidates), True


def _korean_key(text: str) -> str:
    """Build the case-folded lookup key matching the unique-index expression."""
    return collapse_whitespace(nfc(text)).lower()


def resolve(
    target: NormalizedTarget | None,
    *,
    index: LookupIndex,
    source_corpus: str,
    parsed_target_source_id: str | None,
    fallback_page: int | None = None,
) -> ResolutionOutcome:
    """Run one normalized target through the index. Pure function over LookupIndex."""

    # 1. Direct source_id match wins (highest signal).
    if parsed_target_source_id:
        row = index.find_by_source_id(parsed_target_source_id)
        if row is not None:
            return ResolutionOutcome(
                target_entry_id=row.entry_id,
                target_corpus=row.corpus,
                target_source_id=row.source_id,
                target_english=row.english,
                target_page=row.page or fallback_page,
                candidate_count=1,
                ambiguous=False,
                status="resolved",
                reason=None,
            )
        # We have a parseable id but it's not loaded. That's text_only with
        # the parsed_target_source_id surfaced for a later re-resolve.
        if target is None:
            return ResolutionOutcome(
                target_entry_id=None,
                target_corpus=None,
                target_source_id=parsed_target_source_id,
                target_english=None,
                target_page=fallback_page,
                candidate_count=0,
                ambiguous=False,
                status="text_only",
                reason=f"source_id {parsed_target_source_id!r} not in index",
            )

    if target is None:
        return ResolutionOutcome(
            target_entry_id=None,
            target_corpus=None,
            target_source_id=parsed_target_source_id,
            target_english=None,
            target_page=fallback_page,
            candidate_count=0,
            ambiguous=False,
            status="broken",
            reason="normalizer produced no canonical form",
        )

    # 2. Try each subtarget (multi-target case) and take the first hit.
    candidate_count = 0
    ambiguous = False
    for sub in target.subtargets:
        sub_norm = NormalizedTarget(
            original=target.original,
            canonical=sub,
            homograph_index=target.homograph_index,
            subtargets=(sub,),
        )
        row, n, amb = index.find_by_korean(sub_norm, source_corpus=source_corpus)
        candidate_count = max(candidate_count, n)
        ambiguous = ambiguous or amb
        if row is not None:
            return ResolutionOutcome(
                target_entry_id=row.entry_id,
                target_corpus=row.corpus,
                target_source_id=row.source_id,
                target_english=row.english,
                target_page=row.page or fallback_page,
                candidate_count=n,
                ambiguous=amb,
                status="resolved",
                reason=None,
            )

    # 3. No hit — text-only fallback.
    return ResolutionOutcome(
        target_entry_id=None,
        target_corpus=None,
        target_source_id=parsed_target_source_id,
        target_english=None,
        target_page=fallback_page,
        candidate_count=candidate_count,
        ambiguous=ambiguous,
        status="text_only",
        reason=None if candidate_count else "no candidates",
    )
