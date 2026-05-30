"""
Pydantic models matching the source-JSON shapes under tools/ingest/output/.

WHY: bar §"Type safety" — Pydantic at every I/O boundary; no untyped dicts
between layers. These models also serve as the formal documentation of the
parser-output contract — agents working on the parsers must keep them in sync.

The models are deliberately TOLERANT: source JSONs were produced by Claude
vision over PDFs, so missing keys and "almost-right" values happen. We use
``model_config = ConfigDict(extra="ignore")`` so extra keys don't crash the
loader, and we provide sensible defaults for fields that ought to be present
but sometimes aren't.

All money keys keep their snake_case spellings (loader passes them to
SQL parameter dicts directly).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------


class StrictBase(BaseModel):
    """Base model used everywhere — ignores extra keys, validates types."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


# ---------------------------------------------------------------------------
# TTMIK lessons
# ---------------------------------------------------------------------------


class TtmikSentenceModel(StrictBase):
    ordinal: int
    korean: str
    english: str | None = None
    romanization: str | None = None
    speaker: str | None = None
    is_dialog: bool = False
    content_hash: str  # 64-char hex SHA-256


class TtmikUnitModel(StrictBase):
    ordinal: int
    level: int
    lesson: int
    title: str | None = None
    sentences: list[TtmikSentenceModel] = Field(default_factory=list)


class TtmikSourceModel(StrictBase):
    slug: str
    type: str
    title: str
    publisher: str | None = None
    level: int | str | None = None
    copyright_status: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TtmikDocumentModel(StrictBase):
    source: TtmikSourceModel
    units: list[TtmikUnitModel]


# ---------------------------------------------------------------------------
# Iyagi podcast
# ---------------------------------------------------------------------------


class IyagiSentenceModel(StrictBase):
    ordinal: int
    korean: str
    english: str | None = None
    romanization: str | None = None
    speaker: str | None = None
    is_dialog: bool = True
    content_hash: str


class IyagiUnitModel(StrictBase):
    ordinal: int
    number: int
    title: str | None = None
    hosts: str | None = None
    sentences: list[IyagiSentenceModel] = Field(default_factory=list)


class IyagiSourceModel(StrictBase):
    slug: str
    type: str
    title: str
    title_korean: str | None = None
    publisher: str | None = None
    level: str | None = None
    copyright_status: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class IyagiDocumentModel(StrictBase):
    source: IyagiSourceModel
    units: list[IyagiUnitModel]


# ---------------------------------------------------------------------------
# TOPIK items
# ---------------------------------------------------------------------------


class TopikItemModel(StrictBase):
    id: str  # "topik36-read-001"
    number: int
    instruction_group: str | None = None
    instruction: str | None = None
    skill_tag: str | None = None
    skill_tag_raw: str | None = None
    proficiency: str | None = None
    points: int | None = None
    has_image: bool = False
    image_text: str | None = None
    stem: str | None = None
    underline: str | None = None
    prompt: str | None = None
    options: list[str] = Field(default_factory=list)
    answer: Any | None = None         # int or object (writing)
    model_answer: Any | None = None
    # Discriminator for the polymorphic stem shape. None ⇒ inferred as
    # ``multiple_choice`` by the loader's ``_resolve_item_type``.
    #
    # The Postgres enum (``topik_item_type``, migration 005) has only four
    # canonical values: ``multiple_choice``, ``short_answer_blanks``,
    # ``chart_description``, ``essay``. But Claude-vision-extracted writing
    # JSONs use a wider set of discriminators (and the older files use
    # HYPHENATED forms). Verified across ``output/topik_{36,37,41,47,52,
    # 60,64,91,96}_writing.json``:
    #
    #   short_answer_blanks, short-answer-cloze, blank-fill,
    #   sentence-completion, complete-the-sentence,
    #   chart_description, chart-description, data-description,
    #   essay
    #
    # We accept all of these at the model boundary (after hyphen→underscore
    # normalization), then ``_resolve_item_type`` in ``load_topik.py``
    # collapses each writing variant onto the canonical Postgres-enum
    # value before the DB cast.
    #
    # FU-NF-7 (FOLLOW_UPS.md, 2026-05-29): the previous fix-pass tightened
    # this from ``str | None`` to a ``Literal`` to catch typos at parse
    # time. The first cut of that Literal listed only the three
    # underscored canonicals, which hard-failed Pydantic validation on 4
    # of 5 sampled writing JSONs (see ``REVIEW_FIXES_FU_NF.md`` B1). This
    # version preserves the fail-loud goal while accepting real data.
    type: Literal[
        "short_answer_blanks",
        "short_answer_cloze",
        "blank_fill",
        "sentence_completion",
        "complete_the_sentence",
        "chart_description",
        "data_description",
        "essay",
    ] | None = None

    @field_validator("type", mode="before")
    @classmethod
    def _normalize_type_hyphens(cls, v: Any) -> Any:
        """Normalize hyphenated discriminator forms to underscored before
        the ``Literal`` check runs.

        Older Claude-vision extractions wrote ``chart-description``,
        ``sentence-completion``, etc. Newer extractions use the
        underscored canonical forms. We accept both at the boundary so
        production ingestion isn't blocked, then fail loud on truly
        unknown values via the ``Literal``.

        Only strings are transformed; ``None`` and other types pass
        through unchanged so Pydantic can produce its normal error.
        """
        if isinstance(v, str):
            return v.replace("-", "_")
        return v


