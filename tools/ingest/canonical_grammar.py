"""
Canonical grammar normalization & clustering.

WHY this module exists:
    Many KGIU grammar entries appear at multiple levels (Beginner Unit 16
    introduces -아/어도; Intermediate Ch.11 revisits it with richer
    semantics). For the app to deduplicate the "tap-a-grammar" experience —
    one pin, one canonical entry — we need a stable key that collapses
    surface-level variation (the leading "A/V-" placeholder, ordinal
    markers ①②③, NBSP, parenthesized morphophonological alternations) into
    a single string.

    This module is the ONLY place that knows how to normalize a KGIU
    "pattern" string into a `pattern_key`. Both the cluster builder
    (`cluster_canonical_grammar.py`) and any future grammar-recognition
    pipeline import the normalizer from here.

What's in scope:
    * `normalize_pattern(s)` — turn a raw pattern string into its dedup key.
    * `split_compound_pattern(s)` — split multi-form rows like
      "N와/과, N(이)랑, N하고" into their component patterns.
    * Pydantic models for the cluster output (`PatternOccurrence`,
      `CanonicalCluster`, `ClusterDocument`).
    * `classify_semantic_family(s)` — heuristic categorisation
      ("condition", "concession", "reason", …) used to populate
      `canonical_grammar.semantic_family`. Heuristic; final classifications
      live in the DB and a senior reviewer can override.

What's out of scope:
    * Reading the source JSONs (caller's job).
    * Talking to Postgres (the cluster builder owns that).
    * Resolving the *senses* of polysemous forms (e.g., -(으)ㄴ/는데 ① vs ②) —
      we surface them as near-duplicates for human review but do not
      collapse them silently. Semantic split is C2/C3's domain.

Senior-bar notes:
    * Pure functions, no I/O, no globals.
    * Pydantic at the boundary (`ClusterDocument`).
    * Idempotent: normalize(normalize(x)) == normalize(x).
"""

from __future__ import annotations

import re
import unicodedata
from typing import Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Constants — character classes & regexes
# ---------------------------------------------------------------------------

# The Darakwon pattern strings use a handful of "placeholder" prefixes to
# indicate what kind of stem the form attaches to. They are presentation
# scaffolding, not part of the form's identity.
#   A   = adjective stem
#   V   = verb stem
#   A/V = either
#   N   = noun
#
# Two surface conventions appear in the source data:
#   (a) verbal/adjectival placeholders use a hyphen — "A/V-아/어도", "V-(으)면".
#   (b) noun placeholders may attach a particle DIRECTLY with no hyphen —
#       "N처럼", "N(이)랑", "N의".
# We strip the placeholder in both cases. Hyphen optional via the trailing
# character class `[-‐‑‒–—―]?`. The lookahead `(?=[(가-힣])` makes
# sure we only consume a bare "N" when it's actually a placeholder followed
# by Korean syllables or a parenthesised morpheme — not a stray "N" that
# happens to start a pattern word.
_LEADING_PLACEHOLDER_RE = re.compile(
    r"^\s*(?:A/V|V/A|A|V|N)\s*[-‐‑‒–—―]\s*"
)
_LEADING_N_PLACEHOLDER_RE = re.compile(
    # Hangul Syllables block runs U+AC00 (가) .. U+D7A3 (힣).
    r"^\s*N\s*(?=[(가-힣])"
)

# Some entries omit the placeholder and begin with a bare hyphen, e.g.
# "-아/어도". We strip that too so "-아/어도" and "A/V-아/어도" collapse.
_LEADING_DASH_RE = re.compile(r"^[-‐‑‒–—―]\s*")

# Trailing ordinal markers — Darakwon uses ① ② ③ to distinguish polysemous
# senses of the same surface form (-(으)니까 ① "because" vs ② "discovery"
# upon doing X). For the dedup key we *strip* the ordinal: the canonical
# row is the *form*; sense disambiguation is preserved by the link from
# `canonical_grammar` to the underlying `kgiu_entries` rows (each of which
# keeps its own explanation).
_CIRCLED_DIGITS_RE = re.compile(r"[①-⑳㉑-㉟㊱-㊿]")

