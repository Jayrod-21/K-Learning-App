"""
KRDICT XML parser.

Streaming, defensive, format-strict, defusedxml-backed.

Parses KRDICT's **LMF** XML (Lexical Markup Framework, ``DTD_LMF_REV_16``) into
`KrdictEntryModel` instances. Producer-only — the loader is a separate module.
Side-effect-free.

Format note (ADR-016, corrected)
--------------------------------
KRDICT's bulk download (krdict.korean.go.kr → "사전 전체 내려받기", XML) ships
**LMF**, not the TEI-Lite shape an earlier version of this parser assumed. LMF
encodes every value as a ``<feat att="X" val="Y"/>`` pair, nested under
``<LexicalResource><Lexicon><LexicalEntry>``. The real shape, per the 2026-05
export:

    <LexicalEntry att="id" val="27733">          # entry id is the val attribute
        <feat att="homonym_number" val="1"/>     # also seen camelCase: homonymNumber
        <feat att="partOfSpeech" val="명사"/>
        <feat att="origin" val="可"/>            # hanja for Sino-Korean words
        <feat att="vocabularyLevel" val="고급"/>  # 초급/중급/고급
        <Lemma><feat att="writtenForm" val="가"/></Lemma>
        <WordForm><feat att="type" val="발음"/><feat att="pronunciation" val="가ː"/></WordForm>
        <WordForm><feat att="type" val="활용"/><feat att="writtenForm" val="…"/></WordForm>
        <Sense att="id" val="1">
            <feat att="definition" val="…"/>
            <SenseExample><feat att="type" val="구"/><feat att="example" val="…"/></SenseExample>
            <Equivalent><feat att="language" val="영어"/><feat att="definition" val="…"/></Equivalent>
        </Sense>
    </LexicalEntry>

Public API:
    iter_entries(source, *, on_skip=None) -> Iterator[KrdictEntryModel]
    parse_file(path, *, on_skip=None) -> Iterator[KrdictEntryModel]
    parse_directory(path, *, on_skip=None) -> Iterator[KrdictEntryModel]

Why streaming
-------------
KRDICT archives are large (the bulk XML is ~386MB across 11 volumes).
``iterparse`` lets us process one ``<LexicalEntry>`` at a time and clear its
subtree, so memory is flat regardless of file size.

Defense against malformed/malicious input
-----------------------------------------
* ``defusedxml.ElementTree`` — blocks XXE and entity-bomb attacks.
* The KRDICT files declare a SYSTEM DOCTYPE (``DTD_LMF_REV_16.dtd``). We
  therefore set ``forbid_dtd=False`` (tolerate the DOCTYPE declaration — every
  real file has one) while keeping ``forbid_entities=True`` and
  ``forbid_external=True`` (the actual XXE/entity-bomb defenses — the external
  DTD URL is NEVER fetched). ``forbid_dtd=True`` would reject every real file.
* Per-entry try/except: one broken entry is skipped and logged, not fatal.
* The Pydantic model is strict (``extra="forbid"``); an upstream rename surfaces
  as a validation error at the entry boundary.
* Length caps on every string field (krdict_models) defend against a single
  oversized value DoS-ing the loader.
"""

from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional, Union

from xml.etree.ElementTree import ParseError

from defusedxml import ElementTree as DET
from pydantic import ValidationError

from krdict_models import (
    KrdictEntryModel,
    KrdictExampleModel,
    KrdictInflectionModel,
    KrdictSenseModel,
    VocabularyLevel,
)


log = logging.getLogger(__name__)


# --- LMF element + feat names. One line to find on a schema rename. -----------
TAG_ENTRY = "LexicalEntry"
TAG_LEMMA = "Lemma"
TAG_WORDFORM = "WordForm"
TAG_SENSE = "Sense"
TAG_SENSE_EXAMPLE = "SenseExample"
TAG_EQUIVALENT = "Equivalent"

