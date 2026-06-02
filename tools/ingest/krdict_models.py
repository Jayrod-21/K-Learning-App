"""
KRDICT data models — the Pydantic contract between the parser and the loader.

This module is the I/O boundary per SENIOR_ENGINEER_BAR §"Type safety". Every
KRDICT entity flows through these models — the parser produces them; the
loader consumes them. No untyped dicts cross the boundary.

Design rules honored:
    * Strict shape: extra fields rejected so a parser bug surfaces at the
      boundary, not at the SQL INSERT.
    * Defensive bounds: string length limits mirror the DB CHECK constraints
      (defense in depth — the loader rejects oversized input before sending
      it to the DB, and the DB CHECK is the second wall).
    * Sense / example ordinals are validated >= 1; homograph_index >= 0.
    * POS is `str | None` — the DB CHECK constraint (ADR-017) is the source
      of truth for the allowed set. Models stay format-agnostic so a
      KRDICT taxonomy update doesn't break the parser; the DB CHECK is the
      detection point.
    * Register on the entry is the closed enum `register_level`; on a sense
      it's free TEXT (KRDICT inconsistency, see ADR-015).
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


# Mirrors the Postgres `register_level` enum from 001_core_schema.
# Kept here (rather than imported) so the parser is self-contained.
class RegisterLevel(str, Enum):
    """Korean speech-level register, mirroring the `register_level` enum."""

    BANMAL = "반말"
    HAEYOCHE = "해요체"
    HAPSYOCHE = "합쇼체"
    MUNEOCHE = "문어체"
    HAOCHE = "하오체"
    HAGECHE = "하게체"


class VocabularyLevel(str, Enum):
    """KRDICT vocabulary grade (LMF feat ``vocabularyLevel``).

    Maps onto the app's proficiency tagging: 초급→basic, 중급→L3, 고급→L4
    (see DESIGN_SPEC). Mirrors the ck_krdict_entries_vocab_level CHECK in
    migration 026 — that DB constraint is the second wall.
    """

    BEGINNER = "초급"
    INTERMEDIATE = "중급"
    ADVANCED = "고급"


# Defensive length bounds. Match the DB CHECK constraints in
# 003_krdict.up.sql so the loader rejects bad input before the DB does.
MAX_HEADWORD_LEN = 200
MAX_PRONUNCIATION_LEN = 200
MAX_HANJA_LEN = 200
MAX_POS_LEN = 50
MAX_DEFINITION_LEN = 8000
MAX_EXAMPLE_LEN = 4000
MAX_INFLECTION_LEN = 200
MAX_LABEL_LEN = 200
MAX_SOURCE_ID_LEN = 100


def _strip_or_none(v: Optional[str]) -> Optional[str]:
    """Trim whitespace; map empty to None — KRDICT XML often has empty tags."""

    if v is None:
        return None
    stripped = v.strip()
    return stripped if stripped else None


def _strip_required(v: Optional[str]) -> str:
    """Shared validator body for required string fields.

    Three places used to inline this (``_strip_korean``, ``_strip_def_korean``,
    ``_strip_required`` on the entry). DRY rule of three is met — consolidated
    here, per REVIEW_B2.md SF5.

    We deliberately keep manual stripping (vs ``str_strip_whitespace=True`` on
    the model_config) so callers can distinguish None from empty-after-strip
    and emit a domain-specific error message.
    """

    if v is None:
        raise ValueError("required field cannot be None")
    return v.strip()


class KrdictExampleModel(BaseModel):
    """One example sentence under a sense."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    example_index: int = Field(..., ge=1, description="1-based ordinal in the sense.")
    korean: str = Field(..., min_length=1, max_length=MAX_EXAMPLE_LEN)
    english: Optional[str] = Field(default=None, max_length=MAX_EXAMPLE_LEN)
    example_type: Optional[str] = Field(default=None, max_length=MAX_LABEL_LEN)

    @field_validator("english", "example_type", mode="before")
    @classmethod
    def _normalize_optional(cls, v: Optional[str]) -> Optional[str]:
        return _strip_or_none(v)

    @field_validator("korean", mode="before")
    @classmethod
    def _strip_korean(cls, v: Optional[str]) -> str:
        return _strip_required(v)


class KrdictSenseModel(BaseModel):
    """One sense of an entry. Sense 1 is denormalized onto the entry row."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    sense_index: int = Field(..., ge=1)
    definition_korean: str = Field(..., min_length=1, max_length=MAX_DEFINITION_LEN)
    definition_english: Optional[str] = Field(default=None, max_length=MAX_DEFINITION_LEN)
    sense_domain: Optional[str] = Field(default=None, max_length=MAX_LABEL_LEN)
    sense_register: Optional[str] = Field(default=None, max_length=MAX_LABEL_LEN)
    examples: list[KrdictExampleModel] = Field(default_factory=list)

    @field_validator("definition_english", "sense_domain", "sense_register", mode="before")
    @classmethod
    def _normalize_optional(cls, v: Optional[str]) -> Optional[str]:
        return _strip_or_none(v)

    @field_validator("definition_korean", mode="before")
    @classmethod
    def _strip_def_korean(cls, v: Optional[str]) -> str:
        return _strip_required(v)


class KrdictInflectionModel(BaseModel):
    """One inflected form (verb/adjective conjugation row)."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    order_index: int = Field(..., ge=0)
    surface_form: str = Field(..., min_length=1, max_length=MAX_INFLECTION_LEN)
    inflection_label: str = Field(..., min_length=1, max_length=MAX_LABEL_LEN)

    @field_validator("surface_form", "inflection_label", mode="before")
    @classmethod
    def _strip(cls, v: Optional[str]) -> str:
        return _strip_required(v)