# A handful of entries are written with a trailing "-" placeholder for a
# missing tail (e.g. "단어 피동 (-이/히/리/기-)"). We DO NOT strip these —
# they're part of the form. The leading-placeholder regex above is anchored
# to the start.

# Whitespace normalization: collapse runs, strip NBSP / zero-width / BOM.
_INVISIBLE_RE = re.compile(r"[ ​‌‍﻿]")
_WS_RE = re.compile(r"\s+")

# Compound patterns: Darakwon occasionally lists co-equal forms on one row,
# separated by commas (sometimes followed by Korean " 또는 "). Examples:
#     "N와/과, N(이)랑, N하고"
#     "-기는 하지만, -기는 -지만"
#     "N에서 N까지, N부터 N까지"
# We split on commas (Latin and CJK) so each form gets its own cluster
# membership while preserving the row as a multi-pattern entry.
_COMPOUND_SPLIT_RE = re.compile(r"[,，、]\s*")

# ---------------------------------------------------------------------------
# Public normalizer
# ---------------------------------------------------------------------------


def normalize_pattern(pattern: str) -> str:
    """Return the canonical dedup key for a raw KGIU pattern string.

    Pure function. Idempotent.

    Steps (in order):
        1. Unicode-normalize to NFC. (Hangul jamo composition matters; the
           same syllable can be represented as a single character or as
           three jamo. NFC gives us the syllable form Darakwon prints.)
        2. Strip invisible characters (NBSP, ZWSP, ZWJ, BOM).
        3. Collapse internal whitespace to single spaces.
        4. Strip a leading A/V/N + hyphen placeholder.
        5. Strip a bare leading hyphen.
        6. Strip trailing circled-digit ordinal markers.
        7. Strip trailing whitespace.

    Examples:
        >>> normalize_pattern("A/V-아/어도")
        '아/어도'
        >>> normalize_pattern("-아/어도")
        '아/어도'
        >>> normalize_pattern("A/V-(으)니까 ①")
        '(으)니까'
        >>> normalize_pattern("V-(으)니까 ②")
        '(으)니까'
        >>> normalize_pattern("N 처럼")   # NBSP between N and 처럼
        '처럼'
        >>> normalize_pattern("")
        ''

    Raises:
        TypeError if `pattern` is not a string.
    """
    if not isinstance(pattern, str):
        raise TypeError(f"normalize_pattern expects str, got {type(pattern).__name__}")
    if not pattern:
        return ""

    # 1. NFC.
    s = unicodedata.normalize("NFC", pattern)

    # 2. Drop invisible characters.
    s = _INVISIBLE_RE.sub(" ", s)

    # 3. Collapse whitespace.
    s = _WS_RE.sub(" ", s).strip()

    # 4a. Strip leading A/V/N placeholder + hyphen ("A/V-아/어도", "V-(으)면").
    s = _LEADING_PLACEHOLDER_RE.sub("", s)

    # 4b. Strip a bare leading N placeholder directly followed by Korean
    #     ("N처럼", "N(이)랑", "N의"). Lookahead-anchored so a non-placeholder
    #     "N…" (e.g. an English title) is left alone.
    s = _LEADING_N_PLACEHOLDER_RE.sub("", s)

    # 5. Strip bare leading hyphen (en-dash, em-dash variants too).
    s = _LEADING_DASH_RE.sub("", s)

    # 6. Strip trailing circled-digit ordinals.
    s = _CIRCLED_DIGITS_RE.sub("", s).strip()

    return s


def split_compound_pattern(pattern: str) -> list[str]:
    """Split a multi-form pattern row into component patterns.

    Darakwon prints co-equal forms on one row separated by commas (e.g.,
    "N와/과, N(이)랑, N하고"). For clustering, each form is a separate
    surface that may dedupe with the same-shape form at another level —
    so we split first, normalize each, and feed each into the clusterer.

    The original row is preserved at the caller (PatternOccurrence keeps
    the raw string); this function returns the list of NORMALIZED keys.

    A pattern with no commas returns a single-element list (its own key).

    Examples:
        >>> split_compound_pattern("N와/과, N(이)랑, N하고")
        ['와/과', '(이)랑', '하고']
        >>> split_compound_pattern("A/V-아/어도")
        ['아/어도']
        >>> split_compound_pattern("")
        []
    """
    if not pattern:
        return []
    parts = _COMPOUND_SPLIT_RE.split(pattern.strip())
    keys = [normalize_pattern(p) for p in parts if p.strip()]
    return [k for k in keys if k]