# `feat att="…"` attribute names.
FEAT_WRITTEN_FORM = "writtenForm"
FEAT_HOMONYM = "homonym_number"
FEAT_HOMONYM_CAMEL = "homonymNumber"  # the same data also appears camelCased
FEAT_POS = "partOfSpeech"
FEAT_ORIGIN = "origin"
FEAT_VOCAB_LEVEL = "vocabularyLevel"
FEAT_TYPE = "type"
FEAT_PRONUNCIATION = "pronunciation"
FEAT_DEFINITION = "definition"
FEAT_EXAMPLE = "example"
FEAT_LANGUAGE = "language"

# `feat type` values we care about.
TYPE_PRONUNCIATION = "발음"  # WordForm carrying a pronunciation
TYPE_INFLECTION = "활용"  # WordForm carrying a conjugated/declined surface form
LANGUAGE_ENGLISH = "영어"  # the Equivalent we map to definition_english
INFLECTION_LABEL = "활용"  # KRDICT's bulk export gives no finer grammatical label

# CJK ideograph ranges — used to keep only genuine hanja out of `feat origin`
# (which is the source language for loanwords, e.g. an English/Latin string).
_CJK = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


# XML 1.0 forbids the C0 control characters except TAB (0x09), LF (0x0A) and
# CR (0x0D). KRDICT occasionally embeds an illegal one (e.g. a backspace 0x08)
# inside a translation, which makes expat reject the WHOLE file as not
# well-formed — aborting the load of everything after it. These are single-byte
# ASCII controls that can never be a UTF-8 continuation byte (0x80-0xBF) or lead
# byte (0xC0+), so deleting them at the byte level is safe and never corrupts a
# multibyte character. We strip them from the stream before expat sees them.
_ILLEGAL_XML_BYTES = bytes(b for b in range(0x20) if b not in (0x09, 0x0A, 0x0D))


class _ControlCharFilter:
    """Read-through wrapper that deletes XML-illegal control bytes on the fly.

    Wraps a binary file object so streaming is preserved (we never hold the whole
    file). Deletion is per-chunk and byte-wise, which is safe across chunk
    boundaries because we only remove standalone single-byte controls.
    """

    def __init__(self, raw):
        self._raw = raw

    def read(self, size: int = -1) -> bytes:
        chunk = self._raw.read(size)
        if not chunk:
            return chunk
        return chunk.translate(None, _ILLEGAL_XML_BYTES)

    def close(self) -> None:
        self._raw.close()


@dataclass(frozen=True)
class SkipReason:
    """Why a single entry was skipped — surfaced to the on_skip callback."""

    source_id: Optional[str]
    error: str


SkipCallback = Callable[[SkipReason], None]


def _clean(val: Optional[str]) -> Optional[str]:
    """Trim, HTML-unescape, map empty → None.

    KRDICT double-escapes HTML entities in feat values (the XML parser unescapes
    one level, leaving literal ``&quot;`` / ``&lt;`` in definitions), so we
    unescape once more here to recover the real text.
    """
    if val is None:
        return None
    cleaned = html.unescape(val).strip()
    return cleaned or None


def _feat(elem, att: str) -> Optional[str]:
    """Return the cleaned ``val`` of the first direct child ``<feat att=…>``.

    ``att`` is always a module-level constant, so the XPath predicate carries no
    untrusted input.
    """
    if elem is None:
        return None
    child = elem.find(f"feat[@att='{att}']")
    if child is None:
        return None
    return _clean(child.get("val"))


def _int_or_default(value: Optional[str], default: int) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _entry_id(elem) -> Optional[str]:
    """LMF stores the entry id as the ``val`` attribute on <LexicalEntry att='id'>."""
    raw = elem.get("val")
    if raw is None:
        return None
    raw = raw.strip()
    return raw or None


def _headword(elem) -> Optional[str]:
    return _feat(elem.find(TAG_LEMMA), FEAT_WRITTEN_FORM)


def _pronunciation(elem) -> Optional[str]:
    """First WordForm tagged 발음 → its pronunciation (entries can list several)."""
    for wf in elem.findall(TAG_WORDFORM):
        if _feat(wf, FEAT_TYPE) == TYPE_PRONUNCIATION:
            pron = _feat(wf, FEAT_PRONUNCIATION)
            if pron:
                return pron
    return None


