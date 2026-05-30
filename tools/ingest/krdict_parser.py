"""
KRDICT XML parser.

Streaming, defensive, format-strict, defusedxml-backed.

Parses KRDICT's TEI-Lite-ish XML into `KrdictEntryModel` instances.
Producer-only — the loader is a separate module. Side-effect-free.

ADRs:
    * ADR-015 — KRDICT schema design
    * ADR-016 — chose XML over JSON; defusedxml for XXE defense
    * ADR-017 — POS is open TEXT (no enum coercion here)

Public API:
    iter_entries(source, *, on_skip=None) -> Iterator[KrdictEntryModel]
    parse_file(path, *, on_skip=None) -> Iterator[KrdictEntryModel]
    parse_directory(path, *, on_skip=None) -> Iterator[KrdictEntryModel]

Why streaming
-------------
KRDICT archives are big. `iterparse` lets us process one `<entry>` at a
time and clear its subtree, so memory is flat regardless of file size.

Defense against malformed/malicious input
-----------------------------------------
* `defusedxml.ElementTree` — blocks XXE, entity bombs, DTD-driven DoS.
* Per-entry try/except: a single broken entry is skipped and logged
  rather than crashing the load.
* The Pydantic model is strict (`extra="forbid"`); a field rename
  upstream surfaces as a validation error at the entry boundary.
* Length caps on every string field (see krdict_models) defend against
  a single 100MB headword DoS-ing the loader.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional, Union

from defusedxml import ElementTree as DET
from pydantic import ValidationError

from krdict_models import (
    KrdictEntryModel,
    KrdictExampleModel,
    KrdictInflectionModel,
    KrdictSenseModel,
)


log = logging.getLogger(__name__)


# Tag names — KRDICT's XML uses Korean-language TEI-lite-ish tags. Defined
# as constants so a schema rename costs one line to find.
TAG_ENTRY = "entry"
TAG_ENTRY_ID = "entry_id"
TAG_HEADWORD = "headword"
TAG_HOMOGRAPH = "homograph_num"
TAG_PRONUNCIATION = "pronunciation"
TAG_POS = "pos"
TAG_HANJA = "hanja"
# KRDICT XML uses ``<register>`` at both entry scope AND sense scope. We
# deliberately use the SAME constant ``TAG_REGISTER`` at both call sites so
# this contract is explicit; the previous code defined a duplicate alias
# ``TAG_SENSE_REGISTER = "register"`` which looked like a typo and invited
# a future reader to "fix" it. See REVIEW_B2.md SF6.
TAG_REGISTER = "register"
TAG_SENSE = "sense"
TAG_SENSE_NUM = "sense_num"
TAG_DEFINITION = "definition"
TAG_DEFINITION_KO = "definition_ko"
TAG_DEFINITION_EN = "definition_en"
TAG_SENSE_DOMAIN = "domain"
TAG_EXAMPLE = "example"
TAG_EXAMPLE_KO = "example_ko"
TAG_EXAMPLE_EN = "example_en"
TAG_EXAMPLE_TYPE = "example_type"
TAG_INFLECTION = "inflection"
TAG_INFLECTION_FORM = "form"
TAG_INFLECTION_LABEL = "label"


@dataclass(frozen=True)
class SkipReason:
    """Why a single entry was skipped — surfaced to the on_skip callback."""

    source_id: Optional[str]
    error: str


SkipCallback = Callable[[SkipReason], None]


def _text(elem, tag: str) -> Optional[str]:
    """Return stripped text of the first child <tag>, or None."""
    if elem is None:
        return None
    child = elem.find(tag)
    if child is None or child.text is None:
        return None
    text = child.text.strip()
    return text if text else None


def _int_or_default(value: Optional[str], default: int) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_examples(sense_elem) -> list[KrdictExampleModel]:
    examples: list[KrdictExampleModel] = []
    for idx, ex in enumerate(sense_elem.findall(TAG_EXAMPLE), start=1):
        ko = _text(ex, TAG_EXAMPLE_KO)
        if ko is None:
            # KRDICT occasionally emits empty <example> shells. Skip them.
            continue
        examples.append(
            KrdictExampleModel(
                example_index=idx,
                korean=ko,
                english=_text(ex, TAG_EXAMPLE_EN),
                example_type=_text(ex, TAG_EXAMPLE_TYPE),
            )
        )
    return examples


def _parse_senses(entry_elem) -> list[KrdictSenseModel]:
    senses: list[KrdictSenseModel] = []
    raw_senses = entry_elem.findall(TAG_SENSE)
    if not raw_senses:
        return senses

    for fallback_idx, s in enumerate(raw_senses, start=1):
        raw_num = _text(s, TAG_SENSE_NUM)
        sense_index = _int_or_default(raw_num, fallback_idx)
        if sense_index < 1:
            sense_index = fallback_idx

        def_ko = _text(s, TAG_DEFINITION_KO) or _text(s, TAG_DEFINITION)
        if def_ko is None:
            # A sense with no Korean definition is malformed. Skip silently
            # — the parent entry's validator will catch missing sense 1.
            continue

        senses.append(
            KrdictSenseModel(
                sense_index=sense_index,
                definition_korean=def_ko,
                definition_english=_text(s, TAG_DEFINITION_EN),
                sense_domain=_text(s, TAG_SENSE_DOMAIN),
                sense_register=_text(s, TAG_REGISTER),
                examples=_parse_examples(s),
            )
        )
    return senses


def _parse_inflections(entry_elem) -> list[KrdictInflectionModel]:
    out: list[KrdictInflectionModel] = []
    seen: set[tuple[str, str]] = set()
    for idx, infl in enumerate(entry_elem.findall(TAG_INFLECTION)):
        surface = _text(infl, TAG_INFLECTION_FORM)
        label = _text(infl, TAG_INFLECTION_LABEL)
        if not surface or not label:
            continue
        key = (surface, label)
        if key in seen:
            # Silently drop duplicates rather than crashing the entry.
            continue
        seen.add(key)
        out.append(
            KrdictInflectionModel(
                order_index=idx,
                surface_form=surface,
                inflection_label=label,
            )
        )
    return out


def _entry_from_xml(elem) -> KrdictEntryModel:
    """Build a KrdictEntryModel from one `<entry>` element. Raises on shape errors."""

    source_id = _text(elem, TAG_ENTRY_ID)
    if not source_id:
        raise ValueError("missing required <entry_id>")

    headword = _text(elem, TAG_HEADWORD)
    if not headword:
        raise ValueError("missing required <headword>")

    homograph = _int_or_default(_text(elem, TAG_HOMOGRAPH), 0)

    senses = _parse_senses(elem)
    if not senses:
        raise ValueError("entry has no valid senses")

    return KrdictEntryModel(
        source_id=source_id,
        homograph_index=homograph,
        headword=headword,
        pronunciation=_text(elem, TAG_PRONUNCIATION),
        part_of_speech=_text(elem, TAG_POS),
        hanja=_text(elem, TAG_HANJA),
        register=_text(elem, TAG_REGISTER),
        senses=senses,
        inflections=_parse_inflections(elem),
    )


def _iter_entries_from_path(
    path: Path, *, on_skip: Optional[SkipCallback]
) -> Iterator[KrdictEntryModel]:
    """Stream-parse a single XML file. Memory stays flat via elem.clear()."""

    log.info("krdict_parser.parse_file_start", extra={"path": str(path)})
    # defusedxml.iterparse blocks XXE / entity-bomb attacks. forbid_dtd is on
    # by default; setting it explicitly here is for documentation.
    context = DET.iterparse(
        str(path), events=("end",), forbid_dtd=True, forbid_entities=True
    )

    count = 0
    skipped = 0
    try:
        for _event, elem in context:
            if elem.tag != TAG_ENTRY:
                continue
            try:
                yield _entry_from_xml(elem)
                count += 1
            except (ValueError, ValidationError) as exc:
                skipped += 1
                source_id = _text(elem, TAG_ENTRY_ID)
                reason = SkipReason(source_id=source_id, error=str(exc))
                log.warning(
                    "krdict_parser.entry_skipped",
                    extra={
                        "source_id": source_id,
                        "error": str(exc),
                        "path": str(path),
                    },
                )
                if on_skip is not None:
                    on_skip(reason)
            finally:
                # Critical for streaming: drop the parsed subtree so memory
                # doesn't grow with file size.
                elem.clear()
    finally:
        log.info(
            "krdict_parser.parse_file_done",
            extra={"path": str(path), "entries": count, "skipped": skipped},
        )


def parse_file(
    path: Union[str, Path],
    *,
    on_skip: Optional[SkipCallback] = None,
) -> Iterator[KrdictEntryModel]:
    """Stream-parse a KRDICT XML file."""
    yield from _iter_entries_from_path(Path(path), on_skip=on_skip)


def parse_directory(
    path: Union[str, Path],
    *,
    on_skip: Optional[SkipCallback] = None,
) -> Iterator[KrdictEntryModel]:
    """Stream-parse every *.xml file under a directory, sorted by name.

    Visit-order contract (relied on by load_krdict.py's resume cursor):
      1. Files are visited in ``sorted()`` order of their absolute paths.
      2. Within each file, entries are emitted in DOCUMENT ORDER (the order
         they appear in the XML), which iterparse preserves.

    What this contract does NOT guarantee:
      - Entries are NOT sorted by ``source_id``. A new KRDICT vintage can
        intermix new entries among old ones, and homograph entries share
        a source_id with different ``homograph_index``.
      - Therefore the loader CANNOT lexicographic-compare source_ids to
        decide "is this past the resume cursor?". It must walk until it
        observes the marker, and raise if it never does. See
        load_krdict.py::_filter_resumable and REVIEW_B2.md SF1.
    """
    root = Path(path)
    if not root.is_dir():
        raise NotADirectoryError(f"not a directory: {root}")
    xml_files = sorted(p for p in root.rglob("*.xml") if p.is_file())
    log.info(
        "krdict_parser.parse_dir_start",
        extra={"path": str(root), "files": len(xml_files)},
    )
    for f in xml_files:
        yield from _iter_entries_from_path(f, on_skip=on_skip)


def iter_entries(
    source: Union[str, Path],
    *,
    on_skip: Optional[SkipCallback] = None,
) -> Iterator[KrdictEntryModel]:
    """Polymorphic entry point: a file or a directory."""
    p = Path(source)
    if p.is_dir():
        yield from parse_directory(p, on_skip=on_skip)
    elif p.is_file():
        yield from parse_file(p, on_skip=on_skip)
    else:
        raise FileNotFoundError(f"source path does not exist: {source}")