# ---------------------------------------------------------------------------
# Semantic family classifier
# ---------------------------------------------------------------------------

# Heuristic mapping from a category-or-pattern signal to a coarse
# semantic family. KGIU's own `category` column is the strongest signal
# (Darakwon's pedagogical chapter framing). When `category` is missing or
# unhelpful, we fall back to keyword matching on the title/pattern.
#
# This is documented as HEURISTIC: a senior reviewer can override the
# stored value via a follow-up UPDATE. The point of having one at insert
# time is so the Reference UI's "browse by family" facet has something to
# show on day one.

# Map normalized category strings → semantic_family.
_CATEGORY_TO_FAMILY: dict[str, str] = {
    "conjecture": "conjecture",
    "supposition": "conjecture",
    "contrast": "concession",
    "concession": "concession",
    "speech_style": "speech_style",
    "reason": "reason",
    "cause": "reason",
    "purpose": "purpose",
    "intention": "intention",
    "condition": "condition",
    "hypothesis": "condition",
    "time": "time",
    "comparison": "comparison",
    "addition": "addition",
    "discovery": "discovery",
    "passive": "voice",
    "causative": "voice",
    "honorific": "honorifics",
    "humble": "honorifics",
    "quotation": "quotation",
    "negation": "negation",
    "ability": "ability",
    "permission": "permission",
    "obligation": "obligation",
    "wish": "wish",
    "request": "request",
    "regret": "regret",
    "habit": "habit",
    "introduction": "introduction",
    "particle": "particle",
}

# Keyword fallback (English title or pattern surface). Order matters —
# first match wins. Single broad sweep so this stays readable.
_TITLE_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("conjecture", "conjecture"),
    ("supposition", "conjecture"),
    ("seems", "conjecture"),
    ("looks", "conjecture"),
    ("concession", "concession"),
    ("even though", "concession"),
    ("even if", "concession"),
    ("despite", "concession"),
    ("contrast", "concession"),
    ("but", "concession"),
    ("however", "concession"),
    ("reason", "reason"),
    ("because", "reason"),
    ("cause", "reason"),
    ("purpose", "purpose"),
    ("in order to", "purpose"),
    ("intention", "intention"),
    ("intend", "intention"),
    ("plan to", "intention"),
    ("condition", "condition"),
    ("if", "condition"),
    ("when", "time"),
    ("while", "time"),
    ("during", "time"),
    ("after", "time"),
    ("before", "time"),
    ("comparison", "comparison"),
    ("compared", "comparison"),
    ("addition", "addition"),
    ("on top of", "addition"),
    ("besides", "addition"),
    ("discovery", "discovery"),
    ("realize", "discovery"),
    ("realized", "discovery"),
    ("passive", "voice"),
    ("causative", "voice"),
    ("honorific", "honorifics"),
    ("polite", "speech_style"),
    ("speech style", "speech_style"),
    ("formal", "speech_style"),
    ("informal", "speech_style"),
    ("quotation", "quotation"),
    ("quoting", "quotation"),
    ("negation", "negation"),
    ("ability", "ability"),
    ("can ", "ability"),
    ("permission", "permission"),
    ("allowed", "permission"),
    ("obligation", "obligation"),
    ("must", "obligation"),
    ("have to", "obligation"),
    ("should", "obligation"),
    ("wish", "wish"),
    ("hope", "wish"),
    ("request", "request"),
    ("asking", "request"),
    ("regret", "regret"),
    ("habit", "habit"),
    ("used to", "habit"),
    ("particle", "particle"),
    ("connect", "connection"),
    ("conjunctive", "connection"),
)


def classify_semantic_family(
    *,
    category: str | None,
    title_en: str | None,
    pattern: str | None,
) -> str:
    """Return a coarse semantic family tag for a pattern.

    Inputs are the raw KGIU columns. The result is a stable string
    suitable for `canonical_grammar.semantic_family`. Returns
    "uncategorized" when no signal matches — a senior reviewer can fix
    these in-place after the migration runs.

    The function is intentionally permissive about input: a None or
    empty-string for any field is fine.
    """
    if category:
        key = category.strip().lower().replace("-", "_").replace(" ", "_")
        family = _CATEGORY_TO_FAMILY.get(key)
        if family:
            return family
    haystack = " ".join(filter(None, [title_en, pattern])).lower()
    if haystack:
        for needle, family in _TITLE_KEYWORDS:
            if needle in haystack:
                return family
    return "uncategorized"


