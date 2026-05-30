"""
Extract text-form cross-references from a source-JSON entry.

WHY a separate module: there are 11 different shapes of cross-reference
across the 5 Darakwon corpora. Centralizing the dispatch keeps the rest of
the resolver shape-agnostic.

Each entry-type has its own extractor function. They all return a list of
`RawReference` and do NOT mutate the input dict.

The extractors are *liberal* in what they accept and *conservative* in what
they emit: missing keys / wrong shapes are logged + skipped, not raised.
The resolver's pipeline counts skip events and surfaces them so the
extraction layer's silence about malformed source data can't hide bugs.
"""

from __future__ import annotations

from typing import Any

import structlog

from .models import RawReference
from .normalize import extract_entry_ids

logger = structlog.get_logger(__name__)


# -----------------------------------------------------------------------------
# Shape helpers
# -----------------------------------------------------------------------------


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    return str(value).strip() or None


def _safe_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# -----------------------------------------------------------------------------
# Vocab extractor
# -----------------------------------------------------------------------------

# Field name in the source JSON → relation_kind we emit. Only kinds present in
# the DB's vocab_relation_type enum are listed here.
_VOCAB_LIST_FIELDS: dict[str, str] = {
    "synonyms": "synonym",
    "antonyms": "antonym",
    "related": "related",
}

# Scalar fields on a word entry that point at a single Korean form.
_VOCAB_SCALAR_FIELDS: dict[str, str] = {
    "passive_form": "passive_form",
    "causative_form": "causative_form",
    "basic_form": "basic_form",
    "honorific_form": "honorific_form",
    "humble_form": "humble_form",
    "contracted_form": "contracted_form",
}


def extract_vocab_refs(entry: dict[str, Any]) -> list[RawReference]:
    """Return all text-form cross-references on a vocab source-JSON entry.

    The entry is the raw dict from `items[*]` in vocab_2000_*.json.
    Navigational rows (`theme_intro`, `subsection_intro`, `reference`) yield
    no refs.
    """
    if entry.get("type") not in ("word", None):
        return []

    refs: list[RawReference] = []

    # 1. List-shaped fields: synonyms / antonyms / related.
    for field, kind in _VOCAB_LIST_FIELDS.items():
        for item in _as_list(entry.get(field)):
            if not isinstance(item, dict):
                continue
            korean = _safe_str(item.get("korean"))
            if not korean:
                continue
            refs.append(
                RawReference(
                    relation_kind=kind,
                    text=korean,
                    english=_safe_str(item.get("english")),
                    page=_safe_int(item.get("page")),
                    note=_safe_str(item.get("note")),
                )
            )

    # 2. Scalar form fields. These are bare Korean strings, not dicts.
    for field, kind in _VOCAB_SCALAR_FIELDS.items():
        value = _safe_str(entry.get(field))
        if not value:
            continue
        refs.append(
            RawReference(
                relation_kind=kind,
                text=value,
                english=None,
                page=None,
                note=None,
            )
        )

    # 3. cross_refs[] — usually {label, page} pointing at an Appendix page.
    #    We do NOT push these as relation rows by default — they don't
    #    identify a target headword. Resolver.pipeline checks the label for
    #    a Korean form and only emits a row if one is present.
    for item in _as_list(entry.get("cross_refs")):
        if not isinstance(item, dict):
            continue
        label = _safe_str(item.get("label"))
        # Skip "Appendix" / "Index" / pure-English nav labels — they're page
        # pointers, not word↔word relations.
        if not label or label.lower() in {"appendix", "index", "reference"}:
            continue
        # If the label contains a Korean form (e.g. "관련 단어: 식구"), the
        # downstream normalizer will pull the Korean part out. Emit as
        # 'related' so the UI groups it with the other related links.
        refs.append(
            RawReference(
                relation_kind="related",
                text=label,
                english=None,
                page=_safe_int(item.get("page")),
                note=None,
            )
        )

    return refs


# -----------------------------------------------------------------------------
# KGIU extractor
# -----------------------------------------------------------------------------


def extract_kgiu_refs(entry: dict[str, Any]) -> list[RawReference]:
    """Return all text-form cross-references on a KGIU source-JSON entry.

    Intro/reference rows still contribute refs (their `compare_with`
    payloads do exist in the source) — we let them through and let the
    pipeline / lookup decide whether they're resolvable.
    """
    refs: list[RawReference] = []

    # 1. compare_with[] — the dominant KGIU cross-reference shape.
    for item in _as_list(entry.get("compare_with")):
        if not isinstance(item, dict):
            continue
        with_str = _safe_str(item.get("with"))
        note = _safe_str(item.get("note"))
        if not with_str and not note:
            continue
        target_text = with_str or note or ""
        # If the note mentions a `kgiu-…` source_id, surface it for direct
        # FK lookup before the text-canonicalization path.
        parsed_ids = extract_entry_ids(note)
        parsed_id = parsed_ids[0] if parsed_ids else None
        refs.append(
            RawReference(
                relation_kind="compare_with",
                text=target_text,
                english=None,
                page=None,
                note=note,
                parsed_target_source_id=parsed_id,
            )
        )
        # If a note carries MULTIPLE entry IDs (e.g. "See kgiu-beg-u01-01 and
        # kgiu-beg-u01-02"), emit a separate cross_ref row for each beyond
        # the first so the FK web is complete.
        for extra_id in parsed_ids[1:]:
            refs.append(
                RawReference(
                    relation_kind="cross_ref",
                    text=extra_id,
                    english=None,
                    page=None,
                    note=note,
                    parsed_target_source_id=extra_id,
                )
            )

    return refs