class KrdictEntryModel(BaseModel):
    """A single KRDICT headword — the unit of upsert."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    # Provenance / natural key.
    source_id: str = Field(..., min_length=1, max_length=MAX_SOURCE_ID_LEN)
    homograph_index: int = Field(default=0, ge=0)

    # Lexical core.
    headword: str = Field(..., min_length=1, max_length=MAX_HEADWORD_LEN)
    pronunciation: Optional[str] = Field(default=None, max_length=MAX_PRONUNCIATION_LEN)
    part_of_speech: Optional[str] = Field(default=None, max_length=MAX_POS_LEN)
    hanja: Optional[str] = Field(default=None, max_length=MAX_HANJA_LEN)
    register: Optional[RegisterLevel] = None
    vocabulary_level: Optional[VocabularyLevel] = None

    # Children.
    senses: list[KrdictSenseModel] = Field(..., min_length=1)
    inflections: list[KrdictInflectionModel] = Field(default_factory=list)

    @field_validator("pronunciation", "part_of_speech", "hanja", mode="before")
    @classmethod
    def _normalize_optional(cls, v: Optional[str]) -> Optional[str]:
        return _strip_or_none(v)

    @field_validator("headword", "source_id", mode="before")
    @classmethod
    def _strip_required_field(cls, v: Optional[str]) -> str:
        return _strip_required(v)

    @field_validator("register", mode="before")
    @classmethod
    def _coerce_register(cls, v: object) -> object:
        # KRDICT XML can emit register as an arbitrary string; only accept
        # known enum values. Anything else becomes None (logged at the
        # parser layer) so an unknown register doesn't crash the load.
        if v is None or isinstance(v, RegisterLevel):
            return v
        if not isinstance(v, str):
            return None
        s = v.strip()
        try:
            return RegisterLevel(s)
        except ValueError:
            return None

    @field_validator("vocabulary_level", mode="before")
    @classmethod
    def _coerce_vocabulary_level(cls, v: object) -> object:
        # Same defense as register: an unexpected grade string (a future KRDICT
        # value) coerces to None rather than crashing the entry. The DB CHECK
        # in 026 is the second wall.
        if v is None or isinstance(v, VocabularyLevel):
            return v
        if not isinstance(v, str):
            return None
        s = v.strip()
        try:
            return VocabularyLevel(s)
        except ValueError:
            return None

    @field_validator("senses")
    @classmethod
    def _validate_sense_indices(
        cls, senses: list[KrdictSenseModel]
    ) -> list[KrdictSenseModel]:
        # Sense indices must be unique and contiguous starting at 1.
        # This is the contract krdict_senses.uq_krdict_senses_entry_sense
        # enforces in the DB; raising here gives a friendlier error.
        seen = set()
        for s in senses:
            if s.sense_index in seen:
                raise ValueError(
                    f"duplicate sense_index {s.sense_index} in entry"
                )
            seen.add(s.sense_index)
        if 1 not in seen:
            raise ValueError("entry must have a sense_index = 1")
        return senses

    @field_validator("inflections")
    @classmethod
    def _validate_inflection_uniqueness(
        cls, infl: list[KrdictInflectionModel]
    ) -> list[KrdictInflectionModel]:
        # (surface, label) must be unique inside an entry — mirrors
        # uq_krdict_inflections_entry_surface_label.
        seen: set[tuple[str, str]] = set()
        for i in infl:
            key = (i.surface_form, i.inflection_label)
            if key in seen:
                raise ValueError(
                    f"duplicate (surface, label) inflection: "
                    f"{i.surface_form} / {i.inflection_label}"
                )
            seen.add(key)
        return infl


class KrdictSourceMetadata(BaseModel):
    """Provenance description for a KRDICT archive."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    source_label: str = Field(..., min_length=1, max_length=200)
    source_path: str = Field(..., min_length=1, max_length=4000)
    source_sha256: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    # KRDICT is distributed under CC BY-SA 2.0 KR (저작자표시-동일조건변경허락),
    # per https://krdict.korean.go.kr — NOT KOGL Type 1 (an earlier wrong note,
    # corrected after inspecting the actual download). Attribution: 국립국어원
    # 한국어기초사전. ShareAlike applies to redistributed derivatives.
    license: str = Field(
        default="CC BY-SA 2.0 KR (저작자표시-동일조건변경허락) — 국립국어원 한국어기초사전",
        max_length=200,
    )
    license_url: Optional[str] = Field(
        default="https://creativecommons.org/licenses/by-sa/2.0/kr/",
        max_length=500,
    )
    publisher: str = Field(
        default="국립국어원 (National Institute of Korean Language)",
        max_length=200,
    )
    publisher_url: str = Field(
        default="https://krdict.korean.go.kr/", max_length=500
    )
    item_count: Optional[int] = Field(default=None, ge=0)
    notes: Optional[str] = Field(default=None, max_length=4000)