def _hanja(elem) -> Optional[str]:
    """``feat origin`` is the source language; keep it only when it is real hanja.

    For Sino-Korean words this is the hanja (家族, 可); for loanwords it is the
    foreign source string, which does NOT belong in the hanja column. We store it
    only when it contains a CJK ideograph.
    """
    origin = _feat(elem, FEAT_ORIGIN)
    if origin and _CJK.search(origin):
        return origin
    return None


def _vocab_level(elem) -> Optional[VocabularyLevel]:
    """Map ``feat vocabularyLevel`` to the enum; unknown/absent → None.

    Coercing here (rather than passing the raw str to the model) keeps the value
    type-correct for KrdictEntryModel.vocabulary_level. The model's
    ``_coerce_vocabulary_level`` validator stays as a boundary guard for other
    construction paths (tests, a future API mapper).
    """
    raw = _feat(elem, FEAT_VOCAB_LEVEL)
    if raw is None:
        return None
    try:
        return VocabularyLevel(raw)
    except ValueError:
        # A grade KRDICT might add later → None, same as the model guard.
        return None


def _english_definition(sense_elem) -> Optional[str]:
    """The English gloss lives in the Equivalent whose language feat is 영어."""
    for eq in sense_elem.findall(TAG_EQUIVALENT):
        if _feat(eq, FEAT_LANGUAGE) == LANGUAGE_ENGLISH:
            return _feat(eq, FEAT_DEFINITION)
    return None


def _parse_examples(sense_elem) -> list[KrdictExampleModel]:
    examples: list[KrdictExampleModel] = []
    idx = 1
    for se in sense_elem.findall(TAG_SENSE_EXAMPLE):
        ex_type = _feat(se, FEAT_TYPE)
        # A SenseExample can carry MORE than one example feat — a 대화 (dialogue)
        # type holds the back-and-forth as consecutive example feats. Emit one
        # row per example, all tagged with the SenseExample's type.
        for fe in se.findall(f"feat[@att='{FEAT_EXAMPLE}']"):
            ko = _clean(fe.get("val"))
            if not ko:
                continue
            examples.append(
                KrdictExampleModel(
                    example_index=idx,
                    korean=ko,
                    english=None,  # bulk SenseExamples are Korean-only
                    example_type=ex_type,
                )
            )
            idx += 1
    return examples


def _parse_senses(entry_elem) -> list[KrdictSenseModel]:
    senses: list[KrdictSenseModel] = []
    for s in entry_elem.findall(TAG_SENSE):
        def_ko = _feat(s, FEAT_DEFINITION)
        if not def_ko:
            # A sense with no Korean definition is malformed. Skip it — the
            # entry validator catches an entry left with no senses at all.
            continue
        # Re-index POSITIONALLY (1..N in document order). KRDICT's Sense @val is
        # NOT a reliable per-entry 1-based index: a synonym / cross-reference
        # entry can carry a single sense numbered e.g. "3" (the sense number of
        # the entry it points at — e.g. 초야 → 첫날밤 sense 3). Trusting @val made
        # the model reject such entries ("must have sense_index = 1"). Our schema
        # only needs contiguous indices from 1 in document order, so assign by
        # position.
        senses.append(
            KrdictSenseModel(
                sense_index=len(senses) + 1,
                definition_korean=def_ko,
                definition_english=_english_definition(s),
                examples=_parse_examples(s),
            )
        )
    return senses


def _parse_inflections(entry_elem) -> list[KrdictInflectionModel]:
    out: list[KrdictInflectionModel] = []
    seen: set[tuple[str, str]] = set()
    idx = 0
    for wf in entry_elem.findall(TAG_WORDFORM):
        if _feat(wf, FEAT_TYPE) != TYPE_INFLECTION:
            continue
        surface = _feat(wf, FEAT_WRITTEN_FORM)
        if not surface:
            continue
        key = (surface, INFLECTION_LABEL)
        if key in seen:
            # Drop duplicates rather than crash the entry on the uniqueness rule.
            continue
        seen.add(key)
        out.append(
            KrdictInflectionModel(
                order_index=idx,
                surface_form=surface,
                inflection_label=INFLECTION_LABEL,
            )
        )
        idx += 1
    return out