class TopikSourceModel(StrictBase):
    test: str
    level: str            # "TOPIK II"
    section: str          # "reading" | "listening" | "writing"
    form: str | None = None
    total_questions: int | None = None
    origin: str | None = None
    extracted_by: str | None = None
    extracted_at: str | None = None
    answers_verified_against: str | None = None


class TopikDocumentModel(StrictBase):
    source: TopikSourceModel
    passages: dict[str, str] = Field(default_factory=dict)
    items: list[TopikItemModel]


# ---------------------------------------------------------------------------
# KGIU grammar
# ---------------------------------------------------------------------------


class KgiuItemModel(StrictBase):
    id: str
    type: Literal["grammar", "intro", "reference"] = "grammar"
    unit: str | None = None
    audio_track: str | None = None
    pattern: str | None = None
    title_en: str | None = None
    category: str | None = None
    proficiency: str = "basic"
    register: str | None = None
    domain: str = "general"
    explanation: str | None = None
    formation_rules: list[Any] = Field(default_factory=list)
    examples: list[Any] = Field(default_factory=list)
    dialogues: list[Any] = Field(default_factory=list)
    vocabulary: list[Any] = Field(default_factory=list)
    tips: list[Any] = Field(default_factory=list)
    compare_with: list[Any] = Field(default_factory=list)
    exercises: list[Any] = Field(default_factory=list)
    cultural_notes: list[Any] = Field(default_factory=list)
    notes: str | None = None
    source_book: str
    source_pages: list[int] = Field(default_factory=list)


class KgiuSourceModel(StrictBase):
    book: str
    publisher: str | None = None
    authors: str | None = None
    level: Literal["beginner", "intermediate", "advanced"]
    default_proficiency: str = "basic"
    extracted_by: str | None = None
    extracted_at: str | None = None
    note: str | None = None
    total_pdf_pages: int | None = None
    last_pdf_page_done: int | None = None
    highest_book_page: int | None = None


class KgiuDocumentModel(StrictBase):
    source: KgiuSourceModel
    items: list[KgiuItemModel]


# ---------------------------------------------------------------------------
# 2000 Essential Words (vocab)
# ---------------------------------------------------------------------------


class VocabItemModel(StrictBase):
    id: str
    type: str               # "word" | "theme_intro" | "subsection_intro" | "reference"
    theme: str | None = None
    subsection: str | None = None
    audio_track: str | None = None
    korean: str | None = None
    english: str | None = None
    pronunciation: str | None = None
    hanja: str | None = None
    japanese: str | None = None
    part_of_speech: str | None = None
    case_marker: str | None = None
    irregular_class: str | None = None
    example_korean: str | None = None
    example_english: str | None = None
    passive_form: str | None = None
    causative_form: str | None = None
    basic_form: str | None = None
    honorific_form: str | None = None
    humble_form: str | None = None
    contracted_form: str | None = None
    tips: list[Any] = Field(default_factory=list)
    cross_refs: list[Any] = Field(default_factory=list)
    notes: list[Any] | str | None = None    # source carries both shapes
    proficiency: str | None = None
    domain: str = "general"
    source_book: str
    source_pages: list[int] = Field(default_factory=list)


class VocabSourceModel(StrictBase):
    book: str
    publisher: str | None = None
    authors: str | None = None
    level: Literal["beginner", "intermediate"]
    default_proficiency: str = "basic"
    extracted_by: str | None = None
    extracted_at: str | None = None
    note: str | None = None
    total_pdf_pages: int | None = None
    highest_book_page: int | None = None
    extraction_complete: bool | None = None


class VocabDocumentModel(StrictBase):
    source: VocabSourceModel
    items: list[VocabItemModel]
