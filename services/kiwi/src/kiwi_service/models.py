"""Pydantic models for the lemmatize/tokens API surface.

These types are the contract with B3 (Express). Any change here is a breaking
API change — bump the service `version` field in __init__.py and document.

Pydantic v2 reserves the ``model_*`` prefix for its own attribute namespace
(``model_validate``, ``model_dump``, ``model_config``...). Our health and
config responses include user-facing fields named ``model_loaded`` /
``model_size`` (web-API contract — renaming them is a breaking change for
B3 and the Docker healthcheck regex). We therefore set
``protected_namespaces=()`` on those response models with a comment pointing
to this paragraph. See REVIEW_B1.md F-1 / FIX_REPORT_B.md §B1-F1.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator


class LemmatizeRequest(BaseModel):
    """Single-sentence (or short passage) input.

    The character cap is enforced exclusively by ``_enforce_input_limit`` in
    ``app.py``, which reads ``Settings.max_input_chars`` (env-configurable
    via ``KIWI_MAX_INPUT_CHARS``). A previous version of this model also
    capped at a hardcoded ``_DEFAULT_MAX_INPUT_CHARS = 4096``; ops raising
    the env limit above 4096 silently 422'd legitimate requests because the
    model-level check fired first. See REVIEW_B1.md F-2.
    """

    model_config = ConfigDict(extra="forbid")

    text: str = Field(
        ...,
        min_length=1,
        description="Korean text to lemmatize. Caller should chunk by sentence.",
    )


class Token(BaseModel):
    """One morpheme as returned by Kiwi, with offsets into the original string."""

    model_config = ConfigDict(extra="forbid")

    surface: str = Field(..., description="The token as it appears in the input.")
    lemma: str = Field(..., description="Dictionary form. For verbs/adjectives ends in -다.")
    pos: str = Field(
        ...,
        description=(
            "Kiwi POS tag (Sejong-style). E.g. NNG common noun, NNP proper noun, "
            "VV verb, VA adjective, MAG general adverb, JKB adverbial particle, "
            "EF final ending, EP pre-final ending, ETM adnominal ending. See "
            "https://github.com/bab2min/Kiwi/blob/main/docs/Kiwi_POS_tags.md"
        ),
    )
    start: int = Field(..., ge=0, description="UTF-16 code-unit offset (matches JS string indices).")
    end: int = Field(..., ge=0, description="Exclusive end offset, same unit as start.")

    @field_validator("end")
    @classmethod
    def _end_after_start(cls, v: int, info: ValidationInfo) -> int:
        """Enforce ``end >= start`` — Kiwi shouldn't violate this but the
        canonical-data check protects downstream tap-a-word logic that does
        ``text[start:end]`` and would silently return empty on inverted
        offsets.
        """
        start = info.data.get("start")
        if isinstance(start, int) and v < start:
            raise ValueError(f"end ({v}) must be >= start ({start})")
        return v


class LemmatizeResponse(BaseModel):
    """Full lemmatization with offsets, for tap-a-word in the reader UI."""

    model_config = ConfigDict(extra="forbid")

    tokens: list[Token]


class LightToken(BaseModel):
    """Lighter variant used by /tokens: surface + lemma + pos only, no offsets."""

    model_config = ConfigDict(extra="forbid")

    surface: str
    lemma: str
    pos: str


class TokensResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tokens: list[LightToken]


class HealthResponse(BaseModel):
    # protected_namespaces=() because model_loaded / model_size collide with
    # Pydantic v2's reserved ``model_*`` prefix. Field names are part of the
    # B3-facing contract AND the Docker healthcheck regex — renaming them is
    # the more invasive change. See REVIEW_B1.md F-1.
    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    status: str = Field(..., description="`ok` if model is loaded, `starting` otherwise.")
    model_loaded: bool
    model_size: str


class VersionResponse(BaseModel):
    # protected_namespaces=() — see HealthResponse above.
    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    service: str
    service_version: str
    kiwi_version: str
    model_size: str


class ErrorResponse(BaseModel):
    """RFC-7807-ish error body. We don't claim full problem+json compliance."""

    model_config = ConfigDict(extra="forbid")

    error: str = Field(..., description="Stable machine-readable code, e.g. 'input_too_long'.")
    detail: str = Field(..., description="Human-readable explanation.")