def _entry_from_xml(elem) -> KrdictEntryModel:
    """Build a KrdictEntryModel from one <LexicalEntry>. Raises on shape errors."""

    source_id = _entry_id(elem)
    if not source_id:
        raise ValueError("missing required LexicalEntry id (val attribute)")

    headword = _headword(elem)
    if not headword:
        raise ValueError("missing required Lemma/writtenForm")

    senses = _parse_senses(elem)
    if not senses:
        raise ValueError("entry has no valid senses")

    homograph = _int_or_default(
        _feat(elem, FEAT_HOMONYM) or _feat(elem, FEAT_HOMONYM_CAMEL), 0
    )

    return KrdictEntryModel(
        source_id=source_id,
        homograph_index=homograph,
        headword=headword,
        pronunciation=_pronunciation(elem),
        part_of_speech=_feat(elem, FEAT_POS),
        hanja=_hanja(elem),
        vocabulary_level=_vocab_level(elem),
        senses=senses,
        inflections=_parse_inflections(elem),
    )


def _iter_entries_from_path(
    path: Path, *, on_skip: Optional[SkipCallback]
) -> Iterator[KrdictEntryModel]:
    """Stream-parse a single XML file. Memory stays flat via elem.clear()."""

    log.info("krdict_parser.parse_file_start", extra={"path": str(path)})
    # defusedxml blocks XXE / entity-bomb attacks. forbid_dtd is False because
    # every real KRDICT file declares a SYSTEM DOCTYPE; forbid_entities and
    # forbid_external (both True) are the actual defenses — the external DTD URL
    # is never fetched. See the module docstring.
    count = 0
    skipped = 0
    # Open the file ourselves and wrap it so XML-illegal control bytes are
    # stripped before expat sees them (see _ControlCharFilter). The `with`
    # guarantees the handle closes even though defusedxml will not close a source
    # it did not open.
    with open(path, "rb") as raw:
        context = DET.iterparse(
            _ControlCharFilter(raw),
            events=("end",),
            forbid_dtd=False,
            forbid_entities=True,
            forbid_external=True,
        )
        try:
            for _event, elem in context:
                if elem.tag != TAG_ENTRY:
                    continue
                try:
                    yield _entry_from_xml(elem)
                    count += 1
                except (ValueError, ValidationError) as exc:
                    skipped += 1
                    source_id = _entry_id(elem)
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
                    # does not grow with file size.
                    elem.clear()
        except ParseError as exc:
            # A well-formedness error is fatal to expat: it cannot resume past
            # the bad token, so the remainder of THIS file is lost. Log loudly
            # with how far we got and stop this file gracefully rather than crash
            # the whole multi-volume load. (_ControlCharFilter already removes the
            # most common cause — stray control characters — so this should be
            # rare.) The caller continues with the next file.
            log.error(
                "krdict_parser.parse_error",
                extra={
                    "path": str(path),
                    "error": str(exc),
                    "entries_before_error": count,
                },
            )
            if on_skip is not None:
                on_skip(SkipReason(source_id=None, error=f"ParseError: {exc}"))
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
    """Stream-parse a KRDICT LMF XML file."""
    yield from _iter_entries_from_path(Path(path), on_skip=on_skip)


def parse_directory(
    path: Union[str, Path],
    *,
    on_skip: Optional[SkipCallback] = None,
) -> Iterator[KrdictEntryModel]:
    """Stream-parse every *.xml file under a directory, sorted by name.

    Visit-order contract (relied on by load_krdict.py's resume cursor):
      1. Files are visited in ``sorted()`` order of their absolute paths.
      2. Within each file, entries are emitted in DOCUMENT ORDER (the order they
         appear in the XML), which iterparse preserves.

    What this contract does NOT guarantee:
      - Entries are NOT sorted by ``source_id``. A new KRDICT vintage can
        intermix new entries among old ones, and homograph entries share a
        source_id with different ``homograph_index``.
      - Therefore the loader CANNOT lexicographic-compare source_ids to decide
        "is this past the resume cursor?". It must walk until it observes the
        marker, and raise if it never does. See load_krdict.py and REVIEW_B2.md.
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