# ---------------------------------------------------------------------------
# Pydantic models for the cluster output
# ---------------------------------------------------------------------------


class PatternOccurrence(BaseModel):
    """One row in the source JSON that contributes to a cluster.

    `pattern_raw` is exactly what Darakwon printed. `pattern_normalized`
    is the dedup key. `corpus_source_id` is empty at clustering time —
    the DB populator fills it after the corpus_sources lookup.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    corpus: Literal["kgiu_beginner", "kgiu_intermediate", "kgiu_advanced"]
    source_id: str
    pattern_raw: str
    pattern_normalized: str
    level: Literal["beginner", "intermediate", "advanced"]
    title_en: str | None = None
    category: str | None = None


class CanonicalCluster(BaseModel):
    """A cluster of source rows sharing one canonical pattern_key.

    `aliases` captures the set of *raw* surface strings seen — used in
    the README for human review (e.g., spotting "(이)나" with no leading
    hyphen vs "-(이)나" with one).

    `members_per_level` is a fast count for the README and tests; it
    derives from `members` and is regenerated by the clusterer.
    """

    model_config = ConfigDict(extra="forbid")

    pattern_key: str = Field(..., description="The normalized dedup key.")
    canonical_pattern: str = Field(
        ...,
        description=(
            "The pattern string presented in the canonical row. Chosen as "
            "the most common raw surface (ties broken alphabetically). "
            "Preserves the leading hyphen and any A/V- placeholder."
        ),
    )
    semantic_family: str = Field(
        ..., description="Heuristic family (e.g. 'condition', 'concession')."
    )
    aliases: list[str] = Field(default_factory=list)
    members: list[PatternOccurrence] = Field(default_factory=list)
    members_per_level: dict[str, int] = Field(default_factory=dict)
    needs_review: bool = Field(
        default=False,
        description=(
            "True for near-duplicates a human should look at — e.g., "
            "circled-digit polysemy where the same surface form has "
            "distinct senses across rows."
        ),
    )
    review_reason: str | None = None


class ClusterDocument(BaseModel):
    """Top-level shape of canonical_grammar_clusters.json."""

    model_config = ConfigDict(extra="forbid")

    generated_at: str
    source_files: list[str]
    total_rows_in: int
    total_pattern_rows: int  # rows with non-null pattern
    total_clusters: int
    multi_level_clusters: int
    clusters: list[CanonicalCluster]


# ---------------------------------------------------------------------------
# Builder utilities (pure logic; I/O lives in cluster_canonical_grammar.py)
# ---------------------------------------------------------------------------


def pick_canonical_surface(aliases: Iterable[str]) -> str:
    """Choose the canonical display string from observed raw aliases.

    Strategy:
        * Prefer the longest surface that includes a leading hyphen or an
          A/V-/N- placeholder — that's the most "fully-formed" Darakwon
          presentation (e.g., "A/V-아/어도" beats "-아/어도" beats "아/어도").
        * Ties broken by alphabetical order for determinism.

    Empty input → empty string.
    """
    aliases = [a for a in aliases if a]
    if not aliases:
        return ""
    # We want highest score (placeholder > dash > nothing), then longest,
    # then a stable alphabetic tiebreaker (-ord_sum keeps "smaller" strings
    # winning ties for determinism across platforms).
    #
    # Inlining the predicates into the key avoids recomputing the regex
    # matches inside the lambda for every comparison index (REVIEW_C1 NIT-6).
    def key(s: str) -> tuple[int, int, int, int]:
        has_placeholder = bool(_LEADING_PLACEHOLDER_RE.match(s))
        has_dash = bool(_LEADING_DASH_RE.match(s))
        return (int(has_placeholder), int(has_dash), len(s), -ord_sum(s))
    return max(aliases, key=key)


def ord_sum(s: str) -> int:
    """Stable tiebreaker so sort is deterministic across runs/platforms."""
    return sum(ord(c) for c in s)
