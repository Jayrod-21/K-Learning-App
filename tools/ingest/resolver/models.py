"""
Pydantic / dataclass types shared across the resolver.

WHY: bar §"Type safety" — no untyped dicts between layers. Extractor returns
typed RawReference; normalizer returns typed NormalizedTarget; lookup returns
typed ResolutionOutcome; writer takes typed RelationRow.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


# Closed set of relation kinds the resolver writes. Maps 1:1 to the CHECK
# constraint ck_kgiu_entry_relations_kind (added in migration 009) and the
# enum vocab_relation_type (created in migration 002).
#
# WHY a class-side constant rather than reading the enum from the DB at
# runtime: the resolver MUST refuse to invent kinds. If the schema and the
# resolver disagree, the writer's INSERT will fail with a CHECK violation —
# we want that to fail loudly at insert time, not be silently coerced.
KGIU_RELATION_KINDS: set[str] = {
    "compare_with",
    "related",
    "synonym",
    "antonym",
    "reference",
    "cross_ref",
    "passive_form",
    "causative_form",
    "basic_form",
    "honorific_form",
    "humble_form",
    "contracted_form",
}

VOCAB_RELATION_KINDS: set[str] = {
    "synonym",
    "antonym",
    "related",
    "reference",
    "passive_form",
    "causative_form",
    "basic_form",
    "honorific_form",
    "humble_form",
    "contracted_form",
}

KGIU_CORPORA: set[str] = {"kgiu_beginner", "kgiu_intermediate", "kgiu_advanced"}
VOCAB_CORPORA: set[str] = {"vocab_2000_beginner", "vocab_2000_intermediate"}
ALL_CORPORA: set[str] = KGIU_CORPORA | VOCAB_CORPORA


class CorpusKind(str, Enum):
    """Which physical relations table a corpus targets."""
    KGIU = "kgiu"
    VOCAB = "vocab"


def corpus_kind(corpus: str) -> CorpusKind:
    if corpus in KGIU_CORPORA:
        return CorpusKind.KGIU
    if corpus in VOCAB_CORPORA:
        return CorpusKind.VOCAB
    raise ValueError(f"Unknown corpus: {corpus!r}")


# -----------------------------------------------------------------------------
# Extractor output
# -----------------------------------------------------------------------------


class RawReference(BaseModel):
    """One text-form cross-reference pulled from a source entry.

    The `text` field is the original, un-normalized string from the JSON.
    `english` / `page` / `parsed_target_source_id` carry whatever extra
    signal the source provided.
    """
    model_config = ConfigDict(extra="forbid", frozen=True)

    relation_kind: str
    text: str
    english: str | None = None
    page: int | None = None
    note: str | None = None
    # Populated by the extractor when the source `note` mentions
    # "See kgiu-beg-u03-01" or similar — the parsed id ("kgiu-beg-u03-01").
    parsed_target_source_id: str | None = None


# -----------------------------------------------------------------------------
# Normalizer output
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class NormalizedTarget:
    """A normalized Korean target string + structural splits.

    `canonical` is the form used for FK lookup (NFC, trimmed, homograph index
    stripped). `original` is the unchanged input for storage. `homograph_index`
    is the parsed (paren-tagged) homograph marker, if any. `subtargets` is the
    list of canonical forms when the input is a comma-separated multi-target.
    """

    original: str
    canonical: str
    homograph_index: str | None
    subtargets: tuple[str, ...]


# -----------------------------------------------------------------------------
# Lookup output
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class ResolutionOutcome:
    """Result of looking a normalized target up against the index."""

    target_entry_id: int | None
    target_corpus: str | None
    target_source_id: str | None
    target_english: str | None
    target_page: int | None
    # How many candidates the index returned. ``ambiguous`` outcomes are
    # the ones we resolved with the same-corpus-preference tiebreaker; we
    # log them so QA can audit.
    candidate_count: int
    ambiguous: bool
    # 'resolved' (FK link found), 'text_only' (no match), 'broken' (the
    # source pattern was malformed and we couldn't even normalize a target).
    status: Literal["resolved", "text_only", "broken"]
    reason: str | None = None


# -----------------------------------------------------------------------------
# Writer input
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class RelationRow:
    """One row destined for kgiu_entry_relations or vocab_entry_relations."""

    source_entry_id: int
    source_corpus: str
    relation_kind: str
    target_entry_id: int | None
    target_korean: str | None
    target_english: str | None
    target_page: int | None
    target_source_id: str | None
    note: str | None
    resolution_status: str


# -----------------------------------------------------------------------------
# Broken-ref report row (CSV)
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class BrokenRefRow:
    source_corpus: str
    source_entry_id: int
    source_pattern: str | None
    relation_type: str
    target_text: str
    reason: str

    @classmethod
    def csv_header(cls) -> tuple[str, ...]:
        return (
            "source_corpus",
            "source_entry_id",
            "source_pattern",
            "relation_type",
            "target_text",
            "reason",
        )

    def csv_row(self) -> tuple[str, ...]:
        return (
            self.source_corpus,
            str(self.source_entry_id),
            self.source_pattern or "",
            self.relation_type,
            self.target_text,
            self.reason,
        )


class ResolverCounters(BaseModel):
    """Cumulative counters reported per corpus."""

    model_config = ConfigDict(extra="forbid")

    entries_seen: int = 0
    refs_extracted: int = 0
    refs_resolved: int = 0
    refs_text_only: int = 0
    refs_broken: int = 0
    rows_written: int = 0
    rows_unchanged: int = 0
